/* Continuous media-request scheduling, ordered output and byte backpressure.
 * Only the throughput controller selects the target concurrency. Buffer limits
 * pause execution and invalidate measurements; they never change that target.
 */
(function (root) {
  "use strict";

  function abortError() {
    const error = new Error("下载已取消");
    error.name = "AbortError";
    return error;
  }

  function runAdaptiveDownload({
    total, fetchItem, writeItem, signal, controller,
    now = () => performance.now(), sampleIntervalMs = 1000,
    bufferHighWaterBytes = 64 * 1024 * 1024, onMetrics = () => {}
  }) {
    if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("Invalid item count");
    if (!(sampleIntervalMs > 0) || !Number.isFinite(sampleIntervalMs)) throw new RangeError("Invalid sample interval");
    if (!(bufferHighWaterBytes > 0)) throw new RangeError("Invalid buffer watermark");
    if (!controller || !Number.isSafeInteger(controller.targetConcurrency) || controller.targetConcurrency < 1) {
      throw new RangeError("A throughput controller with a positive integer target is required");
    }
    if (signal && signal.aborted) return Promise.reject(abortError());
    if (total === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const requests = new AbortController();
      const tasks = new Map();
      const pending = new Set();
      const ready = new Map();
      const capacityWaiters = new Set();
      let target = controller.targetConcurrency;
      let nextToLaunch = 0;
      let nextToWrite = 0;
      let bufferedBytes = 0;
      let networkActive = 0;
      let stopped = false;
      let draining = false;
      let timer = null;
      let windowStart = now();
      let lastOccupancyTime = windowStart;
      let occupancyIntegral = 0;
      let windowBytes = 0;
      let windowTarget = target;
      let windowPressure = false;
      let windowTail = false;
      let windowUnmeasurable = false;

      function accrueOccupancy() {
        const time = now();
        occupancyIntegral += networkActive * Math.max(0, time - lastOccupancyTime);
        lastOccupancyTime = time;
        return time;
      }

      function canRead(state) {
        // The earliest missing body must be able to finish even when later
        // bodies fill the watermark, otherwise ordered output could deadlock.
        return bufferedBytes < bufferHighWaterBytes || state.index === nextToWrite;
      }

      function wakeCapacity() {
        for (const waiter of capacityWaiters) {
          if (stopped || requests.signal.aborted) {
            capacityWaiters.delete(waiter);
            waiter.reject(abortError());
          } else if (canRead(waiter.state)) {
            capacityWaiters.delete(waiter);
            waiter.resolve();
          }
        }
      }

      function changeBuffer(delta) {
        bufferedBytes = Math.max(0, bufferedBytes + delta);
        if (bufferedBytes >= bufferHighWaterBytes) windowPressure = true;
        wakeCapacity();
      }

      function cleanup() {
        if (timer !== null) clearInterval(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }

      function stop(error) {
        if (stopped) return;
        stopped = true;
        cleanup();
        requests.abort();
        wakeCapacity();
        // Consume every request rejection before handing the page back to the
        // user. fetchItem uses this linked signal, including during retries.
        Promise.allSettled([...pending]).then(() => {
          ready.clear();
          tasks.clear();
          reject(error);
        });
      }

      function onAbort() { stop(abortError()); }

      function finishIfDone() {
        if (!stopped && nextToWrite === total && tasks.size === 0 && !draining) {
          stopped = true;
          cleanup();
          resolve();
        }
      }

      function makeTelemetry(state) {
        return {
          start() {
            if (stopped || requests.signal.aborted) throw abortError();
            if (state.networkActive) throw new Error("Network attempt already active");
            // Release a previous successful body if its later decryption failed.
            if (state.bytes) {
              changeBuffer(-state.bytes);
              state.bytes = 0;
            }
            accrueOccupancy();
            state.networkActive = true;
            state.unmeasurable = false;
            networkActive++;
          },
          bytes(count) {
            if (stopped) return;
            if (!state.networkActive || !Number.isSafeInteger(count) || count < 0) {
              throw new Error("Invalid received-byte measurement");
            }
            windowBytes += count;
            state.bytes += count;
            changeBuffer(count);
          },
          end({ discarded = false } = {}) {
            if (state.networkActive) {
              accrueOccupancy();
              state.networkActive = false;
              networkActive--;
            }
            if (discarded && state.bytes) {
              changeBuffer(-state.bytes);
              state.bytes = 0;
            }
          },
          unmeasurable() {
            // arrayBuffer-only responses cannot reveal byte arrival times.
            state.unmeasurable = true;
            windowUnmeasurable = true;
          },
          waitForCapacity() {
            if (stopped || requests.signal.aborted) return Promise.reject(abortError());
            if (canRead(state)) return Promise.resolve();
            windowPressure = true;
            return new Promise((yes, no) => {
              capacityWaiters.add({ state, resolve: yes, reject: no });
            });
          }
        };
      }

      async function drain() {
        if (draining || stopped) return;
        draining = true;
        try {
          while (!stopped && ready.has(nextToWrite)) {
            const result = ready.get(nextToWrite);
            const size = result.buffer ? result.buffer.byteLength : 0;
            if (result.buffer) await writeItem(result);
            if (stopped) break;
            ready.delete(nextToWrite);
            nextToWrite++;
            changeBuffer(-size);
            // Drop the queue's body reference after writing. The Blob fallback
            // deliberately retains its own reference and is not memory-bounded.
            result.buffer = null;
            pump();
          }
        } catch (error) {
          stop(error);
        } finally {
          draining = false;
          finishIfDone();
        }
      }

      function launch(index) {
        const state = { index, bytes: 0, networkActive: false, unmeasurable: false };
        tasks.set(index, state);
        const telemetry = makeTelemetry(state);
        const work = (async () => fetchItem(index, telemetry, requests.signal))();
        pending.add(work);
        work.then((result) => {
          telemetry.end();
          if (stopped) return;
          if (!result || result.index !== index || (result.buffer != null && !Number.isFinite(result.buffer.byteLength))) {
            throw new Error("Invalid downloaded item");
          }
          const size = result.buffer ? result.buffer.byteLength : 0;
          changeBuffer(size - state.bytes);
          state.bytes = 0;
          tasks.delete(index);
          ready.set(index, result);
          // A completed request releases its slot immediately, regardless of
          // other requests or a pending ordered write. There is no batch gate.
          pump();
          void drain();
        }, (error) => {
          telemetry.end({ discarded: true });
          if (!stopped) stop(error);
        }).catch(stop).finally(() => pending.delete(work));
      }

      function pump() {
        if (stopped) return;
        while (tasks.size < target && nextToLaunch < total) {
          if (bufferedBytes >= bufferHighWaterBytes) {
            windowPressure = true;
            break;
          }
          launch(nextToLaunch++);
        }
        if (nextToLaunch === total) windowTail = true;
      }

      function sample() {
        if (stopped) return;
        try {
          const time = accrueOccupancy();
          const elapsed = time - windowStart;
          if (elapsed <= 0) return;
          const concurrency = occupancyIntegral / elapsed;
          const bytesPerSecond = windowBytes * 1000 / elapsed;
          // Small replenishment gaps are represented by actual fractional N.
          // Large gaps, target transitions, draining tails and backpressure do
          // not describe the steady network response at the requested target.
          const reason = windowPressure ? "buffer-backpressure"
            : windowTail ? "tail"
            : windowUnmeasurable ? "unmeasurable-body"
            : windowTarget !== target ? "target-transition"
            : concurrency < windowTarget * 0.9 || concurrency > windowTarget * 1.001 ? "underfilled-or-transition"
            : bytesPerSecond <= 0 ? "no-received-bytes"
            : "network-window";
          const eligible = reason === "network-window";
          if (eligible) {
            controller.observe({ concurrency, bytesPerSecond });
            const proposed = controller.targetConcurrency;
            if (!Number.isSafeInteger(proposed) || proposed < 1) throw new Error("Invalid controller target");
            target = proposed;
          } else if (typeof controller.discardPendingSamples === "function") {
            // Do not combine pre-stall/pre-backpressure windows with a later
            // operating period into one supposedly stable response point.
            controller.discardPendingSamples();
          }
          onMetrics({ concurrency, measuredTargetConcurrency: windowTarget, targetConcurrency: target,
            bytesPerSecond, eligible, reason, bufferedBytes });
          windowStart = time;
          lastOccupancyTime = time;
          occupancyIntegral = 0;
          windowBytes = 0;
          windowTarget = target;
          windowPressure = bufferedBytes >= bufferHighWaterBytes || capacityWaiters.size > 0;
          windowTail = nextToLaunch === total;
          windowUnmeasurable = [...tasks.values()].some((state) => state.networkActive && state.unmeasurable);
          pump();
        } catch (error) {
          stop(error);
        }
      }

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = setInterval(sample, sampleIntervalMs);
      pump();
    });
  }

  const api = { runAdaptiveDownload };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.NekoAdaptive = Object.assign(root.NekoAdaptive || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
