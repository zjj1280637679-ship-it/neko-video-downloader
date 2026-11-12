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
  const local = { neko_settings_v1: options.settings || {}, neko_concurrency_revision_v1: options.concurrencyRevision || 0, ...(options.localJobs ? { neko_jobs_v1: options.localJobs } : {}) };
  const calls = { nativeDownloads: [], cancel: [], offscreen: [], create: [], tabs: [], shown: [], notifications: [], erased: [], removedFiles: [] };
  const chrome = {
    runtime: {
      id: extensionId, getURL: extensionUrl, onMessage: event(),
      async getContexts() { return options.getContexts ? options.getContexts() : contexts; },
      async sendMessage(message) {
        if (message.target !== 'neko-offscreen') { calls.notifications.push(message); return; }
        calls.offscreen.push(message);
        if (options.offscreen) return options.offscreen(message);
        if (message.action === 'setConcurrency') return { success: true, concurrency: message.concurrency, concurrencyRevision: message.concurrencyRevision };
        if (message.action === 'getOffscreenJobs') return { jobs: [] };
        return { success: true };
      }
    },
    storage: {
      session: { async get() { return session; }, async set(value) { await options.sessionSet?.(value); Object.assign(session, structuredClone(value)); } },
      local: { async get(key) { await options.localGet?.(key); if (key === 'neko_settings_v1' || Array.isArray(key) && key.includes('neko_settings_v1')) await options.settingsRead?.(); return local; }, async set(value) { await options.localSet?.(value); Object.assign(local, structuredClone(value)); } }
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
      async search({ id }) { if (options.search) return options.search(id, items); return items.has(id) ? [{ ...items.get(id) }] : []; },
      async cancel(id) { calls.cancel.push(id); const item = items.get(id); if (item) Object.assign(item, { state: 'interrupted', error: 'USER_CANCELED' }); },
      async show(id) { calls.shown.push(id); },
      async erase(query) { calls.erased.push(query); }, async removeFile(id) { calls.removedFiles.push(id); }
    }
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, console, structuredClone, NekoJobState: require('../engine/job-state.js') });
  vm.runInContext(source, context);
  function message(value, sender = uiSender) {
    return new Promise(resolve => {
      const result = chrome.runtime.onMessage.listeners[0](value, sender, resolve);
      if (result !== true) queueMicrotask(() => resolve(undefined));
    });
  }
  let revision = 0;
  const engine = value => {
    const stored = session.neko_jobs_v1.find(job => job.id === (value.job?.id || value.jobId));
    return message({ target: 'neko-background', runId: stored?.runId, ...value,
      ...(value.job ? { job: { runId: stored?.runId, revision: ++revision, ...value.job } } : {}) }, engineSender);
  };
  return { chrome, message, engine, items, calls, session, local };
}
const hlsRequest = { action: 'startDownload', url: 'https://cdn.test/list.m3u8', filename: 'movie.m3u8', title: 'Movie', isM3U8: true, tabId: 8 };
const restoredJob = changes => ({ id: 'restored', url: 'https://cdn.test/list.m3u8', title: 'Movie', filename: 'movie.ts', subfolder: '', saveAs: false, isM3U8: true, state: 'saving', createdAt: 1, updatedAt: 1, ...changes });

test('content scripts and other extension pages cannot start jobs, save blobs or change settings', async () => {
  const h = setup();
  const contentSender = { id: extensionId, url: 'https://page.test/watch', tab: { id: 8 } };
  for (const action of ['startDownload', 'retryJob', 'discardJob', 'removeJob', 'saveSettings', 'cancelJob']) {
    assert.equal((await h.message({ ...hlsRequest, action }, contentSender)).success, false);
  }
  assert.equal((await h.message({ target: 'neko-background', action: 'saveBlob' }, contentSender)).success, false);
  assert.equal((await h.message(hlsRequest, { id: 'other-extension', url: uiSender.url })).success, false);
  assert.equal((await h.message(hlsRequest, engineSender)).success, false);
  assert.equal(h.calls.nativeDownloads.length, 0);
  assert.equal(h.calls.create.length, 0);
});

test('settings keep only concurrency and ignore every legacy destination field', async () => {
  const h = setup();
  assert.deepEqual(JSON.parse(JSON.stringify((await h.message({ action: 'getSettings' })).settings)), { concurrency: 64 });
  for (const subfolder of ['C:/Desktop', '../escape', 'Video/../escape', '/root', 'Video//nested', 'CON', 'Video/NUL', 'Video/trailing.']) {
    const saved = await h.message({ action: 'saveSettings', settings: { subfolder, askWhereToSave: true, concurrency: 23 } });
    assert.equal(saved.success, true, subfolder);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.settings)), { concurrency: 23 });
  }
  assert.equal(await h.message({ action: 'openDownloadSettings' }), undefined);
  assert.equal(h.calls.tabs.length, 0);
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
      concurrency: 64, concurrencyRevision: 0, concurrencyMode: 'manual', concurrencyReason: 'manual', targetConcurrency: 64, activeConcurrency: 64,
      ...(legacySnapshot ? {} : { cleanupError: '' }) })], contexts: [{}],
      offscreen: async message => message.action === 'setConcurrency' ? { success: true, concurrency: message.concurrency, concurrencyRevision: message.concurrencyRevision } : { jobs: [{ id: 'restored', state: 'downloading', error: '', cleanupError: '', bytesReceived: 4 }] } });
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

