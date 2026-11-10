const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } }; }
function makeBackground({ deferRestore = false, restored = {} } = {}) {
  let restore;
  const storageReady = deferRestore ? new Promise(resolve => { restore = resolve; }) : Promise.resolve(restored);
  const notifications = [];
  const downloadItems = new Map();
  const timers = [];
  const chrome = {
    storage: { session: { get: () => storageReady, set: async value => { chrome.saved = value; } } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: { onMessage: event(), sendMessage: async message => { notifications.push(message); } },
    webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    tabs: { onUpdated: event(), onRemoved: event() },
    downloads: {
      onChanged: event(), search: async ({ id }) => downloadItems.has(id) ? [downloadItems.get(id)] : [],
      download: (options, callback) => {
        chrome.downloadOptions = options;
        downloadItems.set(42, { id: 42, state: 'in_progress', filename: options.filename, url: options.url, totalBytes: 400 });
        callback(42);
      }
    }
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, console, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} });
  vm.runInContext(background, context);
  const message = (body, sender = {}) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](body, sender, resolve));
  return { chrome, message, notifications, downloadItems, restore, timers };
}

test('cold-worker hydration preserves requests captured before storage resolves', async () => {
  const h = makeBackground({ deferRestore: true });
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 0, type: 'xmlhttprequest', url: 'https://cdn.test/new.M3U8?token=1', frameId: 3 });
  h.restore({ neko_tabMedia: [[0, [{ id: 'old', url: 'https://cdn.test/old.mp4', size: 10 }]]] });
  const result = await h.message({ action: 'getMedia', tabId: 0 });
  assert.equal(result.media.length, 2);
  assert.equal(result.media[0].url, 'https://cdn.test/new.M3U8?token=1');
  assert.equal(result.media[0].isM3U8, true);
});

test('same-URL navigation clears old captures before new media arrives', async () => {
  const h = makeBackground({ restored: { neko_tabMedia: [[5, [{ id: 'stale', url: 'https://cdn.test/old.mp4' }]]] } });
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 5, type: 'main_frame', url: 'https://page.test/watch' });
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 5, type: 'xmlhttprequest', url: 'https://cdn.test/new.m3u8' });
  // A late loading notification must not erase requests already seen.
  h.chrome.tabs.onUpdated.emit(5, { status: 'loading', url: 'https://page.test/watch' });
  const result = await h.message({ action: 'getMedia', tabId: 5 });
  assert.deepEqual(Array.from(result.media, item => item.url), ['https://cdn.test/new.m3u8']);
});

test('206 reports total size, fragments are deduplicated, full part_1.mp4 survives', async () => {
  const h = makeBackground();
  const headers = (url, mime, extra = []) => h.chrome.webRequest.onHeadersReceived.emit({
    tabId: 8, statusCode: 206, url,
    responseHeaders: [{ name: 'content-type', value: mime }, { name: 'content-length', value: '100' }, ...extra]
  });
  headers('https://cdn.test/part_1.mp4', 'video/mp4', [{ name: 'Content-Range', value: 'bytes 0-99/8000' }]);
  headers('https://cdn.test/1.ts', 'video/mp2t');
  headers('https://cdn.test/1.ts', 'video/mp2t');
  headers('https://cdn.test/index.m3u8', 'application/vnd.apple.mpegurl');
  const result = await h.message({ action: 'getMedia', tabId: 8 });
  assert.equal(result.media.length, 2);
  assert.equal(result.chunkCount, 1);
  assert.equal(result.media.find(item => !item.isM3U8).size, 8000);
  assert.equal(result.media.find(item => item.isM3U8).size, 0);
});

test('DOM metadata enriches a network capture; invalid URL cannot be downloaded', async () => {
  const h = makeBackground();
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 2, url: 'https://cdn.test/index.m3u8', type: 'xmlhttprequest' });
  await h.message({ action: 'reportMasterStream', url: 'https://cdn.test/index.m3u8', name: '第1集', title: 'Title' }, { tab: { id: 2 }, frameId: 0 });
  const result = await h.message({ action: 'getMedia', tabId: 2 });
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].name, '第1集');
  assert.equal((await h.message({ action: 'download', url: 'javascript:alert(1)' })).success, false);
  assert.equal((await h.message({ action: 'download', url: 'https://cdn.test/index.m3u8' })).success, false);
});

