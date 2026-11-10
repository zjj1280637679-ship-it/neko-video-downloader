const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const { absolutizePlaylist } = require('../hls-core.js');
const source = fs.readFileSync(require.resolve('../downloader.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ids = ['titleVal', 'urlVal', 'segmentVal', 'progressText', 'percentText', 'progressFill', 'statusMsg', 'btnStart', 'btnDownloadM3U8', 'btnCopyUrl', 'btnCancel', 'btnReveal', 'btnRetryParse', 'statBytes', 'statSpeed'];
async function setup(options = {}) {
  const elements = new Map(ids.map(id => [id, {
    textContent: '', disabled: false, hidden: false, dataset: {}, style: {}, listeners: {},
    parentElement: { setAttribute() {} },
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }]));
  const plan = { segments: [{}], totalDuration: 5, isFmp4: false, discontinuities: 0 };
  let onReady;
  const downloadEvents = new Set();
  const submitted = [];
  const counters = { download: 0, abort: 0, close: 0, cancel: 0 };
  const writer = options.writer || {
    async write() {}, async close() { counters.close++; }, async abort() { counters.abort++; }
  };
  const file = { name: 'fixture.ts', size: 4 };
  const fileHandle = { async createWritable() { if (options.openError) throw options.openError; return writer; }, async getFile() { return file; } };
  const window = {
    addEventListener() {},
    ...(options.fallback ? {} : { async showSaveFilePicker() { if (options.pickerError) throw options.pickerError; return fileHandle; } })
  };
  const chrome = {
    runtime: {}, downloads: {
      download(downloadOptions, callback) { submitted.push(downloadOptions); callback(1); },
      search(_options, callback) { callback([{ id: 1, state: 'in_progress' }]); },
      cancel(_id, callback) { counters.cancel++; options.cancel ? options.cancel(callback) : callback(); }, show() {},
      onChanged: { addListener(fn) { downloadEvents.add(fn); }, removeListener(fn) { downloadEvents.delete(fn); } }
    }
  };
  const context = vm.createContext({
    window, document: { getElementById: id => elements.get(id), addEventListener(_name, fn) { onReady = fn; } },
    location: { search: '?url=https%3A%2F%2Ffixture.test%2Flist.m3u8&title=fixture' },
    navigator: { clipboard: { async writeText() {} }, storage: options.storage }, chrome,
    URL, URLSearchParams, AbortController, DOMException, Blob, performance, console, crypto: webcrypto,
    NekoHls: {
      absolutizePlaylist,
      safeFilename: (title, extension) => `${title}.${extension}`,
      createClient({ signal }) { return {
        async loadPlan() { return plan; },
        async request() { return { text: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:5,\npart.ts\n#EXT-X-ENDLIST', url: 'https://cdn.test/redirect/list.m3u8' }; },
        async download(_plan, sink, progress) {
          counters.download++;
          if (options.download) return options.download(sink, signal, progress);
          await sink.write(new Uint8Array([1, 2, 3, 4]).buffer);
          progress({ completed: 1, total: 1, bytes: 4 });
        }
      }; }
    }
  });
  vm.runInContext(source, context);
  onReady();
  await tick();
  return { elements, counters, writer, downloadEvents, submitted, click(id) { return elements.get(id).listeners.click(); } };
}

test('cancelling save picker does not download or fallback; controls recover', async () => {
  const ui = await setup({ pickerError: new DOMException('cancelled', 'AbortError') });
  await ui.click('btnStart');
  assert.equal(ui.counters.download, 0);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'cancelled');
  assert.equal(ui.elements.get('btnStart').disabled, false);
});

test('disk error aborts partial write and never reports success', async () => {
  let aborts = 0, closes = 0;
  const ui = await setup({ writer: { async write() { throw new Error('disk full'); }, async abort() { aborts++; }, async close() { closes++; } } });
  await ui.click('btnStart');
  assert.equal(aborts, 1);
  assert.equal(closes, 0);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'error');
  assert.equal(ui.elements.get('btnStart').disabled, false);
});

test('streaming success closes writer, verifies saved file and reveals check action', async () => {
  const ui = await setup();
  await ui.click('btnStart');
  assert.equal(ui.counters.close, 1);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'success');
  assert.equal(ui.elements.get('btnReveal').hidden, false);
  assert.match(ui.elements.get('statusMsg').textContent, /全部 1 个分片/);
});

test('fallback success waits for Chrome complete event', async () => {
  const ui = await setup({ fallback: true });
  const pending = ui.click('btnStart');
  await tick();
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'downloading');
  assert.equal(ui.elements.get('btnStart').disabled, true);
  for (const listener of ui.downloadEvents) listener({ id: 1, state: { current: 'complete' } });
  await pending;
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'success');
  assert.equal(ui.downloadEvents.size, 0);
});

