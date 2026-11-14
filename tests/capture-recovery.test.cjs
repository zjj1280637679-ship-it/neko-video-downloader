'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const extensionId = 'recovery-fixture';
const extensionUrl = name => `chrome-extension://${extensionId}/${name}`;
const popup = { id: extensionId, url: extensionUrl('popup.html') };
const frame = (documentId = 'current', frameId = 0) => ({ id: extensionId, tab: { id: 7, url: 'https://page.test/watch' },
  frameId, documentId, documentLifecycle: 'active', url: 'https://page.test/watch' });
const report = (extra = {}) => ({ documentToken: 'token-current', documentStartedAt: 100, generation: 1, ...extra });
const confirmed = (documentId = 'current', frameId = 0) => ({ frameId, documentId,
  result: { success: true, documentToken: `token-${documentId}`, generation: 1, reports: 2, failedReports: 0 } });
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });

function fixture({ restore = Promise.resolve({}), execute, getTab, tab = { id: 7, url: 'https://page.test/watch' } } = {}) {
  const calls = [], timers = [], notifications = [];
  let currentTab = tab;
  const chrome = {
    runtime: { id: extensionId, getURL: extensionUrl, onMessage: event(), sendMessage: async message => { notifications.push(message); } },
    storage: { session: { get: () => restore, set: async value => { chrome.saved = value; }, remove: async () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    tabs: { onUpdated: event(), onRemoved: event(), async get(id) {
      if (!currentTab || currentTab.id !== id) throw new Error('No tab');
      const snapshot = { ...currentTab };
      return getTab ? getTab(snapshot) : snapshot;
    } },
    scripting: { async executeScript(options) {
      calls.push(options);
      if (execute) return execute(options, h);
      await h.message(report({ action: 'reportPlaybackState', videoCount: 1, iframeCount: 0, hasPlayed: false }), frame());
      await h.message(report({ action: 'reportDOMVideo', url: 'https://cdn.test/current.mp4' }), frame());
      return [confirmed()];
    } }
  };
  vm.runInContext(source, vm.createContext({ chrome, NekoMedia: require('../domain/media.js'), NekoSites: require('../domain/sites.js'), crypto: webcrypto, URL, console,
    setTimeout(fn, ms) { const timer = { fn, ms, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.active = false; }
  }));
  const h = { chrome, calls, timers, notifications,
    message(message, sender = popup) { return new Promise(resolve => {
      if (chrome.runtime.onMessage.listeners[0](message, sender, resolve) !== true) resolve(undefined);
    }); },
    setTab(value) { currentTab = value; },
    refresh() { return this.message({ action: 'refreshMedia', tabId: 7 }); },
    snapshot() { return this.message({ action: 'getMedia', tabId: 7 }); }
  };
  return h;
}

test('YouTube cold refresh uses browser page identity without media requests or injected scripts', async () => {
  const h = fixture({ tab: { id: 7, url: 'https://www.youtube.com/watch?v=BaW_jenozKc&list=ignored', title: '中文视频 - YouTube' },
    execute: async () => { throw new Error('YouTube discovery does not depend on player injection'); } });
  const result = await h.refresh();
  assert.equal(result.success, true); assert.equal(result.media.length, 1);
  assert.equal(result.media[0].url, 'https://www.youtube.com/watch?v=BaW_jenozKc');
  assert.equal(result.media[0].engine, 'youtube-native'); assert.equal(result.media[0].kind, 'youtube');
  assert.equal(result.media[0].isM3U8, false); assert.equal(result.media[0].suggestedFilename, '中文视频.mp4');
  assert.equal(result.capturePhase, 'found'); assert.equal(h.calls.length, 0);
});

test('YouTube SPA updates replace identity and stale content titles or ranged requests cannot pollute it', async () => {
  const first = { id: 7, url: 'https://www.youtube.com/watch?v=BaW_jenozKc', title: '第一集 - YouTube' };
  const next = { id: 7, url: 'https://www.youtube.com/shorts/aqz-KE-bpKQ', title: '第二集 - YouTube' };
  const h = fixture({ tab: first }); await h.refresh();
  h.setTab(next); h.chrome.tabs.onUpdated.emit(7, { url: next.url, title: next.title }, next);
  await h.message(report({ action: 'reportPageTitle', title: '旧的视频标题' }), { ...frame(), url: first.url, tab: first });
  for (const range of ['0-99', '100-199']) h.chrome.webRequest.onHeadersReceived.emit({ tabId: 7, statusCode: 206,
    frameId: 0, url: `https://rr1.googlevideo.com/videoplayback?itag=137&range=${range}`,
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }] });
  await h.message(report({ action: 'reportDOMVideo', url: 'https://cdn.test/advert.mp4' }), frame());
  const current = await h.snapshot();
  assert.equal(current.media.length, 1); assert.equal(current.media[0].url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.equal(current.media[0].title, '第二集'); assert.equal(current.media[0].suggestedFilename, '第二集.mp4');
  h.chrome.tabs.onUpdated.emit(7, { url: 'https://www.youtube.com/feed/subscriptions' }, { id: 7, url: 'https://www.youtube.com/feed/subscriptions' });
  assert.equal((await h.snapshot()).media.length, 0, 'Leaving the video cannot retain its download candidate');
});

test('cold recovery on a different ordinary page clears a restored YouTube candidate before accepting media', async () => {
  const h = fixture({ restore: Promise.resolve({ neko_tabMedia: [[7, [{ url: 'https://www.youtube.com/watch?v=BaW_jenozKc', engine: 'youtube-native' }]]] }) });
  const result = await h.refresh();
  assert.equal(result.media.length, 1); assert.equal(result.media[0].url, 'https://cdn.test/current.mp4');
});

test('Bilibili cold recovery discovers the current part without playback, navigation or content injection', async () => {
  const h = fixture({ tab: { id: 7, url: 'https://www.bilibili.com/video/BV13x41117TL/?p=2&spm_id_from=share', title: '第二部分_哔哩哔哩_bilibili' },
    restore: Promise.resolve({ neko_tabMedia: [[7, [{ url: 'https://www.bilibili.com/video/BV13x41117TL/?p=1', site: 'bilibili', engine: 'bilibili-native', title: '旧P1' }]]] }),
    execute: async () => { throw new Error('Bilibili discovery does not require a page refresh or player script'); } });
  const result = await h.refresh();
  assert.equal(result.success, true); assert.equal(result.media.length, 1); assert.equal(h.calls.length, 0);
  assert.equal(result.media[0].url, 'https://www.bilibili.com/video/BV13x41117TL/?p=2');
  assert.equal(result.media[0].site, 'bilibili'); assert.equal(result.media[0].engine, 'bilibili-native');
  assert.equal(result.media[0].page, 2); assert.equal(result.media[0].title, '第二部分');
  assert.equal(result.capturePhase, 'found');
});

test('Bilibili SPA part navigation replaces the old identity and rejects old titles and track noise', async () => {
  const first = { id: 7, url: 'https://www.bilibili.com/video/BV13x41117TL/?p=1', title: '第一部分_哔哩哔哩_bilibili' };
  const next = { id: 7, url: 'https://www.bilibili.com/video/BV13x41117TL/?p=3', title: '第三部分_哔哩哔哩_bilibili' };
  const h = fixture({ tab: first }); const initial = await h.refresh();
  h.setTab(next); h.chrome.tabs.onUpdated.emit(7, { url: next.url }, { ...next, title: first.title });
  await h.message(report({ action: 'reportPageTitle', title: first.title }), { ...frame(), url: first.url, tab: first });
  let current = await h.snapshot();
  assert.equal(current.media[0].page, 3); assert.notEqual(current.media[0].id, initial.media[0].id);
  assert.equal(current.media[0].title, 'B站视频', 'A P navigation does not inherit the old page title');
  h.chrome.tabs.onUpdated.emit(7, { title: next.title }, next);
  for (const code of ['30080', '30280']) h.chrome.webRequest.onHeadersReceived.emit({ tabId: 7, frameId: 0, statusCode: 206,
    url: `https://xy.bilivideo.com/upgcxcode/123/123-1-${code}.m4s?range=0-99`,
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }] });
  await h.message(report({ action: 'reportDOMVideo', url: 'https://xy.bilivideo.com/advert.mp4' }), frame());
  current = await h.snapshot();
  assert.equal(current.media.length, 1); assert.equal(current.media[0].title, '第三部分'); assert.equal(current.chunkCount, 0);
  h.chrome.tabs.onUpdated.emit(7, { url: 'https://www.bilibili.com/bangumi/play/ep123' }, { id: 7, url: 'https://www.bilibili.com/bangumi/play/ep123' });
  assert.equal((await h.snapshot()).media.length, 0, 'Unsupported page cannot keep the previous ordinary upload');
});

