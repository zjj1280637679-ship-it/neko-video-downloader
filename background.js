// 🌸 喵喵视频下载姬 - Background Service Worker (防碎片智能过滤版)

// 缓存每个标签页的媒体列表
const tabMediaMap = new Map();
// 缓存网页标题
const tabTitleMap = new Map();
// 缓存标签页的视频多帧截屏
const tabFramesMap = new Map();
// 记录标签页已侦测到的切片计数
const tabChunkCountMap = new Map();

// 判断是否是切片碎片 (绝对不应该作为独立视频卡片展示给用户)
function isFragmentUrl(url, contentType, contentLength) {
  // 如果是 m3u8 播放清单本身，绝不是碎片，而是完整视频流入口！
  if (/\.m3u8($|\?)/i.test(url) || (contentType && contentType.includes("mpegurl"))) {
    return false;
  }

  // 1. MIME 类型明确为 TS 切片
  if (contentType && (contentType.includes("mp2t") || contentType.includes("iso.segment"))) {
    return true;
  }

  // 2. URL 包含典型的切片特征 (.ts, .m4s, seg-1, chunk_01, /hls/.../1 等)
  const FRAGMENT_REGEX = /(\.(ts|m4s|m4v_frag|f4m|f4f)($|\?))|([/_](seg|segment|chunk|frag|slice|part)[-_0-9])|(\/hls\/.*\/[0-9]+)/i;
  if (FRAGMENT_REGEX.test(url)) {
    return true;
  }

  // 3. 小于 12MB 的数字命名分块 (如 /123.mp4)
  if (contentLength && contentLength > 0 && contentLength < 12 * 1024 * 1024) {
    if (/\/[0-9]{1,5}\.(mp4|ts|m4s)($|\?)/i.test(url)) {
      return true;
    }
  }

  return false;
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
  const list = tabMediaMap.get(tabId) || [];
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
  if (!tabId || tabId < 0) return;

  const url = item.url || "";
  const contentType = (item.mime || "").toLowerCase();
  const contentLength = item.size || 0;

  // 🔴 智能拦截几 MB 的切片碎片！
  if (isFragmentUrl(url, contentType, contentLength)) {
    // 累加该标签页的切片计数，但不作为独立卡片推给用户
    const currentCount = (tabChunkCountMap.get(tabId) || 0) + 1;
    tabChunkCountMap.set(tabId, currentCount);

    // 如果当前标签页已经有主 m3u8 流，更新其切片计数
    const mediaList = tabMediaMap.get(tabId);
    if (mediaList && mediaList.length > 0) {
      mediaList[0].chunkCount = currentCount;
      chrome.runtime.sendMessage({ action: "mediaListUpdated", tabId }).catch(() => {});
    }
    return; // 直接拦截，拒绝展示几MB碎片！
  }

  if (!tabMediaMap.has(tabId)) {
    tabMediaMap.set(tabId, []);
  }
  const mediaList = tabMediaMap.get(tabId);

  // URL 去重
  const existing = mediaList.find(m => m.url === url);
  if (existing) {
    if (contentLength && !existing.size) existing.size = contentLength;
    return;
  }

  // 识别是否是完整 m3u8 流媒体
  const isM3U8 = url.includes(".m3u8") || contentType.includes("mpegurl");

  let ext = "mp4";
  if (isM3U8) ext = "m3u8";
  else if (/\.webm($|\?)/i.test(url)) ext = "webm";
  else if (/\.flv($|\?)/i.test(url)) ext = "flv";

  const pageTitle = item.customTitle || tabTitleMap.get(tabId) || "";
  let baseName = sanitizeFilename(pageTitle);
  if (!baseName || baseName === "视频") {
    baseName = "完整高清视频";
  }

  const filename = `${baseName}.${ext}`;
  const existingFrames = tabFramesMap.get(tabId) || [];
  const chunkCount = tabChunkCountMap.get(tabId) || 0;

  const mediaObj = {
    id: `${tabId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    url: url,
    mime: contentType || (isM3U8 ? "application/x-mpegURL" : "video/mp4"),
    size: contentLength,
    isM3U8: isM3U8,
    ext: ext,
    suggestedFilename: filename,
    frames: [...existingFrames],
    chunkCount: chunkCount,
    timestamp: Date.now()
  };

  // 完整 m3u8 流媒体具有最高优先级
  if (isM3U8) {
    mediaList.unshift(mediaObj);
  } else {
    mediaList.push(mediaObj);
  }

  updateBadge(tabId);
  chrome.runtime.sendMessage({ action: "mediaListUpdated", tabId }).catch(() => {});
}

// 1. 请求发出前嗅探（确保即使响应头没有 content-type 也能抓到 m3u8）
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (/\.m3u8($|\?)/i.test(details.url)) {
      addMediaItem(details.tabId, {
        url: details.url,
        mime: "application/x-mpegURL",
        size: 0
      });
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
                        contentType.includes("application/x-mpegurl");
    const isM3U8Url = details.url.includes(".m3u8");

    if (isVideoMime || isM3U8Url) {
      addMediaItem(details.tabId, {
        url: details.url,
        mime: contentType,
        size: contentLength
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = (sender.tab && sender.tab.id) || message.tabId;

  // 接收来自 DOM 的完整流地址 (针对类似 ikanbot 的 lineData udata)
  if (message.action === "reportMasterStream" && tabId) {
    if (message.title) {
      tabTitleMap.set(tabId, message.title);
    }
    addMediaItem(tabId, {
      url: message.url,
      mime: "application/x-mpegURL",
      size: 0,
      customTitle: message.name ? `${message.title}_${message.name}` : message.title
    });
    sendResponse({ status: "ok" });
    return true;
  }

  // 接收多帧截屏
  if (message.action === "reportVideoFrames" && tabId) {
    tabFramesMap.set(tabId, message.frames || []);
    const list = tabMediaMap.get(tabId);
    if (list && list.length > 0) {
      list[0].frames = message.frames || [];
    }
    chrome.runtime.sendMessage({ action: "framesUpdated", tabId, frames: message.frames }).catch(() => {});
    sendResponse({ status: "ok" });
    return true;
  }

  if (message.action === "reportPageTitle" && tabId) {
    tabTitleMap.set(tabId, message.title);
    sendResponse({ status: "ok" });
    return true;
  }

  if (message.action === "getMedia") {
    const list = tabMediaMap.get(message.tabId) || [];
    const pageTitle = tabTitleMap.get(message.tabId) || "当前网页";
    const frames = tabFramesMap.get(message.tabId) || [];
    const chunkCount = tabChunkCountMap.get(message.tabId) || 0;
    
    if (list.length > 0) {
      if (frames.length > 0) list[0].frames = frames;
      list[0].chunkCount = chunkCount;
    }
    sendResponse({ media: list, pageTitle, frames, chunkCount });
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
});

// 清理状态
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    tabMediaMap.delete(tabId);
    tabFramesMap.delete(tabId);
    tabChunkCountMap.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
  tabTitleMap.delete(tabId);
  tabFramesMap.delete(tabId);
  tabChunkCountMap.delete(tabId);
});
