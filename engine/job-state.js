/* Pure job protocol: one attempt, monotonic snapshots, explicit terminal states. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NekoJobState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ACTIVE = Object.freeze(['queued', 'parsing', 'downloading', 'saving']);
  const TERMINAL = Object.freeze(['complete', 'interrupted', 'cancelled']);
  const STATES = Object.freeze([...ACTIVE, ...TERMINAL]);
  const LIMITS = Object.freeze({ jobs: 10, hlsJobs: 1, segments: 375, history: 20 });
  const isTerminal = state => TERMINAL.includes(state);
  function canAdvance(from, to) {
    if (!STATES.includes(from) || !STATES.includes(to)) return false;
    if (from === to) return true;
    if (isTerminal(from)) return false; // A retry explicitly creates a new runId.
    return isTerminal(to) || ACTIVE.indexOf(to) >= ACTIVE.indexOf(from);
  }
  function accepts(job, incoming) {
    if (!job || !incoming || isTerminal(job.state)) return false;
    if (job.runId && incoming.runId !== job.runId) return false;
    if (!canAdvance(job.state, incoming.state)) return false;
    if (job.runId && (!Number.isSafeInteger(incoming.revision) || incoming.revision < 1)) return false;
    return !Number.isSafeInteger(incoming.revision) || incoming.revision > (job.progressRevision || 0);
  }
  function describe(job) {
    const descriptions = {
      queued: job.isM3U8 ? '等待前一个 HLS 任务释放写盘与保存资源' : '正在交给 Chrome 创建下载',
      parsing: '读取播放清单，确认分片、加密方式与输出格式',
      downloading: job.isM3U8 ? '分片并行获取，按照播放顺序逐个写入' : 'Chrome 正在下载原始文件',
      saving: '正在保存文件，等待 Chrome 确认完成',
      complete: 'Chrome 已确认文件保存完成',
      interrupted: job.resumable ? '下载中断，已校验的分片可继续使用' : '下载中断，请查看错误原因',
      cancelled: '任务已取消'
    };
    return descriptions[job.state] || '状态待确认';
  }
  return { ACTIVE, TERMINAL, STATES, LIMITS, isTerminal, canAdvance, accepts, describe };
});
