// The popup is only a view: the background owns all video download jobs.
document.addEventListener("DOMContentLoaded", async () => {
  const $ = id => document.getElementById(id);
  const cards = new Map(), jobCards = new Map();
  const activeStates = new Set(["queued", "parsing", "downloading", "saving"]);
  const stateLabels = { queued: "等待下载", parsing: "解析清单", downloading: "下载中", saving: "正在保存", complete: "已保存", interrupted: "下载中断", cancelled: "已取消" };
  let currentTab = null, currentMedia = [], currentJobs = [], currentFrames = [], activeModalData, modalTrigger;
  let settings = { subfolder: "", askWhereToSave: false };
  let mediaLoading = false, jobsLoading = false, mediaPending = false, jobsPending = false;
  let refreshTimer, toastTimer, framesSignature = "", closing = false;

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
  function formatSize(bytes) {
    if (!(bytes > 0)) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  function safeFilename(name) {
    return String(name || "视频").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120) || "视频";
  }
  function mediaUrl(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; }
  }
  function sendMessage(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response) reject(new Error("扩展后台未响应"));
      else if (response.success === false) reject(new Error(response.error || "操作未完成，请重试"));
      else resolve(response);
    }));
  }
  function showPane(name, focus = false) {
    for (const pane of ["source", "jobs"]) {
      const selected = pane === name;
      $(`${pane}Panel`).hidden = !selected;
      $(`${pane}Tab`).setAttribute("aria-selected", String(selected));
      $(`${pane}Tab`).tabIndex = selected ? 0 : -1;
    }
    if (focus) $(`${name}Tab`).focus();
  }
  for (const name of ["source", "jobs"]) {
    $(`${name}Tab`).addEventListener("click", () => showPane(name));
    $(`${name}Tab`).addEventListener("keydown", event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault(); showPane(event.key === "Home" ? "source" : event.key === "End" ? "jobs" : name === "jobs" ? "source" : "jobs", true);
      }
    });
  }
  function emptyState(container, title, description, hint = "") {
    const signature = JSON.stringify([title, description, hint]);
    if (container.querySelector(".empty-box")?.dataset.signature === signature) return;
    const empty = node("div", "empty-box"); empty.dataset.signature = signature;
    empty.append(node("p", "empty-cat", "(=^･ω･^=)"), node("p", "empty-title", title), node("p", "empty-desc", description));
    if (hint) empty.append(node("p", "empty-hint", hint));
    container.replaceChildren(empty);
  }

  async function startDownload(item, button) {
    if (!mediaUrl(item.url)) return showToast("该来源不是可下载的 HTTP 视频地址");
    button.disabled = true;
    try {
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
    const title = node("h2", "file-name"), host = node("div", "source-host"), path = node("div", "url-preview");
    const actions = node("div", "card-actions"), download = node("button", "btn btn-primary"), copy = node("button", "btn btn-secondary", "复制链接"), state = node("div", "card-state");
    actions.append(download, copy); card.append(header, title, host, path, actions, state);
    const entry = { card, badge, number, size, title, host, path, download, state, item };
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
    const query = $("mediaSearch").value.trim().toLocaleLowerCase();
    const filtered = currentMedia.filter(item => `${item.suggestedFilename || ""} ${item.name || ""} ${item.url}`.toLocaleLowerCase().includes(query));
    $("listToolbar").hidden = !currentMedia.length;
    setText($("sourceTabCount"), currentMedia.length);
    setText($("sourceCount"), query ? `${filtered.length} / ${currentMedia.length}` : `${currentMedia.length} 个来源`);
    const live = new Set(currentMedia.map(item => item.url));
    for (const [url, entry] of cards) if (!live.has(url)) { entry.card.remove(); cards.delete(url); }
    if (!filtered.length) {
      emptyState($("mediaList"), currentMedia.length ? "没有匹配的来源" : "先让视频播放一会儿", currentMedia.length ? "试试文件名、集数，或视频来源域名。" : "在网页点击播放。出现来源后，点下载即可保存。", currentMedia.length ? "" : "仍未发现？刷新视频网页，再重新播放。");
      return;
    }
    $("mediaList").querySelector(".empty-box")?.remove();
    const visible = new Set(filtered.map(item => item.url));
    for (const [url, entry] of cards) entry.card.hidden = !visible.has(url);
    filtered.forEach((item, index) => {
      const entry = cards.get(item.url) || createCard(item);
      cards.set(item.url, entry); entry.item = item; entry.card.hidden = false;
      const url = mediaUrl(item.url);
      entry.badge.className = `badge-tag ${item.isM3U8 ? "badge-m3u8" : "badge-mp4"}`;
      setText(entry.badge, item.isM3U8 ? "HLS · M3U8" : String(item.ext || "VIDEO").toUpperCase());
      setText(entry.number, item.active ? "当前播放" : `来源 ${currentMedia.indexOf(item) + 1}`);
      entry.card.dataset.active = String(Boolean(item.active));
      setText(entry.size, item.isM3U8 ? "自动合并" : item.size > 0 ? formatSize(item.size) : "大小待确认");
      setText(entry.title, item.suggestedFilename || "未命名视频"); entry.title.title = entry.title.textContent;
      setText(entry.host, `${url?.hostname || "未知来源"}${item.name ? ` · ${item.name}` : ""}`);
      setText(entry.path, url ? `${url.pathname}${url.search}` : item.url); entry.path.title = item.url;
      const previous = index ? cards.get(filtered[index - 1].url).card : null;
      if (!entry.card.isConnected || entry.card.previousElementSibling !== previous) {
        if (previous) previous.after(entry.card); else $("mediaList").prepend(entry.card);
      }
    });
    syncSourceJobs();
  }
  function renderFrames(frames) {
    currentFrames = frames.filter(frame => /^data:image\/(jpeg|png|webp);base64,/i.test(frame.dataUrl || "")).slice(-10);
    $("framesSection").hidden = !currentMedia.length;
    const signature = JSON.stringify(currentFrames.map(frame => [frame.timeStr, frame.timestamp, frame.dataUrl]));
    if (signature === framesSignature) return;
    framesSignature = signature;
    setText($("framesCount"), currentFrames.length ? `${currentFrames.length} 帧` : "");
    $("framesHint").hidden = !!currentFrames.length;
    $("framesList").replaceChildren(...currentFrames.map(frame => {
      const button = node("button", "frame-card"); button.title = `预览 ${frame.timeStr || "当前"} 的画面`;
      const img = node("img", "frame-img"); img.src = frame.dataUrl; img.alt = `视频画面 ${frame.timeStr || ""}`;
      button.append(img, node("span", "frame-time-tag", frame.timeStr || "当前"));
      button.addEventListener("click", () => {
        activeModalData = frame; $("modalImg").src = frame.dataUrl;
        setText($("modalTimeTag"), `画面预览 · ${frame.timeStr || "当前"}`);
        openModal("imageModal", button, "modalClose");
      });
      return button;
    }));
  }

  function createJobCard(job) {
    const card = node("article", "job-card"), header = node("div", "job-header"), title = node("h2", "job-title"), label = node("span", "job-state");
    header.append(title, label);
    const progress = node("div", "job-progress"), fill = node("div", "job-progress-fill");
    progress.setAttribute("role", "progressbar"); progress.setAttribute("aria-label", "视频下载进度"); progress.setAttribute("aria-valuemin", "0"); progress.setAttribute("aria-valuemax", "100"); progress.append(fill);
    const details = node("div", "job-details"), metrics = node("span", "job-metrics"), percent = node("span", "job-percent"); details.append(metrics, percent);
    const error = node("p", "job-error"), actions = node("div", "job-actions"), cancel = node("button", "job-button", "取消"), retry = node("button", "job-button", "重新下载"), reveal = node("button", "job-button", "在文件夹中显示");
    actions.append(cancel, retry, reveal); card.append(header, progress, details, error, actions);
    const entry = { card, title, label, progress, fill, metrics, percent, error, cancel, retry, reveal, job };
    cancel.addEventListener("click", () => jobAction("cancelJob", entry, cancel));
    reveal.addEventListener("click", () => jobAction("showJob", entry, reveal));
    retry.addEventListener("click", () => startDownload(entry.job, retry));
    return entry;
  }
  async function jobAction(action, entry, button) {
    button.disabled = true;
    try { await sendMessage({ action, jobId: entry.job.id }); if (action !== "showJob") await loadJobs(); }
    catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }
  function renderJobs() {
    const jobs = currentJobs.slice(0, 20), active = currentJobs.filter(job => activeStates.has(job.state)).length;
    setText($("jobsTabCount"), active || currentJobs.length);
    $("jobsTabCount").dataset.active = String(active > 0);
    const live = new Set(jobs.map(job => job.id));
    for (const [id, entry] of jobCards) if (!live.has(id)) { entry.card.remove(); jobCards.delete(id); }
    if (!jobs.length) {
      emptyState($("jobList"), "喜欢的视频，正在等你", "在“视频来源”里点击下载。这里会保留近期任务，随时查看进度。");
      syncSourceJobs(); return;
    }
    $("jobList").querySelector(".empty-box")?.remove();
    jobs.forEach((job, index) => {
      const entry = jobCards.get(job.id) || createJobCard(job); jobCards.set(job.id, entry); entry.job = job;
      entry.card.dataset.state = job.state;
      setText(entry.title, String(job.filename || job.title || "视频").split(/[\\/]/).pop()); entry.title.title = job.filename || job.title || "视频";
      setText(entry.label, stateLabels[job.state] || "处理中");
      const hasTotal = job.totalSegments > 0 || job.totalBytes > 0;
      const ratio = job.totalSegments > 0 ? (job.completedSegments || 0) / job.totalSegments : job.totalBytes > 0 ? (job.bytesReceived || 0) / job.totalBytes : 0;
      // Downloaded bytes/segments reaching 100% still means "saving", never "saved".
      const value = job.state === "complete" ? 100 : Math.max(0, Math.min(100, Math.floor(ratio * 100)));
      entry.fill.style.width = `${value}%`;
      entry.progress.dataset.indeterminate = String(!hasTotal && activeStates.has(job.state));
      if (hasTotal || job.state === "complete") entry.progress.setAttribute("aria-valuenow", value); else entry.progress.removeAttribute("aria-valuenow");
      entry.progress.setAttribute("aria-valuetext", `${stateLabels[job.state] || "处理中"}${hasTotal ? ` ${value}%` : ""}`);
      const segments = job.totalSegments > 0 ? `${job.completedSegments || 0} / ${job.totalSegments} 片 · ` : "";
      setText(entry.metrics, `${segments}${formatSize(job.bytesReceived || 0)}${!job.totalSegments && job.totalBytes > 0 ? ` / ${formatSize(job.totalBytes)}` : ""}`);
      setText(entry.percent, hasTotal || job.state === "complete" ? `${value}%` : "");
      const issue = [job.error, job.cleanupError].filter(Boolean).join(" · ");
      entry.error.hidden = !issue; setText(entry.error, issue);
      entry.cancel.hidden = !activeStates.has(job.state);
      entry.retry.hidden = !["interrupted", "cancelled"].includes(job.state);
      entry.reveal.hidden = job.state !== "complete";
      const previous = index ? jobCards.get(jobs[index - 1].id).card : null;
      if (!entry.card.isConnected || entry.card.previousElementSibling !== previous) {
        if (previous) previous.after(entry.card); else $("jobList").prepend(entry.card);
      }
    });
    syncSourceJobs();
  }
  async function loadJobs() {
    if (closing) return;
    if (jobsLoading) { jobsPending = true; return; }
    jobsLoading = true;
    try {
      const response = await sendMessage({ action: "getJobs" });
      currentJobs = Array.isArray(response.jobs) ? response.jobs : [];
      $("jobsStatus").hidden = true; renderJobs();
    } catch (error) {
      $("jobsStatus").hidden = false; setText($("jobsStatus"), `暂时无法读取任务：${error.message}`);
    } finally {
      jobsLoading = false;
      if (jobsPending && !closing) { jobsPending = false; queueMicrotask(loadJobs); }
    }
  }
  async function loadMediaData() {
    if (!currentTab || !mediaUrl(currentTab.url) || closing) return;
    if (mediaLoading) { mediaPending = true; return; }
    mediaLoading = true;
    try {
      const response = await sendMessage({ action: "getMedia", tabId: currentTab.id });
      currentMedia = (response.media || []).filter(item => mediaUrl(item.url));
      const title = response.pageTitle && response.pageTitle !== "当前网页" ? response.pageTitle : currentTab.title || currentTab.url || "当前网页";
      setText($("pageTitle"), title); $("pageTitle").title = title;
      setStatus(currentMedia.length ? `已发现 ${currentMedia.length} 个视频来源` : response.chunkCount ? "检测到分段请求，等待播放清单" : "等待视频播放", currentMedia.length ? "ready" : "waiting");
      renderMedia(); renderFrames(response.frames || []);
    } catch (error) {
      setStatus("读取失败，点击右侧刷新重试", "error");
      if (!currentMedia.length) emptyState($("mediaList"), "暂时无法连接扩展", "刷新扩展后，请重新打开视频网页。", error.message);
    } finally {
      mediaLoading = false;
      if (mediaPending && !closing) { mediaPending = false; queueMicrotask(loadMediaData); }
    }
  }

  function applySettings(value) {
    settings = { subfolder: String(value?.subfolder || ""), askWhereToSave: Boolean(value?.askWhereToSave) };
    setText($("saveLocation"), settings.askWhereToSave ? "每次询问保存位置" : settings.subfolder ? `保存至默认目录 / ${settings.subfolder}` : "保存至 Chrome 默认下载文件夹");
    $("btnSaveLocation").title = $("saveLocation").textContent;
  }
  async function loadSettings() {
    const response = await sendMessage({ action: "getSettings" }); applySettings(response.settings); return settings;
  }
  function folderPreview() { setText($("folderPreview"), `默认下载文件夹${$("subfolder").value.trim() ? ` / ${$("subfolder").value.trim().replace(/\\/g, "/")}` : ""}`); }
  function openModal(id, trigger, focusId) { modalTrigger = trigger; $(id).hidden = false; $("appContent").inert = true; $(focusId).focus(); }
  function closeModal(id) { $(id).hidden = true; $("appContent").inert = false; if (modalTrigger?.isConnected) modalTrigger.focus(); else $("sourceTab").focus(); }
  async function openSettings(trigger) {
    $("settingsError").hidden = true; $("settingsSave").disabled = true; $("subfolder").disabled = true; $("askWhereToSave").disabled = true;
    $("subfolder").value = settings.subfolder; $("askWhereToSave").checked = settings.askWhereToSave; folderPreview();
    openModal("settingsModal", trigger, "settingsClose");
    try {
      await loadSettings(); $("subfolder").value = settings.subfolder; $("askWhereToSave").checked = settings.askWhereToSave; folderPreview();
    } catch (error) { $("settingsError").hidden = false; setText($("settingsError"), error.message); }
    finally { $("settingsSave").disabled = false; $("subfolder").disabled = false; $("askWhereToSave").disabled = false; }
  }
  for (const id of ["btnSettings", "btnSaveLocation"]) $(id).addEventListener("click", () => openSettings($(id)));
  for (const id of ["settingsClose", "settingsCancel"]) $(id).addEventListener("click", () => closeModal("settingsModal"));
  $("modalClose").addEventListener("click", () => closeModal("imageModal"));
  for (const id of ["imageModal", "settingsModal"]) $(id).addEventListener("click", event => { if (event.target === $(id)) closeModal(id); });
  $("subfolder").addEventListener("input", folderPreview);
  $("settingsForm").addEventListener("submit", async event => {
    event.preventDefault(); $("settingsSave").disabled = true; $("settingsError").hidden = true;
    try {
      const response = await sendMessage({ action: "saveSettings", settings: { subfolder: $("subfolder").value.trim(), askWhereToSave: $("askWhereToSave").checked } });
      applySettings(response.settings); closeModal("settingsModal"); showToast("下载设置已保存，将用于之后的下载和截图");
    } catch (error) { $("settingsError").hidden = false; setText($("settingsError"), error.message); }
    finally { $("settingsSave").disabled = false; }
  });
  $("btnChromeSettings").addEventListener("click", async () => {
    try { await sendMessage({ action: "openDownloadSettings" }); }
    catch (error) { showToast(error.message); }
  });
  document.addEventListener("keydown", event => {
    const modal = !$("settingsModal").hidden ? $("settingsModal") : !$("imageModal").hidden ? $("imageModal") : null;
    if (!modal) return;
    if (event.key === "Escape") { event.preventDefault(); closeModal(modal.id); }
    if (event.key === "Tab") {
      const focusable = [...modal.querySelectorAll("button:not([disabled]), input:not([disabled])")].filter(element => !element.hidden);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  $("btnSaveFrame").addEventListener("click", async () => {
    if (!activeModalData) return;
    $("btnSaveFrame").disabled = true;
    try {
      const currentSettings = await loadSettings();
      const basename = `${safeFilename(currentTab?.title)}_${safeFilename(activeModalData.timeStr)}.jpg`;
      const filename = `${currentSettings.subfolder ? `${currentSettings.subfolder}/` : ""}${basename}`;
      await chrome.downloads.download({ url: activeModalData.dataUrl, filename, saveAs: currentSettings.askWhereToSave });
      showToast("截图已交给 Chrome 保存，请查看下载记录"); closeModal("imageModal");
    } catch (error) { showToast(`截图未保存：${error.message}`); }
    finally { $("btnSaveFrame").disabled = false; }
  });
  $("btnSnap").addEventListener("click", () => {
    if (!currentTab) return;
    const button = $("btnSnap"); button.disabled = true; setText(button, "抓拍中…");
    chrome.tabs.sendMessage(currentTab.id, { action: "captureCurrentFrameNow" }, response => {
      const error = chrome.runtime.lastError;
      button.disabled = false; setText(button, "抓拍一帧");
      if (!error && response?.success) { showToast(`已抓拍 ${response.frame?.timeStr || "当前画面"}`); loadMediaData(); }
      else showToast("暂时无法抓拍：请播放视频；跨域画面可能不允许截图");
    });
  });
  $("mediaSearch").addEventListener("input", renderMedia);
  $("btnRefresh").addEventListener("click", () => { setStatus("正在重新读取…", "loading"); loadMediaData(); });
  const onMessage = message => {
    if ((message.action === "mediaListUpdated" || message.action === "framesUpdated") && message.tabId === currentTab?.id) loadMediaData();
    if (message.action === "jobsUpdated") loadJobs();
  };
  chrome.runtime.onMessage.addListener(onMessage);
  // Global jobs/settings stay available even when the selected tab is Chrome's own UI.
  await Promise.allSettled([loadJobs(), loadSettings()]);
  if (currentJobs.some(job => activeStates.has(job.state))) showPane("jobs");
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); currentTab = tabs[0] || null;
    setText($("pageTitle"), currentTab?.title || currentTab?.url || "未选择视频网页");
    if (!currentTab || !mediaUrl(currentTab.url)) {
      setStatus("请切换到视频网页", "waiting");
      emptyState($("mediaList"), "这里还没有视频", "打开一个视频网页并播放。下载任务仍可在右侧页签查看。");
      if (currentJobs.length) showPane("jobs");
    } else await loadMediaData();
  } catch (error) { setStatus(error.message, "error"); emptyState($("mediaList"), "无法读取当前网页", "已有下载不受影响，请查看下载任务。", error.message); }
  refreshTimer = setInterval(() => { if (!document.hidden) { loadMediaData(); loadJobs(); } }, 2000);
  window.addEventListener("unload", () => { closing = true; clearInterval(refreshTimer); clearTimeout(toastTimer); chrome.runtime.onMessage.removeListener(onMessage); });
});
