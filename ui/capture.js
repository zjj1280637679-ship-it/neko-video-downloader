// Pure capture feedback: request evidence is separate from playback observations.
(function (root) {
  function captureFeedback(capture, mediaCount, checkingStartedAt, now = Date.now()) {
    const { phase, playback } = capture;
    if (phase === "found") {
      const playbackLabel = playback.playing ? "正在播放" : playback.observed ? "已播放" : playback.hasVideo && !playback.uncertain ? "尚未播放" : "播放状态未确认";
      return { state: "ready", status: `已发现 ${mediaCount} 个来源 · ${playbackLabel}` };
    }
    if (phase === "waiting") return { state: "waiting", status: "等待播放 · 请先在网页点击播放", title: "点击播放，开始识别", description: "已找到播放器，尚未观察到播放。请先在网页点击播放按钮。", hint: "出现视频来源后，即可在这里下载。" };
    if (phase === "sniffing") return { state: "sniffing", status: "已播放 · 正在识别视频来源…", title: "正在识别视频来源", description: capture.chunkCount ? "已检测到分段请求，正在等待可下载的播放清单。" : "已确认视频开始播放，正在查看播放器发出的视频请求。", hint: "若暂未找到来源，会在约 10 秒后显示结果。" };
    if (phase === "no-source") return { state: "no-source", status: "已播放 · 暂未识别到可下载来源", title: "这次还没有找到来源", description: "已观察到播放，但暂未找到可下载的视频地址。", hint: "可切换播放线路，或刷新网页后重新播放。" };
    if (phase === "no-video") return { state: "no-video", status: "暂未检测到播放器", title: "当前网页还没有播放器", description: "请打开视频播放页面，或等待网页加载播放器。", hint: "下载任务仍可在右侧页签查看。" };
    if (phase === "unavailable") return { state: "unavailable", status: "当前页面不支持视频识别", title: "切换到视频网页", description: "浏览器内部页面无法识别视频。打开一个视频网页后，再打开扩展。", hint: "已有下载会继续运行。" };
    if (phase === "error") return { state: "error", status: "读取失败，点击右上角重新读取", title: "暂时无法重新识别", description: "点击右上角重新读取，扩展会重新连接当前网页。", hint: capture.error || "" };
    if (now - checkingStartedAt >= 5000) return { state: "unconfirmed", status: "播放器状态尚未确认", title: "还未确认播放器状态", description: "可以先播放视频，或点击右上角重新读取。", hint: "嵌入式播放器可能无法立即确认播放状态。" };
    return { state: "checking", status: "正在确认播放器状态…", title: "正在查看当前网页", description: "正在确认播放器和可用的视频来源。", hint: "" };
  }
  root.NekoCapture = Object.freeze({ captureFeedback });
  if (typeof module === "object") module.exports = root.NekoCapture;
})(globalThis);
