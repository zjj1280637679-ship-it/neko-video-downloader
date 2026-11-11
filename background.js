// 🌸 喵喵视频下载姬 - Background Service Worker (防碎片智能过滤版)

// 缓存每个标签页的媒体列表
let tabMediaMap = new Map();
// 缓存网页标题
let tabTitleMap = new Map();
// 缓存标签页的视频多帧截屏
let tabFramesMap = new Map();
// 播放器所在文档，供 iframe 抓拍和原图读取使用。
let tabPlayersMap = new Map();
// 记录标签页已侦测到的切片计数
let tabChunkCountMap = new Map();

// ---------- MV3 service worker 内存态持久化 ----------
// service worker 闲置约 30 秒即被系统回收，内存里的 Map 会丢；写透到 chrome.storage.session，启动时恢复。
const SESSION_KEYS = {
  media: "neko_tabMedia",
  titles: "neko_tabTitles",
  frames: "neko_tabFrames",
  chunks: "neko_tabChunks",
  players: "neko_tabPlayers"
};

let saveChain = Promise.resolve();
function scheduleSave() {
  // 原图不经过 session；缩略图只存一份，写入按顺序完成。
  const snapshot = {
    [SESSION_KEYS.media]: [...tabMediaMap.entries()].map(([id, items]) => [id, items.map(({ frames, ...item }) => item)]),
    [SESSION_KEYS.titles]: [...tabTitleMap.entries()],
    [SESSION_KEYS.frames]: [...tabFramesMap.entries()],
    [SESSION_KEYS.chunks]: [...tabChunkCountMap.entries()],
    [SESSION_KEYS.players]: [...tabPlayersMap.entries()]
  };
  saveChain = saveChain.then(() => chrome.storage.session.set(snapshot)).catch((err) => console.warn("媒体状态保存失败", err));
}

let restorePromise = null;
function restoreState() {
  if (restorePromise) return restorePromise;
  restorePromise = chrome.storage.session
    .get(Object.values(SESSION_KEYS))
    .then((data) => {
      if (data[SESSION_KEYS.media]) tabMediaMap = new Map(data[SESSION_KEYS.media]);
      if (data[SESSION_KEYS.titles]) tabTitleMap = new Map(data[SESSION_KEYS.titles]);
      if (data[SESSION_KEYS.frames]) tabFramesMap = new Map(data[SESSION_KEYS.frames]);
      if (data[SESSION_KEYS.chunks]) tabChunkCountMap = new Map(data[SESSION_KEYS.chunks]);
      if (data[SESSION_KEYS.players]) tabPlayersMap = new Map(data[SESSION_KEYS.players]);
    })
    .catch(() => {});
  return restorePromise;
}
restoreState();

function whenReady(action) {
  return restoreState().then(action).catch((err) => console.warn("媒体状态处理失败", err));
}

function framesForMedia(tabId, item) {
  const frames = tabFramesMap.get(tabId) || [];
  const exact = frames.filter((frame) => frame.sourceUrl === item.url);
  if (exact.length) return exact.map((frame) => ({ ...frame, sourceMatched: true }));
  if (!item.isM3U8) return [];
  const players = (tabPlayersMap.get(tabId) || []).filter((player) =>
    (!player.sourceUrl || player.sourceUrl.startsWith("blob:")) && playerBelongsToMedia(player, item));
  if (players.length !== 1) return [];
  return framesForPlayer(frames, players[0]).map((frame) => ({ ...frame, sourceMatched: false }));
}

function framesForPlayer(frames, player) {
  return frames.filter((frame) => frame.frameId === player.frameId && frame.videoId === player.videoId &&
    frame.documentId === player.documentId);
}

function frameOptions(target) {
  return target.documentId ? { documentId: target.documentId } : { frameId: target.frameId || 0 };
}

