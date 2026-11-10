/* Hidden HLS worker. Only chrome.runtime is used here; downloads are brokered
 * by the service worker. No popup or visible document owns a running task. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else api.createOffscreenRunner({ runtime: root.chrome.runtime, hls: root.NekoHls,
    storage: root.navigator.storage, urlApi: root.URL, cryptoApi: root.crypto }).attach();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const TERMINAL = new Set(["complete", "interrupted", "cancelled"]);
  const MEMORY_LIMIT = 256 * 1024 * 1024;
  const abortError = () => new DOMException("下载已取消", "AbortError");
  function createOffscreenRunner({ runtime, hls, storage, urlApi = URL, cryptoApi = crypto,
    pollMs = 500, progressMs = 500, now = Date.now, logger = console }) {
    const entries = new Map();
    const queue = [];
    let activeId = null, pumping = false, attached = false;

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
      Object.assign(entry.status, patch, { updatedAt: now() });
      if (immediate || stateChanged || TERMINAL.has(entry.status.state) || now() - entry.lastSent >= progressMs) return sendProgress(entry);
      if (!entry.progressTimer) entry.progressTimer = setTimeout(() => sendProgress(entry), Math.max(0, progressMs - (now() - entry.lastSent)));
      return entry.notifications;
    }
    function outputFilename(job, extension) {
      const requested = String(job.filename || job.title || "视频").replace(/\\/g, "/");
      const parts = requested.split("/");
      const basename = parts.pop().replace(/\.(?:m3u8|mp4|m4v|ts)$/i, "");
      if (parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part))) throw new Error("下载文件夹路径无效");
      return [...parts, hls.safeFilename(basename, extension)].join("/");
    }
    function trimHistory() {
      const finished = Array.from(entries.values()).filter(entry => TERMINAL.has(entry.status.state));
      for (const entry of finished.slice(0, Math.max(0, finished.length - 30))) entries.delete(entry.status.id);
    }
    function addJob(job) {
      if (!job || typeof job.id !== "string" || !job.id || job.id.length > 128 || job.isM3U8 !== true) throw new Error("无效的 HLS 下载任务");
      if (!/^https?:$/.test(new URL(job.url).protocol)) throw new Error("仅支持 HTTP / HTTPS 视频资源");
      if (entries.has(job.id)) return { success: true, job: snapshot(entries.get(job.id)) };
      if (Array.from(entries.values()).filter(entry => !TERMINAL.has(entry.status.state)).length >= 20) throw new Error("下载队列已满，请等待当前任务完成");
      trimHistory();
      const stamp = now();
      const entry = { input: { ...job }, controller: new AbortController(), progressTimer: null,
        lastSent: -Infinity, notifications: Promise.resolve(), downloadId: null, chromeFinished: false,
        status: { id: job.id, title: job.title || "视频", tabId: job.tabId, filename: job.filename || "视频",
          state: "queued", bytesReceived: 0, totalBytes: 0, completedSegments: 0, totalSegments: 0,
          createdAt: stamp, updatedAt: stamp, error: null } };
      entries.set(job.id, entry);
      queue.push(job.id);
      update(entry, {}, true);
      Promise.resolve().then(pump);
      return { success: true, job: snapshot(entry) };
    }
    function cancelJob(jobId) {
      const entry = entries.get(jobId);
      if (!entry) return { success: false, error: "找不到下载任务" };
      if (TERMINAL.has(entry.status.state)) return { success: true, job: snapshot(entry) };
      entry.controller.abort(abortError());
      if (activeId !== jobId) update(entry, { state: "cancelled", error: null, finishedAt: now() }, true);
      else update(entry, { cancelRequested: true }, true);
      return { success: true };
    }
    async function cancelChrome(entry) {
      if (entry.downloadId === null || entry.chromeFinished) return;
      await broker("cancelChromeDownload", { jobId: entry.status.id, downloadId: entry.downloadId }, 3);
      entry.chromeFinished = true;
    }
    async function waitForChrome(entry) {
      for (;;) {
        ensureActive(entry);
        const { item } = await broker("getChromeDownload", { jobId: entry.status.id, downloadId: entry.downloadId }, 3);
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
      try { return await broker("saveBlob", data, 3); }
      catch (saveError) {
        // A missing runtime reply does not prove Chrome failed to create the
        // download. The broker owns an idempotent jobId -> downloadId mapping.
        for (;;) {
          let recovery;
          try { recovery = await broker("getChromeDownload", { jobId: entry.status.id }, 3); }
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
      const memoryParts = [];
      let memoryBytes = 0, finalState = "interrupted", errorText = null, cleanupError = null, chromeReferencePossible = false;
      try {
        ensureActive(entry);
        await update(entry, { state: "parsing" }, true);
        const client = hls.createClient({ signal: entry.controller.signal, onRetry({ attempt }) {
          update(entry, { retryAttempt: attempt });
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
        await update(entry, { state: "downloading" }, true);
        await client.download(plan, sink, ({ bytes, completed, total }) => {
          update(entry, { bytesReceived: bytes, completedSegments: completed, totalSegments: total, retryAttempt: 0 });
        });
        ensureActive(entry);
        let file;
        if (writer) {
          await writer.close();
          writer = null;
          file = await temporaryFile.getFile();
          if (file.size !== entry.status.bytesReceived) throw new Error("临时文件大小与接收数据不一致");
        } else {
          file = new Blob(memoryParts, { type: plan.isFmp4 ? "video/mp4" : "video/mp2t" });
          memoryParts.length = 0;
        }
        ensureActive(entry);
        objectUrl = urlApi.createObjectURL(file);
        await update(entry, { state: "saving", totalBytes: file.size }, true);
        chromeReferencePossible = true;
        const result = await saveBlob(entry, { jobId: entry.status.id, url: objectUrl, filename, saveAs: entry.input.saveAs === true });
        if (!Number.isInteger(result.downloadId)) throw new Error("Chrome 未返回有效的下载任务编号");
        entry.downloadId = result.downloadId;
        await update(entry, { downloadId: result.downloadId }, true);
        await waitForChrome(entry);
        finalState = "complete";
      } catch (error) {
        if (error.noChromeReference) chromeReferencePossible = false;
        const cancelled = entry.controller.signal.aborted || error.name === "AbortError";
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
          if (objectUrl) urlApi.revokeObjectURL(objectUrl);
          if (directory && temporaryName && temporaryFile) {
            try { await directory.removeEntry(temporaryName); }
            catch (error) { if (error.name !== "NotFoundError") cleanupError = `临时下载文件未能清理：${error.message}`; }
          }
        }
        await update(entry, { state: finalState, error: errorText, cleanupError, cancelRequested: false, finishedAt: now() }, true);
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
          await execute(entry);
          activeId = null;
        }
      } finally { activeId = null; pumping = false; }
    }
    function handleMessage(message, sender, sendResponse) {
      if (message?.target !== "neko-offscreen") return false;
      if (sender?.id !== runtime.id || sender.tab || (sender.url && sender.url !== runtime.getURL("background.js"))) return false;
      try {
        if (message.action === "runJob") sendResponse(addJob(message.job));
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
