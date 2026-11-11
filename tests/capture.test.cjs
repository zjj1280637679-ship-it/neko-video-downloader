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
function makeBackground({ deferRestore = false, restored = {}, now = 100000 } = {}) {
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
  class ClockDate extends Date { static now() { return now; } }
  const context = vm.createContext({ chrome, crypto: webcrypto, URL, console, Date: ClockDate, setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} });
  vm.runInContext(background, context);
  const message = (body, sender = {}) => new Promise(resolve => {
    const result = chrome.runtime.onMessage.listeners[0](body, sender, resolve);
    if (result !== true) resolve(undefined);
  });
  return { chrome, message, notifications, downloadItems, restore, timers, advance(milliseconds) { now += milliseconds; } };
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

test('DOM metadata enriches a network capture; non-HTTP media is not exposed', async () => {
  const h = makeBackground();
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 2, url: 'https://cdn.test/index.m3u8', type: 'xmlhttprequest' });
  await h.message({ action: 'reportMasterStream', url: 'https://cdn.test/index.m3u8', name: '第1集', title: 'Title' }, { tab: { id: 2 }, frameId: 0 });
  const result = await h.message({ action: 'getMedia', tabId: 2 });
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].name, '第1集');
  await h.message({ action: 'reportDOMVideo', url: 'javascript:alert(1)' }, { tab: { id: 2 }, frameId: 0 });
  assert.equal((await h.message({ action: 'getMedia', tabId: 2 })).media.length, 1);
});

test('capture handler exposes no legacy download bypass for content-script senders', async () => {
  const h = makeBackground();
  const sender = { tab: { id: 9 }, url: 'https://page.test/watch' };
  assert.equal(await h.message({ action: 'download', url: 'https://cdn.test/movie.mp4', filename: 'movie.mp4' }, sender), undefined);
  assert.equal(await h.message({ action: 'getDownloadStatus', downloadId: 42 }, sender), undefined);
  assert.equal(h.chrome.downloadOptions, undefined);
});

test('changing back to an earlier selected stream promotes it and clears the old active marker', async () => {
  const h = makeBackground();
  const report = url => h.message({ action: 'reportMasterStream', url, active: true }, { tab: { id: 11 }, frameId: 0 });
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
  await h.message({ action: 'reportDOMVideo', url: 'https://cdn.test/movie.mp4' }, { tab: { id: 3 }, frameId: 0 });
  await h.message({ action: 'reportVideoFrames', frames: Array.from({ length: 30 }, (_, seconds) => ({ seconds, dataUrl: 'data:image/jpeg;base64,a', timeStr: String(seconds) })) }, { tab: { id: 3 }, frameId: 0 });
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
    querySelectorAll(selector) { return selector === '[udata], [data-url]' ? elements : []; }
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

function playbackReport(overrides = {}) {
  return { action: 'reportPlaybackState', documentToken: 'document-a', documentStartedAt: 90000,
    generation: 1, videoCount: 1, iframeCount: 0, hasPlayed: false, playing: false, ...overrides };
}
function frameSender(tabId = 20, frameId = 0, documentId = `document-${frameId}`) {
  return { tab: { id: tabId, url: 'https://page.test/watch' }, frameId, documentId };
}

test('preloaded network and selected DOM playlists remain downloadable without implying playback', async () => {
  const h = makeBackground();
  await h.message(playbackReport(), frameSender());
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).capturePhase, 'waiting');
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 20, type: 'xmlhttprequest', frameId: 0, url: 'https://cdn.test/preload.m3u8' });
  await h.message({ action: 'reportMasterStream', url: 'https://cdn.test/selected.m3u8', active: true }, frameSender());
  const result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.media.length, 2);
  assert.equal(result.capturePhase, 'found');
  assert.equal(result.playback.observed, false);
  assert.equal(result.playback.playing, false);
});

