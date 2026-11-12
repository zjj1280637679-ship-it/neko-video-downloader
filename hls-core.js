/* HLS parsing and ordered downloading. Shared by the extension and Node tests. */
(function (root, factory) {
  const commonjs = typeof module === "object" && module.exports;
  const api = factory(commonjs ? require('./engine/segment-scheduler.js') : root.NekoSegmentScheduler);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NekoHls = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (segmentScheduler) {
  "use strict";
  const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
  const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
  function attributes(value) {
    const result = {};
    const pattern = /([A-Z0-9_-]+)\s*=\s*("[^"]*"|[^,]*)/gi;
    let match;
    while ((match = pattern.exec(value || ''))) result[match[1].toUpperCase()] = match[2].trim().replace(/^"|"$/g, "");
    return result;
  }
  function mediaUrl(value, base) {
    if (!value) throw new Error("播放清单缺少资源地址");
    const trimmed = String(value).trim();
    if (!trimmed) throw new Error("播放清单缺少资源地址");
    const url = new URL(trimmed, base);
    if (!/^https?:$/.test(url.protocol)) throw new Error("仅支持 HTTP / HTTPS 视频资源");
    return url.href;
  }
  function absolutizePlaylist(text, base) {
    const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim());
    if (lines[0] !== "#EXTM3U") throw new Error("返回内容不是有效的 m3u8 播放清单");
    return lines.map(line => {
      if (!line) return line;
      if (!line.startsWith("#")) return mediaUrl(line, base);
      return line.replace(/([:,])\s*URI="([^"]*)"/gi, (_match, prefix, uri) => `${prefix}URI="${mediaUrl(uri, base)}"`);
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
  function selectKey(formats, base) {
    if (!formats.size) return null;
    const selected = formats.get('identity');
    if (!selected || selected.METHOD !== 'AES-128') throw new Error('此线路采用不支持的加密方式；仅支持 identity 格式的普通 AES-128 HLS');
    return { url: mediaUrl(selected.URI, base), iv: selected.IV ? parseIv(selected.IV) : null };
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
    const keyFormats = new Map();
    let sequence = 0n, map = null, rangeText = null, previousRange = null, previousMapRange = null, duration = null;
    let totalDuration = 0, endList = false, discontinuity = false, discontinuities = 0;
    for (const line of lines.slice(1)) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        const value = line.slice(22);
        if (!/^\d+$/.test(value)) throw new Error("播放清单的分片序号无效");
        sequence = BigInt(value);
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const a = attributes(line.slice(11));
        if (a.METHOD === "NONE") keyFormats.clear();
        else keyFormats.set(a.KEYFORMAT || 'identity', a);
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const a = attributes(line.slice(11));
        const url = mediaUrl(a.URI, base);
        const byteRange = a.BYTERANGE ? parseRange(a.BYTERANGE, url, previousMapRange) : null;
        previousMapRange = byteRange ? { url, ...byteRange } : null;
        // MAP keeps the encryption context at its declaration, independently
        // of keys selected for later media segments. Resolve only when used.
        map = { url, byteRange, keyFormats: new Map(keyFormats) };
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
        if (map && !map.id) {
          const mapKey = selectKey(map.keyFormats, base);
          if (mapKey && !mapKey.iv) throw new Error("加密初始化段缺少显式 IV，无法可靠合并");
          const id = JSON.stringify([map.url, map.byteRange, mapKey?.url, mapKey?.iv ? Array.from(mapKey.iv) : null]);
          map = { id, url: map.url, byteRange: map.byteRange, key: mapKey, iv: mapKey?.iv || null };
          maps.set(id, map);
        }
        const key = selectKey(keyFormats, base);
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
      // Long server Retry-After values must not overflow setTimeout or be
      // shortened into an early retry. Keep cancellation available throughout.
      const timer = setTimeout(done, Math.min(ms, 2147483647));
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason || abortError()); };
      signal?.addEventListener("abort", abort, { once: true });
    }).then(() => ms > 2147483647 ? delay(ms - 2147483647, signal) : undefined);
  }
  // ETA belongs to the running transfer, not the popup. Cache reads are not
  // throughput samples. A rolling window includes retry/backoff time; after a
  // stall or before enough samples arrive, unknown is more honest than zero.
  function createEtaEstimator({ totalSegments, now = Date.now, windowMs = 12000 } = {}) {
    const startedAt = now(), available = new Set(), samples = [];
    let finished = false;
    const unknown = () => ({ etaSeconds: null, etaBasis: 'unknown' });
    function record(index, bytes) {
      if (finished || !Number.isInteger(index) || index < 0 || index >= totalSegments || available.has(index)) return;
      available.add(index);
      if (Number.isFinite(bytes) && bytes > 0) samples.push({ time: now(), bytes });
    }
    function metrics() {
      const time = now();
      while (samples.length && samples[0].time <= time - windowMs) samples.shift();
      const elapsed = Math.min(windowMs, time - startedAt), remaining = totalSegments - available.size;
      if (finished || !Number.isInteger(totalSegments) || totalSegments <= 0 || remaining <= 0 || elapsed < 2000 || samples.length < 3) return unknown();
      const bytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
      const averageSegmentBytes = bytes / samples.length;
      const aggregateGoodput = bytes * 1000 / elapsed;
      const seconds = remaining * averageSegmentBytes / aggregateGoodput;
      return Number.isFinite(seconds) && seconds > 0 ? { etaSeconds: Math.ceil(seconds), etaBasis: 'network-segments' } : unknown();
    }
    return { recordNetwork: record, recordCached(index) { record(index, null); }, metrics,
      finish() { finished = true; samples.length = 0; return unknown(); } };
  }
  function createClient(options = {}) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    const cryptoApi = options.crypto || globalThis.crypto;
    const signal = options.signal;
    const retries = Number.isFinite(options.retries) ? Math.max(1, Math.min(10, Math.floor(options.retries))) : 6;
    const keyCache = new Map(), mapCache = new Map();
    const originCooldowns = new Map();
    let requestSequence = 0;
    function annotate(error, details) {
      const result = error instanceof Error || error instanceof DOMException ? error : new Error(String(error));
      for (const [key, value] of Object.entries(details)) if (result[key] === undefined) result[key] = value;
      return result;
    }
    function retryAfter(value) {
      if (!value) return 0;
      const seconds = Number(value);
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - (options.now || Date.now)();
      return Number.isFinite(wait) ? Math.max(0, wait) : 0;
    }
    async function withRetries(operation, operationSignal, resourceUrl, observer) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        ensureActive(operationSignal);
        let result;
        try {
          result = await operation(attempt);
        } catch (cause) {
          ensureActive(operationSignal);
          const error = annotate(cause, { retryable: true, resourceUrl, stage: "request" });
          error.attempts = attempt;
          observer?.onFailure?.(error);
          if (!error.retryable || attempt >= retries) throw error;
          const base = Math.max(0, options.retryDelayMs ?? 500);
          const cap = Math.max(0, Math.min(30000, options.maxRetryDelayMs ?? 10000));
          const random = Math.max(0, Math.min(1, (options.random || Math.random)()));
          const backoff = Math.min(cap, base * 2 ** (attempt - 1) * (0.8 + random * 0.4));
          const delayMs = Math.max(Math.round(backoff), error.retryAfterMs || 0);
          options.onRetry?.({ attempt, maxAttempts: retries, delayMs, stage: error.stage, resourceUrl: error.resourceUrl, operationUrl: resourceUrl, error });
          await delay(delayMs, operationSignal);
          continue;
        }
        if (attempt > 1) options.onRecovered?.({ resourceUrl, attempt });
        return result;
      }
    }
    async function requestOnce(url, byteRange, asText, operationSignal, cache, observer) {
      ensureActive(operationSignal);
      const origin = new URL(url).origin;
      while ((originCooldowns.get(origin) || 0) > Date.now()) await delay(originCooldowns.get(origin) - Date.now(), operationSignal);
      ensureActive(operationSignal);
      const controller = new AbortController();
      const abort = () => controller.abort(operationSignal.reason || abortError());
      operationSignal?.addEventListener("abort", abort, { once: true });
      let timedOut = false, httpStatus, succeeded = false;
      const startTimeout = () => setTimeout(() => { timedOut = true; controller.abort(new DOMException("资源请求超时", "TimeoutError")); }, options.timeoutMs ?? 30000);
      let timer = startTimeout();
      const requestId = ++requestSequence;
      observer?.onStart?.(requestId);
      try {
        const headers = byteRange ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } : {};
        const response = await fetcher(url, { headers, signal: controller.signal, credentials: "include", ...(cache ? { cache } : {}) });
        httpStatus = response.status;
        const retryAfterMs = [429, 503].includes(response.status) ? retryAfter(response.headers.get('retry-after')) : 0;
        if (retryAfterMs > 0) originCooldowns.set(origin, Math.max(originCooldowns.get(origin) || 0, Date.now() + retryAfterMs));
        const encoded = response.headers.get('content-encoding');
        observer?.onResponse?.(requestId, { status: httpStatus, retryAfterMs,
          contentLength: !encoded || encoded === 'identity' ? Number(response.headers.get('content-length')) || null : null });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* Error-body cleanup must not replace the HTTP failure. */ }
          throw annotate(new Error(`资源请求失败（HTTP ${response.status}）`), {
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            retryAfterMs
          });
        }
        const requestedLimit = asText ? options.maxPlaylistBytes : options.maxResourceBytes;
        const defaultLimit = asText ? MAX_PLAYLIST_BYTES : MAX_SEGMENT_BYTES;
        const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, defaultLimit) : defaultLimit;
        const reserve = observer?.prepareBody ? async size => {
          clearTimeout(timer); // Local buffer backpressure is not a network timeout.
          try { await observer.prepareBody(size, operationSignal); ensureActive(operationSignal); }
          finally { if (!operationSignal?.aborted) timer = startTimeout(); }
        } : null;
        let data = await readBoundedBody(response, limit, asText ? '播放清单' : '单个分片', observer ? {
          onBytes: size => observer.onBytes?.(requestId, size),
          declare: size => observer.declareBody?.(size),
          reserve
        } : null);
        if (asText) { succeeded = true; return { text: new TextDecoder().decode(data), url: response.url || url, httpStatus }; }
        if (byteRange) {
          if (response.status === 200) {
            if (data.byteLength < byteRange.offset + byteRange.length) throw new Error("服务器返回的完整资源不足以覆盖字节范围");
            data = data.slice(byteRange.offset, byteRange.offset + byteRange.length);
          } else if (response.status === 206) {
            const contentRange = response.headers.get("content-range");
            const expected = new RegExp(`^bytes ${byteRange.offset}-${byteRange.offset + byteRange.length - 1}/(?:\\d+|\\*)$`, "i");
            if (!contentRange || !expected.test(contentRange)) throw annotate(new Error("服务器返回了错误的字节范围"), { retryable: false });
          } else throw annotate(new Error("服务器没有正确响应分片范围请求"), { retryable: false });
          if (data.byteLength !== byteRange.length) throw new Error("分片字节数不完整");
        }
        if (!data.byteLength) throw new Error("服务器返回了空分片");
        succeeded = true;
        return { data, httpStatus, requestId };
      } catch (cause) {
        ensureActive(operationSignal);
        const error = timedOut ? new DOMException("资源请求超时", "TimeoutError") : cause;
        throw annotate(error, { retryable: true, resourceUrl: url, httpStatus, stage: "request" });
      } finally {
        clearTimeout(timer);
        operationSignal?.removeEventListener("abort", abort);
        observer?.onEnd?.(requestId, { ok: succeeded, timeout: timedOut });
      }
    }
    async function readBoundedBody(response, limit, label, observer) {
      const tooLarge = () => annotate(new Error(`${label}超过 ${Math.ceil(limit / 1024 / 1024)} MB 安全处理上限，请更换线路`), { retryable: false, stage: 'resource-limit' });
      const declared = Number(response.headers.get('content-length'));
      const encoding = response.headers.get('content-encoding');
      let exactLength = Number.isSafeInteger(declared) && declared > 0 && (!encoding || encoding === 'identity') ? declared : null;
      const checkLength = size => { if (exactLength !== null && size !== exactLength) throw new Error('分片实际长度与响应声明不符'); };
      if (Number.isFinite(declared) && declared > limit) {
        try { await response.body?.cancel(); } catch {}
        throw tooLarge();
      }
      // Honest Content-Length reserves the complete payload before reading.
      // Chunked responses grow incrementally, so missing headers do not force
      // all small fragments through a worst-case 64 MiB reservation.
      try {
        exactLength = observer?.declare?.(exactLength) ?? exactLength;
        await observer?.reserve?.(exactLength ?? Math.min(65536, limit));
      }
      catch (error) { try { await response.body?.cancel(); } catch {} throw error; }
      if (!response.body?.getReader) {
        const data = await response.arrayBuffer();
        if (data.byteLength > limit) throw tooLarge();
        checkLength(data.byteLength);
        observer?.onBytes?.(data.byteLength);
        await observer?.reserve?.(data.byteLength);
        return data;
      }
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          await observer?.reserve?.(exactLength ?? Math.min(limit, size + 65536));
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw tooLarge();
          if (exactLength !== null && size > exactLength) checkLength(size);
          // Observe actual arrival before any local wait. One reader chunk can
          // exceed the read-ahead reservation; browser-owned buffers are not
          // part of the scheduler's payload budget.
          observer?.onBytes?.(value.byteLength);
          await observer?.reserve?.(size);
          chunks.push(value);
        }
        checkLength(size);
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        return data.buffer;
      } catch (error) {
        try { await reader.cancel(); } catch {}
        throw error;
      } finally { reader.releaseLock(); }
    }
    async function request(url, byteRange, asText = false) {
      const result = await withRetries(attempt => requestOnce(url, byteRange, asText, signal, attempt > 1 ? "no-store" : undefined), signal, url);
      return asText ? { text: result.text, url: result.url } : result.data;
    }
    async function loadPlan(url) {
      let attempts = 0;
      async function visit(target, ancestors = new Set()) {
        ensureActive(signal);
        if (ancestors.size >= 16) throw new Error('播放清单嵌套过深');
        if (ancestors.has(target)) throw new Error('播放清单存在循环引用');
        if (++attempts > 32) throw new Error('播放清单候选过多，请选择更具体的线路');
        const response = await request(mediaUrl(target), null, true);
        if (ancestors.has(response.url)) throw new Error('播放清单存在循环引用');
        const plan = parsePlaylist(response.text, response.url);
        if (plan.kind === 'media') {
          // A candidate is prepared only after its first initialization/key
          // context is usable. MAP also exists for MPEG-TS, so inspect bytes.
          const firstMap = plan.segments[0]?.mapId;
          if (firstMap) {
            const init = new Uint8Array(await readMap(plan, firstMap, signal));
            if (init.length >= 188 && init[0] === 0x47 && (init.length < 376 || init[188] === 0x47)) plan.isFmp4 = false;
            else if (init.length >= 8 && ['ftyp', 'moov'].includes(String.fromCharCode(...init.subarray(4, 8)))) plan.isFmp4 = true;
          }
          if (plan.isFmp4 && (plan.maps.size > 1 || plan.discontinuities)) throw new Error('此 fMP4 线路需要重新封装，请更换线路');
          if (plan.segments[0]?.key) await getKey(plan.segments[0].key.url, signal);
          return plan;
        }
        const path = new Set([...ancestors, target, response.url]);
        const failures = [];
        for (let index = 0; index < plan.variants.length; index++) {
          const variant = plan.variants[index];
          if (variant.externalAudio) { failures.push('音视频分轨，需要封装工具合并'); continue; }
          try {
            const selected = await visit(variant.url, path);
            const selection = { bandwidth: variant.bandwidth, rank: index + 1, total: plan.variants.length, failures };
            selected.variantSelections = [selection, ...(selected.variantSelections || [])];
            options.onVariant?.(variant, plan.variants.length, selection);
            return selected;
          } catch (error) {
            ensureActive(signal);
            failures.push(String(error.message).slice(0, 200));
            if (attempts >= 32) break;
          }
        }
        throw new Error(`已有画质候选均无法准备：${failures.slice(0, 3).join('；')}`);
      }
      return visit(url);
    }
    async function getKey(url, operationSignal, cache) {
      if (!keyCache.has(url)) {
        const token = {};
        token.promise = (async () => {
          try {
            const { data: bytes, httpStatus } = await requestOnce(url, null, false, operationSignal, cache);
            if (bytes.byteLength !== 16) throw annotate(new Error("AES-128 密钥长度无效（应为 16 字节）"), { httpStatus });
            return await cryptoApi.subtle.importKey("raw", bytes, "AES-CBC", false, ["decrypt"]);
          } catch (error) { error.stage = "key"; throw annotate(error, { retryable: true, resourceUrl: url }); }
        })();
        keyCache.set(url, token);
      }
      const token = keyCache.get(url);
      try { return { key: await token.promise, token }; }
      catch (error) {
        if (keyCache.get(url) === token) keyCache.delete(url);
        throw error;
      }
    }
    async function readResource(resource, operationSignal = signal, observer) {
      return withRetries(async attempt => {
        const cache = attempt > 1 ? "no-store" : undefined;
        const { data: raw, httpStatus, requestId } = await requestOnce(resource.url, resource.byteRange, false, operationSignal, cache, observer);
        let keyEntry, stage = "payload";
        try {
          validatePayload(raw);
          if (!resource.key) return raw;
          stage = "decrypt";
          if (raw.byteLength % 16 !== 0) throw new Error("AES-128 分片长度不完整");
          keyEntry = await getKey(resource.key.url, operationSignal, cache);
          ensureActive(operationSignal);
          let decoded;
          try { decoded = await cryptoApi.subtle.decrypt({ name: "AES-CBC", iv: resource.iv }, keyEntry.key, raw); }
          catch { throw new Error("AES-128 解密失败，请重新播放网页后获取最新线路"); }
          stage = "payload";
          return validatePayload(decoded);
        } catch (error) {
          observer?.onInvalid?.(requestId);
          ensureActive(operationSignal);
          if (keyEntry && keyCache.get(resource.key.url) === keyEntry.token) keyCache.delete(resource.key.url);
          throw annotate(error, { retryable: true, resourceUrl: resource.url, httpStatus, stage });
        }
      }, operationSignal, resource.url, observer);
    }
    async function readMap(plan, id, operationSignal) {
      if (!mapCache.has(id)) mapCache.set(id, readResource(plan.maps.get(id), operationSignal));
      const pending = mapCache.get(id);
      try { return await pending; }
      catch (error) { if (mapCache.get(id) === pending) mapCache.delete(id); throw error; }
    }
    async function download(plan, sink, onProgress = () => {}, concurrency = 64, hooks = {}) {
      if (plan.isFmp4 && (plan.maps.size > 1 || plan.discontinuities)) throw new Error('此 fMP4 线路存在初始化段或时间轴切换，需要重新封装；请更换线路或使用外部下载工具');
      const resourceLimit = Number.isSafeInteger(options.maxResourceBytes) && options.maxResourceBytes > 0 ? Math.min(MAX_SEGMENT_BYTES, options.maxResourceBytes) : MAX_SEGMENT_BYTES;
      return segmentScheduler.download(plan, sink, onProgress, concurrency, hooks, {
        ...options, resourceLimit, readResource, readMap, createEtaEstimator
      });
    }
    return { loadPlan, download, readResource, request };
  }
  function safeFilename(value, extension) {
    let name = String(value || "视频").normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 140);
    if (!name) name = "视频";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return `${name}.${extension}`;
  }
  return { attributes, parsePlaylist, parseIv, sequenceToIv, createClient, safeFilename, absolutizePlaylist, createEtaEstimator };
});
