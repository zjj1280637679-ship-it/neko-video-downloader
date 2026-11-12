const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createOffscreenRunner } = require('../offscreen.js');
const core = require('../hls-core.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for worker state');
}
function fixture(options = {}) {
  const events = [], messages = [], started = [], saved = [], cancelled = [], files = [], revoked = [], sources = [];
  const items = new Map();
  let listener;
  const runtime = {
    id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener(value) { listener = value; } },
    async sendMessage(message) {
      assert.equal(message.target, 'neko-background');
      messages.push(structuredClone(message));
      if (message.action === 'jobProgress') {
        events.push(`${message.job.id}:${message.job.state}`);
        await options.progress?.(message.job);
        return { success: true };
      }
      if (message.action === 'saveBlob') {
        if (options.noDownloadCreated) return { success: false, error: 'Download could not start' };
        const existing = saved.findIndex(job => job.jobId === message.jobId);
        const id = existing >= 0 ? existing + 1 : saved.length + 1;
        if (existing < 0) {
          saved.push(message);
          items.set(id, { state: options.pendingSave ? 'in_progress' : 'complete', bytesReceived: 4, filename: `C:/Downloads/${message.filename}` });
        }
        events.push(`save:${message.jobId}`);
        if (options.saveBlob) return options.saveBlob(message, id);
        return { success: true, downloadId: id };
      }
      if (message.action === 'getChromeDownload') {
        if (options.lookup) return options.lookup(message, items, saved);
        if (message.downloadId === undefined) {
          const index = saved.findIndex(job => job.jobId === message.jobId);
          return { success: true, downloadId: index >= 0 ? index + 1 : null, item: index >= 0 ? items.get(index + 1) : null, pending: false };
        }
        return { success: true, item: items.get(message.downloadId) };
      }
      if (message.action === 'cancelChromeDownload') {
        cancelled.push(message.downloadId);
        if (options.cancel) await options.cancel();
        items.set(message.downloadId, { state: 'interrupted', error: 'USER_CANCELED' });
        events.push(`cancel:${message.jobId}`);
        return { success: true };
      }
      throw new Error('Unexpected message');
    }
  };
  const root = {
    async getFileHandle(name, config) {
      assert.equal(config.create, true);
      assert.match(name, /^neko-download-[0-9a-f-]+\.part$/);
      const file = { name, bytes: 0, writes: 0, closed: false, aborted: false, removed: false };
      files.push(file);
      return {
        async createWritable() {
          if (options.openError) throw options.openError;
          return {
            async write(data) {
              if (options.writeError) throw options.writeError;
              file.bytes += data.byteLength;
              file.writes++;
            },
            async close() { file.closed = true; events.push('close'); },
            async abort() { file.aborted = true; events.push('abort'); }
          };
        },
        async getFile() {
          assert.equal(file.closed, true);
          // Model a lazy, disk-backed OPFS snapshot without allocating hundreds
          // of MB for the large-file regression. Reading it into JS is a bug.
          return { size: file.bytes, type: '',
            arrayBuffer() { assert.fail('OPFS video must not be read back into JS memory'); },
            text() { assert.fail('OPFS video must not be read back as text'); },
            slice(start, end, type) {
              assert.equal(start, 0); assert.equal(end, file.bytes);
              file.slicedType = type;
              return { size: end - start, type };
            }
          };
        }
      };
    },
    async removeEntry(name, config) {
      if (/^neko-cache-[a-f0-9]{64}$/.test(name)) {
        assert.equal(config?.recursive, true);
        await options.cacheRemove?.(name); events.push('cache-remove'); return;
      }
      const file = files.find(value => value.name === name);
      assert.ok(file, 'Must only remove a file owned by this runner');
      await options.removeTemp?.(name);
      file.removed = true;
      events.push('remove');
    }
  };
  const storage = options.noStorage ? undefined : { async getDirectory() {
    if (options.directoryError) throw options.directoryError;
    return root;
  } };
  const hls = {
    safeFilename: core.safeFilename,
    createClient({ signal, onMetrics }) {
      let source;
      return {
        async loadPlan(url) {
          source = url;
          started.push(url);
          if (options.loadPlan) return options.loadPlan(url, signal);
          return { segments: [{}], totalDuration: 5, isFmp4: false, maps: new Map(), discontinuities: 0 };
        },
        async download(plan, sink, progress, concurrency) {
          if (options.download) return options.download(sink, signal, progress, source, concurrency, onMetrics);
          await sink.write(new Uint8Array([1, 2, 3, 4]).buffer);
          progress({ bytes: 4, completed: 1, total: 1 });
        }
      };
    }
  };
  const runner = createOffscreenRunner({ runtime, hls, storage, cryptoApi: webcrypto,
    urlApi: { createObjectURL(blob) { sources.push(blob); return `blob:chrome-extension://test-extension/${webcrypto.randomUUID()}`; }, revokeObjectURL: url => revoked.push(url) },
    pollMs: 2, progressMs: options.progressMs ?? 500, logger: { warn() {} } }).attach();
  const sender = { id: runtime.id, url: runtime.getURL('background.js') };
  function message(value, origin = sender) {
    let result;
    assert.equal(listener({ target: 'neko-offscreen', ...value }, origin, reply => { result = reply; }), false);
    return result;
  }
  function run(id, extra = {}) { return message({ action: 'runJob', job: { id, url: `https://fixture.test/${id}.m3u8`, filename: `Movies/${id}.mp4`, title: id, isM3U8: true, saveAs: false, tabId: 3, ...extra } }); }
  function request(value, origin = sender) {
    return new Promise(resolve => {
      const result = listener({ target: 'neko-offscreen', ...value }, origin, resolve);
      if (result !== true) queueMicrotask(() => resolve(undefined));
    });
  }
  function status(id) { return runner.getJobs().find(job => job.id === id); }
  return { runner, message, request, run, status, runtime, events, messages, started, saved, cancelled, files, revoked, items, sources };
}

