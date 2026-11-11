const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const source = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function contentHarness() {
  let listener;
  const messages = [];
  const canvases = [];
  const handlers = {};
  const video = {
    src: 'https://media.test/episode1.mp4', currentSrc: 'https://media.test/episode1.mp4',
    currentTime: 0, videoWidth: 1920, videoHeight: 1080, paused: false, ended: false,
    querySelector: () => null,
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); }
  };
  const window = {}; window.top = window;
  const context = vm.createContext({
    window, location: { href: 'https://page.test/watch' }, URL, crypto: { randomUUID }, console,
    setTimeout() {}, MutationObserver: class { observe() {} },
    document: {
      title: 'Video', body: {},
      querySelectorAll: (selector) => selector === 'video' ? [video] : [],
      createElement(tag) {
        assert.equal(tag, 'canvas');
        const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }),
          toDataURL() { return `data:image/jpeg;size=${this.width}x${this.height};source=${video.currentSrc};time=${video.currentTime}`; } };
        canvases.push(canvas); return canvas;
      }
    },
    chrome: { runtime: {
      sendMessage: async (m) => { messages.push(JSON.parse(JSON.stringify(m))); },
      onMessage: { addListener: (fn) => { listener = fn; } }
    } }
  });
  vm.runInContext(source('content.js'), context);
  return {
    video, messages, canvases,
    emit: (name) => (handlers[name] || []).forEach((fn) => fn()),
    request(message) { let result; listener(message, {}, (r) => { result = r; }); return result; },
    frames: () => messages.filter((m) => m.action === 'reportVideoFrames').at(-1).frames
  };
}

test('original screenshot uses source dimensions while session-bound reports contain only thumbnails', () => {
  const h = contentHarness();
  const result = h.request({ action: 'captureCurrentFrameNow' });
  assert.equal(result.success, true);
  assert.match(result.frame.originalDataUrl, /size=1920x1080/);
  assert.match(result.frame.dataUrl, /size=180x101/);
  assert.equal(h.frames().length, 1);
  assert.equal('originalDataUrl' in h.frames()[0], false);
  assert.equal(result.frame.width, 1920);
});

test('switching the source after ten samples discards all old pictures; same-second manual capture replaces', () => {
  const h = contentHarness();
  for (let seconds = 2; seconds <= 18; seconds += 2) { h.video.currentTime = seconds; h.emit('timeupdate'); }
  assert.equal(h.frames().length, 10);
  const oldId = h.frames()[0].id;
  h.video.src = h.video.currentSrc = 'https://media.test/episode2.mp4';
  h.video.currentTime = 10; h.emit('playing');
  assert.equal(h.frames().length, 1);
  assert.ok(h.frames().every((f) => f.sourceUrl.endsWith('episode2.mp4')));
  const idBeforeManual = h.frames()[0].id;
  const snap = h.request({ action: 'captureCurrentFrameNow' });
  assert.equal(snap.success, true);
  assert.equal(h.frames().length, 1);
  assert.notEqual(h.frames()[0].id, idBeforeManual);
  const stale = h.request({ action: 'getCapturedFrame', videoId: snap.frame.videoId, captureId: oldId });
  assert.equal(stale.success, false);
});

test('manual pictures stay bounded and original retrieval matches the selected capture', () => {
  const h = contentHarness();
  let snap;
  for (let seconds = 0; seconds < 25; seconds++) {
    h.video.currentTime = seconds;
    snap = h.request({ action: 'captureCurrentFrameNow' });
  }
  assert.equal(h.frames().length, 10);
  const full = h.request({ action: 'getCapturedFrame', videoId: snap.frame.videoId, captureId: snap.frame.id });
  assert.equal(full.frame.originalDataUrl, snap.frame.originalDataUrl);
});