test('cancel while fetching aborts writer and restores controls', async () => {
  const ui = await setup({ download(_sink, signal) { return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); } });
  const pending = ui.click('btnStart');
  await tick();
  await ui.click('btnCancel');
  await pending;
  assert.equal(ui.counters.abort, 1);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'cancelled');
  assert.equal(ui.elements.get('btnStart').disabled, false);
});

test('unavailable picker falls back but still waits for Chrome to finish', async () => {
  for (const name of ['NotSupportedError', 'SecurityError']) {
    const ui = await setup({ pickerError: new DOMException('unsupported context', name) });
    const pending = ui.click('btnStart');
    await tick();
    assert.equal(ui.counters.download, 1);
    assert.equal(ui.elements.get('statusMsg').dataset.state, 'downloading');
    for (const listener of ui.downloadEvents) listener({ id: 1, state: { current: 'complete' } });
    await pending;
    assert.equal(ui.elements.get('statusMsg').dataset.state, 'success');
  }
});

test('write permission errors never trigger memory fallback', async () => {
  const ui = await setup({ openError: new DOMException('permission denied', 'SecurityError') });
  await ui.click('btnStart');
  assert.equal(ui.counters.download, 0);
  assert.equal(ui.submitted.length, 0);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'error');
});

test('unsupported picker fallback enforces the memory ceiling', async () => {
  const ui = await setup({ pickerError: new DOMException('unsupported', 'NotSupportedError'), async download(sink) { await sink.write({ byteLength: 257 * 1024 * 1024 }); } });
  await ui.click('btnStart');
  assert.equal(ui.submitted.length, 0);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'error');
  assert.match(ui.elements.get('statusMsg').textContent, /256 MB/);
});

test('manifest export absolutizes against redirected URL and reports actual completion', async () => {
  const ui = await setup();
  assert.equal(ui.elements.get('progressText').textContent, '准备下载');
  const pending = ui.click('btnDownloadM3U8');
  await tick();
  assert.equal(ui.submitted.length, 1);
  assert.match(ui.submitted[0].url, /^blob:/);
  const text = await (await fetch(ui.submitted[0].url)).text();
  assert.match(text, /URI="https:\/\/cdn.test\/redirect\/key"/);
  assert.match(text, /https:\/\/cdn.test\/redirect\/part.ts/);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'downloading');
  for (const listener of ui.downloadEvents) listener({ id: 1, state: { current: 'complete' } });
  await pending;
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'success');
  assert.match(ui.elements.get('statusMsg').textContent, /播放清单已保存/);
});

function fakeOpfs(options = {}) {
  const state = { created: [], removed: [], writes: [], closed: 0, aborted: 0, bytes: 0 };
  const writer = {
    async write(data) {
      if (options.writeError) throw options.writeError;
      state.writes.push(data.byteLength);
      state.bytes += data.byteLength;
    },
    async close() { state.closed++; },
    async abort() { state.aborted++; }
  };
  const fileHandle = {
    async createWritable() { if (options.openError) throw options.openError; return writer; },
    async getFile() {
      // A tiny backing Blob keeps this lifecycle test cheap; its reported size
      // represents bytes written by the mocked disk, not allocated heap data.
      const file = new Blob(['fixture']);
      Object.defineProperty(file, 'size', { value: state.bytes });
      return file;
    }
  };
  const root = {
    async getFileHandle(name, config) {
      assert.equal(config.create, true);
      assert.match(name, /^neko-download-[0-9a-f-]+\.part$/);
      state.created.push(name);
      return fileHandle;
    },
    async removeEntry(name) {
      assert.ok(state.created.includes(name), 'Only this test task file may be removed');
      state.removed.push(name);
    }
  };
  return { state, storage: { async getDirectory() { if (options.directoryError) throw options.directoryError; return root; } } };
}