test('background-only message boundary ignores content scripts, popup and wrong target', () => {
  const f = fixture();
  assert.equal(f.message({ action: 'getOffscreenJobs' }, { id: f.runtime.id, tab: { id: 5 } }), undefined);
  assert.equal(f.message({ action: 'getOffscreenJobs' }, { id: f.runtime.id, url: f.runtime.getURL('popup.html') }), undefined);
  assert.equal(f.message({ action: 'getOffscreenJobs' }, { id: 'other' }), undefined);
  assert.equal(f.message({ target: 'neko-background', action: 'getOffscreenJobs' }), undefined);
  assert.deepEqual(f.message({ action: 'getOffscreenJobs' }), { jobs: [] });
});

test('immediate job ack is independent of popup; default save has no picker', async () => {
  const f = fixture();
  const result = f.run('one');
  assert.equal(result.success, true);
  assert.equal(result.job.state, 'queued');
  assert.equal(f.started.length, 0);
  // No popup, DOM or window is present in this test environment.
  await until(() => f.status('one').state === 'complete');
  assert.equal(f.saved[0].filename, 'one.ts');
  assert.equal(f.saved[0].saveAs, false);
  assert.equal(f.files[0].removed, true);
  assert.ok(f.events.indexOf('remove') < f.events.indexOf('one:complete'));
  assert.equal(f.revoked.length, 1);
});

test('queued jobs execute one at a time and queued cancellation never fetches', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ async download(sink, _signal, progress, url) {
    if (url.includes('/one.')) await gate;
    await sink.write(new Uint8Array(4).buffer);
    progress({ bytes: 4, completed: 1, total: 1 });
  } });
  f.run('one'); f.run('two'); f.run('three');
  await until(() => f.status('one').state === 'downloading');
  assert.equal(f.started.length, 1);
  assert.equal(f.status('one').queuePosition, 0);
  assert.equal(f.status('two').queuePosition, 1);
  assert.equal(f.status('three').queuePosition, 2);
  assert.equal(f.message({ action: 'cancelJob', jobId: 'two' }).success, true);
  assert.equal(f.status('two').state, 'cancelled');
  assert.equal(f.status('three').queuePosition, 1);
  release();
  await until(() => f.status('three').state === 'complete');
  assert.deepEqual(f.started, ['https://fixture.test/one.m3u8', 'https://fixture.test/three.m3u8']);
  assert.ok(f.events.indexOf('one:complete') < f.events.indexOf('three:parsing'));
});