test('a delayed tab-title sample cannot overwrite a newer authoritative title event', async () => {
  const sampled = deferred(); let hold = false;
  const tab = { id: 7, url: 'https://www.bilibili.com/video/BV13x41117TL/?p=2', title: '旧标题_哔哩哔哩_bilibili' };
  const h = fixture({ tab, getTab: snapshot => hold ? sampled.promise.then(() => snapshot) : snapshot });
  await h.refresh(); hold = true;
  const pending = h.refresh(); await tick();
  const newer = { ...tab, title: '更新后的P2标题_哔哩哔哩_bilibili' };
  h.setTab(newer); h.chrome.tabs.onUpdated.emit(7, { title: newer.title }, newer);
  assert.equal((await h.snapshot()).media[0].title, '更新后的P2标题');
  sampled.resolve();
  assert.equal((await pending).media[0].title, '更新后的P2标题');
  assert.equal((await h.snapshot()).media[0].suggestedFilename, '更新后的P2标题.mp4');
});

test('a refresh cannot reintroduce the previous P title while Chrome metadata is catching up', async () => {
  const first = { id: 7, url: 'https://www.bilibili.com/video/BV13x41117TL/?p=1', title: '第一部分_哔哩哔哩_bilibili' };
  const second = { ...first, url: 'https://www.bilibili.com/zh-Hans/video/BV13x41117TL/?p=2' };
  const h = fixture({ tab: first }); await h.refresh();
  h.setTab(second); h.chrome.tabs.onUpdated.emit(7, { url: second.url }, second);
  assert.equal((await h.snapshot()).media[0].title, 'B站视频');
  const refreshed = await h.refresh();
  assert.equal(refreshed.media[0].page, 2); assert.equal(refreshed.media[0].title, 'B站视频');
  // Persist the uncertainty so suspending the service worker cannot reintroduce P1.
  h.timers.filter(timer => timer.active && timer.ms === 150).at(-1).fn(); await tick();
  const recovered = fixture({ tab: second, restore: Promise.resolve(h.chrome.saved) });
  assert.equal((await recovered.refresh()).media[0].title, 'B站视频');
  recovered.setTab({ ...second, title: '第二部分_哔哩哔哩_bilibili' });
  assert.equal((await recovered.refresh()).media[0].title, '第二部分', 'A changed fresh sample can recover a missed title event');
});