function playerIdentity(player) {
  return { frameId: player.frameId, documentId: player.documentId, videoId: player.videoId,
    sourceUrl: player.sourceUrl, title: player.title, isPlaying: player.isPlaying,
    width: player.width, height: player.height };
}

function playerBelongsToMedia(player, media) {
  const contexts = media?.contexts || (media?.frameIds || []).map((frameId) => ({ frameId }));
  const related = contexts.filter((context) => context.frameId === player.frameId);
  const documented = related.filter((context) => context.documentId);
  return documented.length ? documented.some((context) => context.documentId === player.documentId) : related.length > 0;
}

async function captureFromPlayer(tabId, message) {
  const allPlayers = [...(tabPlayersMap.get(tabId) || [])];
  let players;
  const media = (tabMediaMap.get(tabId) || []).find((item) => item.url === message.sourceUrl);
  const hasTarget = ["videoId", "frameId", "documentId"].some((key) => message[key] !== undefined);
  if (hasTarget) {
    players = allPlayers.filter((player) => ["videoId", "frameId", "documentId"]
      .every((key) => message[key] === undefined || player[key] === message[key]));
  } else {
    const exact = message.sourceUrl ? allPlayers.filter((p) => p.sourceUrl === message.sourceUrl) : [];
    if (exact.length) players = exact;
    else if (!message.sourceUrl) players = allPlayers;
    else if (media?.isM3U8) {
      // blob 只证明播放器存在。清单所在 frame/document 限定候选范围，失败不能换别处的画面。
      players = allPlayers.filter((p) => (!p.sourceUrl || p.sourceUrl.startsWith("blob:")) && playerBelongsToMedia(p, media));
    } else players = [];
  }
  if (!players.length) return { success: false, error: hasTarget
    ? "所选播放器已关闭或文档已刷新，请重新选择播放器"
    : "这个片源没有对应的当前播放器；可在下方播放器卡片选择需要抓拍的画面" };
  if (players.length > 1) return { success: false,
    error: "找到多个可能的播放器，请在下方播放器卡片选择需要抓拍的画面", candidates: players.map(playerIdentity) };
  const player = players[0];
  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      action: "captureCurrentFrameNow", videoId: player.videoId, sourceUrl: message.sourceUrl,
      expectedSourceUrl: player.sourceUrl
    }, frameOptions(player));
    if (result?.success) return { ...result, sourceMatched: result.frame.sourceUrl === message.sourceUrl,
      frame: { ...result.frame, frameId: player.frameId, documentId: player.documentId } };
    return result || { success: false, error: "播放器未返回画面，请重新播放后重试" };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// 切片计数应挂在 m3u8 主流卡片上，而不是 mediaList[0]（[0] 可能是先到的 mp4）
function firstStreamItem(list) {
  const visible = (list || []).filter((item) => !item.isFragment);
  return visible.find((m) => m.isM3U8) || visible[0] || null;
}

const FILE_MIMES = {
  "video/mp4": "mp4", "video/webm": "webm", "video/x-flv": "flv", "video/flv": "flv",
  "video/quicktime": "mov", "video/ogg": "ogv", "video/x-msvideo": "avi", "video/x-matroska": "mkv",
  "video/mp2t": "ts"
};

function isKnownMediaMime(mime) {
  return /mpegurl|mp2t|iso\.segment/i.test(mime || "") || (mime || "").startsWith("video/");
}