test('OPFS handles more than 256 MB and retains temp file until Chrome completes', async () => {
  const opfs = fakeOpfs();
  const total = 563 * 1024 * 1024;
  const ui = await setup({ fallback: true, storage: opfs.storage, async download(sink, _signal, progress) {
    await sink.write({ byteLength: total });
    progress({ completed: 1, total: 1, bytes: total });
  } });
  const pending = ui.click('btnStart');
  await tick();
  assert.equal(opfs.state.bytes, total);
  assert.equal(opfs.state.closed, 1);
  assert.equal(ui.submitted.length, 1);
  assert.equal(opfs.state.removed.length, 0);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'downloading');
  for (const listener of ui.downloadEvents) listener({ id: 1, state: { current: 'complete' } });
  await pending;
  assert.deepEqual(opfs.state.removed, opfs.state.created);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'success');
  assert.equal(ui.elements.get('btnReveal').textContent, '在文件夹中显示');
});

test('OPFS write quota failure aborts writer, cleans only its temp file, and does not fallback', async () => {
  const opfs = fakeOpfs({ writeError: new DOMException('quota', 'QuotaExceededError') });
  const ui = await setup({ fallback: true, storage: opfs.storage });
  await ui.click('btnStart');
  assert.equal(opfs.state.aborted, 1);
  assert.equal(opfs.state.closed, 0);
  assert.deepEqual(opfs.state.removed, opfs.state.created);
  assert.equal(ui.submitted.length, 0);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'error');
  assert.match(ui.elements.get('statusMsg').textContent, /空间不足/);
});

test('OPFS createWritable failure cleans created file and never downloads into memory', async () => {
  const opfs = fakeOpfs({ openError: new DOMException('quota', 'QuotaExceededError') });
  const ui = await setup({ fallback: true, storage: opfs.storage });
  await ui.click('btnStart');
  assert.equal(ui.counters.download, 0);
  assert.deepEqual(opfs.state.removed, opfs.state.created);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'error');
});

test('OPFS cancellation during fetch aborts and removes its temporary file', async () => {
  const opfs = fakeOpfs();
  const ui = await setup({ fallback: true, storage: opfs.storage, download(_sink, signal) { return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); } });
  const pending = ui.click('btnStart');
  await tick();
  await ui.click('btnCancel');
  await pending;
  assert.equal(opfs.state.aborted, 1);
  assert.deepEqual(opfs.state.removed, opfs.state.created);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'cancelled');
});

test('OPFS cleanup waits for Chrome cancellation callback', async () => {
  const opfs = fakeOpfs();
  let finishCancel;
  const ui = await setup({ fallback: true, storage: opfs.storage, cancel(callback) { finishCancel = callback; } });
  const pending = ui.click('btnStart');
  await tick();
  await ui.click('btnCancel');
  await tick();
  assert.equal(opfs.state.removed.length, 0);
  finishCancel();
  await pending;
  assert.deepEqual(opfs.state.removed, opfs.state.created);
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'cancelled');
});

test('unsupported OPFS falls back to bounded memory but security failure terminates', async () => {
  const unavailable = fakeOpfs({ directoryError: new DOMException('unsupported', 'NotSupportedError') });
  const ui = await setup({ fallback: true, storage: unavailable.storage });
  const pending = ui.click('btnStart');
  await tick();
  assert.equal(ui.submitted.length, 1);
  for (const listener of ui.downloadEvents) listener({ id: 1, state: { current: 'complete' } });
  await pending;
  assert.equal(ui.elements.get('statusMsg').dataset.state, 'success');
  const denied = fakeOpfs({ directoryError: new DOMException('denied', 'SecurityError') });
  const deniedUi = await setup({ fallback: true, storage: denied.storage });
  await deniedUi.click('btnStart');
  assert.equal(deniedUi.counters.download, 0);
  assert.equal(deniedUi.elements.get('statusMsg').dataset.state, 'error');
});
