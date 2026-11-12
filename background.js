// 喵喵视频下载姬 — MV3 media capture. Downloads belong to the trusted manager.
if (typeof importScripts === 'function') importScripts('domain/media.js', 'download-manager.js');
const mediaRules = globalThis.NekoMedia;
const SESSION_KEYS = {
  media: "neko_tabMedia", titles: "neko_tabTitles",
  chunks: "neko_tabChunks", playback: "neko_tabPlayback", documents: "neko_tabDocuments",
  retired: "neko_retiredDocuments", networkRetired: "neko_retiredNetworkDocuments", parents: "neko_frameParents",
  fragments: "neko_fragments"
};
let tabMediaMap = new Map();
let tabTitleMap = new Map();
let tabChunkCountMap = new Map();
let tabPlaybackMap = new Map();
let retiredDocuments = new Map();
let frameParents = new Map();
let tabDocuments = new Map();
let retiredNetworkDocuments = new Map();
let fragmentMediaMap = new Map();
const MAX_MEDIA = 60;
const mediaRefreshes = new Map();
let saveTimer;
let saveChain = Promise.resolve();

// Mutations wait for hydration so a cold worker cannot overwrite new captures.
const restorePromise = chrome.storage.session.get(Object.values(SESSION_KEYS)).then(async data => {
  const restore = key => new Map(Array.isArray(data[key]) ? data[key] : []);
  tabMediaMap = restore(SESSION_KEYS.media);
  const hasLegacyFrames = [...tabMediaMap.values()].some(list => list.some(item => Object.hasOwn(item, 'frames')));
  tabMediaMap = new Map([...tabMediaMap].map(([id, list]) => [id, list.map(({ frames, ...item }) => item)]));
  tabTitleMap = restore(SESSION_KEYS.titles);
  tabChunkCountMap = restore(SESSION_KEYS.chunks);
  tabPlaybackMap = restore(SESSION_KEYS.playback);
  tabDocuments = restore(SESSION_KEYS.documents);
  frameParents = restore(SESSION_KEYS.parents);
  retiredDocuments = new Map([...restore(SESSION_KEYS.retired)].map(([key, values]) => [key, new Set(values)]));
  retiredNetworkDocuments = new Map([...restore(SESSION_KEYS.networkRetired)].map(([key, values]) => [key, new Set(values)]));
  fragmentMediaMap = new Map([...restore(SESSION_KEYS.fragments)].map(([key, values]) => [key, new Map(values)]));
  // Older versions saved screenshots in both places. Remove those image bytes
  // without discarding media evidence or titles still used for filenames.
  const cleanup = await Promise.allSettled([
    chrome.storage.session.remove('neko_tabFrames'),
    hasLegacyFrames ? chrome.storage.session.set({ [SESSION_KEYS.media]: [...tabMediaMap] }) : undefined
  ]);
  for (const result of cleanup) if (result.status === 'rejected') console.warn("Neko preview cleanup:", result.reason.message);
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
    const snapshot = {
      [SESSION_KEYS.media]: [...tabMediaMap],
      [SESSION_KEYS.titles]: [...tabTitleMap],
      [SESSION_KEYS.chunks]: [...tabChunkCountMap], [SESSION_KEYS.playback]: [...tabPlaybackMap],
      [SESSION_KEYS.documents]: [...tabDocuments], [SESSION_KEYS.parents]: [...frameParents],
      [SESSION_KEYS.retired]: [...retiredDocuments].map(([key, values]) => [key, [...values]]),
      [SESSION_KEYS.networkRetired]: [...retiredNetworkDocuments].map(([key, values]) => [key, [...values]]),
      [SESSION_KEYS.fragments]: [...fragmentMediaMap].map(([key, values]) => [key, [...values]])
    };
    saveChain = saveChain.then(() => chrome.storage.session.set(snapshot))
      .catch(error => console.warn("Neko session save:", error.message));
  }, 150);
}
function notify(message) { chrome.runtime.sendMessage(message).catch(() => {}); }
function validTab(tabId) { return Number.isInteger(tabId) && tabId >= 0; }
function validFrame(frameId) { return Number.isInteger(frameId) && frameId >= 0; }
function mediaSnapshot(tabId) {
  const list = (tabMediaMap.get(tabId) || []).map(item => ({ ...item }));
  return { media: list, chunkCount: tabChunkCountMap.get(tabId) || 0, ...captureStatus(tabId, list) };
}
function invalidateRefresh(tabId) {
  const refresh = mediaRefreshes.get(tabId);
  if (refresh) refresh.invalidated = true;
}
function retireRefreshDocuments(tabId, refresh) {
  // A result belongs to the old page only when its browser documentId was
  // observed before navigation. An injection may instead land on the new page;
  // never erase that document merely because the older refresh was invalidated.
  const stale = (refresh.results || []).filter(result => typeof result.documentId === 'string' &&
    refresh.documents.has(result.documentId));
  if (!stale.length) return;
  const ids = new Set(stale.map(result => result.documentId));
  const frames = tabPlaybackMap.get(tabId) || {}, documents = tabDocuments.get(tabId) || {};
  for (const result of stale) {
    retireNetworkDocument(tabId, result.documentId);
    if (validFrame(result.frameId) && typeof result.result?.documentToken === 'string') {
      retireDocument(tabId, result.frameId, { documentKey: `${result.documentId}:${result.result.documentToken}` });
    }
  }
  let changed = false;
  for (const [id, state] of Object.entries(frames)) {
    if (stale.some(result => state.documentKey?.startsWith(`${result.documentId}:`))) {
      retireDocument(tabId, id, state); delete frames[id]; changed = true;
      if (id === '0' && ids.has(documents[id])) tabTitleMap.delete(tabId);
    }
  }
  for (const [id, documentId] of Object.entries(documents)) if (ids.has(documentId)) delete documents[id];
  const retain = item => {
    const contexts = (item.contexts || [{ frameId: item.frameId, documentId: item.documentId || '' }])
      .filter(context => !ids.has(context.documentId));
    if (contexts.length === (item.contexts?.length ?? 1)) return item;
    changed = true;
    return contexts.length ? { ...item, contexts, frameId: contexts[0].frameId, documentId: contexts[0].documentId } : null;
  };
  if (tabMediaMap.has(tabId)) tabMediaMap.set(tabId, tabMediaMap.get(tabId).map(retain).filter(Boolean));
  const fragments = fragmentMediaMap.get(tabId);
  if (fragments) for (const [url, item] of fragments) {
    const remaining = retain(item); if (remaining) fragments.set(url, remaining); else fragments.delete(url);
  }
  scheduleSave();
  if (changed) {
    tabChunkCountMap.set(tabId, fragments?.size || 0);
    updateBadge(tabId); notify({ action: 'mediaListUpdated', tabId });
  }
}
function fromPopup(sender) {
  return sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
}
async function refreshableTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { throw new Error('当前标签页已关闭或不可用'); }
  if (tab.discarded) throw new Error('当前标签页已休眠，请先切换到该网页后重试');
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('只能重新扫描 HTTP / HTTPS 网页');
  return tab;
}
function refreshMedia(tabId) {
  const existing = mediaRefreshes.get(tabId);
  if (existing && !existing.invalidated) return existing.promise;
  const refresh = { invalidated: false, expired: false, documents: new Set(), results: [], promise: null };
  mediaRefreshes.set(tabId, refresh);
  const checkNavigation = () => {
    if (refresh.invalidated) throw new Error('扫描期间网页已变化，请重新刷新列表');
    if (refresh.expired) throw new Error('页面扫描超时，请再次刷新列表');
  };
  refresh.promise = (async () => {
    // This short barrier waits for hydration/navigation mutations. The script
    // itself must run OUTSIDE eventQueue: it awaits reports handled by that queue.
    await enqueue(() => {});
    for (const documentId of Object.values(tabDocuments.get(tabId) || {})) refresh.documents.add(documentId);
    const initial = await refreshableTab(tabId);
    checkNavigation();
    let timer;
    try {
      const scanning = (async () => {
        let results, partial = false;
        try {
          results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
        } catch (error) {
          checkNavigation();
          // A protected child frame can reject an all-frames request. Retry the
          // accessible main frame without clearing network or earlier evidence.
          partial = true;
          try { results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] }); }
          catch { throw new Error(`无法重新扫描网页，请检查扩展的网站访问权限后重试：${error.message || '脚本注入失败'}`); }
        }
        refresh.results = Array.isArray(results) ? results : [];
        if (refresh.invalidated) await enqueue(() => retireRefreshDocuments(tabId, refresh));
        checkNavigation();
        const confirmed = result => result?.result?.success === true && typeof result.result.documentToken === 'string' &&
          result.result.documentToken.length > 0 && Number.isSafeInteger(result.result.generation) &&
          Number.isSafeInteger(result.result.reports) && result.result.reports > 0 && !result.result.inactive;
        if (!Array.isArray(results) || !results.some(confirmed)) throw new Error('页面未确认完成扫描，请再次刷新列表');
        partial ||= results.some(result => !confirmed(result));
        const current = await refreshableTab(tabId);
        checkNavigation();
        if (current.url !== initial.url) throw new Error('扫描期间网页已变化，请重新刷新列表');
        return partial ? '部分页面框架无法扫描，已保留可读取的视频来源' : '';
      })();
      const recoveryWarning = await Promise.race([scanning, new Promise((_, reject) => {
        timer = setTimeout(() => { refresh.expired = true; reject(new Error('页面扫描超时，请再次刷新列表')); }, 10000);
      })]);
      // executeScript resolves only after the content script's report ACKs.
      return await enqueue(() => {
        checkNavigation();
        return { success: true, ...mediaSnapshot(tabId), ...(recoveryWarning ? { recoveryWarning } : {}) };
      });
    } finally {
      clearTimeout(timer);
      if (refresh.invalidated) await enqueue(() => retireRefreshDocuments(tabId, refresh));
    }
  })().finally(() => { if (mediaRefreshes.get(tabId) === refresh) mediaRefreshes.delete(tabId); });
  return refresh.promise;
}
function documentKey(message, sender) {
  const token = typeof message.documentToken === "string" ? message.documentToken.slice(0, 100) : "";
  return typeof sender.documentId === "string" && sender.documentId ? `${sender.documentId}:${token}` : token;
}
function retireNetworkDocument(tabId, documentId) {
  if (typeof documentId !== 'string' || !documentId) return;
  let retired = retiredNetworkDocuments.get(tabId);
  if (!retired) retiredNetworkDocuments.set(tabId, retired = new Set());
  retired.add(documentId);
  if (retired.size > 200) retired.delete(retired.values().next().value);
}
function networkDocumentAllowed(details) {
  const { tabId, frameId, documentId } = details;
  if (!documentId) return true; // Chrome supplies documentId; tolerate older stored/test evidence.
  if (retiredNetworkDocuments.get(tabId)?.has(documentId)) return false;
  let documents = tabDocuments.get(tabId);
  if (!documents) tabDocuments.set(tabId, documents = {});
  if (documents[frameId] && documents[frameId] !== documentId) return false;
  documents[frameId] = documentId;
  return true;
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
  if (sender.documentId) {
    let documents = tabDocuments.get(tabId);
    if (!documents) tabDocuments.set(tabId, documents = {});
    if (documents[frameId] !== sender.documentId) retireNetworkDocument(tabId, documents[frameId]);
    documents[frameId] = sender.documentId;
    // A fresh BFCache activation can use the same browser documentId.
    retiredNetworkDocuments.get(tabId)?.delete(sender.documentId);
  }
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
function isPlaylist(url, mime = "") { return /\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(mime); }
function isFragmentUrl(url, contentType = "") {
  if (isPlaylist(url, contentType)) return false;
  return /mp2t|iso\.segment/i.test(contentType) || /\.(?:ts|m4s|m4v_frag|f4f)(?:$|[?#])/i.test(url);
}
function updateBadge(tabId) {
  chrome.action.setBadgeText({ tabId, text: String(tabMediaMap.get(tabId)?.length || "") }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#DC7091" }).catch(() => {});
}
function clearTab(tabId) {
  for (const [frameId, state] of Object.entries(tabPlaybackMap.get(tabId) || {})) retireDocument(tabId, frameId, state);
  for (const documentId of Object.values(tabDocuments.get(tabId) || {})) retireNetworkDocument(tabId, documentId);
  tabMediaMap.delete(tabId); tabTitleMap.delete(tabId);
  tabChunkCountMap.delete(tabId); fragmentMediaMap.delete(tabId);
  tabPlaybackMap.delete(tabId); frameParents.delete(tabId); tabDocuments.delete(tabId);
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
  const documents = tabDocuments.get(tabId) || {};
  for (const id of removed) {
    retireDocument(tabId, id, frames[id]); delete frames[id]; delete parents[id];
    retireNetworkDocument(tabId, documents[id]); delete documents[id];
  }
  const media = tabMediaMap.get(tabId);
  const retainContexts = item => {
    const contexts = (item.contexts || [{ frameId: item.frameId, documentId: item.documentId || '' }])
      .filter(context => !removed.has(context.frameId));
    return contexts.length ? { ...item, contexts, frameId: contexts[0].frameId, documentId: contexts[0].documentId } : null;
  };
  if (media) tabMediaMap.set(tabId, media.map(retainContexts).filter(Boolean));
  const fragments = fragmentMediaMap.get(tabId);
  if (fragments) {
    for (const [url, item] of fragments) {
      const retained = retainContexts(item);
      if (retained) fragments.set(url, retained); else fragments.delete(url);
    }
    tabChunkCountMap.set(tabId, fragments.size);
  }
  updateBadge(tabId); scheduleSave(); notify({ action: "mediaListUpdated", tabId });
}
function addMediaItem(tabId, item) {
  const url = mediaRules.normalizeUrl(item.url);
  if (!validTab(tabId) || !url) return;
  let list = tabMediaMap.get(tabId);
  if (!list) tabMediaMap.set(tabId, list = []);
  let fragments = fragmentMediaMap.get(tabId);
  if (!fragments) fragmentMediaMap.set(tabId, fragments = new Map());
  const existing = list.find(entry => entry.url === url) || fragments.get(url);
  const observations = mediaRules.mergeObservations(existing?.observations, item);
  const classification = mediaRules.classify(url, observations);
  const context = { frameId: item.frameId ?? 0, documentId: item.documentId || '' };
  const contexts = [...(existing?.contexts || (existing ? [{ frameId: existing.frameId, documentId: existing.documentId || '' }] : []))];
  if (!contexts.some(entry => entry.frameId === context.frameId && entry.documentId === context.documentId)) contexts.push(context);
  const baseName = mediaRules.sanitizeFilename(item.customTitle || existing?.baseName ||
    existing?.suggestedFilename?.replace(/\.[^/.]+$/, '') || tabTitleMap.get(tabId) || '视频');
  const media = {
    ...existing, id: existing?.id || `${tabId}_${crypto.randomUUID()}`, url, observations, ...classification,
    size: classification.isM3U8 ? 0 : Math.max(existing?.size || 0, Number(item.size) || 0),
    baseName, suggestedFilename: `${baseName}.${classification.ext}`,
    name: String(item.name || existing?.name || '').slice(0, 80), source: item.source || existing?.source || 'network',
    contexts, frameId: item.frameId ?? existing?.frameId ?? 0, documentId: item.documentId || existing?.documentId || '',
    pageUrl: item.pageUrl || existing?.pageUrl || '', active: Boolean(item.active || existing?.active),
    timestamp: item.active ? Date.now() : existing?.timestamp || Date.now()
  };
  if (existing && JSON.stringify(existing) === JSON.stringify(media)) return;
  const index = list.indexOf(existing);
  if (index >= 0) list.splice(index, 1);
  fragments.delete(url);
  if (classification.isFragment) {
    fragments.set(url, media);
    // Keep evidence so a later <video> observation can promote a .ts resource.
    if (fragments.size > 1000) fragments.delete(fragments.keys().next().value);
  } else {
    if (item.active) for (const entry of list) entry.active = false;
    list.push(media);
    list.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
      Number(Boolean(b.isM3U8)) - Number(Boolean(a.isM3U8)) || (b.timestamp || 0) - (a.timestamp || 0));
    if (list.length > MAX_MEDIA) list.length = MAX_MEDIA;
  }
  tabChunkCountMap.set(tabId, fragments.size);
  updateBadge(tabId); scheduleSave(); notify({ action: 'mediaListUpdated', tabId });
}
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (!validTab(details.tabId)) return;
  if (details.type === "main_frame") {
    invalidateRefresh(details.tabId);
    // Reset before new media requests, including same-URL reloads.
    enqueue(() => clearTab(details.tabId));
  } else if (details.type === "sub_frame" && validFrame(details.frameId)) {
    enqueue(() => {
      clearFrame(details.tabId, details.frameId);
      let parents = frameParents.get(details.tabId);
      if (!parents) frameParents.set(details.tabId, parents = {});
      if (validFrame(details.parentFrameId)) parents[details.frameId] = details.parentFrameId;
    });
  } else {
    enqueue(() => {
      if (!networkDocumentAllowed(details)) return;
      if (isPlaylist(details.url)) addMediaItem(details.tabId, {
        url: details.url, observation: 'url', frameId: details.frameId, documentId: details.documentId,
        pageUrl: details.documentUrl || details.initiator || ''
      });
    });
  }
}, { urls: ["<all_urls>"] });
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (!validTab(details.tabId) || details.statusCode >= 400 || (details.statusCode >= 300 && details.statusCode !== 304)) return;
  const headers = Object.fromEntries((details.responseHeaders || []).map(header => [header.name.toLowerCase(), header.value || ""]));
  const mime = headers["content-type"] || "";
  if (!/^(?:video|audio)\//i.test(mime) && !isPlaylist(details.url, mime) && !isFragmentUrl(details.url, mime)) return;
  // Content-Length on a 206 response is only the current byte range.
  const total = /\/([0-9]+)$/.exec(headers["content-range"] || "")?.[1];
  enqueue(() => {
    if (!networkDocumentAllowed(details)) return;
    addMediaItem(details.tabId, {
      url: details.url, mime, observation: 'response', size: Number(total || headers["content-length"]) || 0,
      frameId: details.frameId, documentId: details.documentId, pageUrl: details.documentUrl || details.initiator || ""
    });
  });
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== "string") return;
  if (message.action === 'refreshMedia') {
    if (!fromPopup(sender) || !validTab(message.tabId)) {
      sendResponse({ success: false, error: '重新扫描请求无效或来源未授权' }); return;
    }
    refreshMedia(message.tabId).then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  const supported = ["reportMasterStream", "reportDOMVideo", "reportPageTitle", "reportPlaybackState", "getMedia"];
  if (!supported.includes(message.action)) return;
  const tabId = message.action === "getMedia" ? sender.tab?.id ?? message.tabId : sender.tab?.id;
  const refresh = mediaRefreshes.get(tabId);
  if (message.action !== 'getMedia' && refresh && !refresh.invalidated && !refresh.expired && typeof sender.documentId === 'string') {
    refresh.documents.add(sender.documentId);
  }
  enqueue(async () => {
    if (message.action !== "getMedia" && (!validTab(tabId) || !validFrame(sender.frameId) ||
        (sender.documentLifecycle && sender.documentLifecycle !== 'active') ||
        isStaleDocument(tabId, sender.frameId, message, sender))) return { status: "ignored" };
    if (message.action === "reportPlaybackState") {
      reportPlayback(tabId, sender.frameId, message, sender);
      return { status: "ok" };
    }
    if (["reportMasterStream", "reportDOMVideo"].includes(message.action)) {
      const title = tabTitleMap.get(tabId) || message.title;
      addMediaItem(tabId, {
        url: message.url, mime: message.mime || '', observation: 'dom',
        directVideo: message.directVideo === true || (message.action === 'reportDOMVideo' && message.directVideo !== false),
        streamHint: message.action === 'reportMasterStream', documentId: sender.documentId,
        customTitle: message.name ? `${title || "视频"}_${message.name}` : title,
        name: message.name, active: message.active, source: "dom", frameId: sender.frameId, pageUrl: sender.tab?.url || sender.url
      });
      return { status: "ok" };
    }
    if (message.action === "reportPageTitle" && validTab(tabId)) {
      if (!sender.frameId && message.title) tabTitleMap.set(tabId, String(message.title).slice(0, 300));
      scheduleSave(); return { status: "ok" };
    }
    if (message.action === "getMedia") {
      return mediaSnapshot(tabId);
    }
    return { status: "ignored" };
  }).then(result => { if (result !== undefined) sendResponse(result); })
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title) enqueue(() => { tabTitleMap.set(tabId, changeInfo.title); scheduleSave(); });
});
chrome.tabs.onRemoved.addListener(tabId => {
  invalidateRefresh(tabId);
  enqueue(() => {
    clearTab(tabId);
    retiredNetworkDocuments.delete(tabId);
    for (const key of retiredDocuments.keys()) if (key.startsWith(`${tabId}:`)) retiredDocuments.delete(key);
  });
});
