// Render untrusted page metadata as text. Preserve cards and focus between updates.
document.addEventListener("DOMContentLoaded", async () => {
  const $ = id => document.getElementById(id);
  const cards = new Map(), downloadStates = new Map();
  let currentTab, currentMedia = [], currentFrames = [], activeModalData, modalTrigger;
  let loading = false, refreshPending = false, refreshTimer, toastTimer, framesSignature = "";

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function showToast(message) {
    clearTimeout(toastTimer); $("toast").textContent = message; $("toast").classList.add("show");
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3500);
  }
  function setStatus(message, state = "ready") {
    $("statusText").textContent = message; $("statusBar").dataset.state = state;
  }
  function formatSize(bytes) {
    if (!(bytes > 0)) return "大小待确认";
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  function safeFilename(name) {
    return (String(name || "视频").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 120) || "视频");
  }
  function mediaUrl(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; }
  }
  function sendMessage(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response) reject(new Error("扩展后台未响应"));
      else resolve(response);
    }));
  }
  function renderEmpty(title, description, hint = "") {
    const existing = $("mediaList").querySelector(".empty-box");
    const signature = JSON.stringify([title, description, hint]);
    if (existing?.dataset.signature === signature) return;
    const empty = node("div", "empty-box"); empty.dataset.signature = signature;
    empty.append(node("p", "empty-cat", "(=^･ω･^=)"), node("p", "empty-title", title), node("p", "empty-desc", description));
    if (hint) empty.append(node("p", "empty-hint", hint));
    $("mediaList").replaceChildren(empty);
  }

  async function handleDownload(item, button, status) {
    if (!mediaUrl(item.url)) return showToast("该来源不是可下载的 HTTP 视频地址");
    button.disabled = true;
    try {
      if (item.isM3U8) {
        const query = new URLSearchParams({ url: item.url, title: String(item.suggestedFilename || currentTab.title || "视频").replace(/\.m3u8$/i, ""), tabId: String(currentTab.id) });
        await chrome.tabs.create({ url: `${chrome.runtime.getURL("downloader.html")}?${query}` });
        showToast("已打开下载工作台，确认来源后开始保存");
      } else {
        const response = await sendMessage({ action: "download", url: item.url, filename: safeFilename(item.suggestedFilename), tabId: currentTab.id });
        if (!response.success) throw new Error(response.error || "无法创建下载任务");
        downloadStates.set(response.downloadId, { url: item.url, filename: item.suggestedFilename, state: "in_progress", downloadId: response.downloadId });
        status.dataset.state = "in_progress"; status.textContent = "已开始下载 · 可在 Chrome 下载记录中查看";
        showToast("下载任务已开始，完成状态以 Chrome 下载记录为准");
      }
    } catch (error) { status.dataset.state = "interrupted"; status.textContent = `下载失败：${error.message}`; showToast(status.textContent); }
    finally { button.disabled = false; }
  }
  async function copyUrl(url) {
    try { await navigator.clipboard.writeText(url); showToast("视频来源链接已复制"); }
    catch { showToast("复制失败，请重新点击复制链接"); }
  }
  function createCard(item) {
    const card = node("article", "media-card"), header = node("div", "card-header"), identity = node("div");
    const badge = node("span", "badge-tag"), number = node("span", "source-number"), size = node("span", "media-size");
    identity.append(badge, number); header.append(identity, size);
    const title = node("h2", "file-name"), host = node("div", "source-host"), path = node("div", "url-preview"), note = node("p", "stream-note");
    const actions = node("div", "card-actions"), download = node("button", "btn btn-primary"), copy = node("button", "btn btn-secondary", "复制链接"), state = node("div", "card-state");
    actions.append(download, copy); card.append(header, title, host, path, note, actions, state);
    const entry = { card, badge, number, size, title, host, path, note, download, state, item };
    download.addEventListener("click", () => handleDownload(entry.item, download, state));
    copy.addEventListener("click", () => copyUrl(entry.item.url));
    return entry;
  }
  function renderMedia() {
    const query = $("mediaSearch").value.trim().toLocaleLowerCase();
    const filtered = currentMedia.filter(item => `${item.suggestedFilename || ""} ${item.name || ""} ${item.url}`.toLocaleLowerCase().includes(query));
    $("listToolbar").hidden = !currentMedia.length;
    $("sourceCount").textContent = query ? `${filtered.length} / ${currentMedia.length}` : `${currentMedia.length} 个来源`;
    const live = new Set(currentMedia.map(item => item.url));
    for (const [url, entry] of cards) if (!live.has(url)) { entry.card.remove(); cards.delete(url); }
    if (!filtered.length) {
      renderEmpty(currentMedia.length ? "没有匹配的来源" : "先让视频播放一会儿", currentMedia.length ? "试试文件名、集数，或视频来源域名。" : "在网页点击播放。出现来源后，选择需要的视频下载。", currentMedia.length ? "" : "仍未发现？刷新视频网页，再重新播放。");
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
      entry.badge.textContent = item.isM3U8 ? "HLS · M3U8" : String(item.ext || "VIDEO").toUpperCase();
      entry.number.textContent = item.active ? "当前播放" : `来源 ${currentMedia.indexOf(item) + 1}`;
      entry.card.dataset.active = String(Boolean(item.active));
      entry.size.textContent = item.isM3U8 ? "分段视频" : formatSize(item.size);
      entry.title.textContent = item.suggestedFilename || "未命名视频"; entry.title.title = entry.title.textContent;
      entry.host.textContent = `${url?.hostname || "未知来源"}${item.name ? ` · ${item.name}` : ""}`;
      entry.path.textContent = url ? `${url.pathname}${url.search}` : item.url; entry.path.title = item.url;
      entry.note.textContent = item.isM3U8 ? "打开工作台解析清单，按顺序合并保存。" : "直接交给 Chrome 下载，可在下载记录中查看。";
      entry.download.textContent = item.isM3U8 ? "↓ 合并下载" : "↓ 下载视频";
      // Only move cards when order changes; preserve focus and scroll during network updates.
      const previous = index ? cards.get(filtered[index - 1].url).card : null;
      if (!entry.card.isConnected || entry.card.previousElementSibling !== previous) {
        if (previous) previous.after(entry.card); else $("mediaList").prepend(entry.card);
      }
    });
  }
  function renderFrames(frames) {
    currentFrames = frames.filter(frame => /^data:image\/(jpeg|png|webp);base64,/i.test(frame.dataUrl || "")).slice(-10);
    $("framesSection").hidden = !currentMedia.length;
    const signature = JSON.stringify(currentFrames.map(frame => [frame.timeStr, frame.timestamp, frame.dataUrl]));
    if (signature === framesSignature) return;
    framesSignature = signature;
    $("framesCount").textContent = currentFrames.length ? `${currentFrames.length} 帧` : "";
    $("framesHint").hidden = !!currentFrames.length;
    $("framesList").replaceChildren(...currentFrames.map(frame => {
      const button = node("button", "frame-card"); button.title = `预览 ${frame.timeStr || "当前"} 的画面`;
      const img = node("img", "frame-img"); img.src = frame.dataUrl; img.alt = `视频画面 ${frame.timeStr || ""}`;
      button.append(img, node("span", "frame-time-tag", frame.timeStr || "当前"));
      button.addEventListener("click", () => {
        modalTrigger = button; activeModalData = frame; $("modalImg").src = frame.dataUrl;
        $("modalTimeTag").textContent = `画面预览 · ${frame.timeStr || "当前"}`;
        $("imageModal").hidden = false; $("modalClose").focus();
      });
      return button;
    }));
  }
  function renderDownloads(downloads) {
    const recent = downloads.slice(-3).reverse();
    $("downloadSection").hidden = !recent.length;
    $("downloadList").replaceChildren(...recent.map(download => {
      const row = node("div", "download-row"); row.dataset.state = download.state;
      const name = node("span", "download-name", String(download.filename || "视频下载").split(/[\\/]/).pop()); name.title = download.filename || "";
      const labels = { complete: "已保存", interrupted: "下载中断", in_progress: "下载中" };
      const state = node("span", "download-state", labels[download.state] || "处理中"); state.title = download.error || "";
      row.append(name, state); return row;
    }));
  }
  async function loadMediaData() {
    if (!currentTab) return;
    if (loading) { refreshPending = true; return; }
    loading = true;
    try {
      const response = await sendMessage({ action: "getMedia", tabId: currentTab.id });
      currentMedia = (response.media || []).filter(item => mediaUrl(item.url));
      const title = response.pageTitle && response.pageTitle !== "当前网页" ? response.pageTitle : currentTab.title || currentTab.url || "当前网页";
      $("pageTitle").textContent = title; $("pageTitle").title = title;
      setStatus(currentMedia.length ? `已发现 ${currentMedia.length} 个视频来源` : response.chunkCount ? "检测到分段请求，等待播放清单" : "等待视频播放", currentMedia.length ? "ready" : "waiting");
      renderMedia(); renderFrames(response.frames || []);
      if (Array.isArray(response.downloads)) renderDownloads(response.downloads);
    } catch (error) {
      setStatus("读取失败，点击右侧刷新重试", "error");
      if (!currentMedia.length) renderEmpty("暂时无法连接扩展", "刷新扩展后，请重新打开视频网页。", error.message);
    } finally {
      loading = false;
      if (refreshPending) { refreshPending = false; queueMicrotask(loadMediaData); }
    }
  }
  function closeModal() { $("imageModal").hidden = true; modalTrigger?.focus(); }
  $("modalClose").addEventListener("click", closeModal);
  $("imageModal").addEventListener("click", event => { if (event.target === $("imageModal")) closeModal(); });
  document.addEventListener("keydown", event => {
    if ($("imageModal").hidden) return;
    if (event.key === "Escape") closeModal();
    if (event.key === "Tab") {
      const first = $("modalClose"), last = $("btnSaveFrame");
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  $("btnSaveFrame").addEventListener("click", async () => {
    if (!activeModalData) return;
    try {
      await chrome.downloads.download({ url: activeModalData.dataUrl, filename: `${safeFilename(currentTab.title)}_${safeFilename(activeModalData.timeStr)}.jpg`, saveAs: true });
      showToast("截图已交给 Chrome 保存，请查看下载记录"); closeModal();
    } catch (error) { showToast(`截图未保存：${error.message}`); }
  });
  $("btnSnap").addEventListener("click", () => {
    if (!currentTab) return;
    const button = $("btnSnap"); button.disabled = true; button.textContent = "抓拍中…";
    chrome.tabs.sendMessage(currentTab.id, { action: "captureCurrentFrameNow" }, response => {
      const error = chrome.runtime.lastError;
      button.disabled = false; button.textContent = "抓拍一帧";
      if (!error && response?.success) { showToast(`已抓拍 ${response.frame?.timeStr || "当前画面"}`); loadMediaData(); }
      else showToast("暂时无法抓拍：请播放视频；跨域画面可能不允许截图");
    });
  });
  $("mediaSearch").addEventListener("input", renderMedia);
  $("btnRefresh").addEventListener("click", () => { setStatus("正在重新读取…", "loading"); loadMediaData(); });
  const onMessage = message => {
    if ((message.action === "mediaListUpdated" || message.action === "framesUpdated") && message.tabId === currentTab?.id) loadMediaData();
    if (message.action === "downloadStatusUpdated") {
      const download = downloadStates.get(message.downloadId);
      if (download) {
        Object.assign(download, message);
        const entry = cards.get(download.url);
        if (entry) {
          entry.state.dataset.state = message.state;
          entry.state.textContent = message.state === "complete" ? "✓ 文件已保存" : message.state === "interrupted" ? `下载中断：${message.error || "请重试"}` : "正在下载…";
        }
      }
      if (message.tabId === currentTab?.id || download) loadMediaData();
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0];
    if (!currentTab) throw new Error("未找到当前标签页");
    $("pageTitle").textContent = currentTab.title || currentTab.url || "当前网页";
    if (!/^https?:/i.test(currentTab.url || "")) {
      setStatus("请切换到视频网页", "waiting");
      renderEmpty("这里还没有视频", "打开一个 HTTP 或 HTTPS 视频网页，播放后再使用喵喵。"); return;
    }
    await loadMediaData();
    refreshTimer = setInterval(() => { if (!document.hidden) loadMediaData(); }, 2000);
  } catch (error) { setStatus(error.message, "error"); renderEmpty("无法读取当前网页", "请关闭弹窗并重新打开。", error.message); }
  window.addEventListener("unload", () => { clearInterval(refreshTimer); clearTimeout(toastTimer); chrome.runtime.onMessage.removeListener(onMessage); });
});
