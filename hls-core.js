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
  // Compare aggregate successful network goodput over wall-clock windows.
  // Compare the change in total speed when the concurrent segment count changes;
  // a small tolerance filters measurement noise, not per-request speed or errors.
  function createAdaptiveController(config = {}) {
    const clock = config.now || (globalThis.performance?.now ? globalThis.performance.now.bind(globalThis.performance) : Date.now);
    const clamp = (value, lower, upper) => Math.max(lower, Math.min(upper, Math.floor(value)));
    const min = clamp(Number.isFinite(config.min) ? config.min : 1, 1, 8);
    const max = clamp(Number.isFinite(config.max) ? config.max : 8, min, 8);
    const automatic = config.mode !== "manual";
    let width = clamp(Number.isFinite(config.initial) ? config.initial : 2, min, max);
    const windowMs = Math.max(100, config.windowMs ?? 4000);
    const minSamples = Math.max(2, Math.floor(config.minSamples ?? 4));
    const cooldownMs = Math.max(windowMs, config.cooldownMs ?? 12000);
    const noiseTolerance = config.noiseTolerance ?? config.gainThreshold ?? 0.03;
    const declineThreshold = config.declineThreshold ?? noiseTolerance;
    const startedAt = clock();
    let epoch = startedAt, windowBytes = 0, samples = 0, baseline = null, probe = null;
    let cooldownUntil = 0, declines = 0, finished = false;
    let reason = automatic ? "initializing" : "manual";
    const arrivals = [];
    function resetWindow(time = clock()) { epoch = time; windowBytes = 0; samples = 0; }
    function rate(time = clock()) {
      while (arrivals.length && arrivals[0].time <= time - windowMs) arrivals.shift();
      const elapsed = Math.min(windowMs, Math.max(0, time - startedAt));
      return !finished && elapsed > 0 ? arrivals.reduce((total, item) => total + item.bytes, 0) * 1000 / elapsed : 0;
    }
    function metrics() {
      return { bytesPerSecond: rate(), activeConcurrency: width,
        concurrencyMode: automatic ? "auto" : "manual", concurrencyReason: reason };
    }
    function invalidate() {
      if (!automatic) return metrics();
      if (probe) width = probe.width;
      probe = null; baseline = null; declines = 0;
      reason = "insufficient";
      resetWindow();
      return metrics();
    }
    function beginProbe(speed, direction) {
      probe = { width, speed, direction };
      width += direction;
      reason = direction > 0 ? "probing" : "decline";
    }
    function recordSuccess(bytes, eligible = true) {
      const time = clock();
      if (finished || !Number.isFinite(bytes) || bytes <= 0) return metrics();
      arrivals.push({ time, bytes });
      if (!automatic) return metrics();
      if (!eligible) return invalidate();
      windowBytes += bytes; samples++;
      const elapsed = time - epoch;
      if (elapsed < windowMs || samples < minSamples) return metrics();
      const speed = windowBytes * 1000 / elapsed;
      resetWindow(time);
      if (!Number.isFinite(speed) || speed <= 0) return metrics();
      if (probe) {
        const gain = probe.direction > 0 ? speed > probe.speed * (1 + noiseTolerance) : speed >= probe.speed * (1 - noiseTolerance);
        if (gain) { baseline = speed; reason = probe.direction > 0 ? "gain" : "decline"; }
        else { width = probe.width; baseline = probe.speed; reason = "no-gain"; }
        probe = null; declines = 0; cooldownUntil = time + cooldownMs;
      } else if (time < cooldownUntil) {
        baseline = speed; declines = 0; reason = "cooldown";
      } else if (baseline !== null && speed < baseline * (1 - declineThreshold)) {
        declines++;
        if (declines >= 2) {
          if (width > min) beginProbe(speed, -1);
          else {
            // At the lower bound there is no smaller width to compare. Rebase
            // after a confirmed total-speed change so this historical rate
            // cannot prevent future upward probes once conditions stabilize.
            baseline = speed; cooldownUntil = time + cooldownMs; reason = "cooldown";
          }
          declines = 0;
        } else reason = "steady";
      } else {
        baseline = speed; declines = 0;
        if (width < max) beginProbe(speed, 1);
        else reason = "steady";
      }
      return metrics();
    }
    // Retry/backoff consumes the same wall-clock measurement window. An error
    // itself does not change width, reset the baseline, or discard a probe.
    function recordFailure() { return metrics(); }
    function finish() { finished = true; arrivals.length = 0; return metrics(); }
    return { metrics, recordSuccess, recordFailure, invalidate, finish };
  }
  function createClient(options = {}) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    const cryptoApi = options.crypto || globalThis.crypto;
    const signal = options.signal;
    const retries = Number.isFinite(options.retries) ? Math.max(1, Math.min(10, Math.floor(options.retries))) : 6;
    const keyCache = new Map(), mapCache = new Map();
    function annotate(error, details) {
      const result = error instanceof Error || error instanceof DOMException ? error : new Error(String(error));
      for (const [key, value] of Object.entries(details)) if (result[key] === undefined) result[key] = value;
      return result;
    }
    function retryAfter(value) {
      if (!value) return 0;
      const seconds = Number(value);
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - (options.now || Date.now)();
      return Number.isFinite(wait) ? Math.min(30000, Math.max(0, wait)) : 0;
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
          const delayMs = Math.min(30000, Math.max(Math.round(backoff), error.retryAfterMs || 0));
          options.onRetry?.({ attempt, maxAttempts: retries, delayMs, stage: error.stage, resourceUrl: error.resourceUrl, operationUrl: resourceUrl, error });
          await delay(delayMs, operationSignal);
          continue;
        }
        if (attempt > 1) options.onRecovered?.({ resourceUrl, attempt });
        return result;
      }
    }
    async function requestOnce(url, byteRange, asText, operationSignal, cache) {
      ensureActive(operationSignal);
      const controller = new AbortController();
      const abort = () => controller.abort(operationSignal.reason || abortError());
      operationSignal?.addEventListener("abort", abort, { once: true });
      let timedOut = false, httpStatus;
      const timer = setTimeout(() => { timedOut = true; controller.abort(new DOMException("资源请求超时", "TimeoutError")); }, options.timeoutMs ?? 30000);
      try {
        const headers = byteRange ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } : {};
        const response = await fetcher(url, { headers, signal: controller.signal, credentials: "include", ...(cache ? { cache } : {}) });
        httpStatus = response.status;
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* Error-body cleanup must not replace the HTTP failure. */ }
          throw annotate(new Error(`资源请求失败（HTTP ${response.status}）`), {
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            retryAfterMs: [429, 503].includes(response.status) ? retryAfter(response.headers.get("retry-after")) : 0
          });
        }
        if (asText) return { text: await response.text(), url: response.url || url, httpStatus };
        let data = await response.arrayBuffer();
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
        return { data, httpStatus };
      } catch (cause) {
        ensureActive(operationSignal);
        const error = timedOut ? new DOMException("资源请求超时", "TimeoutError") : cause;
        throw annotate(error, { retryable: true, resourceUrl: url, httpStatus, stage: "request" });
      } finally {
        clearTimeout(timer);
        operationSignal?.removeEventListener("abort", abort);
      }
    }
    async function request(url, byteRange, asText = false) {
      const result = await withRetries(attempt => requestOnce(url, byteRange, asText, signal, attempt > 1 ? "no-store" : undefined), signal, url);
      return asText ? { text: result.text, url: result.url } : result.data;
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
        const { data: raw, httpStatus } = await requestOnce(resource.url, resource.byteRange, false, operationSignal, cache);
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
    // Slide a bounded read/cache window behind an ordered writer. Successful
    // peers are cached immediately, including when another segment later fails.
    async function download(plan, sink, onProgress = () => {}, concurrency = 5, hooks = {}) {
      if (plan.isFmp4 && (plan.maps.size > 1 || plan.discontinuities)) throw new Error("此 fMP4 线路存在初始化段或时间轴切换，需要重新封装；请更换线路或使用外部下载工具");
      let bytes = 0, completed = 0, lastMap = null;
      const auto = concurrency === "auto" || concurrency?.mode === "auto";
      const adaptive = createAdaptiveController({ ...(auto && typeof concurrency === "object" ? concurrency : {}),
        mode: auto ? "auto" : "manual", ...(auto ? {} : { initial: Number.isFinite(concurrency) ? concurrency : 5 }), now: options.now });
      function emitMetrics(value = adaptive.metrics()) {
        try { Promise.resolve(options.onMetrics?.(value)).catch(() => {}); } catch { /* Metrics cannot interrupt media work. */ }
        return value;
      }
      emitMetrics();
      // Keep displayed goodput honest during stalls/backoff without training on
      // a window that has no new samples. Learning remains completion driven.
      const metricsTimer = options.onMetrics ? setInterval(() => emitMetrics(), 1000) : null;
      const operation = new AbortController();
      const abort = () => operation.abort(signal.reason || abortError());
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const pending = new Map();
      let nextToSchedule = 0, firstFailure = null;
      function segmentError(cause, index, segment, stage) {
        if (cause.name === "AbortError") return cause;
        const error = new Error(`第 ${index + 1} 个分片处理失败：${cause.message}`, { cause });
        error.name = cause.name || "Error";
        Object.assign(error, { retryable: cause.retryable ?? false, resourceUrl: cause.resourceUrl || segment.url,
          httpStatus: cause.httpStatus, stage: cause.stage || stage, segmentIndex: index, segmentNumber: index + 1,
          segmentUrl: segment.url, attempts: cause.attempts });
        return error;
      }
      async function readSegment(index) {
        const segment = plan.segments[index];
        let stage = "cache-read";
        try {
          ensureActive(operation.signal);
          if (hooks.getSegment) {
            const cached = await hooks.getSegment(index, segment);
            ensureActive(operation.signal);
            if (cached != null) {
              if (Object.prototype.toString.call(cached) !== "[object ArrayBuffer]" || !cached.byteLength) throw new Error("已缓存的分片内容无效");
              emitMetrics(adaptive.invalidate());
              return { data: cached };
            }
          }
          stage = "request";
          const data = await readResource(segment, operation.signal, { onFailure(error) { emitMetrics(adaptive.recordFailure(error)); } });
          ensureActive(operation.signal);
          const width = adaptive.metrics().activeConcurrency;
          const eligible = nextToSchedule < plan.segments.length && plan.segments.length - completed >= width * 2;
          emitMetrics(adaptive.recordSuccess(data.byteLength, eligible));
          if (hooks.putSegment) {
            stage = "cache-write";
            await hooks.putSegment(index, segment, data);
          }
          ensureActive(operation.signal);
          return { data };
        } catch (cause) {
          const error = segmentError(cause, index, segment, stage);
          if (stage === "cache-read" || stage === "cache-write") { error.retryable = false; error.stage = stage; }
          if (!firstFailure && error.name !== "AbortError") firstFailure = error;
          return { error };
        }
      }
      function fillWindow(written) {
        const width = adaptive.metrics().activeConcurrency;
        while (!firstFailure && !operation.signal.aborted && nextToSchedule < plan.segments.length && nextToSchedule < written + width) {
          const index = nextToSchedule++;
          pending.set(index, readSegment(index));
        }
      }
      try {
        fillWindow(0);
        for (let index = 0; index < plan.segments.length; index++) {
          ensureActive(operation.signal);
          const result = await pending.get(index);
          ensureActive(operation.signal);
          if (firstFailure) throw firstFailure;
          if (result?.error) throw result.error;
          const segment = plan.segments[index];
          if (segment.mapId && (segment.mapId !== lastMap || segment.discontinuity)) {
            let init;
            try { init = await readMap(plan, segment.mapId, operation.signal); }
            catch (error) { throw segmentError(error, index, segment, "request"); }
            ensureActive(operation.signal);
            try { await sink.write(init); }
            catch (error) {
              const failure = segmentError(error, index, segment, "sink-write");
              failure.retryable = false; failure.stage = "sink-write"; throw failure;
            }
            ensureActive(operation.signal);
            bytes += init.byteLength;
            lastMap = segment.mapId;
          }
          ensureActive(operation.signal);
          try { await sink.write(result.data); }
          catch (error) {
            const failure = segmentError(error, index, segment, "sink-write");
            failure.retryable = false; failure.stage = "sink-write"; throw failure;
          }
          ensureActive(operation.signal);
          bytes += result.data.byteLength;
          completed++;
          pending.delete(index);
          onProgress({ bytes, completed, total: plan.segments.length, ...emitMetrics() });
          fillWindow(completed);
        }
        return { bytes, completed, total: plan.segments.length };
      } catch (error) {
        // Keep successful peers running long enough to persist their cache on a
        // network failure. Storage failure can stop outstanding network work.
        if (["sink-write", "cache-read", "cache-write"].includes(error.stage)) operation.abort(abortError());
        throw error;
      } finally {
        await Promise.allSettled(pending.values());
        clearInterval(metricsTimer);
        signal?.removeEventListener("abort", abort);
        emitMetrics(adaptive.finish());
      }
    }
    return { loadPlan, download, readResource, request };
  }
  function safeFilename(value, extension) {
    let name = String(value || "视频").normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 140);
    if (!name) name = "视频";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return `${name}.${extension}`;
  }
  return { attributes, parsePlaylist, parseIv, sequenceToIv, createClient, safeFilename, absolutizePlaylist, createAdaptiveController };
});