test('running cancellation aborts writer, cleans temporary file and advances queue', async () => {
  const f = fixture({ async download(sink, signal, progress, url) {
    if (url.includes('/one.')) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    await sink.write(new Uint8Array(4).buffer);
    progress({ bytes: 4, completed: 1, total: 1 });
  } });
  f.run('one'); f.run('two');
  await until(() => f.status('one').state === 'downloading');
  assert.equal(f.message({ action: 'cancelJob', jobId: 'one' }).success, true);
  await until(() => f.status('two').state === 'complete');
  assert.equal(f.status('one').state, 'cancelled');
  assert.equal(f.files[0].aborted, true);
  assert.equal(f.files[0].removed, true);
  assert.equal(f.saved.length, 1);
});

test('OPFS larger than memory limit remains until Chrome confirms completion', async () => {
  const total = 563 * 1024 * 1024;
  const f = fixture({ pendingSave: true, async download(sink, _signal, progress) {
    await sink.write({ byteLength: total });
    progress({ bytes: total, completed: 1, total: 1 });
  } });
  f.run('large');
  await until(() => f.saved.length === 1);
  assert.equal(f.files[0].bytes, total);
  assert.equal(f.files[0].closed, true);
  assert.equal(f.files[0].slicedType, 'video/mp2t');
  assert.equal(f.sources[0].type, 'video/mp2t');
  assert.equal(f.sources[0].size, total);
  assert.equal(f.files[0].removed, false);
  assert.equal(f.revoked.length, 0);
  assert.equal(f.status('large').state, 'saving');
  f.items.set(1, { state: 'complete', bytesReceived: total, filename: 'C:/Downloads/large.ts' });
  await until(() => f.status('large').state === 'complete');
  assert.equal(f.files[0].removed, true);
  assert.equal(f.status('large').savedFilename, 'C:/Downloads/large.ts');
});

test('OPFS and memory outputs declare the same MIME type and matching TS or MP4 suffix', async () => {
  for (const noStorage of [false, true]) for (const isFmp4 of [false, true]) {
    const f = fixture({ noStorage, async loadPlan() {
      return { segments: [{}], totalDuration: 5, isFmp4, maps: new Map(), discontinuities: 0 };
    } });
    f.run('typed');
    await until(() => f.status('typed').state === 'complete');
    assert.equal(f.sources[0].type, isFmp4 ? 'video/mp4' : 'video/mp2t');
    assert.equal(f.sources[0].size, 4);
    assert.equal(f.saved[0].filename, isFmp4 ? 'typed.mp4' : 'typed.ts');
  }
});

test('cancel during Chrome save waits for cancellation broker before cleanup', async () => {
  let finishCancel;
  const gate = new Promise(resolve => { finishCancel = resolve; });
  const f = fixture({ pendingSave: true, cancel: () => gate });
  f.run('one');
  await until(() => f.saved.length === 1);
  f.message({ action: 'cancelJob', jobId: 'one' });
  await until(() => f.cancelled.length === 1);
  assert.equal(f.files[0].removed, false);
  assert.equal(f.status('one').state, 'saving');
  finishCancel();
  await until(() => f.status('one').state === 'cancelled');
  assert.equal(f.files[0].removed, true);
  assert.ok(f.events.indexOf('cancel:one') < f.events.indexOf('remove'));
});

test('quota failure is terminal, cleans the owned file and does not fallback', async () => {
  const f = fixture({ writeError: new DOMException('quota', 'QuotaExceededError') });
  f.run('one');
  await until(() => f.status('one').state === 'interrupted');
  assert.equal(f.files[0].aborted, true);
  assert.equal(f.files[0].removed, true);
  assert.equal(f.saved.length, 0);
  assert.match(f.status('one').error, /空间不足/);
});

test('OPFS open error cleans file, unsupported API uses bounded memory', async () => {
  const f = fixture({ openError: new DOMException('quota', 'QuotaExceededError') });
  f.run('one');
  await until(() => f.status('one').state === 'interrupted');
  assert.equal(f.files[0].removed, true);
  const noOpfs = fixture({ noStorage: true, async download(sink) { await sink.write({ byteLength: 257 * 1024 * 1024 }); } });
  noOpfs.run('big');
  await until(() => noOpfs.status('big').state === 'interrupted');
  assert.match(noOpfs.status('big').error, /256 MB/);
  assert.equal(noOpfs.saved.length, 0);
});

