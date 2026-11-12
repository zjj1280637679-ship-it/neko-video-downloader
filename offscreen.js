/* Hidden HLS worker. Only chrome.runtime is used here; downloads are brokered
 * by the service worker. No popup or visible document owns a running task. */
(function (root, factory) {
  const commonjs = typeof module === "object" && module.exports;
  const api = factory(commonjs ? require('./segment-cache.js') : root.NekoSegmentCache,
    commonjs ? require('./engine/job-state.js') : root.NekoJobState);
  if (typeof module === "object" && module.exports) module.exports = api;
  else api.createOffscreenRunner({ runtime: root.chrome.runtime, hls: root.NekoHls,
    storage: root.navigator.storage, urlApi: root.URL, cryptoApi: root.crypto }).attach();
})(typeof globalThis !== "undefined" ? globalThis : this, function (segmentCache, jobState) {
  "use strict";
  const TERMINAL = new Set(jobState.TERMINAL);
  const MEMORY_LIMIT = 256 * 1024 * 1024;
  const abortError = () => new DOMException("下载已取消", "AbortError");
  function createOffscreenRunner({ runtime, hls, storage, urlApi = URL, cryptoApi = crypto,
    pollMs = 500, progressMs = 500, now = Date.now, logger = console }) {
    const entries = new Map();
    const removals = new Map();
    const queue = [];
    let activeId = null, pumping = false, attached = false;
    // The first broker snapshot can be a migrated preference at revision zero.
    // Do not pre-establish 64/0 and reject that user's existing value.
    let concurrencyPreference = null;

    function concurrencyControl(initial) {
      let value = initial, disposed = false;
      const listeners = new Set();
      return {
        get: () => value,
        subscribe(listener) {
          if (typeof listener !== 'function') throw new TypeError('并发监听器无效');
          if (!disposed) listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(next) {
          if (disposed || next === value) return;
          value = next;
          for (const listener of [...listeners]) {
            try { listener(); } catch (error) { logger.warn('并发更新通知失败', error); }
          }
        },
        dispose() { disposed = true; listeners.clear(); }
      };
    }
    function validateConcurrency(concurrency, concurrencyRevision) {
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > jobState.LIMITS.segments ||
          !Number.isSafeInteger(concurrencyRevision) || concurrencyRevision < 0) throw new Error('并发偏好或版本无效');
      return { concurrency, concurrencyRevision };
    }
    function setConcurrency(message) {
      const next = validateConcurrency(message.concurrency, message.concurrencyRevision);
      if (concurrencyPreference && next.concurrencyRevision <= concurrencyPreference.concurrencyRevision) {
        if (next.concurrencyRevision === concurrencyPreference.concurrencyRevision && next.concurrency !== concurrencyPreference.concurrency) {
          throw new Error('相同版本的并发偏好不一致');
        }
        return { success: true, ...concurrencyPreference };
      }
      concurrencyPreference = next;
      for (const entry of entries.values()) {
        if (TERMINAL.has(entry.status.state)) continue;
        Object.assign(entry.input, next);
        // Publishing is queued, never awaited: the broker may itself be waiting
        // for this ACK before it can acknowledge a progress snapshot.
        const target = entry.status.state === 'downloading' ? next.concurrency : 0;
        update(entry, { ...next, targetConcurrency: target, activeConcurrency: target }, true);
        entry.concurrencyControl.set(next.concurrency);
      }
      return { success: true, ...concurrencyPreference };
    }

    function snapshot(entry) { return { ...entry.status }; }
    function getJobs() { return Array.from(entries.values(), snapshot); }
    function delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason || abortError());
        const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason || abortError()); };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    function ensureActive(entry) { if (entry.controller.signal.aborted) throw entry.controller.signal.reason || abortError(); }
    async function broker(action, data, retries = 1) {
      let lastError;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const reply = await runtime.sendMessage({ target: "neko-background", action, ...data });
          if (!reply?.success) throw new Error(reply?.error || "下载服务暂时不可用");
          return reply;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < retries) await delay(Math.min(500, 100 * (attempt + 1)));
        }
      }
      throw lastError;
    }
    function sendProgress(entry) {
      clearTimeout(entry.progressTimer);
      entry.progressTimer = null;
      entry.lastSent = now();
      const job = snapshot(entry);
      entry.notifications = entry.notifications.catch(() => {}).then(() =>
        runtime.sendMessage({ target: "neko-background", action: "jobProgress", job }).then(reply => {
          if (reply?.success === false) throw new Error(reply.error || "后台未接受任务状态");
        })
      ).catch(error => { logger.warn("下载进度同步失败，可通过任务快照恢复", error); });
      return entry.notifications;
    }
    function update(entry, patch, immediate = false) {
      const stateChanged = patch.state && patch.state !== entry.status.state;
      Object.assign(entry.status, patch, { updatedAt: now(), revision: entry.status.revision + 1 });
      if (TERMINAL.has(entry.status.state)) entry.concurrencyControl.dispose();
      if (immediate || stateChanged || TERMINAL.has(entry.status.state) || now() - entry.lastSent >= progressMs) return sendProgress(entry);
      if (!entry.progressTimer) entry.progressTimer = setTimeout(() => sendProgress(entry), Math.max(0, progressMs - (now() - entry.lastSent)));
      return entry.notifications;
    }
    function outputFilename(job, extension) {
      const requested = String(job.filename || job.title || "视频").replace(/\\/g, "/");
      const basename = requested.split("/").pop().replace(/\.(?:m3u8|mp4|m4v|ts)$/i, "");
      return hls.safeFilename(basename, extension);
    }
    function trimHistory() {
      const finished = Array.from(entries.values()).filter(entry => TERMINAL.has(entry.status.state) && !entry.status.resumable && !entry.status.cachedSegments && !entry.cleanupSource && !removals.has(entry.status.id));
      for (const entry of finished.slice(0, Math.max(0, finished.length - 30))) entries.delete(entry.status.id);
    }
    function addJob(job) {
      if (!job || typeof job.id !== "string" || !job.id || job.id.length > 128 || job.isM3U8 !== true) throw new Error("无效的 HLS 下载任务");
      if (!/^https?:$/.test(new URL(job.url).protocol)) throw new Error("仅支持 HTTP / HTTPS 视频资源");
      const incomingPreference = validateConcurrency(job.concurrency === undefined ? 64 : job.concurrency,
        job.concurrencyRevision === undefined ? 0 : job.concurrencyRevision);
      if (removals.has(job.id)) throw new Error('任务正在移除，请稍后重试');
      const previous = entries.get(job.id);
      if (job.resume === true && previous?.cleanupSource) throw new Error('上次临时文件尚未清理，请先移除此任务后重新下载');
      if (previous && !(job.resume === true && previous.status.state === 'interrupted' && previous.status.resumable)) {
        setConcurrency(incomingPreference);
        return { success: true, job: snapshot(previous) };
      }
      if (Array.from(entries.values()).filter(entry => !TERMINAL.has(entry.status.state)).length >= jobState.LIMITS.jobs) throw new Error("下载队列已满，请等待当前任务完成");
      setConcurrency(incomingPreference);
      trimHistory();
      const stamp = now();
      const entry = { input: { ...job, ...concurrencyPreference }, controller: new AbortController(), progressTimer: null,
        concurrencyControl: concurrencyControl(concurrencyPreference.concurrency),
        lastSent: -Infinity, notifications: Promise.resolve(), downloadId: null, chromeFinished: false,
        status: { id: job.id, runId: job.runId || cryptoApi.randomUUID(), revision: 0, queuePosition: 0,
          ...concurrencyPreference,
          title: job.title || "视频", tabId: job.tabId, filename: job.filename || "视频",
          state: "queued", etaSeconds: null, etaBasis: 'unknown', bytesReceived: 0, totalBytes: 0, completedSegments: 0, totalSegments: 0,
          cachedSegments: previous?.status.cachedSegments || job.cachedSegments || 0,
          resumable: false, retryAttempt: 0, retryMessage: '',
          bytesPerSecond: 0, activeConcurrency: 0, concurrencyMode: 'manual', concurrencyReason: 'manual',
          targetConcurrency: 0, inFlightRequests: 0,
          createdAt: previous?.status.createdAt || stamp, updatedAt: stamp, error: null } };
      entries.set(job.id, entry);
      queue.push(job.id);
      updateQueuePositions();
      update(entry, {}, true);
      Promise.resolve().then(pump);
      return { success: true, job: snapshot(entry) };
    }
    function updateQueuePositions() {
      let position = 0;
      for (const id of queue) {
        const entry = entries.get(id);
        if (entry && !TERMINAL.has(entry.status.state)) {
          position++;
          if (entry.status.queuePosition !== position) update(entry, { queuePosition: position }, true);
        }
      }
    }
    function cancelJob(jobId) {
      const entry = entries.get(jobId);
      if (!entry) return { success: false, error: "找不到下载任务" };
      if (TERMINAL.has(entry.status.state)) return { success: true, job: snapshot(entry) };
      entry.concurrencyControl.dispose();
      entry.controller.abort(abortError());
      if (activeId !== jobId && entry.status.cachedSegments > 0) {
        const at = queue.indexOf(jobId);
        if (at >= 0) queue.splice(at, 1);
        update(entry, { cancelRequested: true }, true);
        (async () => {
          try {
            await segmentCache.removeJob(await storage.getDirectory(), jobId, cryptoApi);
            await update(entry, { state: 'cancelled', resumable: false, cachedSegments: 0, cancelRequested: false, error: null, finishedAt: now() }, true);
          } catch (error) {
            await update(entry, { state: 'interrupted', resumable: true, cancelRequested: false, cleanupError: `分片缓存未能清理：${error.message}`, finishedAt: now() }, true);
          }
        })();
      } else if (activeId !== jobId) update(entry, { state: "cancelled", error: null, finishedAt: now() }, true);
      else update(entry, { cancelRequested: true }, true);
      updateQueuePositions();
      return { success: true };
    }
    async function cancelChrome(entry) {
      if (entry.downloadId === null || entry.chromeFinished) return;
      await broker("cancelChromeDownload", { jobId: entry.status.id, runId: entry.status.runId, downloadId: entry.downloadId }, 3);
      entry.chromeFinished = true;
    }
    async function waitForChrome(entry) {
      for (;;) {
        ensureActive(entry);
        const { item } = await broker("getChromeDownload", { jobId: entry.status.id, runId: entry.status.runId, downloadId: entry.downloadId }, 3);
        if (!item) throw new Error("找不到 Chrome 下载任务");
        if (item.state === "complete") {
          entry.chromeFinished = true;
          update(entry, { savedFilename: item.filename, savedBytes: item.bytesReceived || entry.status.bytesReceived });
          return;
        }
        if (item.state === "interrupted") {
          entry.chromeFinished = true;
          throw new Error(`保存中断：${item.error || "请重试"}`);
        }
        update(entry, { savedBytes: item.bytesReceived || 0 });
        await delay(pollMs, entry.controller.signal);
      }
    }
    async function saveBlob(entry, data) {
      try { return await broker("saveBlob", { ...data, runId: entry.status.runId }, 3); }
      catch (saveError) {
        // A missing runtime reply does not prove Chrome failed to create the
        // download. The broker owns an idempotent jobId -> downloadId mapping.
        for (;;) {
          let recovery;
          try { recovery = await broker("getChromeDownload", { jobId: entry.status.id, runId: entry.status.runId }, 3); }
          catch { throw saveError; }
          if (Number.isInteger(recovery.downloadId)) return { success: true, downloadId: recovery.downloadId };
          if (recovery.downloadId === null && recovery.pending === false) {
            saveError.noChromeReference = true;
            throw saveError;
          }
          if (recovery.pending !== true) throw saveError;
          // Even after cancellation, retain the Blob until a pending save has
          // produced an id we can cancel, or the broker confirms no reference.
          await delay(pollMs);
        }
      }
    }
    async function execute(entry) {
      let writer = null, directory = null, temporaryName = null, temporaryFile = null, objectUrl = null;
      let cache = null;
      const memoryParts = [];
      let memoryBytes = 0, finalState = "interrupted", errorText = null, cleanupError = null, chromeReferencePossible = false;
      entry.sourceCanBeReleased = verification => !chromeReferencePossible || entry.chromeFinished ||
        (verification?.chromeIdle === true && Number.isInteger(entry.downloadId) && verification.verifiedDownloadId === entry.downloadId);
      // Retain only this attempt's owned source if cleanup fails, so an explicit
      // task removal can retry it after the broker confirms Chrome is idle.
      entry.cleanupSource = async () => {
        if (objectUrl) { urlApi.revokeObjectURL(objectUrl); objectUrl = null; }
        if (directory && temporaryName && temporaryFile) {
          try { await directory.removeEntry(temporaryName); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
          temporaryFile = null;
        }
        entry.cleanupSource = null;
      };
      try {
        ensureActive(entry);
        await update(entry, { state: "parsing" }, true);
        const retryingResources = new Map();
        const client = hls.createClient({ signal: entry.controller.signal, onRetry({ attempt, maxAttempts, delayMs, stage, operationUrl }) {
          const reason = stage === 'key' ? '分片密钥获取失败' : stage === 'decrypt' ? '分片解密失败' : stage === 'payload' ? '分片内容异常' : '资源请求失败';
          const retry = { retryAttempt: attempt, retryMessage: `${reason}，${Math.ceil((delayMs || 0) / 1000)} 秒后进行第 ${attempt + 1}/${maxAttempts || 6} 次尝试` };
          retryingResources.set(operationUrl, retry);
          update(entry, retry);
        }, onRecovered({ resourceUrl }) {
          retryingResources.delete(resourceUrl);
          update(entry, Array.from(retryingResources.values()).at(-1) || { retryAttempt: 0, retryMessage: '' });
        }, onVariant(variant, total, selection) {
          update(entry, { qualityLabel: `${variant.bandwidth || '未知'} bps · 第 ${selection.rank}/${total} 档`,
            qualityReason: selection.failures.length ? `较高档位未通过准备：${selection.failures.slice(0, 2).join('；')}` : '已选择可用的最高码率档位' });
        }, onMetrics(metrics) {
          if (entry.status.state !== 'downloading' || entry.controller.signal.aborted) return;
          const measured = {};
          for (const field of ['inFlightRequests']) {
            if (metrics[field] !== undefined) measured[field] = metrics[field];
          }
          update(entry, { ...measured, targetConcurrency: entry.input.concurrency,
            bytesPerSecond: metrics.bytesPerSecond, activeConcurrency: entry.input.concurrency,
            concurrencyMode: metrics.concurrencyMode, concurrencyReason: metrics.concurrencyReason,
            etaSeconds: Number.isFinite(metrics.etaSeconds) && metrics.etaSeconds > 0 ? metrics.etaSeconds : null,
            etaBasis: metrics.etaBasis || 'unknown' });
        } });
        const plan = await client.loadPlan(entry.input.url);
        ensureActive(entry);
        if (plan.isFmp4 && (plan.maps.size > 1 || plan.discontinuities)) throw new Error("此 fMP4 线路需要重新封装，请更换线路");
        const filename = outputFilename(entry.input, plan.isFmp4 ? "mp4" : "ts");
        await update(entry, { filename, totalSegments: plan.segments.length, duration: plan.totalDuration });
        if (typeof storage?.getDirectory === "function") {
          try { directory = await storage.getDirectory(); }
          catch (error) { if (error.name !== "NotSupportedError") throw error; }
          if (directory) {
            // Persist the first usable checkpoint immediately; subsequent
            // counts are telemetry and may be coalesced without losing resume.
            cache = await segmentCache.open(directory, entry.status.id, plan, cryptoApi, count => update(entry, { cachedSegments: count }, count <= 1));
            temporaryName = `neko-download-${cryptoApi.randomUUID()}.part`;
            temporaryFile = await directory.getFileHandle(temporaryName, { create: true });
            writer = await temporaryFile.createWritable();
          }
        }
        ensureActive(entry);
        const sink = writer || { async write(bytes) {
          memoryBytes += bytes.byteLength;
          if (memoryBytes > MEMORY_LIMIT) throw new Error("浏览器不支持临时磁盘存储，已达到 256 MB 内存上限");
          memoryParts.push(bytes);
        } };
        await update(entry, { state: "downloading", targetConcurrency: entry.input.concurrency, activeConcurrency: entry.input.concurrency }, true);
        await client.download(plan, sink, ({ bytes, completed, total }) => {
          update(entry, { bytesReceived: bytes, completedSegments: completed, totalSegments: total });
        }, entry.concurrencyControl, cache || {});
        ensureActive(entry);
        let file;
        const outputType = plan.isFmp4 ? 'video/mp4' : 'video/mp2t';
        if (writer) {
          await writer.close();
          writer = null;
          file = await temporaryFile.getFile();
          if (file.size !== entry.status.bytesReceived) throw new Error("临时文件大小与接收数据不一致");
          // OPFS snapshots inherit the temporary .part name and may have an
          // empty MIME type. A typed Blob slice references the same file bytes;
          // never read a whole video back through arrayBuffer()/FileReader.
          file = file.slice(0, file.size, outputType);
        } else {
          file = new Blob(memoryParts, { type: outputType });
          memoryParts.length = 0;
        }
        ensureActive(entry);
        objectUrl = urlApi.createObjectURL(file);
        await update(entry, { state: "saving", totalBytes: file.size, retryAttempt: 0, retryMessage: '', bytesPerSecond: 0, activeConcurrency: 0, targetConcurrency: 0, inFlightRequests: 0, etaSeconds: null, etaBasis: 'unknown' }, true);
        // Persisting the saving phase yields to cancellation. Check again
        // before Chrome can create a download or open the save-as dialog.
        ensureActive(entry);
        chromeReferencePossible = true;
        const result = await saveBlob(entry, { jobId: entry.status.id, url: objectUrl, filename, saveAs: false });
        if (!Number.isInteger(result.downloadId)) throw new Error("Chrome 未返回有效的下载任务编号");
        entry.downloadId = result.downloadId;
        await update(entry, { downloadId: result.downloadId }, true);
        await waitForChrome(entry);
        finalState = "complete";
      } catch (error) {
        if (error.noChromeReference) chromeReferencePossible = false;
        const cancelled = entry.controller.signal.aborted;
        finalState = cancelled ? "cancelled" : "interrupted";
        errorText = cancelled ? null : error.name === "QuotaExceededError" ? "临时存储空间不足，请释放磁盘空间后重试" : error.message;
        if (entry.downloadId !== null && !entry.chromeFinished) {
          try { await cancelChrome(entry); }
          catch (cancelError) { cleanupError = `无法确认 Chrome 已停止保存：${cancelError.message}`; }
        }
        if (entry.downloadId === null && chromeReferencePossible) cleanupError = "无法确认 Chrome 的保存状态，已保留本次临时文件以避免中断保存";
      } finally {
        if (writer) {
          try { await writer.abort(); }
          catch (error) { cleanupError = cleanupError || `临时文件写入未能中止：${error.message}`; }
        }
        memoryParts.length = 0;
        // Do not revoke a source that Chrome may still be reading if a broker
        // cancellation failed. Surface the cleanup problem instead.
        if ((!chromeReferencePossible && entry.downloadId === null) || entry.chromeFinished) {
          try { await entry.cleanupSource(); }
          catch (error) { cleanupError = `临时下载文件未能清理：${error.message}`; }
        }
        if (cache && finalState !== 'interrupted') {
          try { await cache.clear(); }
          catch (error) { cleanupError = `分片缓存未能清理：${error.message}`; }
        } else if (!cache && finalState === 'cancelled' && entry.status.cachedSegments > 0) {
          try {
            await segmentCache.removeJob(await storage.getDirectory(), entry.status.id, cryptoApi);
            entry.status.cachedSegments = 0;
          } catch (error) { cleanupError = `分片缓存未能清理：${error.message}`; }
        }
        // A failure retains committed, verified pieces; explicit cancellation
        // discards them. Never offer restart while Chrome may still be saving.
        const retainedCount = cache ? cache.count() : entry.status.cachedSegments;
        const resumable = finalState === 'interrupted' && retainedCount > 0 &&
          ((!chromeReferencePossible && entry.downloadId === null) || entry.chromeFinished);
        await update(entry, { state: finalState, error: errorText, cleanupError, resumable,
          cachedSegments: retainedCount, retryAttempt: 0, retryMessage: '', bytesPerSecond: 0, activeConcurrency: 0, targetConcurrency: 0, inFlightRequests: 0, etaSeconds: null, etaBasis: 'unknown', cancelRequested: false, finishedAt: now() }, true);
      }
    }
    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (queue.length) {
          const id = queue.shift();
          const entry = entries.get(id);
          if (!entry || TERMINAL.has(entry.status.state)) continue;
          activeId = id;
          update(entry, { queuePosition: 0 }, true);
          updateQueuePositions();
          await execute(entry);
          activeId = null;
        }
      } finally { activeId = null; pumping = false; }
    }
    function removeJob(message) {
      const id = message.jobId;
      if (typeof id !== 'string' || !id || id.length > 128) throw new Error('缓存任务无效');
      if (removals.has(id)) return removals.get(id);
      const entry = entries.get(id);
      if (entry && !TERMINAL.has(entry.status.state)) throw new Error('请先取消下载，结束后再移除任务');
      // Removal owns the whole terminal task, not one attempt. A rejected
      // resume may already have advanced the broker's runId while this older
      // terminal entry still owns cleanup. The terminal check and removal lock
      // prevent deleting a newly active attempt of the same task.
      const pending = (async () => {
        try {
          // Terminal status is published before its final acknowledgement.
          // Wait for that acknowledgement without changing the pump's owner.
          if (entry) await entry.notifications;
          if (entry?.cleanupSource && !entry.sourceCanBeReleased(message)) throw new Error('尚未确认 Chrome 已停止保存，临时文件仍保留');
          if (typeof storage?.getDirectory === 'function') await segmentCache.removeJob(await storage.getDirectory(), id, cryptoApi);
          if (entry?.cleanupSource) {
            await entry.cleanupSource();
          }
          if (entry && entries.get(id) === entry) {
            if (!TERMINAL.has(entry.status.state)) throw new Error('任务已重新开始，不能移除');
            clearTimeout(entry.progressTimer); entry.progressTimer = null;
            entries.delete(id);
          }
          return { success: true, jobId: id };
        } finally { removals.delete(id); }
      })();
      removals.set(id, pending);
      return pending;
    }
    function handleMessage(message, sender, sendResponse) {
      if (message?.target !== "neko-offscreen") return false;
      if (sender?.id !== runtime.id || sender.tab || (sender.url && sender.url !== runtime.getURL("background.js"))) return false;
      if (message.action === 'removeJob') {
        try { removeJob(message).then(sendResponse, error => sendResponse({ success: false, error: error.message })); }
        catch (error) { sendResponse({ success: false, error: error.message }); }
        return true;
      }
      if (message.action === 'discardJob' || message.action === 'pruneCaches') {
        (async () => {
          if (typeof storage?.getDirectory !== 'function') return { success: true };
          const directory = await storage.getDirectory();
          if (message.action === 'pruneCaches') {
            if (!Array.isArray(message.jobIds) || message.jobIds.some(id => typeof id !== 'string' || !id || id.length > 128)) throw new Error('缓存任务列表无效');
            const active = Array.from(entries.values()).filter(entry => !TERMINAL.has(entry.status.state)).map(entry => entry.status.id);
            await segmentCache.prune(directory, [...message.jobIds, ...active], cryptoApi);
          } else {
            if (typeof message.jobId !== 'string' || !message.jobId || message.jobId.length > 128) throw new Error('缓存任务无效');
            const entry = entries.get(message.jobId);
            if (entry && !TERMINAL.has(entry.status.state)) throw new Error('下载进行中，不能清理缓存');
            await segmentCache.removeJob(directory, message.jobId, cryptoApi);
            if (entry) await update(entry, { resumable: false, cachedSegments: 0 }, true);
          }
          return { success: true };
        })().then(sendResponse, error => sendResponse({ success: false, error: error.message }));
        return true;
      }
      try {
        if (message.action === "runJob") sendResponse(addJob(message.job));
        else if (message.action === "setConcurrency") sendResponse(setConcurrency(message));
        else if (message.action === "cancelJob") sendResponse(cancelJob(message.jobId));
        else if (message.action === "getOffscreenJobs") sendResponse({ jobs: getJobs() });
        else sendResponse({ success: false, error: "未知任务操作" });
      } catch (error) { sendResponse({ success: false, error: error.message }); }
      return false;
    }
    function attach() {
      if (!attached) { runtime.onMessage.addListener(handleMessage); attached = true; }
      return api;
    }
    const api = { attach, handleMessage, addJob, cancelJob, getJobs };
    return api;
  }
  return { createOffscreenRunner };
});