test('a true cold Bilibili P2 page still receives its sampled title without navigation events', async () => {
  const h = fixture({ tab: { id: 7, url: 'https://www.bilibili.com/zh-Hans/video/BV1bK411W797/?p=2', title: '第2部分_哔哩哔哩_bilibili' } });
  const result = await h.refresh();
  assert.equal(result.media[0].title, '第2部分'); assert.equal(result.media[0].page, 2);
  assert.equal(result.media[0].url, 'https://www.bilibili.com/video/BV1bK411W797/?p=2');
  assert.equal(h.calls.length, 0);
});

test('only trusted tab navigation can establish a Bilibili identity and independent CDN MP4s survive', async () => {
  const h = fixture();
  await h.message(report({ action: 'reportDOMVideo', url: 'https://www.bilibili.com/video/BV13x41117TL/?p=8' }), frame());
  assert.equal((await h.snapshot()).media.length, 0, 'Content-reported page URLs do not authorize a native site job');
  h.chrome.webRequest.onHeadersReceived.emit({ tabId: 7, frameId: 0, statusCode: 200, url: 'https://xy.bilivideo.com/ordinary.mp4',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }] });
  const current = await h.snapshot();
  assert.equal(current.media.length, 1); assert.equal(current.media[0].url, 'https://xy.bilivideo.com/ordinary.mp4');
  assert.equal(current.media[0].engine, undefined);
});

