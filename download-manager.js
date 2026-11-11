/* MV3 coordinator. Media work runs offscreen; only this worker uses downloads. */
(() => {
  'use strict';
  const JOBS_KEY = 'neko_jobs_v1';
  const SETTINGS_KEY = 'neko_settings_v1';
  const terminal = new Set(['complete', 'interrupted', 'cancelled']);
  const jobs = new Map();
  const dispatching = new Set();
  const saving = new Map();
  const retrying = new Map();
  const discarding = new Map();
  let creating, reconciling, saveChain = Promise.resolve();
  const ready = chrome.storage.session.get(JOBS_KEY).then(data => {
    for (const job of Array.isArray(data[JOBS_KEY]) ? data[JOBS_KEY] : []) {
      if (job?.id) jobs.set(job.id, job);
    }
  }).catch(error => console.warn('Neko jobs restore:', error));
  const notify = () => chrome.runtime.sendMessage({ action: 'jobsUpdated' }).catch(() => {});
  function persist() {
    const completed = [...jobs.values()].filter(job => terminal.has(job.state) && !(job.state === 'interrupted' && (job.resumable || job.cachedSegments > 0))).sort((a, b) => b.createdAt - a.createdAt);
    for (const job of completed.slice(20)) jobs.delete(job.id);
    const snapshot = [...jobs.values()].map(job => ({ ...job }));
    const write = saveChain.then(() => chrome.storage.session.set({ [JOBS_KEY]: snapshot }));
    saveChain = write.catch(error => console.warn('Neko jobs save:', error));
    return write;
  }
  function update(job, changes) {
    if (Object.entries(changes).every(([key, value]) => job[key] === value)) return job;
    Object.assign(job, changes, { updatedAt: Date.now() });
    void persist().catch(() => {}); notify(); return job;
  }
  function safeName(value) {
    let name = String(value || '视频').split(/[\\/]/).pop().normalize('NFC')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 140);
    if (!name) name = '视频';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  }
  function normalizeSettings(value = {}) {
    const subfolder = String(value.subfolder || '').trim().replace(/\\/g, '/');
    if (subfolder.length > 120 || subfolder.startsWith('/') || /[<>:"|?*\x00-\x1f]/.test(subfolder)) throw new Error('子文件夹必须是下载目录内的相对路径，例如 Videos/动画');
    if (subfolder && subfolder.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('子文件夹不能包含空目录、.. 或系统保留名称');
    const concurrency = value.concurrency === undefined ? 5 : value.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('分片并发数必须是 1 到 8 之间的整数');
    const concurrencyMode = value.concurrencyMode === undefined ? 'auto' : value.concurrencyMode;
    if (!['auto', 'manual'].includes(concurrencyMode)) throw new Error('请选择自动调整或手动并行模式');
    return { subfolder, askWhereToSave: value.askWhereToSave === true, concurrency, concurrencyMode };
  }
  async function settings() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    try { return normalizeSettings(data[SETTINGS_KEY]); } catch { return normalizeSettings(); }
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
    if (!job.isM3U8) Object.assign(patch, { state, error: item.error || '' });
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
          } else update(job, { state: 'interrupted', error: '浏览器或扩展已重新启动，请重试' });
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
    const allowed = ['queued', 'parsing', 'downloading', 'saving', 'complete', 'interrupted', 'cancelled'];
    if (!allowed.includes(incoming.state)) throw new Error('下载状态无效');
    if (incoming.state === 'complete') {
      if (!Number.isInteger(job.downloadId) || (await chromeItem(job.downloadId)).state !== 'complete') throw new Error('文件尚未确认保存完成');
    }
    const patch = { state: incoming.state, error: String(incoming.error || '').slice(0, 500), cleanupError: String(incoming.cleanupError || '').slice(0, 500) };
    if (typeof incoming.resumable === 'boolean') patch.resumable = incoming.resumable;
    for (const field of ['cachedSegments', 'retryAttempt']) {
      if (Number.isInteger(incoming[field]) && incoming[field] >= 0) patch[field] = incoming[field];
    }
    if (typeof incoming.retryMessage === 'string') patch.retryMessage = incoming.retryMessage.slice(0, 500);
    if (typeof incoming.phase === 'string') patch.phase = incoming.phase.slice(0, 80);
    if (Number.isFinite(incoming.bytesPerSecond) && incoming.bytesPerSecond >= 0 && incoming.bytesPerSecond <= 1e12) patch.bytesPerSecond = incoming.bytesPerSecond;
    if (Number.isInteger(incoming.activeConcurrency) && incoming.activeConcurrency >= 0 && incoming.activeConcurrency <= 8) patch.activeConcurrency = incoming.activeConcurrency;
    if (['auto', 'manual'].includes(incoming.concurrencyMode)) patch.concurrencyMode = incoming.concurrencyMode;
    if (['initializing', 'probing', 'gain', 'no-gain', 'errors', 'decline', 'cooldown', 'steady', 'insufficient', 'manual'].includes(incoming.concurrencyReason)) patch.concurrencyReason = incoming.concurrencyReason;
    if (typeof incoming.filename === 'string') {
      const leaf = incoming.filename.split('/').pop();
      const expected = job.subfolder ? `${job.subfolder}/${safeName(leaf)}` : safeName(leaf);
      if (incoming.filename === expected && /\.(ts|mp4)$/i.test(leaf)) patch.filename = expected;
    }
    for (const field of ['bytesReceived', 'totalBytes', 'completedSegments', 'totalSegments']) {
      if (Number.isFinite(incoming[field]) && incoming[field] >= 0) patch[field] = incoming[field];
    }
    update(job, patch);
  }
  async function startDownload(message) {
    await ready;
    const url = new URL(message.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 HTTP / HTTPS 视频地址');
    const pref = await settings();
    const duplicate = [...jobs.values()].find(job => job.url === url.href && !terminal.has(job.state));
    if (duplicate) return { success: true, job: duplicate };
    if ([...jobs.values()].filter(job => !terminal.has(job.state) || dispatching.has(job.id)).length >= 10) throw new Error('最多同时安排 10 个任务，请等待或取消部分下载');
    const isM3U8 = Boolean(message.isM3U8) || /\.m3u8(?:$|\?)/i.test(url.href);
    let basename = safeName(message.filename || message.title || '视频.mp4');
    if (isM3U8) basename = basename.replace(/\.(?:m3u8|mp4|ts)$/i, '') + '.ts';
    const job = { id: crypto.randomUUID(), url: url.href, title: String(message.title || basename).slice(0, 300), filename: pref.subfolder ? `${pref.subfolder}/${basename}` : basename, subfolder: pref.subfolder, saveAs: pref.askWhereToSave, concurrency: pref.concurrency, concurrencyMode: pref.concurrencyMode, isM3U8, tabId: Number.isInteger(message.tabId) ? message.tabId : null, state: 'queued', bytesReceived: 0, totalBytes: 0, completedSegments: 0, totalSegments: 0, error: '', createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(job.id, job); dispatching.add(job.id);
    try {
      await persist(); notify();
      if (isM3U8) {
        await ensureOffscreen();
        if (job.cancelRequested) { update(job, { state: 'cancelled' }); return { success: true, job: { ...job } }; }
        const response = await offscreen('runJob', { job: { ...job } });
        if (!response?.success) throw new Error(response?.error || '无法启动后台下载');
        if (job.cancelRequested) await offscreen('cancelJob', { jobId: job.id });
      } else {
        const id = await chrome.downloads.download({ url: job.url, filename: job.filename, saveAs: job.saveAs, conflictAction: 'uniquify' });
        update(job, { downloadId: id, state: 'downloading' });
        if (job.cancelRequested) await chrome.downloads.cancel(id);
        applyChrome(job, await chromeItem(id));
      }
    } catch (error) { update(job, { state: job.cancelRequested ? 'cancelled' : 'interrupted', error: error.message }); throw error; }
    finally { dispatching.delete(job.id); }
    return { success: true, job: { ...job } };
  }
  function retryJob(job) {
    if (retrying.has(job.id)) return retrying.get(job.id);
    if (discarding.has(job.id)) throw new Error('正在清理这个任务的缓存，请稍后重试');
    if (!job.isM3U8 || job.state !== 'interrupted' || job.resumable !== true || dispatching.has(job.id)) throw new Error('只有保留了缓存的中断 HLS 任务可以继续下载');
    if ([...jobs.values()].filter(item => !terminal.has(item.state) || dispatching.has(item.id)).length >= 10) throw new Error('最多同时安排 10 个任务，请等待或取消部分下载');
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
        update(job, { state: 'queued', error: '', cleanupError: '', cancelRequested: false,
          retryAttempt: 0, retryMessage: '', phase: 'queued', downloadId: null, savedPath: '',
          concurrency: pref.concurrency, concurrencyMode: pref.concurrencyMode, bytesPerSecond: 0, activeConcurrency: 0, concurrencyReason: 'initializing' });
        prepared = true;
        await persist();
        await ensureOffscreen();
        if (job.cancelRequested) {
          const discarded = await offscreen('discardJob', { jobId: job.id });
          if (!discarded?.success) throw new Error(discarded?.error || '取消继续下载后，缓存尚未清理');
          update(job, { state: 'cancelled', resumable: false, cachedSegments: 0, cleanupError: '' });
          return { success: true, job: { ...job } };
        }
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
  function fromPage(sender, file) { return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(file); }
  async function saveBlob(message) {
    const job = jobs.get(message.jobId);
    if (!job?.isM3U8 || terminal.has(job.state)) throw new Error('后台任务不存在或已结束');
    if (!String(message.url).startsWith(`blob:${chrome.runtime.getURL('')}`)) throw new Error('只接受本扩展生成的临时视频');
    if (Number.isInteger(job.downloadId)) return { success: true, downloadId: job.downloadId };
    if (saving.has(job.id)) return saving.get(job.id);
    const leaf = String(message.filename || '').split('/').pop();
    const expected = job.subfolder ? `${job.subfolder}/${safeName(leaf)}` : safeName(leaf);
    if (message.filename !== expected || !/\.(ts|mp4)$/i.test(leaf)) throw new Error('下载文件名或子目录无效');
    const promise = (async () => {
      const id = await chrome.downloads.download({ url: message.url, filename: expected, saveAs: job.saveAs, conflictAction: 'uniquify' });
      update(job, { downloadId: id, filename: expected, state: 'saving' });
      await persist(); return { success: true, downloadId: id };
    })().finally(() => saving.delete(job.id));
    saving.set(job.id, promise); return promise;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target === 'neko-offscreen') return;
    const publicActions = ['startDownload', 'retryJob', 'discardJob', 'getJobs', 'cancelJob', 'showJob', 'getSettings', 'saveSettings', 'openDownloadSettings'];
    const privateActions = ['jobProgress', 'saveBlob', 'getChromeDownload', 'cancelChromeDownload'];
    const isPublic = publicActions.includes(message.action);
    const isPrivate = message.target === 'neko-background' && privateActions.includes(message.action);
    if (!isPublic && !isPrivate) return;
    if (!(isPublic ? fromPage(sender, 'popup.html') : fromPage(sender, 'offscreen.html'))) {
      sendResponse({ success: false, error: '请求来源未授权' }); return;
    }
    (async () => {
      await ready;
      if (message.action === 'getSettings') return { success: true, settings: await settings() };
      if (message.action === 'saveSettings') {
        if (!message.settings || typeof message.settings !== 'object' || Array.isArray(message.settings)) throw new Error('下载设置无效');
        const pref = normalizeSettings({ ...await settings(), ...message.settings });
        await chrome.storage.local.set({ [SETTINGS_KEY]: pref }); return { success: true, settings: pref };
      }
      if (message.action === 'openDownloadSettings') { await chrome.tabs.create({ url: 'chrome://settings/downloads' }); return { success: true }; }
      if (message.action === 'startDownload') return startDownload(message);
      if (message.action === 'getJobs') { await reconcile(); return { success: true, jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt) }; }
      if (message.action === 'jobProgress') { await acceptProgress(message.job); return { success: true }; }
      if (message.action === 'saveBlob') return saveBlob(message);
      const job = jobs.get(message.jobId);
      if (!job) throw new Error('找不到这个下载任务');
      if (message.action === 'retryJob') return retryJob(job);
      if (message.action === 'discardJob') return discardJob(job);
      if (message.action === 'cancelJob') {
        if (terminal.has(job.state)) return { success: true };
        update(job, { cancelRequested: true });
        if (dispatching.has(job.id)) return { success: true };
        if (job.isM3U8) {
          if (!(await getContexts()).length) update(job, { state: 'interrupted', error: '后台任务已停止' });
          else { const reply = await offscreen('cancelJob', { jobId: job.id }); if (!reply?.success) throw new Error(reply?.error || '取消请求未送达'); }
        } else if (Number.isInteger(job.downloadId)) {
          await chrome.downloads.cancel(job.downloadId); applyChrome(job, await chromeItem(job.downloadId));
        } else throw new Error('正在创建下载任务，请稍后再取消');
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
    });
  });
})();
