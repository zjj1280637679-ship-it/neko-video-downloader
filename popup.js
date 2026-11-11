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

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

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
      statusTextEl.textContent = "正在读取媒体和播放器... (✧ω✧)";
    }

    chrome.runtime.sendMessage(
      { action: "getMedia", tabId: currentTab.id },
      (response) => {
        if (chrome.runtime.lastError || !response) return;

        const media = response.media || [];
        const frames = response.frames || [];
        const players = response.players || [];
        const chunkCount = response.chunkCount || 0;
        const pageTitle = response.pageTitle || currentTab.title;

        if (pageTitle && pageTitleEl.textContent !== pageTitle) {
          pageTitleEl.textContent = pageTitle;
        }

        const currentHash = JSON.stringify({
          count: media.length,
          media: media.map((m) => [m.url, m.size, m.suggestedFilename, m.isM3U8, m.ext, m.mime,
            (m.frames || []).map((f) => [f.id || f.timestamp, f.sourceMatched])]),
          players: players.map((p) => [p.frameId, p.documentId, p.videoId, p.sourceUrl, p.title,
            p.isPlaying, p.width, p.height, (p.frames || []).map((f) => f.id || f.timestamp)]),
          chunkCount: chunkCount,
          lastFrameTime: frames.length > 0 ? frames[frames.length - 1].timeStr : ""
        });

        if (currentHash === lastRenderHash) return;
        lastRenderHash = currentHash;

        if (media.length === 0 && players.length === 0) {
          renderEmptyState(chunkCount);
        } else {
          renderMediaList(media, players);
        }
      }
    );
  }

  // 渲染正在捕捉中
  function renderEmptyState(chunkCount) {
    statusTextEl.textContent = "尚未发现媒体和播放器 (✧ω✧)";
    
    let chunkHint = "";
    if (chunkCount > 0) {
      chunkHint = `<div style="margin-top: 6px; color: #FF6B8B; font-weight: 600;">已识别 ${chunkCount} 个分片，正在等待媒体清单或视频资源。</div>`;
    }

    mediaListEl.innerHTML = `
      <div class="empty-box">
        <div class="empty-radar-wrap">
          <div class="empty-kaomoji">(✧ω✧)</div>
          <div class="empty-ripple"></div>
        </div>
        <div class="empty-title">🌸 正在等待视频资源或播放器...</div>
        <div class="empty-desc">
          尚未发现可下载的媒体或网页播放器。已识别的分片会合并计数，不占用视频卡片。<br>
          ${chunkHint}
          <div style="margin-top: 6px;">💡 <b>提示：</b>请在网页中点击<b>播放视频</b>，再查看媒体和播放器列表。</div>
        </div>
      </div>
    `;
  }

  // 渲染完整视频列表
  function renderMediaList(mediaList, players) {
    statusTextEl.textContent = `✨ 发现 ${mediaList.length} 个媒体 · ${players.length} 个播放器`;
    const scrollPositions = new Map([...mediaListEl.querySelectorAll(".media-card")].map((card) => [card.dataset.mediaId, card.querySelector(".frames-scroll")?.scrollLeft || 0]));
    mediaListEl.innerHTML = "";

    mediaList.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "media-card";
      card.dataset.mediaId = item.id;

      const isM3U8 = item.isM3U8;
      const tagClass = isM3U8 ? "badge-m3u8" : "badge-mp4";
      const tagText = isM3U8 ? "🌸 视频流清单 (m3u8)" : `🎀 媒体文件 (.${item.ext.toUpperCase()})`;

      const frames = item.frames || [];

      // 切片状态提示
      let streamHint = "";
      if (isM3U8) {
        streamHint = `
          <div class="full-stream-banner">
            <span>✨ <b>HLS 视频流</b> · 已识别分片单独计数</span>
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
              <span>🎬 ${frames.some((frame) => frame.sourceMatched === false) ? "当前播放器画面" : "多帧截屏预览"} (${frames.length} 帧)</span>
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
          <span class="media-size">${isM3U8 ? "HLS 清单" : formatSize(item.size)}</span>
        </div>
        ${streamHint}
        <div class="card-body">
          <div class="file-name" title="${escapeHtml(item.suggestedFilename)}">${escapeHtml(item.suggestedFilename)}</div>
          <div class="url-preview" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
        </div>
        ${framesHtml}
        <div class="card-actions">
          <button class="btn btn-primary btn-download" data-index="${index}">
            <span>🌸</span> ${isM3U8 ? "合并下载视频" : "下载媒体文件"}
          </button>
          <button class="btn btn-secondary btn-copy" data-index="${index}">
            <span>📋</span> 复制媒体链接
          </button>
        </div>
      `;

      // 绑定多帧点击预览
      const frameCards = card.querySelectorAll(".frame-card");
      frameCards.forEach((fc) => {
        fc.addEventListener("click", () => {
          const fIdx = parseInt(fc.getAttribute("data-idx"), 10);
          const fData = frames[fIdx];
          if (fData) openImageModal(fData, fData.sourceMatched === false ? "当前播放器截图" : item.suggestedFilename);
        });
      });

      // 绑定即时抓拍
      const btnSnap = card.querySelector(`#btnSnap_${index}`);
      if (btnSnap) {
        btnSnap.addEventListener("click", () => triggerInstantSnap(btnSnap, item));
      }

      // 绑定下载
      const btnDownload = card.querySelector(".btn-download");
      btnDownload.addEventListener("click", () => handleDownload(item));

      // 绑定复制链接
      const btnCopy = card.querySelector(".btn-copy");
      btnCopy.addEventListener("click", () => handleCopy(item.url));

      mediaListEl.appendChild(card);
      const gallery = card.querySelector(".frames-scroll");
      if (gallery) gallery.scrollLeft = scrollPositions.get(item.id) || 0;
    });

    // 无下载直链的 blob/srcObject 也有自己的原图入口；相同直链的多个播放器可逐个选择。
    const independentPlayers = players.filter((player) => !mediaList.some((item) => item.url === player.sourceUrl) ||
      players.filter((candidate) => candidate.sourceUrl === player.sourceUrl).length > 1);
    independentPlayers.forEach((player, index) => {
      const card = document.createElement("div");
      card.className = "media-card player-card";
      card.dataset.playerKey = JSON.stringify([player.frameId, player.documentId, player.videoId]);
      card.dataset.mediaId = "player:" + card.dataset.playerKey;
      const title = `播放器 ${index + 1}`;
      const frames = player.frames || [];
      const frameItems = frames.map((frame, frameIndex) => `
        <div class="frame-card" data-idx="${frameIndex}" title="查看和保存 ${escapeHtml(frame.timeStr)} 原图">
          <img class="frame-img" src="${escapeHtml(frame.dataUrl)}" alt="帧 ${escapeHtml(frame.timeStr)}">
          <span class="frame-time-tag">⏱️ ${escapeHtml(frame.timeStr)}</span>
        </div>`).join("");
      card.innerHTML = `
        <div class="card-header">
          <span class="badge-tag badge-mp4">🎬 ${title}</span>
          <span class="media-size">${player.isPlaying ? "播放中" : "已暂停"}${player.width && player.height ? ` · ${player.width} × ${player.height}` : ""}</span>
        </div>
        <div class="card-body">
          <div class="file-name" title="${escapeHtml(player.title || title)}">${escapeHtml(player.title || title)}</div>
          <div class="url-preview" title="${escapeHtml(player.sourceUrl || "此播放器没有可下载的直链")}">${escapeHtml(player.sourceUrl || "此播放器没有可下载的直链")}</div>
        </div>
        <div class="frames-section">
          <div class="frames-header">
            <span>🎬 播放器画面${frames.length ? ` (${frames.length} 帧)` : ""}</span>
            <button class="btn-snap btn-player-snap">📸 抓拍此播放器</button>
          </div>
          ${frames.length ? `<div class="frames-scroll">${frameItems}</div>` : '<div class="frames-empty-hint">播放视频后可抓拍原尺寸画面</div>'}
        </div>`;
      card.querySelectorAll(".frame-card").forEach((frameCard) => {
        frameCard.addEventListener("click", () => openImageModal(frames[Number(frameCard.getAttribute("data-idx"))], title + "截图"));
      });
      const snap = card.querySelector(".btn-player-snap");
      snap.addEventListener("click", () => triggerInstantSnap(snap, { url: player.sourceUrl, suggestedFilename: title + "截图" }, player));
      mediaListEl.appendChild(card);
      const gallery = card.querySelector(".frames-scroll");
      if (gallery) gallery.scrollLeft = scrollPositions.get(card.dataset.mediaId) || 0;
    });
  }

  // 抓拍当前帧
  function triggerInstantSnap(btn, item, player = null) {
    if (!currentTab) return;
    btn.textContent = "📸 抓拍中...";
    const target = player ? { frameId: player.frameId, documentId: player.documentId, videoId: player.videoId } : {};
    chrome.runtime.sendMessage({ action: "captureCurrentFrame", tabId: currentTab.id, sourceUrl: item.url, ...target }, (res) => {
      btn.textContent = player ? "📸 抓拍此播放器" : "📸 抓拍当前帧";
      const error = chrome.runtime.lastError;
      if (!error && res && res.success) {
        showToast(`✨ 已截取${res.sourceMatched ? "" : "当前播放器"} [${res.frame.timeStr}] 画面喵！`);
        loadMediaData(true);
        openImageModal(res.frame, player || res.sourceMatched ? item.suggestedFilename : "当前播放器截图");
      } else {
        showToast(error?.message || res?.error || "未能截到画面，请先播放视频后重试", 4000);
        if (res?.candidates?.length) {
          const keys = new Set(res.candidates.map((candidate) => JSON.stringify([candidate.frameId, candidate.documentId, candidate.videoId])));
          [...mediaListEl.querySelectorAll(".player-card")].find((card) => keys.has(card.dataset.playerKey))?.scrollIntoView?.({ block: "nearest" });
        }
      }
    });
  }

  // 大图预览
  function openImageModal(frameData, videoTitle) {
    activeModalData = { ...frameData, videoTitle };
    const selected = activeModalData;
    modalImg.src = frameData.originalDataUrl || frameData.dataUrl;
    btnSaveFrame.disabled = !frameData.originalDataUrl;
    modalTimeTag.textContent = `⏱️ ${frameData.timeStr} · ${frameData.originalDataUrl ? `${frameData.width} × ${frameData.height}` : "正在读取原图…"}`;
    imageModal.classList.add("show");
    if (frameData.originalDataUrl) return;
    chrome.runtime.sendMessage({ action: "getCapturedFrame", tabId: currentTab.id, captureId: frameData.id }, (res) => {
      const error = chrome.runtime.lastError;
      if (activeModalData !== selected) return;
      if (!error && res?.success && res.frame.originalDataUrl) {
        Object.assign(selected, res.frame);
        modalImg.src = selected.originalDataUrl;
        modalTimeTag.textContent = `⏱️ ${selected.timeStr} · ${selected.width} × ${selected.height}`;
        btnSaveFrame.disabled = false;
      } else {
        modalTimeTag.textContent = `${frameData.timeStr} · 原图已失效，请重新抓拍`;
        showToast(error?.message || res?.error || "原图已失效，请重新抓拍", 4000);
      }
    });
  }

  modalClose.addEventListener("click", () => imageModal.classList.remove("show"));
  imageModal.addEventListener("click", (e) => {
    if (e.target === imageModal) imageModal.classList.remove("show");
  });

  btnSaveFrame.addEventListener("click", () => {
    if (!activeModalData?.originalDataUrl) return;
    const cleanTitle = (activeModalData.videoTitle || "视频截屏").replace(/\.[^/.]+$/, "");
    const filename = `${cleanTitle}_帧_${activeModalData.timeStr.replace(/:/g, "-")}.jpg`;
    
    chrome.downloads.download({
      url: activeModalData.originalDataUrl,
      filename: filename,
      saveAs: true
    }, () => {
      if (chrome.runtime.lastError) showToast("保存未完成：" + chrome.runtime.lastError.message, 4000);
      else { showToast("💾 已提交原尺寸截图下载喵！"); imageModal.classList.remove("show"); }
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
            showToast("✨ 已提交媒体下载，可在浏览器下载中查看~");
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
      showToast("📋 媒体链接已复制！");
    }).catch(() => {
      const input = document.createElement("input");
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      showToast("📋 媒体链接已复制！");
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
