// 喵喵视频下载姬 — MV3 media capture and download state.
const SESSION_KEYS = {
  media: "neko_tabMedia", titles: "neko_tabTitles", frames: "neko_tabFrames",
  chunks: "neko_tabChunks", downloads: "neko_downloads"
};
let tabMediaMap = new Map();
let tabTitleMap = new Map();
let tabFramesMap = new Map();
let tabChunkCountMap = new Map();
let downloadMap = new Map();
const chunkUrls = new Map();
const MAX_MEDIA = 60;
let saveTimer;
let saveChain = Promise.resolve();

// Mutations wait for hydration so a cold worker cannot overwrite new captures.
const restorePromise = chrome.storage.session.get(Object.values(SESSION_KEYS)).then(data => {
  const restore = key => new Map(Array.isArray(data[key]) ? data[key] : []);
  tabMediaMap = restore(SESSION_KEYS.media);
  tabTitleMap = restore(SESSION_KEYS.titles);
  tabFramesMap = restore(SESSION_KEYS.frames);
  tabChunkCountMap = restore(SESSION_KEYS.chunks);
  downloadMap = restore(SESSION_KEYS.downloads);
}).catch(error => console.warn("Neko session restore:", error.message));
let eventQueue = restorePromise;
function enqueue(action) {
  const result = eventQueue.then(action);
  eventQueue = result.catch(error => console.warn("Neko capture:", error.message));
  return result;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Store frames once per tab, not once per alternate stream.
    const snapshot = {
      [SESSION_KEYS.media]: [...tabMediaMap].map(([id, list]) => [id, list.map(({ frames, ...item }) => item)]),
      [SESSION_KEYS.titles]: [...tabTitleMap], [SESSION_KEYS.frames]: [...tabFramesMap],
      [SESSION_KEYS.chunks]: [...tabChunkCountMap], [SESSION_KEYS.downloads]: [...downloadMap]
    };
    saveChain = saveChain.then(() => chrome.storage.session.set(snapshot))
      .catch(error => console.warn("Neko session save:", error.message));
  }, 150);
}
function notify(message) { chrome.runtime.sendMessage(message).catch(() => {}); }
function validTab(tabId) { return Number.isInteger(tabId) && tabId >= 0; }
function mediaUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
function isPlaylist(url, mime = "") { return /\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(mime); }
function isFragmentUrl(url, contentType = "") {
  if (isPlaylist(url, contentType)) return false;
  return /mp2t|iso\.segment/i.test(contentType) || /\.(?:ts|m4s|m4v_frag|f4f)(?:$|[?#])/i.test(url);
}
function sanitizeFilename(name) {
  return String(name || "视频").replace(/[\x00-\x1f\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, 100) || "视频";
}
function firstStreamItem(list) { return list?.find(item => item.active) || list?.find(item => item.isM3U8) || list?.[0]; }
function updateBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: String(tabMediaMap.get(tabId)?.length || "") }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#DC7091" }).catch(() => {});
}
function clearTab(tabId) {
  tabMediaMap.delete(tabId); tabTitleMap.delete(tabId); tabFramesMap.delete(tabId);
  tabChunkCountMap.delete(tabId); chunkUrls.delete(tabId);
  updateBadge(tabId); scheduleSave(); notify({ action: "mediaListUpdated", tabId });
}
function addMediaItem(tabId, item) {
  const url = mediaUrl(item.url);
  if (!validTab(tabId) || !url) return;
  const mime = String(item.mime || "").toLowerCase();
  if (isFragmentUrl(url, mime)) {
    let seen = chunkUrls.get(tabId);
    if (!seen) chunkUrls.set(tabId, seen = new Set());
    if (seen.has(url)) return;
    seen.add(url);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    tabChunkCountMap.set(tabId, (tabChunkCountMap.get(tabId) || 0) + 1);
    scheduleSave(); return;
  }
  const isM3U8 = isPlaylist(url, mime);
  const size = isM3U8 ? 0 : Math.max(0, Number(item.size) || 0);
  let list = tabMediaMap.get(tabId);
  if (!list) tabMediaMap.set(tabId, list = []);
  const existing = list.find(entry => entry.url === url);
  if (existing) {
    let changed = false;
    if (item.active) {
      for (const entry of list) entry.active = entry === existing;
      existing.timestamp = Date.now();
      list.splice(list.indexOf(existing), 1); list.unshift(existing);
      changed = true;
    }
    for (const [key, value] of Object.entries({ size, mime, name: item.name, pageUrl: item.pageUrl })) {
      if (value && existing[key] !== value && (key !== "size" || value > existing.size)) {
        existing[key] = value; changed = true;
      }
    }
    if (changed) { scheduleSave(); notify({ action: "mediaListUpdated", tabId }); }
    return;
  }
  const ext = isM3U8 ? "m3u8" : (/\.(mp4|webm|flv|mov|mkv|m4v|mp3|m4a|aac|ogg)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase()
    || (mime.includes("webm") ? "webm" : mime.startsWith("audio/") ? "m4a" : "mp4"));
  const pageTitle = item.customTitle || tabTitleMap.get(tabId) || "视频";
  const media = {
    id: `${tabId}_${crypto.randomUUID()}`, url, mime: mime || (isM3U8 ? "application/vnd.apple.mpegurl" : "video/mp4"),
    size, isM3U8, ext, suggestedFilename: `${sanitizeFilename(pageTitle)}.${ext}`,
    name: String(item.name || "").slice(0, 80), source: item.source || "network",
    frameId: item.frameId ?? 0, pageUrl: item.pageUrl || "", active: Boolean(item.active), timestamp: Date.now()
  };
  if (item.active) for (const entry of list) entry.active = false;
  if (isM3U8) list.splice(!item.active && list[0]?.active ? 1 : 0, 0, media);
  else list.splice(list.filter(entry => entry.isM3U8).length, 0, media);
  if (list.length > MAX_MEDIA) list.length = MAX_MEDIA;
  updateBadge(tabId); scheduleSave(); notify({ action: "mediaListUpdated", tabId });
}
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (!validTab(details.tabId)) return;
  if (details.type === "main_frame") {
    // Reset before new media requests, including same-URL reloads.
    enqueue(() => clearTab(details.tabId));
  } else if (isPlaylist(details.url)) {
    enqueue(() => addMediaItem(details.tabId, {
      url: details.url, mime: "application/vnd.apple.mpegurl", frameId: details.frameId,
      pageUrl: details.documentUrl || details.initiator || ""
    }));
  }
}, { urls: ["<all_urls>"] });
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (!validTab(details.tabId) || details.statusCode >= 400 || (details.statusCode >= 300 && details.statusCode !== 304)) return;
  const headers = Object.fromEntries((details.responseHeaders || []).map(header => [header.name.toLowerCase(), header.value || ""]));
  const mime = headers["content-type"] || "";
  if (!/^(?:video|audio)\//i.test(mime) && !isPlaylist(details.url, mime) && !isFragmentUrl(details.url, mime)) return;
  // Content-Length on a 206 response is only the current byte range.
  const total = /\/([0-9]+)$/.exec(headers["content-range"] || "")?.[1];
  enqueue(() => addMediaItem(details.tabId, {
    url: details.url, mime, size: Number(total || headers["content-length"]) || 0,
    frameId: details.frameId, pageUrl: details.documentUrl || details.initiator || ""
  }));
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);
function downloadSnapshot(item, previous = {}) {
  return {
    ...previous, downloadId: item.id, state: item.state, error: item.error || "",
    filename: item.filename || previous.filename || "", bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || 0, url: previous.url || item.finalUrl || item.url || ""
  };
}
async function refreshDownload(downloadId) {
  const previous = downloadMap.get(downloadId);
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item) return previous || null;
  const status = downloadSnapshot(item, previous);
  if (previous) { downloadMap.set(downloadId, status); scheduleSave(); }
  return status;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== "string") return;
  const supported = ["reportMasterStream", "reportDOMVideo", "reportVideoFrames", "reportPageTitle", "getMedia", "download", "getDownloadStatus"];
  if (!supported.includes(message.action)) return;
  const tabId = sender.tab?.id ?? message.tabId;
  enqueue(async () => {
    if (["reportMasterStream", "reportDOMVideo"].includes(message.action)) {
      const title = tabTitleMap.get(tabId) || message.title;
      addMediaItem(tabId, {
        url: message.url, mime: message.mime || (message.action === "reportMasterStream" ? "application/vnd.apple.mpegurl" : ""),
        customTitle: message.name ? `${title || "视频"}_${message.name}` : title,
        name: message.name, active: message.active, source: "dom", frameId: sender.frameId, pageUrl: sender.tab?.url || sender.url
      });
      return { status: "ok" };
    }
    if (message.action === "reportVideoFrames" && validTab(tabId)) {
      const frames = (Array.isArray(message.frames) ? message.frames : []).filter(frame =>
        typeof frame.dataUrl === "string" && frame.dataUrl.startsWith("data:image/jpeg;base64,") &&
        frame.dataUrl.length <= 100000 && Number.isFinite(frame.seconds)).slice(-10);
      tabFramesMap.set(tabId, frames); scheduleSave();
      notify({ action: "framesUpdated", tabId, frames }); return { status: "ok" };
    }
    if (message.action === "reportPageTitle" && validTab(tabId)) {
      if (!sender.frameId && message.title) tabTitleMap.set(tabId, String(message.title).slice(0, 300));
      scheduleSave(); return { status: "ok" };
    }
    if (message.action === "getMedia") {
      const frames = tabFramesMap.get(tabId) || [];
      const chunkCount = tabChunkCountMap.get(tabId) || 0;
      const list = (tabMediaMap.get(tabId) || []).map(item => ({ ...item, frames: [] }));
      const target = firstStreamItem(list);
      if (target) { target.frames = frames; target.chunkCount = chunkCount; }
      const downloads = [...downloadMap.values()].filter(item => item.tabId === tabId).slice(-10);
      return { media: list, pageTitle: tabTitleMap.get(tabId) || "当前网页", frames, chunkCount, downloads };
    }
    if (message.action === "getDownloadStatus") return await refreshDownload(Number(message.downloadId));
    if (message.action === "download") {
      const url = mediaUrl(message.url);
      if (!url) return { success: false, error: "此地址不是可下载的 HTTP/HTTPS 媒体链接" };
      if (isPlaylist(url)) return { success: false, error: "HLS 播放列表需要通过合并下载器保存" };
      const filename = sanitizeFilename(message.filename || "视频.mp4");
      // Keep capture responsive while Chrome's Save As dialog is open.
      chrome.downloads.download({ url, filename, saveAs: true }, async downloadId => {
        if (chrome.runtime.lastError || !Number.isInteger(downloadId)) {
          sendResponse({ success: false, error: chrome.runtime.lastError?.message || "下载未启动" }); return;
        }
        downloadMap.set(downloadId, { downloadId, tabId, url, filename, state: "in_progress", bytesReceived: 0, totalBytes: 0, error: "" });
        if (downloadMap.size > 40) downloadMap.delete(downloadMap.keys().next().value);
        scheduleSave(); sendResponse({ success: true, downloadId, state: "in_progress" });
        try { notify({ action: "downloadStatusUpdated", ...await refreshDownload(downloadId) }); } catch {}
      });
      return undefined;
    }
    return { status: "ignored" };
  }).then(result => { if (result !== undefined) sendResponse(result); })
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state && !delta.error && !delta.filename) return;
  enqueue(async () => {
    if (!downloadMap.has(delta.id)) return;
    const status = await refreshDownload(delta.id);
    if (status) notify({ action: "downloadStatusUpdated", ...status });
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title) enqueue(() => { tabTitleMap.set(tabId, changeInfo.title); scheduleSave(); });
});
chrome.tabs.onRemoved.addListener(tabId => enqueue(() => clearTab(tabId)));
