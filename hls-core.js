/* HLS parsing and ordered downloading. Shared by the extension and Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NekoHls = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function attributes(value) {
    const result = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match;
    while ((match = pattern.exec(value))) result[match[1]] = match[2].replace(/^"|"$/g, "");
    return result;
  }
  function mediaUrl(value, base) {
    if (!value) throw new Error("播放清单缺少资源地址");
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol)) throw new Error("仅支持 HTTP / HTTPS 视频资源");
    return url.href;
  }
  function absolutizePlaylist(text, base) {
    const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== "#EXTM3U") throw new Error("返回内容不是有效的 m3u8 播放清单");
    return lines.map(line => {
      if (!line) return line;
      if (!line.startsWith("#")) return mediaUrl(line, base);
      return line.replace(/([:,])URI="([^"]*)"/g, (_match, prefix, uri) => `${prefix}URI="${mediaUrl(uri, base)}"`);
    }).join("\n");
  }
  function sequenceToIv(sequence) {
    let n = BigInt(sequence);
    if (n < 0n || n >= 1n << 128n) throw new Error("分片序号超出有效范围");
    const iv = new Uint8Array(16);
    for (let i = 15; i >= 0; i--, n >>= 8n) iv[i] = Number(n & 255n);
    return iv;
  }
  function parseIv(value) {
    if (!/^0x[\da-f]{1,32}$/i.test(value)) throw new Error("AES-128 的 IV 格式无效");
    return sequenceToIv(BigInt(value));
  }
  function parseRange(value, url, previous) {
    const match = /^(\d+)(?:@(\d+))?$/.exec(value || "");
    if (!match) throw new Error("分片字节范围格式无效");
    const length = Number(match[1]);
    const offset = match[2] === undefined ? previous?.url === url ? previous.offset + previous.length : NaN : Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) throw new Error("字节范围无效，隐式偏移必须接续同一个资源");
    return { length, offset };
  }
  function parsePlaylist(text, base) {
    const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== "#EXTM3U") throw new Error("返回内容不是有效的 m3u8 播放清单");
    if (lines.includes("#EXT-X-I-FRAMES-ONLY")) throw new Error("这是仅含关键帧的预览清单，请选择完整视频线路");
    if (lines.some(line => line.startsWith("#EXT-X-STREAM-INF:"))) {
      const variants = [];
      const audioGroups = new Map();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-MEDIA:")) {
          const a = attributes(lines[i].slice(13));
          if (a.TYPE === "AUDIO" && a.URI) audioGroups.set(a["GROUP-ID"], true);
        }
        if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
        const a = attributes(lines[i].slice(18));
        let j = i + 1;
        while (j < lines.length && !lines[j]) j++;
        if (!lines[j] || lines[j].startsWith("#")) throw new Error("多码率清单缺少视频地址");
        variants.push({ url: mediaUrl(lines[j], base), bandwidth: Number(a["AVERAGE-BANDWIDTH"] || a.BANDWIDTH) || 0, audioGroup: a.AUDIO });
      }
      variants.forEach(variant => { variant.externalAudio = audioGroups.has(variant.audioGroup); });
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      return { kind: "master", variants };
    }
    const segments = [];
    const maps = new Map();
    let sequence = 0n, key = null, map = null, rangeText = null, previousRange = null, previousMapRange = null, duration = null;
    let totalDuration = 0, endList = false, discontinuity = false, discontinuities = 0;
    for (const line of lines.slice(1)) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        const value = line.slice(22);
        if (!/^\d+$/.test(value)) throw new Error("播放清单的分片序号无效");
        sequence = BigInt(value);
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const a = attributes(line.slice(11));
        if (a.METHOD === "NONE") key = null;
        else {
          if (a.METHOD !== "AES-128" || (a.KEYFORMAT && a.KEYFORMAT !== "identity")) throw new Error("此线路采用不支持的加密方式；仅支持普通 AES-128 HLS");
          key = { url: mediaUrl(a.URI, base), iv: a.IV ? parseIv(a.IV) : null };
        }
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const a = attributes(line.slice(11));
        const url = mediaUrl(a.URI, base);
        const byteRange = a.BYTERANGE ? parseRange(a.BYTERANGE, url, previousMapRange) : null;
        previousMapRange = byteRange ? { url, ...byteRange } : null;
        if (key && !key.iv) throw new Error("加密初始化段缺少显式 IV，无法可靠合并");
        const id = JSON.stringify([url, byteRange, key?.url, key?.iv ? Array.from(key.iv) : null]);
        map = { id, url, byteRange, key, iv: key?.iv || null };
        maps.set(id, map);
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) rangeText = line.slice(17);
      else if (line.startsWith("#EXTINF:")) {
        duration = Number(line.slice(8).split(",")[0]);
        if (!Number.isFinite(duration) || duration < 0) throw new Error("分片时长无效");
      } else if (line === "#EXT-X-ENDLIST") endList = true;
      else if (line === "#EXT-X-DISCONTINUITY") { discontinuity = true; discontinuities++; }
      else if (line.startsWith("#EXT-X-GAP")) throw new Error("该线路缺少部分视频分片，请更换线路");
      else if (line && !line.startsWith("#")) {
        if (duration === null) throw new Error("清单资源缺少 EXTINF 分片时长");
        const url = mediaUrl(line, base);
        const byteRange = rangeText ? parseRange(rangeText, url, previousRange) : null;
        previousRange = byteRange ? { url, ...byteRange } : null;
        segments.push({ url, byteRange, key, iv: key ? key.iv || sequenceToIv(sequence) : null, mapId: map?.id || null, sequence: sequence.toString(), duration, discontinuity });
        sequence++;
        totalDuration += duration;
        rangeText = null;
        duration = null;
        discontinuity = false;
      }
    }
    if (!segments.length) throw new Error("播放清单中没有可下载的视频分片");
    if (!endList) throw new Error("这是尚未结束的直播或滚动清单，无法作为完整视频导出");
    const isFmp4 = maps.size > 0 || segments.some(segment => /\.m4s(?:$|\?)/i.test(segment.url));
    if (isFmp4 && segments.some(segment => !segment.mapId)) throw new Error("fMP4 流缺少初始化段，无法生成可播放文件");
    return { kind: "media", url: base, segments, maps, isFmp4, totalDuration, discontinuities };
  }
  const abortError = () => new DOMException("下载已取消", "AbortError");
  function validatePayload(buffer) {
    if (!buffer.byteLength) throw new Error("解密后的视频分片为空");
    const prefix = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength))).trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<\?xml\b|\{\s*"(?:error|message|code)"\s*:)/i.test(prefix)) throw new Error("视频地址返回了错误页面，请重新播放网页后重试");
    return buffer;
  }
  function ensureActive(signal) { if (signal?.aborted) throw signal.reason || abortError(); }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      ensureActive(signal);
      const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(done, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason || abortError()); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function createClient(options = {}) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    const cryptoApi = options.crypto || globalThis.crypto;
    const signal = options.signal;
    const retries = options.retries ?? 3;
    const keyCache = new Map(), mapCache = new Map();
    async function request(url, byteRange, asText = false) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        ensureActive(signal);
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason || abortError());
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error("请求超时")), options.timeoutMs ?? 30000);
        try {
          const headers = byteRange ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } : {};
          const response = await fetcher(url, { headers, signal: controller.signal, credentials: "include" });
          if (!response.ok) {
            const error = new Error(`资源请求失败（HTTP ${response.status}）`);
            error.noRetry = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
            throw error;
          }
          if (asText) return { text: await response.text(), url: response.url || url };
          let data = await response.arrayBuffer();
          if (byteRange) {
            if (response.status === 200) {
              if (data.byteLength < byteRange.offset + byteRange.length) throw new Error("服务器返回的完整资源不足以覆盖字节范围");
              data = data.slice(byteRange.offset, byteRange.offset + byteRange.length);
            } else if (response.status === 206) {
              const contentRange = response.headers.get("content-range");
              const expected = new RegExp(`^bytes ${byteRange.offset}-${byteRange.offset + byteRange.length - 1}/(?:\\d+|\\*)$`, "i");
              if (!contentRange || !expected.test(contentRange)) throw new Error("服务器返回了错误的字节范围");
            } else throw new Error("服务器没有正确响应分片范围请求");
            if (data.byteLength !== byteRange.length) throw new Error("分片字节数不完整");
          }
          if (!data.byteLength) throw new Error("服务器返回了空分片");
          return data;
        } catch (error) {
          ensureActive(signal);
          if (attempt >= retries || error.noRetry) throw error;
          options.onRetry?.({ attempt, error });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
        await delay((options.retryDelayMs ?? 500) * attempt, signal);
      }
    }
    async function loadPlan(url) {
      const visited = new Set();
      for (let depth = 0; depth < 8; depth++) {
        if (visited.has(url)) throw new Error("播放清单存在循环引用");
        visited.add(url);
        const response = await request(mediaUrl(url), null, true);
        const plan = parsePlaylist(response.text, response.url);
        if (plan.kind === "media") return plan;
        const variant = plan.variants.find(item => !item.externalAudio);
        if (!variant) throw new Error("此线路的音视频分轨，需要封装工具合并；请换一条音视频合一的线路");
        options.onVariant?.(variant, plan.variants.length);
        url = variant.url;
      }
      throw new Error("播放清单嵌套过深");
    }
    async function getKey(url) {
      if (!keyCache.has(url)) keyCache.set(url, (async () => {
        const bytes = await request(url);
        if (bytes.byteLength !== 16) throw new Error("AES-128 密钥长度无效（应为 16 字节）");
        return cryptoApi.subtle.importKey("raw", bytes, "AES-CBC", false, ["decrypt"]);
      })());
      try { return await keyCache.get(url); }
      catch (error) { keyCache.delete(url); throw error; }
    }
    async function readResource(resource) {
      const raw = await request(resource.url, resource.byteRange);
      if (!resource.key) return validatePayload(raw);
      const key = await getKey(resource.key.url);
      ensureActive(signal);
      let decoded;
      try { decoded = await cryptoApi.subtle.decrypt({ name: "AES-CBC", iv: resource.iv }, key, raw); }
      catch { throw new Error("AES-128 解密失败，请重新播放网页后获取最新线路"); }
      return validatePayload(decoded);
    }
    async function readMap(plan, id) {
      if (!mapCache.has(id)) mapCache.set(id, readResource(plan.maps.get(id)));
      try { return await mapCache.get(id); }
      catch (error) { mapCache.delete(id); throw error; }
    }
    // Consume each window before scheduling the next: bounded reorder memory.
    async function download(plan, sink, onProgress = () => {}, concurrency = 5) {
      if (plan.isFmp4 && (plan.maps.size > 1 || plan.discontinuities)) throw new Error("此 fMP4 线路存在初始化段或时间轴切换，需要重新封装；请更换线路或使用外部下载工具");
      let bytes = 0, completed = 0, lastMap = null;
      const width = Number.isFinite(concurrency) ? Math.max(1, Math.min(8, Math.floor(concurrency))) : 5;
      for (let start = 0; start < plan.segments.length; start += width) {
        ensureActive(signal);
        const window = plan.segments.slice(start, start + width);
        const results = await Promise.allSettled(window.map(segment => readResource(segment)));
        ensureActive(signal);
        const failed = results.findIndex(result => result.status === "rejected");
        if (failed >= 0) throw new Error(`第 ${start + failed + 1} 个分片下载失败：${results[failed].reason.message}`);
        for (let i = 0; i < window.length; i++) {
          ensureActive(signal);
          const segment = window[i];
          if (segment.mapId && (segment.mapId !== lastMap || segment.discontinuity)) {
            const init = await readMap(plan, segment.mapId);
            await sink.write(init);
            bytes += init.byteLength;
            lastMap = segment.mapId;
          }
          const data = results[i].value;
          await sink.write(data);
          bytes += data.byteLength;
          completed++;
          results[i] = null;
          onProgress({ bytes, completed, total: plan.segments.length });
        }
      }
      return { bytes, completed, total: plan.segments.length };
    }
    return { loadPlan, download, readResource, request };
  }
  function safeFilename(value, extension) {
    let name = String(value || "视频").normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 140);
    if (!name) name = "视频";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return `${name}.${extension}`;
  }
  return { attributes, parsePlaylist, parseIv, sequenceToIv, createClient, safeFilename, absolutizePlaylist };
});
