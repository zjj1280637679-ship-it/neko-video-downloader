const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../download-manager.js'), 'utf8');
const extensionId = 'neko-test-extension';
const extensionUrl = name => `chrome-extension://${extensionId}/${name}`;
const uiSender = { id: extensionId, url: extensionUrl('popup.html') };
const engineSender = { id: extensionId, url: extensionUrl('offscreen.html') };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function event() {
  const listeners = [];
  return { listeners, addListener(fn) { listeners.push(fn); }, emit(...args) { listeners.forEach(fn => fn(...args)); } };
}
function setup(options = {}) {
  let contexts = options.contexts || [];
  let nextId = 1;
  const items = new Map((options.items || []).map(item => [item.id, item]));
  const session = { neko_jobs_v1: options.jobs || [] };
  const local = { neko_settings_v1: options.settings || {} };
  const calls = { nativeDownloads: [], cancel: [], offscreen: [], create: [], tabs: [], shown: [], notifications: [] };
  const chrome = {
    runtime: {
      id: extensionId, getURL: extensionUrl, onMessage: event(),
      async getContexts() { return options.getContexts ? options.getContexts() : contexts; },
      async sendMessage(message) {
        if (message.target !== 'neko-offscreen') { calls.notifications.push(message); return; }
        calls.offscreen.push(message);
        if (options.offscreen) return options.offscreen(message);
        if (message.action === 'getOffscreenJobs') return { jobs: [] };
        return { success: true };
      }
    },
    storage: {
      session: { async get() { return session; }, async set(value) { Object.assign(session, structuredClone(value)); } },
      local: { async get() { return local; }, async set(value) { Object.assign(local, structuredClone(value)); } }
    },
    offscreen: { async createDocument(value) { calls.create.push(value); contexts = [{ documentUrl: extensionUrl('offscreen.html') }]; } },
    tabs: { async create(value) { calls.tabs.push(value); } },
    downloads: {
      onChanged: event(),
      async download(value) {
        calls.nativeDownloads.push(value);
        if (options.download) return options.download(value, items);
        const id = nextId++;
        items.set(id, { id, state: 'in_progress', bytesReceived: 0, totalBytes: 100, filename: `C:/Downloads/${value.filename}` });
        return id;
      },
      async search({ id }) { return items.has(id) ? [{ ...items.get(id) }] : []; },
      async cancel(id) { calls.cancel.push(id); const item = items.get(id); if (item) Object.assign(item, { state: 'interrupted', error: 'USER_CANCELED' }); },
      async show(id) { calls.shown.push(id); }
    }
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, console, structuredClone });
  vm.runInContext(source, context);
  function message(value, sender = uiSender) {
    return new Promise(resolve => {
      const result = chrome.runtime.onMessage.listeners[0](value, sender, resolve);
      if (result !== true) queueMicrotask(() => resolve(undefined));
    });
  }
  const engine = value => message({ target: 'neko-background', ...value }, engineSender);
  return { chrome, message, engine, items, calls, session, local };
}
const hlsRequest = { action: 'startDownload', url: 'https://cdn.test/list.m3u8', filename: 'movie.m3u8', title: 'Movie', isM3U8: true, tabId: 8 };
const restoredJob = changes => ({ id: 'restored', url: 'https://cdn.test/list.m3u8', title: 'Movie', filename: 'movie.ts', subfolder: '', saveAs: false, isM3U8: true, state: 'saving', createdAt: 1, updatedAt: 1, ...changes });

test('content scripts and other extension pages cannot start jobs, save blobs or change settings', async () => {
  const h = setup();
  const contentSender = { id: extensionId, url: 'https://page.test/watch', tab: { id: 8 } };
  for (const action of ['startDownload', 'saveSettings', 'openDownloadSettings', 'cancelJob']) {
    assert.equal((await h.message({ ...hlsRequest, action }, contentSender)).success, false);
  }
  assert.equal((await h.message({ target: 'neko-background', action: 'saveBlob' }, contentSender)).success, false);
  assert.equal((await h.message(hlsRequest, { id: 'other-extension', url: uiSender.url })).success, false);
  assert.equal((await h.message(hlsRequest, engineSender)).success, false);
  assert.equal(h.calls.nativeDownloads.length, 0);
  assert.equal(h.calls.create.length, 0);
});

