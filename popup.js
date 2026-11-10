// 🌸 喵喵视频下载姬 - Popup 界面交互逻辑 (过滤碎片 · 专属完整全片版)

document.addEventListener("DOMContentLoaded", async () => {
  const pageTitleEl = document.getElementById("pageTitle");
  const statusTextEl = document.getElementById("statusText");
  const mediaListEl = document.getElementById("mediaList");
  const btnRefresh = document.getElementById("btnRefresh");
  const toastEl = document.getElementById("toast");

  // 大图弹窗
  const imageModal = document.getElementById("imageModal");
  const modalImg = document.getElementById("modalImg");
  const modalTimeTag = document.getElementById("modalTimeTag");
  const modalClose = document.getElementById("modalClose");
  const btnSaveFrame = document.getElementById("btnSaveFrame");

  let currentTab = null;
  let activeModalData = null;
  let refreshTimer = null;
  let lastRenderHash = "";

  function showToast(message, duration = 2200) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    setTimeout(() => {
      toastEl.classList.remove("show");
    }, duration);
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return "流媒体 / 动态全片";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
    return mb.toFixed(2) + " MB";
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs.length > 0) {
    currentTab = tabs[0];
    pageTitleEl.textContent = currentTab.title || currentTab.url || "正在连接网页...";
  } else {
    pageTitleEl.textContent = "无法获取当前网页";
    statusTextEl.textContent = "未找到活动标签页 (T_T)";
    return;
  }

  // 加载数据
  function loadMediaData(silent = false) {
    if (!currentTab) return;

    if (!silent) {
      statusTextEl.textContent = "正在捕捉完整视频信号中喵... (✧ω✧)";
    }

    chrome.runtime.sendMessage(
      { action: "getMedia", tabId: currentTab.id },
      (response) => {
        if (chrome.runtime.lastError || !response) return;

        const media = response.media || [];
        const frames = response.frames || [];
        const chunkCount = response.chunkCount || 0;
        const pageTitle = response.pageTitle || currentTab.title;

        if (pageTitle && pageTitleEl.textContent !== pageTitle) {
          pageTitleEl.textContent = pageTitle;
        }

        const currentHash = JSON.stringify({
          count: media.length,
          urls: media.map(m => m.url),
          framesCount: frames.length,
          chunkCount: chunkCount,
          lastFrameTime: frames.length > 0 ? frames[frames.length - 1].timeStr : ""
        });

        if (currentHash === lastRenderHash) return;
        lastRenderHash = currentHash;

        if (media.length === 0) {
          renderEmptyState(chunkCount);
        } else {
          renderMediaList(media, frames);
        }
      }
    );
  }

  // 渲染正在捕捉中
  function renderEmptyState(chunkCount) {
    statusTextEl.textContent = "正在捕捉完整视频中喵... (✧ω✧)";
    
    let chunkHint = "";
    if (chunkCount > 0) {
      chunkHint = `<div style="margin-top: 6px; color: #FF6B8B; font-weight: 600;">已自动帮您过滤了 ${chunkCount} 个碎片切片，正在锁定完整总流！</div>`;
    }

    mediaListEl.innerHTML = `
      <div class="empty-box">
        <div class="empty-radar-wrap">
          <div class="empty-kaomoji">(✧ω✧)</div>
          <div class="empty-ripple"></div>
        </div>
        <div class="empty-title">🌸 正在全力锁定完整视频总流...</div>
        <div class="empty-desc">
          喵喵已开启<b>【智能碎片过滤系统】</b>，会自动屏蔽几MB的短切片碎片，只为您捕获整部完整视频喵！(o^▽^o)<br>
          ${chunkHint}
          <div style="margin-top: 6px;">💡 <b>提示：</b>请在网页中点击<b>播放视频</b>，视频一旦缓冲即可抓取完整流！</div>
        </div>
      </div>
    `;
  }

  // 渲染完整视频列表
  function renderMediaList(mediaList, globalFrames) {
    statusTextEl.textContent = `✨ 成功锁定 ${mediaList.length} 个完整视频总流！(o^▽^o)`;
    mediaListEl.innerHTML = "";

    mediaList.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "media-card";

      const isM3U8 = item.isM3U8;
      const tagClass = isM3U8 ? "badge-m3u8" : "badge-mp4";
      const tagText = isM3U8 ? "🌸 完整全片流媒体 (m3u8)" : `🎀 完整视频文件 (.${item.ext.toUpperCase()})`;

      const frames = (item.frames && item.frames.length > 0) ? item.frames : globalFrames;

      // 切片状态提示
      let streamHint = "";
      if (isM3U8) {
        streamHint = `
          <div class="full-stream-banner">
            <span>✨ <b>整部完整视频</b> · 已自动过滤短小碎片</span>
            ${item.chunkCount ? `<span class="chunk-badge">📶 持续缓冲中 (${item.chunkCount} 切片)</span>` : ""}
          </div>
        `;
      }

      // 多帧截屏
      let framesHtml = "";
      if (frames && frames.length > 0) {
        const frameItems = frames.map((f, fIdx) => `
          <div class="frame-card" data-idx="${fIdx}" title="点击放大/保存第 ${f.timeStr} 帧截屏">
            <img class="frame-img" src="${f.dataUrl}" alt="帧 ${f.timeStr}">
            <span class="frame-time-tag">⏱️ ${f.timeStr}</span>
          </div>
        `).join("");

        framesHtml = `
          <div class="frames-section">
            <div class="frames-header">
              <span>🎬 精彩多帧截屏预览 (${frames.length} 帧)</span>
              <button class="btn-snap" id="btnSnap_${index}">📸 抓拍当前帧</button>
            </div>
            <div class="frames-scroll">${frameItems}</div>
          </div>
        `;
      } else {
        framesHtml = `
          <div class="frames-section">
            <div class="frames-header">
              <span>🎬 精彩多帧截屏预览</span>
              <button class="btn-snap" id="btnSnap_${index}">📸 抓拍当前画面</button>
            </div>
            <div class="frames-empty-hint">📸 正在抓拍带时间参数的截屏中 (播放时会自动采样喵~)</div>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="card-header">
          <span class="badge-tag ${tagClass}">${tagText}</span>
          <span class="media-size">${isM3U8 ? "完整片源" : formatSize(item.size)}</span>
        </div>
        ${streamHint}
        <div class="card-body">
          <div class="file-name" title="${item.suggestedFilename}">${item.suggestedFilename}</div>
          <div class="url-preview" title="${item.url}">${item.url}</div>
        </div>
        ${framesHtml}
        <div class="card-actions">
          <button class="btn btn-primary btn-download" data-index="${index}">
            <span>🌸</span> ${isM3U8 ? "一键合并下载整部视频" : "一键下载完整视频"}
          </button>
          <button class="btn btn-secondary btn-copy" data-index="${index}">
            <span>📋</span> 复制整片直链
          </button>
        </div>
      `;

      // 绑定多帧点击预览
      const frameCards = card.querySelectorAll(".frame-card");
      frameCards.forEach((fc) => {
        fc.addEventListener("click", () => {
          const fIdx = parseInt(fc.getAttribute("data-idx"), 10);
          const fData = frames[fIdx];
          if (fData) openImageModal(fData, item.suggestedFilename);
        });
      });

      // 绑定即时抓拍
      const btnSnap = card.querySelector(`#btnSnap_${index}`);
      if (btnSnap) {
        btnSnap.addEventListener("click", () => triggerInstantSnap(btnSnap));
      }

      // 绑定下载
      const btnDownload = card.querySelector(".btn-download");
      btnDownload.addEventListener("click", () => handleDownload(item));

      // 绑定复制链接
      const btnCopy = card.querySelector(".btn-copy");
      btnCopy.addEventListener("click", () => handleCopy(item.url));

      mediaListEl.appendChild(card);
    });
  }

  // 抓拍当前帧
  function triggerInstantSnap(btn) {
    if (!currentTab) return;
    btn.textContent = "📸 抓拍中...";
    chrome.tabs.sendMessage(currentTab.id, { action: "captureCurrentFrameNow" }, (res) => {
      btn.textContent = "📸 抓拍当前帧";
      if (res && res.success) {
        showToast(`✨ 成功截取 [${res.frame.timeStr}] 画面喵！`);
        loadMediaData(true);
      } else {
        showToast("未能截到画面，请确保网页视频正在播放哦喵~");
      }
    });
  }

  // 大图预览
  function openImageModal(frameData, videoTitle) {
    activeModalData = { ...frameData, videoTitle };
    modalImg.src = frameData.dataUrl;
    modalTimeTag.textContent = `⏱️ 视频时间参数: ${frameData.timeStr}`;
    imageModal.classList.add("show");
  }

  modalClose.addEventListener("click", () => imageModal.classList.remove("show"));
  imageModal.addEventListener("click", (e) => {
    if (e.target === imageModal) imageModal.classList.remove("show");
  });

  btnSaveFrame.addEventListener("click", () => {
    if (!activeModalData) return;
    const cleanTitle = (activeModalData.videoTitle || "视频截屏").replace(/\.[^/.]+$/, "");
    const filename = `${cleanTitle}_帧_${activeModalData.timeStr.replace(/:/g, "-")}.jpg`;
    
    chrome.downloads.download({
      url: activeModalData.dataUrl,
      filename: filename,
      saveAs: true
    }, () => {
      showToast("💾 截屏图片已保存喵！");
      imageModal.classList.remove("show");
    });
  });

  // 处理下载
  function handleDownload(item) {
    if (item.isM3U8) {
      // 打开整片切片合并下载姬
      const downloaderUrl = chrome.runtime.getURL("downloader.html") + 
        `?url=${encodeURIComponent(item.url)}&title=${encodeURIComponent(item.suggestedFilename.replace(/\.m3u8$/i, ""))}`;
      chrome.tabs.create({ url: downloaderUrl });
      showToast("🌸 已打开整片切片合并下载姬！(｡♥‿♥｡)");
    } else {
      chrome.runtime.sendMessage(
        { action: "download", url: item.url, filename: item.suggestedFilename },
        (res) => {
          if (res && res.success) {
            showToast("✨ 开始下载完整视频啦！可在浏览器下载中查看~");
          } else {
            showToast("下载出错：" + (res?.error || "未知错误"));
          }
        }
      );
    }
  }

  // 复制直链
  function handleCopy(url) {
    navigator.clipboard.writeText(url).then(() => {
      showToast("📋 完整全片直链已复制！粘贴到 PotPlayer 即可完整观看喵~");
    }).catch(() => {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      showToast("📋 复制成功喵！可以直接丢进 PotPlayer 播放~");
    });
  }

  // 刷新
  btnRefresh.addEventListener("click", () => {
    btnRefresh.style.transform = "rotate(360deg)";
    setTimeout(() => { btnRefresh.style.transform = ""; }, 400);
    lastRenderHash = "";
    loadMediaData();
    showToast("🔄 已极速重新扫描信号喵~");
  });

  // 广播监听
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "mediaListUpdated" || msg.action === "framesUpdated") {
      if (currentTab && msg.tabId === currentTab.id) {
        loadMediaData(true);
      }
    }
  });

  // 轮询
  loadMediaData();
  refreshTimer = setInterval(() => { loadMediaData(true); }, 650);

  window.addEventListener("unload", () => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
});
