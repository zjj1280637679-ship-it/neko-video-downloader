const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
const { createOffscreenRunner } = require('../offscreen.js');
const core = require('../hls-core.js');
const { createMemoryOpfs } = require('./helpers/memory-opfs.cjs');
const directoryFor = id => `neko-cache-${createHash('sha256').update(id).digest('hex')}`;
const terminal = new Set(['complete', 'interrupted', 'cancelled']);
async function until(predicate, description = 'worker condition') {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function fixture() {
  const fs = createMemoryOpfs(), requests = [], progress = [], saves = [], blobs = new Map(), revoked = [], items = new Map();
  const flags = { damageSecond: true, failPlan: false };
  const plaintext = Array.from({ length: 3 }, (_, index) => {
    const segment = new Uint8Array(188).fill(index + 17); segment[0] = 0x47; return segment;
  });
  const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const encrypted = await Promise.all(plaintext.map((data, index) => webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: core.sequenceToIv(10 + index) }, key, data)));
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:5,\ns0.ts\n#EXTINF:5,\ns1.ts\n#EXTINF:5,\ns2.ts\n#EXT-X-ENDLIST';
  async function fetcher(url, init = {}) {
    const path = new URL(url).pathname; requests.push({ url, path, cache: init.cache });
    if (path === '/hold.m3u8') return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) return reject(init.signal.reason);
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    if (path === '/list.m3u8') return flags.failPlan ? new Response('temporary unavailable', { status: 503 }) : new Response(playlist);
    if (path === '/key.bin') return new Response(keyBytes);
    const match = /\/s([0-2])\.ts$/.exec(path);
    if (match) {
      const index = Number(match[1]);
      // Non-multiple-of-16 payload guarantees AES failure on every attempt,
      // without relying on probabilistic invalid PKCS#7 padding.
      return new Response(index === 1 && flags.damageSecond ? Uint8Array.of(7, 8, 9) : encrypted[index]);
    }
    throw new Error(`Unexpected request ${url}`);
  }
  const runtime = {
    id: 'resume-fixture', getURL: path => `chrome-extension://resume-fixture/${path}`,
    onMessage: { addListener() {} },
    async sendMessage(message) {
      assert.equal(message.target, 'neko-background');
      if (message.action === 'jobProgress') { progress.push(structuredClone(message.job)); return { success: true }; }
      if (message.action === 'saveBlob') {
        const blob = blobs.get(message.url); assert.ok(blob, 'Source Blob must remain alive when Chrome begins saving');
        const data = new Uint8Array(await blob.arrayBuffer());
        const id = saves.length + 1; saves.push({ ...message, data });
        items.set(id, { state: 'complete', filename: `C:/Downloads/${message.filename}`, bytesReceived: data.byteLength, totalBytes: data.byteLength });
        return { success: true, downloadId: id };
      }
      if (message.action === 'getChromeDownload') return { success: true, downloadId: message.downloadId, item: items.get(message.downloadId) };
      if (message.action === 'cancelChromeDownload') { items.set(message.downloadId, { state: 'interrupted', error: 'USER_CANCELED' }); return { success: true }; }
      throw new Error(`Unexpected broker request ${message.action}`);
    }
  };
  const hls = { ...core, createClient(options) { return core.createClient({ ...options, fetch: fetcher, crypto: webcrypto, retryDelayMs: 0, maxRetryDelayMs: 0, random: () => 0.5 }); } };
  const runner = createOffscreenRunner({ runtime, hls, storage: fs.storage, cryptoApi: webcrypto, progressMs: 0, pollMs: 1,
    urlApi: { createObjectURL(blob) { const url = `blob:chrome-extension://resume-fixture/${webcrypto.randomUUID()}`; blobs.set(url, blob); return url; }, revokeObjectURL(url) { revoked.push(url); blobs.delete(url); } },
    logger: { warn() {} }
  });
  const sender = { id: runtime.id, url: runtime.getURL('background.js') };
  function message(value) { return new Promise(resolve => runner.handleMessage({ target: 'neko-offscreen', ...value }, sender, resolve)); }
  function run(id, extra = {}) { return message({ action: 'runJob', job: { id, title: 'fixture', filename: 'Saved/fixture.ts', url: 'https://fixture.test/list.m3u8', isM3U8: true, saveAs: false, tabId: 7, concurrency: 3, ...extra } }); }
  function status(id) { return runner.getJobs().find(job => job.id === id); }
  async function fail(id = 'resumable') {
    const acknowledgement = await run(id); assert.equal(acknowledgement.success, true);
    await until(() => status(id)?.state === 'interrupted', `${id} interrupted after six decrypt attempts`);
    assert.equal(status(id).resumable, true); assert.equal(status(id).cachedSegments, 2);
    return status(id);
  }
  function segmentCounts() { return [0, 1, 2].map(index => requests.filter(request => request.path === `/s${index}.ts`).length); }
  return { fs, flags, requests, progress, saves, revoked, blobs, plaintext, runner, message, run, status, fail, segmentCounts };
}

