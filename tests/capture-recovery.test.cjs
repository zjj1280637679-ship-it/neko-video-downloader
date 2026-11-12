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

function fixture({ restore = Promise.resolve({}), execute, tab = { id: 7, url: 'https://page.test/watch' } } = {}) {
  const calls = [], timers = [], notifications = [];
  let currentTab = tab;
  const chrome = {
    runtime: { id: extensionId, getURL: extensionUrl, onMessage: event(), sendMessage: async message => { notifications.push(message); } },
    storage: { session: { get: () => restore, set: async () => {}, remove: async () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    tabs: { onUpdated: event(), onRemoved: event(), async get(id) {
      if (!currentTab || currentTab.id !== id) throw new Error('No tab'); return { ...currentTab };
    } },
    scripting: { async executeScript(options) {
      calls.push(options);
      if (execute) return execute(options, h);
      await h.message(report({ action: 'reportPlaybackState', videoCount: 1, iframeCount: 0, hasPlayed: false }), frame());
      await h.message(report({ action: 'reportDOMVideo', url: 'https://cdn.test/current.mp4' }), frame());
      return [confirmed()];
    } }
  };
  vm.runInContext(source, vm.createContext({ chrome, NekoMedia: require('../domain/media.js'), crypto: webcrypto, URL, console,
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
