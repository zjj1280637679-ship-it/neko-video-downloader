// The popup is only a view: the background owns all video download jobs.
document.addEventListener("DOMContentLoaded", async () => {
  const $ = id => document.getElementById(id);
  const cards = new Map(), jobCards = new Map(), removedJobs = new Set();
  const activeStates = new Set(["queued", "parsing", "downloading", "saving"]);
  const { formatSize, safeFilename, mediaUrl, formatRemaining } = NekoFormat;
  const { stateLabels, concurrencyReason, jobConcurrency, jobExplanation } = NekoExplain;
  let currentTab = null, currentMedia = [], currentJobs = [];
  let settings = { concurrency: 64 }, settingsLoaded = false;
  let preferenceSave = Promise.resolve(), preferenceRevision = 0, confirmedPreferenceRevision = 0, pendingPreferenceKey = null;
  let unappliedPreferenceKey = null, preferenceLiveApplied, preferenceWarning = "";
  let mediaLoading = false, jobsLoading = false, mediaPending = false, jobsPending = false;
  let mediaRefreshPending = false, mediaRecoveryError = "", paneChosen = false;
  let refreshTimer, toastTimer, closing = false;
  let capture = { phase: "checking", playback: {}, chunkCount: 0 }, checkingStartedAt = Date.now();

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function setText(element, text) { if (element.textContent !== String(text)) element.textContent = text; }
  function showToast(message) {
    clearTimeout(toastTimer); setText($("toast"), message); $("toast").classList.add("show");
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3500);
  }
  function setStatus(message, state = "ready") { setText($("statusText"), message); $("statusBar").dataset.state = state; }
  function sendMessage(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response) reject(new Error("扩展后台未响应"));
      else if (response.success === false) reject(new Error(response.error || "操作未完成，请重试"));
      else resolve(response);
    }));
  }
  function showPane(name, focus = false, automatic = false) {
    if (automatic && paneChosen) return;
    if (!automatic) paneChosen = true;
    for (const pane of ["source", "jobs"]) {
      const selected = pane === name;
      $(`${pane}Panel`).hidden = !selected;
      $(`${pane}Tab`).setAttribute("aria-selected", String(selected));
      $(`${pane}Tab`).tabIndex = selected ? 0 : -1;
    }
    syncArtMotion();
    if (focus) $(`${name}Tab`).focus();
  }
  function syncArtMotion() {
    $("appContent").dataset.artPaused = String(document.hidden || $("sourcePanel").hidden);
    $("appContent").dataset.jobArtPaused = String(document.hidden || $("jobsPanel").hidden);
  }
  document.addEventListener("visibilitychange", syncArtMotion);
  syncArtMotion();
  for (const name of ["source", "jobs"]) {
    $(`${name}Tab`).addEventListener("click", () => showPane(name));
    $(`${name}Tab`).addEventListener("keydown", event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault(); showPane(event.key === "Home" ? "source" : event.key === "End" ? "jobs" : name === "jobs" ? "source" : "jobs", true);
      }
    });
  }
  function createCaptureArt(phase) {
    const art = node("div", `companion-art companion-art-${phase}`); art.setAttribute("aria-hidden", "true");
    const mascot = node("img", "companion-mascot"); mascot.src = "icons/yangmo-mascot.png"; mascot.alt = "";
    const sign = node("span", "companion-sign", { waiting: "▶", sniffing: "···", error: "!", unavailable: "·" }[phase] || "✦");
    art.append(mascot, sign); return art;
  }
  function emptyState(container, title, description, hint = "", phase = "") {
    const signature = JSON.stringify([title, description, hint, phase]);
    const existing = container.querySelector(".empty-box");
    if (existing?.dataset.signature === signature) return;
    // Keep the illustration's timeline when only a discovery hint changes.
    if (existing && existing.dataset.phase === phase) {
      existing.dataset.signature = signature; setText(existing.querySelector(".empty-title"), title); setText(existing.querySelector(".empty-desc"), description);
      const hintNode = existing.querySelector(".empty-hint");
      if (hint) { if (hintNode) setText(hintNode, hint); else existing.append(node("p", "empty-hint", hint)); }
      else hintNode?.remove();
      return;
    }
    const empty = node("div", "empty-box"); empty.dataset.signature = signature; empty.dataset.phase = phase;
    empty.append(createCaptureArt(phase), node("p", "empty-title", title), node("p", "empty-desc", description));
    if (hint) empty.append(node("p", "empty-hint", hint));
    container.replaceChildren(empty);
  }
  function updateCapture(response) {
    const playback = response.playback || {};
    let phase = currentMedia.length ? "found" : response.capturePhase;
    if (!["checking", "waiting", "sniffing", "found", "no-source", "no-video"].includes(phase) || phase === "found" && !currentMedia.length) phase = "checking";
    // A source request can be a preload. Only player observations establish playback.
    if (["sniffing", "no-source"].includes(phase) && !playback.observed && !playback.playing) phase = "checking";
    if (phase === "checking" && capture.phase !== "checking") checkingStartedAt = Date.now();
    capture = { phase, playback, chunkCount: response.chunkCount || 0 };
  }
  function captureFeedback() { return NekoCapture.captureFeedback(capture, currentMedia.length, checkingStartedAt); }
  function renderCapture() {
    const feedback = captureFeedback(); setStatus(feedback.status, feedback.state); renderMedia();
  }

  async function startDownload(item, button) {
    if (!mediaUrl(item.url)) return showToast("该来源不是可下载的 HTTP 视频地址");
    button.disabled = true;
    try {
      await savePreferences();
      const filename = String(item.suggestedFilename || item.filename || "视频").split(/[\\/]/).pop();
      const title = item.title || filename.replace(/\.(m3u8|mp4|ts|webm|mov|mkv|m4a|mp3)$/i, "");
      const response = await sendMessage({ action: "startDownload", url: item.url, title, filename: safeFilename(filename), isM3U8: Boolean(item.isM3U8 || /\.m3u8(?:[?#]|$)/i.test(item.url) || item.totalSegments > 0), tabId: item.tabId ?? currentTab?.id });
      if (response.job) currentJobs = [response.job, ...currentJobs.filter(job => job.id !== response.job.id)];
      renderJobs(); showPane("jobs");
      showToast("任务已开始，关闭弹窗也会继续下载");
      await loadJobs();
    } catch (error) { showToast(`下载未开始：${error.message}`); }
    finally { button.disabled = false; syncSourceJobs(); }
  }
  async function copyUrl(url) {
    try { await navigator.clipboard.writeText(url); showToast("视频来源链接已复制"); }
    catch { showToast("复制失败，请重新点击复制链接"); }
  }
  function createCard(item) {
    const card = node("article", "media-card"), header = node("div", "card-header"), identity = node("div");
    const badge = node("span", "badge-tag"), number = node("span", "source-number"), size = node("span", "media-size");
    identity.append(badge, number); header.append(identity, size);
    const title = node("h2", "file-name"), host = node("div", "source-host");
    const actions = node("div", "card-actions"), download = node("button", "btn btn-primary"), copy = node("button", "btn btn-secondary", "复制链接"), state = node("div", "card-state");
    actions.append(download, copy); card.append(header, title, host, actions, state);
    const entry = { card, badge, number, size, title, host, download, state, item };
    download.addEventListener("click", () => startDownload(entry.item, download));
    copy.addEventListener("click", () => copyUrl(entry.item.url));
    return entry;
  }
  function syncSourceJobs() {
    for (const entry of cards.values()) {
      const job = currentJobs.find(job => job.url === entry.item.url && activeStates.has(job.state));
      entry.download.disabled = Boolean(job);
      setText(entry.download, job ? stateLabels[job.state] : "↓ 下载视频");
      setText(entry.state, job ? "任务已在后台运行，可切换到下载任务查看。" : "");
    }
  }
  function renderMedia() {
    setText($("sourceTabCount"), currentMedia.length);
    const live = new Set(currentMedia.map(item => item.url));
    for (const [url, entry] of cards) if (!live.has(url)) { entry.card.remove(); cards.delete(url); }
    if (!currentMedia.length) {
      const feedback = captureFeedback(); emptyState($("mediaList"), feedback.title, feedback.description, feedback.hint, feedback.state);
      return;
    }
    $("mediaList").querySelector(".empty-box")?.remove();
    currentMedia.forEach((item, index) => {
      const entry = cards.get(item.url) || createCard(item);
      cards.set(item.url, entry); entry.item = item; entry.card.hidden = false;
      const url = mediaUrl(item.url);
      entry.badge.className = `badge-tag ${item.isM3U8 ? "badge-m3u8" : "badge-mp4"}`;
      setText(entry.badge, item.isM3U8 ? "HLS · M3U8" : String(item.ext || "VIDEO").toUpperCase());
      setText(entry.number, item.active ? capture.playback.playing ? "当前播放" : "当前线路" : `来源 ${currentMedia.indexOf(item) + 1}`);
      entry.card.dataset.active = String(Boolean(item.active));
      setText(entry.size, item.isM3U8 ? "自动合并" : item.size > 0 ? formatSize(item.size) : "大小待确认");
      setText(entry.title, item.suggestedFilename || "未命名视频"); entry.title.title = entry.title.textContent;
      setText(entry.host, `${url?.hostname || "未知来源"}${item.name ? ` · ${item.name}` : ""}`);
      const previous = index ? cards.get(currentMedia[index - 1].url).card : null;
      if (!entry.card.isConnected || entry.card.previousElementSibling !== previous) {
        if (previous) previous.after(entry.card); else $("mediaList").prepend(entry.card);
      }
    });
    syncSourceJobs();
  }
  function createJobCard(job) {
    const card = node("article", "job-card"), header = node("div", "job-header"), title = node("h2", "job-title"), label = node("span", "job-state");
    header.append(title, label);
    const progress = node("div", "job-progress"), fill = node("div", "job-progress-fill");
    progress.setAttribute("role", "progressbar"); progress.setAttribute("aria-label", "视频下载进度"); progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100"); progress.append(fill);
    const progressScene = node("div", "job-progress-scene"), mascotLane = node("div", "job-mascot-lane"), mascotRunner = node("div", "job-mascot-runner");
    mascotLane.setAttribute("aria-hidden", "true");
    const mascot = node("img", "job-mascot-image"); mascot.src = "icons/yangmo-mascot.png"; mascot.alt = ""; mascot.draggable = false;
    mascotRunner.append(mascot, node("span", "job-mascot-sparkle sparkle-one", "✦"), node("span", "job-mascot-sparkle sparkle-two", "✧"));
    mascotLane.append(mascotRunner); progressScene.append(mascotLane, progress);
    const details = node("div", "job-details"), metrics = node("span", "job-metrics"), percent = node("span", "job-percent"); details.append(metrics, percent);
    const telemetry = node("div", "job-telemetry"), speed = node("span", "job-speed"), concurrency = node("span", "job-concurrency");
    speed.title = "当前所有网络分片的合计下载速度，缓存读取不计入"; telemetry.append(speed, concurrency);
    const eta = node("p", "job-eta"); eta.title = "根据近期速度估算，实际时间会随来源响应变化；不代表文件已经保存。";
    const retryStatus = node("p", "job-retry-status"), cacheStatus = node("p", "job-cache-status");
    retryStatus.setAttribute("role", "status"); retryStatus.setAttribute("aria-live", "polite");
    const error = node("p", "job-error"), actions = node("div", "job-actions"), cancel = node("button", "job-button", "取消任务"), retry = node("button", "job-button", "重新下载"), reveal = node("button", "job-button", "在文件夹中显示"), discard = node("button", "job-button job-discard", "清除缓存"), remove = node("button", "job-button job-remove", "删除任务");
    remove.title = "删除任务记录及临时缓存，不删除已保存的文件";
    const explanation = node("details", "job-explain"), summary = node("summary", "explain-summary", "下载是怎样进行的"), explanationBody = node("dl", "explain-grid");
    const explainFields = {}, explainLabels = {};
    for (const [key, label] of [["source", "来源"], ["quality", "档位"], ["phase", "当前"], ["order", "顺序"], ["concurrency", "并行"], ["result", "保存"]]) {
      const value = node("dd", `explain-${key}`), term = node("dt", "", label); explainFields[key] = value; explainLabels[key] = term;
      explanationBody.append(term, value);
    }
    explanation.append(summary, explanationBody);
    actions.append(cancel, retry, reveal, discard, remove); card.append(header, progressScene, details, telemetry, eta, retryStatus, error, cacheStatus, actions, explanation);
    const entry = { card, title, label, progress, fill, mascotRunner, metrics, percent, telemetry, speed, concurrency, eta, retryStatus, cacheStatus, error, cancel, retry, reveal, discard, remove, explainFields, explainLabels, job, pendingAction: null, actionError: "", cancelAcknowledged: false, restoreCancelFocus: false };
    cancel.addEventListener("click", () => jobAction("cancelJob", entry, cancel));
    reveal.addEventListener("click", () => jobAction("showJob", entry, reveal));
    retry.addEventListener("click", () => jobAction(entry.job.state === "interrupted" && entry.job.resumable ? "retryJob" : "freshStart", entry, retry));
    discard.addEventListener("click", () => jobAction("discardJob", entry, discard));
    remove.addEventListener("click", () => jobAction("removeJob", entry, remove));
    return entry;
  }
  function setJobControls(entry) {
    for (const button of [entry.cancel, entry.retry, entry.reveal, entry.discard, entry.remove]) button.disabled = Boolean(entry.pendingAction);
    if (activeStates.has(entry.job.state) && (entry.job.cancelRequested || entry.cancelAcknowledged)) entry.cancel.disabled = true;
  }
  async function jobAction(action, entry, button) {
    if (entry.pendingAction) return;
    if (action === "cancelJob" && (entry.job.cancelRequested || entry.cancelAcknowledged)) return;
    if (action === "removeJob" && !["complete", "interrupted", "cancelled"].includes(entry.job.state)) return;
    const hadActionFocus = document.activeElement === button;
    const actionIndex = [...$("jobList").children].indexOf(entry.card);
    if (action === "cancelJob") entry.restoreCancelFocus = hadActionFocus;
    entry.pendingAction = action; entry.actionError = ""; setJobControls(entry);
    if (action === "cancelJob" || action === "removeJob") renderJobs();
    try {
      if (action === "freshStart") await startDownload(entry.job, button);
      else {
        if (action === "retryJob") await savePreferences();
        const response = await sendMessage({ action, jobId: entry.job.id });
        if (action === "cancelJob") entry.cancelAcknowledged = true;
        if (action === "removeJob") {
          removedJobs.add(entry.job.id);
          currentJobs = currentJobs.filter(job => job.id !== entry.job.id);
          renderJobs(); showToast("任务已删除，已保存的文件不受影响");
        }
        if (response.job) currentJobs = currentJobs.map(job => job.id === response.job.id ? response.job : job);
        if (action === "retryJob") showToast("已继续下载，将校验并复用已保留的分片");
        if (action === "discardJob") showToast("缓存已清除，下次下载将重新获取分片");
        if (action !== "showJob") await loadJobs();
      }
    }
    catch (error) {
      if (action === "removeJob") { entry.actionError = `删除失败：${error.message}`; renderJobs(); }
      showToast(error.message);
    }
    finally {
      entry.pendingAction = null; setJobControls(entry);
      if (action === "cancelJob") renderJobs();
      // Polling never replaces controls. If an action removes its own control,
      // keep keyboard navigation on a meaningful action for this task.
      const focus = document.activeElement;
      const mayRestoreFocus = hadActionFocus && (!focus || focus === button || focus === document.body || focus === document.documentElement);
      if (mayRestoreFocus && action === "removeJob" && removedJobs.has(entry.job.id)) {
        focusRemovalNeighbor(actionIndex);
      } else if (mayRestoreFocus && (button.hidden || !button.isConnected)) {
        const order = action === "cancelJob" ? [entry.remove, entry.retry] : [entry.cancel, entry.retry, entry.reveal, entry.remove, entry.discard];
        const next = order.find(control => !control.hidden && !control.disabled && control.isConnected);
        (next || $("jobsTab")).focus();
      } else if (mayRestoreFocus && !button.disabled) button.focus();
    }
  }
  function focusRemovalNeighbor(index) {
    const nextJob = currentJobs[Math.min(Math.max(0, index), currentJobs.length - 1)];
    const next = nextJob && jobCards.get(nextJob.id);
    (next && !next.remove.hidden && !next.remove.disabled ? next.remove : $("jobsTab")).focus();
  }
  function renderJobs() {
    const jobs = currentJobs, active = currentJobs.filter(job => activeStates.has(job.state)).length;
    setText($("jobsTabCount"), active || currentJobs.length);
    $("jobsTabCount").dataset.active = String(active > 0);
    const live = new Set(jobs.map(job => job.id));
    let removedFocusIndex = -1;
    for (const [id, entry] of jobCards) if (!live.has(id)) {
      if (entry.card.contains(document.activeElement)) removedFocusIndex = [...$("jobList").children].indexOf(entry.card);
      entry.card.remove(); jobCards.delete(id);
    }
    if (!jobs.length) {
      emptyState($("jobList"), "喜欢的视频，正在等你", "在“视频来源”里点击下载。这里会保留近期任务，随时查看进度。");
      if (removedFocusIndex >= 0) $("jobsTab").focus();
      syncSourceJobs(); return;
    }
    $("jobList").querySelector(".empty-box")?.remove();
    jobs.forEach((job, index) => {
      const entry = jobCards.get(job.id) || createJobCard(job); jobCards.set(job.id, entry); entry.job = job;
      if (!activeStates.has(job.state)) entry.cancelAcknowledged = false;
      const cancelling = activeStates.has(job.state) && (job.cancelRequested || entry.cancelAcknowledged || entry.pendingAction === "cancelJob");
      entry.card.dataset.state = job.state;
      entry.card.dataset.animating = String(["parsing", "downloading", "saving"].includes(job.state) && !cancelling);
      setText(entry.title, String(job.filename || job.title || "视频").split(/[\\/]/).pop()); entry.title.title = job.filename || job.title || "视频";
      setText(entry.label, stateLabels[job.state] || "处理中");
      const hasTotal = job.totalSegments > 0 || job.totalBytes > 0;
      const ratio = job.totalSegments > 0 ? (job.completedSegments || 0) / job.totalSegments : job.totalBytes > 0 ? (job.bytesReceived || 0) / job.totalBytes : 0;
      // Downloaded bytes/segments reaching 100% still means "saving", never "saved".
      const value = job.state === "complete" ? 100 : Math.max(0, Math.min(100, Math.floor(ratio * 100)));
      entry.fill.style.width = `${value}%`;
      // Decoration shares the real progress value; unknown totals stay at the
      // origin instead of inventing progress from the indeterminate animation.
      entry.mascotRunner.style.left = `${hasTotal || job.state === "complete" ? value : 0}%`;
      entry.progress.dataset.indeterminate = String(!hasTotal && activeStates.has(job.state));
      if (hasTotal || job.state === "complete") entry.progress.setAttribute("aria-valuenow", value); else entry.progress.removeAttribute("aria-valuenow");
      entry.progress.setAttribute("aria-valuetext", `${stateLabels[job.state] || "处理中"}${hasTotal ? ` ${value}%` : ""}`);
      const segments = job.totalSegments > 0 ? `${job.completedSegments || 0} / ${job.totalSegments} 片 · ` : "";
      setText(entry.metrics, `${segments}${formatSize(job.bytesReceived || 0)}${!job.totalSegments && job.totalBytes > 0 ? ` / ${formatSize(job.totalBytes)}` : ""}`);
      setText(entry.percent, hasTotal || job.state === "complete" ? `${value}%` : "");
      const hasSpeed = Number.isFinite(job.bytesPerSecond) && job.bytesPerSecond >= 0;
      const targetConcurrency = job.isM3U8 || job.totalSegments > 0 ? jobConcurrency(job) : null;
      const hasConcurrency = targetConcurrency !== null;
      const showSpeed = job.state === "downloading";
      entry.telemetry.hidden = !(showSpeed && (hasSpeed || hasConcurrency) || job.state === "queued" && hasConcurrency);
      entry.speed.hidden = !showSpeed;
      setText(entry.speed, hasSpeed ? `合计 ${formatSize(job.bytesPerSecond)}/s` : "正在测量速度…");
      entry.concurrency.hidden = !hasConcurrency;
      setText(entry.concurrency, `并发 ${hasConcurrency ? targetConcurrency : "—"}`);
      entry.concurrency.title = concurrencyReason(job);
      const remaining = job.retryAttempt > 0 ? "" : formatRemaining(job.etaSeconds);
      const dataReceived = job.totalSegments > 0 ? job.completedSegments >= job.totalSegments : job.totalBytes > 0 && job.bytesReceived >= job.totalBytes;
      entry.eta.hidden = job.state !== "downloading" || cancelling;
      setText(entry.eta, entry.eta.hidden ? "" : dataReceived ? "数据已收齐，正在准备保存" : remaining ? `预计剩余约 ${remaining}` : "预计剩余 · 估算中");
      for (const [key, value] of Object.entries(jobExplanation(job))) {
        setText(entry.explainFields[key], value);
        entry.explainFields[key].hidden = !value; entry.explainLabels[key].hidden = !value;
      }
      const retrying = activeStates.has(job.state) && (job.retryAttempt > 0 || Boolean(job.retryMessage));
      entry.retryStatus.hidden = !retrying && !cancelling;
      setText(entry.retryStatus, cancelling ? "正在取消任务，等待已发请求结束…" : retrying ? String(job.retryMessage || `正在进行第 ${job.retryAttempt} 次重试…`) : "");
      const issue = [job.error, job.cleanupError, entry.actionError].filter(Boolean).join(" · ");
      entry.error.hidden = !issue; setText(entry.error, issue);
      const canResume = job.state === "interrupted" && job.resumable === true;
      const cached = Number.isFinite(job.cachedSegments) ? Math.max(0, Math.floor(job.cachedSegments)) : 0;
      entry.cacheStatus.hidden = !canResume;
      setText(entry.cacheStatus, canResume ? `已保留 ${cached} 个分片，可继续下载。继续时会校验缓存，链接过期时可能需要重新识别。` : "");
      entry.cancel.hidden = !activeStates.has(job.state);
      setText(entry.cancel, cancelling ? "正在取消…" : "取消任务");
      entry.retry.hidden = !["interrupted", "cancelled"].includes(job.state);
      setText(entry.retry, canResume ? "继续下载" : "重新下载");
      entry.reveal.hidden = job.state !== "complete";
      entry.discard.hidden = !canResume;
      entry.remove.hidden = !["complete", "interrupted", "cancelled"].includes(job.state);
      setJobControls(entry);
      if (entry.restoreCancelFocus) {
        const focus = document.activeElement;
        if (focus && focus !== entry.cancel && focus !== document.body && focus !== document.documentElement) entry.restoreCancelFocus = false;
        else if (!entry.remove.hidden && !entry.remove.disabled) { entry.restoreCancelFocus = false; entry.remove.focus(); }
      }
      const previous = index ? jobCards.get(jobs[index - 1].id).card : null;
      if (!entry.card.isConnected || entry.card.previousElementSibling !== previous) {
        if (previous) previous.after(entry.card); else $("jobList").prepend(entry.card);
      }
    });
    if (removedFocusIndex >= 0) {
      focusRemovalNeighbor(removedFocusIndex);
    }
    syncSourceJobs();
  }
  async function loadJobs() {
    if (closing) return;
    if (jobsLoading) { jobsPending = true; return; }
    jobsLoading = true;
    try {
      const response = await sendMessage({ action: "getJobs" });
      // A getJobs started before removal may finish later. This popup never
      // restores an ID after the worker has confirmed its deletion.
      currentJobs = Array.isArray(response.jobs) ? response.jobs.filter(job => !removedJobs.has(job.id)) : [];
      $("jobsStatus").hidden = true; renderJobs();
    } catch (error) {
      $("jobsStatus").hidden = false; setText($("jobsStatus"), `暂时无法读取任务：${error.message}`);
    } finally {
      jobsLoading = false;
      if (jobsPending && !closing) { jobsPending = false; queueMicrotask(loadJobs); }
    }
  }
  async function loadMediaData(refresh = false) {
    if (!currentTab || !mediaUrl(currentTab.url) || closing) return;
    mediaRefreshPending ||= refresh;
    if (mediaLoading) { mediaPending = true; return; }
    mediaLoading = true;
    const rescan = mediaRefreshPending; mediaRefreshPending = false;
    if (rescan) { $("btnRefresh").disabled = true; setStatus("正在重新识别…", "checking"); }
    try {
      const response = await sendMessage({ action: rescan ? "refreshMedia" : "getMedia", tabId: currentTab.id });
      if (closing) return;
      currentMedia = (response.media || []).filter(item => mediaUrl(item.url));
      if (rescan || currentMedia.length) mediaRecoveryError = "";
      if (mediaRecoveryError) capture = { phase: "error", playback: {}, error: mediaRecoveryError };
      else updateCapture(response);
      renderCapture();
      if (rescan && response.recoveryWarning) showToast(response.recoveryWarning);
    } catch (error) {
      if (closing) return;
      if (rescan) mediaRecoveryError = error.message;
      capture = { phase: "error", playback: {}, error: error.message }; renderCapture();
    } finally {
      mediaLoading = false;
      if (rescan) $("btnRefresh").disabled = false;
      if (mediaPending && !closing) { mediaPending = false; queueMicrotask(loadMediaData); }
    }
  }

  function validConcurrency(value) { return Number.isInteger(value) && value >= 1 && value <= 375; }
  function preferenceValues(value) { return { concurrency: validConcurrency(value?.concurrency) ? value.concurrency : 64 }; }
  function preferenceDraft() { return { concurrency: Number($("concurrency").value) }; }
  function renderConcurrencyInput() {
    const value = Number($("concurrency").value);
    setText($("concurrencyValue"), validConcurrency(value) ? String(value) : "—");
    $("concurrency").setAttribute("aria-valuetext", validConcurrency(value) ? `${value} 路` : "并发数无效");
  }
  function preferenceKey(value) { return JSON.stringify(preferenceValues(value)); }
  function showPreferenceError(message, kind = "error") { $("saveError").hidden = !message; $("saveError").dataset.kind = kind; setText($("saveError"), message || ""); }
  function renderPreferenceConfirmation() {
    const waiting = unappliedPreferenceKey === preferenceKey(settings);
    $("btnReloadPreferences").hidden = !waiting;
    $("btnReloadPreferences").disabled = false;
    setText($("btnReloadPreferences"), waiting ? "重试应用" : "重新读取");
    showPreferenceError(waiting ? preferenceWarning || "并发已保存，尚未应用到当前任务，请重试应用。" : "", "warning");
    setText($("saveStatus"), waiting ? "已保存 · 待应用" : preferenceLiveApplied === true ? "已保存 · 已应用" : confirmedPreferenceRevision ? "已保存" : "自动保存");
  }
  async function loadSettings() {
    $("btnReloadPreferences").disabled = true;
    try {
      const response = await sendMessage({ action: "getSettings" }); settings = preferenceValues(response.settings);
      if (!settingsLoaded) { $("concurrency").value = String(settings.concurrency); renderConcurrencyInput(); }
      settingsLoaded = true; $("concurrency").disabled = false; $("btnReloadPreferences").hidden = true;
      showPreferenceError(""); setText($("saveStatus"), "自动保存"); return settings;
    } catch (error) {
      if (!settingsLoaded) $("concurrency").disabled = true;
      $("btnReloadPreferences").hidden = false;
      setText($("btnReloadPreferences"), "重新读取");
      showPreferenceError(`并发偏好读取失败：${error.message}`); setText($("saveStatus"), "读取失败"); throw error;
    } finally { $("btnReloadPreferences").disabled = false; }
  }
  function savePreferences() {
    if (!settingsLoaded) return Promise.reject(new Error("并发偏好尚未读取，请在下载任务页重新读取"));
    const draft = preferenceDraft();
    if (!validConcurrency(draft.concurrency)) {
      const error = new Error("分片并发需为 1–375 的整数"); showPreferenceError(error.message); setText($("saveStatus"), "未保存"); return Promise.reject(error);
    }
    const key = preferenceKey(draft);
    if (key === pendingPreferenceKey) return preferenceSave;
    if (!pendingPreferenceKey && key === preferenceKey(settings) && key !== unappliedPreferenceKey) { renderPreferenceConfirmation(); return Promise.resolve(settings); }
    const revision = ++preferenceRevision;
    pendingPreferenceKey = key; showPreferenceError(""); setText($("saveStatus"), "保存中…");
    $("btnReloadPreferences").disabled = true;
    // Hand every edit to the worker immediately. Its write queue survives this
    // popup closing; revision guards only protect this view from late replies.
    const operation = sendMessage({ action: "saveSettings", settings: draft }).then(response => {
      if (revision > confirmedPreferenceRevision) {
        settings = preferenceValues(response.settings); confirmedPreferenceRevision = revision;
        preferenceLiveApplied = response.liveApplied;
        unappliedPreferenceKey = response.liveApplied === false ? key : null;
        preferenceWarning = typeof response.warning === "string" ? response.warning : "";
      }
      if (revision === preferenceRevision) {
        pendingPreferenceKey = null;
        if (preferenceKey(preferenceDraft()) === key) {
          renderPreferenceConfirmation();
        } else setText($("saveStatus"), "编辑中…");
        void loadJobs();
      }
      return settings;
    }).catch(error => {
      if (revision === preferenceRevision) { pendingPreferenceKey = null; $("btnReloadPreferences").hidden = true; showPreferenceError(error.message); setText($("saveStatus"), "未保存"); }
      throw error;
    });
    preferenceSave = operation; return operation;
  }
  function savePreferenceChange() { return savePreferences().catch(() => {}); }
  function changeConcurrency() { renderConcurrencyInput(); return savePreferenceChange(); }
  $("concurrency").addEventListener("input", changeConcurrency);
  $("concurrency").addEventListener("change", changeConcurrency);
  $("btnReloadPreferences").addEventListener("click", async () => {
    const button = $("btnReloadPreferences"), hadFocus = document.activeElement === button;
    if (button.disabled) return;
    await (settingsLoaded ? savePreferenceChange() : loadSettings().catch(() => {}));
    const focus = document.activeElement;
    if (hadFocus && (!focus || focus === button || focus === document.body || focus === document.documentElement)) {
      (button.hidden ? $("concurrency") : button).focus();
    }
  });
  $("btnRefresh").addEventListener("click", () => {
    showPane("source");
    if (!settingsLoaded) void loadSettings().catch(() => {});
    if (!currentTab || !mediaUrl(currentTab.url)) return renderCapture();
    loadMediaData(true);
  });
  const onMessage = message => {
    if (message.action === "mediaListUpdated" && message.tabId === currentTab?.id) loadMediaData();
    if (message.action === "jobsUpdated") loadJobs();
  };
  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener("unload", () => { closing = true; clearInterval(refreshTimer); clearTimeout(toastTimer); chrome.runtime.onMessage.removeListener(onMessage); });
  refreshTimer = setInterval(() => { if (!document.hidden) { loadMediaData(); loadJobs(); } }, 2000);
  // Source recovery, job reconciliation and preference reads are independent.
  // A slow download/save broker must not hold the current page scan hostage.
  await Promise.allSettled([
    loadJobs().then(() => { if (!closing && currentJobs.some(job => activeStates.has(job.state))) showPane("jobs", false, true); }),
    loadSettings(),
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (closing) return;
        currentTab = tabs[0] || null;
        if (!currentTab || !mediaUrl(currentTab.url)) {
          capture = { phase: "unavailable", playback: {} }; renderCapture();
        } else await loadMediaData(true);
      } catch (error) { if (!closing) { capture = { phase: "error", playback: {}, error: error.message }; renderCapture(); } }
    })()
  ]);
  if (closing) return;
  if ((!currentTab || !mediaUrl(currentTab.url)) && currentJobs.length) showPane("jobs", false, true);
});
