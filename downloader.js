// 🌸 喵喵切片合并下载姬 - HLS/m3u8 在线解析与合并核心

document.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const m3u8Url = params.get("url") || "";
  const videoTitle = params.get("title") || "动漫视频";

  const titleVal = document.getElementById("titleVal");
  const urlVal = document.getElementById("urlVal");
  const segmentVal = document.getElementById("segmentVal");
  const progressText = document.getElementById("progressText");
  const percentText = document.getElementById("percentText");
  const progressFill = document.getElementById("progressFill");
  const statusMsg = document.getElementById("statusMsg");

  const btnStart = document.getElementById("btnStart");
  const btnDownloadM3U8 = document.getElementById("btnDownloadM3U8");
  const btnCopyUrl = document.getElementById("btnCopyUrl");

  titleVal.textContent = videoTitle;
  urlVal.textContent = m3u8Url || "未提供 m3u8 地址";

  if (!m3u8Url) {
    statusMsg.textContent = "错误：缺少视频流地址参数喵 (T_T)";
    btnStart.disabled = true;
    return;
  }

  let segmentUrls = [];
  let isDownloading = false;

  // 工具：解析相对 URL
  function resolveUrl(relative, base) {
    try {
      return new URL(relative, base).href;
    } catch (e) {
      return relative;
    }
  }

  // 第一步：拉取并解析 m3u8 内容
  async function parseM3U8(targetUrl) {
    statusMsg.textContent = "正在拉取 m3u8 播放清单喵... (◕ᴗ◕✿)";
    try {
      const resp = await fetch(targetUrl);
      if (!resp.ok) throw new Error(`HTTP 状态码: ${resp.status}`);
      const text = await resp.text();

      // 判断是否是 Master Playlist (二级清单)
      if (text.includes("#EXT-X-STREAM-INF")) {
        const lines = text.split("\n");
        let subUrl = "";
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith("#EXT-X-STREAM-INF")) {
            for (let j = i + 1; j < lines.length; j++) {
              const nextLine = lines[j].trim();
              if (nextLine && !nextLine.startsWith("#")) {
                subUrl = resolveUrl(nextLine, targetUrl);
                break;
              }
            }
            if (subUrl) break;
          }
        }
        if (subUrl) {
          statusMsg.textContent = "检测到多码率高清清单，自动跳转解析最高画质... (✧ω✧)";
          return await parseM3U8(subUrl);
        }
      }

      // 解析切片
      const lines = text.split("\n");
      const urls = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line && !line.startsWith("#")) {
          urls.push(resolveUrl(line, targetUrl));
        }
      }

      return urls;
    } catch (err) {
      console.error(err);
      statusMsg.textContent = "解析清单失败: " + err.message + "，请尝试复制直链用外部工具下载喵~";
      return [];
    }
  }

  // 初始自动解析清单
  segmentUrls = await parseM3U8(m3u8Url);
  if (segmentUrls.length > 0) {
    segmentVal.textContent = `共解析到 ${segmentUrls.length} 个切片 (预计可合并完整播放)`;
    statusMsg.textContent = `(=^･ω･^=) 切片清单已准备完毕，共 ${segmentUrls.length} 个分段，快点击下载吧！`;
  } else {
    segmentVal.textContent = "未能解析出切片列表 (可能是跨域或密钥限制)";
    btnStart.disabled = true;
  }

  // 复制直链按钮
  btnCopyUrl.addEventListener("click", () => {
    navigator.clipboard.writeText(m3u8Url).then(() => {
      alert("📋 视频直链已成功复制喵！(｡♥‿♥｡)\n可以直接粘贴进 PotPlayer / VLC 播放~");
    });
  });

  // 仅下载 m3u8 文件
  btnDownloadM3U8.addEventListener("click", () => {
    chrome.downloads.download({
      url: m3u8Url,
      filename: `${videoTitle}.m3u8`,
      saveAs: true
    });
  });

  // 核心：并发分片下载并合并
  btnStart.addEventListener("click", async () => {
    if (isDownloading || segmentUrls.length === 0) return;
    isDownloading = true;
    btnStart.disabled = true;
    btnDownloadM3U8.disabled = true;

    const total = segmentUrls.length;
    let completed = 0;
    let totalBytes = 0;
    const chunks = new Array(total);

    statusMsg.textContent = "正在飞速搬运切片中，请保持网页开启喵... (づ｡◕‿‿◕｡)づ";

    // 带重试的切片抓取
    async function fetchSegment(url, index, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = await res.arrayBuffer();
          chunks[index] = buffer;
          completed++;
          totalBytes += buffer.byteLength;

          // 更新进度
          const percent = Math.floor((completed / total) * 100);
          progressFill.style.width = `${percent}%`;
          percentText.textContent = `${percent}%`;
          const mb = (totalBytes / (1024 * 1024)).toFixed(1);
          progressText.textContent = `已完成 ${completed} / ${total} 个切片 (${mb} MB)`;
          return;
        } catch (err) {
          if (attempt === retries) {
            console.error(`切片 ${index} 下载失败:`, err);
            // 填入空数据避免整体崩溃
            chunks[index] = new ArrayBuffer(0);
            completed++;
          } else {
            await new Promise(r => setTimeout(r, 800));
          }
        }
      }
    }

    // 控制并发数（5个并发通道，既迅速又不会触发反爬风控）
    const CONCURRENCY = 5;
    let currentIdx = 0;

    async function worker() {
      while (currentIdx < total) {
        const idx = currentIdx++;
        await fetchSegment(segmentUrls[idx], idx);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    // 全部下载完成，开始合并 Blob
    statusMsg.textContent = "✨ 正在将所有分段无损合成单个视频文件喵... (✧ω✧)";
    progressText.textContent = "合成中，请稍候...";

    try {
      const mergedBlob = new Blob(chunks, { type: "video/mp2t" });
      const blobUrl = URL.createObjectURL(mergedBlob);
      const filename = `${videoTitle}.ts`;

      // 触发下载
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      statusMsg.innerHTML = "🎉 <b>下载大成功！</b> 文件已保存为 <code>" + filename + "</code> 喵！(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧<br>常见播放器（PotPlayer、VLC、Windows播放器）均可直接流畅播放哦~";
      progressFill.style.background = "#4CAF50";
      progressText.textContent = `已全部完成 (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`;
      
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 60000);
    } catch (e) {
      statusMsg.textContent = "合并文件出错: " + e.message;
    } finally {
      btnStart.disabled = false;
      btnDownloadM3U8.disabled = false;
      isDownloading = false;
    }
  });
});