test('settings reject absolute and traversal paths while default uses Chrome directory', async () => {
  const h = setup();
  assert.deepEqual(JSON.parse(JSON.stringify((await h.message({ action: 'getSettings' })).settings)), { subfolder: '', askWhereToSave: false });
  for (const subfolder of ['C:/Desktop', '../escape', 'Video/../escape', '/root', 'Video//nested', 'CON', 'Video/NUL', 'Video/trailing.']) {
    assert.equal((await h.message({ action: 'saveSettings', settings: { subfolder } })).success, false, subfolder);
  }
  const saved = await h.message({ action: 'saveSettings', settings: { subfolder: 'Videos/动画', askWhereToSave: true } });
  assert.equal(saved.success, true);
  assert.equal(saved.settings.subfolder, 'Videos/动画');
});

test('direct download is not complete until Chrome confirms it', async () => {
  const h = setup();
  const started = await h.message({ action: 'startDownload', url: 'https://cdn.test/movie.mp4', filename: 'movie.mp4' });
  assert.equal(started.success, true);
  assert.equal(started.job.state, 'downloading');
  assert.equal(h.calls.nativeDownloads[0].filename, 'movie.mp4');
  assert.equal(h.calls.nativeDownloads[0].saveAs, false);
  assert.equal(h.calls.nativeDownloads[0].conflictAction, 'uniquify');
  Object.assign(h.items.get(started.job.downloadId), { state: 'complete', bytesReceived: 100 });
  h.chrome.downloads.onChanged.emit({ id: started.job.downloadId, state: { current: 'complete' } });
  await tick();
  const current = await h.message({ action: 'getJobs' });
  assert.equal(current.jobs[0].state, 'complete');
  assert.equal((await h.message({ action: 'showJob', jobId: started.job.id })).success, true);
});

test('HLS start is detached from popup and duplicate clicks reuse the active task', async () => {
  const h = setup();
  const first = await h.message(hlsRequest);
  const second = await h.message(hlsRequest);
  assert.equal(first.success, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.offscreen.filter(call => call.action === 'runJob').length, 1);
  assert.equal(h.calls.nativeDownloads.length, 0);
  assert.equal(h.calls.create[0].reasons[0], 'BLOBS');
});

test('saveBlob rejects foreign origins, wrong paths and mismatched download IDs', async () => {
  const h = setup({ settings: { subfolder: 'Videos' } });
  const { job } = await h.message(hlsRequest);
  for (const url of ['https://cdn.test/file.ts', 'blob:https://page.test/random', 'blob:chrome-extension://different-extension/uuid']) {
    assert.equal((await h.engine({ action: 'saveBlob', jobId: job.id, filename: 'Videos/movie.ts', url })).success, false);
  }
  assert.equal((await h.engine({ action: 'saveBlob', jobId: job.id, filename: '../movie.ts', url: `blob:${extensionUrl('')}x` })).success, false);
  assert.equal((await h.engine({ action: 'getChromeDownload', jobId: job.id, downloadId: 99 })).success, false);
  assert.equal(h.calls.nativeDownloads.length, 0);
});

test('simultaneous saveBlob retries are idempotent and complete requires Chrome success', async () => {
  const native = deferred();
  const h = setup({ download: async (_options, items) => { await native.promise; items.set(7, { id: 7, state: 'in_progress', filename: 'C:/Downloads/movie.ts' }); return 7; } });
  const { job } = await h.message(hlsRequest);
  const request = { action: 'saveBlob', jobId: job.id, filename: 'movie.ts', url: `blob:${extensionUrl('')}fixture` };
  const first = h.engine(request), second = h.engine(request);
  await tick();
  assert.equal(h.calls.nativeDownloads.length, 1);
  native.resolve();
  assert.equal((await first).downloadId, 7);
  assert.equal((await second).downloadId, 7);
  assert.equal((await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'complete' } })).success, false);
  Object.assign(h.items.get(7), { state: 'complete', bytesReceived: 100 });
  assert.equal((await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'complete' } })).success, true);
  assert.equal((await h.message({ action: 'getJobs' })).jobs[0].state, 'complete');
});

test('restored HLS task without a worker is interrupted instead of silently restarted', async () => {
  const h = setup({ jobs: [restoredJob({ state: 'downloading' })] });
  const result = await h.message({ action: 'getJobs' });
  assert.equal(result.jobs[0].state, 'interrupted');
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.calls.nativeDownloads.length, 0);
});

test('restored HLS task reconciles a Chrome file completed after worker loss', async () => {
  const h = setup({ jobs: [restoredJob({ downloadId: 77 })], items: [{ id: 77, state: 'complete', filename: 'C:/Downloads/movie.ts' }] });
  assert.equal((await h.message({ action: 'getJobs' })).jobs[0].state, 'complete');
});

