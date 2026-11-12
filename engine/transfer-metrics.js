/* Passive observations for speed display. This module never chooses concurrency. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NekoTransferMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createTracker({ now = () => performance.now(), windowMs = 4000 } = {}) {
    const started = now(), requests = new Map(), recent = new Map(), buckets = [];
    let finished = false, samples = 0, responses = 0, ttfb = null, duration = null;
    function trim(time) {
      while (buckets.length && buckets[0].time < time - windowMs) buckets.shift();
      for (const [id, entry] of recent) {
        if (entry.ended < time - windowMs || recent.size > 1024) recent.delete(id); else break;
      }
    }
    function discard(entry) { for (const [bucket, bytes] of entry.buckets) bucket.useful = Math.max(0, bucket.useful - bytes); }
    function onRequestStart(id) { if (!finished) requests.set(id, { started: now(), buckets: new Map(), responded: false }); }
    function onResponse(id) {
      const entry = requests.get(id);
      if (entry && !entry.responded) { entry.responded = true; responses++; ttfb = Math.max(0, now() - entry.started); }
    }
    function onBytes(id, bytes) {
      const entry = requests.get(id), time = now();
      if (!entry || finished || !Number.isFinite(bytes) || bytes <= 0) return;
      let bucket = buckets.at(-1);
      if (!bucket || bucket.time !== time) buckets.push(bucket = { time, bytes: 0, useful: 0 });
      bucket.bytes += bytes; bucket.useful += bytes;
      entry.buckets.set(bucket, (entry.buckets.get(bucket) || 0) + bytes);
      for (const old of entry.buckets.keys()) { if (old.time < time - windowMs) entry.buckets.delete(old); else break; }
      trim(time);
    }
    function onRequestEnd(id, result = {}) {
      const entry = requests.get(id); if (!entry) return;
      requests.delete(id); entry.ended = now(); duration = Math.max(0, entry.ended - entry.started);
      if (result.ok === false || result.timeout) discard(entry);
      else { samples++; recent.set(id, entry); }
      trim(entry.ended);
    }
    function onRequestInvalid(id) {
      const entry = recent.get(id); if (!entry) return;
      discard(entry); recent.delete(id); samples = Math.max(0, samples - 1);
    }
    function metrics() {
      const time = now(); trim(time);
      const since = Math.max(started, time - windowMs), seconds = (time - since) / 1000;
      const rate = field => finished || seconds <= 0 ? 0 : buckets.reduce((sum, b) => sum + (b.time > since ? b[field] : 0), 0) / seconds;
      return { bytesPerSecond: rate('useful'), networkBytesPerSecond: rate('bytes'), inFlightRequests: requests.size,
        sampleCount: samples, responseSampleCount: responses, ttfbMs: ttfb, requestDurationMs: duration };
    }
    return { onRequestStart, onResponse, onBytes, onRequestEnd, onRequestInvalid, metrics, finish() { finished = true; } };
  }
  return { createTracker };
});
