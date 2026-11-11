// 🌸 喵喵切片合并下载姬 - HLS/m3u8 在线解析与合并核心
// AES-128 / 最高码率 / MAP + BYTERANGE / 吞吐趋势自适应并发 / 按序写盘

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const m3u8Url = params.get("url") || "";
  const videoTitle = params.get("title") || "动漫视频";

  const titleVal = document.getElementById("titleVal");
  const urlVal = document.getElementById("urlVal");
  const segmentVal = document.getElementById("segmentVal");
  const progressText = document.getElementById("progressText");
  const transferStats = document.getElementById("transferStats");
  const percentText = document.getElementById("percentText");
  const progressFill = document.getElementById("progressFill");
  const statusMsg = document.getElementById("statusMsg");

  const btnStart = document.getElementById("btnStart");
  const btnDownloadM3U8 = document.getElementById("btnDownloadM3U8");
  const btnCopyUrl = document.getElementById("btnCopyUrl");
  const btnCancel = document.getElementById("btnCancel");
  const audioNotice = document.getElementById("audioNotice");
  const audioNoticeText = document.getElementById("audioNoticeText");
  const audioUrls = document.getElementById("audioUrls");
  const btnCopyAudio = document.getElementById("btnCopyAudio");

  titleVal.textContent = videoTitle;
  urlVal.textContent = m3u8Url || "未提供 m3u8 地址";

  if (!m3u8Url) {
    statusMsg.textContent = "错误：缺少视频流地址参数喵 (T_T)";
    btnStart.disabled = true;
    return;
  }

  let plan = null; // { segments, initSegments, isFmp4, variantSelections }
  let isDownloading = false;
  let activeController = null;
  btnStart.disabled = true;

  function abortError() {
    const error = new Error("下载已取消");
    error.name = "AbortError";
    return error;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function waitForRetry(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---------- 小工具 ----------
  function resolveUrl(relative, base) {
    try {
      return new URL(relative, base).href;
    } catch (e) {
      return relative;
    }
  }

  // 解析 #EXT-X-KEY / #EXT-X-MAP / #EXT-X-STREAM-INF 这类 key=value 串，正确处理带引号的值
  function parseAttributes(attrStr) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(attrStr)) !== null) {
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      attrs[m[1]] = v;
    }
    return attrs;
  }

  function hexToBytes(hex) {
    const clean = String(hex).replace(/^0x/i, "");
    const padded = clean.padStart(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // HLS 规范：无 IV 时默认 IV = 分片序号的 128 位大端整数
  function sequenceToIv(seq) {
    const out = new Uint8Array(16);
    let n = seq;
    for (let i = 15; i >= 8; i--) {
      out[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    return out;
  }

  // 每次等待网络数据最多 30 秒；本地写盘背压不计入网络超时。
  const NETWORK_IDLE_MS = 30000;
  async function readResponse(url, headers, signal, telemetry) {
    throwIfAborted(signal);
    const request = new AbortController();
    let timer = null;
    let timedOut = false;
    let reader = null;
    let complete = false;
    const clearDeadline = () => { clearTimeout(timer); timer = null; };
    const armDeadline = () => {
      clearDeadline();
      timer = setTimeout(() => { timedOut = true; request.abort(); }, NETWORK_IDLE_MS);
    };
    const cancel = () => request.abort();
    if (signal) signal.addEventListener("abort", cancel, { once: true });
    try {
      armDeadline();
      const res = await fetch(url, { headers, signal: request.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let buffer;
      if (res.body && typeof res.body.getReader === "function") {
        reader = res.body.getReader();
        const chunks = [];
        let length = 0;
        while (true) {
          clearDeadline();
          throwIfAborted(signal);
          if (telemetry) await telemetry.waitForCapacity();
          armDeadline();
          const { done, value } = await reader.read();
          clearDeadline();
          if (done) break;
          if (telemetry) telemetry.bytes(value.byteLength);
          chunks.push(value);
          length += value.byteLength;
        }
        const combined = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
        buffer = combined.buffer;
      } else {
        if (telemetry) telemetry.unmeasurable();
        armDeadline();
        buffer = await res.arrayBuffer();
        if (telemetry) telemetry.bytes(buffer.byteLength);
      }
      throwIfAborted(signal);
      if (timedOut) throw new Error("Network timeout");
      complete = true;
      return { res, buffer };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) {
        const timeout = new Error("网络请求连续 30 秒未收到数据，可重试或取消");
        timeout.name = "TimeoutError";
        throw timeout;
      }
      throw error;
    } finally {
      clearDeadline();
      if (signal) signal.removeEventListener("abort", cancel);
      if (!complete) request.abort();
      if (reader) {
        if (!complete) { try { await reader.cancel(); } catch (_) {} }
        reader.releaseLock();
      }
    }
  }

  // 接受合法 206，或从足够长的 200 全量响应中切出所需范围。
  // 长度/范围不符必须进入重试，不能将错误字节交给写盘端。
  async function fetchBytes(url, byteRange, signal, telemetry) {
    const headers = {};
    let end;
    if (byteRange) {
      const { offset, length } = byteRange;
      end = offset + length - 1;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(end)) {
        throw new Error("清单字节范围无效");
      }
      headers.Range = `bytes=${offset}-${end}`;
    }
    let received = false;
    if (telemetry) telemetry.start();
    try {
      const { res, buffer } = await readResponse(url, headers, signal, telemetry);
      let result = buffer;
      if (byteRange) {
        if (res.status === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(res.headers.get("Content-Range") || "");
          if (!match || Number(match[1]) !== byteRange.offset || Number(match[2]) !== end ||
              (match[3] !== "*" && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= end)) ||
              buffer.byteLength !== byteRange.length) {
            throw new Error("服务器返回的 Content-Range 或字节数与请求范围不符");
          }
        } else if (res.status === 200 && buffer.byteLength > end) {
          result = buffer.slice(byteRange.offset, end + 1);
        } else {
          throw new Error(`服务器未返回完整请求范围：需要 ${byteRange.offset}-${end}，收到 ${buffer.byteLength} 字节（HTTP ${res.status}）`);
        }
      }
      received = true;
      return result;
    } finally {
      if (telemetry) telemetry.end({ discarded: !received });
    }
  }

  // ---------- 密钥缓存 ----------
  const keyCache = new Map(); // keyUri -> { bytes, cryptoKey }
  async function getKey(keyUri, signal) {
    if (keyCache.has(keyUri)) return keyCache.get(keyUri);
    const bytes = await fetchBytes(keyUri, null, signal);
    if (bytes.byteLength !== 16) {
      throw new Error(`密钥长度异常（${bytes.byteLength} 字节，应为 16）：${keyUri}`);
    }
    const cryptoKey = await crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["decrypt"]);
    const entry = { bytes, cryptoKey };
    keyCache.set(keyUri, entry);
    return entry;
  }

  // ---------- 播放清单规划 ----------
  // 同一分片可以提供多种 KEYFORMAT。只在确实使用密钥时判断能力，避免
  // 不认识的备选格式或已经被后续标签替换的密钥挡住可用的 identity 路径。
  function selectKey(keyFormats, context) {
    if (keyFormats.size === 0) return null;
    const key = keyFormats.get("identity");
    if (!key) {
      throw new Error(`${context}没有可用的密钥格式（KEYFORMAT=${[...keyFormats.keys()].join("、")}；仅支持 identity）`);
    }
    if (key.method !== "AES-128") {
      throw new Error(`${context}不支持的加密方式 METHOD=${key.method || "未提供"}（仅支持 AES-128；SAMPLE-AES 的样本解密暂未实现）`);
    }
    if (!key.uri) throw new Error(`${context}的 AES-128 密钥缺少 URI`);
    return key;
  }

  async function prepareKey(key, signal) {
    if (key && !key.keyEntry) key.keyEntry = await getKey(key.uri, signal);
    return key;
  }

  function inferFmp4(segments, initSegments) {
    // MAP 也可描述 TS 初始化数据；先看已取得的初始化内容，再用 URI 提示。
    for (const buffer of initSegments.values()) {
      const bytes = new Uint8Array(buffer);
      if (bytes.length >= 188 && bytes[0] === 0x47 &&
          (bytes.length < 376 || bytes[188] === 0x47)) return false;
      if (bytes.length >= 8) {
        const boxType = String.fromCharCode(...bytes.subarray(4, 8));
        if (boxType === "ftyp" || boxType === "moov") return true;
      }
    }
    const mediaPaths = segments.map((segment) => segment.url.split(/[?#]/)[0]);
    if (mediaPaths.some((url) => /\.(m4s|mp4)$/i.test(url))) return true;
    if (mediaPaths.some((url) => /\.ts$/i.test(url))) return false;
    return segments.some((segment) => segment.mapUri && /\.(m4s|mp4)$/i.test(segment.mapUri.split(/[?#]/)[0]));
  }

  // 返回 { segments: [{url, key, iv, mapId, mapUri, byteRange, sequence, discontinuity}],
  //         initSegments: Map(mapId -> ArrayBuffer), isFmp4, variantSelections }
  async function planPlaylist(targetUrl, externalAudio = [], ancestors = new Set(), signal) {
    if (ancestors.has(targetUrl)) throw new Error(`清单引用循环：${targetUrl}`);
    const { res: resp, buffer } = await readResponse(targetUrl, {}, signal);
    // 相对 URI 属于最终收到的清单地址；重定向可能同时改变域名和目录。
    const playlistUrl = resp.url || targetUrl;
    if (ancestors.has(playlistUrl)) throw new Error(`清单引用循环：${playlistUrl}`);
    const path = new Set(ancestors);
    path.add(targetUrl);
    path.add(playlistUrl);
    const text = new TextDecoder().decode(buffer);
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    if (lines[0] !== "#EXTM3U") {
      throw new Error(`响应不是有效的 HLS 清单，缺少 #EXTM3U 文件头：${playlistUrl}`);
    }

    // 优先最高码率；只有该候选实际失败才尝试下一档，并保留降档原因。
    if (text.includes("#EXT-X-STREAM-INF")) {
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
          const attrs = parseAttributes(lines[i].slice("#EXT-X-STREAM-INF:".length));
          let uri = attrs.URI || "";
          if (!uri) {
            for (let j = i + 1; j < lines.length; j++) {
              if (lines[j] && !lines[j].startsWith("#")) {
                uri = lines[j];
                break;
              }
            }
          }
          if (uri) {
            variants.push({
              uri: resolveUrl(uri, playlistUrl),
              bandwidth: parseInt(attrs.BANDWIDTH || "0", 10) || 0,
              audioGroup: attrs.AUDIO || ""
            });
          }
        }
      }
      if (variants.length === 0) throw new Error("多码率清单中未找到可用变体");
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      const audioRenditions = lines
        .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
        .map((line) => parseAttributes(line.slice("#EXT-X-MEDIA:".length)));
      const failures = [];
      for (let index = 0; index < variants.length; index++) {
        const variant = variants[index];
        const selectedAudio = audioRenditions
          .filter((attrs) => attrs.TYPE === "AUDIO" && attrs.URI &&
            variant.audioGroup && attrs["GROUP-ID"] === variant.audioGroup)
          .map((attrs) => ({
            url: resolveUrl(attrs.URI, playlistUrl),
            name: attrs.NAME || attrs.LANGUAGE || "独立音轨"
          }));
        statusMsg.textContent = `检测到 ${variants.length} 档码率，正在检查第 ${index + 1} 档（${variant.bandwidth} bps）... (✧ω✧)`;
        try {
          const selected = await planPlaylist(variant.uri, [...externalAudio, ...selectedAudio], path, signal);
          if (selected.segments.length === 0) throw new Error("清单中没有可下载的分片");
          return {
            ...selected,
            variantSelections: [{
              url: variant.uri, bandwidth: variant.bandwidth,
              rank: index + 1, total: variants.length, failures
            }, ...selected.variantSelections]
          };
        } catch (error) {
          throwIfAborted(signal);
          failures.push({ url: variant.uri, bandwidth: variant.bandwidth, reason: error.message });
        }
      }
      throw new Error(`全部 ${variants.length} 档码率均不可用：${failures.map((failure) => `${failure.bandwidth} bps：${failure.reason}`).join("；")}`);
    }

    // Media Playlist：逐行走状态机
    const segments = [];
    const initSegments = new Map();
    let sequence = 0;
    const keyFormats = new Map(); // KEYFORMAT -> 当前密钥描述，各格式独立延续
    let curMap = null; // URI、范围及声明当时的密钥状态；首次使用时加载
    let pendingByteRange = null; // { length, offset|null }
    const lastOffsetByUri = new Map();
    let discontinuity = false;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
        sequence = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-KEY")) {
        const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
        const method = (attrs.METHOD || "").toUpperCase();
        if (method === "NONE") {
          keyFormats.clear();
        } else {
          keyFormats.set(attrs.KEYFORMAT || "identity", {
            method,
            uri: attrs.URI ? resolveUrl(attrs.URI, playlistUrl) : null,
            ivHex: attrs.IV || null
          });
        }
      } else if (line.startsWith("#EXT-X-MAP")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
        let byteRange = null;
        if (attrs.BYTERANGE) {
          const parts = attrs.BYTERANGE.split("@");
          byteRange = { length: parseInt(parts[0], 10), offset: parts[1] !== undefined ? parseInt(parts[1], 10) : 0 };
        }
        curMap = {
          uri: attrs.URI ? resolveUrl(attrs.URI, playlistUrl) : null,
          byteRange,
          keyFormats: new Map(keyFormats),
          id: null
        };
      } else if (line.startsWith("#EXT-X-BYTERANGE")) {
        const spec = line.slice("#EXT-X-BYTERANGE:".length).trim();
        const parts = spec.split("@");
        pendingByteRange = {
          length: parseInt(parts[0], 10),
          offset: parts[1] !== undefined ? parseInt(parts[1], 10) : null
        };
      } else if (line.startsWith("#EXT-X-DISCONTINUITY")) {
        discontinuity = true;
      } else if (line && !line.startsWith("#")) {
        const url = resolveUrl(line, playlistUrl);
        let byteRange = null;
        if (pendingByteRange) {
          let offset = pendingByteRange.offset;
          if (offset === null) offset = lastOffsetByUri.get(url) || 0;
          byteRange = { length: pendingByteRange.length, offset };
          lastOffsetByUri.set(url, offset + pendingByteRange.length);
          pendingByteRange = null;
        }
        if (curMap && !curMap.id) {
          if (!curMap.uri) throw new Error("初始化段 #EXT-X-MAP 缺少 URI");
          const mapKey = selectKey(curMap.keyFormats, "初始化段");
          if (mapKey && !mapKey.ivHex) {
            throw new Error("AES-128 加密初始化段缺少显式 IV，无法解密该初始化段");
          }
          await prepareKey(mapKey, signal);
          const mapIv = mapKey ? hexToBytes(mapKey.ivHex) : null;
          // URI 相同不代表初始化段相同：范围、密钥和 IV 都参与身份判断。
          curMap.id = JSON.stringify([
            curMap.uri, curMap.byteRange,
            mapKey ? [mapKey.method, mapKey.uri, [...new Uint8Array(mapKey.keyEntry.bytes)], [...mapIv]] : null
          ]);
          if (!initSegments.has(curMap.id)) {
            const raw = await fetchBytes(curMap.uri, curMap.byteRange, signal);
            initSegments.set(curMap.id, await decryptBytes(raw, mapKey, mapIv, "初始化段"));
          }
        }
        const key = await prepareKey(selectKey(keyFormats, `分片 #${sequence}`), signal);
        const iv = key ? (key.ivHex ? hexToBytes(key.ivHex) : sequenceToIv(sequence)) : null;
        segments.push({ url, key, iv, mapId: curMap && curMap.id, mapUri: curMap && curMap.uri, byteRange, sequence, discontinuity });
        if (discontinuity) discontinuity = false;
        sequence++;
      }
    }

    // 无 MAP 的 .m4s 流也保留 fMP4 扩展名，缺失初始化段的提示在下方给出。
    const isFmp4 = inferFmp4(segments, initSegments);

    const uniqueAudio = [...new Map(externalAudio.map((track) => [track.url, track])).values()];
    return { segments, initSegments, isFmp4, externalAudio: uniqueAudio, variantSelections: [] };
  }

  async function decryptBytes(buffer, key, iv, context) {
    if (!key) return buffer;
    try {
      return await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key.keyEntry.cryptoKey, buffer);
    } catch (e) {
      throw new Error(`AES-128 解密失败（${context}）：${e.message}`);
    }
  }

  async function decryptSegment(buffer, seg) {
    return await decryptBytes(buffer, seg.key, seg.iv, `分片 #${seg.sequence}`);
  }

  // 初始解析、取消和重试共享同一生命周期；控制按钮在请求前注册。
  async function loadPlan() {
    if (isDownloading) return;
    isDownloading = true;
    const controller = new AbortController();
    activeController = controller;
    plan = null;
    keyCache.clear();
    btnStart.disabled = true;
    btnCancel.hidden = false;
    btnCancel.disabled = false;
    audioNotice.hidden = true;
    audioUrls.value = "";
    segmentVal.textContent = "正在解析…";
    statusMsg.textContent = "正在拉取 m3u8 播放清单喵... (◕ᴗ◕✿)";
    try {
      const candidate = await planPlaylist(m3u8Url, [], new Set(), controller.signal);
      throwIfAborted(controller.signal);
      if (!candidate.segments.length) throw new Error("清单中没有可下载的分片");
      plan = candidate;
      btnStart.textContent = "开始下载";
      renderPlan();
    } catch (error) {
      plan = null;
      segmentVal.textContent = "清单尚未准备完成";
      statusMsg.textContent = controller.signal.aborted ? "已取消清单加载，可重新解析。"
        : "解析清单失败：" + error.message + "；可重试、复制地址或保存原始清单。";
      btnStart.textContent = "重新解析清单";
    } finally {
      activeController = null;
      isDownloading = false;
      btnStart.disabled = false;
      btnCancel.hidden = true;
      btnCancel.disabled = true;
    }
  }

  function renderPlan() {
    if (plan.segments.length > 0) {
      const encNote = plan.segments.some((s) => s.key) ? "（AES-128 加密，已备好密钥解密）" : "";
      const mapNote = plan.isFmp4 ? "（fMP4）" : "";
      const selectionNotes = plan.variantSelections.map((selection) => {
        const failures = selection.failures.map((failure) => `${failure.bandwidth} bps：${failure.reason}`).join("；");
        return `已选 ${selection.bandwidth} bps（第 ${selection.rank}/${selection.total} 档）${failures ? `，此前候选失败：${failures}` : ""}`;
      }).join("；");
      // 保留在清单信息中，下载进度和最终保存提示不会覆盖所选档位及失败原因。
      segmentVal.textContent = `共解析到 ${plan.segments.length} 个切片${encNote}${mapNote}${selectionNotes ? `；${selectionNotes}` : ""}`;
      statusMsg.textContent = `(=^･ω･^=) 切片清单已准备完毕，共 ${plan.segments.length} 个分段，快点击下载吧！`;
      if (plan.isFmp4 && plan.initSegments.size === 0) {
        statusMsg.textContent += " ⚠️ 未检测到初始化段（#EXT-X-MAP），合并后可能无法播放。";
      }

    } else {
      segmentVal.textContent = "未能解析出切片列表 (可能是跨域或密钥限制)";

    }

    if (plan.externalAudio.length > 0) {
      audioNotice.hidden = false;
      audioNoticeText.textContent = `此视频使用独立音轨（${plan.externalAudio.map((track) => track.name).join("、")}）。本页仅保存所选视频流，不会合并这些音轨，生成文件可能没有声音。可复制音轨清单或原始 m3u8 地址，交给支持音视频合并的工具。`;
      audioUrls.value = plan.externalAudio.map((track) => track.url).join("\n");
      btnStart.textContent = "下载视频（不合并独立音轨）";
    }

  }

  btnCopyAudio.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(audioUrls.value);
      statusMsg.textContent = "已复制独立音轨清单地址。";
    } catch (error) {
      audioUrls.select();
      statusMsg.textContent = "无法自动复制，请复制上方已选中的音轨清单地址。";
    }
  });

  btnCancel.addEventListener("click", () => {
    if (!activeController) return;
    activeController.abort();
    btnCancel.disabled = true;
    statusMsg.textContent = "正在取消下载...";
  });

  // 复制直链按钮
  btnCopyUrl.addEventListener("click", () => {
    navigator.clipboard.writeText(m3u8Url).then(() => {
      statusMsg.textContent = "已复制原始 m3u8 地址。";
    }).catch(() => {
      statusMsg.textContent = "无法自动复制，请复制上方显示的原始流地址。";
    });
  });

  // 仅下载 m3u8 文件
  btnDownloadM3U8.addEventListener("click", () => {
    chrome.downloads.download({
      url: m3u8Url,
      filename: `${videoTitle}.m3u8`,
      saveAs: true
    });
  });

  // 并发目标只由实际并发与总吞吐的测量曲线计算；网络补位与按序写盘各自推进。
  btnStart.addEventListener("click", async () => {
    if (isDownloading) return;
    if (!plan) { await loadPlan(); return; }
    isDownloading = true;
    const controller = new AbortController();
    const signal = controller.signal;
    activeController = controller;
    btnStart.disabled = true;
    btnDownloadM3U8.disabled = true;
    btnCancel.disabled = false;
    btnCancel.hidden = false;

    const total = plan.segments.length;
    const ext = plan.isFmp4 ? "mp4" : "ts";
    const filename = `${videoTitle}.${ext}`;
    let completed = 0;
    const failed = [];
    let totalBytes = 0;
    let writer = null;
    const blobParts = [];
    let lastMapWritten = null;
    progressFill.style.background = "";
    transferStats.textContent = "正在测量总下载速度…";

    function updateProgress() {
      const percent = Math.floor((completed / total) * 100);
      progressFill.style.width = `${percent}%`;
      percentText.textContent = `${percent}%`;
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      const failNote = failed.length ? `，${failed.length} 个失败` : "";
      progressText.textContent = `已处理 ${completed} / ${total} 个切片 (${mb} MB${failNote})`;
    }
    updateProgress();

    // 这里只重试网络/解密；写盘发生在外层，不会重试分片或重复增加进度。
    async function fetchSegment(seg, index, telemetry, requestSignal, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        throwIfAborted(requestSignal);
        try {
          const raw = await fetchBytes(seg.url, seg.byteRange, requestSignal, telemetry);
          throwIfAborted(requestSignal);
          const plain = await decryptSegment(raw, seg);
          throwIfAborted(requestSignal);
          if (plain.byteLength === 0) throw new Error("切片内容为空");
          completed++;
          totalBytes += plain.byteLength;
          updateProgress();
          return { index, buffer: plain };
        } catch (err) {
          telemetry.end({ discarded: true });
          if (requestSignal.aborted || err.name === "AbortError") throw err;
          if (attempt === retries) {
            console.error(`切片 ${index} 下载失败:`, err);
            failed.push({ index, url: seg.url, error: err.message });
            completed++;
            updateProgress();
            return { index, buffer: null };
          } else {
            await waitForRetry(800, requestSignal);
          }
        }
      }
    }

    function failureReport() {
      if (failed.length === 0) return "";
      const shown = failed.slice(0, 10).map((f) => `#${f.index}`).join("、");
      const more = failed.length > 10 ? ` 等共 ${failed.length} 个` : "";
      return ` ⚠️ 有 ${failed.length} 个切片下载失败（${shown}${more}），对应位置会卡顿/缺失，可重试下载。`;
    }

    try {
      statusMsg.textContent = "请选择保存位置；下载时请保持本页开启。";
      if (typeof window.showSaveFilePicker === "function") {
        let handle = null;
        try {
          handle = await window.showSaveFilePicker({ suggestedName: filename });
        } catch (error) {
          // 用户关闭保存框就是取消，不能再发起内存下载。
          if (error.name === "AbortError" || signal.aborted) throw error;
          console.warn("保存框不可用，改用内存合并：", error);
        }
        throwIfAborted(signal);
        if (handle) writer = await handle.createWritable();
      }
      throwIfAborted(signal);
      statusMsg.textContent = writer
        ? "正在下载并按顺序保存切片，请保持本页开启喵..."
        : "正在使用内存合并；大文件会占用较多内存，请保持本页开启。";

      const throughput = new NekoAdaptive.ThroughputController();
      await NekoAdaptive.runAdaptiveDownload({
        total,
        controller: throughput,
        signal,
        fetchItem: (index, telemetry, requestSignal) => fetchSegment(plan.segments[index], index, telemetry, requestSignal),
        async writeItem(result) {
          throwIfAborted(signal);
          const seg = plan.segments[result.index];
          if (seg.mapId && seg.mapId !== lastMapWritten) {
            const init = plan.initSegments.get(seg.mapId);
            if (init) {
              if (writer) await writer.write(init);
              else blobParts.push(init);
            }
            lastMapWritten = seg.mapId;
          }
          throwIfAborted(signal);
          if (writer) await writer.write(result.buffer);
          else blobParts.push(result.buffer);
        },
        onMetrics({ concurrency, targetConcurrency, bytesPerSecond }) {
          const speed = (bytesPerSecond / (1024 * 1024)).toFixed(2);
          transferStats.textContent = `总下载速度 ${speed} MB/s · 实际并发 ${concurrency.toFixed(1)} · 目标 ${targetConcurrency}`;
        }
      });

      throwIfAborted(signal);
      if (failed.length === total) {
        throw new Error(`全部切片下载失败，未保存视频文件。首个失败原因：${failed[0].error}；可重试下载。`);
      }
      // 提交文件后无法撤销，所以提交阶段关闭取消按钮。
      btnCancel.disabled = true;
      statusMsg.textContent = "正在保存视频文件...";
      progressText.textContent = "正在完成保存，请稍候...";
      if (writer) {
        await writer.close();
        writer = null;
      } else {
        const mergedBlob = new Blob(blobParts, {
          type: plan.isFmp4 ? "video/mp4" : "video/mp2t"
        });
        const blobUrl = URL.createObjectURL(mergedBlob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        try {
          a.click();
        } finally {
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        }
      }

      const audioNote = plan.externalAudio.length > 0
        ? " 独立音轨未合并，文件可能没有声音；音轨清单和原始流地址仍可复制。"
        : "";
      if (failed.length > 0) {
        statusMsg.textContent = `已保存 ${filename}，但视频有缺失。${failureReport()}${audioNote}`;
        progressFill.style.background = "#FF9800";
        progressText.textContent = `已保存部分视频 (${(totalBytes / (1024 * 1024)).toFixed(1)} MB)，${failed.length} 个切片失败`;
      } else {
        statusMsg.textContent = `视频文件已保存为 ${filename}。${audioNote}`;
        progressFill.style.background = "#4CAF50";
        progressText.textContent = `已全部完成 (${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`;
      }
    } catch (e) {
      const cancelled = signal.aborted || e.name === "AbortError";
      controller.abort();
      statusMsg.textContent = cancelled ? "已取消下载，未保存本次视频文件。" : "下载未完成：" + e.message;
      progressText.textContent = cancelled ? "已取消，可重新开始。" : "保存未完成，可重试。";
      progressFill.style.background = cancelled ? "#8C7A78" : "#F44336";
    } finally {
      if (writer) {
        try {
          await writer.abort();
        } catch (error) {
          console.warn("释放未完成的文件写入器失败：", error);
        }
      }
      blobParts.length = 0;
      activeController = null;
      btnCancel.disabled = true;
      btnCancel.hidden = true;
      btnStart.disabled = false;
      btnDownloadM3U8.disabled = false;
      isDownloading = false;
    }
  });

  await loadPlan();
});