test('valid slider values persist while invalid legacy values fall back to64 and old destinations disappear', async () => {
  const h = setup({ settings: { subfolder: 'Existing/Videos', askWhereToSave: true, concurrency: 64, concurrencyMode: 'manual' } });
  const previous = await h.message({ action: 'getSettings' });
  assert.equal(previous.settings.concurrency, 64);
  assert.equal(previous.settings.concurrencyMode, undefined);
  assert.equal(previous.settings.subfolder, undefined);
  for (const concurrency of [0, 376, 2.5, 'auto', '3', null, NaN, Infinity]) {
    const migrated = await h.message({ action: 'saveSettings', settings: { concurrency } });
    assert.equal(migrated.success, true);
    assert.equal(migrated.settings.concurrency, 64);
    assert.equal(migrated.settings.subfolder, undefined);
  }
  const saved = await h.message({ action: 'saveSettings', settings: { concurrency: 3 } });
  assert.equal(saved.settings.concurrency, 3);
  assert.equal(saved.settings.subfolder, undefined);
  assert.equal(saved.settings.askWhereToSave, undefined);
  const { job } = await h.message({ ...hlsRequest, concurrency: 8 });
  assert.equal(job.concurrency, 3, 'Jobs use the committed preference snapshot, not a separate caller-supplied value');
  assert.equal(job.concurrencyMode, 'manual');
  await h.message({ action: 'saveSettings', settings: { concurrency: 7 } });
  assert.equal(h.calls.offscreen.find(call => call.action === 'runJob').job.concurrency, 3);
  assert.equal(h.local.neko_jobs_v1.find(item => item.id === job.id).concurrency, 7, 'Editing the slider updates the active task');
  assert.equal(h.calls.offscreen.at(-1).action, 'setConcurrency');
  assert.equal(h.calls.offscreen.at(-1).concurrency, 7);
  const second = await h.message({ ...hlsRequest, url: 'https://cdn.test/next.m3u8' });
  assert.equal(second.job.concurrency, 7);
});

test('retry reuses ID, migrates to the default destination, reads the slider, and waits for one acknowledgement', async () => {
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
  assert.equal(dispatched[0].job.filename, 'movie.mp4');
  assert.equal(dispatched[0].job.subfolder, '');
  assert.equal(dispatched[0].job.saveAs, false);
  assert.equal(dispatched[0].job.concurrency, 1);
  assert.equal(dispatched[0].job.concurrencyMode, 'manual');
  assert.equal(dispatched[0].job.url, 'https://cdn.test/list.m3u8');
  assert.equal(dispatched[0].job.downloadId, null);
  assert.equal(dispatched[0].job.savedPath, '');
  assert.equal(dispatched[0].job.error, '');
  assert.equal(dispatched[0].job.cleanupError, '');
  assert.equal(dispatched[0].job.cancelRequested, false);
  acknowledgement.resolve({ success: true });
  assert.equal((await first).job.id, 'restored');
  assert.equal((await second).job.id, 'restored');
  const saved = await h.engine({ action: 'saveBlob', jobId: job.id, filename: 'movie.mp4', url: `blob:${extensionUrl('')}new-attempt` });
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

test('obsolete mode labels cannot override a valid saved numeric slider preference', async () => {
  const h = setup({ settings: { subfolder: 'Videos', concurrency: 8 } });
  assert.equal((await h.message({ action: 'getSettings' })).settings.concurrency, 8);
  for (const concurrencyMode of ['auto', 'fast', null, false, 2]) {
    const saved = await h.message({ action: 'saveSettings', settings: { concurrencyMode } });
    assert.equal(saved.settings.concurrency, 8);
    assert.equal(saved.settings.concurrencyMode, undefined);
  }
  const first = await h.message(hlsRequest);
  assert.equal(first.job.concurrencyMode, 'manual');
  assert.equal(h.calls.offscreen.find(call => call.action === 'runJob').job.concurrency, 8);
  await h.message({ action: 'saveSettings', settings: { concurrencyMode: 'manual', concurrency: 3 } });
  const second = await h.message({ ...hlsRequest, url: 'https://cdn.test/second.m3u8' });
  assert.equal(second.job.concurrencyMode, 'manual');
  assert.equal(second.job.concurrency, 3);
});

test('slider endpoints and intermediate values survive worker recreation', async () => {
  for (const concurrency of [1, 64, 128, 375]) {
    const h = setup({ settings: { subfolder: 'Keep', askWhereToSave: true, concurrency, concurrencyMode: 'auto' } });
    assert.equal((await h.message({ action: 'getSettings' })).settings.concurrency, concurrency);
    await h.message({ action: 'saveSettings', settings: { concurrency } });
    const recreated = setup({ settings: structuredClone(h.local.neko_settings_v1) });
    const saved = (await recreated.message({ action: 'getSettings' })).settings;
    assert.equal(saved.concurrency, concurrency);
    assert.equal(saved.subfolder, undefined);
    assert.equal(saved.askWhereToSave, undefined);
  }
});

test('job metrics accept only finite nonnegative aggregate rates and bounded concurrency', async () => {
  const h = setup();
  const { job } = await h.message(hlsRequest);
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', bytesPerSecond: 800000,
    activeConcurrency: 3, concurrencyMode: 'manual', concurrencyReason: 'manual' } });
  await tick();
  let current = h.session.neko_jobs_v1.find(item => item.id === job.id);
  assert.equal(current.bytesPerSecond, 800000); assert.equal(current.activeConcurrency, 3);
  assert.equal(current.concurrencyReason, 'manual');
  for (const invalid of [NaN, Infinity, -1, '100']) {
    await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', bytesPerSecond: invalid,
      activeConcurrency: 376, concurrencyMode: 'turbo', concurrencyReason: '<script>' } });
  }
  await tick();
  current = h.session.neko_jobs_v1.find(item => item.id === job.id);
  assert.equal(current.bytesPerSecond, 800000); assert.equal(current.activeConcurrency, 3);
  assert.equal(current.concurrencyMode, 'manual'); assert.equal(current.concurrencyReason, 'manual');
});