test('cold refresh waits for hydration, then accepts content ACKs without holding the capture queue', { timeout: 1500 }, async () => {
  const restored = deferred();
  const h = fixture({ restore: restored.promise });
  const refreshing = h.refresh();
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 7, frameId: 0, type: 'xmlhttprequest', url: 'https://cdn.test/network.m3u8' });
  await tick(); assert.equal(h.calls.length, 0);
  restored.resolve({ neko_tabMedia: [[7, [{ id: 'saved', url: 'https://cdn.test/saved.mp4' }]]] });
  const result = await refreshing;
  assert.equal(result.success, true);
  assert.deepEqual(Array.from(result.media, item => item.url).sort(), [
    'https://cdn.test/current.mp4', 'https://cdn.test/network.m3u8', 'https://cdn.test/saved.mp4'
  ]);
  assert.equal(result.capturePhase, 'found');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ target: { tabId: 7, allFrames: true }, files: ['content.js'] }]);
});

test('production content reinjection reaches the production broker after ordered identity and title acknowledgements', { timeout: 1500 }, async () => {
  const content = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  const sent = []; let observers = 0, context;
  const h = fixture({ execute: async () => [{ frameId: 0, documentId: 'current', result: await vm.runInContext(content, context) }] });
  const selected = { textContent: '第1集', classList: { contains: () => true },
    getAttribute(name) { return name === 'name' ? 'lineData' : name === 'udata' ? 'https://cdn.test/episode.m3u8' : null; } };
  const document = { title: '恢复影片', URL: 'https://page.test/watch', baseURI: 'https://page.test/watch', documentElement: {},
    querySelectorAll(selector) { return selector === '[udata], [data-url]' ? [selected] : []; } };
  const window = { addEventListener() {}, removeEventListener() {} }; window.top = window;
  context = vm.createContext({ document, window, URL, crypto: webcrypto, performance: { timeOrigin: 100 }, setTimeout, clearTimeout,
    chrome: { runtime: { id: extensionId, async sendMessage(message) { sent.push(message.action); return h.message(message, frame()); } } },
    MutationObserver: class { constructor() { observers++; } observe() {} disconnect() {} }
  });
  const first = await h.refresh();
  assert.equal(first.success, true);
  assert.equal(first.media[0].suggestedFilename, '恢复影片_第1集.m3u8');
  assert.deepEqual(sent, ['reportPlaybackState', 'reportPageTitle', 'reportMasterStream']);
  assert.equal((await h.refresh()).success, true);
  assert.equal(observers, 1, 'Reinjection reuses the content singleton');
  assert.equal((await h.snapshot()).media.length, 1);
  assert.equal(sent.length, 6, 'A manual rescan reports again after prior acknowledgements');
});

test('overlapping refresh requests coalesce while getMedia remains a noninjecting read', { timeout: 1500 }, async () => {
  const injection = deferred();
  const h = fixture({ execute: async () => { await injection.promise; return [confirmed()]; } });
  const first = h.refresh(), second = h.refresh();
  await tick(); assert.equal(h.calls.length, 1);
  assert.equal((await h.snapshot()).media.length, 0);
  assert.equal((await h.snapshot()).media.length, 0);
  assert.equal(h.calls.length, 1);
  injection.resolve();
  assert.equal((await first).success, true); assert.equal((await second).success, true);
  assert.equal((await h.refresh()).success, true); assert.equal(h.calls.length, 2);
});