function backgroundHarness(initial = {}, deferred = false) {
  const events = {}, writes = [], sent = [];
  let resolveStorage;
  const restored = deferred ? new Promise((resolve) => { resolveStorage = resolve; }) : Promise.resolve(initial);
  const event = (name) => ({ addListener: (fn) => { events[name] = fn; } });
  let tabsResponder = async () => ({ success: false, error: 'No video' });
  const chrome = {
    storage: { session: {
      get: () => restored,
      set: async (snapshot) => { writes.push(JSON.parse(JSON.stringify(snapshot))); }
    } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    runtime: { onMessage: event('message'), sendMessage: async () => {} },
    webRequest: { onBeforeRequest: event('before'), onHeadersReceived: event('headers') },
    tabs: {
      onUpdated: event('updated'), onRemoved: event('removed'),
      sendMessage: async (tabId, message, options) => { sent.push({ tabId, message, options }); return tabsResponder(tabId, message, options); }
    },
    downloads: { download() {} }
  };
  vm.runInNewContext(source('background.js'), { chrome, console });
  return { events, writes, sent,
    restore: () => resolveStorage(initial),
    respondWith: (fn) => { tabsResponder = fn; },
    request: (message, sender = {}) => new Promise((resolve) => events.message(message, sender, resolve))
  };
}

test('new media arriving before session recovery is retained alongside the old state', async () => {
  const old = { url: 'https://media.test/old.m3u8', isM3U8: true, frameIds: [0] };
  const h = backgroundHarness({ neko_tabMedia: [[1, [old]]] }, true);
  h.events.before({ tabId: 1, frameId: 0, url: 'https://media.test/new.m3u8' });
  assert.equal(h.writes.length, 0);
  h.restore(); await tick();
  const result = await h.request({ action: 'getMedia', tabId: 1 });
  assert.deepEqual(Array.from(result.media, (m) => m.url).sort(), [old.url, 'https://media.test/new.m3u8'].sort());
});

test('tab closure queued before recovery cannot resurrect saved media or pictures', async () => {
  const h = backgroundHarness({ neko_tabMedia: [[1, [{ url: 'old' }]]], neko_tabFrames: [[1, [{ id: 'old' }]]] }, true);
  h.events.removed(1); h.restore(); await tick();
  const result = await h.request({ action: 'getMedia', tabId: 1 });
  assert.equal(result.media.length, 0); assert.equal(result.frames.length, 0);
});

test('same-URL reload without changeInfo.url clears every old document state, including during recovery', async () => {
  for (const deferred of [false, true]) {
    const initial = {
      neko_tabMedia: [[1, [{ url: 'https://media.test/old.m3u8', isM3U8: true, frameIds: [0] }]]],
      neko_tabTitles: [[1, 'Old page']], neko_tabChunks: [[1, 12]],
      neko_tabFrames: [[1, [{ id: 'old-picture', frameId: 0, documentId: 'old-document', videoId: 'video-1' }]]],
      neko_tabPlayers: [[1, [{ frameId: 0, documentId: 'old-document', videoId: 'video-1', sourceUrl: 'blob:old' }]]]
    };
    const h = backgroundHarness(initial, deferred);
    if (!deferred) await tick();
    h.events.updated(1, { status: 'loading' });
    if (deferred) h.restore();
    await tick();
    const result = await h.request({ action: 'getMedia', tabId: 1 });
    assert.equal(result.media.length, 0);
    assert.equal(result.frames.length, 0);
    assert.equal(result.players.length, 0);
    assert.equal(result.chunkCount, 0);
    assert.notEqual(result.pageTitle, 'Old page');
    assert.ok(!JSON.stringify(h.writes.at(-1)).includes('old-document'));
  }
});

test('new media after a queued reload survives recovery while the previous document stays cleared', async () => {
  const h = backgroundHarness({
    neko_tabMedia: [[1, [{ url: 'https://media.test/old.m3u8', isM3U8: true, frameIds: [0] }]]],
    neko_tabFrames: [[1, [{ id: 'old-picture' }]]]
  }, true);
  h.events.updated(1, { status: 'loading' });
  h.events.before({ tabId: 1, frameId: 0, documentId: 'new-document', url: 'https://media.test/new.m3u8' });
  h.restore(); await tick();
  const result = await h.request({ action: 'getMedia', tabId: 1 });
  assert.deepEqual(Array.from(result.media, (item) => item.url), ['https://media.test/new.m3u8']);
  assert.equal(result.frames.length, 0);
  assert.equal(result.media[0].contexts[0].documentId, 'new-document');
});

test('iframe capture targets its registered document and pictures do not leak between direct video sources', async () => {
  const h = backgroundHarness(); await tick();
  const first = 'https://media.test/main.mp4', second = 'https://media.test/iframe.mp4';
  await h.request({ action: 'reportDOMVideo', url: first, title: 'Main' }, { tab: { id: 1 }, frameId: 0 });
  await h.request({ action: 'reportDOMVideo', url: second, title: 'Frame' }, { tab: { id: 1 }, frameId: 7 });
  await h.request({ action: 'reportVideoFrames', videoId: 'video-1', sourceUrl: second, isPlaying: true, area: 100,
    frames: [{ id: 'capture-7', timestamp: 1, dataUrl: 'thumbnail', originalDataUrl: 'must-not-persist' }] },
    { tab: { id: 1 }, frameId: 7, documentId: 'iframe-document' });
  h.respondWith(async (tabId, message, options) => {
    assert.equal(options.documentId, 'iframe-document');
    return { success: true, frame: { id: 'capture-7', originalDataUrl: 'original' } };
  });
  const snap = await h.request({ action: 'captureCurrentFrame', tabId: 1, sourceUrl: second });
  assert.equal(snap.success, true); assert.equal(h.sent.length, 1);
  const result = await h.request({ action: 'getMedia', tabId: 1 });
  assert.equal(result.media.find((m) => m.url === first).frames.length, 0);
  assert.equal(result.media.find((m) => m.url === second).frames.length, 1);
  assert.ok(!JSON.stringify(h.writes).includes('must-not-persist'));
});

test('a reused iframe document removes its stale pictures before new samples arrive', async () => {
  const h = backgroundHarness(); await tick();
  const report = (documentId, frames) => h.request({ action: 'reportVideoFrames', videoId: 'video-1', sourceUrl: 'blob:' + documentId, frames },
    { tab: { id: 2 }, frameId: 3, documentId });
  await report('old-document', [{ id: 'old-capture', timestamp: 1 }]);
  await report('new-document', []);
  const result = await h.request({ action: 'getMedia', tabId: 2 });
  assert.equal(result.frames.length, 0);
});

test('a failed capture from the selected direct video never silently captures a different video', async () => {
  const h = backgroundHarness(); await tick();
  const first = 'https://media.test/a.mp4', second = 'https://media.test/b.mp4';
  for (const [frameId, sourceUrl] of [[0, first], [1, second]]) {
    await h.request({ action: 'reportDOMVideo', url: sourceUrl }, { tab: { id: 1 }, frameId });
    await h.request({ action: 'reportVideoFrames', videoId: 'video-1', sourceUrl, frames: [] },
      { tab: { id: 1 }, frameId, documentId: `doc-${frameId}` });
  }
  h.respondWith(async (tabId, message, options) => options.documentId === 'doc-0'
    ? { success: false, error: 'Cross-origin picture is not readable' }
    : { success: true, frame: { sourceUrl: second } });
  const result = await h.request({ action: 'captureCurrentFrame', tabId: 1, sourceUrl: first });
  assert.equal(result.success, false);
  assert.deepEqual(h.sent.map((item) => item.options.documentId), ['doc-0']);
});

test('a player changed between selection and capture returns an error for the old direct source', () => {
  const h = contentHarness();
  const selected = h.frames()[0].videoId;
  h.video.src = h.video.currentSrc = 'https://media.test/episode2.mp4';
  const result = h.request({ action: 'captureCurrentFrameNow', videoId: selected, sourceUrl: 'https://media.test/episode1.mp4' });
  assert.equal(result.success, false);
});

test('replacing srcObject clears originals even when both source URLs remain empty', () => {
  const h = contentHarness();
  h.video.src = h.video.currentSrc = '';
  h.video.srcObject = { id: 'stream-a' };
  const first = h.request({ action: 'captureCurrentFrameNow' }).frame;
  h.video.srcObject = { id: 'stream-b' };
  const stale = h.request({ action: 'getCapturedFrame', videoId: first.videoId, captureId: first.id });
  assert.equal(stale.success, false);
  assert.equal(h.frames().length, 0);
  const second = h.request({ action: 'captureCurrentFrameNow', videoId: first.videoId });
  assert.equal(second.success, true);
  assert.notEqual(second.frame.id, first.id);
});

test('srcObject takes precedence over a leftover src attribute for picture attribution', () => {
  const h = contentHarness();
  h.video.srcObject = { id: 'camera-stream' };
  const snap = h.request({ action: 'captureCurrentFrameNow' });
  assert.equal(snap.success, true);
  assert.equal(snap.frame.sourceUrl, '');
  assert.ok(h.frames().every((frame) => frame.sourceUrl === ''));
});

test('playback state reports remain fresh after the automatic screenshot cache is full', () => {
  const h = contentHarness();
  for (let seconds = 2; seconds <= 18; seconds += 2) { h.video.currentTime = seconds; h.emit('timeupdate'); }
  assert.equal(h.frames().length, 10);
  h.video.paused = true; h.emit('pause');
  assert.equal(h.messages.filter((message) => message.action === 'reportVideoFrames').at(-1).isPlaying, false);
  h.video.paused = false; h.emit('playing');
  assert.equal(h.messages.filter((message) => message.action === 'reportVideoFrames').at(-1).isPlaying, true);
});

async function respondWithMime(harness, url, mime, frameId = 0, documentId) {
  harness.events.headers({ tabId: 1, frameId, documentId, url,
    responseHeaders: [{ name: 'Content-Type', value: mime }, { name: 'Content-Length', value: '524288000' }] });
  await tick();
}

test('actual response MIME corrects either DOM guess in either arrival order', async () => {
  for (const [action, responseMime, expectedExt] of [
    ['reportDOMVideo', 'application/vnd.apple.mpegurl', 'm3u8'],
    ['reportMasterStream', 'video/mp4', 'mp4'],
    ['reportDOMVideo', 'video/webm', 'webm']
  ]) {
    for (const networkFirst of [false, true]) {
      const h = backgroundHarness(); await tick();
      const url = 'https://media.test/watch?id=42';
      const dom = () => h.request({ action, url, title: 'Episode', directVideo: action === 'reportDOMVideo' },
        { tab: { id: 1 }, frameId: 0, documentId: 'page' });
      if (networkFirst) { await respondWithMime(h, url, responseMime, 0, 'page'); await dom(); }
      else { await dom(); await respondWithMime(h, url, responseMime, 0, 'page'); }
      const result = await h.request({ action: 'getMedia', tabId: 1 });
      assert.equal(result.media.length, 1);
      const item = result.media[0];
      assert.equal(item.ext, expectedExt, `${action}, networkFirst=${networkFirst}`);
      assert.equal(item.isM3U8, expectedExt === 'm3u8');
      assert.equal(item.mime, responseMime);
      assert.equal(item.suggestedFilename, `Episode.${expectedExt}`);
      assert.equal(item.evidence.responseMime, responseMime);
      assert.equal(item.evidence.domMime, undefined, 'a DOM guess must not masquerade as a type declaration');
    }
  }
});

test('a later declared DOM type or generic response cannot erase a known response type', async () => {
  const h = backgroundHarness(); await tick();
  const url = 'https://media.test/endpoint';
  await respondWithMime(h, url, 'application/vnd.apple.mpegurl');
  await h.request({ action: 'reportDOMVideo', url, directVideo: true, mime: 'video/mp4' }, { tab: { id: 1 }, frameId: 0 });
  await respondWithMime(h, url, 'application/octet-stream');
  const item = (await h.request({ action: 'getMedia', tabId: 1 })).media[0];
  assert.equal(item.isM3U8, true);
  assert.equal(item.evidence.domMime, 'video/mp4');
  assert.equal(item.evidence.responseMime, 'application/vnd.apple.mpegurl');
});

test('a lineData stream hint cannot override an explicit file suffix before a response arrives', async () => {
  const h = backgroundHarness(); await tick();
  for (const ext of ['mp4', 'webm', 'flv']) {
    const url = `https://media.test/movie.${ext}`;
    await h.request({ action: 'reportDOMVideo', url, title: 'Episode', directVideo: false, streamHint: true },
      { tab: { id: 1 }, frameId: 0 });
    const item = (await h.request({ action: 'getMedia', tabId: 1 })).media.find((entry) => entry.url === url);
    assert.equal(item.isM3U8, false, `${ext} must use the native file route`);
    assert.equal(item.ext, ext);
    await respondWithMime(h, url, 'application/vnd.apple.mpegurl');
    const corrected = (await h.request({ action: 'getMedia', tabId: 1 })).media.find((entry) => entry.url === url);
    assert.equal(corrected.isM3U8, true, 'actual manifest MIME remains stronger than the URL suffix');
    assert.equal(corrected.ext, 'm3u8');
  }
});

test('weak part, chunk and hls path hints cannot hide full MP4 resources', async () => {
  const h = backgroundHarness(); await tick();
  const urls = ['https://media.test/part-1.mp4', 'https://media.test/hls/archive/2026/movie.mp4',
    'https://media.test/chunk-01/feature.mp4', 'https://media.test/movie.mp4?caption=subtitles.m3u8'];
  for (const url of urls) await respondWithMime(h, url, 'video/mp4');
  const result = await h.request({ action: 'getMedia', tabId: 1 });
  assert.deepEqual(Array.from(result.media, (item) => item.url), urls);
  assert.ok(result.media.every((item) => !item.isM3U8 && !item.isFragment && item.ext === 'mp4'));
  assert.equal(result.chunkCount, 0);
});

test('TS and m4s stay out of media cards but retain identity for later direct-video evidence', async () => {
  const h = backgroundHarness(); await tick();
  const ts = 'https://media.test/full.ts', m4s = 'https://media.test/segment.m4s';
  await respondWithMime(h, ts, 'video/mp2t');
  await respondWithMime(h, m4s, 'video/mp4');
  await respondWithMime(h, m4s, 'video/mp4');
  const hidden = await h.request({ action: 'getMedia', tabId: 1 });
  assert.equal(hidden.media.length, 0);
  assert.equal(hidden.chunkCount, 2);
  const saved = h.writes.at(-1).neko_tabMedia[0][1];
  const originalId = saved.find((item) => item.url === ts).id;
  assert.equal(saved.length, 2);
  await h.request({ action: 'reportDOMVideo', url: ts, title: 'Whole recording', directVideo: true },
    { tab: { id: 1 }, frameId: 0, documentId: 'player-document' });
  const promoted = await h.request({ action: 'getMedia', tabId: 1 });
  assert.equal(promoted.media.length, 1);
  assert.equal(promoted.media[0].id, originalId);
  assert.equal(promoted.media[0].ext, 'ts');
  assert.equal(promoted.media[0].isFragment, false);
  assert.equal(promoted.chunkCount, 1);
});

test('an HLS target failure never falls through to an unrelated blob player', async () => {
  const h = backgroundHarness(); await tick();
  const url = 'https://media.test/main.m3u8';
  await h.request({ action: 'reportMasterStream', url }, { tab: { id: 1 }, frameId: 7, documentId: 'target-document' });
  for (const [frameId, documentId] of [[7, 'target-document'], [0, 'unrelated-document']]) {
    await h.request({ action: 'reportVideoFrames', videoId: 'video-1', sourceUrl: 'blob:' + documentId, frames: [] },
      { tab: { id: 1 }, frameId, documentId });
  }
  h.respondWith(async (_tab, _message, options) => options.documentId === 'target-document'
    ? { success: false, error: 'Cross-origin picture is not readable' }
    : { success: true, frame: { sourceUrl: 'blob:unrelated-document' } });
  const result = await h.request({ action: 'captureCurrentFrame', tabId: 1, sourceUrl: url });
  assert.equal(result.success, false);
  assert.deepEqual(h.sent.map((item) => item.options.documentId), ['target-document']);
});

test('ambiguous players remain selectable through exact document and video targets', async () => {
  const h = backgroundHarness(); await tick();
  const url = 'https://media.test/main.m3u8';
  await h.request({ action: 'reportMasterStream', url }, { tab: { id: 1 }, frameId: 7, documentId: 'player-document' });
  for (const videoId of ['video-1', 'video-2']) {
    await h.request({ action: 'reportVideoFrames', videoId, sourceUrl: 'blob:' + videoId,
      frames: [{ id: 'capture-' + videoId, timestamp: 1, dataUrl: 'thumbnail' }] },
      { tab: { id: 1 }, frameId: 7, documentId: 'player-document' });
  }
  const ambiguous = await h.request({ action: 'captureCurrentFrame', tabId: 1, sourceUrl: url });
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(h.sent.length, 0);
  const state = await h.request({ action: 'getMedia', tabId: 1 });
  assert.equal(state.media[0].frames.length, 0, 'ambiguous pictures must not be assigned to the source card');
  assert.equal(state.players.length, 2);
  assert.ok(state.players.every((player) => player.frames.length === 1));
  h.respondWith(async (_tab, message) => ({ success: true, frame: { sourceUrl: message.expectedSourceUrl } }));
  const chosen = await h.request({ action: 'captureCurrentFrame', tabId: 1, frameId: 7,
    documentId: 'player-document', videoId: 'video-2', sourceUrl: 'blob:video-2' });
  assert.equal(chosen.success, true);
  assert.equal(h.sent[0].message.videoId, 'video-2');
  assert.equal(h.sent[0].options.documentId, 'player-document');
  for (const invalid of [{ documentId: 'expired-document' }, { frameId: 8 }, { videoId: 'missing-video' }]) {
    const result = await h.request({ action: 'captureCurrentFrame', tabId: 1, frameId: 7,
      documentId: 'player-document', videoId: 'video-2', ...invalid });
    assert.equal(result.success, false);
  }
  assert.equal(h.sent.length, 1, 'invalid explicit identities must never fall back');
});

test('a source association with a known document cannot match a reused frame document', async () => {
  const h = backgroundHarness(); await tick();
  const url = 'https://media.test/main.m3u8';
  h.events.before({ tabId: 1, frameId: 7, url }); await tick();
  await h.request({ action: 'reportMasterStream', url }, { tab: { id: 1 }, frameId: 7, documentId: 'old-document' });
  await h.request({ action: 'reportVideoFrames', videoId: 'video-1', sourceUrl: 'blob:new-player', frames: [] },
    { tab: { id: 1 }, frameId: 7, documentId: 'new-document' });
  const result = await h.request({ action: 'captureCurrentFrame', tabId: 1, sourceUrl: url });
  assert.equal(result.success, false);
  assert.equal(h.sent.length, 0);
});

test('players and originals stay accessible without any downloadable media URL', async () => {
  const h = backgroundHarness(); await tick();
  for (const [videoId, sourceUrl] of [['video-1', 'blob:local'], ['video-2', '']]) {
    await h.request({ action: 'reportVideoFrames', videoId, sourceUrl, width: 1920, height: 1080,
      frames: [{ id: 'capture-' + videoId, dataUrl: 'thumbnail', timestamp: 1 }] },
      { tab: { id: 1 }, frameId: 0, documentId: 'local-document' });
  }
  const state = await h.request({ action: 'getMedia', tabId: 1 });
  assert.equal(state.media.length, 0);
  assert.equal(state.players.length, 2);
  assert.equal(state.players[1].frames[0].id, 'capture-video-2');
  h.respondWith(async (_tab, message, options) => {
    assert.equal(options.documentId, 'local-document');
    return { success: true, frame: { id: message.captureId, originalDataUrl: 'original' } };
  });
  const original = await h.request({ action: 'getCapturedFrame', tabId: 1, captureId: 'capture-video-2' });
  assert.equal(original.success, true);
  assert.equal(original.frame.originalDataUrl, 'original');
  assert.equal(h.sent[0].message.videoId, 'video-2');
});