test('browser restart restores durable job metadata and offers verified cached HLS continuation', async () => {
  const h = setup({ localJobs: [restoredJob({ state: 'downloading', cachedSegments: 4, resumable: false })] });
  const response = await h.message({ action: 'getJobs' });
  assert.equal(response.jobs[0].state, 'interrupted');
  assert.equal(response.jobs[0].resumable, true);
  assert.match(response.jobs[0].stateReason, /分片可继续使用/);
  await tick();
  assert.equal(h.local.neko_jobs_v1[0].cachedSegments, 4);
  const resumed = await h.message({ action: 'retryJob', jobId: 'restored' });
  assert.equal(resumed.success, true);
  assert.ok(resumed.job.runId);
  assert.equal(h.calls.offscreen.find(call => call.action === 'runJob').job.resume, true);
});

test('out-of-order progress and old attempts cannot overwrite a newer state or save a Blob', async () => {
  const h = setup();
  const { job } = await h.message(hlsRequest);
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', revision: 20, bytesReceived: 40 } });
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'parsing', revision: 21, bytesReceived: 0 } });
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', revision: 19, bytesReceived: 1 } });
  await h.engine({ action: 'jobProgress', job: { id: job.id, runId: 'obsolete', state: 'interrupted', revision: 999 } });
  await tick();
  assert.equal(h.session.neko_jobs_v1[0].state, 'downloading');
  assert.equal(h.session.neko_jobs_v1[0].bytesReceived, 40);
  const rejected = await h.engine({ action: 'saveBlob', runId: 'obsolete', jobId: job.id, filename: 'movie.ts', url: `blob:${extensionUrl('')}old` });
  assert.equal(rejected.success, false);
  assert.equal(h.calls.nativeDownloads.length, 0);
});

test('a retry changes the attempt ID and ignores late completion from the previous attempt', async () => {
  const h = setup({ jobs: [restoredJob({ state: 'interrupted', runId: 'previous', resumable: true, cachedSegments: 3 })] });
  const retry = await h.message({ action: 'retryJob', jobId: 'restored' });
  assert.notEqual(retry.job.runId, 'previous');
  await h.engine({ action: 'jobProgress', job: { id: 'restored', runId: 'previous', revision: 100, state: 'complete' } });
  await tick();
  assert.equal(h.session.neko_jobs_v1[0].state, 'queued');
});

test('progress acknowledgement waits for durable metadata instead of only updating memory', async () => {
  const write = deferred();
  let block = false, acknowledged = false;
  const h = setup({ localSet: async () => { if (block) await write.promise; } });
  const { job } = await h.message(hlsRequest);
  block = true;
  const pending = h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', cachedSegments: 1 } }).then(reply => { acknowledged = true; return reply; });
  await tick();
  assert.equal(acknowledged, false);
  assert.equal(h.local.neko_jobs_v1[0].state, 'queued');
  write.resolve();
  assert.equal((await pending).success, true);
  assert.equal(h.local.neko_jobs_v1[0].cachedSegments, 1);
});