test('Chrome interrupted save is never complete and temp cleanup still runs', async () => {
  const f = fixture({ pendingSave: true });
  f.run('one');
  await until(() => f.saved.length === 1);
  f.items.set(1, { state: 'interrupted', error: 'FILE_NO_SPACE' });
  await until(() => f.status('one').state === 'interrupted');
  assert.match(f.status('one').error, /FILE_NO_SPACE/);
  assert.equal(f.files[0].removed, true);
  assert.equal(f.events.includes('one:complete'), false);
});

test('duplicate run is idempotent and snapshots recover terminal state', async () => {
  const f = fixture();
  f.run('one'); f.run('one');
  await until(() => f.status('one').state === 'complete');
  const response = f.run('one');
  assert.equal(response.job.state, 'complete');
  await tick();
  assert.equal(f.saved.length, 1);
  assert.equal(f.message({ action: 'getOffscreenJobs' }).jobs[0].state, 'complete');
});

test('rapid segment progress is throttled while terminal updates are immediate', async () => {
  const f = fixture({ async download(sink, _signal, progress) {
    for (let i = 1; i <= 100; i++) {
      await sink.write(new Uint8Array(1).buffer);
      progress({ bytes: i, completed: i, total: 100 });
    }
  } });
  f.run('one');
  await until(() => f.status('one').state === 'complete');
  const progress = f.messages.filter(message => message.action === 'jobProgress' && message.job.state === 'downloading');
  assert.ok(progress.length <= 2, `Unexpected ${progress.length} unthrottled messages`);
  assert.equal(f.status('one').completedSegments, 100);
  assert.ok(f.messages.some(message => message.action === 'jobProgress' && message.job.state === 'complete'));
});

test('lost save acknowledgement recovers idempotently before cleaning source', async () => {
  let acknowledgements = 0;
  const f = fixture({ saveBlob(_message, id) {
    if (++acknowledgements === 1) throw new Error('worker response lost');
    return { success: true, downloadId: id };
  } });
  f.run('one');
  await until(() => f.status('one').state === 'complete');
  assert.equal(f.saved.length, 1);
  assert.equal(acknowledgements, 2);
  assert.equal(f.files[0].removed, true);
});

test('cancel during saving acknowledgement never creates a native download or save-as dialog', async () => {
  let release;
  const acknowledgement = new Promise(resolve => { release = resolve; });
  const f = fixture({ async progress(job) {
    if (job.id === 'one' && job.state === 'saving') await acknowledgement;
  } });
  f.run('one', { saveAs: true });
  f.run('two');
  await until(() => f.messages.some(message => message.action === 'jobProgress' && message.job.id === 'one' && message.job.state === 'saving'));
  assert.equal(f.saved.length, 0);
  assert.equal(f.message({ action: 'cancelJob', jobId: 'one' }).success, true);
  release();
  await until(() => f.status('two').state === 'complete');
  assert.equal(f.status('one').state, 'cancelled');
  assert.equal(f.saved.some(job => job.jobId === 'one'), false);
  assert.equal(f.messages.some(message => message.action === 'saveBlob' && message.jobId === 'one'), false);
  assert.equal(f.cancelled.length, 0);
  assert.equal(f.files[0].removed, true);
  assert.equal(f.revoked.length, 2, 'Both cancelled source and next completed source are released');
});

test('all save acknowledgements lost recovers existing Chrome download by job id', async () => {
  const f = fixture({ saveBlob() { throw new Error('all replies lost'); } });
  f.run('one');
  await until(() => f.status('one').state === 'complete');
  assert.equal(f.saved.length, 1);
  assert.equal(f.files[0].removed, true);
  assert.ok(f.messages.some(message => message.action === 'getChromeDownload' && message.downloadId === undefined));
});

test('confirmed absent Chrome download permits cleanup after save failure', async () => {
  const f = fixture({ noDownloadCreated: true });
  f.run('one');
  await until(() => f.status('one').state === 'interrupted');
  assert.equal(f.files[0].removed, true);
  assert.equal(f.revoked.length, 1);
  assert.equal(f.status('one').cleanupError, null);
});

