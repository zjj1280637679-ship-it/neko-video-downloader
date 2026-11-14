// Explain observed facts, never infer playback or download success from detection.
(function (root) {
  const sites = typeof module === 'object' && module.exports ? require('../domain/sites.js') : root.NekoSites;
  const stateLabels = Object.freeze({ queued: "等待下载", parsing: "解析来源", downloading: "下载中", muxing: "合并音视频", saving: "正在保存", complete: "已保存", interrupted: "下载中断", cancelled: "已取消" });
  function jobConcurrency(job) {
    // Queued jobs have no running requests yet, but retain the live desired
    // setting. A terminal zero instead means that no concurrency remains.
    const queuedWithoutTarget = job.state === "queued" && job.targetConcurrency === 0;
    const value = !queuedWithoutTarget && Number.isInteger(job.targetConcurrency) ? job.targetConcurrency : Number.isInteger(job.concurrency) ? job.concurrency : job.activeConcurrency;
    return Number.isInteger(value) && value >= 1 && value <= 375 ? value : null;
  }
  function concurrencyReason() { return "请求并行，文件按序写入。"; }
  function jobExplanation(job) {
    const site = sites.forJob(job);
    const native = Boolean(site);
    const hls = !native && (job.isM3U8 === true || job.totalSegments > 0);
    const segmented = native ? job.segmented === true : hls;
    const phases = {
      queued: "任务已登记，等待启动。", parsing: native ? `正在解析 ${site.label} 视频与可用音视频格式。` : "正在检查播放清单和分片条件。",
      downloading: native ? segmented ? "分片按实时目标并发获取，各轨道按顺序写入。" : "本机内核正在下载音视频，非分片传输不受滑块影响。" : hls ? "分片可同时获取，文件按原始顺序合并。" : "Chrome 正在处理视频文件下载。",
      muxing: "正在合并画面和声音，并检查成品；尚未保存完成。",
      saving: "数据已交给保存流程，正在等待 Chrome 确认结果。",
      complete: "Chrome 已确认下载完成。", interrupted: "下载尚未完成；可按提示继续或重新下载。",
      cancelled: "任务已取消，未报告保存成功。"
    };
    const target = jobConcurrency(job);
    const concurrency = segmented
      ? `${target !== null ? `并发 ${target}。` : ""}${concurrencyReason()}`
      : native ? job.segmented === false ? "非分片传输按正常方式下载，不受滑块影响。" : "解析完成后确认是否使用分片传输。" : "由 Chrome 管理连接与传输。";
    return {
      source: native ? `${site.label} 视频页面${site.id === 'bilibili' && Number.isSafeInteger(job.page) ? ` · P${job.page}` : ''}` : hls ? "HLS 播放清单" : "HTTP(S) 视频链接",
      quality: job.qualityLabel ? `${job.qualityLabel}${job.qualityReason ? `。${job.qualityReason}` : ""}` : "",
      phase: job.stateReason || (job.state === "queued" && job.queuePosition > 0 ? `排队第 ${job.queuePosition} 位，等待正在进行的任务释放资源。` : phases[job.state]) || "正在读取任务状态。",
      order: native ? "解析格式 → 获取音视频 → 合并检查 → Chrome 保存确认" : hls ? "解析清单 → 并行获取 → 按序合并 → 保存确认" : "交给 Chrome 下载 → 保存确认",
      concurrency: segmented ? `视频任务逐个处理，分片在任务内并行。${concurrency}` : concurrency,
      result: job.state === "complete" ? "已保存，可在文件夹中查看。" : "尚未确认保存完成。"
    };
  }
  const api = Object.freeze({ stateLabels, concurrencyReason, jobConcurrency, jobExplanation });
  root.NekoExplain = api;
  if (typeof module === "object") module.exports = api;
})(globalThis);