test('resuming an older interrupted job cannot duplicate a newer active download of the same URL', async () => {
  const h = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 2 })] });
  const fresh = await h.message(hlsRequest);
  assert.equal(fresh.success, true);
  assert.notEqual(fresh.job.id, 'restored');
  const retry = await h.message({ action: 'retryJob', jobId: 'restored' });
  assert.equal(retry.success, false);
  assert.match(retry.error, /同一视频已有下载任务/);
  const dispatched = h.calls.offscreen.filter(call => call.action === 'runJob');
  assert.deepEqual(dispatched.map(call => call.job.id), [fresh.job.id]);
  assert.equal(h.local.neko_jobs_v1.find(job => job.id === 'restored').cachedSegments, 2);
});

test('a retry reserves its URL before settings hydration against both starts and other cached retries', async () => {
  const preferences = deferred();
  let settingsReads = 0;
  const h = setup({ jobs: [
    restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 2 }),
    restoredJob({ id: 'other-cached', state: 'interrupted', resumable: true, cachedSegments: 3 })
  ], settingsRead: async () => { if (++settingsReads === 1) await preferences.promise; } });
  const pending = h.message({ action: 'retryJob', jobId: 'restored' });
  await tick();
  assert.equal(h.calls.offscreen.filter(call => call.action === 'runJob').length, 0);
  const fresh = await h.message(hlsRequest);
  assert.equal(fresh.job.id, 'restored');
  const other = await h.message({ action: 'retryJob', jobId: 'other-cached' });
  assert.equal(other.success, false);
  assert.match(other.error, /同一视频已有下载任务/);
  preferences.resolve();
  assert.equal((await pending).success, true);
  assert.deepEqual(h.calls.offscreen.filter(call => call.action === 'runJob').map(call => call.job.id), ['restored']);
});

test('HLS ETA reaches persisted jobs, rejects invalid estimates, and clears at saving', async () => {
  const h = setup();
  const { job } = await h.message(hlsRequest);
  const report = extra => h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', ...extra } });
  await report({ etaSeconds: 41.2, etaBasis: 'network-segments' });
  assert.equal(h.session.neko_jobs_v1[0].etaSeconds, 42);
  for (const etaSeconds of [null, NaN, Infinity, -1, 0, '20']) {
    await report({ etaSeconds, etaBasis: 'network-segments' });
    assert.equal(h.session.neko_jobs_v1[0].etaSeconds, null);
  }
  await report({ etaSeconds: 22, etaBasis: 'network-segments' });
  await report({ state: 'saving', etaSeconds: 22, etaBasis: 'network-segments' });
  assert.equal(h.session.neko_jobs_v1[0].etaSeconds, null);
  assert.equal(h.session.neko_jobs_v1[0].etaBasis, 'unknown');
});

test('direct download ETA uses Chrome estimate and becomes unknown when paused or absent', async () => {
  const h = setup();
  const { job } = await h.message({ action: 'startDownload', url: 'https://cdn.test/movie.mp4', filename: 'movie.mp4' });
  const item = h.items.get(job.downloadId);
  item.estimatedEndTime = new Date(Date.now() + 60000).toISOString();
  let current = (await h.message({ action: 'getJobs' })).jobs[0];
  assert.equal(current.etaBasis, 'chrome');
  assert.ok(current.etaSeconds >= 58 && current.etaSeconds <= 60);
  item.paused = true;
  current = (await h.message({ action: 'getJobs' })).jobs[0];
  assert.equal(current.etaSeconds, null);
  item.paused = false; delete item.estimatedEndTime;
  current = (await h.message({ action: 'getJobs' })).jobs[0];
  assert.equal(current.etaSeconds, null);
  item.state = 'complete'; item.estimatedEndTime = new Date(Date.now() + 60000).toISOString();
  current = (await h.message({ action: 'getJobs' })).jobs[0];
  assert.equal(current.etaSeconds, null);
});