test('pending save acknowledgement retains source through cancellation until id is known', async () => {
  let registered = false;
  const f = fixture({ pendingSave: true, saveBlob() { throw new Error('response lost'); }, lookup(message, items) {
    if (message.downloadId === undefined) return registered ? { success: true, downloadId: 1, item: items.get(1) } : { success: true, downloadId: null, item: null, pending: true };
    return { success: true, item: items.get(message.downloadId) };
  } });
  f.run('one');
  await until(() => f.messages.some(message => message.action === 'getChromeDownload' && message.downloadId === undefined));
  f.message({ action: 'cancelJob', jobId: 'one' });
  await tick();
  assert.equal(f.files[0].removed, false);
  assert.equal(f.revoked.length, 0);
  registered = true;
  await until(() => f.status('one').state === 'cancelled');
  assert.equal(f.cancelled.length, 1);
  assert.equal(f.files[0].removed, true);
});

test('offscreen defaults to 64, uses the selected count and clears speed while saving', async () => {
  for (const config of [{ expected: 64 }, { concurrency: 3, expected: 3 }, { concurrency: 375, expected: 375 }]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ async download(sink, _signal, progress, _url, concurrency, onMetrics) {
      assert.equal(concurrency.get(), config.expected);
      assert.equal(typeof concurrency.subscribe, 'function');
      onMetrics({ bytesPerSecond: 1234567, activeConcurrency: 3, concurrencyMode: 'manual', concurrencyReason: 'manual' });
      await gate;
      await sink.write(new Uint8Array(4).buffer);
      progress({ bytes: 4, completed: 1, total: 1 });
    } });
    f.run('adaptive', config);
    await until(() => f.status('adaptive').bytesPerSecond === 1234567);
    assert.equal(f.status('adaptive').activeConcurrency, config.expected);
    assert.equal(f.status('adaptive').concurrencyMode, 'manual');
    release();
    await until(() => f.status('adaptive').state === 'complete');
    assert.equal(f.status('adaptive').bytesPerSecond, 0);
    assert.equal(f.status('adaptive').activeConcurrency, 0);
  }
});

test('offscreen forwards selected and actual requests without automatic decisions', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const metrics = { bytesPerSecond: 1234567, activeConcurrency: 16, targetConcurrency: 16, inFlightRequests: 9,
    concurrencyMode: 'manual', concurrencyReason: 'manual', etaSeconds: 12, etaBasis: 'network-segments' };
  const f = fixture({ async download(sink, _signal, progress, _source, _concurrency, onMetrics) {
    onMetrics(metrics); await gate;
    await sink.write(new Uint8Array(4).buffer); progress({ bytes: 4, completed: 1, total: 1 });
  } });
  f.run('environment', { concurrency: 16 });
  await until(() => f.status('environment').targetConcurrency === 16);
  for (const [key, value] of Object.entries(metrics)) assert.equal(f.status('environment')[key], value, key);
  release(); await until(() => f.status('environment').state === 'complete');
  assert.equal(f.status('environment').targetConcurrency, 0);
  assert.equal(f.status('environment').inFlightRequests, 0);
  assert.equal(f.status('environment').etaSeconds, null);
});

test('removing a terminal worker clears its cache and snapshot without deleting the saved file record', async () => {
  const f = fixture();
  f.run('one', { saveAs: true, filename: 'Old/Nested/one.mp4' });
  await until(() => f.status('one').state === 'complete');
  assert.equal(f.saved[0].filename, 'one.ts'); assert.equal(f.saved[0].saveAs, false);
  assert.equal((await f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true })).success, true);
  assert.equal(f.status('one'), undefined); assert.ok(f.events.includes('cache-remove'));
  assert.equal(f.items.get(1).state, 'complete'); assert.equal(f.saved.length, 1);
  assert.equal((await f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true })).success, true);
});

