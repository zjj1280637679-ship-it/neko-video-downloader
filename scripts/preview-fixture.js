// This adapter is injected ONLY by scripts/preview.cjs.
(() => {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('case') || 'source';
  const listeners = new Set();
  let settings = { concurrency: 64 };
  const settingsKey = 'yangmo-preview-manual-settings';
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || 'null');
    if (saved && typeof saved === 'object') settings = { concurrency: Number.isInteger(saved.concurrency) && saved.concurrency >= 1 && saved.concurrency <= 375 ? saved.concurrency : 64 };
  } catch {}
  const media = ['empty', 'error'].includes(scenario) ? [] : [{ id: 'demo-source', url: 'https://media.example.test/video/index.m3u8?signature=hidden',
    name: '第1集', title: '窗边的小旅行', suggestedFilename: '窗边的小旅行_第1集.m3u8', isM3U8: true, ext: 'm3u8',
    mime: 'application/vnd.apple.mpegurl', active: true, source: 'dom', evidence: ['dom-selection', 'network-mime'], timestamp: Date.now() }];
  const jobs = scenario === 'jobs' ? [{ id: 'demo-job', title: '窗边的小旅行 · 第1集', url: media[0].url, isM3U8: true,
    state: 'downloading', bytesReceived: 52428800, totalBytes: 0, completedSegments: 180, totalSegments: 576,
    bytesPerSecond: 3145728, concurrency: settings.concurrency, targetConcurrency: settings.concurrency,
    etaSeconds: 124, etaBasis: 'network-segments',
    updatedAt: Date.now(), stateReason: '并行获取分片，按清单顺序写入。' }, {
    id: 'demo-queued', title: '窗边的小旅行 · 第2集', url: 'https://media.example.test/video/episode-2.m3u8', isM3U8: true,
    state: 'queued', concurrency: settings.concurrency, targetConcurrency: 0, queuePosition: 1, updatedAt: Date.now() - 1
    }] : scenario === 'error' ? [{
      id: 'demo-error', title: '窗边的小旅行', state: 'interrupted', isM3U8: true,
      url: 'https://media.example.test/index.m3u8', bytesReceived: 12582912, cachedSegments: 48, totalSegments: 576,
      resumable: true, error: '来源暂时无法连接；已保留校验通过的分片。', updatedAt: Date.now()
    }] : [];
  // Optional visual fixtures keep progress truthful without any animation timer.
  if (scenario === 'jobs') {
    const job = jobs[0], progress = Number(params.get('progress'));
    if (params.has('progress') && Number.isFinite(progress)) job.completedSegments = Math.floor(job.totalSegments * Math.max(0, Math.min(100, progress)) / 100);
    if (params.get('unknown') === '1') { job.totalSegments = 0; job.completedSegments = 0; }
    if (['queued', 'parsing', 'downloading', 'saving', 'complete', 'interrupted', 'cancelled'].includes(params.get('state'))) job.state = params.get('state');
    if (params.get('cancel') === '1') job.cancelRequested = true;
  }
  const notify = () => listeners.forEach(fn => fn({ action: 'jobsUpdated' }));
  window.chrome = { runtime: { lastError: null, onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    sendMessage(message, callback) {
      let response = { success: true };
      switch (message.action) {
        case 'getMedia': case 'refreshMedia': response = { media, capturePhase: media.length ? 'found' : 'waiting', playback: { hasVideo: true, observed: media.length > 0 } }; break;
        case 'getJobs': response.jobs = jobs; break;
        case 'getSettings': response.settings = settings; break;
        case 'saveSettings': {
          settings = { concurrency: message.settings.concurrency };
          try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch {}
          for (const job of jobs) if (job.isM3U8 && ['queued', 'parsing', 'downloading', 'saving'].includes(job.state)) {
            job.concurrency = settings.concurrency; job.targetConcurrency = settings.concurrency;
          }
          response.settings = settings; response.liveApplied = true; break;
        }
        case 'startDownload': response.job = { ...message, concurrency: settings.concurrency, targetConcurrency: settings.concurrency, id: 'preview-' + Date.now(), state: 'queued', updatedAt: Date.now() }; jobs.unshift(response.job); break;
        case 'cancelJob': { const job = jobs.find(j => j.id === message.jobId); if (job) Object.assign(job, { state: 'cancelled', cancelRequested: true }); response.job = job; break; }
        case 'removeJob': { const index = jobs.findIndex(j => j.id === message.jobId); if (index >= 0 && ['complete', 'interrupted', 'cancelled'].includes(jobs[index].state)) jobs.splice(index, 1); else if (index >= 0) response = { success: false, error: '请先取消任务' }; response.jobId = message.jobId; break; }
        case 'retryJob': { const job = jobs.find(j => j.id === message.jobId); if (job) Object.assign(job, { state: 'queued', cancelRequested: false, concurrency: settings.concurrency, targetConcurrency: settings.concurrency }); response.job = job; break; }
        case 'discardJob': { const job = jobs.find(j => j.id === message.jobId); if (job) job.resumable = false; break; }
      }
      callback(response); if (!message.action.startsWith('get')) queueMicrotask(notify);
    } },
    tabs: { query: async () => [{ id: 1, url: 'https://example.test/watch' }] }
  };
})();