test('only the extension popup can refresh a valid tab; protected, missing and discarded pages never inject', async () => {
  const h = fixture();
  for (const sender of [frame(), {}, { ...popup, id: 'another-extension' }, { ...popup, url: extensionUrl('offscreen.html') }]) {
    assert.equal((await h.message({ action: 'refreshMedia', tabId: 7 }, sender)).success, false);
  }
  for (const tabId of [-1, 1.2, '7', null, undefined]) {
    assert.equal((await h.message({ action: 'refreshMedia', tabId })).success, false);
  }
  for (const tab of [null, { id: 7, url: 'chrome://extensions/' }, { id: 7, url: 'file:///video.html' },
    { id: 7, url: 'https://page.test/watch', discarded: true }]) {
    h.setTab(tab); assert.equal((await h.refresh()).success, false);
  }
  assert.equal(h.calls.length, 0);
});

test('a blocked child-frame injection retries the main frame and retains network evidence', async () => {
  const h = fixture({ execute: async (options, instance) => {
    if (options.target.allFrames) throw new Error('Cannot access child frame');
    await instance.message(report({ action: 'reportDOMVideo', url: 'https://cdn.test/main.mp4' }), frame());
    return [confirmed()];
  } });
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 7, frameId: 4, type: 'xmlhttprequest', url: 'https://cdn.test/network.m3u8' });
  const result = await h.refresh();
  assert.equal(result.success, true); assert.match(result.recoveryWarning, /部分/);
  assert.equal(result.media.length, 2);
  assert.deepEqual(Array.from(h.calls[1].target.frameIds), [0]);
});

test('permission failures and unconfirmed old scripts are truthful, preserve sources and remain retryable', async () => {
  let mode = 'denied';
  const h = fixture({ execute: async () => {
    if (mode === 'denied') throw new Error('Missing host permission');
    return mode === 'old' ? [{ frameId: 0 }] : [confirmed()];
  } });
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 7, frameId: 0, type: 'xmlhttprequest', url: 'https://cdn.test/network.m3u8' });
  assert.match((await h.refresh()).error, /访问权限/);
  assert.equal((await h.snapshot()).media.length, 1);
  mode = 'old'; assert.match((await h.refresh()).error, /未确认/);
  mode = 'ok'; assert.equal((await h.refresh()).success, true);
  assert.equal((await h.snapshot()).media.length, 1);
});

test('navigation invalidates a pending refresh without sharing it with the new document or clearing new sources', { timeout: 1500 }, async () => {
  const oldInjection = deferred(); let attempts = 0;
  const h = fixture({ execute: async () => ++attempts === 1 ? oldInjection.promise : [confirmed('new')] });
  await h.message(report({ action: 'reportPlaybackState', videoCount: 1, hasPlayed: false }), frame());
  const previous = h.refresh(); await tick();
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 7, frameId: 0, type: 'main_frame', url: 'https://page.test/next' });
  h.setTab({ id: 7, url: 'https://page.test/next' });
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 7, frameId: 0, documentId: 'new', type: 'xmlhttprequest', url: 'https://cdn.test/new.m3u8' });
  const current = await h.refresh();
  assert.equal(current.success, true); assert.equal(h.calls.length, 2);
  assert.equal((await h.message(report({ action: 'reportDOMVideo', url: 'https://cdn.test/stale.mp4' }), frame())).status, 'ignored');
  oldInjection.resolve([confirmed()]);
  assert.match((await previous).error, /网页已变化/);
  assert.deepEqual(Array.from((await h.snapshot()).media, item => item.url), ['https://cdn.test/new.m3u8']);
});

