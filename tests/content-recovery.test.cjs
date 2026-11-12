const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, value = {}) { for (const fn of listeners.get(name) || []) fn({ type: name, isTrusted: true, ...value }); }
  };
}
function makeVideo() {
  return { ...eventTarget(), nodeType: 1, src: 'blob:https://page.test/player', currentSrc: 'blob:https://page.test/player',
    paused: true, ended: false, readyState: 2, played: { length: 0 }, currentTime: 0,
    querySelectorAll() { return []; }, matches(selector) { return selector.includes('video'); }, querySelector() { return null; }
  };
}
function makeRoute(url, active = true) {
  return { url, active, textContent: '第1集', nodeType: 1,
    getAttribute(name) { return name === 'udata' ? this.url : name === 'name' ? 'lineData' : null; },
    matches(selector) { return selector.includes('[udata]'); }, querySelector() { return null; },
    get classList() { return { contains: () => this.active }; }
  };
}
function harness({ deferred = false, response = { status: 'ok' }, videos = [makeVideo()], routes = [makeRoute('https://cdn.test/one.m3u8')] } = {}) {
  const sent = [], pending = [], observers = [], timers = new Map();
  const state = { deferred, response, now: 100000, error: null };
  let nextTimer = 0, nextToken = 0;
  const window = eventTarget(); window.top = window;
  const document = {
    title: '影片标题', URL: 'https://page.test/watch', baseURI: 'https://page.test/watch', documentElement: {},
    querySelectorAll(selector) { return selector === 'video' ? videos : selector === '[udata], [data-url]' ? routes : []; }
  };
  class Clock extends Date { static now() { return state.now; } }
  const context = vm.createContext({ document, window, URL, Date: Clock, performance: { timeOrigin: 50000 },
    crypto: { randomUUID: () => `document-${++nextToken}` },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: { sendMessage(message) {
      sent.push(structuredClone(message));
      if (state.error) return Promise.reject(state.error);
      if (!state.deferred) return Promise.resolve(state.response);
      return new Promise((resolve, reject) => pending.push({ message, resolve, reject, done: false }));
    } } },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    }
  });
  return {
    state, context, document, window, videos, routes, sent, pending, observers, timers,
    run(code = source) { return vm.runInContext(code, context); },
    async reply(index, value = { status: 'ok' }, reject = false) { const item = pending[index]; assert.ok(item && !item.done); item.done = true; item[reject ? 'reject' : 'resolve'](value); await tick(); },
    async drainReplies(value = { status: 'ok' }) { for (let index = 0; index < pending.length; index++) if (!pending[index].done) { pending[index].done = true; pending[index].resolve(value); await tick(); } },
    async fireTimers(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } await tick(); },
    async mutate(target = routes[0]) { for (const observer of observers) if (observer.connected) observer.fn([{ type: 'attributes', attributeName: 'udata', target }]); await this.fireTimers(200); }
  };
}

test('cold injection waits for identity and title ACKs, then reports independent selected sources in parallel', async () => {
  const h = harness({ deferred: true, routes: [makeRoute('https://cdn.test/one.m3u8'), makeRoute('https://cdn.test/two.m3u8'), makeRoute('https://cdn.test/inactive.m3u8', false)] });
  let finished = false; const initial = h.run().then(result => { finished = true; return result; });
  assert.deepEqual(h.sent.map(item => item.action), ['reportPlaybackState']);
  await h.reply(0);
  assert.deepEqual(h.sent.map(item => item.action), ['reportPlaybackState', 'reportPageTitle']);
  await h.reply(1);
  assert.deepEqual(h.sent.filter(item => item.url).map(item => item.url), ['https://cdn.test/one.m3u8', 'https://cdn.test/two.m3u8']);
  assert.equal(finished, false);
  assert.equal(h.sent[0].hasPlayed, false, 'A selected playlist and paused blob video do not imply playback');
  await h.reply(2); assert.equal(finished, false);
  await h.reply(3); const result = await initial;
  assert.equal(result.success, true); assert.equal(result.reports, 4); assert.equal(result.failedReports, 0);
  assert.ok(h.sent.every(item => item.documentToken === result.documentToken && item.generation === result.generation));
  assert.equal(h.sent[0].documentStartedAt, 100000, 'Fresh activation is newer than the document performance origin');
  assert.equal(h.timers.size, 0);
});