test('direct download is started first, and interrupted/completed only from Chrome state', async () => {
  const h = makeBackground();
  const start = await h.message({ action: 'download', tabId: 9, url: 'https://cdn.test/movie.mp4', filename: 'movie.mp4' });
  assert.equal(start.state, 'in_progress');
  h.downloadItems.set(42, { id: 42, state: 'interrupted', error: 'NETWORK_FAILED', filename: 'movie.mp4' });
  h.chrome.downloads.onChanged.emit({ id: 42, state: { current: 'interrupted' } });
  await tick();
  const status = await h.message({ action: 'getMedia', tabId: 9 });
  assert.equal(status.downloads[0].state, 'interrupted');
  assert.equal(status.downloads[0].error, 'NETWORK_FAILED');
  assert.ok(h.notifications.some(message => message.action === 'downloadStatusUpdated' && message.state === 'interrupted'));
});

test('changing back to an earlier selected stream promotes it and clears the old active marker', async () => {
  const h = makeBackground();
  const report = url => h.message({ action: 'reportMasterStream', url, active: true }, { tab: { id: 11 } });
  await report('https://cdn.test/one.m3u8');
  await report('https://cdn.test/two.m3u8');
  await report('https://cdn.test/one.m3u8');
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 11, url: 'https://cdn.test/variant.m3u8', type: 'xmlhttprequest' });
  const result = await h.message({ action: 'getMedia', tabId: 11 });
  assert.equal(result.media[0].url, 'https://cdn.test/one.m3u8');
  assert.equal(result.media.filter(item => item.active).length, 1);
});

test('frame history is bounded and serialized once per tab', async () => {
  const h = makeBackground();
  await h.message({ action: 'reportDOMVideo', url: 'https://cdn.test/movie.mp4' }, { tab: { id: 3 } });
  await h.message({ action: 'reportVideoFrames', frames: Array.from({ length: 30 }, (_, seconds) => ({ seconds, dataUrl: 'data:image/jpeg;base64,a', timeStr: String(seconds) })) }, { tab: { id: 3 } });
  const result = await h.message({ action: 'getMedia', tabId: 3 });
  assert.equal(result.frames.length, 10);
  h.timers.at(-1)(); await tick();
  assert.equal(h.chrome.saved.neko_tabMedia[0][1][0].frames, undefined);
  assert.equal(h.chrome.saved.neko_tabFrames[0][1].length, 10);
});

test('DOM scanner ignores inactive episodes and non-media data-url; repeated mutations do not resend', () => {
  const sent = [];
  let observerCallback;
  const timers = [];
  function element(url, { active = false, line = false } = {}) {
    return {
      textContent: '第1集', classList: { contains: () => active },
      getAttribute(name) { return name === 'data-url' ? url : name === 'name' && line ? 'lineData' : null; }
    };
  }
  const elements = [element('https://cdn.test/active.m3u8', { active: true, line: true }),
    element('https://cdn.test/inactive.m3u8', { line: true }), element('https://site.test/article'), element('/movie.mp4')];
  const document = {
    title: 'Test', baseURI: 'https://page.test/', documentElement: {},
    querySelectorAll(selector) { return selector === 'video' ? [] : elements; }
  };
  const window = { addEventListener() {} }; window.top = window;
  const context = vm.createContext({
    document, window, URL, console, setTimeout(fn) { timers.push(fn); return timers.length; },
    chrome: { runtime: { sendMessage(message) { sent.push(message); return Promise.resolve(); }, onMessage: event() } },
    MutationObserver: class { constructor(fn) { observerCallback = fn; } observe() {} }
  });
  vm.runInContext(content, context);
  const media = sent.filter(message => message.url);
  assert.deepEqual(media.map(message => message.url), ['https://cdn.test/active.m3u8', 'https://page.test/movie.mp4']);
  assert.equal(media[1].action, 'reportDOMVideo');
  const mutations = [{ type: 'attributes', attributeName: 'class', target: elements[0] }];
  observerCallback(mutations); observerCallback(mutations);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(sent.filter(message => message.url).length, 2);
});
