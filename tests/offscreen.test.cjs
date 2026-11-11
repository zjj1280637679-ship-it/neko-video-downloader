const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createOffscreenRunner } = require('../offscreen.js');
const core = require('../hls-core.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for worker state');
}
function fixture(options = {}) {
  const events = [], messages = [], started = [], saved = [], cancelled = [], files = [], revoked = [];
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
          const blob = new Blob(['data']);
          Object.defineProperty(blob, 'size', { value: file.bytes });
          return blob;
        }
      };
    },
    async removeEntry(name) {
      const file = files.find(value => value.name === name);
      assert.ok(file, 'Must only remove a file owned by this runner');
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
    urlApi: { createObjectURL: _blob => `blob:chrome-extension://test-extension/${webcrypto.randomUUID()}`, revokeObjectURL: url => revoked.push(url) },
    pollMs: 2, progressMs: options.progressMs ?? 500, logger: { warn() {} } }).attach();
  const sender = { id: runtime.id, url: runtime.getURL('background.js') };
  function message(value, origin = sender) {
    let result;
    assert.equal(listener({ target: 'neko-offscreen', ...value }, origin, reply => { result = reply; }), false);
    return result;
  }
  function run(id, extra = {}) { return message({ action: 'runJob', job: { id, url: `https://fixture.test/${id}.m3u8`, filename: `Movies/${id}.mp4`, title: id, isM3U8: true, saveAs: false, tabId: 3, ...extra } }); }
  function status(id) { return runner.getJobs().find(job => job.id === id); }
  return { runner, message, run, status, runtime, events, messages, started, saved, cancelled, files, revoked, items };
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
  assert.equal(f.saved[0].filename, 'Movies/one.ts');
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
  assert.equal(f.message({ action: 'cancelJob', jobId: 'two' }).success, true);
  assert.equal(f.status('two').state, 'cancelled');
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
  assert.equal(f.files[0].removed, false);
  assert.equal(f.revoked.length, 0);
  assert.equal(f.status('large').state, 'saving');
  f.items.set(1, { state: 'complete', bytesReceived: total, filename: 'C:/Downloads/large.ts' });
  await until(() => f.status('large').state === 'complete');
  assert.equal(f.files[0].removed, true);
  assert.equal(f.status('large').savedFilename, 'C:/Downloads/large.ts');
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

test('offscreen defaults to adaptive mode, forwards aggregate metrics and clears speed while saving', async () => {
  for (const config of [{ expected: 'auto' }, { concurrencyMode: 'manual', concurrency: 3, expected: 3 }]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ async download(sink, _signal, progress, _url, concurrency, onMetrics) {
      assert.equal(concurrency, config.expected);
      onMetrics({ bytesPerSecond: 1234567, activeConcurrency: 3, concurrencyMode: config.concurrencyMode || 'auto', concurrencyReason: 'gain' });
      await gate;
      await sink.write(new Uint8Array(4).buffer);
      progress({ bytes: 4, completed: 1, total: 1 });
    } });
    f.run('adaptive', config);
    await until(() => f.status('adaptive').bytesPerSecond === 1234567);
    assert.equal(f.status('adaptive').activeConcurrency, 3);
    assert.equal(f.status('adaptive').concurrencyMode, config.concurrencyMode || 'auto');
    release();
    await until(() => f.status('adaptive').state === 'complete');
    assert.equal(f.status('adaptive').bytesPerSecond, 0);
    assert.equal(f.status('adaptive').activeConcurrency, 0);
  }
});
