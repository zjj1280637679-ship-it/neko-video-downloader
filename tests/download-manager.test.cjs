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
  for (const action of ['startDownload', 'retryJob', 'discardJob', 'saveSettings', 'openDownloadSettings', 'cancelJob']) {
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
  assert.deepEqual(JSON.parse(JSON.stringify((await h.message({ action: 'getSettings' })).settings)), { subfolder: '', askWhereToSave: false, concurrency: 5, concurrencyMode: 'auto' });
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

test('concurrency defaults for old preferences, rejects invalid values, and preserves unrelated settings', async () => {
  const h = setup({ settings: { subfolder: 'Existing/Videos', askWhereToSave: true } });
  const previous = await h.message({ action: 'getSettings' });
  assert.equal(previous.settings.concurrency, 5);
  assert.equal(previous.settings.subfolder, 'Existing/Videos');
  for (const concurrency of [0, 9, 2.5, '3', null, NaN, Infinity]) {
    assert.equal((await h.message({ action: 'saveSettings', settings: { concurrency } })).success, false, String(concurrency));
  }
  const saved = await h.message({ action: 'saveSettings', settings: { concurrency: 3 } });
  assert.equal(saved.settings.concurrency, 3);
  assert.equal(saved.settings.subfolder, 'Existing/Videos');
  assert.equal(saved.settings.askWhereToSave, true);
  const { job } = await h.message({ ...hlsRequest, concurrency: 8 });
  assert.equal(job.concurrency, 3, 'Jobs snapshot validated settings, not caller-supplied concurrency');
  await h.message({ action: 'saveSettings', settings: { concurrency: 7 } });
  assert.equal(h.calls.offscreen.find(call => call.action === 'runJob').job.concurrency, 3);
});

test('retry reuses ID and destination, applies current concurrency, clears old Chrome ID, and waits for one acknowledgement', async () => {
  const acknowledgement = deferred();
  const job = restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 2,
    filename: 'Original/movie.mp4', subfolder: 'Original', saveAs: true, concurrency: 2,
    downloadId: 81, savedPath: 'old-path', error: 'network failed', cleanupError: 'old cleanup', cancelRequested: true });
  const h = setup({ jobs: [job], settings: { subfolder: 'New', askWhereToSave: false, concurrency: 1 },
    items: [{ id: 81, state: 'interrupted', error: 'NETWORK_FAILED' }],
    offscreen: async message => message.action === 'runJob' ? acknowledgement.promise : { success: true } });
  let firstSettled = false, secondSettled = false;
  const first = h.message({ action: 'retryJob', jobId: job.id }).then(value => { firstSettled = true; return value; });
  await tick();
  const second = h.message({ action: 'retryJob', jobId: job.id }).then(value => { secondSettled = true; return value; });
  await tick();
  const dispatched = h.calls.offscreen.filter(call => call.action === 'runJob');
  assert.equal(dispatched.length, 1);
  assert.equal(firstSettled, false); assert.equal(secondSettled, false);
  assert.equal(dispatched[0].job.id, 'restored');
  assert.equal(dispatched[0].job.resume, true);
  assert.equal(dispatched[0].job.filename, 'Original/movie.mp4');
  assert.equal(dispatched[0].job.subfolder, 'Original');
  assert.equal(dispatched[0].job.saveAs, true);
  assert.equal(dispatched[0].job.concurrency, 1, 'Retry applies a lowered concurrency setting without changing its destination');
  assert.equal(dispatched[0].job.url, 'https://cdn.test/list.m3u8');
  assert.equal(dispatched[0].job.downloadId, null);
  assert.equal(dispatched[0].job.savedPath, '');
  assert.equal(dispatched[0].job.error, '');
  assert.equal(dispatched[0].job.cleanupError, '');
  assert.equal(dispatched[0].job.cancelRequested, false);
  acknowledgement.resolve({ success: true });
  assert.equal((await first).job.id, 'restored');
  assert.equal((await second).job.id, 'restored');
  const saved = await h.engine({ action: 'saveBlob', jobId: job.id, filename: 'Original/movie.mp4', url: `blob:${extensionUrl('')}new-attempt` });
  assert.equal(saved.success, true);
  assert.notEqual(saved.downloadId, 81, 'Retry cannot reuse the failed native save ID');
  assert.equal(h.calls.nativeDownloads.length, 1);
});

