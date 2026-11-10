/* Download UI: only report success after the file writer / Chrome finishes. */
document.addEventListener("DOMContentLoaded", () => {
  "use strict";
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sourceUrl = params.get("url") || "";
  const title = params.get("title") || "视频";
  let plan = null, controller = null, downloading = false, downloadId = null, objectUrl = null, selectedFile = null, savedBytes = 0;
  const MEMORY_LIMIT = 256 * 1024 * 1024;
  $("titleVal").textContent = title;
  $("urlVal").textContent = sourceUrl || "未提供视频流地址";
  $("btnStart").disabled = true;

  function setStatus(text, state = "ready") {
    $("statusMsg").textContent = text;
    $("statusMsg").dataset.state = state;
  }
  function setBusy(busy) {
    downloading = busy;
    $("btnStart").disabled = busy || !plan;
    $("btnDownloadM3U8").disabled = busy || !sourceUrl;
    if ($("btnCancel")) $("btnCancel").disabled = !busy;
    if ($("btnRetryParse")) $("btnRetryParse").disabled = busy;
  }
  function updateProgress({ completed, total, bytes }, startedAt) {
    savedBytes = bytes;
    const percent = Math.floor(completed / total * 100);
    $("progressFill").style.width = `${percent}%`;
    $("progressFill").parentElement.setAttribute("aria-valuenow", percent);
    $("percentText").textContent = `${percent}%`;
    $("progressText").textContent = `${completed} / ${total} 个分片 · ${(bytes / 1048576).toFixed(1)} MB`;
    if ($("statBytes")) $("statBytes").textContent = `${(bytes / 1048576).toFixed(1)} MB`;
    if ($("statSpeed")) $("statSpeed").textContent = `${(bytes / 1048576 / Math.max(1, (performance.now() - startedAt) / 1000)).toFixed(1)} MB/s`;
  }
  function revokeObjectUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  async function parse() {
    if (downloading) return;
    plan = null;
    controller?.abort();
    controller = new AbortController();
    const parseSignal = controller.signal;
    $("btnStart").disabled = true;
    if ($("btnRetryParse")) $("btnRetryParse").hidden = true;
    setStatus("正在解析播放清单…", "loading");
    try {
      const client = NekoHls.createClient({ signal: parseSignal, onVariant(variant, count) {
        if (!parseSignal.aborted) setStatus(`检测到 ${count} 档画质，正在解析可完整保存的最高码率线路…`, "loading");
      } });
      const parsedPlan = await client.loadPlan(sourceUrl);
      if (parseSignal.aborted) return;
      plan = parsedPlan;
      if (plan.isFmp4 && (plan.maps.size > 1 || plan.discontinuities)) throw new Error("此 fMP4 线路存在初始化段或时间轴切换，需要重新封装；请更换线路或使用外部下载工具");
      const duration = Math.round(plan.totalDuration);
      const time = `${Math.floor(duration / 60)} 分 ${duration % 60} 秒`;
      const encrypted = plan.segments.some(segment => segment.key) ? " · AES-128" : "";
      $("segmentVal").textContent = `${plan.segments.length} 个分片 · ${time} · ${plan.isFmp4 ? "MP4" : "TS"}${encrypted}`;
      $("progressText").textContent = "准备下载";
      setStatus(`清单已就绪。选择保存位置后开始下载。${plan.discontinuities ? "此线路存在时间轴切换，保存后请检查衔接处。" : ""}`);
      $("btnStart").disabled = false;
    } catch (error) {
      if (error.name === "AbortError" || parseSignal.aborted) return;
      plan = null;
      $("segmentVal").textContent = "解析未完成";
      setStatus(`解析失败：${error.message}`, "error");
      if ($("btnRetryParse")) $("btnRetryParse").hidden = false;
    }
  }
  function chromeDownload(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: true }, id => {
        const error = chrome.runtime.lastError;
        if (error || id === undefined) reject(new Error(error?.message || "Chrome 未创建下载任务"));
        else resolve(id);
      });
    });
  }
  function waitForDownload(id, signal) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { chrome.downloads.onChanged.removeListener(changed); signal.removeEventListener("abort", abort); };
      const finish = error => {
        if (finished) return;
        finished = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const changed = delta => {
        if (delta.id !== id) return;
        if (delta.state?.current === "complete") finish();
        if (delta.state?.current === "interrupted") finish(new Error(`保存中断：${delta.error?.current || "请重试"}`));
      };
      const abort = () => {
        chrome.downloads.cancel(id, () => {
          void chrome.runtime.lastError;
          finish(new DOMException("下载已取消", "AbortError"));
        });
      };
      chrome.downloads.onChanged.addListener(changed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      chrome.downloads.search({ id }, items => {
        const error = chrome.runtime.lastError;
        if (error) return finish(new Error(error.message));
        const item = items?.[0];
        if (!item) return finish(new Error("找不到 Chrome 下载任务"));
        if (item.state === "complete") finish();
        else if (item.state === "interrupted") finish(new Error(`保存中断：${item.error || "请重试"}`));
      });
    });
  }
  $("btnStart").addEventListener("click", async () => {
    if (downloading || !plan) return;
    setBusy(true);
    controller = new AbortController();
    const signal = controller.signal;
    selectedFile = null;
    downloadId = null;
    savedBytes = 0;
    if ($("btnReveal")) $("btnReveal").hidden = true;
    const filename = NekoHls.safeFilename(title, plan.isFmp4 ? "mp4" : "ts");
    const startedAt = performance.now();
    updateProgress({ completed: 0, total: plan.segments.length, bytes: 0 }, startedAt);
    let writer = null;
    let temporaryDirectory = null, temporaryName = null, temporaryFile = null;
    const memoryParts = [];
    let memoryBytes = 0;
    try {
      // Preserve user activation. Cancelling this dialog cancels the operation.
      if (typeof window.showSaveFilePicker === "function") {
        try {
          selectedFile = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: "视频文件", accept: { [plan.isFmp4 ? "video/mp4" : "video/mp2t"]: [plan.isFmp4 ? ".mp4" : ".ts"] } }] });
        } catch (error) {
          // Some extension contexts expose the method but cannot show a picker.
          // Only unsupported-context failures may fall back; cancellation and
          // all permission / actual write errors remain terminal.
          if (!["NotSupportedError", "SecurityError"].includes(error.name)) throw error;
          selectedFile = null;
        }
        if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
        if (selectedFile) writer = await selectedFile.createWritable();
      }
      // Extension contexts may not support the user-facing picker. OPFS keeps
      // large downloads on disk until Chrome has copied the completed file to
      // the chosen destination. Never enumerate or remove other tasks' files.
      if (!writer && typeof navigator.storage?.getDirectory === "function") {
        try { temporaryDirectory = await navigator.storage.getDirectory(); }
        catch (error) {
          if (error.name !== "NotSupportedError") throw error;
        }
        if (temporaryDirectory) {
          temporaryName = `neko-download-${crypto.randomUUID()}.part`;
          temporaryFile = await temporaryDirectory.getFileHandle(temporaryName, { create: true });
          writer = await temporaryFile.createWritable();
        }
      }
      if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
      const sink = writer || { async write(bytes) {
        memoryBytes += bytes.byteLength;
        if (memoryBytes > MEMORY_LIMIT) throw new Error("当前浏览器无法流式写盘，已达到 256 MB 内存上限。请使用支持保存位置选择的 Chrome，或复制直链到外部下载工具");
        memoryParts.push(bytes);
      } };
      const client = NekoHls.createClient({ signal, onRetry({ attempt }) {
        setStatus(`网络请求暂时失败，正在第 ${attempt} 次重试…`, "downloading");
      } });
      setStatus(temporaryFile ? "正在下载并写入临时文件，完成后选择保存位置。请保持此标签页开启。" : writer ? "正在下载并按顺序写入文件，请保持此标签页开启。" : "正在下载，当前使用内存保存（上限 256 MB）。", "downloading");
      await client.download(plan, sink, progress => updateProgress(progress, startedAt));
      if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
      setStatus("分片已全部接收，正在完成文件保存…", "downloading");
      if (writer) {
        await writer.close();
        writer = null;
        const file = await (temporaryFile || selectedFile).getFile();
        if (file.size !== savedBytes) throw new Error("保存后的文件大小与下载数据不一致");
        if (temporaryFile) {
          if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
          objectUrl = URL.createObjectURL(file);
          downloadId = await chromeDownload(objectUrl, filename);
          await waitForDownload(downloadId, signal);
          revokeObjectUrl();
        }
      } else {
        const blob = new Blob(memoryParts, { type: plan.isFmp4 ? "video/mp4" : "video/mp2t" });
        memoryParts.length = 0;
        objectUrl = URL.createObjectURL(blob);
        downloadId = await chromeDownload(objectUrl, filename);
        await waitForDownload(downloadId, signal);
        revokeObjectUrl();
      }
      setStatus(`已保存：${filename} · ${(savedBytes / 1048576).toFixed(1)} MB。全部 ${plan.segments.length} 个分片下载成功。`, "success");
      if ($("btnReveal")) {
        $("btnReveal").hidden = false;
        $("btnReveal").textContent = downloadId === null ? "检查已保存文件" : "在文件夹中显示";
      }
    } catch (error) {
      if (writer) { try { await writer.abort(); } catch { /* Already closed or disk unavailable. */ } }
      const cancelled = error.name === "AbortError" || signal.aborted;
      const reason = error.name === "QuotaExceededError" ? "临时存储空间不足，请释放磁盘空间后重试" : error.message;
      setStatus(cancelled ? "下载已取消。可重新开始。" : `下载未完成：${reason}。本次下载未标记为完成。`, cancelled ? "cancelled" : "error");
      revokeObjectUrl();
      selectedFile = null;
    } finally {
      memoryParts.length = 0;
      if (temporaryDirectory && temporaryName && temporaryFile) {
        try { await temporaryDirectory.removeEntry(temporaryName); }
        catch (error) {
          if (error.name !== "NotFoundError") {
            console.warn("本次下载的临时文件未能清理：", error);
            $("statusMsg").textContent += " 临时下载缓存未能清理。";
          }
        }
      }
      setBusy(false);
    }
  });
  $("btnCancel")?.addEventListener("click", () => controller?.abort(new DOMException("下载已取消", "AbortError")));
  $("btnRetryParse")?.addEventListener("click", parse);
  $("btnCopyUrl").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(sourceUrl); setStatus(downloading ? "视频流地址已复制，下载正在继续。" : "视频流地址已复制。", downloading ? "downloading" : "ready"); }
    catch (error) { setStatus(`复制失败：${error.message}${downloading ? "。下载仍在继续。" : ""}`, downloading ? "downloading" : "error"); }
  });
  $("btnDownloadM3U8").addEventListener("click", async () => {
    if (downloading || !sourceUrl) return;
    setBusy(true);
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    let manifestObjectUrl = null;
    try {
      setStatus("正在准备播放清单并转换资源地址…", "downloading");
      const result = await NekoHls.createClient({ signal }).request(sourceUrl, null, true);
      const content = NekoHls.absolutizePlaylist(result.text, result.url);
      manifestObjectUrl = URL.createObjectURL(new Blob([content], { type: "application/vnd.apple.mpegurl" }));
      if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
      const id = await chromeDownload(manifestObjectUrl, NekoHls.safeFilename(title, "m3u8"));
      await waitForDownload(id, signal);
      setStatus("播放清单已保存，资源地址已转换为完整网址。清单不包含视频数据，播放时仍需联网。", "success");
    } catch (error) {
      const cancelled = error.name === "AbortError" || signal.aborted;
      setStatus(cancelled ? "清单保存已取消。" : `清单保存未完成：${error.message}`, cancelled ? "cancelled" : "error");
    } finally {
      if (manifestObjectUrl) URL.revokeObjectURL(manifestObjectUrl);
      setBusy(false);
      if (!plan && $("btnRetryParse")) $("btnRetryParse").hidden = false;
    }
  });
  $("btnReveal")?.addEventListener("click", async () => {
    if (downloadId !== null) { chrome.downloads.show(downloadId); return; }
    try {
      if (!selectedFile) return;
      const file = await selectedFile.getFile();
      setStatus(`文件检查通过：${file.name} · ${(file.size / 1048576).toFixed(1)} MB。请在选择的保存文件夹中用播放器打开。`, "success");
    } catch (error) { setStatus(`无法打开文件：${error.message}`, "error"); }
  });
  window.addEventListener("beforeunload", event => {
    if (!downloading) return;
    event.preventDefault();
    event.returnValue = "";
  });
  if (sourceUrl) parse();
  else { setBusy(false); setStatus("缺少视频流地址，请从插件中选择视频重新打开。", "error"); }
});
