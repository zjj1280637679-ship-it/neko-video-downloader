/* Request completion replenishes network slots independently of ordered writes.
 * Payload reservations provide backpressure without starving the head segment. */
(function (root, factory) {
  const commonjs = typeof module === 'object' && module.exports;
  const api = factory(commonjs ? require('./transfer-metrics.js') : root.NekoTransferMetrics,
    commonjs ? require('./transfer-buffer.js') : root.NekoTransferBuffer);
  if (commonjs) module.exports = api; else root.NekoSegmentScheduler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (transferMetrics, transferBuffer) {
  'use strict';
  const abortError = () => new DOMException('下载已取消', 'AbortError');
  async function download(plan, sink, onProgress, mode, hooks, options) {
    const now = options.now || (() => globalThis.performance?.now() ?? Date.now());
    const control = mode && typeof mode.get === 'function' && typeof mode.subscribe === 'function' ? mode : null;
    const target = () => {
      const value = control ? control.get() : mode;
      return Number.isInteger(value) && value >= 1 && value <= 375 ? value : 64;
    };
    const budgetBytes = Math.max(options.resourceLimit * 2, options.maxBufferedBytes || 192 * 1024 ** 2);
    const buffer = transferBuffer.createBuffer({ budgetBytes, resourceLimitBytes: options.resourceLimit });
    const meter = transferMetrics.createTracker({ now });
    const eta = options.createEtaEstimator({ totalSegments: plan.segments.length, now });
    const operation = new AbortController(), pending = new Map(), resident = new Map(), ready = new Set(), results = new Map();
    let bytes = 0, completed = 0, lastMap = null, next = 0, running = 0, firstFailure = null, filling = false, writing = null;
    let stopped = false, unsubscribe, writerWake;
    const wakeWriter = () => { const wake = writerWake; writerWake = null; wake?.(); };
    const active = () => { if (operation.signal.aborted) throw operation.signal.reason || abortError(); };
    const abort = () => { operation.abort(options.signal.reason || abortError()); wakeWriter(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    function emit() {
      const concurrency = target();
      const metrics = { ...meter.metrics(), ...eta.metrics(), activeConcurrency: concurrency, targetConcurrency: concurrency,
        concurrencyMode: 'manual', concurrencyReason: 'manual',
        bufferedBytes: [...resident.values()].reduce((sum, size) => sum + size, 0), bufferedSegments: ready.size,
        reservedBufferBytes: buffer.stats().reservedBytes, bufferBudgetBytes: budgetBytes };
      try { Promise.resolve(options.onMetrics?.(metrics)).catch(() => {}); } catch { /* Telemetry cannot stop a transfer. */ }
      return metrics;
    }
    function release(index) { resident.delete(index); ready.delete(index); buffer.release(index); }
    function discardReady() {
      // Drop the actual ArrayBuffer references before releasing reservations.
      for (const index of [...ready]) { const result = results.get(index); if (result) result.data = null; results.delete(index); release(index); }
    }
    function fail(cause, index, segment, stage) {
      if (cause.name === 'AbortError') return cause;
      const error = new Error(`第 ${index + 1} 个分片处理失败：${cause.message}`, { cause });
      error.name = cause.name || 'Error';
      Object.assign(error, { retryable: cause.retryable ?? false, resourceUrl: cause.resourceUrl || segment.url,
        httpStatus: cause.httpStatus, stage: cause.stage || stage, segmentIndex: index, segmentNumber: index + 1,
        segmentUrl: segment.url, attempts: cause.attempts });
      if (stage === 'cache-read' || stage === 'cache-write') { error.retryable = false; error.stage = stage; }
      return error;
    }
    async function read(index) {
      const segment = plan.segments[index]; let stage = 'cache-read', reservation = 0;
      const reserve = async size => { reservation = Math.max(reservation, size); await buffer.reserve(index, reservation, operation.signal); };
      try {
        active();
        if (hooks.getSegment) {
          const cached = await hooks.getSegment(index, segment, async size => { buffer.setExpectedSize(index, size); await reserve(size); }); active();
          if (cached != null) {
            if (Object.prototype.toString.call(cached) !== '[object ArrayBuffer]' || !cached.byteLength) throw new Error('已缓存的分片内容无效');
            await reserve(cached.byteLength); resident.set(index, cached.byteLength); eta.recordCached(index);
            return { data: cached };
          }
          release(index); reservation = 0;
        }
        stage = 'request';
        const data = await options.readResource(segment, operation.signal, {
          declareBody(size) {
            // Re-check protection when retry headers change or disappear.
            // Reject an impossible larger reservation instead of deadlocking.
            try { buffer.setExpectedSize(index, size ?? options.resourceLimit); }
            catch (error) { error.retryable = false; error.stage = 'resource-limit'; throw error; }
            return size;
          },
          prepareBody: reserve,
          onStart(id) { meter.onRequestStart(id); emit(); },
          onResponse(id) { meter.onResponse(id); emit(); },
          onBytes(id, size) { resident.set(index, (resident.get(index) || 0) + size); meter.onBytes(id, size); },
          onEnd(id, result) { meter.onRequestEnd(id, result); emit(); },
          onInvalid(id) { meter.onRequestInvalid(id); },
          onFailure() { release(index); reservation = 0; emit(); }
        });
        active(); await buffer.reserve(index, data.byteLength, operation.signal);
        resident.set(index, data.byteLength); eta.recordNetwork(index, data.byteLength);
        if (hooks.putSegment) {
          stage = 'cache-write';
          await hooks.putSegment(index, segment, data);
        }
        active(); return { data };
      } catch (cause) {
        const error = fail(cause, index, segment, stage); release(index);
        if (!firstFailure && error.name !== 'AbortError') { firstFailure = error; discardReady(); buffer.drain(); }
        if (stage === 'cache-read' || stage === 'cache-write') operation.abort(error);
        wakeWriter();
        return { error };
      }
    }
    function fill() {
      if (filling || stopped) return;
      filling = true;
      try {
        while (!firstFailure && !operation.signal.aborted && running < target() && next < plan.segments.length && next < completed + 512) {
          const index = next++; running++;
          pending.set(index, read(index).then(result => {
            running--;
            if (firstFailure || operation.signal.aborted) { release(index); result.data = null; }
            else if (result.data) { ready.add(index); results.set(index, result); }
            emit(); fill(); return result;
          }));
          wakeWriter();
        }
      } finally { filling = false; }
    }
    async function nextResult(index) {
      // A lower live target can postpone admission. Wait for scheduling instead
      // of interpreting an absent pending entry as a completed empty result.
      while (!pending.has(index)) {
        active();
        if (firstFailure) throw firstFailure;
        fill();
        if (pending.has(index)) break;
        active();
        if (firstFailure) throw firstFailure;
        await new Promise(resolve => { writerWake = resolve; });
      }
      return pending.get(index);
    }
    const timer = setInterval(() => { emit(); fill(); }, options.metricsIntervalMs || 250);
    try {
      unsubscribe = control?.subscribe(() => {
        if (stopped) return;
        emit(); fill(); wakeWriter();
      });
      emit();
      fill();
      for (let index = 0; index < plan.segments.length; index++) {
        active();
        const result = await nextResult(index); active();
        if (firstFailure) throw firstFailure;
        if (result?.error) throw result.error;
        if (!result?.data) throw new Error('分片调度结果缺失');
        ready.delete(index); results.delete(index); writing = { index, result };
        const segment = plan.segments[index];
        if (segment.mapId && (segment.mapId !== lastMap || segment.discontinuity)) {
          let init;
          try { init = await options.readMap(plan, segment.mapId, operation.signal); }
          catch (error) { throw fail(error, index, segment, 'request'); }
          active();
          try { await sink.write(init); } catch (error) { throw fail(error, index, segment, 'sink-write'); }
          active(); bytes += init.byteLength; lastMap = segment.mapId;
        }
        active();
        try { await sink.write(result.data); } catch (error) { throw fail(error, index, segment, 'sink-write'); }
        active(); bytes += result.data.byteLength; completed++;
        result.data = null; writing = null; pending.delete(index); release(index); buffer.advance(completed);
        onProgress({ bytes, completed, total: plan.segments.length, ...emit() });
        fill();
      }
      return { bytes, completed, total: plan.segments.length };
    } catch (error) {
      firstFailure ||= error; discardReady();
      if (writing) { writing.result.data = null; release(writing.index); writing = null; }
      buffer.drain();
      if (['sink-write', 'cache-read', 'cache-write'].includes(error.stage)) operation.abort(abortError());
      throw error;
    } finally {
      stopped = true;
      try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* A detached UI cannot prevent cleanup. */ }
      wakeWriter();
      await Promise.allSettled(pending.values());
      for (const index of resident.keys()) release(index);
      clearInterval(timer); options.signal?.removeEventListener('abort', abort);
      eta.finish(); meter.finish(); emit();
    }
  }
  return { download };
});