test('reinjection force-reports acknowledged DOM state without duplicate observers, listeners, or generation changes', async () => {
  const h = harness(); const first = await h.run(); const scanner = h.context.__yangmoContentScanner;
  assert.equal(Object.keys(h.context).includes('__yangmoContentScanner'), false);
  assert.equal(h.sent.length, 3);
  await h.mutate(); assert.equal(h.sent.length, 3, 'Ordinary unchanged DOM mutations remain deduplicated');
  const second = await h.run();
  assert.equal(h.context.__yangmoContentScanner, scanner); assert.equal(h.sent.length, 6);
  assert.equal(first.documentToken, second.documentToken); assert.equal(first.generation, second.generation);
  assert.equal(h.observers.length, 1); assert.equal(h.window.listeners.get('pagehide').size, 1); assert.equal(h.window.listeners.get('pageshow').size, 1);
  assert.ok([...h.videos[0].listeners.values()].every(handlers => handlers.size === 1));
  assert.equal(h.timers.size, 0);
});

test('concurrent reinjections share pending reports and complete only after the same media ACK', async () => {
  const h = harness({ deferred: true }); const first = h.run(), second = h.run();
  assert.equal(h.sent.length, 1);
  await h.drainReplies();
  assert.equal((await first).success, true); assert.equal((await second).success, true);
  assert.equal(h.sent.length, 3); assert.equal(h.observers.length, 1);
});

test('undefined, ignored, rejected and explicitly failed ACKs never suppress a later recovery', async () => {
  for (const mode of ['undefined', 'ignored', 'failed', 'rejected']) {
    const h = harness();
    h.state.response = mode === 'undefined' ? undefined : mode === 'ignored' ? { status: 'ignored' } : { success: false, error: '暂不可用' };
    if (mode === 'rejected') h.state.error = new Error('Receiving end does not exist');
    const first = await h.run();
    assert.equal(first.success, false, mode); assert.equal(first.failedReports, 1);
    assert.equal(h.sent.some(item => item.url), false, 'Unacknowledged identity blocks dependent URLs');
    h.state.response = { status: 'ok' }; h.state.error = null;
    await h.mutate();
    assert.equal(h.sent.filter(item => item.action === 'reportPlaybackState').length, 2, mode);
    assert.equal(h.sent.filter(item => item.url).length, 1, mode);
    const count = h.sent.length; await h.mutate(); assert.equal(h.sent.length, count, mode);
  }
});

test('failed title and URL reports are retried without treating earlier metadata acceptance as full success', async () => {
  const h = harness({ deferred: true }); const initial = h.run();
  await h.reply(0); await h.reply(1, { status: 'ignored' });
  assert.equal((await initial).success, false); assert.equal(h.sent.some(item => item.url), false);
  await h.mutate(); assert.equal(h.pending[2].message.action, 'reportPageTitle');
  await h.reply(2); assert.equal(h.pending[3].message.action, 'reportMasterStream');
  await h.reply(3, { success: false });
  await h.mutate(); assert.equal(h.pending[4].message.action, 'reportMasterStream');
  await h.reply(4); const count = h.sent.length;
  await h.mutate(); assert.equal(h.sent.length, count);
});