test('nested-frame playback aggregates, pauses retain evidence, and no-source stops sniffing after ten seconds', async () => {
  const h = makeBackground();
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).capturePhase, 'checking');
  await h.message(playbackReport({ videoCount: 0, iframeCount: 1 }), frameSender());
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).capturePhase, 'checking');
  await h.message(playbackReport({ videoCount: 0, iframeCount: 1 }), frameSender(20, 4));
  await h.message(playbackReport({ hasPlayed: true, playing: true }), frameSender(20, 8));
  let result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.capturePhase, 'sniffing');
  assert.equal(result.playback.frameCount, 3);
  assert.equal(result.playback.uncertain, false);
  assert.equal(result.playback.videoCount, 1);
  assert.equal(result.playback.playing, true);
  h.advance(9999);
  await h.message(playbackReport({ hasPlayed: true, playing: false }), frameSender(20, 8));
  result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.capturePhase, 'sniffing');
  assert.equal(result.playback.observed, true);
  assert.equal(result.playback.playing, false);
  h.advance(1);
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).capturePhase, 'no-source');
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 20, type: 'xmlhttprequest', frameId: 8, url: 'https://cdn.test/found.m3u8' });
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).capturePhase, 'found');
});

test('no-video requires complete frame evidence; unknown iframes stay uncertain', async () => {
  const h = makeBackground();
  await h.message(playbackReport({ videoCount: 0, iframeCount: 1 }), frameSender());
  let result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.capturePhase, 'checking');
  assert.equal(result.playback.uncertain, true);
  await h.message(playbackReport({ videoCount: 0 }), frameSender(20, 3));
  result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.capturePhase, 'no-video');
  assert.equal(result.playback.uncertain, false);
});

test('source generations and newer documents reset playback and reject delayed old reports', async () => {
  const h = makeBackground();
  await h.message(playbackReport({ hasPlayed: true, playing: true }), frameSender());
  h.advance(11000);
  await h.message(playbackReport({ generation: 2 }), frameSender());
  let result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.capturePhase, 'waiting');
  assert.equal(result.playback.observedAt, null);
  await h.message(playbackReport({ hasPlayed: true, playing: true }), frameSender());
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).playback.observed, false);
  await h.message(playbackReport({ documentToken: 'document-new', documentStartedAt: 100001, generation: 1 }), frameSender(20, 0, 'new-id'));
  await h.message(playbackReport({ generation: 9, hasPlayed: true, playing: true }), frameSender());
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).playback.observed, false);
});

test('same-URL refresh clears playback and rejects retired documents while allowing a new activation', async () => {
  const h = makeBackground();
  await h.message(playbackReport({ hasPlayed: true, playing: true }), frameSender());
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 20, type: 'main_frame', url: 'https://page.test/watch' });
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).capturePhase, 'checking');
  await h.message(playbackReport({ hasPlayed: true, playing: true }), frameSender());
  await h.message({ action: 'reportMasterStream', documentToken: 'document-a', generation: 1,
    documentStartedAt: 90000, url: 'https://cdn.test/stale.m3u8' }, frameSender());
  let result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.playback.observed, false);
  assert.equal(result.media.length, 0);
  // BFCache can reactivate the same browser documentId with a fresh token.
  await h.message(playbackReport({ documentToken: 'reactivated', documentStartedAt: 100000 }), frameSender());
  result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.capturePhase, 'waiting');
});

test('subframe navigation clears that frame and known descendants without clearing other frame media', async () => {
  const h = makeBackground();
  await h.message(playbackReport({ videoCount: 0, iframeCount: 2 }), frameSender());
  for (const [frameId, parentFrameId] of [[4, 0], [8, 4], [9, 0]]) {
    h.chrome.webRequest.onBeforeRequest.emit({ tabId: 20, type: 'sub_frame', frameId, parentFrameId, url: 'https://player.test/' });
    await h.message(playbackReport({ hasPlayed: frameId === 8, playing: frameId === 8, videoCount: frameId === 4 ? 0 : 1 }), frameSender(20, frameId));
    await h.message({ action: 'reportMasterStream', url: `https://cdn.test/${frameId}.m3u8` }, frameSender(20, frameId));
  }
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 20, type: 'sub_frame', frameId: 4, parentFrameId: 0, url: 'https://player.test/' });
  const result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.playback.observed, false);
  assert.deepEqual(Array.from(result.media, item => item.frameId), [9]);
});