test('preference writes serialize read-merge-write and subsequent downloads observe both saves', async () => {
  const blocked = deferred();
  let writes = 0, readFinished = false;
  const h = setup({ localSet: async value => {
    if ('neko_settings_v1' in value && ++writes === 1) await blocked.promise;
  } });
  const first = h.message({ action: 'saveSettings', settings: { subfolder: 'Saved/first', concurrency: 1 } });
  await tick();
  const second = h.message({ action: 'saveSettings', settings: { askWhereToSave: true, concurrency: 375 } });
  const read = h.message({ action: 'getSettings' }).then(result => { readFinished = true; return result; });
  const start = h.message({ action: 'startDownload', url: 'https://cdn.test/a.mp4', filename: 'a.mp4' });
  await tick();
  assert.equal(writes, 1);
  assert.equal(readFinished, false);
  assert.equal(h.calls.nativeDownloads.length, 0);
  blocked.resolve();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  const settings = (await read).settings;
  assert.equal(settings.subfolder, undefined);
  assert.equal(settings.askWhereToSave, undefined);
  assert.equal(settings.concurrency, 375);
  const started = await start;
  assert.equal(started.success, true);
  assert.equal(started.job.concurrency, 375);
  assert.equal(h.calls.nativeDownloads[0].filename, 'a.mp4');
  assert.equal(h.calls.nativeDownloads[0].saveAs, false);
});

test('a rejected preference write does not block later saves or reads', async () => {
  let writes = 0;
  const h = setup({ localSet: async value => {
    if ('neko_settings_v1' in value && ++writes === 1) throw new Error('temporary storage failure');
  } });
  const first = h.message({ action: 'saveSettings', settings: { subfolder: 'failed', concurrency: 375 } });
  const second = h.message({ action: 'saveSettings', settings: { subfolder: 'saved', askWhereToSave: true, concurrency: 23 } });
  assert.equal((await first).success, false);
  assert.equal((await second).success, true);
  const result = await h.message({ action: 'getSettings' });
  assert.equal(result.settings.subfolder, undefined);
  assert.equal(result.settings.askWhereToSave, undefined);
  assert.equal(result.settings.concurrency, 23);
});

test('slider broadcasts to active and queued HLS jobs, preserving native downloads and terminal history', async () => {
  const stored = [
    restoredJob({ id: 'active', state: 'downloading', concurrency: 64, runId: 'a', progressRevision: 0 }),
    restoredJob({ id: 'queued', state: 'queued', concurrency: 64 }),
    restoredJob({ id: 'done', state: 'complete', concurrency: 64 }),
    restoredJob({ id: 'direct', state: 'downloading', isM3U8: false, concurrency: 64 })
  ];
  const h = setup({ jobs: stored, contexts: [{}] });
  const result = await h.message({ action: 'saveSettings', settings: { concurrency: 1 } });
  assert.equal(result.liveApplied, true);
  assert.equal(h.calls.create.length, 0);
  for (const id of ['active', 'queued']) {
    const job = h.local.neko_jobs_v1.find(item => item.id === id);
    assert.equal(job.concurrency, 1); assert.equal(job.targetConcurrency, id === 'active' ? 1 : 0); assert.equal(job.concurrencyRevision, 1);
  }
  for (const id of ['done', 'direct']) assert.equal(h.local.neko_jobs_v1.find(item => item.id === id).concurrency, 64);
  await h.engine({ action: 'jobProgress', job: { id: 'active', state: 'downloading', concurrencyRevision: 0,
    targetConcurrency: 64, activeConcurrency: 64, inFlightRequests: 15, bytesReceived: 100 } });
  const job = h.local.neko_jobs_v1.find(item => item.id === 'active');
  assert.equal(job.targetConcurrency, 1); assert.equal(job.activeConcurrency, 1);
  assert.equal(job.inFlightRequests, 15, 'Already-started requests drain without falsifying their count');
  assert.equal(job.bytesReceived, 100, 'A late control version still reports useful transfer progress');
});

test('saved slider changes report failed delivery honestly and retry after worker recreation', async () => {
  const h = setup({ jobs: [restoredJob({ state: 'downloading', concurrency: 64 })], contexts: [{}],
    offscreen: async () => { throw new Error('message port lost'); } });
  const result = await h.message({ action: 'saveSettings', settings: { concurrency: 375 } });
  assert.equal(result.success, true); assert.equal(result.liveApplied, false); assert.match(result.warning, /message port lost/);
  assert.equal(h.local.neko_settings_v1.concurrency, 375);
  assert.equal(h.local.neko_concurrency_revision_v1, 1);
  const calls = [];
  const recreated = setup({ jobs: h.session.neko_jobs_v1, settings: h.local.neko_settings_v1,
    concurrencyRevision: h.local.neko_concurrency_revision_v1, contexts: [{}], offscreen: async message => {
      calls.push(message);
      if (message.action === 'setConcurrency') return { success: true, concurrency: message.concurrency, concurrencyRevision: message.concurrencyRevision };
      return { jobs: [{ id: 'restored', state: 'downloading', concurrency: 375, concurrencyRevision: 1, targetConcurrency: 375 }] };
    } });
  const jobs = await recreated.message({ action: 'getJobs' });
  assert.equal(jobs.success, true); assert.equal(jobs.jobs[0].concurrency, 375);
  assert.equal(calls[0].action, 'setConcurrency'); assert.equal(calls[0].concurrencyRevision, 1);
  const retried = await recreated.message({ action: 'saveSettings', settings: { concurrency: 375 } });
  assert.equal(retried.liveApplied, true); assert.equal(recreated.local.neko_concurrency_revision_v1, 2);
});