test('removal without OPFS waits for final notification and preserves ownership of the next queued job', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ noStorage: true, progress: async job => { if (job.id === 'one' && job.state === 'complete') await gate; } });
  f.run('one'); f.run('two');
  await until(() => f.status('one').state === 'complete');
  let removed = false;
  const pending = f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true }).then(result => { removed = true; return result; });
  await tick();
  assert.equal(removed, false); assert.equal(f.started.length, 1);
  release();
  assert.equal((await pending).success, true);
  await until(() => f.status('two')?.state === 'complete');
  assert.equal(f.status('one'), undefined); assert.equal(f.started.length, 2);
  await tick(); assert.equal(f.status('one'), undefined);
});

test('failed offscreen cache removal keeps its terminal entry and can be retried', async () => {
  let attempts = 0;
  const f = fixture({ cacheRemove: async () => { if (++attempts === 1) throw new Error('temporary cache failure'); } });
  f.run('one'); await until(() => f.status('one').state === 'complete');
  const failed = await f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true });
  assert.equal(failed.success, false); assert.equal(f.status('one').state, 'complete');
  assert.equal((await f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true })).success, true);
  assert.equal(f.status('one'), undefined);
});

test('explicit removal retries an owned temporary-file cleanup that failed after confirmed saving', async () => {
  let attempts = 0;
  const f = fixture({ removeTemp: async () => { if (++attempts === 1) throw new Error('file locked'); } });
  f.run('one'); await until(() => f.status('one').state === 'complete');
  assert.match(f.status('one').cleanupError, /file locked/); assert.equal(f.files[0].removed, false);
  assert.equal((await f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true })).success, true);
  assert.equal(f.files[0].removed, true); assert.equal(f.items.get(1).state, 'complete');
});

test('unverified Chrome references prevent source revocation and cache deletion despite a terminal status', async () => {
  const f = fixture({ pendingSave: true, cancel: async () => { throw new Error('cancel not confirmed'); } });
  f.run('one'); await until(() => f.status('one').state === 'saving' && f.saved.length === 1);
  f.message({ action: 'cancelJob', jobId: 'one' });
  await until(() => f.status('one').state === 'cancelled');
  assert.equal(f.revoked.length, 0); assert.equal(f.files[0].removed, false);
  for (const verifiedDownloadId of [null, 99]) {
    const blocked = await f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true, verifiedDownloadId });
    assert.equal(blocked.success, false); assert.match(blocked.error, /尚未确认/);
    assert.equal(f.revoked.length, 0); assert.equal(f.files[0].removed, false);
    assert.equal(f.events.includes('cache-remove'), false);
  }
  f.items.set(1, { state: 'interrupted' });
  assert.equal((await f.request({ action: 'removeJob', jobId: 'one', chromeIdle: true, verifiedDownloadId: 1 })).success, true);
  assert.equal(f.revoked.length, 1); assert.equal(f.files[0].removed, true);
});

test('resume cannot overwrite an older attempt that still owns an uncleared temporary source', async () => {
  let cleanupAttempts = 0;
  const f = fixture({ download: async () => { throw new Error('network failed'); },
    removeTemp: async () => { if (++cleanupAttempts === 1) throw new Error('file locked'); } });
  f.run('one', { cachedSegments: 2 });
  await until(() => f.status('one').state === 'interrupted');
  assert.equal(f.status('one').resumable, true);
  const previousRunId = f.status('one').runId;
  const retry = f.run('one', { resume: true, runId: 'new-rejected-attempt' });
  assert.equal(retry.success, false); assert.match(retry.error, /临时文件尚未清理/);
  assert.equal(f.status('one').runId, previousRunId);
  assert.equal((await f.request({ action: 'removeJob', jobId: 'one', runId: 'new-rejected-attempt', chromeIdle: true })).success, true);
  assert.equal(f.files[0].removed, true);
});