test('playback reports require the actual sender tab/frame and unchanged state does not write or notify', async () => {
  const h = makeBackground();
  await h.message(playbackReport({ tabId: 999, frameId: 99 }), frameSender());
  const reports = h.notifications.length;
  const saves = h.timers.length;
  h.advance(12000);
  await h.message(playbackReport({ tabId: 999, frameId: 99 }), frameSender());
  assert.equal(h.notifications.length, reports);
  assert.equal(h.timers.length, saves);
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).playback.videoCount, 1);
  assert.equal((await h.message({ action: 'getMedia', tabId: 999 })).playback.videoCount, 0);
  await h.message(playbackReport({ tabId: 999, hasPlayed: true, playing: true }), {});
  await h.message(playbackReport({ hasPlayed: true, playing: true }), { tab: { id: 20 } });
  assert.equal((await h.message({ action: 'getMedia', tabId: 20 })).playback.observed, false);
  h.timers.at(-1)(); await tick();
  const restored = makeBackground({ restored: h.chrome.saved });
  assert.equal((await restored.message({ action: 'getMedia', tabId: 20 })).capturePhase, 'waiting');
});

test('removed iframe pagehide retires its playback and late reports cannot resurrect it', async () => {
  const h = makeBackground();
  await h.message(playbackReport({ videoCount: 0, iframeCount: 1 }), frameSender());
  await h.message(playbackReport({ hasPlayed: true, playing: true }), frameSender(20, 4));
  await h.message(playbackReport({ videoCount: 0, inactive: true, generation: 2 }), frameSender(20, 4));
  await h.message(playbackReport({ videoCount: 0, iframeCount: 0 }), frameSender());
  await h.message(playbackReport({ hasPlayed: true, playing: true, generation: 3 }), frameSender(20, 4));
  const result = await h.message({ action: 'getMedia', tabId: 20 });
  assert.equal(result.capturePhase, 'no-video');
  assert.equal(result.playback.frameCount, 1);
});

function fakeVideo(overrides = {}) {
  const listeners = new Map();
  return {
    nodeType: 1, src: 'blob:https://page.test/movie', currentSrc: 'blob:https://page.test/movie',
    paused: true, ended: false, readyState: 0, currentTime: 0, videoWidth: 0, videoHeight: 0,
    played: { length: 0 }, sources: [], ...overrides,
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    querySelectorAll(selector) { return selector === 'source[src]' ? this.sources : []; },
    querySelector() { return null; }, matches(selector) { return selector.includes('video'); },
    emit(type, changes = {}) { Object.assign(this, changes); for (const handler of listeners.get(type) || []) handler({ type, isTrusted: true }); }
  };
}
function makeContent({ videos = [], iframeCount = 0, elements = [], topFrame = true } = {}) {
  const sent = [];
  const timers = [];
  const windowEvents = new Map();
  let observerCallback;
  const document = {
    title: 'Test', baseURI: 'https://page.test/watch', documentElement: {},
    querySelectorAll(selector) {
      return selector === 'video' ? videos : selector === 'iframe, frame' ? Array(iframeCount).fill({})
        : selector === '[udata], [data-url]' ? elements : [];
    }
  };
  const window = { addEventListener(type, handler) { windowEvents.set(type, handler); } };
  window.top = topFrame ? window : {};
  vm.runInContext(content, vm.createContext({
    document, window, URL, crypto: webcrypto, performance: { timeOrigin: 90000 }, console,
    setTimeout(fn) { timers.push(fn); return timers.length; },
    chrome: { runtime: { sendMessage(message) { sent.push(message); return Promise.resolve(); }, onMessage: event() } },
    MutationObserver: class { constructor(fn) { observerCallback = fn; } observe() {} }
  }));
  return {
    sent, videos, playback() { return sent.filter(message => message.action === 'reportPlaybackState'); },
    flush() { while (timers.length) timers.shift()(); },
    mutate(records) { observerCallback(records); },
    pageShow(persisted = false) { windowEvents.get('pageshow')({ persisted }); },
    pageHide() { windowEvents.get('pagehide')(); }
  };
}

