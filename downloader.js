// 🌸 喵喵切片合并下载姬 - HLS/m3u8 在线解析与合并核心
// v1.1.0 全修版：AES-128 解密（#EXT-X-KEY）/ 选最高码率 / #EXT-X-MAP + BYTERANGE / 失败上报 / 流式写盘防 OOM

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const m3u8Url = params.get("url") || "";
  const videoTitle = params.get("title") || "动漫视频";

  const titleVal = document.getElementById("titleVal");
  const urlVal = document.getElementById("urlVal");
  const segmentVal = document.getElementById("segmentVal");
  const progressText = document.getElementById("progressText");
  const percentText = document.getElementById("percentText");
  const progressFill = document.getElementById("progressFill");
  const statusMsg = document.getElementById("statusMsg");

  const btnStart = document.getElementById("btnStart");
  const btnDownloadM3U8 = document.getElementById("btnDownloadM3U8");
  const btnCopyUrl = document.getElementById("btnCopyUrl");

  titleVal.textContent = videoTitle;
  urlVal.textContent = m3u8Url || "未提供 m3u8 地址";

  if (!m3u8Url) {
    statusMsg.textContent = "错误：缺少视频流地址参数喵 (T_T)";
    btnStart.disabled = true;
    return;
  }

  let plan = null; // { segments, initSegments, isFmp4 }
  let isDownloading = false;

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

  // 按字节范围拉取；服务器若无视 Range 返回 200 全量，则本地切片
  async function fetchBytes(url, byteRange) {
    const headers = {};
    if (byteRange) {
      headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (byteRange && res.status === 200 && buf.byteLength > byteRange.length) {
      return buf.slice(byteRange.offset, byteRange.offset + byteRange.length);
    }
    return buf;
  }

  // ---------- 密钥缓存 ----------
  const keyCache = new Map(); // keyUri -> { bytes, cryptoKey }
  async function getKey(keyUri) {
    if (keyCache.has(keyUri)) return keyCache.get(keyUri);
    const bytes = await fetchBytes(keyUri, null);
    if (bytes.byteLength !== 16) {
      throw new Error(`密钥长度异常（${bytes.byteLength} 字节，应为 16）：${keyUri}`);
    }
    const cryptoKey = await crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["decrypt"]);
    const entry = { bytes, cryptoKey };
    keyCache.set(keyUri, entry);
    return entry;
  }

  // ---------- 播放清单规划 ----------
  // 返回 { segments: [{url, key, iv, mapUri, byteRange, sequence, discontinuity}],
  //         initSegments: Map(mapUri -> ArrayBuffer), isFmp4 }
  async function planPlaylist(targetUrl) {
    const resp = await fetch(targetUrl);
    if (!resp.ok) throw new Error(`拉取清单失败 HTTP ${resp.status}：${targetUrl}`);
    const text = await resp.text();
    const lines = text.split(/\r?\n/).map((l) => l.trim());

    // Master Playlist：收集全部变体，取 BANDWIDTH 最大者（旧版取第一个，常为最低档）
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
              uri: resolveUrl(uri, targetUrl),
              bandwidth: parseInt(attrs.BANDWIDTH || "0", 10) || 0
            });
          }
        }
      }
      if (variants.length === 0) throw new Error("多码率清单中未找到可用变体");
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      statusMsg.textContent = `检测到 ${variants.length} 档码率，自动选最高画质（${variants[0].bandwidth} bps）... (✧ω✧)`;
      return await planPlaylist(variants[0].uri);
    }

    // Media Playlist：逐行走状态机
    const segments = [];
    const initSegments = new Map();
    let isFmp4 = false;
    let sequence = 0;
    let curKey = null; // { method, uri, keyEntry, ivHex }
    let curMapUri = null;
    let pendingByteRange = null; // { length, offset|null }
    const lastOffsetByUri = new Map();
    let discontinuity = false;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
        sequence = parseInt(line.split(":")[1], 10) || 0;
      } else if (line.startsWith("#EXT-X-KEY")) {
        const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
        const method = (attrs.METHOD || "NONE").toUpperCase();
        if (method === "NONE") {
          curKey = null;
        } else if (method === "AES-128") {
          if (attrs.KEYFORMAT && attrs.KEYFORMAT !== "identity") {
            throw new Error(`不支持的密钥格式 KEYFORMAT=${attrs.KEYFORMAT}`);
          }
          const keyUri = resolveUrl(attrs.URI, targetUrl);
          // 密钥拉不到就直接报错，别等下到一半才炸
          const keyEntry = await getKey(keyUri);
          curKey = { method, uri: keyUri, keyEntry, ivHex: attrs.IV || null };
        } else {
          throw new Error(`不支持的加密方式 METHOD=${method}（仅支持 AES-128；SAMPLE-AES 需 transmux，暂不支持）`);
        }
      } else if (line.startsWith("#EXT-X-MAP")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
        curMapUri = resolveUrl(attrs.URI, targetUrl);
        isFmp4 = true;
        if (!initSegments.has(curMapUri)) {
          let br = null;
          if (attrs.BYTERANGE) {
            const parts = attrs.BYTERANGE.split("@");
            br = { length: parseInt(parts[0], 10), offset: parts[1] !== undefined ? parseInt(parts[1], 10) : 0 };
          }
          initSegments.set(curMapUri, await fetchBytes(curMapUri, br));
        }
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
        const url = resolveUrl(line, targetUrl);
        let byteRange = null;
        if (pendingByteRange) {
          let offset = pendingByteRange.offset;
          if (offset === null) offset = lastOffsetByUri.get(url) || 0;
          byteRange = { length: pendingByteRange.length, offset };
          lastOffsetByUri.set(url, offset + pendingByteRange.length);
          pendingByteRange = null;
        }
        const iv = curKey ? (curKey.ivHex ? hexToBytes(curKey.ivHex) : sequenceToIv(sequence)) : null;
        segments.push({ url, key: curKey, iv, mapUri: curMapUri, byteRange, sequence, discontinuity });
        if (discontinuity) discontinuity = false;
        sequence++;
      }
    }

    // 无 MAP 的 .m4s 流同样是 fMP4（只是缺初始化段，合并后可能播不了，下方会提示）
    if (!isFmp4 && segments.some((s) => /\.m4s($|\?)/i.test(s.url))) isFmp4 = true;

    return { segments, initSegments, isFmp4 };
  }

  async function decryptSegment(buffer, seg) {
    if (!seg.key) return buffer;
    try {
      return await crypto.subtle.decrypt({ name: "AES-CBC", iv: seg.iv }, seg.key.keyEntry.cryptoKey, buffer);
    } catch (e) {
      throw new Error(`AES-128 解密失败（分片 #${seg.sequence}）：${e.message}`);
    }
  }

  // ---------- 初始解析 ----------
  statusMsg.textContent = "正在拉取 m3u8 播放清单喵... (◕ᴗ◕✿)";
  try {
    plan = await planPlaylist(m3u8Url);
  } catch (err) {
    console.error(err);
    statusMsg.textContent = "解析清单失败: " + err.message + "，请尝试复制直链用外部工具下载喵~";
    btnStart.disabled = true;
    plan = { segments: [], initSegments: new Map(), isFmp4: false };
  }

  if (plan.segments.length > 0) {
    const encNote = plan.segments.some((s) => s.key) ? "（AES-128 加密，已备好密钥解密）" : "";
    const mapNote = plan.isFmp4 ? "（fMP4，含初始化段）" : "";
    segmentVal.textContent = `共解析到 ${plan.segments.length} 个切片${encNote}${mapNote} (预计可合并完整播放)`;
    statusMsg.textContent = `(=^･ω･^=) 切片清单已准备完毕，共 ${plan.segments.length} 个分段，快点击下载吧！`;
    if (plan.isFmp4 && plan.initSegments.size === 0) {
      statusMsg.textContent += " ⚠️ 未检测到初始化段（#EXT-X-MAP），合并后可能无法播放。";
    }
  } else {
    segmentVal.textContent = "未能解析出切片列表 (可能是跨域或密钥限制)";
    btnStart.disabled = true;
  }

  // 复制直链按钮
  btnCopyUrl.addEventListener("click", () => {
    navigator.clipboard.writeText(m3u8Url).then(() => {
      alert("📋 视频直链已成功复制喵！(｡♥‿♥｡)\n可以直接粘贴进 PotPlayer / VLC 播放~");
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

  // 按顺序组装 Blob 回退路径的分段（含 MAP 变化时插入新初始化段）
  function buildBlobParts(chunks, total) {
    const parts = [];
    let lastMap = null;
    for (let i = 0; i < total; i++) {
      const seg = plan.segments[i];
      if (plan.isFmp4 && seg.mapUri && seg.mapUri !== lastMap) {
        const init = plan.initSegments.get(seg.mapUri);
        if (init) parts.push(init);
        lastMap = seg.mapUri;
      }
      parts.push(chunks[i] || new ArrayBuffer(0));
    }
    return parts;
  }

  // 核心：并发分片下载并合并
  btnStart.addEventListener("click", async () => {
    if (isDownloading || !plan || plan.segments.length === 0) return;
    isDownloading = true;
    btnStart.disabled = true;
    btnDownloadM3U8.disabled = true;

    const total = plan.segments.length;
    const ext = plan.isFmp4 ? "mp4" : "ts";
    const filename = `${videoTitle}.${ext}`;
    let completed = 0;
    const failed = []; // { index, url, error }：失败不再静默填 0 字节了事
    let totalBytes = 0;
    const chunks = new Array(total);

    statusMsg.textContent = "正在飞速搬运切片中，请保持网页开启喵... (づ｡◕‿‿◕｡)づ";

    function updateProgress() {
      const percent = Math.floor((completed / total) * 100);
      progressFill.style.width = `${percent}%`;
      percentText.textContent = `${percent}%`;
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      const failNote = failed.length ? `，${failed.length} 个失败` : "";
      progressText.textContent = `已完成 ${completed} / ${total} 个切片 (${mb} MB${failNote})`;
    }

    // ---- 写盘：优先流式写盘（File System Access API），不可用时回退内存 Blob ----
    let writer = null;
    let useStreaming = false;
    try {
      if (typeof window.showSaveFilePicker === "function") {
        const handle = await window.showSaveFilePicker({ suggestedName: filename });
        writer = await handle.createWritable();
        useStreaming = true;
      }
    } catch (e) {
      console.warn("流式写盘不可用，回退内存合并：", e);
      statusMsg.textContent = "未能打开保存框，改用内存合并（大文件可能占内存）喵...";
    }

    // 顺序写盘：只允许一个 drain 在跑（写盘顺序 = 分片顺序），写完立即释放内存
    let nextToWrite = 0;
    let lastMapWritten = null;
    let writeChain = Promise.resolve();
    async function drainWriter() {
      while (useStreaming && nextToWrite < total && chunks[nextToWrite] !== undefined) {
        const idx = nextToWrite++;
        const seg = plan.segments[idx];
        const buf = chunks[idx];
        chunks[idx] = undefined;
        if (plan.isFmp4 && seg.mapUri && seg.mapUri !== lastMapWritten) {
          const init = plan.initSegments.get(seg.mapUri);
          if (init) await writer.write(init);
          lastMapWritten = seg.mapUri;
        }
        if (buf.byteLength > 0) await writer.write(buf);
      }
    }
    function scheduleDrain() {
      writeChain = writeChain.then(drainWriter);
      return writeChain;
    }

    // 带重试的切片抓取（含解密）
    async function fetchSegment(seg, index, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const raw = await fetchBytes(seg.url, seg.byteRange);
          const plain = await decryptSegment(raw, seg);
          chunks[index] = plain;
          completed++;
          totalBytes += plain.byteLength;
          updateProgress();
          if (useStreaming) await scheduleDrain();
          return;
        } catch (err) {
          if (attempt === retries) {
            console.error(`切片 ${index} 下载失败:`, err);
            failed.push({ index, url: seg.url, error: err.message });
            chunks[index] = new ArrayBuffer(0); // 占位保序，失败清单最后如实上报
            completed++;
            updateProgress();
            if (useStreaming) await scheduleDrain();
          } else {
            await new Promise((r) => setTimeout(r, 800));
          }
        }
      }
    }

    // 控制并发数（5个并发通道，既迅速又不会触发反爬风控）
    const CONCURRENCY = 5;
    let currentIdx = 0;

    async function worker() {
      while (currentIdx < total) {
        const idx = currentIdx++;
        await fetchSegment(plan.segments[idx], idx);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    await writeChain; // 确保写盘全部落盘

    statusMsg.textContent = "✨ 正在将所有分段无损合成单个视频文件喵... (✧ω✧)";
    progressText.textContent = "合成中，请稍候...";

    // 汇总失败报告：全部成功 / 部分失败 / 全部失败，三种口径分开说
    function failureReport() {
      if (failed.length === 0) return "";
      const shown = failed.slice(0, 10).map((f) => `#${f.index}`).join("、");
      const more = failed.length > 10 ? ` 等共 ${failed.length} 个` : "";
      return ` ⚠️ 有 ${failed.length} 个切片下载失败（${shown}${more}），对应位置会卡顿/缺失，可重试下载。`;
    }

    try {
      if (useStreaming) {
        await writer.close();
      } else {
        const mergedBlob = new Blob(buildBlobParts(chunks, total), {
          type: plan.isFmp4 ? "video/mp4" : "video/mp2t"
        });
        const blobUrl = URL.createObjectURL(mergedBlob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => {
          URL.revokeObjectURL(blobUrl);
        }, 60000);
      }

      if (failed.length === total) {
        statusMsg.textContent = "下载失败：全部切片都拉取失败，请检查网络或换线路重试喵 (T_T)";
        progressFill.style.background = "#F44336";
      } else if (failed.length > 0) {
        statusMsg.innerHTML =
          "🎉 <b>下载完成，但有缺失！</b> 文件已保存为 <code>" + filename + "</code> 喵！" + failureReport();
        progressFill.style.background = "#FF9800";
        progressText.textContent = `已全部完成 (${(totalBytes / (1024 * 1024)).toFixed(1)} MB)，${failed.length} 个切片失败`;
      } else {
        statusMsg.innerHTML =
          "🎉 <b>下载大成功！</b> 文件已保存为 <code>" + filename + "</code> 喵！(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧<br>常见播放器（PotPlayer、VLC、Windows播放器）均可直接流畅播放哦~";
        progressFill.style.background = "#4CAF50";
        progressText.textContent = `已全部完成 (${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`;
      }
    } catch (e) {
      statusMsg.textContent = "合并文件出错: " + e.message;
    } finally {
      btnStart.disabled = false;
      btnDownloadM3U8.disabled = false;
      isDownloading = false;
    }
  });
});