test('a slider write during offscreen creation reaches the newly dispatched task', async () => {
  const opening = deferred(); let contextCalls = 0;
  const h = setup({ getContexts: () => ++contextCalls === 1 ? opening.promise : Promise.resolve([]), settings: { concurrency: 73 } });
  const starting = h.message(hlsRequest); await tick();
  const changed = await h.message({ action: 'saveSettings', settings: { concurrency: 5 } });
  assert.equal(changed.success, true);
  opening.resolve([]);
  assert.equal((await starting).success, true);
  const dispatched = h.calls.offscreen.find(message => message.action === 'runJob');
  assert.equal(dispatched.job.concurrency, 5); assert.equal(dispatched.job.concurrencyRevision, 1);
});

test('no executor is created merely to save an idle slider and its revision survives recreation', async () => {
  const h = setup({ settings: { concurrency: 73 } });
  const response = await h.message({ action: 'saveSettings', settings: { concurrency: 375 } });
  assert.equal(response.liveApplied, true); assert.equal(h.calls.create.length, 0); assert.equal(h.calls.offscreen.length, 0);
  const recreated = setup({ settings: h.local.neko_settings_v1, concurrencyRevision: h.local.neko_concurrency_revision_v1 });
  const { job } = await recreated.message(hlsRequest);
  assert.equal(job.concurrency, 375); assert.equal(job.concurrencyRevision, 1);
  assert.deepEqual(JSON.parse(JSON.stringify((await recreated.message({ action: 'getSettings' })).settings)), { concurrency: 375 });
});

test('passive progress preserves only bounded concurrency facts and ignores obsolete automatic decisions', async () => {
  const h = setup(); const { job } = await h.message(hlsRequest);
  const measurements = {
    activeConcurrency: 375, targetConcurrency: 375, inFlightRequests: 340,
    bytesPerSecond: 800000, concurrencyMode: 'manual', concurrencyReason: 'manual', phase: 'downloading'
  };
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading', ...measurements,
    resourceCap: 2, networkEnvironment: 'server-limited', decisionReason: 'rate-limited', ttfbMs: 100 } });
  let saved = h.session.neko_jobs_v1.find(item => item.id === job.id);
  for (const [key, value] of Object.entries(measurements)) assert.equal(saved[key], value, key);
  for (const key of ['resourceCap', 'networkEnvironment', 'decisionReason', 'ttfbMs']) assert.equal(saved[key], undefined);
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading',
    activeConcurrency: 376, targetConcurrency: 376, inFlightRequests: -1,
    bytesPerSecond: Infinity, concurrencyMode: 'auto', concurrencyReason: 'probing'
  } });
  saved = h.session.neko_jobs_v1.find(item => item.id === job.id);
  for (const [key, value] of Object.entries(measurements)) assert.equal(saved[key], value, `Invalid update changed ${key}`);
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'downloading',
    activeConcurrency: 0, targetConcurrency: 0, inFlightRequests: 0, bytesPerSecond: 0
  } });
  saved = h.session.neko_jobs_v1.find(item => item.id === job.id);
  assert.equal(saved.inFlightRequests, 0); assert.equal(saved.targetConcurrency, 0);
  assert.equal(saved.bytesPerSecond, 0);
});

test('legacy destination preferences cannot redirect new downloads or reopened HLS saves', async () => {
  const h = setup({ settings: { concurrency: 23, subfolder: '../old', askWhereToSave: true } });
  const direct = await h.message({ action: 'startDownload', url: 'https://cdn.test/a.mp4', filename: 'Old/Nested/a.mp4', saveAs: true });
  assert.equal(direct.job.filename, 'a.mp4');
  assert.equal(h.calls.nativeDownloads[0].filename, 'a.mp4'); assert.equal(h.calls.nativeDownloads[0].saveAs, false);
  const legacy = setup({ jobs: [restoredJob({ filename: 'Old/movie.ts', subfolder: 'Old', saveAs: true })] });
  const saved = await legacy.engine({ action: 'saveBlob', jobId: 'restored', filename: 'Old/movie.ts', url: `blob:${extensionUrl('')}legacy`, saveAs: true });
  assert.equal(saved.success, true);
  assert.equal(legacy.calls.nativeDownloads[0].filename, 'movie.ts');
  assert.equal(legacy.calls.nativeDownloads[0].saveAs, false);
  const tracking = setup({ jobs: [restoredJob({ filename: 'Old/movie.ts', downloadId: 81, saveAs: true })],
    items: [{ id: 81, state: 'in_progress', filename: 'D:/Previous/movie.ts' }] });
  assert.equal((await tracking.engine({ action: 'saveBlob', jobId: 'restored', filename: 'movie.ts', url: `blob:${extensionUrl('')}old-id` })).downloadId, 81);
  assert.equal(tracking.calls.nativeDownloads.length, 0, 'An existing Chrome save is tracked, never recreated');
});

