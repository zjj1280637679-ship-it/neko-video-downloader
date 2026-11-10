const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { webcrypto, createHash } = require('node:crypto');
const hls = require('../hls-core.js');
const { createOffscreenRunner } = require('../offscreen.js');

function event() {
  const listeners = new Set();
  return { listeners, addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
    emit(...args) { for (const fn of listeners) fn(...args); } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function waitUntil(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('popup → MV3 manager → offscreen → HTTP AES-128 → Chrome save continues after popup closes', { timeout: 12000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neko-download-integration-'));
  const absoluteTemp = path.resolve(directory);
  const expectedParent = path.resolve(os.tmpdir());
  // Cleanup is limited to this test's unique temporary directory.
  assert.equal(path.dirname(absoluteTemp), expectedParent);
  assert.match(path.basename(absoluteTemp), /^neko-download-integration-[A-Za-z0-9]+$/);
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(resolved, absoluteTemp);
    assert.equal(path.dirname(resolved), expectedParent);
    await fs.rm(resolved, { recursive: true, force: true });
  });

  const rawKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const cryptoKey = await webcrypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
  const pieces = Array.from({ length: 3 }, (_, segment) => {
    const bytes = Buffer.alloc(376);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (segment * 41 + index * 7) % 256;
    bytes[0] = 0x47; bytes[188] = 0x47;
    return bytes;
  });
  const encrypted = await Promise.all(pieces.map((bytes, index) => webcrypto.subtle.encrypt({
    name: 'AES-CBC', iv: hls.sequenceToIv(42 + index)
  }, cryptoKey, bytes)));
  const requests = [];
  const manifest = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"\n' +
    pieces.map((_, index) => `#EXTINF:5,\nsegments/${index}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n';
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/video/index.m3u8') { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(manifest); }
    else if (req.url === '/video/keys/enc.key') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(rawKey); }
    else {
      const match = /^\/video\/segments\/(\d)\.ts$/.exec(req.url);
      if (match && encrypted[Number(match[1])]) { res.setHeader('Content-Type', 'video/mp2t'); res.end(Buffer.from(encrypted[Number(match[1])])); }
      else { res.statusCode = 404; res.end('not found'); }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const sourceUrl = `http://127.0.0.1:${server.address().port}/video/index.m3u8`;

  const extensionId = 'neko-integration-fixture';
  const extensionUrl = filename => `chrome-extension://${extensionId}/${filename}`;
  const bus = event();
  const nativeEvents = event();
  const sessionData = {};
  const localData = { neko_settings_v1: { subfolder: 'Videos/验收', askWhereToSave: false } };
  const chromeItems = new Map();
  const temporaryFiles = new Map();
  const blobUrls = new Map();
  const nativeWrites = [];
  const warnings = [];
  const earlyCompletion = [];
  const savingStarted = deferred(), allowNativeCompletion = deferred();
  let offscreenExists = false, offscreenCreations = 0, blobSequence = 0;

  const runtimeFor = file => ({
    id: extensionId, getURL: extensionUrl, onMessage: bus,
    async getContexts() { return offscreenExists ? [{ documentUrl: extensionUrl('offscreen.html') }] : []; },
    sendMessage(message) {
      // Chrome extension messages are JSON-serialized, so test real wire shapes.
      const data = JSON.parse(JSON.stringify(message));
      const sender = { id: extensionId, url: extensionUrl(file) };
      return new Promise((resolve, reject) => {
        let replied = false, pending = false;
        const reply = value => { if (!replied) { replied = true; resolve(value === undefined ? undefined : JSON.parse(JSON.stringify(value))); } };
        try {
          for (const listener of bus.listeners) if (listener(data, sender, reply) === true) pending = true;
          if (!replied && !pending) resolve(undefined);
        } catch (error) { reject(error); }
      });
    }
  });
  const memoryOpfs = {
    async getDirectory() {
      return {
        async getFileHandle(name, { create }) {
          if (!temporaryFiles.has(name)) {
            if (!create) throw new DOMException('missing', 'NotFoundError');
            temporaryFiles.set(name, Buffer.alloc(0));
          }
          return {
            async createWritable() {
              const chunks = [];
              return {
                async write(bytes) { chunks.push(Buffer.from(bytes)); },
                async close() { temporaryFiles.set(name, Buffer.concat(chunks)); },
                async abort() { chunks.length = 0; }
              };
            },
            async getFile() { return new Blob([temporaryFiles.get(name)], { type: 'video/mp2t' }); }
          };
        },
        async removeEntry(name) { temporaryFiles.delete(name); }
      };
    }
  };
  const runner = createOffscreenRunner({
    runtime: runtimeFor('offscreen.html'), hls, storage: memoryOpfs, cryptoApi: webcrypto,
    pollMs: 5, progressMs: 1, logger: { warn(...args) { warnings.push(args); } },
    urlApi: {
      createObjectURL(blob) { const url = `blob:${extensionUrl('')}${++blobSequence}`; blobUrls.set(url, blob); return url; },
      revokeObjectURL(url) { blobUrls.delete(url); }
    }
  });
  const chrome = {
    runtime: runtimeFor('background.js'),
    storage: {
      session: {
        async get() { return structuredClone(sessionData); },
        async set(value) {
          for (const job of value.neko_jobs_v1 || []) {
            if (job.state === 'complete' && chromeItems.get(job.downloadId)?.state !== 'complete') earlyCompletion.push(job);
          }
          Object.assign(sessionData, structuredClone(value));
        }
      },
      local: { async get() { return structuredClone(localData); }, async set(value) { Object.assign(localData, structuredClone(value)); } }
    },
    offscreen: { async createDocument(options) {
      assert.equal(options.url, 'offscreen.html');
      assert.deepEqual(Array.from(options.reasons), ['BLOBS']);
      offscreenCreations++; offscreenExists = true; runner.attach();
    } },
    tabs: { async create() { throw new Error('Downloading must not open a visible tab'); } },
    downloads: {
      onChanged: nativeEvents,
      async download(options) {
        assert.equal(options.saveAs, false);
        assert.equal(options.conflictAction, 'uniquify');
        assert.equal(options.filename, 'Videos/验收/integration.ts');
        const blob = blobUrls.get(options.url);
        assert.ok(blob, 'Native download must receive a live offscreen Blob URL');
        const outputPath = path.resolve(directory, options.filename);
        assert.ok(outputPath.startsWith(absoluteTemp + path.sep), 'Output must stay in the test directory');
        const id = 101;
        chromeItems.set(id, { id, state: 'in_progress', bytesReceived: 0, totalBytes: blob.size, filename: outputPath });
        const write = (async () => {
          await allowNativeCompletion.promise;
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, Buffer.from(await blob.arrayBuffer()));
          Object.assign(chromeItems.get(id), { state: 'complete', bytesReceived: blob.size });
          nativeEvents.emit({ id, state: { current: 'complete' } });
        })();
        nativeWrites.push(write);
        savingStarted.resolve();
        return id;
      },
      async search({ id }) { return chromeItems.has(id) ? [structuredClone(chromeItems.get(id))] : []; },
      async cancel(id) { Object.assign(chromeItems.get(id), { state: 'interrupted', error: 'USER_CANCELED' }); },
      async show() {}
    }
  };
  const managerSource = await fs.readFile(require.resolve('../download-manager.js'), 'utf8');
  vm.runInNewContext(managerSource, { chrome, crypto: webcrypto, URL, console }, { filename: 'download-manager.js' });

  function openPopup() {
    let closed = false;
    const runtime = runtimeFor('popup.html');
    return {
      async send(message) { assert.equal(closed, false, 'Closed popup cannot participate in work'); return runtime.sendMessage(message); },
      close() { closed = true; }
    };
  }
  const popup = openPopup();
  const started = await popup.send({ action: 'startDownload', url: sourceUrl, isM3U8: true,
    title: 'Integration fixture', filename: 'integration.m3u8', tabId: 8 });
  assert.equal(started.success, true);
  popup.close();
  await savingStarted.promise;
  await waitUntil(() => sessionData.neko_jobs_v1?.find(job => job.id === started.job.id)?.state === 'saving', 'saving state');
  assert.equal(chromeItems.get(101).state, 'in_progress');
  assert.ok(temporaryFiles.size > 0, 'OPFS source must remain until Chrome completes');
  assert.equal(blobUrls.size, 1);
  await assert.rejects(fs.access(path.join(directory, 'Videos', '验收', 'integration.ts')), { code: 'ENOENT' });
  assert.equal(sessionData.neko_jobs_v1.find(job => job.id === started.job.id).state, 'saving');
  allowNativeCompletion.resolve();
  await Promise.all(nativeWrites);
  await waitUntil(() => sessionData.neko_jobs_v1?.find(job => job.id === started.job.id)?.state === 'complete', 'complete state');
  const reopenedPopup = openPopup();
  const restored = await reopenedPopup.send({ action: 'getJobs' });
  reopenedPopup.close();
  assert.equal(restored.success, true);
  const saved = restored.jobs.find(job => job.id === started.job.id);
  assert.equal(saved.state, 'complete');
  assert.equal(saved.completedSegments, 3);
  assert.equal(saved.totalSegments, 3);
  assert.equal(saved.filename, 'Videos/验收/integration.ts');
  const actual = await fs.readFile(chromeItems.get(101).filename);
  const expected = Buffer.concat(pieces);
  assert.deepEqual(actual, expected);
  assert.equal(createHash('sha256').update(actual).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  assert.equal(saved.bytesReceived, expected.length);
  assert.equal(temporaryFiles.size, 0, 'Only completed OPFS temporary file must be removed');
  assert.equal(blobUrls.size, 0, 'Blob must be revoked after native completion');
  assert.equal(earlyCompletion.length, 0, 'No persisted complete state before Chrome completion');
  assert.equal(warnings.length, 0);
  assert.equal(offscreenCreations, 1);
  assert.equal(requests.filter(url => url.endsWith('enc.key')).length, 1);
  assert.equal(requests.filter(url => url.endsWith('.ts')).length, 3);
});