test('paused seek and metadata/preload do not imply playback; play requests wait for real playback', () => {
  const video = fakeVideo({ readyState: 4, currentTime: 150 });
  const h = makeContent({ videos: [video] });
  assert.equal(h.playback().at(-1).hasPlayed, false);
  video.emit('loadedmetadata');
  video.emit('play', { paused: false, readyState: 1 });
  assert.equal(h.playback().at(-1).hasPlayed, false);
  video.emit('playing', { readyState: 3 });
  assert.equal(h.playback().at(-1).hasPlayed, true);
  assert.equal(h.playback().at(-1).playing, true);
  video.emit('pause', { paused: true });
  assert.equal(h.playback().at(-1).hasPlayed, true);
  assert.equal(h.playback().at(-1).playing, false);
  video.emit('ended', { ended: true });
  assert.equal(h.playback().at(-1).hasPlayed, true);
});

test('late attachment recognizes running video and played ranges in paused video, including nested frames', () => {
  const running = makeContent({ videos: [fakeVideo({ paused: false, readyState: 2 })], topFrame: false });
  assert.equal(running.playback()[0].hasPlayed, true);
  assert.equal(running.playback()[0].playing, true);
  assert.equal(running.sent.some(message => message.action === 'reportPageTitle'), false);
  const paused = makeContent({ videos: [fakeVideo({ readyState: 4, played: { length: 1 } })] });
  assert.equal(paused.playback()[0].hasPlayed, true);
  assert.equal(paused.playback()[0].playing, false);
});

test('source changes reset evidence before currentSrc catches up and emptied resets same-URL reloads', () => {
  const video = fakeVideo({ paused: false, readyState: 4, currentTime: 50, played: { length: 1 } });
  const h = makeContent({ videos: [video] });
  const generation = h.playback().at(-1).generation;
  video.src = 'blob:https://page.test/new-movie';
  h.mutate([{ type: 'attributes', attributeName: 'src', target: video }]); h.flush();
  assert.equal(h.playback().at(-1).hasPlayed, false);
  assert.ok(h.playback().at(-1).generation > generation);
  video.emit('emptied', { paused: true, readyState: 0, currentSrc: '', currentTime: 0, played: { length: 0 } });
  video.emit('loadedmetadata', { readyState: 2, currentSrc: video.src });
  assert.equal(h.playback().at(-1).hasPlayed, false);
  video.emit('playing', { paused: false, readyState: 4 });
  assert.equal(h.playback().at(-1).hasPlayed, true);
  const playedGeneration = h.playback().at(-1).generation;
  video.emit('emptied', { paused: true, readyState: 0, currentTime: 0 });
  assert.equal(h.playback().at(-1).hasPlayed, false);
  assert.ok(h.playback().at(-1).generation > playedGeneration);
});

test('video removal reports zero players; repeated video-clock ticks do not emit playback state', () => {
  const video = fakeVideo({ paused: false, readyState: 4, currentTime: 1 });
  const h = makeContent({ videos: [video] });
  const count = h.playback().length;
  for (let index = 0; index < 100; index++) video.emit('timeupdate', { currentTime: index + 2 });
  assert.equal(h.playback().length, count);
  h.videos.length = 0;
  h.mutate([{ type: 'childList', target: {}, addedNodes: [], removedNodes: [video] }]); h.flush();
  assert.equal(h.playback().at(-1).videoCount, 0);
  assert.equal(h.playback().at(-1).hasPlayed, false);
});

test('BFCache activation refreshes document token and resends unchanged playback and media', () => {
  const video = fakeVideo({ src: 'https://cdn.test/movie.mp4', currentSrc: 'https://cdn.test/movie.mp4', readyState: 4 });
  const h = makeContent({ videos: [video] });
  const previous = h.playback()[0].documentToken;
  h.pageHide();
  assert.equal(h.playback().at(-1).inactive, true);
  h.pageShow(true); h.flush();
  assert.equal(h.playback().length, 3);
  assert.notEqual(h.playback().at(-1).documentToken, previous);
  assert.equal(h.sent.filter(message => message.action === 'reportDOMVideo').length, 2);
});