test('removing a completed direct job deletes only the extension record and is idempotent', async () => {
  const job = restoredJob({ isM3U8: false, state: 'complete', downloadId: 9 });
  const h = setup({ jobs: [job], items: [{ id: 9, state: 'complete', filename: 'C:/Downloads/movie.mp4' }] });
  const result = await h.message({ action: 'removeJob', jobId: job.id });
  assert.equal(result.success, true); assert.equal(result.jobId, job.id);
  assert.equal(h.local.neko_jobs_v1.length, 0); assert.equal(h.session.neko_jobs_v1.length, 0);
  assert.equal((await h.message({ action: 'getJobs' })).jobs.length, 0);
  assert.equal((await h.message({ action: 'removeJob', jobId: job.id })).success, true);
  assert.equal(h.items.has(9), true); assert.equal(h.calls.erased.length, 0); assert.equal(h.calls.removedFiles.length, 0);
  assert.equal(h.calls.offscreen.length, 0);
});

test('HLS removal waits for cleanup, shares duplicate requests, blocks retry/discard, and ignores late progress', async () => {
  const cleanup = deferred();
  const h = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 3 })],
    offscreen: async message => message.action === 'removeJob' ? cleanup.promise : { success: true } });
  let settled = false;
  const first = h.message({ action: 'removeJob', jobId: 'restored' }).then(value => { settled = true; return value; });
  await tick();
  const second = h.message({ action: 'removeJob', jobId: 'restored' });
  assert.equal((await h.message({ action: 'retryJob', jobId: 'restored' })).success, false);
  assert.equal((await h.message({ action: 'discardJob', jobId: 'restored' })).success, false);
  assert.equal(settled, false); assert.equal(h.session.neko_jobs_v1.length, 1);
  assert.equal(h.calls.offscreen.filter(call => call.action === 'removeJob').length, 1);
  cleanup.resolve({ success: true });
  assert.equal((await first).success, true); assert.equal((await second).success, true);
  await h.engine({ action: 'jobProgress', job: { id: 'restored', state: 'downloading', revision: 999 } });
  assert.equal((await h.message({ action: 'getJobs' })).jobs.length, 0);
  assert.equal(h.local.neko_jobs_v1.length, 0);
});

test('failed cache removal keeps a visible retryable record, and a later removal succeeds', async () => {
  let removals = 0;
  const h = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 3 })],
    offscreen: async message => message.action === 'removeJob' && ++removals === 1 ? { success: false, error: 'disk unavailable' } : { success: true } });
  const failed = await h.message({ action: 'removeJob', jobId: 'restored' });
  assert.equal(failed.success, false);
  const kept = h.local.neko_jobs_v1[0];
  assert.equal(kept.cachedSegments, 3); assert.equal(kept.resumable, true); assert.match(kept.cleanupError, /disk unavailable/);
  assert.equal((await h.message({ action: 'removeJob', jobId: 'restored' })).success, true);
  assert.equal(h.local.neko_jobs_v1.length, 0);
});

test('removal rejects active jobs, active Chrome saves, and conflicting retry/discard operations', async () => {
  for (const state of ['queued', 'parsing', 'downloading', 'saving']) {
    const h = setup({ jobs: [restoredJob({ state })] });
    assert.equal((await h.message({ action: 'removeJob', jobId: 'restored' })).success, false, state);
    assert.equal(h.calls.offscreen.length, 0);
  }
  const saving = setup({ jobs: [restoredJob({ state: 'interrupted', downloadId: 9 })], items: [{ id: 9, state: 'in_progress' }] });
  assert.equal((await saving.message({ action: 'removeJob', jobId: 'restored' })).success, false);
  assert.equal(saving.calls.offscreen.length, 0);
  for (const action of ['retryJob', 'discardJob']) {
    const gate = deferred();
    const h = setup({ jobs: [restoredJob({ state: 'interrupted', resumable: true, cachedSegments: 2 })],
      offscreen: async message => ['runJob', 'discardJob'].includes(message.action) ? gate.promise : { success: true } });
    const pending = h.message({ action, jobId: 'restored' });
    await tick();
    assert.equal((await h.message({ action: 'removeJob', jobId: 'restored' })).success, false, action);
    gate.resolve({ success: true }); await pending;
  }
});