test('a transient offscreen snapshot error does not permanently discard recovery work', async () => {
  let attempts = 0;
  const h = setup({
    jobs: [restoredJob({ state: 'downloading' })], contexts: [{}],
    offscreen: async message => {
      if (message.action === 'getOffscreenJobs') {
        if (++attempts === 1) throw new Error('temporary message port unavailable');
        return { jobs: [{ id: 'restored', state: 'interrupted', error: 'network gone' }] };
      }
      return { success: true };
    }
  });
  assert.equal((await h.message({ action: 'getJobs' })).success, false);
  const retry = await h.message({ action: 'getJobs' });
  assert.equal(retry.success, true);
  assert.equal(retry.jobs[0].state, 'interrupted');
  assert.equal(attempts, 2);
});

test('Chrome completion is recoverable if offscreen disappears during current session', async () => {
  const h = setup();
  const { job } = await h.message(hlsRequest);
  const saved = await h.engine({ action: 'saveBlob', jobId: job.id, filename: 'movie.ts', url: `blob:${extensionUrl('')}fixture` });
  Object.assign(h.items.get(saved.downloadId), { state: 'complete', bytesReceived: 100 });
  h.chrome.downloads.onChanged.emit({ id: saved.downloadId, state: { current: 'complete' } });
  await tick();
  const result = await h.message({ action: 'getJobs' });
  assert.equal(result.jobs[0].state, 'complete');
});

test('cancel before native download ID resolves cancels that exact download once created', async () => {
  const pendingId = deferred();
  const h = setup({ download: async (_options, items) => {
    await pendingId.promise;
    items.set(55, { id: 55, state: 'in_progress', filename: 'C:/Downloads/movie.mp4' });
    return 55;
  } });
  const pending = h.message({ action: 'startDownload', url: 'https://cdn.test/movie.mp4', filename: 'movie.mp4' });
  await tick();
  const { jobs } = await h.message({ action: 'getJobs' });
  assert.equal(jobs[0].state, 'queued');
  assert.equal((await h.message({ action: 'cancelJob', jobId: jobs[0].id })).success, true);
  pendingId.resolve();
  const result = await pending;
  assert.equal(result.job.state, 'cancelled');
  assert.deepEqual(h.calls.cancel, [55]);
});

test('cancel while offscreen is being prepared never dispatches HLS network work', async () => {
  const opening = deferred();
  const h = setup({ getContexts: () => opening.promise });
  const pending = h.message(hlsRequest);
  await tick();
  const { jobs } = await h.message({ action: 'getJobs' });
  assert.equal((await h.message({ action: 'cancelJob', jobId: jobs[0].id })).success, true);
  opening.resolve([]);
  const result = await pending;
  assert.equal(result.job.state, 'cancelled');
  assert.equal(h.calls.offscreen.filter(call => call.action === 'runJob').length, 0);
});

test('unchanged live snapshots do not generate jobsUpdated refresh feedback', async () => {
  for (const legacySnapshot of [false, true]) {
    const h = setup({ jobs: [restoredJob({ state: 'downloading', error: '', bytesReceived: 4,
      ...(legacySnapshot ? {} : { cleanupError: '' }) })], contexts: [{}],
      offscreen: async () => ({ jobs: [{ id: 'restored', state: 'downloading', error: '', cleanupError: '', bytesReceived: 4 }] }) });
    await h.message({ action: 'getJobs' });
    // Older snapshots legitimately gain the newly supported cleanupError field
    // once. Subsequent identical reads must never feed another notification.
    const expectedNotifications = legacySnapshot ? 1 : 0;
    assert.equal(h.calls.notifications.filter(message => message.action === 'jobsUpdated').length, expectedNotifications);
    await h.message({ action: 'getJobs' });
    await h.message({ action: 'getJobs' });
    assert.equal(h.calls.notifications.filter(message => message.action === 'jobsUpdated').length, expectedNotifications);
  }
});

test('offscreen can recover a native ID when a saveBlob response was lost', async () => {
  const h = setup();
  const { job } = await h.message(hlsRequest);
  const saved = await h.engine({ action: 'saveBlob', jobId: job.id, filename: 'movie.ts', url: `blob:${extensionUrl('')}fixture` });
  const recovered = await h.engine({ action: 'getChromeDownload', jobId: job.id });
  assert.equal(recovered.success, true);
  assert.equal(recovered.downloadId, saved.downloadId);
  assert.equal(recovered.item.state, 'in_progress');
});