test('AES interruption retains two verified peers; same-id resume fetches only missing piece and saves exact bytes', { timeout: 10000 }, async () => {
  const f = await fixture(); await f.fs.write('foreign/note.txt', 'keep');
  const failed = await f.fail();
  assert.match(failed.error, /第 2 个分片.*AES-128/);
  assert.deepEqual(f.segmentCounts(), [1, 6, 1]);
  assert.equal(f.saves.length, 0);
  assert.ok(f.progress.some(job => job.retryAttempt > 0 && /解密失败/.test(job.retryMessage)));
  assert.ok(f.fs.paths().includes(`${directoryFor('resumable')}/0.bin`));
  assert.ok(f.fs.paths().includes(`${directoryFor('resumable')}/2.bin`));
  assert.equal(f.fs.paths().some(path => /^neko-download-.*\.part$/.test(path)), false, 'Partial merged output must be removed after failure');
  f.flags.damageSecond = false;
  const resumed = await f.run('resumable', { resume: true }); assert.equal(resumed.success, true);
  await until(() => f.status('resumable').state === 'complete', 'same-id completion');
  assert.equal(f.runner.getJobs().length, 1);
  assert.deepEqual(f.segmentCounts(), [1, 7, 1]);
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].saveAs, false);
  assert.deepEqual(Buffer.from(f.saves[0].data), Buffer.concat(f.plaintext.map(value => Buffer.from(value))));
  assert.equal(f.status('resumable').cachedSegments, 0); assert.equal(f.status('resumable').resumable, false);
  assert.deepEqual(f.fs.paths(), ['foreign', 'foreign/note.txt']);
  assert.equal(f.revoked.length, 1); assert.equal(f.blobs.size, 0);
});

test('transient playlist failure during resume retains checkpoints and still offers another resume', { timeout: 10000 }, async () => {
  const f = await fixture(); await f.fail('plan-failure');
  const before = f.segmentCounts();
  f.flags.failPlan = true; await f.run('plan-failure', { resume: true });
  await until(() => f.status('plan-failure').state === 'interrupted', 'resumed playlist failure');
  assert.equal(f.status('plan-failure').cachedSegments, 2); assert.equal(f.status('plan-failure').resumable, true);
  assert.deepEqual(f.segmentCounts(), before);
  assert.ok(f.fs.paths().includes(`${directoryFor('plan-failure')}/0.bin`));
  assert.ok(f.fs.paths().includes(`${directoryFor('plan-failure')}/2.bin`));
  f.flags.failPlan = false; f.flags.damageSecond = false;
  await f.run('plan-failure', { resume: true });
  await until(() => f.status('plan-failure').state === 'complete');
  assert.deepEqual(f.segmentCounts(), [1, 7, 1]); assert.deepEqual(f.fs.paths(), []);
});

test('discardJob removes the failed checkpoint and updates resumability without touching unrelated data', { timeout: 10000 }, async () => {
  const f = await fixture(); await f.fail('discard'); await f.fs.write('other-app/file.bin', 'keep');
  const result = await f.message({ action: 'discardJob', jobId: 'discard' });
  assert.equal(result.success, true);
  assert.equal(f.status('discard').cachedSegments, 0); assert.equal(f.status('discard').resumable, false);
  assert.equal(f.status('discard').state, 'interrupted');
  assert.deepEqual(f.fs.paths(), ['other-app', 'other-app/file.bin']);
  assert.equal(f.saves.length, 0);
});

test('cancelling a queued resume clears its old cache before it can fetch again', { timeout: 10000 }, async () => {
  const f = await fixture(); await f.fail('queued');
  const counts = f.segmentCounts();
  await f.run('blocker', { url: 'https://fixture.test/hold.m3u8' });
  await until(() => f.status('blocker').state === 'parsing', 'blocking manifest');
  const resumed = await f.run('queued', { resume: true });
  assert.equal(resumed.job.state, 'queued'); assert.equal(resumed.job.cachedSegments, 2);
  assert.equal((await f.message({ action: 'cancelJob', jobId: 'queued' })).success, true);
  await until(() => f.status('queued').state === 'cancelled', 'queued checkpoint removal');
  assert.equal(f.status('queued').cachedSegments, 0); assert.equal(f.status('queued').resumable, false);
  assert.equal(f.fs.paths().some(path => path.startsWith(directoryFor('queued'))), false);
  assert.deepEqual(f.segmentCounts(), counts, 'Queued resume must not have fetched any piece');
  await f.message({ action: 'cancelJob', jobId: 'blocker' });
  await until(() => terminal.has(f.status('blocker').state));
  assert.equal(f.status('blocker').state, 'cancelled'); assert.equal(f.saves.length, 0);
});
