// 🌸 喵喵视频下载姬 - Content Script
// 负责 DOM 视频检测、完整主视频流嗅探(如 ikanbot lineData)、实时多帧截屏与时间戳

(function () {
  const capturedFrames = [];

  // 时间格式化：秒 -> mm:ss 或 hh:mm:ss
  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  // 截取单帧画面
  function captureVideoFrame(video) {
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return null;
    try {
      const canvas = document.createElement("canvas");
      const width = 180;
      const height = Math.round((video.videoHeight / video.videoWidth) * width) || 101;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.75);

      const currentTime = video.currentTime || 0;
      return {
        timeStr: formatTime(currentTime),
        seconds: Math.round(currentTime),
        dataUrl: dataUrl,
        timestamp: Date.now()
      };
    } catch (e) {
      return null;
    }
  }

  function reportFrames() {
    if (capturedFrames.length === 0) return;
    chrome.runtime.sendMessage({
      action: "reportVideoFrames",
      frames: capturedFrames
    }).catch(() => {});
  }

  function tryCapture(video) {
    const currentSec = Math.round(video.currentTime || 0);
    const isDistinct = capturedFrames.every(f => Math.abs(f.seconds - currentSec) >= 2);
    if (isDistinct && capturedFrames.length < 10) {
      const frame = captureVideoFrame(video);
      if (frame) {
        capturedFrames.push(frame);
        capturedFrames.sort((a, b) => a.seconds - b.seconds);
        reportFrames();
      }
    }
  }

  function attachFrameCapture(video) {
    if (video.__cute_capture_hooked) return;
    video.__cute_capture_hooked = true;

    video.addEventListener("timeupdate", () => tryCapture(video));
    video.addEventListener("playing", () => tryCapture(video));
    video.addEventListener("seeked", () => tryCapture(video));
    video.addEventListener("canplay", () => tryCapture(video));
    tryCapture(video);
  }

  // 核心突破：扫描页面 DOM 里的完整播放流地址 (例如爱看机器人 ikanbot 的 lineData udata)
  function scanMasterStreams() {
    const title = document.title || "";

    // 针对 ikanbot 等流媒体站点的线路属性
    const lineElements = document.querySelectorAll("div[name='lineData'], [udata], [data-url]");
    lineElements.forEach((el) => {
      const streamUrl = el.getAttribute("udata") || el.getAttribute("data-url");
      if (streamUrl && (streamUrl.includes(".m3u8") || streamUrl.startsWith("http"))) {
        const lineName = el.textContent.trim() || "";
        chrome.runtime.sendMessage({
          action: "reportMasterStream",
          url: streamUrl,
          name: lineName,
          title: title
        }).catch(() => {});
      }
    });

    // 检查页面 video 标签是否有 m3u8
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      attachFrameCapture(video);

      if (video.src && video.src.includes(".m3u8")) {
        chrome.runtime.sendMessage({
          action: "reportMasterStream",
          url: video.src,
          title: title
        }).catch(() => {});
      }

      // 普通非 blob 直链
      if (video.src && !video.src.startsWith("blob:") && video.src.startsWith("http")) {
        // 如果是 ts 切片则不作为独立视频上报
        if (!video.src.includes(".ts")) {
          chrome.runtime.sendMessage({
            action: "reportDOMVideo",
            url: video.src,
            title: title
          }).catch(() => {});
        }
      }
    });
  }

  // 上报页面标题
  function reportTitle() {
    if (window.top === window && document.title) {
      chrome.runtime.sendMessage({
        action: "reportPageTitle",
        title: document.title
      }).catch(() => {});
    }
  }

  // 响应即时截图
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "captureCurrentFrameNow") {
      const video = document.querySelector("video");
      if (video) {
        const frame = captureVideoFrame(video);
        if (frame) {
          const exists = capturedFrames.some(f => f.timeStr === frame.timeStr);
          if (!exists) {
            capturedFrames.push(frame);
            capturedFrames.sort((a, b) => a.seconds - b.seconds);
          }
          reportFrames();
          sendResponse({ success: true, frame });
          return true;
        }
      }
      sendResponse({ success: false, error: "未找到正在播放的视频画面" });
      return true;
    }
  });

  reportTitle();
  scanMasterStreams();

  // 深度监听 DOM 动态变化（很多站点点播、切集是异步塞入 lineData 的）
  const observer = new MutationObserver(() => {
    scanMasterStreams();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      reportTitle();
      scanMasterStreams();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
})();
