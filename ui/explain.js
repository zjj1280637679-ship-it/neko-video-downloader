// Explain observed facts, never infer playback or download success from detection.
(function (root) {
  const stateLabels = Object.freeze({ queued: "等待下载", parsing: "解析清单", downloading: "下载中", saving: "正在保存", complete: "已保存", interrupted: "下载中断", cancelled: "已取消" });
  function jobConcurrency(job) {
    // Queued jobs have no running requests yet, but retain the live desired
    // setting. A terminal zero instead means that no concurrency remains.
    const queuedWithoutTarget = job.state === "queued" && job.targetConcurrency === 0;
    const value = !queuedWithoutTarget && Number.isInteger(job.targetConcurrency) ? job.targetConcurrency : Number.isInteger(job.concurrency) ? job.concurrency : job.activeConcurrency;
    return Number.isInteger(value) && value >= 1 && value <= 375 ? value : null;
  }
  function concurrencyReason() { return "请求并行，文件按序写入。"; }
  function jobExplanation(job) {
    const hls = job.isM3U8 === true || job.totalSegments > 0;
    const phases = {
      queued: "任务已登记，等待启动。", parsing: "正在检查播放清单和分片条件。",
      downloading: hls ? "分片可同时获取，文件按原始顺序合并。" : "Chrome 正在处理视频文件下载。",
      saving: "数据已交给保存流程，正在等待 Chrome 确认结果。",
      complete: "Chrome 已确认下载完成。", interrupted: "下载尚未完成；可按提示继续或重新下载。",
      cancelled: "任务已取消，未报告保存成功。"
    };
    const target = jobConcurrency(job);
    const concurrency = hls
      ? `${target !== null ? `并发 ${target}。` : ""}${concurrencyReason()}`
      : "由 Chrome 管理连接与传输。";
    return {
      source: hls ? "HLS 播放清单" : "HTTP(S) 视频链接",
      quality: job.qualityLabel ? `${job.qualityLabel}${job.qualityReason ? `。${job.qualityReason}` : ""}` : "",
      phase: job.stateReason || (job.state === "queued" && job.queuePosition > 0 ? `排队第 ${job.queuePosition} 位，等待正在进行的任务释放资源。` : phases[job.state]) || "正在读取任务状态。",
      order: hls ? "解析清单 → 并行获取 → 按序合并 → 保存确认" : "交给 Chrome 下载 → 保存确认",
      concurrency: hls ? `视频任务逐个处理，分片在任务内并行。${concurrency}` : concurrency,
      result: job.state === "complete" ? "已保存，可在文件夹中查看。" : "尚未确认保存完成。"
    };
  }
  const api = Object.freeze({ stateLabels, concurrencyReason, jobConcurrency, jobExplanation });
  root.NekoExplain = api;
  if (typeof module === "object") module.exports = api;
})(globalThis);