test('retry guards terminal state, resumability, active Chrome saves, and maximum active queue', async () => {
  for (const changes of [{ state: 'complete', resumable: true }, { state: 'cancelled', resumable: true },
    { state: 'downloading', resumable: true }, { state: 'interrupted', resumable: false },
    { state: 'interrupted', resumable: true, isM3U8: false }]) {
    const h = setup({ jobs: [restoredJob(changes)] });
    assert.equal((await h.message({ action: 'retryJob', jobId: 'restored' })).success, false);
    assert.equal(h.calls.offscreen.filter(call => call.action === 'runJob').length, 0);
  }
  const activeSave = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, downloadId: 8 })], items: [{ id: 8, state: 'in_progress' }] });
  assert.equal((await activeSave.message({ action: 'retryJob', jobId: 'restored' })).success, false);
  assert.equal(activeSave.session.neko_jobs_v1[0].downloadId, 8);
  const full = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true }),
    ...Array.from({ length: 10 }, (_, index) => restoredJob({ id: `active-${index}`, state: 'downloading' }))] });
  assert.equal((await full.message({ action: 'retryJob', jobId: 'restored' })).success, false);
  assert.equal(full.calls.create.length, 0);
});

test('progress exposes bounded retry and cache metadata without accepting malformed counters', async () => {
  const h = setup();
  const { job } = await h.message(hlsRequest);
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', resumable: true,
    cachedSegments: 4, retryAttempt: 2, retryMessage: 'Retrying segment 5', phase: 'fetching' } });
  await tick();
  let stored = h.session.neko_jobs_v1.find(item => item.id === job.id);
  assert.equal(stored.resumable, true); assert.equal(stored.cachedSegments, 4);
  assert.equal(stored.retryAttempt, 2); assert.equal(stored.retryMessage, 'Retrying segment 5');
  assert.equal(stored.phase, 'fetching');
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'interrupted', resumable: 'yes',
    cachedSegments: -1, retryAttempt: 1.5, retryMessage: 'x'.repeat(1000), phase: 'y'.repeat(200) } });
  await tick();
  stored = h.session.neko_jobs_v1.find(item => item.id === job.id);
  assert.equal(stored.resumable, true); assert.equal(stored.cachedSegments, 4); assert.equal(stored.retryAttempt, 2);
  assert.equal(stored.retryMessage.length, 500); assert.equal(stored.phase.length, 80);
});

test('discard only clears confirmed interrupted HLS cache and preserves the failure record', async () => {
  const cleanup = deferred();
  const h = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 3, error: 'Network failed' })],
    offscreen: async message => message.action === 'discardJob' ? cleanup.promise : { success: true } });
  const first = h.message({ action: 'discardJob', jobId: 'restored' });
  await tick();
  const second = h.message({ action: 'discardJob', jobId: 'restored' });
  await tick();
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.offscreen.filter(call => call.action === 'discardJob').length, 1);
  assert.equal(h.session.neko_jobs_v1[0].resumable, true);
  assert.equal((await h.message({ action: 'retryJob', jobId: 'restored' })).success, false);
  cleanup.resolve({ success: true });
  const result = await first; await second;
  assert.equal(result.job.state, 'interrupted'); assert.equal(result.job.error, 'Network failed');
  assert.equal(result.job.resumable, false); assert.equal(result.job.cachedSegments, 0);
  assert.equal(h.calls.nativeDownloads.length, 0);
  assert.equal((await h.message({ action: 'discardJob', jobId: 'restored' })).success, false);
});

test('discard rejects active/completed/non-HLS jobs and does not erase metadata after engine failure', async () => {
  for (const changes of [{ state: 'complete' }, { state: 'cancelled' }, { state: 'downloading' },
    { state: 'interrupted', isM3U8: false }, { state: 'interrupted', resumable: false, cachedSegments: 0 }]) {
    const h = setup({ jobs: [restoredJob({ resumable: true, cachedSegments: 2, ...changes })] });
    assert.equal((await h.message({ action: 'discardJob', jobId: 'restored' })).success, false);
    assert.equal(h.calls.offscreen.filter(call => call.action === 'discardJob').length, 0);
  }
  const failed = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 2 })],
    offscreen: async message => ({ success: message.action !== 'discardJob', error: 'disk unavailable' }) });
  assert.equal((await failed.message({ action: 'discardJob', jobId: 'restored' })).success, false);
  assert.equal(failed.session.neko_jobs_v1[0].resumable, true);
  assert.equal(failed.session.neko_jobs_v1[0].cachedSegments, 2);
});