test('nonactive document reports are ignored and a closed tab cannot finish a successful refresh', { timeout: 1500 }, async () => {
  const injection = deferred();
  const h = fixture({ execute: async () => injection.promise });
  const ignored = await h.message(report({ action: 'reportDOMVideo', url: 'https://cdn.test/old.mp4' }), { ...frame(), documentLifecycle: 'pending_deletion' });
  assert.equal(ignored.status, 'ignored');
  const pending = h.refresh(); await tick();
  h.setTab(null); h.chrome.tabs.onRemoved.emit(7);
  injection.resolve([confirmed()]);
  assert.equal((await pending).success, false);
  assert.equal((await h.snapshot()).media.length, 0);
});

test('invalidated injection results retire only proven old documents and preserve a shared URL in the new document', { timeout: 1500 }, async () => {
  const injection = deferred();
  const h = fixture({ execute: async () => injection.promise });
  await h.message(report({ action: 'reportPlaybackState', videoCount: 1 }), frame());
  const pending = h.refresh(); await tick();
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 7, frameId: 0, type: 'main_frame', url: 'https://page.test/new' });
  h.setTab({ id: 7, url: 'https://page.test/new' });
  // A newly injected token can first arrive after navigation retired the old
  // token. The injection result later identifies this browser document exactly.
  const staleReport = extra => report({ documentToken: 'token-rescan', ...extra });
  await h.message(staleReport({ action: 'reportDOMVideo', url: 'https://cdn.test/old.mp4' }), frame());
  await h.message(staleReport({ action: 'reportDOMVideo', url: 'https://cdn.test/shared.mp4' }), frame());
  await h.message(report({ documentToken: 'token-new', action: 'reportDOMVideo', url: 'https://cdn.test/shared.mp4' }), frame('new'));
  const result = confirmed(); result.result.documentToken = 'token-rescan'; injection.resolve([result]);
  assert.equal((await pending).success, false);
  const snapshot = await h.snapshot();
  assert.deepEqual(Array.from(snapshot.media, item => item.url), ['https://cdn.test/shared.mp4']);
  assert.deepEqual(Array.from(snapshot.media[0].contexts, context => context.documentId), ['new']);
  assert.equal((await h.message(staleReport({ action: 'reportDOMVideo', url: 'https://cdn.test/late.mp4' }), frame())).status, 'ignored');
});

test('a delayed injection that lands in the new document must not retire its fresh evidence', { timeout: 1500 }, async () => {
  const injection = deferred();
  const h = fixture({ execute: async () => injection.promise });
  await h.message(report({ action: 'reportPlaybackState', videoCount: 1 }), frame());
  const pending = h.refresh(); await tick();
  h.chrome.webRequest.onBeforeRequest.emit({ tabId: 7, frameId: 0, type: 'main_frame', url: 'https://page.test/new' });
  h.setTab({ id: 7, url: 'https://page.test/new' });
  await h.message(report({ documentToken: 'token-new', action: 'reportDOMVideo', url: 'https://cdn.test/new.mp4' }), frame('new'));
  injection.resolve([confirmed('new')]);
  assert.equal((await pending).success, false);
  assert.deepEqual(Array.from((await h.snapshot()).media, item => item.url), ['https://cdn.test/new.mp4']);
  assert.equal((await h.message(report({ documentToken: 'token-new', action: 'reportDOMVideo', url: 'https://cdn.test/new.mp4' }), frame('new'))).status, 'ok');
});

test('a bounded scan timeout releases coalescing so an explicit retry can succeed', { timeout: 1500 }, async () => {
  const stalled = deferred(); let attempts = 0;
  const h = fixture({ execute: async () => ++attempts === 1 ? stalled.promise : [confirmed()] });
  const first = h.refresh(); await tick();
  h.timers.find(timer => timer.active && timer.ms === 10000).fn();
  assert.match((await first).error, /超时/);
  assert.equal((await h.refresh()).success, true);
  stalled.resolve([confirmed()]); await tick();
  assert.equal(h.calls.length, 2);
});