test('a source change during the metadata barrier prevents sending old URLs with the new generation', async () => {
  const h = harness({ deferred: true }); const old = h.run(); const oldGeneration = h.sent[0].generation;
  h.routes[0].url = 'https://cdn.test/new.m3u8'; h.document.title = '新标题';
  await h.mutate();
  assert.equal((await old).success, false);
  await h.reply(0); // Late acceptance from the retired local generation.
  assert.equal(h.sent.some(item => item.url), false);
  assert.ok(h.pending[1].message.generation > oldGeneration);
  await h.reply(1); await h.reply(2); await h.reply(3, { status: 'ignored' });
  assert.deepEqual(h.sent.filter(item => item.url).map(item => item.url), ['https://cdn.test/new.m3u8']);
  await h.mutate();
  assert.equal(h.pending[4].message.url, 'https://cdn.test/new.m3u8', 'A stale success cannot memoize a rejected new source');
  await h.reply(4);
  assert.ok(h.sent.filter(item => item.url).every(item => item.generation > oldGeneration && item.title === '新标题'));
});

test('pagehide aborts outstanding scans and reinjection stays inactive until BFCache reactivation', async () => {
  const h = harness({ deferred: true }); const first = h.run(); const token = h.sent[0].documentToken;
  h.window.emit('pagehide');
  assert.equal((await first).success, false);
  const count = h.sent.length, hidden = await h.run();
  assert.equal(hidden.success, false); assert.equal(hidden.inactive, true); assert.equal(h.sent.length, count);
  assert.equal(h.observers[0].connected, false);
  h.state.now += 1000; h.window.emit('pageshow', { persisted: true });
  const restored = h.run(); await h.drainReplies(); const result = await restored;
  assert.equal(result.success, true); assert.notEqual(result.documentToken, token);
  assert.equal(h.sent.at(-1).documentStartedAt, 101000);
  assert.equal(h.observers.length, 1); assert.equal(h.observers[0].connected, true); assert.equal(h.timers.size, 0);
});

test('lost ACKs have one finite deadline, and a later manual recovery can resend', async () => {
  const h = harness({ deferred: true }); const initial = h.run();
  await h.fireTimers(4000); const result = await initial;
  assert.equal(result.success, false); assert.equal(result.failedReports, 1); assert.equal(h.timers.size, 0);
  const count = h.sent.length; await tick(); assert.equal(h.sent.length, count, 'No polling or endless automatic probes');
  h.state.deferred = false;
  assert.equal((await h.run()).success, true); assert.equal(h.sent.filter(item => item.url).length, 1);
  await h.reply(0); const afterLate = h.sent.length; await h.mutate(); assert.equal(h.sent.length, afterLate);
});

test('an incompatible owned scanner is disposed and replaced without retaining old video or window listeners', async () => {
  const h = harness(); await h.run(); const previous = h.context.__yangmoContentScanner;
  const result = await h.run(source.replace('version = 1', 'version = 2'));
  assert.equal(result.success, true); assert.notEqual(h.context.__yangmoContentScanner, previous);
  assert.equal((await previous.forceRescan()).success, false);
  assert.equal(h.observers.filter(observer => observer.connected).length, 1);
  assert.ok([...h.window.listeners.values()].every(listeners => listeners.size === 1));
  assert.ok([...h.videos[0].listeners.values()].every(listeners => listeners.size === 1));
});

test('an invalidated same-version closure is replaced once and removed videos release their event listeners', async () => {
  const h = harness(); let disposed = 0;
  Object.defineProperty(h.context, '__yangmoContentScanner', { configurable: true, value: {
    owner: 'yangmo-content', version: 1, document: h.document,
    forceRescan: async () => ({ success: false, invalidated: true }), dispose() { disposed++; }
  } });
  assert.equal((await h.run()).success, true); assert.equal(disposed, 1);
  const video = h.videos.pop(); await h.run();
  assert.ok([...video.listeners.values()].every(listeners => listeners.size === 0));
  const count = h.sent.length; video.emit('playing'); await tick(); assert.equal(h.sent.length, count);
});
