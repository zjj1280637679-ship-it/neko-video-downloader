/* MV3 coordinator. Media work runs offscreen; only this worker uses downloads. */
(() => {
  'use strict';
  if (!globalThis.NekoJobState && typeof importScripts === 'function') importScripts('engine/job-state.js');
  const jobState = globalThis.NekoJobState;
  const JOBS_KEY = 'neko_jobs_v1';
  const SETTINGS_KEY = 'neko_settings_v1';
  const CONCURRENCY_REVISION_KEY = 'neko_concurrency_revision_v1';
  const terminal = new Set(jobState.TERMINAL);
  const jobs = new Map();
  const dispatching = new Set();
  const saving = new Map();
  const retrying = new Map();
  const discarding = new Map();
  const removing = new Map();
  const pendingWrites = new WeakMap();
  let creating, reconciling, saveChain = Promise.resolve(), settingsChain = Promise.resolve();
  // Local metadata outlives the browser session; OPFS holds verified media bytes.
  // Session is retained as a compatibility mirror for the 1.x upgrade.
  const ready = Promise.all([chrome.storage.session.get(JOBS_KEY), chrome.storage.local.get(JOBS_KEY)]).then(([session, local]) => {
    // An empty durable array is authoritative too: a stale session mirror must
    // never resurrect records the user removed. Session is legacy fallback only.
    const saved = local[JOBS_KEY] === undefined ? session[JOBS_KEY] : local[JOBS_KEY];
    if (saved !== undefined && !Array.isArray(saved)) throw new Error('下载记录格式无效，请稍后重试');
    for (const job of saved || []) {
      if (!job?.id || !jobState.STATES.includes(job.state)) continue;
      const previous = jobs.get(job.id);
      if (!previous || (job.updatedAt || 0) >= (previous.updatedAt || 0)) jobs.set(job.id, job);
    }
  });
  void ready.catch(error => console.warn('Neko jobs restore:', error));
  const notify = () => chrome.runtime.sendMessage({ action: 'jobsUpdated' }).catch(() => {});
  function snapshotJobs() {
    const completed = [...jobs.values()].filter(job => terminal.has(job.state) && !removing.has(job.id) && !job.cleanupError && !(job.state === 'interrupted' && (job.resumable || job.cachedSegments > 0))).sort((a, b) => b.createdAt - a.createdAt);
    for (const job of completed.slice(jobState.LIMITS.history)) jobs.delete(job.id);
    return [...jobs.values()].map(job => ({ ...job }));
  }
  async function writeSnapshot(snapshot) {
    await chrome.storage.local.set({ [JOBS_KEY]: snapshot });
    // Local is the commit point. A failed compatibility mirror cannot roll
    // back a durable deletion or turn its successful reply into a false error.
    try { await chrome.storage.session.set({ [JOBS_KEY]: snapshot }); }
    catch (error) { console.warn('Neko jobs session mirror:', error); }
  }
  function enqueueWrite(operation) {
    const write = saveChain.then(operation);
    saveChain = write.catch(error => console.warn('Neko jobs save:', error));
    return write;
  }
  function persist() {
    // Capture at execution time so an older queued snapshot cannot reinsert a
    // record removed by a preceding transaction in this same write queue.
    return enqueueWrite(() => writeSnapshot(snapshotJobs()));
  }
  function update(job, changes) {
    if (jobs.get(job.id) !== job || removing.has(job.id)) return job;
    if (changes.state && changes.state !== 'downloading') changes = { ...changes, etaSeconds: null, etaBasis: 'unknown' };
    if (Object.entries(changes).every(([key, value]) => job[key] === value)) return job;
    Object.assign(job, changes, { updatedAt: Date.now() });
    const write = persist();
    pendingWrites.set(job, write);
    void write.catch(() => {}); notify(); return job;
  }
  function safeName(value) {
    let name = String(value || '视频').split(/[\\/]/).pop().normalize('NFC')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 140);
    if (!name) name = '视频';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }
  function normalizeSettings(value = {}) {
    // The slider is the only concurrency policy. Legacy mode labels have no
    // effect; retain valid numeric preferences independently of other fields.
    const concurrency = Number.isInteger(value.concurrency) && value.concurrency >= 1 &&
      value.concurrency <= jobState.LIMITS.segments ? value.concurrency : 64;
    return { concurrency };
  }
  async function readPolicy() {
    const data = await chrome.storage.local.get([SETTINGS_KEY, CONCURRENCY_REVISION_KEY]);
    let pref;
    try { pref = normalizeSettings(data[SETTINGS_KEY]); } catch { pref = normalizeSettings(); }
    const revision = data[CONCURRENCY_REVISION_KEY];
    return { ...pref, concurrencyRevision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0 };
  }
  async function settings() {
    // Downloads and reads observe all preference writes received before them.
    await settingsChain;
    return readPolicy();
  }
  async function applyConcurrencyToJobs(policy) {
    let changed = false;
    for (const job of jobs.values()) {
      if (!job.isM3U8 || terminal.has(job.state) || removing.has(job.id) || (job.concurrencyRevision || 0) > policy.concurrencyRevision) continue;
      const patch = { ...policy, concurrencyMode: 'manual', concurrencyReason: 'manual',
        targetConcurrency: job.state === 'downloading' ? policy.concurrency : 0 };
      if (job.state === 'downloading') patch.activeConcurrency = policy.concurrency;
      if (Object.entries(patch).every(([key, value]) => job[key] === value)) continue;
      Object.assign(job, patch, { updatedAt: Date.now() }); changed = true;
    }
    if (changed) { await persist(); notify(); }
  }
  async function syncConcurrency(policy, contextKnown = false) {
    if (contextKnown || (await getContexts()).length) {
      const reply = await offscreen('setConcurrency', policy);
      if (!reply?.success || !Number.isSafeInteger(reply.concurrencyRevision) || reply.concurrencyRevision < policy.concurrencyRevision ||
          !Number.isInteger(reply.concurrency) || reply.concurrency < 1 || reply.concurrency > jobState.LIMITS.segments ||
          (reply.concurrencyRevision === policy.concurrencyRevision && reply.concurrency !== policy.concurrency)) {
        throw new Error(reply?.error || '下载引擎尚未确认新的分片并发');
      }
      // A newer control message may have overtaken this reconciliation request.
      policy = { concurrency: reply.concurrency, concurrencyRevision: reply.concurrencyRevision };
    }
    await applyConcurrencyToJobs(policy);
  }
  function saveSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('下载设置无效');
    const changes = { ...value };
    const operation = settingsChain.then(async () => {
      // Use the raw reader here: awaiting settingsChain inside its own operation
      // would deadlock. Read/merge/write is one serialized transaction.
      const previous = await readPolicy();
      if (previous.concurrencyRevision === Number.MAX_SAFE_INTEGER) throw new Error('并发设置版本已达到上限');
      const pref = normalizeSettings({ ...previous, ...changes });
      const policy = { ...pref, concurrencyRevision: previous.concurrencyRevision + 1 };
      await chrome.storage.local.set({ [SETTINGS_KEY]: pref, [CONCURRENCY_REVISION_KEY]: policy.concurrencyRevision });
      try {
        await syncConcurrency(policy);
        return { success: true, settings: pref, liveApplied: true };
      } catch (error) {
        return { success: true, settings: pref, liveApplied: false, warning: error.message };
      }
    });
    settingsChain = operation.catch(() => {});
    return operation;
  }
  function getContexts() {
    return chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] });
  }
  async function ensureOffscreen() {
    if ((await getContexts()).length) return;
    if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Download and combine video fragments in a disk-backed Blob while the popup is closed.' }).then(async () => {
      try {
        const response = await offscreen('pruneCaches', { jobIds: [...jobs.keys()] });
        if (response?.success === false) console.warn('Neko cache cleanup:', response.error || '缓存清理未完成');
      } catch (error) { console.warn('Neko cache cleanup:', error.message); }
    }).finally(() => { creating = null; });
    await creating;
  }
  function offscreen(action, extra = {}) { return chrome.runtime.sendMessage({ target: 'neko-offscreen', action, ...extra }); }
  async function chromeItem(downloadId) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) throw new Error('找不到下载任务，请重新下载');
    return item;
  }
  function applyChrome(job, item) {
    const state = item.state === 'complete' ? 'complete' : item.state === 'interrupted' ? (item.error === 'USER_CANCELED' ? 'cancelled' : 'interrupted') : 'downloading';
    // HLS completion is acknowledged by the offscreen writer after cleanup.
    const patch = { bytesReceived: item.bytesReceived || 0, totalBytes: Math.max(0, item.totalBytes || 0), savedPath: item.filename || job.savedPath || '' };
    if (!job.isM3U8) {
      const seconds = (Date.parse(item.estimatedEndTime) - Date.now()) / 1000;
      const etaSeconds = state === 'downloading' && item.paused !== true && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
      Object.assign(patch, { state, error: item.error || '', etaSeconds, etaBasis: etaSeconds === null ? 'unknown' : 'chrome' });
    }
    update(job, patch);
  }
  async function reconcile() {
    await ready;
    if (reconciling) return reconciling;
    reconciling = (async () => {
      const hls = [...jobs.values()].filter(job => job.isM3U8 && !terminal.has(job.state) && !dispatching.has(job.id));
      if (hls.length) {
        let live = [];
        if ((await getContexts()).length) {
          // Retry delivery after a worker wake or a lost control acknowledgement.
          try { await syncConcurrency(await settings(), true); }
          catch (error) { console.warn('Neko live concurrency:', error.message); }
          const reply = await offscreen('getOffscreenJobs');
          if (!reply || !Array.isArray(reply.jobs)) throw new Error('下载引擎暂时未响应，请稍后刷新');
          live = reply.jobs;
        }
        for (const job of hls) {
          if (terminal.has(job.state) || dispatching.has(job.id)) continue;
          const current = live.find(item => item.id === job.id);
          if (current) await acceptProgress(current);
          else if (Number.isInteger(job.downloadId)) {
            try {
              const item = await chromeItem(job.downloadId);
              update(job, { state: item.state === 'complete' ? 'complete' : item.state === 'in_progress' ? 'saving' : item.error === 'USER_CANCELED' ? 'cancelled' : 'interrupted', error: item.state === 'interrupted' ? item.error || '后台任务已停止，请重试' : '', savedPath: item.filename || '' });
            } catch { update(job, { state: 'interrupted', error: '后台任务已停止，请重试' }); }
          } else update(job, { state: 'interrupted', resumable: job.cachedSegments > 0,
            error: job.cachedSegments > 0 ? '浏览器或扩展已重新启动，可继续已缓存分片' : '浏览器或扩展已重新启动，请重试' });
        }
      }
      for (const job of jobs.values()) {
        if (!job.isM3U8 && !terminal.has(job.state) && !dispatching.has(job.id)) {
          if (!Number.isInteger(job.downloadId)) update(job, { state: 'interrupted', error: '下载创建过程已中断，请重试' });
          else {
            try { applyChrome(job, await chromeItem(job.downloadId)); }
            catch (error) { update(job, { state: 'interrupted', error: error.message }); }
          }
        }
      }
    })().finally(() => { reconciling = null; });
    return reconciling;
  }
  async function acceptProgress(incoming) {
    const job = jobs.get(incoming?.id);
    if (!job?.isM3U8 || terminal.has(job.state)) return;
    if (!jobState.STATES.includes(incoming.state)) throw new Error('下载状态无效');
    if (!jobState.accepts(job, incoming) || jobs.get(job.id) !== job || removing.has(job.id)) return;
    if (incoming.state === 'complete') {
      if (!Number.isInteger(job.downloadId) || (await chromeItem(job.downloadId)).state !== 'complete') throw new Error('文件尚未确认保存完成');
    }
    // Chrome lookup yields: a newer snapshot or retry may have arrived meanwhile.
    if (!jobState.accepts(job, incoming) || jobs.get(job.id) !== job || removing.has(job.id)) return;
    const patch = { state: incoming.state, error: String(incoming.error || '').slice(0, 500), cleanupError: String(incoming.cleanupError || '').slice(0, 500) };
    if (Number.isSafeInteger(incoming.revision)) patch.progressRevision = incoming.revision;
    if (Number.isInteger(incoming.queuePosition) && incoming.queuePosition >= 0 && incoming.queuePosition <= jobState.LIMITS.jobs) patch.queuePosition = incoming.queuePosition;
    if (typeof incoming.resumable === 'boolean') patch.resumable = incoming.resumable;
    for (const field of ['cachedSegments', 'retryAttempt']) {
      if (Number.isInteger(incoming[field]) && incoming[field] >= 0) patch[field] = incoming[field];
    }
    if (typeof incoming.retryMessage === 'string') patch.retryMessage = incoming.retryMessage.slice(0, 500);
    for (const field of ['qualityLabel', 'qualityReason']) {
      if (typeof incoming[field] === 'string') patch[field] = incoming[field].slice(0, 500);
    }
    if (typeof incoming.phase === 'string') patch.phase = incoming.phase.slice(0, 80);
    if (Number.isFinite(incoming.bytesPerSecond) && incoming.bytesPerSecond >= 0 && incoming.bytesPerSecond <= 1e12) patch.bytesPerSecond = incoming.bytesPerSecond;
    if ('etaSeconds' in incoming || 'etaSeconds' in job) {
      patch.etaSeconds = incoming.state === 'downloading' && incoming.etaBasis === 'network-segments' &&
        Number.isFinite(incoming.etaSeconds) && incoming.etaSeconds > 0 ? Math.ceil(incoming.etaSeconds) : null;
      patch.etaBasis = patch.etaSeconds === null ? 'unknown' : 'network-segments';
    }
    const incomingControlRevision = incoming.concurrencyRevision ?? 0;
    const currentControl = Number.isSafeInteger(incomingControlRevision) && incomingControlRevision >= (job.concurrencyRevision || 0);
    for (const field of ['activeConcurrency', 'targetConcurrency', 'inFlightRequests']) {
      // Old telemetry may still carry useful bytes/state, but must not undo a
      // newer slider value. Real in-flight requests can exceed a lowered target.
      if (!currentControl && field !== 'inFlightRequests' && !terminal.has(incoming.state) && incoming.state !== 'saving') continue;
      if (Number.isInteger(incoming[field]) && incoming[field] >= 0 && incoming[field] <= jobState.LIMITS.segments) patch[field] = incoming[field];
    }
    if (Number.isSafeInteger(incoming.concurrencyRevision) && incoming.concurrencyRevision >= 0 && currentControl) {
      patch.concurrencyRevision = incoming.concurrencyRevision;
      if (Number.isInteger(incoming.concurrency) && incoming.concurrency >= 1 && incoming.concurrency <= jobState.LIMITS.segments) patch.concurrency = incoming.concurrency;
    }
    if (incoming.concurrencyMode === 'manual') patch.concurrencyMode = 'manual';
    if (incoming.concurrencyReason === 'manual') patch.concurrencyReason = 'manual';
    if (typeof incoming.filename === 'string') {
      const leaf = incoming.filename.split('/').pop();
      // Retain a legacy path only while an existing attempt reports it; the
      // save broker always strips it before creating a new Chrome download.
      const prefix = String(job.filename || '').includes('/') ? job.filename.slice(0, job.filename.lastIndexOf('/') + 1) : '';
      const expected = prefix ? `${prefix}${safeName(leaf)}` : safeName(leaf);
      if (incoming.filename === expected && /\.(ts|mp4)$/i.test(leaf)) patch.filename = expected;
    }
    for (const field of ['bytesReceived', 'totalBytes', 'completedSegments', 'totalSegments']) {
      if (Number.isFinite(incoming[field]) && incoming[field] >= 0) patch[field] = incoming[field];
    }
    update(job, patch);
    // Acknowledged snapshots are durable. Offscreen may safely release its
    // final state after the reply, including the first reusable checkpoint.
    await pendingWrites.get(job);
  }
  async function startDownload(message) {
    await ready;
    const url = new URL(message.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 HTTP / HTTPS 视频地址');
    const pref = await settings();
    const duplicate = activeJobForUrl(url.href);
    if (duplicate) return { success: true, job: duplicate };
    if ([...jobs.values()].filter(job => !terminal.has(job.state) || dispatching.has(job.id)).length >= jobState.LIMITS.jobs) throw new Error('最多同时安排 10 个任务，请等待或取消部分下载');
    const isM3U8 = Boolean(message.isM3U8) || /\.m3u8(?:$|\?)/i.test(url.href);
    let basename = safeName(message.filename || message.title || '视频.mp4');
    if (isM3U8) basename = basename.replace(/\.(?:m3u8|mp4|ts)$/i, '') + '.ts';
    const job = { id: crypto.randomUUID(), url: url.href, title: String(message.title || basename).slice(0, 300), filename: basename, subfolder: '', saveAs: false, concurrency: pref.concurrency, concurrencyMode: 'manual', isM3U8, tabId: Number.isInteger(message.tabId) ? message.tabId : null, state: 'queued', bytesReceived: 0, totalBytes: 0, completedSegments: 0, totalSegments: 0, error: '', createdAt: Date.now(), updatedAt: Date.now() };
    Object.assign(job, { runId: crypto.randomUUID(), progressRevision: 0, concurrencyRevision: pref.concurrencyRevision });
    jobs.set(job.id, job); dispatching.add(job.id);
    try {
      await persist(); notify();
      if (isM3U8) {
        await ensureOffscreen();
        if (job.cancelRequested) { update(job, { state: 'cancelled' }); return { success: true, job: { ...job } }; }
        const latest = await settings();
        update(job, { ...latest, targetConcurrency: 0 });
        await pendingWrites.get(job);
        const response = await offscreen('runJob', { job: { ...job } });
        if (!response?.success) throw new Error(response?.error || '无法启动后台下载');
        if (job.cancelRequested) await offscreen('cancelJob', { jobId: job.id });
      } else {
        const id = await chrome.downloads.download({ url: job.url, filename: safeName(job.filename), saveAs: false, conflictAction: 'uniquify' });
        update(job, { downloadId: id, state: 'downloading' });
        if (job.cancelRequested) await chrome.downloads.cancel(id);
        applyChrome(job, await chromeItem(id));
      }
    } catch (error) { update(job, { state: job.cancelRequested ? 'cancelled' : 'interrupted', error: error.message }); throw error; }
    finally { dispatching.delete(job.id); }
    return { success: true, job: { ...job } };
  }
  function activeJobForUrl(url, exceptId) {
    return [...jobs.values()].find(job => job.id !== exceptId && job.url === url &&
      (!terminal.has(job.state) || dispatching.has(job.id)));
  }
  function retryJob(job) {
    if (removing.has(job.id)) throw new Error('任务正在移除，请稍后重试');
    if (retrying.has(job.id)) return retrying.get(job.id);
    if (discarding.has(job.id)) throw new Error('正在清理这个任务的缓存，请稍后重试');
    if (!job.isM3U8 || job.state !== 'interrupted' || job.resumable !== true || dispatching.has(job.id)) throw new Error('只有保留了缓存的中断 HLS 任务可以继续下载');
    if (activeJobForUrl(job.url, job.id)) throw new Error('同一视频已有下载任务，请等待其结束或取消后再继续');
    if ([...jobs.values()].filter(item => !terminal.has(item.state) || dispatching.has(item.id)).length >= jobState.LIMITS.jobs) throw new Error('最多同时安排 10 个任务，请等待或取消部分下载');
    if (saving.has(job.id)) throw new Error('上次保存操作尚未结束，请稍后重试');
    // Reserve the task synchronously so concurrent retry/start requests cannot
    // exceed the queue limit or dispatch the same cached job twice.
    dispatching.add(job.id);
    const pending = (async () => {
      let prepared = false;
      try {
        const pref = await settings();
        if (Number.isInteger(job.downloadId)) {
          const [previous] = await chrome.downloads.search({ id: job.downloadId });
          if (previous?.state === 'in_progress') throw new Error('上次 Chrome 保存仍在进行，请等待其结束后重试');
        }
        update(job, { state: 'queued', runId: crypto.randomUUID(), progressRevision: 0, error: '', cleanupError: '', cancelRequested: false,
          filename: safeName(job.filename), subfolder: '', saveAs: false,
          retryAttempt: 0, retryMessage: '', phase: 'queued', downloadId: null, savedPath: '',
          concurrency: pref.concurrency, concurrencyRevision: pref.concurrencyRevision, concurrencyMode: 'manual', bytesPerSecond: 0, activeConcurrency: 0, concurrencyReason: 'manual',
          targetConcurrency: 0, inFlightRequests: 0 });
        prepared = true;
        await persist();
        await ensureOffscreen();
        if (job.cancelRequested) {
          const discarded = await offscreen('discardJob', { jobId: job.id });
          if (!discarded?.success) throw new Error(discarded?.error || '取消继续下载后，缓存尚未清理');
          update(job, { state: 'cancelled', resumable: false, cachedSegments: 0, cleanupError: '' });
          return { success: true, job: { ...job } };
        }
        const latest = await settings();
        update(job, { ...latest, targetConcurrency: 0 });
        await pendingWrites.get(job);
        const response = await offscreen('runJob', { job: { ...job, resume: true } });
        if (!response?.success) throw new Error(response?.error || '无法继续后台下载');
        if (job.cancelRequested) {
          const cancelled = await offscreen('cancelJob', { jobId: job.id });
          if (!cancelled?.success) throw new Error(cancelled?.error || '取消请求未送达');
        }
        return { success: true, job: { ...job } };
      } catch (error) {
        if (prepared) update(job, { state: 'interrupted', error: error.message,
          ...(job.cancelRequested ? { cleanupError: '缓存仍保留，可点击清理缓存后重试' } : {}) });
        throw error;
      } finally { dispatching.delete(job.id); retrying.delete(job.id); }
    })();
    retrying.set(job.id, pending);
    return pending;
  }
  function discardJob(job) {
    if (removing.has(job.id)) throw new Error('任务正在移除，请稍后重试');
    if (discarding.has(job.id)) return discarding.get(job.id);
    if (retrying.has(job.id) || dispatching.has(job.id)) throw new Error('任务正在继续下载，不能清理缓存');
    if (!job.isM3U8 || job.state !== 'interrupted' || !(job.resumable === true || job.cachedSegments > 0)) throw new Error('只有中断任务保留的缓存可以清理');
    const pending = (async () => {
      try {
        await ensureOffscreen();
        const response = await offscreen('discardJob', { jobId: job.id });
        if (!response?.success) throw new Error(response?.error || '缓存未能清理，请重试');
        update(job, { resumable: false, cachedSegments: 0, cleanupError: '' });
        await persist();
        return { success: true, job: { ...job } };
      } finally { discarding.delete(job.id); }
    })();
    discarding.set(job.id, pending);
    return pending;
  }
  function removeJob(job) {
    if (removing.has(job.id)) return removing.get(job.id);
    if (!terminal.has(job.state)) throw new Error('请先取消下载，结束后再移除任务');
    if (retrying.has(job.id) || discarding.has(job.id) || dispatching.has(job.id) || saving.has(job.id)) throw new Error('任务操作尚未结束，请稍后再移除');
    const pending = (async () => {
      try {
        let verifiedDownloadId = null;
        if (Number.isInteger(job.downloadId)) {
          const [item] = await chrome.downloads.search({ id: job.downloadId });
          if (item?.state === 'in_progress') throw new Error('文件仍在保存，请等待结束或取消后再移除');
          if (item && ['complete', 'interrupted'].includes(item.state)) verifiedDownloadId = job.downloadId;
        }
        if (job.isM3U8) {
          await ensureOffscreen();
          const reply = await offscreen('removeJob', { jobId: job.id, runId: job.runId, chromeIdle: true, verifiedDownloadId });
          if (!reply?.success) throw new Error(reply?.error || '临时缓存未能清理，请重试');
          Object.assign(job, { resumable: false, cachedSegments: 0, cleanupError: '', updatedAt: Date.now() });
        }
        await enqueueWrite(async () => {
          jobs.delete(job.id);
          try { await writeSnapshot(snapshotJobs()); }
          catch (error) { jobs.set(job.id, job); throw error; }
        });
        notify();
        return { success: true, jobId: job.id };
      } catch (error) {
        if (jobs.get(job.id) === job) {
          Object.assign(job, { cleanupError: `移除未完成：${error.message}`, updatedAt: Date.now() });
          try { await persist(); } catch { /* Keep the item in memory for retry. */ }
          notify();
        }
        throw error;
      } finally { removing.delete(job.id); }
    })();
    removing.set(job.id, pending);
    return pending;
  }
  function fromPage(sender, file) { return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(file); }
  async function saveBlob(message) {
    const job = jobs.get(message.jobId);
    if (!job?.isM3U8 || terminal.has(job.state) || removing.has(job.id)) throw new Error('后台任务不存在或已结束');
    if (!String(message.url).startsWith(`blob:${chrome.runtime.getURL('')}`)) throw new Error('只接受本扩展生成的临时视频');
    if (Number.isInteger(job.downloadId)) return { success: true, downloadId: job.downloadId };
    if (saving.has(job.id)) return saving.get(job.id);
    const leaf = String(message.filename || '').split('/').pop();
    const expected = safeName(leaf);
    if ((message.filename !== expected && message.filename !== job.filename) || !/\.(ts|mp4)$/i.test(leaf)) throw new Error('下载文件名无效');
    const promise = (async () => {
      const id = await chrome.downloads.download({ url: message.url, filename: expected, saveAs: false, conflictAction: 'uniquify' });
      update(job, { downloadId: id, filename: expected, state: 'saving' });
      await persist(); return { success: true, downloadId: id };
    })().finally(() => saving.delete(job.id));
    saving.set(job.id, promise); return promise;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target === 'neko-offscreen') return;
    const publicActions = ['startDownload', 'retryJob', 'discardJob', 'removeJob', 'getJobs', 'cancelJob', 'showJob', 'getSettings', 'saveSettings'];
    const privateActions = ['jobProgress', 'saveBlob', 'getChromeDownload', 'cancelChromeDownload'];
    const isPublic = publicActions.includes(message.action);
    const isPrivate = message.target === 'neko-background' && privateActions.includes(message.action);
    if (!isPublic && !isPrivate) return;
    if (!(isPublic ? fromPage(sender, 'popup.html') : fromPage(sender, 'offscreen.html'))) {
      sendResponse({ success: false, error: '请求来源未授权' }); return;
    }
    (async () => {
      await ready;
      if (message.action === 'getSettings') return { success: true, settings: normalizeSettings(await settings()) };
      if (message.action === 'saveSettings') return saveSettings(message.settings);
      if (message.action === 'startDownload') return startDownload(message);
      if (message.action === 'getJobs') { await reconcile(); return { success: true, jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(job => ({ ...job, stateReason: jobState.describe(job) })) }; }
      if (message.action === 'jobProgress') { await acceptProgress(message.job); return { success: true }; }
      if (isPrivate) {
        const activeJob = jobs.get(message.jobId);
        if (activeJob?.runId && activeJob.runId !== message.runId) throw new Error('这是已过期的下载尝试，请刷新任务状态');
      }
      if (message.action === 'saveBlob') return saveBlob(message);
      if (message.action === 'removeJob') {
        if (typeof message.jobId !== 'string' || !message.jobId || message.jobId.length > 128) throw new Error('无效的下载任务');
        if (removing.has(message.jobId)) return removing.get(message.jobId);
        const target = jobs.get(message.jobId);
        return target ? removeJob(target) : { success: true, jobId: message.jobId };
      }
      const job = jobs.get(message.jobId);
      if (!job) throw new Error('找不到这个下载任务');
      if (message.action === 'retryJob') return retryJob(job);
      if (message.action === 'discardJob') return discardJob(job);
      if (message.action === 'cancelJob') {
        if (terminal.has(job.state)) return { success: true };
        update(job, { cancelRequested: true });
        if (dispatching.has(job.id)) return { success: true };
        try { if (job.isM3U8) {
          if (!(await getContexts()).length) update(job, { state: 'interrupted', error: '后台任务已停止' });
          else { const reply = await offscreen('cancelJob', { jobId: job.id }); if (!reply?.success) throw new Error(reply?.error || '取消请求未送达'); }
        } else if (Number.isInteger(job.downloadId)) {
          await chrome.downloads.cancel(job.downloadId); applyChrome(job, await chromeItem(job.downloadId));
        } else throw new Error('正在创建下载任务，请稍后再取消'); }
        catch (error) { if (!terminal.has(job.state)) update(job, { cancelRequested: false }); throw error; }
        return { success: true };
      }
      if (message.action === 'showJob') {
        if (job.state !== 'complete' || !Number.isInteger(job.downloadId)) throw new Error('文件尚未保存完成');
        await chrome.downloads.show(job.downloadId); return { success: true };
      }
      if (message.action === 'getChromeDownload' && message.downloadId === undefined) {
        if (!Number.isInteger(job.downloadId)) return { success: true, downloadId: null, item: null, pending: saving.has(job.id) };
        const item = await chromeItem(job.downloadId);
        return { success: true, downloadId: job.downloadId, item: { state: item.state, error: item.error || '', bytesReceived: item.bytesReceived || 0, totalBytes: item.totalBytes || 0, filename: item.filename || '' } };
      }
      if (!Number.isInteger(message.downloadId) || message.downloadId !== job.downloadId) throw new Error('下载编号与任务不匹配');
      if (message.action === 'cancelChromeDownload') { await chrome.downloads.cancel(job.downloadId); return { success: true }; }
      if (message.action === 'getChromeDownload') {
        const item = await chromeItem(job.downloadId);
        return { success: true, downloadId: job.downloadId, item: { state: item.state, error: item.error || '', bytesReceived: item.bytesReceived || 0, totalBytes: item.totalBytes || 0, filename: item.filename || '' } };
      }
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  });
  chrome.downloads.onChanged.addListener(delta => {
    void ready.then(async () => {
      const job = [...jobs.values()].find(entry => entry.downloadId === delta.id);
      if (!job || terminal.has(job.state)) return;
      try { applyChrome(job, await chromeItem(delta.id)); } catch (error) { console.warn('Neko download state:', error); }
    }).catch(error => console.warn('Neko download state:', error));
  });
})();