test('concurrency messages validate values and revisions, bootstrap migrated revision zero, and acknowledge stale values without publishing', async () => {
  const f = fixture();
  const first = f.message({ action: 'setConcurrency', concurrency: 73, concurrencyRevision: 0 });
  assert.deepEqual(first, { success: true, concurrency: 73, concurrencyRevision: 0 });
  for (const values of [
    {}, { concurrency: 1 }, { concurrency: 0, concurrencyRevision: 1 },
    { concurrency: 376, concurrencyRevision: 1 }, { concurrency: 1.5, concurrencyRevision: 1 },
    { concurrency: '64', concurrencyRevision: 1 }, { concurrency: 64, concurrencyRevision: -1 },
    { concurrency: 64, concurrencyRevision: 0.5 }, { concurrency: 64, concurrencyRevision: Number.MAX_SAFE_INTEGER + 1 },
    { concurrency: 64, concurrencyRevision: 0 }
  ]) {
    assert.equal(f.message({ action: 'setConcurrency', ...values }).success, false, JSON.stringify(values));
  }
  assert.deepEqual(f.message({ action: 'setConcurrency', concurrency: 73, concurrencyRevision: 0 }), first);
  const latest = f.message({ action: 'setConcurrency', concurrency: 1, concurrencyRevision: 5 });
  assert.deepEqual(latest, { success: true, concurrency: 1, concurrencyRevision: 5 });
  assert.deepEqual(f.message({ action: 'setConcurrency', concurrency: 375, concurrencyRevision: 4 }), latest);
  assert.equal(f.messages.length, 0, 'No tasks means no progress notifications');
  assert.equal(f.run('invalid', { concurrency: 0, concurrencyRevision: 6 }).success, false);
  assert.equal(f.run('bad-revision', { concurrency: 64, concurrencyRevision: null }).success, false);
  assert.equal(f.runner.getJobs().length, 0);
  const restored = f.run('legacy', { concurrency: 73 });
  assert.equal(restored.job.concurrency, 1); assert.equal(restored.job.concurrencyRevision, 5);
  await until(() => f.status('legacy').state === 'complete');
});

test('active and queued jobs share live revisions, and concurrency ACK never waits for progress acknowledgements', async () => {
  const transfer = deferred(), notifications = deferred();
  const controls = [], updates = [], signals = [];
  let block = false, blockedNotification = false, publishMetrics;
  const f = fixture({
    progress: async job => { if (block && job.concurrencyRevision >= 1) { blockedNotification = true; await notifications.promise; } },
    async download(sink, signal, progress, source, control, onMetrics) {
      controls.push({ source, control, initial: control.get() }); signals.push(signal);
      const unsubscribe = control.subscribe(() => updates.push(control.get()));
      publishMetrics = onMetrics;
      try {
        await transfer.promise;
        await sink.write(new Uint8Array(4).buffer); progress({ bytes: 4, completed: 1, total: 1 });
      } finally { unsubscribe(); }
    }
  });
  f.run('active', { concurrency: 3, concurrencyRevision: 0 });
  await until(() => controls.length === 1);
  f.run('queued', { concurrency: 3, concurrencyRevision: 0 });
  assert.equal(f.status('queued').state, 'queued');
  block = true;
  assert.deepEqual(f.message({ action: 'setConcurrency', concurrency: 6, concurrencyRevision: 1 }),
    { success: true, concurrency: 6, concurrencyRevision: 1 });
  await until(() => blockedNotification);
  assert.deepEqual(f.message({ action: 'setConcurrency', concurrency: 2, concurrencyRevision: 2 }),
    { success: true, concurrency: 2, concurrencyRevision: 2 });
  assert.deepEqual(updates, [6, 2]); assert.equal(controls.length, 1);
  assert.equal(signals[0].aborted, false, 'Reducing the target does not abort the active transfer');
  for (const id of ['active', 'queued']) {
    assert.equal(f.status(id).concurrency, 2); assert.equal(f.status(id).concurrencyRevision, 2);
  }
  assert.equal(f.status('active').targetConcurrency, 2); assert.equal(f.status('queued').targetConcurrency, 0);
  assert.equal(f.status('active').activeConcurrency, 2); assert.equal(f.status('queued').activeConcurrency, 0);
  publishMetrics({ targetConcurrency: 3, activeConcurrency: 3, inFlightRequests: 3, bytesPerSecond: 10 });
  assert.equal(f.status('active').targetConcurrency, 2, 'A delayed metric cannot restore the old target');
  assert.equal(f.status('active').activeConcurrency, 2); assert.equal(f.status('active').inFlightRequests, 3);
  const revisions = f.runner.getJobs().map(job => job.revision);
  f.message({ action: 'setConcurrency', concurrency: 2, concurrencyRevision: 2 });
  f.message({ action: 'setConcurrency', concurrency: 375, concurrencyRevision: 1 });
  assert.deepEqual(f.runner.getJobs().map(job => job.revision), revisions, 'Replayed values do not create progress feedback');
  assert.deepEqual(updates, [6, 2]);
  notifications.resolve(); transfer.resolve();
  await until(() => f.status('queued').state === 'complete');
  assert.deepEqual(controls.map(item => item.initial), [3, 2], 'Queued execution reads the latest value');
  const terminal = f.runner.getJobs();
  f.message({ action: 'setConcurrency', concurrency: 20, concurrencyRevision: 3 });
  publishMetrics({ targetConcurrency: 375, activeConcurrency: 375, inFlightRequests: 375, bytesPerSecond: 999 });
  assert.deepEqual(f.runner.getJobs(), terminal);
  for (const job of terminal) {
    assert.equal(job.targetConcurrency, 0); assert.equal(job.activeConcurrency, 0); assert.equal(job.inFlightRequests, 0);
  }
});

