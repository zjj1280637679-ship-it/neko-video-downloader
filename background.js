// 喵喵视频下载姬 — MV3 media capture. Downloads belong to the trusted manager.
if (typeof importScripts === 'function') importScripts('download-manager.js');
const SESSION_KEYS = {
  media: "neko_tabMedia", titles: "neko_tabTitles", frames: "neko_tabFrames",
  chunks: "neko_tabChunks", playback: "neko_tabPlayback"
};
let tabMediaMap = new Map();
let tabTitleMap = new Map();
let tabFramesMap = new Map();
let tabChunkCountMap = new Map();
let tabPlaybackMap = new Map();
const retiredDocuments = new Map();
const frameParents = new Map();
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
  tabPlaybackMap = restore(SESSION_KEYS.playback);
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
      [SESSION_KEYS.chunks]: [...tabChunkCountMap], [SESSION_KEYS.playback]: [...tabPlaybackMap]
    };
    saveChain = saveChain.then(() => chrome.storage.session.set(snapshot))
      .catch(error => console.warn("Neko session save:", error.message));
  }, 150);
}
function notify(message) { chrome.runtime.sendMessage(message).catch(() => {}); }
function validTab(tabId) { return Number.isInteger(tabId) && tabId >= 0; }
function validFrame(frameId) { return Number.isInteger(frameId) && frameId >= 0; }
function documentKey(message, sender) {
  const token = typeof message.documentToken === "string" ? message.documentToken.slice(0, 100) : "";
  return typeof sender.documentId === "string" && sender.documentId ? `${sender.documentId}:${token}` : token;
}
function retireDocument(tabId, frameId, state) {
  if (!state?.documentKey) return;
  const key = `${tabId}:${frameId}`;
  let retired = retiredDocuments.get(key);
  if (!retired) retiredDocuments.set(key, retired = new Set());
  retired.add(state.documentKey);
  if (retired.size > 40) retired.delete(retired.values().next().value);
}
function isStaleDocument(tabId, frameId, message, sender) {
  const key = documentKey(message, sender);
  if (!key) return false;
  if (retiredDocuments.get(`${tabId}:${frameId}`)?.has(key)) return true;
  const previous = tabPlaybackMap.get(tabId)?.[frameId];
  if (!previous) return false;
  if (previous.documentKey === key) return Number.isInteger(message.generation) && message.generation < previous.generation;
  return Number.isFinite(message.documentStartedAt) && message.documentStartedAt < previous.documentStartedAt;
}
function reportPlayback(tabId, frameId, message, sender) {
  const key = documentKey(message, sender);
  if (!key || !Number.isFinite(message.documentStartedAt) || message.documentStartedAt <= 0 ||
      !Number.isSafeInteger(message.generation) || message.generation < 0 || isStaleDocument(tabId, frameId, message, sender)) return;
  if (message.inactive === true) {
    if (frameId === 0) clearTab(tabId);
    else clearFrame(tabId, frameId);
    retireDocument(tabId, frameId, { documentKey: key });
    return;
  }
  let frames = tabPlaybackMap.get(tabId);
  if (!frames) tabPlaybackMap.set(tabId, frames = {});
  const previous = frames[frameId];
  const sameSource = previous?.documentKey === key && previous.generation === message.generation;
  const count = value => Number.isInteger(value) && value >= 0 ? Math.min(value, 1000) : 0;
  const videoCount = count(message.videoCount);
  const hasPlayed = videoCount > 0 && message.hasPlayed === true;
  const next = {
    documentKey: key, documentStartedAt: message.documentStartedAt, generation: message.generation,
    videoCount, iframeCount: count(message.iframeCount), hasPlayed,
    playing: hasPlayed && message.playing === true,
    observedAt: hasPlayed ? (sameSource && previous.hasPlayed ? previous.observedAt : Date.now()) : null
  };
  if (previous && Object.keys(next).every(field => next[field] === previous[field])) return;
  if (previous && previous.documentKey !== key) retireDocument(tabId, frameId, previous);
  frames[frameId] = next;
  scheduleSave(); notify({ action: "mediaListUpdated", tabId });
}
function captureStatus(tabId, media) {
  const byFrame = tabPlaybackMap.get(tabId) || {};
  const frames = Object.values(byFrame);
  const observedFrames = frames.filter(frame => frame.hasPlayed);
  const videoCount = frames.reduce((total, frame) => total + frame.videoCount, 0);
  // Cross-origin/blank frames may not have a content script. Their absence is
  // uncertainty, not evidence that this page contains no player.
  const uncertain = !byFrame[0] || frames.length - 1 < frames.reduce((total, frame) => total + frame.iframeCount, 0);
  const observedAt = observedFrames.length ? Math.min(...observedFrames.map(frame => frame.observedAt)) : null;
  const playback = {
    observed: observedFrames.length > 0, hasVideo: videoCount > 0, playing: frames.some(frame => frame.playing),
    videoCount, observedAt, frameCount: frames.length, uncertain
  };
  const capturePhase = media.length ? "found" : playback.observed
    ? Date.now() - observedAt >= 10000 ? "no-source" : "sniffing"
    : playback.hasVideo ? "waiting" : !frames.length || uncertain ? "checking" : "no-video";
  return { playback, capturePhase };
}
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
  for (const [frameId, state] of Object.entries(tabPlaybackMap.get(tabId) || {})) retireDocument(tabId, frameId, state);
  tabMediaMap.delete(tabId); tabTitleMap.delete(tabId); tabFramesMap.delete(tabId);
  tabChunkCountMap.delete(tabId); chunkUrls.delete(tabId);
  tabPlaybackMap.delete(tabId); frameParents.delete(tabId);
  updateBadge(tabId); scheduleSave(); notify({ action: "mediaListUpdated", tabId });
}
function clearFrame(tabId, frameId) {
  const removed = new Set([frameId]);
  const parents = frameParents.get(tabId) || {};
  let expanded;
  do {
    expanded = false;
    for (const [child, parent] of Object.entries(parents)) if (removed.has(parent) && !removed.has(Number(child))) {
      removed.add(Number(child)); expanded = true;
    }
  } while (expanded);
  const frames = tabPlaybackMap.get(tabId) || {};
  for (const id of removed) {
    retireDocument(tabId, id, frames[id]); delete frames[id]; delete parents[id];
  }
  const media = tabMediaMap.get(tabId);
  if (media) tabMediaMap.set(tabId, media.filter(item => !removed.has(item.frameId)));
  // Existing preview frames cannot safely be attributed to the replacement
  // document. Clear them while leaving unrelated frame sources available.
  tabFramesMap.delete(tabId);
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
  } else if (details.type === "sub_frame" && validFrame(details.frameId)) {
    enqueue(() => {
      clearFrame(details.tabId, details.frameId);
      let parents = frameParents.get(details.tabId);
      if (!parents) frameParents.set(details.tabId, parents = {});
      if (validFrame(details.parentFrameId)) parents[details.frameId] = details.parentFrameId;
    });
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== "string") return;
  const supported = ["reportMasterStream", "reportDOMVideo", "reportVideoFrames", "reportPageTitle", "reportPlaybackState", "getMedia"];
  if (!supported.includes(message.action)) return;
  const tabId = message.action === "getMedia" ? sender.tab?.id ?? message.tabId : sender.tab?.id;
  enqueue(async () => {
    if (message.action !== "getMedia" && (!validTab(tabId) || !validFrame(sender.frameId) ||
        isStaleDocument(tabId, sender.frameId, message, sender))) return { status: "ignored" };
    if (message.action === "reportPlaybackState") {
      reportPlayback(tabId, sender.frameId, message, sender);
      return { status: "ok" };
    }
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
      return { media: list, pageTitle: tabTitleMap.get(tabId) || "当前网页", frames, chunkCount, ...captureStatus(tabId, list) };
    }
    return { status: "ignored" };
  }).then(result => { if (result !== undefined) sendResponse(result); })
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title) enqueue(() => { tabTitleMap.set(tabId, changeInfo.title); scheduleSave(); });
});
chrome.tabs.onRemoved.addListener(tabId => enqueue(() => {
  clearTab(tabId);
  for (const key of retiredDocuments.keys()) if (key.startsWith(`${tabId}:`)) retiredDocuments.delete(key);
}));