function classifyMedia(url, evidence) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch (_) { pathname = url.split(/[?#]/)[0]; }
  const pathExt = pathname.match(/\.([a-z0-9_]+)$/i)?.[1].toLowerCase() || "";
  const responseMime = evidence.responseMime || "";
  const mime = isKnownMediaMime(responseMime) ? responseMime : (evidence.domMime || "");
  const isHlsMime = mime.includes("mpegurl");
  const filePath = ["mp4", "webm", "flv", "mov", "m4v", "ogv", "avi", "mkv", "ts", "m4s"].includes(pathExt);
  const segmentPath = ["ts", "m4s", "m4v_frag", "f4f"].includes(pathExt);
  const isM3U8 = !!(isHlsMime || (!isKnownMediaMime(mime) &&
    (pathExt === "m3u8" || (!filePath && !segmentPath && evidence.streamHint))));
  const segmentMime = /mp2t|iso\.segment/.test(mime);
  // 目录/part 名称只作为线索；真实 video MIME 或 <video> 使用证据不能被弱路径规则抹掉。
  const fragmentHint = /(?:[\/_](?:seg|segment|chunk|frag|slice)[-_0-9])|(?:[\/_]part[-_][0-9])|(?:\/hls\/.*\/[0-9]+)/i.test(pathname);
  const isFragment = !isM3U8 && !evidence.domVideo && (segmentPath || segmentMime);
  const ext = isM3U8 ? "m3u8" : FILE_MIMES[mime] ||
    (filePath ? pathExt : "mp4");
  return { isM3U8, isFragment, fragmentHint, ext,
    mime: mime || (isM3U8 ? "application/x-mpegurl" : "video/" + ext) };
}

// 格式化文件名
function sanitizeFilename(name) {
  return (name || "视频")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// 更新插件角标 (萌系樱花粉色)
function updateBadge(tabId) {
  const list = (tabMediaMap.get(tabId) || []).filter((item) => !item.isFragment);
  const count = list.length;
  if (count > 0) {
    chrome.action.setBadgeText({ tabId, text: String(count) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#FF6584" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
}

// 核心：添加/更新捕获的媒体项目（过滤碎片）
function addMediaItem(tabId, item) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const url = item.url || "";
  if (!/^https?:\/\//i.test(url)) return;
  const contentType = (item.mime || "").toLowerCase().split(";")[0].trim();
  const contentLength = item.size || 0;
  if (!tabMediaMap.has(tabId)) {
    tabMediaMap.set(tabId, []);
  }
  const mediaList = tabMediaMap.get(tabId);
  const existing = mediaList.find(m => m.url === url);
  const evidence = { ...(existing?.evidence || {}) };
  // responseMime 只接收响应头；DOM 类型声明与线路猜测始终保留各自来源。
  if (item.observation === "response" && contentType &&
      (isKnownMediaMime(contentType) || !isKnownMediaMime(evidence.responseMime))) evidence.responseMime = contentType;
  if (item.observation === "dom") {
    if (contentType) evidence.domMime = contentType;
    if (item.directVideo) evidence.domVideo = true;
    if (item.streamHint) evidence.streamHint = true;
  }
  const classification = classifyMedia(url, evidence);
  let baseName = sanitizeFilename(item.customTitle || existing?.baseName ||
    existing?.suggestedFilename?.replace(/\.[^/.]+$/, "") || tabTitleMap.get(tabId) || "");
  if (!baseName || baseName === "视频") {
    baseName = "完整高清视频";
  }
  const frameId = item.frameId ?? 0;
  const contexts = [...(existing?.contexts || (existing?.frameIds || []).map((id) => ({ frameId: id })))];
  if (!contexts.some((c) => c.frameId === frameId && c.documentId === item.documentId)) {
    contexts.push({ frameId, documentId: item.documentId });
  }
  const chunkCount = Math.max(0, (tabChunkCountMap.get(tabId) || 0) +
    Number(classification.isFragment) - Number(!!existing?.isFragment));
  tabChunkCountMap.set(tabId, chunkCount);
  const mediaObj = {
    ...existing,
    id: existing?.id || `${tabId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    url, evidence, ...classification, baseName,
    size: existing?.size || contentLength,
    suggestedFilename: `${baseName}.${classification.ext}`,
    frameIds: [...new Set([...(existing?.frameIds || []), frameId])], contexts,
    chunkCount, timestamp: existing?.timestamp || Date.now()
  };
  // 分片保留可修正身份，但不作为下载卡片展示；同 URL 后到的完整媒体证据可提升它。
  if (existing) mediaList[mediaList.indexOf(existing)] = mediaObj;
  else mediaList.push(mediaObj);
  mediaList.sort((a, b) => Number(b.isM3U8) - Number(a.isM3U8));
  const target = firstStreamItem(mediaList);
  if (target) target.chunkCount = chunkCount;
  updateBadge(tabId);
  scheduleSave();
  chrome.runtime.sendMessage({ action: "mediaListUpdated", tabId }).catch(() => {});
}

// 1. 请求发出前嗅探（确保即使响应头没有 content-type 也能抓到 m3u8）
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (/\.m3u8($|\?)/i.test(details.url)) {
      whenReady(() => addMediaItem(details.tabId, {
        url: details.url,
        observation: "url",
        size: 0, frameId: details.frameId, documentId: details.documentId
      }));
    }
  },
  { urls: ["<all_urls>"] }
);

// 2. 响应头嗅探
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    let contentType = "";
    let contentLength = 0;

    for (const h of details.responseHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === "content-type") {
        contentType = (h.value || "").toLowerCase();
      }
      if (name === "content-length") {
        contentLength = parseInt(h.value, 10) || 0;
      }
    }

    const isVideoMime = contentType.startsWith("video/") || 
                        contentType.includes("mpegurl") || 
                        contentType.includes("mp2t") || contentType.includes("iso.segment");
    const isM3U8Url = /\.m3u8(?:$|[?#])/i.test(details.url);
    const isSegmentUrl = /\.(ts|m4s|m4v_frag|f4f)(?:$|[?#])/i.test(details.url);

    if (isVideoMime || isM3U8Url || isSegmentUrl) {
      whenReady(() => addMediaItem(details.tabId, {
        url: details.url,
        mime: contentType, observation: "response",
        size: contentLength, frameId: details.frameId, documentId: details.documentId
      }));
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// 监听消息
function handleMessage(message, sender, sendResponse) {
  const tabId = sender.tab?.id ?? message.tabId;

  // 接收来自 DOM 的完整流地址 (针对类似 ikanbot 的 lineData udata)
  if (message.action === "reportMasterStream" && Number.isInteger(tabId)) {
    if (message.title) {
      tabTitleMap.set(tabId, message.title);
    }
    addMediaItem(tabId, {
      url: message.url,
      mime: message.mime || "", observation: "dom", directVideo: !!message.directVideo,
      streamHint: true,
      size: 0, frameId: sender.frameId, documentId: sender.documentId,
      customTitle: message.name ? `${message.title}_${message.name}` : message.title
    });
    sendResponse({ status: "ok" });
    return true;
  }

  // 接收 DOM 扫描到的普通视频直链（如 <video src> 的 mp4）——之前 content.js 发了这条消息，
  // background 却没有处理分支，正片直接被丢掉，弹窗里看不到
  if (message.action === "reportDOMVideo" && Number.isInteger(tabId)) {
    if (message.title) {
      tabTitleMap.set(tabId, message.title);
    }
    addMediaItem(tabId, {
      url: message.url,
      mime: message.mime || "", observation: "dom", directVideo: message.directVideo !== false,
      streamHint: !!message.streamHint,
      size: 0, frameId: sender.frameId, documentId: sender.documentId,
      customTitle: message.title
    });
    sendResponse({ status: "ok" });
    return true;
  }

  // 接收多帧截屏
  if (message.action === "reportVideoFrames" && Number.isInteger(tabId)) {
    const frameId = sender.frameId ?? 0;
    const player = { frameId, documentId: sender.documentId, videoId: message.videoId,
      sourceUrl: message.sourceUrl || "", isPlaying: !!message.isPlaying, area: message.area || 0,
      width: message.width || 0, height: message.height || 0,
      title: message.title || "", pageUrl: message.pageUrl || sender.url || "" };
    const samePlayer = (p) => p.frameId === frameId && p.videoId === player.videoId;
    const staleDocument = (p) => p.frameId === frameId && p.documentId && sender.documentId && p.documentId !== sender.documentId;
    const players = (tabPlayersMap.get(tabId) || []).filter((p) => !samePlayer(p) && !staleDocument(p));
    tabPlayersMap.set(tabId, [...players, player]);
    const oldFrames = (tabFramesMap.get(tabId) || []).filter((f) => !samePlayer(f) && !staleDocument(f));
    const frames = (message.frames || []).slice(-10).map(({ originalDataUrl, ...frame }) => ({ ...frame, ...player }));
    tabFramesMap.set(tabId, [...oldFrames, ...frames].slice(-60));
    scheduleSave();
    chrome.runtime.sendMessage({ action: "framesUpdated", tabId }).catch(() => {});
    sendResponse({ status: "ok" });
    return true;
  }

  if (message.action === "reportPageTitle" && Number.isInteger(tabId)) {
    tabTitleMap.set(tabId, message.title);
    scheduleSave();
    sendResponse({ status: "ok" });
    return true;
  }

  if (message.action === "getMedia") {
    // 先等启动恢复完成，否则 SW 刚被唤醒时列表还是空的
    restoreState().then(() => {
      const list = (tabMediaMap.get(message.tabId) || []).filter((item) => !item.isFragment)
        .map((item) => ({ ...item, frames: framesForMedia(message.tabId, item) }));
      const pageTitle = tabTitleMap.get(message.tabId) || "当前网页";
      const frames = tabFramesMap.get(message.tabId) || [];
      const players = (tabPlayersMap.get(message.tabId) || [])
        .map((player) => ({ ...player, frames: framesForPlayer(frames, player) }));
      const chunkCount = tabChunkCountMap.get(message.tabId) || 0;

      if (list.length > 0) {
        const target = firstStreamItem(list);
        if (target) {
          target.chunkCount = chunkCount;
        }
      }
      sendResponse({ media: list, pageTitle, frames, players, chunkCount });
    });
    return true;
  }

  if (message.action === "captureCurrentFrame") {
    captureFromPlayer(tabId, message).then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "getCapturedFrame") {
    const frame = (tabFramesMap.get(tabId) || []).find((f) => f.id === message.captureId);
    if (!frame) { sendResponse({ success: false, error: "原图已失效，请重新抓拍" }); return true; }
    chrome.tabs.sendMessage(tabId, { action: "getCapturedFrame", videoId: frame.videoId, captureId: frame.id }, frameOptions(frame))
      .then(sendResponse).catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "download") {
    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename || "完整视频.mp4",
        saveAs: true
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }
}

// 监听器同步注册；所有状态操作都排在恢复之后，避免新请求被旧快照覆盖。
const handledActions = new Set(["reportMasterStream", "reportDOMVideo", "reportVideoFrames", "reportPageTitle", "getMedia", "download", "captureCurrentFrame", "getCapturedFrame"]);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!handledActions.has(message.action)) return false;
  restoreState().then(() => handleMessage(message, sender, sendResponse))
    .catch((err) => sendResponse({ success: false, error: err.message }));
  return true;
});

// 清理状态
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 同 URL 重载只更新 status，不保证同时带 url；新文档不能继续使用旧文档的媒体与原图。
  if (changeInfo.status === "loading") {
    whenReady(() => {
    tabMediaMap.delete(tabId);
    tabTitleMap.delete(tabId);
    tabFramesMap.delete(tabId);
    tabPlayersMap.delete(tabId);
    tabChunkCountMap.delete(tabId);
    updateBadge(tabId);
    scheduleSave();
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  whenReady(() => {
  tabMediaMap.delete(tabId);
  tabTitleMap.delete(tabId);
  tabFramesMap.delete(tabId);
  tabPlayersMap.delete(tabId);
  tabChunkCountMap.delete(tabId);
  scheduleSave();
  });
});