test('a newer queued job updates the active control while stale dispatch snapshots inherit the latest preference', async () => {
  const transfer = deferred(), observed = [];
  let activeControl;
  const f = fixture({ async download(sink, signal, progress, source, control) {
    observed.push({ source, value: control.get() }); activeControl ||= control;
    await transfer.promise;
    assert.equal(signal.aborted, false);
    await sink.write(new Uint8Array(4).buffer); progress({ bytes: 4, completed: 1, total: 1 });
  } });
  f.run('active', { concurrency: 73, concurrencyRevision: 0 });
  await until(() => observed.length === 1);
  f.message({ action: 'setConcurrency', concurrency: 10, concurrencyRevision: 3 });
  const stale = f.run('stale', { concurrency: 5, concurrencyRevision: 2 });
  assert.equal(stale.job.concurrency, 10); assert.equal(stale.job.concurrencyRevision, 3);
  f.run('newer', { concurrency: 17, concurrencyRevision: 4 });
  assert.equal(activeControl.get(), 17);
  assert.equal(observed.length, 1, 'Changing concurrency cannot start another HLS job');
  for (const job of f.runner.getJobs()) {
    assert.equal(job.concurrency, 17); assert.equal(job.concurrencyRevision, 4);
  }
  const duplicate = f.run('active', { concurrency: 3, concurrencyRevision: 0 });
  assert.equal(duplicate.job.concurrency, 17);
  assert.equal(f.run('conflict', { concurrency: 18, concurrencyRevision: 4 }).success, false);
  assert.equal(f.status('conflict'), undefined); assert.equal(activeControl.get(), 17);
  transfer.resolve(); await until(() => f.status('newer').state === 'complete');
  assert.deepEqual(observed.map(item => item.value), [73, 17, 17]);
});

test('cancellation disposes concurrency subscriptions and terminal jobs cannot be revived by later preferences', async () => {
  let control, signal;
  const observed = [], removedListener = [];
  const f = fixture({ noStorage: true, async download(_sink, activeSignal, _progress, _source, activeControl) {
    control = activeControl; signal = activeSignal;
    control.subscribe(() => observed.push(control.get()));
    const unsubscribe = control.subscribe(() => removedListener.push(control.get()));
    unsubscribe();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  f.run('active', { concurrency: 4, concurrencyRevision: 0 });
  await until(() => control);
  f.message({ action: 'setConcurrency', concurrency: 8, concurrencyRevision: 1 });
  assert.deepEqual(observed, [8]); assert.deepEqual(removedListener, []);
  assert.equal(f.message({ action: 'cancelJob', jobId: 'active' }).success, true);
  assert.equal(signal.aborted, true);
  f.message({ action: 'setConcurrency', concurrency: 9, concurrencyRevision: 2 });
  await until(() => f.status('active').state === 'cancelled');
  control.subscribe(() => observed.push('after-disposal'));
  const terminal = f.status('active');
  f.message({ action: 'setConcurrency', concurrency: 64, concurrencyRevision: 3 });
  assert.deepEqual(observed, [8]); assert.deepEqual(f.status('active'), terminal);
  assert.equal(terminal.targetConcurrency, 0); assert.equal(terminal.activeConcurrency, 0);
  assert.equal(terminal.inFlightRequests, 0); assert.equal(f.saved.length, 0);
});
