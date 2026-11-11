// 页面视频发现与截图。原图留在播放器所在页面，后台只保存缩略图与来源。
(function () {
  const MAX_FRAMES = 10;
  const videoStates = new WeakMap();
  let videoCounter = 0;

  function formatTime(seconds) {
    const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const parts = [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60];
    if (!parts[0]) parts.shift();
    return parts.map((v) => String(v).padStart(2, "0")).join(":");
  }

  function sourceOf(video) {
    if (video.srcObject) return ""; // srcObject 优先于遗留 src 属性，不能把摄像头画面归给旧文件。
    return video.currentSrc || video.src || video.querySelector("source[src]")?.src || "";
  }

  function reportFrames(video, state) {
    chrome.runtime.sendMessage({
      action: "reportVideoFrames", videoId: state.id, sourceUrl: state.source,
      isPlaying: !video.paused && !video.ended,
      area: video.videoWidth * video.videoHeight, width: video.videoWidth, height: video.videoHeight,
      title: document.title || "", pageUrl: location.href, frames: state.frames
    }).catch(() => {});
  }

  function resetSource(video, state, force = false) {
    const source = sourceOf(video);
    const sourceObject = video.srcObject || null;
    if (!force && state.source === source && state.sourceObject === sourceObject) return;
    state.source = source;
    state.sourceObject = sourceObject;
    state.frames = [];
    state.originals.clear();
    reportFrames(video, state);
  }

  function captureVideoFrame(video, state) {
    if (!video.videoWidth || !video.videoHeight) throw new Error("视频画面尚未就绪，请先播放几秒后重试");
    const original = document.createElement("canvas");
    original.width = video.videoWidth;
    original.height = video.videoHeight;
    original.getContext("2d").drawImage(video, 0, 0);
    let fullDataUrl;
    try {
      fullDataUrl = original.toDataURL("image/jpeg", 0.92);
    } catch (err) {
      if (err.name === "SecurityError") throw new Error("此播放器的跨域视频不允许读取画面，当前无法导出视频帧");
      throw err;
    }
    const thumbnail = document.createElement("canvas");
    thumbnail.width = Math.min(180, original.width);
    thumbnail.height = Math.max(1, Math.round(original.height * thumbnail.width / original.width));
    thumbnail.getContext("2d").drawImage(original, 0, 0, thumbnail.width, thumbnail.height);
    const seconds = Math.max(0, video.currentTime || 0);
    const frame = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      videoId: state.id, sourceUrl: state.source,
      timeStr: formatTime(seconds), seconds: Math.round(seconds),
      dataUrl: thumbnail.toDataURL("image/jpeg", 0.75),
      width: original.width, height: original.height, timestamp: Date.now()
    };
    state.originals.set(frame.id, fullDataUrl);
    return frame;
  }

  function tryCapture(video, manual = false) {
    const state = videoStates.get(video);
    resetSource(video, state);
    const seconds = Math.round(video.currentTime || 0);
    if (!manual && (state.frames.length >= MAX_FRAMES || state.frames.some((f) => Math.abs(f.seconds - seconds) < 2))) return null;
    const frame = captureVideoFrame(video, state);
    // 同秒抓拍替换旧图；换源清空，防止第二集显示第一集截图。
    const previous = state.frames.findIndex((f) => f.seconds === frame.seconds);
    if (previous >= 0) state.originals.delete(state.frames.splice(previous, 1)[0].id);
    if (state.frames.length >= MAX_FRAMES) state.originals.delete(state.frames.shift().id);
    state.frames.push(frame);
    state.frames.sort((a, b) => a.seconds - b.seconds);
    reportFrames(video, state);
    return frame;
  }

  function attachFrameCapture(video) {
    if (videoStates.has(video)) return;
    const state = { id: `video-${++videoCounter}`, source: sourceOf(video), sourceObject: video.srcObject || null,
      frames: [], originals: new Map() };
    videoStates.set(video, state);
    const capture = () => {
      try { tryCapture(video); } catch (_) { /* 手动抓拍会返回可读错误；自动采样不打断播放。 */ }
    };
    for (const name of ["timeupdate", "seeked", "loadeddata"]) video.addEventListener(name, capture);
    for (const name of ["playing", "pause", "ended", "resize"]) video.addEventListener(name, () => {
      resetSource(video, state);
      reportFrames(video, state); // 播放状态不能依赖截图缓存尚有空位或像素可读。
      if (name === "playing") capture();
    });
    video.addEventListener("emptied", () => resetSource(video, state, true));
    video.addEventListener("loadedmetadata", () => {
      resetSource(video, state); reportFrames(video, state); reportVideoSource(video);
    });
    reportFrames(video, state); // 没有成功截图时也登记 iframe，供手动抓拍精确定位。
    capture();
  }

  const reportedStreams = new Set();
  function reportStream(url, title, name = "", knownStream = false, directVideo = false, mime = "") {
    if (!/^https?:\/\//i.test(url)) return;
    const key = `${url}\n${title}\n${name}\n${directVideo}\n${mime}\n${knownStream}`;
    if (reportedStreams.has(key)) return;
    reportedStreams.add(key);
    const isM3U8 = /\.m3u8(?:$|[?#])/i.test(url) || (knownStream && !/\.(mp4|webm|flv)(?:$|[?#])/i.test(url));
    chrome.runtime.sendMessage({
      action: isM3U8 ? "reportMasterStream" : "reportDOMVideo", url, title, name,
      directVideo, mime, streamHint: knownStream
    }).catch(() => { reportedStreams.delete(key); });
  }

  function reportVideoSource(video) {
    const url = sourceOf(video);
    const source = [...(video.querySelectorAll?.("source[src]") || [])].find((el) => el.src === url);
    const mime = source?.type || video.getAttribute?.("type") || "";
    // <video> 实际使用的地址是完整媒体证据；不能因为 .ts 或目录名而预先丢掉。
    reportStream(url, document.title || "", "", false, true, mime);
  }

  function scanMasterStreams() {
    const title = document.title || "";
    document.querySelectorAll("div[name='lineData'], [udata], [data-url]").forEach((el) => {
      const raw = el.getAttribute("udata") || el.getAttribute("data-url");
      if (!raw) return;
      try {
        const url = new URL(raw, location.href).href;
        // data-url 也常是文章/图片链接，只有已知线路或媒体后缀才上报。
        if (el.hasAttribute("udata") || el.getAttribute("name") === "lineData" || /\.(m3u8|mp4|webm)(?:$|[?#])/i.test(url)) {
          reportStream(url, title, el.textContent.trim(), el.hasAttribute("udata") || el.getAttribute("name") === "lineData");
        }
      } catch (_) {}
    });
    document.querySelectorAll("video").forEach((video) => {
      attachFrameCapture(video);
      resetSource(video, videoStates.get(video));
      reportVideoSource(video);
    });
  }

  function selectVideo(message) {
    const videos = [...document.querySelectorAll("video")];
    videos.forEach(attachFrameCapture);
    if (message.videoId) return videos.find((v) => videoStates.get(v).id === message.videoId);
    return videos.sort((a, b) => {
      const score = (v) => (message.sourceUrl && sourceOf(v) === message.sourceUrl ? 1e12 : 0) +
        (!v.paused && !v.ended ? 1e10 : 0) + v.videoWidth * v.videoHeight;
      return score(b) - score(a);
    })[0];
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["captureCurrentFrameNow", "getCapturedFrame"].includes(message.action)) return false;
    try {
      const video = selectVideo(message);
      if (!video) throw new Error("此播放器已关闭，请刷新列表或重新播放视频");
      const state = videoStates.get(video);
      resetSource(video, state);
      if (message.action === "captureCurrentFrameNow" && message.expectedSourceUrl !== undefined &&
          state.source !== message.expectedSourceUrl) {
        throw new Error("播放器已切换到其他片源，请刷新列表后重新选择");
      }
      if (message.action === "captureCurrentFrameNow" && /^https?:\/\//i.test(message.sourceUrl || "") &&
          /^https?:\/\//i.test(state.source) && state.source !== message.sourceUrl) {
        throw new Error("播放器已切换到其他片源，请刷新列表后重新选择");
      }
      const frame = message.action === "captureCurrentFrameNow" ? tryCapture(video, true) : state.frames.find((f) => f.id === message.captureId);
      if (!frame || !state.originals.has(frame.id)) throw new Error("这张原图已随页面换源或刷新失效，请重新抓拍");
      sendResponse({ success: true, frame: { ...frame, originalDataUrl: state.originals.get(frame.id) } });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false;
  });

  function reportTitle() {
    if (window.top === window && document.title) chrome.runtime.sendMessage({ action: "reportPageTitle", title: document.title }).catch(() => {});
  }
  let scanScheduled = false;
  const observer = new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => { scanScheduled = false; reportTitle(); scanMasterStreams(); }, 100);
  });
  function start() {
    reportTitle();
    scanMasterStreams();
    if (document.body) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "udata", "data-url"] });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