test('cancel during retry preparation confirms cache cleanup instead of orphaning it', async () => {
  const opening = deferred();
  const h = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 2 })], getContexts: () => opening.promise });
  const pending = h.message({ action: 'retryJob', jobId: 'restored' });
  await tick();
  assert.equal((await h.message({ action: 'cancelJob', jobId: 'restored' })).success, true);
  opening.resolve([]);
  const result = await pending;
  assert.equal(result.job.state, 'cancelled');
  assert.equal(result.job.resumable, false); assert.equal(result.job.cachedSegments, 0);
  assert.equal(h.calls.offscreen.filter(call => call.action === 'runJob').length, 0);
  assert.equal(h.calls.offscreen.filter(call => call.action === 'discardJob').length, 1);
});

test('history trimming retains every resumable task and new-worker pruning protects all known IDs', async () => {
  const knownJobs = Array.from({ length: 23 }, (_, index) => restoredJob({ id: `cached-${index}`, state: 'interrupted', resumable: true, cachedSegments: 1 }));
  const h = setup({ jobs: knownJobs });
  const started = await h.message(hlsRequest);
  const pruning = h.calls.offscreen.find(call => call.action === 'pruneCaches');
  assert.deepEqual(new Set(pruning.jobIds), new Set([...knownJobs.map(job => job.id), started.job.id]));
  assert.equal(h.session.neko_jobs_v1.filter(job => job.resumable).length, 23);
  await h.message({ ...hlsRequest, url: 'https://cdn.test/second.m3u8' });
  assert.equal(h.calls.offscreen.filter(call => call.action === 'pruneCaches').length, 1);
});

test('automatic mode migrates old settings and only explicit manual mode opts out', async () => {
  const h = setup({ settings: { subfolder: 'Videos', concurrency: 8 } });
  assert.equal((await h.message({ action: 'getSettings' })).settings.concurrencyMode, 'auto');
  for (const concurrencyMode of ['fast', null, false, 2]) {
    assert.equal((await h.message({ action: 'saveSettings', settings: { concurrencyMode } })).success, false);
  }
  const first = await h.message(hlsRequest);
  assert.equal(first.job.concurrencyMode, 'auto');
  assert.equal(h.calls.offscreen.find(call => call.action === 'runJob').job.concurrencyMode, 'auto');
  await h.message({ action: 'saveSettings', settings: { concurrencyMode: 'manual', concurrency: 3 } });
  const second = await h.message({ ...hlsRequest, url: 'https://cdn.test/second.m3u8' });
  assert.equal(second.job.concurrencyMode, 'manual');
  assert.equal(second.job.concurrency, 3);
});

test('job metrics accept only finite nonnegative aggregate rates and bounded concurrency', async () => {
  const h = setup();
  const { job } = await h.message(hlsRequest);
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', bytesPerSecond: 800000,
    activeConcurrency: 3, concurrencyMode: 'auto', concurrencyReason: 'probing' } });
  await tick();
  let current = h.session.neko_jobs_v1.find(item => item.id === job.id);
  assert.equal(current.bytesPerSecond, 800000); assert.equal(current.activeConcurrency, 3);
  assert.equal(current.concurrencyReason, 'probing');
  for (const invalid of [NaN, Infinity, -1, '100']) {
    await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', bytesPerSecond: invalid,
      activeConcurrency: 99, concurrencyMode: 'turbo', concurrencyReason: '<script>' } });
  }
  await tick();
  current = h.session.neko_jobs_v1.find(item => item.id === job.id);
  assert.equal(current.bytesPerSecond, 800000); assert.equal(current.activeConcurrency, 3);
  assert.equal(current.concurrencyMode, 'auto'); assert.equal(current.concurrencyReason, 'probing');
});