test('a pending native-save creation blocks removal even after an interrupted progress snapshot', async () => {
  const gate = deferred();
  const h = setup({ download: async (_options, items) => { await gate.promise; items.set(7, { id: 7, state: 'in_progress' }); return 7; } });
  const { job } = await h.message(hlsRequest);
  const save = h.engine({ action: 'saveBlob', jobId: job.id, filename: 'movie.ts', url: `blob:${extensionUrl('')}pending` });
  await tick();
  await h.engine({ action: 'jobProgress', job: { id: job.id, state: 'interrupted' } });
  assert.equal((await h.message({ action: 'removeJob', jobId: job.id })).success, false);
  assert.equal(h.calls.offscreen.filter(call => call.action === 'removeJob').length, 0);
  gate.resolve(); await save;
});

test('durable empty history wins over a stale session mirror after mirror failure and worker recreation', async () => {
  const old = restoredJob({ isM3U8: false, state: 'cancelled' });
  const h = setup({ jobs: [old], sessionSet: async () => { throw new Error('mirror unavailable'); } });
  assert.equal((await h.message({ action: 'removeJob', jobId: old.id })).success, true);
  assert.equal(h.local.neko_jobs_v1.length, 0); assert.equal(h.session.neko_jobs_v1.length, 1);
  const restarted = setup({ jobs: structuredClone(h.session.neko_jobs_v1), localJobs: structuredClone(h.local.neko_jobs_v1) });
  assert.equal((await restarted.message({ action: 'getJobs' })).jobs.length, 0);
});

test('cleanup followed by a failed local deletion keeps a record without pretending the cleared cache survives', async () => {
  let failed = false;
  const h = setup({ jobs: [restoredJob({ state: 'interrupted', cachedSegments: 3, resumable: true })],
    localSet: async value => { if (value.neko_jobs_v1?.length === 0 && !failed) { failed = true; throw new Error('local unavailable'); } } });
  assert.equal((await h.message({ action: 'removeJob', jobId: 'restored' })).success, false);
  const kept = (await h.message({ action: 'getJobs' })).jobs[0];
  assert.equal(kept.state, 'interrupted'); assert.equal(kept.cachedSegments, 0); assert.equal(kept.resumable, false);
  assert.equal(h.local.neko_jobs_v1[0].cachedSegments, 0);
  assert.equal((await h.message({ action: 'removeJob', jobId: 'restored' })).success, true);
});

test('late Chrome lookups cannot reopen an object while its deletion commits or rolls back', async () => {
  for (const rejectDelete of [false, true]) {
    const stale = deferred(), write = deferred(); let searches = 0, deletionStarted = false, deleteAttempt = 0;
    const h = setup({ jobs: [restoredJob({ isM3U8: false, state: 'downloading', downloadId: 8 })],
      search: async () => ++searches === 1 ? stale.promise : [{ id: 8, state: 'complete' }],
      localSet: async value => { if (value.neko_jobs_v1?.length === 0 && ++deleteAttempt === 1) { deletionStarted = true; await write.promise; if (rejectDelete) throw new Error('delete write failed'); } } });
    h.chrome.downloads.onChanged.emit({ id: 8 }); await tick();
    assert.equal((await h.message({ action: 'getJobs' })).jobs[0].state, 'complete');
    const deleting = h.message({ action: 'removeJob', jobId: 'restored' }); await tick();
    assert.equal(deletionStarted, true);
    stale.resolve([{ id: 8, state: 'in_progress' }]); await tick();
    write.resolve();
    assert.equal((await deleting).success, !rejectDelete);
    const records = (await h.message({ action: 'getJobs' })).jobs;
    assert.equal(records.length, rejectDelete ? 1 : 0);
    if (rejectDelete) assert.equal(records[0].state, 'complete');
  }
});

test('a failed durable-history read refuses writes instead of treating old records as an empty history', async () => {
  const h = setup({ jobs: [restoredJob({ state: 'complete' })], localGet: async key => { if (key === 'neko_jobs_v1') throw new Error('read unavailable'); } });
  assert.equal((await h.message(hlsRequest)).success, false);
  assert.equal((await h.message({ action: 'getJobs' })).success, false);
  assert.equal(h.calls.nativeDownloads.length, 0); assert.equal(h.local.neko_jobs_v1, undefined);
  assert.equal(h.session.neko_jobs_v1.length, 1);
});

test('failed cancel delivery clears the request flag so the user can cancel again', async () => {
  let attempts = 0;
  const h = setup({ offscreen: async message => message.action === 'cancelJob' && ++attempts === 1 ? { success: false, error: 'not delivered' } : { success: true } });
  const { job } = await h.message(hlsRequest);
  assert.equal((await h.message({ action: 'cancelJob', jobId: job.id })).success, false);
  await tick();
  assert.equal(h.local.neko_jobs_v1.find(item => item.id === job.id).cancelRequested, false);
  assert.equal((await h.message({ action: 'cancelJob', jobId: job.id })).success, true);
  assert.equal(attempts, 2);
});
