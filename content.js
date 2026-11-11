// DOM media discovery and bounded frame sampling. Network capture handles
// blob/MediaSource players and cross-origin HLS requests.
(() => {
  const reported = new Set();
  const hooked = new WeakSet();
  const blockedSources = new WeakMap();
  const videoPlayback = new WeakMap();
  const newDocumentToken = () => typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  let documentToken = newDocumentToken();
  let documentStartedAt = typeof performance !== "undefined" && performance.timeOrigin
    ? performance.timeOrigin : Date.now();
  let playbackGeneration = 0;
  let nextVideoId = 0;
  let sourceSignature = "";
  let lastPlaybackReport = "";
  let capturedFrames = [];
  let capturedVideo = null;
  let capturedSource = "";
  let lastTitle = "";
  let lastSelectedUrl = "";
  let scanTimer;
  const send = message => { try {
    chrome.runtime.sendMessage({ ...message, documentToken, documentStartedAt, generation: playbackGeneration }).catch(() => {});
  } catch {} };
  function absoluteUrl(value) {
    if (!value) return null;
    try { const url = new URL(value, document.baseURI); return /^https?:$/.test(url.protocol) ? url.href : null; }
    catch { return null; }
  }
  function reportUrl(value, { name = "", mime = "", explicitVideo = false, active = false } = {}) {
    const url = absoluteUrl(value);
    if (!url || /\.(ts|m4s)(?:$|[?#])/i.test(url)) return;
    const playlist = /\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(mime);
    // data-url also occurs on articles, ads, and navigation. HTTP alone does
    // not make a URL a media playlist.
    if (!playlist && !explicitVideo && !/\.(mp4|webm|mov|mkv|flv|m4v|mp3|m4a|aac|ogg)(?:$|[?#])/i.test(url)) return;
    const key = `${url}|${mime}|${name}`;
    const selectionChanged = active && lastSelectedUrl !== url;
    if (active) lastSelectedUrl = url;
    if (reported.has(key) && !selectionChanged) return;
    reported.add(key);
    if (reported.size > 500) reported.delete(reported.values().next().value);
    send({ action: playlist ? "reportMasterStream" : "reportDOMVideo", url, mime, name, active, title: document.title || "" });
  }
  function formatTime(seconds) {
    const time = Math.max(0, Math.floor(Number(seconds) || 0));
    const parts = [Math.floor(time / 60) % 60, time % 60];
    if (time >= 3600) parts.unshift(Math.floor(time / 3600));
    return parts.map(part => String(part).padStart(2, "0")).join(":");
  }
  function videoSource(video) { return video.currentSrc || video.src || ""; }
  function observeVideo(video, event) {
    // currentSrc can still name the previous movie after src is reassigned.
    // Prefer the declared source and wait until the loaded source matches it.
    const declared = [video.src || "", ...[...video.querySelectorAll("source[src]")].map(item => item.src)].filter(Boolean);
    const source = JSON.stringify(declared.length ? declared : [video.currentSrc || ""]);
    let state = videoPlayback.get(video);
    if (!state) {
      state = { id: ++nextVideoId, source, revision: 0, observed: false, playing: false };
      videoPlayback.set(video, state);
    }
    if (source !== state.source || event?.type === "emptied") {
      state.source = source; state.revision++; state.observed = false; state.playing = false;
    }
    const playbackEvent = event?.isTrusted !== false && event?.type === "playing";
    // A preload, a seek, and loadedmetadata on a paused video are not proof
    // of playback. This also detects a player already running when we attach.
    const sourceMatches = !declared.length || declared.includes(video.currentSrc);
    const running = sourceMatches && !video.paused && !video.ended && video.readyState >= 2;
    const hasPlayedRange = sourceMatches && video.played?.length > 0;
    if (event?.type !== "emptied" && (playbackEvent || running || hasPlayedRange)) state.observed = true;
    state.playing = state.observed && running;
    return state;
  }
  function reportPlayback() {
    const videos = [...document.querySelectorAll("video")];
    const states = videos.map(video => observeVideo(video));
    const signature = JSON.stringify(states.map(state => [state.id, state.source, state.revision]));
    if (signature !== sourceSignature) { sourceSignature = signature; playbackGeneration++; }
    const state = {
      action: "reportPlaybackState", videoCount: videos.length,
      iframeCount: document.querySelectorAll("iframe, frame").length,
      hasPlayed: states.some(item => item.observed), playing: states.some(item => item.playing),
      generation: playbackGeneration
    };
    const key = JSON.stringify(state);
    if (key === lastPlaybackReport) return;
    lastPlaybackReport = key;
    send(state);
  }
  function captureVideoFrame(video) {
    if (!video) return null;
    const source = videoSource(video);
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || blockedSources.get(video) === source) return null;
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(240 / video.videoWidth, 160 / video.videoHeight, 1);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return {
        timeStr: formatTime(video.currentTime), seconds: Math.round(video.currentTime),
        dataUrl: canvas.toDataURL("image/jpeg", 0.75), timestamp: Date.now()
      };
    } catch (error) {
      // A tainted canvas remains so until its source changes. Do not throw on
      // every timeupdate for the rest of the movie.
      if (error.name === "SecurityError") blockedSources.set(video, source);
      return null;
    }
  }
  function reportFrames() { send({ action: "reportVideoFrames", frames: capturedFrames }); }
  function selectCaptureSource(video) {
    const source = videoSource(video);
    if (capturedVideo === video && capturedSource === source) return;
    const changed = capturedVideo !== null;
    capturedVideo = video; capturedSource = source; capturedFrames = [];
    if (changed) reportFrames();
  }
  function tryCapture(video, force = false) {
    if (video.paused && !force) return null;
    selectCaptureSource(video);
    const seconds = Math.round(video.currentTime || 0);
    if (!force && (capturedFrames.length >= 10 || capturedFrames.some(frame => Math.abs(frame.seconds - seconds) < 5))) return null;
    const frame = captureVideoFrame(video);
    if (!frame) return null;
    capturedFrames = capturedFrames.filter(item => item.seconds !== frame.seconds);
    if (capturedFrames.length >= 10) capturedFrames.shift();
    capturedFrames.push(frame); capturedFrames.sort((a, b) => a.seconds - b.seconds);
    reportFrames(); return frame;
  }
  function inspectVideo(video) {
    reportUrl(video.currentSrc || video.src, { explicitVideo: true });
    video.querySelectorAll("source[src]").forEach(source => reportUrl(source.src, { mime: source.type, explicitVideo: true }));
    if (hooked.has(video)) return;
    hooked.add(video);
    for (const event of ["play", "playing", "loadedmetadata", "emptied", "pause", "ended"]) video.addEventListener(event, eventInfo => {
      observeVideo(video, eventInfo);
      reportPlayback();
      reportUrl(video.currentSrc || video.src, { explicitVideo: true });
      if (event !== "emptied") tryCapture(video);
    });
    video.addEventListener("timeupdate", () => {
      // At most the first advancing frame changes playback state. Do not send
      // or persist a status update for every video-clock tick.
      if (!videoPlayback.get(video)?.observed && !video.paused && !video.ended && video.readyState >= 2 && video.currentTime > 0) reportPlayback();
      tryCapture(video);
    });
    video.addEventListener("seeked", () => tryCapture(video));
    tryCapture(video);
  }
  function scan() {
    scanTimer = undefined;
    reportPlayback();
    if (window.top === window && document.title && lastTitle !== document.title) {
      lastTitle = document.title; send({ action: "reportPageTitle", title: lastTitle });
    }
    document.querySelectorAll("[udata], [data-url]").forEach(element => {
      // ikanbot renders all episodes and routes. Only the selected episode is
      // relevant; inactive URLs would otherwise flood the popup with 196 rows.
      if (element.getAttribute("name") === "lineData" && !element.classList.contains("active")) return;
      reportUrl(element.getAttribute("udata") || element.getAttribute("data-url"), {
        name: (element.getAttribute("title") || element.textContent || "").trim().slice(0, 80),
        active: element.getAttribute("name") === "lineData"
      });
    });
    document.querySelectorAll("video").forEach(inspectVideo);
  }
  function scheduleScan() { if (!scanTimer) scanTimer = setTimeout(scan, 200); }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== "captureCurrentFrameNow") return;
    const videos = [...document.querySelectorAll("video")].filter(video => video.readyState >= 2 && video.videoWidth);
    videos.sort((a, b) => Number(a.paused) - Number(b.paused) || b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    const video = videos[0];
    const frame = video && tryCapture(video, true);
    sendResponse(frame ? { success: true, frame } : {
      success: false, error: video && blockedSources.has(video) ? "该视频未允许跨域截图，下载功能不受影响" : "请先播放视频，再抓拍画面"
    });
  });
  const observer = new MutationObserver(records => {
    // Video clocks, captions and unrelated CSS animations should not trigger a
    // full scan. Observe selected-route classes and actual media insertions.
    const selector = "video, source, iframe, frame, [udata], [data-url], title";
    if (records.some(record => {
      if (record.type === "attributes") return record.attributeName === "class"
        ? record.target.getAttribute("name") === "lineData"
        : record.target.matches?.(selector);
      return record.target.matches?.("title") || [...(record.addedNodes || []), ...(record.removedNodes || [])].some(node =>
        node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector)));
    })) scheduleScan();
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["src", "udata", "data-url", "type", "class"]
  });
  window.addEventListener("pagehide", () => {
    // Removed/navigated iframes must not leave a permanently "playing" entry
    // behind. A BFCache restore gets a fresh activation token below.
    playbackGeneration++;
    send({ action: "reportPlaybackState", videoCount: 0, iframeCount: 0,
      hasPlayed: false, playing: false, inactive: true });
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      // BFCache restores the same Document object after a navigation reset.
      // Treat this activation as fresh so both playback and URLs are resent.
      documentToken = newDocumentToken(); documentStartedAt = Date.now();
      lastPlaybackReport = ""; reported.clear(); lastSelectedUrl = ""; lastTitle = "";
      capturedFrames = []; capturedVideo = null;
    }
    scheduleScan();
  });
  scan();
})();
