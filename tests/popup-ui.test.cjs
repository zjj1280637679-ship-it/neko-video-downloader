const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../popup.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../popup.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

// A small DOM double exercises extension messages and state transitions without
// opening a browser or downloading network content.
async function setup(options = {}) {
  let ready, poll;
  const elements = new Map(), messages = [], downloadCalls = [], runtimeListeners = new Set(), pendingActions = new Map(), windowListeners = new Map(), documentListeners = new Map();
  const timers = { intervals: 0, timeouts: 0 };
  const state = {
    media: options.media || [], jobs: options.jobs || [],
    settings: options.settings || { concurrency: 64 }, deferJobs: Boolean(options.deferInitialJobs), deferMedia: false, recoveryError: options.recoveryError || null,
    settingsError: null, getSettingsError: options.getSettingsError || null, liveApplied: options.liveApplied, liveWarning: options.liveWarning, nextJob: 1, now: 1000,
    capturePhase: options.capturePhase || (options.media?.length ? 'found' : 'checking'), playback: options.playback || {}, chunkCount: 0
  };
  const document = { hidden: false, activeElement: null, addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready = fn; else documentListeners.set(name, fn); }, getElementById(id) { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); } };
  class Element {
    constructor(tag, id = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.className = ''; this.checked = false; this.parentElement = null;
      const classes = new Set(); this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
    }
    get isConnected() { return this.tagName === 'HTML' || Boolean(this.parentElement?.isConnected); }
    get disabled() { return this._disabled; }
    set disabled(value) { this._disabled = Boolean(value); if (value && options.blurDisabledFocus && document.activeElement === this) document.activeElement = document.body; }
    contains(element) { for (let current = element; current; current = current.parentElement) if (current === this) return true; return false; }
    get previousElementSibling() { if (!this.parentElement) return null; return this.parentElement.children[this.parentElement.children.indexOf(this) - 1] || null; }
    append(...children) { for (const child of children) { child.remove(); this.children.push(child); child.parentElement = this; } }
    prepend(child) { child.remove(); this.children.unshift(child); child.parentElement = this; }
    after(child) { const parent = this.parentElement; child.remove(); parent.children.splice(parent.children.indexOf(this) + 1, 0, child); child.parentElement = parent; }
    remove() { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; } }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    focus() { document.activeElement = this; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const matches = [];
      for (const child of this.children) {
        if (selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) matches.push(child);
        if (selector.includes(':not([disabled])') && ['BUTTON', 'INPUT', 'SELECT'].includes(child.tagName) && !child.disabled) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }
  }
  const stack = [], voidTags = new Set(['meta', 'link', 'input', 'img', 'br']);
  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)\b([^>]*)>/gi)) {
    const [, closing, tag, attrs] = match;
    if (closing) { while (stack.length && stack.pop().tagName !== tag.toUpperCase()) {} continue; }
    const id = attrs.match(/\bid="([^"]+)"/)?.[1] || '';
    const element = new Element(tag, id);
    element.hidden = /(?:^|\s)hidden(?:\s|$)/.test(attrs); element.disabled = /(?:^|\s)disabled(?:\s|$)/.test(attrs);
    element.className = attrs.match(/\bclass="([^"]+)"/)?.[1] || '';
    for (const attribute of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    if (id) elements.set(id, element);
    if (tag === 'body') document.body = element;
    if (tag === 'html') document.documentElement = element;
    if (stack.length) stack[stack.length - 1].append(element);
    if (!voidTags.has(tag)) stack.push(element);
  }
  document.createElement = tag => new Element(tag);
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { runtimeListeners.add(fn); }, removeListener(fn) { runtimeListeners.delete(fn); } },
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        switch (message.action) {
          case 'getMedia': case 'refreshMedia': {
            const error = message.action === 'refreshMedia' ? state.recoveryError || state.mediaError : state.mediaError;
            const snapshot = structuredClone(error ? { success: false, error } : { media: state.media, capturePhase: state.capturePhase, playback: state.playback, chunkCount: state.chunkCount });
            if (!state.deferMedia) return callback(snapshot);
            const waiting = pendingActions.get(message.action) || []; waiting.push(() => callback(snapshot)); pendingActions.set(message.action, waiting); return;
          }
          case 'getJobs': {
            const snapshot = structuredClone({ success: true, jobs: state.jobs });
            if (!state.deferJobs) return callback(snapshot);
            const waiting = pendingActions.get('getJobs') || []; waiting.push(() => callback(snapshot)); pendingActions.set('getJobs', waiting); return;
          }
          case 'getSettings': {
            const finish = () => callback(state.getSettingsError ? { success: false, error: state.getSettingsError } : { success: true, settings: state.settings });
            if (!options.deferredActions?.includes('getSettings')) return finish();
            pendingActions.set('getSettings', finish); return;
          }
          case 'saveSettings': {
            const finish = () => {
              if (state.settingsError) return callback({ success: false, error: state.settingsError });
              state.settings = message.settings; return callback({ success: true, settings: state.settings, liveApplied: state.liveApplied, warning: state.liveWarning });
            };
            if (options.deferredActions?.includes('saveSettings')) {
              const waiting = pendingActions.get('saveSettings') || []; waiting.push(finish); pendingActions.set('saveSettings', waiting);
            }
            else finish();
            return;
          }
          case 'startDownload': {
            const job = { ...message, id: `job-${state.nextJob++}`, state: 'queued', bytesReceived: 0 };
            state.jobs.unshift(job); return callback({ success: true, job });
          }
          case 'cancelJob': case 'retryJob': case 'discardJob': case 'removeJob': {
            const finish = () => {
              if (options.actionErrors?.[message.action]) return callback({ success: false, error: options.actionErrors[message.action] });
              const job = state.jobs.find(job => job.id === message.jobId);
              if (message.action === 'removeJob') {
                state.jobs = state.jobs.filter(item => item.id !== message.jobId); return callback({ success: true, jobId: message.jobId });
              }
              if (message.action === 'retryJob') Object.assign(job, { state: 'queued', error: '', retryAttempt: 0, retryMessage: '', cancelRequested: false });
              else if (message.action === 'cancelJob') Object.assign(job, { cancelRequested: true, ...(options.cancelPending ? {} : { state: 'cancelled' }) });
              else Object.assign(job, { resumable: false, cachedSegments: 0 });
              callback({ success: true, job });
            };
            if (options.deferredActions?.includes(message.action)) pendingActions.set(message.action, finish);
            else finish();
            return;
          }
          case 'showJob': return callback({ success: true });
          default: throw new Error(`Unexpected message ${message.action}`);
        }
      }
    },
    tabs: { async query() { return [{ id: 7, title: '测试视频', url: options.tabUrl || 'https://video.test/watch' }]; }, create() { throw new Error('Popup must never open a download page'); } },
    downloads: { async download(value) { downloadCalls.push(value); return 42; } }
  };
  class Clock extends Date { static now() { return state.now; } }
  const context = vm.createContext({ document, chrome, window: { addEventListener(name, fn) { windowListeners.set(name, fn); } }, navigator: { clipboard: { async writeText() {} } }, URL, URLSearchParams, Date: Clock, console, queueMicrotask, setTimeout() { timers.timeouts++; return 1; }, clearTimeout() {}, setInterval(fn, duration) { timers.intervals++; assert.equal(duration, 2000); poll = fn; return 2; }, clearInterval() {} });
  for (const name of ["format", "explain", "capture"]) vm.runInContext(fs.readFileSync(require.resolve(`../ui/${name}.js`), "utf8"), context);
  vm.runInContext(source, context); const initialized = ready();
  if (!options.leaveInitializationPending) await initialized;
  await tick();
  return {
    elements, messages, downloadCalls, state, document, timers, initialized,
    async visibility(hidden) { document.hidden = hidden; documentListeners.get('visibilitychange')?.(); await tick(); },
    async finishAction(action) {
      const pending = pendingActions.get(action);
      if (Array.isArray(pending)) { pending.shift()(); if (!pending.length) pendingActions.delete(action); }
      else { pending(); pendingActions.delete(action); }
      await tick();
    },
    close() { windowListeners.get('unload')?.(); },
    async click(element) { await (typeof element === 'string' ? elements.get(element) : element).listeners.click?.({ target: element }); await tick(); },
    async change(id, value) { const element = elements.get(id); element.value = value; await element.listeners.change?.({ target: element }); await tick(); },
    async input(id, value) { const element = elements.get(id); element.value = value; await element.listeners.input?.({ target: element }); await tick(); },
    async blur(id) { await elements.get(id).listeners.blur?.(); await tick(); },
    async check(id, value) { const element = elements.get(id); element.checked = value; await element.listeners.change?.({ target: element }); await tick(); },
    async updateJobs() { for (const listener of runtimeListeners) listener({ action: 'jobsUpdated' }); await tick(); },
    async runtimeMessage(message) { for (const listener of runtimeListeners) listener(message); await tick(); },
    async updateMedia() { for (const listener of runtimeListeners) listener({ action: 'mediaListUpdated', tabId: 7 }); await tick(); },
    async advance(ms) { state.now += ms; poll(); await tick(); }
  };
}
const media = (isM3U8 = true) => ({ url: `https://cdn.test/video.${isM3U8 ? 'm3u8' : 'mp4'}`, suggestedFilename: `fixture.${isM3U8 ? 'm3u8' : 'mp4'}`, isM3U8, ext: isM3U8 ? 'm3u8' : 'mp4' });

test('both HLS and direct video start background jobs without opening a page', async () => {
  for (const isM3U8 of [true, false]) {
    const ui = await setup({ media: [media(isM3U8)] });
    await ui.click(ui.elements.get('mediaList').querySelector('.btn-primary'));
    const request = ui.messages.find(message => message.action === 'startDownload');
    assert.equal(request.isM3U8, isM3U8); assert.equal(request.tabId, 7);
    assert.equal(ui.elements.get('jobsPanel').hidden, false);
    assert.equal(ui.elements.get('sourcePanel').hidden, true);
    assert.equal(ui.downloadCalls.length, 0);
    assert.equal(ui.elements.get('jobList').querySelector('.job-state').textContent, '等待下载');
  }
});

test('reopened popup restores global jobs even on a Chrome internal tab', async () => {
  const ui = await setup({ tabUrl: 'chrome://newtab', jobs: [{ id: 'existing', filename: '收藏/a.ts', url: media().url, isM3U8: true, state: 'downloading', completedSegments: 4, totalSegments: 10, bytesReceived: 4096, tabId: 99 }] });
  assert.equal(ui.elements.get('jobsPanel').hidden, false);
  const card = ui.elements.get('jobList').querySelector('.job-card');
  assert.equal(card.querySelector('.job-title').textContent, 'a.ts');
  const cancel = card.querySelector('.job-button'); cancel.focus();
  ui.state.jobs[0].completedSegments = 8; await ui.updateJobs();
  assert.equal(ui.elements.get('jobList').querySelector('.job-card'), card, 'Retain the same DOM card');
  assert.equal(ui.document.activeElement, cancel, 'Polling must not discard focus');
  assert.equal(card.querySelector('.job-percent').textContent, '80%');
  await ui.click(cancel);
  assert.equal(ui.messages.at(-2)?.action === 'cancelJob' || ui.messages.some(message => message.action === 'cancelJob' && message.jobId === 'existing'), true);
  assert.equal(card.querySelector('.job-state').textContent, '已取消');
});

test('opening scans the page while jobs and preferences are blocked, without overriding the selected tab later', async () => {
  const ui = await setup({ media: [media()], deferInitialJobs: true, deferredActions: ['getSettings'], leaveInitializationPending: true,
    jobs: [{ id: 'active', state: 'downloading', isM3U8: true }] });
  assert.equal(ui.messages.filter(message => message.action === 'refreshMedia').length, 1);
  assert.equal(ui.elements.get('mediaList').querySelectorAll('.media-card').length, 1, 'Independent source scan does not wait on downloads/settings');
  assert.equal(ui.elements.get('concurrency').disabled, true, 'Unloaded settings remain protected');
  await ui.click('sourceTab');
  await ui.finishAction('getJobs'); await ui.finishAction('getSettings'); await ui.initialized;
  assert.equal(ui.elements.get('sourcePanel').hidden, false, 'Late jobs do not steal the user-selected tab');
  assert.equal(ui.elements.get('concurrency').disabled, false);
});

test('manual rescan queued behind a read is retained, and routine polls never inject the page again', async () => {
  const ui = await setup();
  assert.equal(ui.messages.filter(message => message.action === 'refreshMedia').length, 1);
  ui.state.deferMedia = true;
  await ui.updateMedia();
  await ui.click('btnRefresh');
  assert.equal(ui.messages.filter(message => message.action === 'refreshMedia').length, 1, 'Rescan waits for the older read');
  ui.state.media = [media()]; ui.state.capturePhase = 'found';
  ui.state.deferMedia = false; await ui.finishAction('getMedia');
  assert.equal(ui.messages.filter(message => message.action === 'refreshMedia').length, 2, 'Busy reads cannot swallow manual recovery');
  assert.equal(ui.elements.get('mediaList').querySelectorAll('.media-card').length, 1);
  await ui.advance(2000); await ui.advance(2000);
  assert.equal(ui.messages.filter(message => message.action === 'refreshMedia').length, 2);
  assert.equal(ui.elements.get('btnRefresh').disabled, false);
});

test('failed recovery remains retryable instead of a passive empty poll falsely reporting recovery', async () => {
  const ui = await setup({ recoveryError: '页面连接暂时失败' });
  assert.match(ui.elements.get('statusText').textContent, /读取失败/);
  await ui.advance(2000);
  assert.match(ui.elements.get('statusText').textContent, /读取失败/);
  ui.state.recoveryError = null; ui.state.media = [media()]; ui.state.capturePhase = 'found';
  await ui.click('btnRefresh');
  assert.equal(ui.elements.get('mediaList').querySelectorAll('.media-card').length, 1);
  assert.equal(ui.elements.get('btnRefresh').disabled, false);
  assert.equal(ui.downloadCalls.length, 0);
});

test('100 percent while saving never reports saved or exposes a file action', async () => {
  const ui = await setup({ jobs: [{ id: 'save', url: media().url, filename: 'a.ts', state: 'saving', completedSegments: 10, totalSegments: 10, bytesReceived: 1024 }] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  assert.equal(ui.elements.get('jobsPanel').hidden, false, 'Reopening shows a still-running job immediately');
  assert.equal(card.querySelector('.job-state').textContent, '正在保存');
  const reveal = card.querySelectorAll('.job-button')[2]; assert.equal(reveal.hidden, true);
  ui.state.jobs[0].state = 'complete'; await ui.updateJobs();
  assert.equal(card.querySelector('.job-state').textContent, '已保存'); assert.equal(reveal.hidden, false);
  await ui.click(reveal); assert.ok(ui.messages.some(message => message.action === 'showJob' && message.jobId === 'save'));
});

test('retry keeps original source and HLS type and strips saved folder from filename', async () => {
  const ui = await setup({ jobs: [{ id: 'failed', url: 'https://cdn.test/playlist?id=42', filename: '旧目录/a.ts', isM3U8: true, state: 'interrupted', error: 'HTTP 503', tabId: 99 }] });
  const retry = ui.elements.get('jobList').querySelectorAll('.job-button')[1]; await ui.click(retry);
  const request = ui.messages.find(message => message.action === 'startDownload');
  assert.equal(request.filename, 'a.ts'); assert.equal(request.isM3U8, true); assert.equal(request.tabId, 99); assert.equal(request.url, 'https://cdn.test/playlist?id=42');
});

test('concurrency and a static default destination belong only to the jobs tab', async () => {
  const ui = await setup();
  for (const id of ['btnSettings', 'settingsModal', 'concurrencyMode', 'subfolder', 'askWhereToSave', 'btnChromeSettings']) assert.equal(ui.elements.has(id), false, id);
  assert.equal(ui.elements.get('jobsPanel').contains(ui.elements.get('concurrency')), true);
  assert.equal(ui.elements.get('jobsPanel').contains(ui.elements.get('saveLocation')), true);
  assert.equal(ui.elements.get('sourcePanel').contains(ui.elements.get('concurrency')), false);
  assert.equal(ui.elements.get('saveLocation').tagName, 'SPAN');
  assert.equal(ui.elements.get('jobsPanel').hidden, true);
  await ui.click('jobsTab'); assert.equal(ui.elements.get('jobsPanel').hidden, false);
  await ui.click('sourceTab'); assert.equal(ui.elements.get('jobsPanel').hidden, true);
});

test('the popup removes page metadata, screenshot controls and source search completely', async () => {
  const ui = await setup({ media: [media()] });
  for (const id of ['pageTitle', 'framesSection', 'framesCount', 'framesList', 'framesHint', 'btnSnap', 'imageModal', 'modalTimeTag', 'modalClose', 'modalImg', 'btnSaveFrame', 'mediaSearch', 'listToolbar', 'sourceCount']) {
    assert.equal(ui.elements.has(id), false, id);
  }
  const requests = ui.messages.filter(message => message.action === 'getMedia').length;
  await ui.runtimeMessage({ action: 'framesUpdated', tabId: 7 });
  assert.equal(ui.messages.filter(message => message.action === 'getMedia').length, requests, 'Removed screenshot events do not trigger a source refresh');
  assert.equal(ui.downloadCalls.length, 0);
  assert.doesNotMatch(source, /captureCurrentFrameNow|chrome\.downloads|currentTab\?\.title|response\.pageTitle/);
});

test('resumable interrupted task continues with the same job id and retained segments', async () => {
  const ui = await setup({ jobs: [{ id: 'partially-saved', url: media().url, filename: 'film.ts', isM3U8: true, state: 'interrupted', completedSegments: 498, totalSegments: 576, cachedSegments: 498, resumable: true, error: '分片解密失败' }] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  const retry = card.querySelectorAll('.job-button')[1];
  assert.equal(retry.textContent, '继续下载');
  assert.match(card.querySelector('.job-cache-status').textContent, /已保留 498 个分片/);
  assert.match(card.querySelector('.job-cache-status').textContent, /继续时会校验缓存/);
  retry.focus(); await ui.click(retry);
  assert.deepEqual(ui.messages.find(message => message.action === 'retryJob'), { action: 'retryJob', jobId: 'partially-saved' });
  assert.equal(ui.messages.some(message => message.action === 'startDownload'), false);
  assert.equal(ui.state.jobs.length, 1);
  assert.equal(ui.elements.get('jobList').querySelector('.job-card'), card);
  assert.equal(card.querySelector('.job-state').textContent, '等待下载');
  assert.equal(ui.document.activeElement, card.querySelectorAll('.job-button')[0]);
});

test('cancelled tasks use a fresh download even when an obsolete resumable flag exists', async () => {
  const ui = await setup({ jobs: [{ id: 'cancelled-old', url: media().url, filename: 'film.ts', isM3U8: true, state: 'cancelled', cachedSegments: 3, resumable: true }] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  assert.equal(card.querySelector('.job-cache-status').hidden, true);
  assert.equal(card.querySelector('.job-discard').hidden, true);
  await ui.click(card.querySelectorAll('.job-button')[1]);
  assert.equal(ui.messages.some(message => message.action === 'retryJob'), false);
  assert.equal(ui.messages.filter(message => message.action === 'startDownload').length, 1);
});

test('clearing retained cache disables competing actions and polling preserves focus', async () => {
  const ui = await setup({ deferredActions: ['discardJob'], jobs: [{ id: 'cache', url: media().url, filename: 'film.ts', isM3U8: true, state: 'interrupted', cachedSegments: 498, resumable: true }] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  const discard = card.querySelector('.job-discard'); discard.focus();
  const pending = ui.click(discard); await tick();
  assert.equal(discard.disabled, true);
  const retry = card.querySelectorAll('.job-button')[1]; assert.equal(retry.disabled, true);
  await ui.updateJobs();
  assert.equal(ui.elements.get('jobList').querySelector('.job-card'), card);
  assert.equal(ui.document.activeElement, discard);
  assert.equal(discard.disabled, true, 'Polling must not re-enable a pending action');
  await ui.click(retry);
  assert.equal(ui.messages.some(message => message.action === 'retryJob'), false, 'A second handler cannot race the pending discard');
  await ui.finishAction('discardJob'); await pending;
  assert.equal(ui.messages.filter(message => message.action === 'discardJob').length, 1);
  assert.equal(discard.hidden, true);
  assert.equal(retry.textContent, '重新下载');
  assert.equal(retry.disabled, false);
  assert.equal(ui.document.activeElement, retry);
  assert.equal(card.querySelector('.job-cache-status').hidden, true);
});

test('failed resume keeps its cache action available and reports the broker error', async () => {
  const ui = await setup({ actionErrors: { retryJob: '缓存暂时无法读取' }, jobs: [{ id: 'failed-resume', url: media().url, filename: 'film.ts', isM3U8: true, state: 'interrupted', cachedSegments: 498, resumable: true }] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  await ui.click(card.querySelectorAll('.job-button')[1]);
  assert.equal(card.querySelectorAll('.job-button')[1].disabled, false);
  assert.equal(card.querySelector('.job-discard').hidden, false);
  assert.equal(ui.elements.get('toast').textContent, '缓存暂时无法读取');
  assert.equal(ui.messages.some(message => message.action === 'startDownload'), false);
});

test('engine retry/backoff text is visible while running and disappears after recovery', async () => {
  const message = '第 499 片解密失败，2 秒后重试（2/4）';
  const ui = await setup({ jobs: [{ id: 'retrying', url: media().url, filename: 'film.ts', state: 'downloading', retryAttempt: 2, retryMessage: message }] });
  const status = ui.elements.get('jobList').querySelector('.job-retry-status');
  assert.equal(status.hidden, false); assert.equal(status.textContent, message);
  Object.assign(ui.state.jobs[0], { retryAttempt: 0, retryMessage: '' }); await ui.updateJobs();
  assert.equal(status.hidden, true);
  Object.assign(ui.state.jobs[0], { state: 'complete', retryAttempt: 2, retryMessage: message }); await ui.updateJobs();
  assert.equal(status.hidden, true, 'A successful job must not display stale retry information');
});



test('download waits for pending concurrency and does not start after a failed save', async () => {
  for (const fail of [false, true]) {
    const ui = await setup({ media: [media()], deferredActions: ['saveSettings'] });
    if (fail) ui.state.settingsError = '存储写入失败';
    await ui.click('jobsTab');
    const change = ui.input('concurrency', '96'); await tick();
    await ui.click('sourceTab');
    const download = ui.click(ui.elements.get('mediaList').querySelector('.btn-primary')); await tick();
    assert.equal(ui.messages.some(message => message.action === 'startDownload'), false);
    await ui.finishAction('saveSettings'); await change; await download;
    assert.equal(ui.messages.some(message => message.action === 'startDownload'), !fail);
    if (fail) assert.match(ui.elements.get('toast').textContent, /存储写入失败/);
  }
});

test('changing concurrency never writes obsolete location or mode fields', async () => {
  const ui = await setup({ settings: { subfolder: '旧目录', askWhereToSave: true, concurrencyMode: 'manual', concurrency: 8 } });
  await ui.input('concurrency', '16');
  assert.deepEqual(ui.messages.find(message => message.action === 'saveSettings').settings, { concurrency: 16 });
  assert.equal(ui.messages.some(message => message.action === 'openDownloadSettings'), false);
});

test('job telemetry reports speed and live target without replacing focused controls', async () => {
  const job = { id: 'manual', filename: 'film.ts', state: 'downloading', isM3U8: true, bytesReceived: 500 * 1024 ** 2,
    cachedSegments: 498, bytesPerSecond: 1.2 * 1024 ** 2, concurrency: 64, targetConcurrency: 64 };
  const ui = await setup({ jobs: [job] });
  const card = ui.elements.get('jobList').querySelector('.job-card'), cancel = card.querySelector('.job-button'); cancel.focus();
  assert.equal(card.querySelector('.job-telemetry').hidden, false);
  assert.equal(card.querySelector('.job-speed').textContent, '合计 1.2 MB/s');
  assert.equal(card.querySelector('.job-concurrency').textContent, '并发 64');
  assert.equal(card.querySelector('.job-concurrency').title, '请求并行，文件按序写入。');
  Object.assign(job, { bytesPerSecond: 0, concurrencyReason: 'errors', decisionReason: 'rate-limited' }); await ui.updateJobs();
  assert.equal(card.querySelector('.job-speed').textContent, '合计 0 B/s', 'Restored cached bytes cannot become fake transfer speed');
  assert.equal(card.querySelector('.job-concurrency').textContent, '并发 64');
  assert.doesNotMatch(card.querySelector('.job-concurrency').title, /降低|探测|调节/);
  assert.equal(ui.document.activeElement, cancel);
  job.targetConcurrency = 120; await ui.updateJobs();
  assert.equal(card.querySelector('.job-concurrency').textContent, '并发 120');
  job.state = 'queued'; job.targetConcurrency = 0; job.concurrency = 96; await ui.updateJobs();
  assert.equal(card.querySelector('.job-telemetry').hidden, false);
  assert.equal(card.querySelector('.job-speed').hidden, true);
  assert.equal(card.querySelector('.job-concurrency').textContent, '并发 96');
  for (const state of ['parsing', 'saving', 'complete', 'interrupted', 'cancelled']) {
    job.state = state; await ui.updateJobs(); assert.equal(card.querySelector('.job-telemetry').hidden, true, state);
  }
});

test('waiting, confirmed playback detection, and finite no-source are distinct capture states', async () => {
  const ui = await setup({ capturePhase: 'waiting', playback: { hasVideo: true, observed: false, playing: false } });
  assert.equal(ui.elements.get('statusBar').dataset.state, 'waiting');
  assert.match(ui.elements.get('statusText').textContent, /请先在网页点击播放/);
  assert.equal(ui.elements.get('mediaList').querySelector('.empty-box').dataset.phase, 'waiting');
  ui.state.capturePhase = 'sniffing'; ui.state.playback.observed = true; ui.state.playback.playing = true; ui.state.chunkCount = 1;
  await ui.updateMedia();
  assert.equal(ui.elements.get('statusBar').dataset.state, 'sniffing');
  assert.match(ui.elements.get('mediaList').querySelector('.empty-desc').textContent, /分段请求/);
  const requests = ui.messages.filter(message => message.action === 'getMedia').length;
  ui.state.capturePhase = 'no-source'; await ui.advance(10000);
  assert.equal(ui.messages.filter(message => message.action === 'getMedia').length, requests + 1, 'Polling must refresh discovery, even without an event');
  assert.equal(ui.elements.get('statusBar').dataset.state, 'no-source');
  assert.equal(ui.elements.get('mediaList').querySelector('.empty-box').dataset.phase, 'no-source');
  assert.doesNotMatch(ui.elements.get('statusText').textContent, /正在识别/);
});

test('preloaded sources are downloadable without claiming playback and cards survive playback transitions', async () => {
  const ui = await setup({ media: [{ ...media(), active: true }], capturePhase: 'found', playback: { observed: false, hasVideo: true, playing: false, uncertain: false } });
  const card = ui.elements.get('mediaList').querySelector('.media-card'), button = card.querySelector('.btn-primary');
  button.focus();
  assert.match(ui.elements.get('statusText').textContent, /尚未播放/);
  assert.equal(card.querySelector('.source-number').textContent, '当前线路');
  assert.equal(button.disabled, false);
  Object.assign(ui.state.playback, { observed: true, playing: true }); await ui.updateMedia();
  assert.match(ui.elements.get('statusText').textContent, /正在播放/);
  assert.equal(card.querySelector('.source-number').textContent, '当前播放');
  assert.equal(ui.document.activeElement, button);
  ui.state.playback.playing = false; await ui.updateMedia();
  assert.match(ui.elements.get('statusText').textContent, /已播放/);
  assert.equal(card.querySelector('.source-number').textContent, '当前线路');
  assert.equal(ui.elements.get('mediaList').querySelector('.media-card'), card);
});

test('unknown player state becomes a static neutral hint, then recovers when observations arrive', async () => {
  const ui = await setup({ capturePhase: 'checking', playback: { observed: false, uncertain: true } });
  assert.equal(ui.elements.get('statusBar').dataset.state, 'checking');
  await ui.advance(6000);
  assert.equal(ui.elements.get('statusBar').dataset.state, 'unconfirmed');
  assert.match(ui.elements.get('statusText').textContent, /尚未确认/);
  assert.doesNotMatch(ui.elements.get('mediaList').querySelector('.empty-desc').textContent, /尚未播放/);
  await ui.advance(20000); assert.equal(ui.elements.get('statusBar').dataset.state, 'unconfirmed');
  ui.state.capturePhase = 'waiting'; ui.state.playback = { hasVideo: true, observed: false }; await ui.updateMedia();
  assert.equal(ui.elements.get('statusBar').dataset.state, 'waiting');
  ui.state.capturePhase = 'checking'; await ui.updateMedia();
  assert.equal(ui.elements.get('statusBar').dataset.state, 'checking', 'A new unknown observation starts a fresh short check');
});

test('no player, unavailable page, and connection failure have separate empty states', async () => {
  const ui = await setup({ capturePhase: 'no-video', playback: { videoCount: 0, frameCount: 1, uncertain: false } });
  assert.equal(ui.elements.get('statusBar').dataset.state, 'no-video');
  assert.match(ui.elements.get('mediaList').querySelector('.empty-title').textContent, /没有播放器/);
  ui.state.mediaError = '后台未响应'; await ui.updateMedia();
  assert.equal(ui.elements.get('statusBar').dataset.state, 'error');
  assert.match(ui.elements.get('mediaList').querySelector('.empty-hint').textContent, /后台未响应/);
  const unavailable = await setup({ tabUrl: 'chrome://settings/downloads' });
  assert.equal(unavailable.elements.get('statusBar').dataset.state, 'unavailable');
  await unavailable.click('btnRefresh');
  assert.equal(unavailable.elements.get('statusBar').dataset.state, 'unavailable');
  assert.equal(unavailable.messages.some(message => message.action === 'getMedia'), false);
});

test('requests or uncertain iframe data never establish playback on their own', async () => {
  const ui = await setup({ capturePhase: 'sniffing', playback: { observed: false, playing: false, uncertain: true } });
  assert.equal(ui.elements.get('statusBar').dataset.state, 'checking');
  ui.state.media = [{ ...media(), active: true }]; ui.state.capturePhase = 'found'; await ui.updateMedia();
  assert.match(ui.elements.get('statusText').textContent, /播放状态未确认/);
  assert.equal(ui.elements.get('mediaList').querySelector('.source-number').textContent, '当前线路');
});

test('source cards omit discovery explanations and keep the source host free of signed query parameters', async () => {
  const item = { ...media(), url: 'https://cdn.test/movie.m3u8?token=secret#private', isM3U8: true, active: true, evidence: ['dom-selection', 'network-mime'] };
  const ui = await setup({ media: [item] });
  const card = ui.elements.get('mediaList').querySelector('.media-card');
  assert.equal(card.querySelector('.source-explain'), null);
  assert.equal(card.querySelector('.source-evidence'), null);
  assert.equal(card.querySelector('.url-preview'), null);
  assert.match(card.querySelector('.source-host').textContent, /^cdn\.test/);
  assert.doesNotMatch(card.querySelector('.source-host').textContent, /secret|private/);
  assert.equal(card.querySelectorAll('.btn').length, 2);
});

test('expanded task explanation follows state changes without resetting disclosure or focus', async () => {
  const job = { id: 'explainable', filename: 'movie.ts', state: 'downloading', isM3U8: true, activeConcurrency: 3, concurrencyReason: 'gain', totalSegments: 5, completedSegments: 4 };
  const ui = await setup({ jobs: [job] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  const disclosure = card.querySelector('.job-explain'); disclosure.open = true;
  const summary = disclosure.querySelector('.explain-summary'); summary.focus();
  assert.match(card.querySelector('.explain-concurrency').textContent, /并发 3/);
  Object.assign(job, { state: 'saving', completedSegments: 5, stateReason: '正在确认最终文件保存结果。' });
  await ui.updateJobs();
  assert.equal(card.querySelector('.job-explain'), disclosure);
  assert.equal(disclosure.open, true);
  assert.equal(ui.document.activeElement, summary);
  assert.equal(card.querySelector('.explain-phase').textContent, '正在确认最终文件保存结果。');
  assert.match(card.querySelector('.explain-result').textContent, /尚未确认/);
  job.state = 'complete'; await ui.updateJobs();
  assert.match(card.querySelector('.explain-result').textContent, /已保存/);
});

test('failed first concurrency read stays locked until retry and never overwrites the saved value', async () => {
  const ui = await setup({ media: [media()], getSettingsError: '存储暂时不可用', settings: { concurrency: 128 } });
  assert.equal(ui.elements.get('concurrency').disabled, true);
  assert.equal(ui.elements.get('btnReloadPreferences').hidden, false);
  assert.match(ui.elements.get('saveError').textContent, /读取失败/);
  await ui.click(ui.elements.get('mediaList').querySelector('.btn-primary'));
  assert.equal(ui.messages.some(message => ['saveSettings', 'startDownload'].includes(message.action)), false);
  ui.state.getSettingsError = null; await ui.click('jobsTab'); await ui.click('btnReloadPreferences');
  assert.equal(ui.elements.get('concurrency').disabled, false);
  assert.equal(ui.elements.get('concurrency').value, '128');
  assert.equal(ui.elements.get('btnReloadPreferences').hidden, true);
  assert.equal(ui.messages.some(message => message.action === 'saveSettings'), false);
});

test('the large header refresh action has a complete label, opens sources and recovers after read failures', async () => {
  const ui = await setup({ media: [media()], jobs: [{ id: 'active', state: 'downloading', isM3U8: true }] });
  const refresh = ui.elements.get('btnRefresh');
  assert.equal(refresh.getAttribute('aria-label'), '重新读取视频来源');
  assert.equal(ui.document.body.querySelector('.header').contains(refresh), true);
  assert.equal(ui.elements.get('sourcePanel').contains(refresh), false);
  assert.equal(ui.elements.get('jobsPanel').hidden, false);
  refresh.focus(); ui.state.mediaError = '来源暂时未响应';
  let requests = ui.messages.filter(message => message.action === 'refreshMedia').length;
  await ui.click(refresh);
  assert.equal(ui.messages.filter(message => message.action === 'refreshMedia').length, requests + 1);
  assert.equal(ui.elements.get('sourcePanel').hidden, false);
  assert.equal(ui.elements.get('statusBar').dataset.state, 'error');
  assert.equal(ui.document.activeElement, refresh);
  ui.state.mediaError = null; requests++;
  await ui.click(refresh);
  assert.equal(ui.messages.filter(message => message.action === 'refreshMedia').length, requests + 1);
  assert.equal(ui.elements.get('mediaList').querySelectorAll('.media-card').length, 1);
  assert.equal(ui.document.activeElement, refresh);
  assert.equal(ui.messages.some(message => ['startDownload', 'cancelJob', 'removeJob'].includes(message.action)), false);
});

test('ETA shows a stable engine estimate, never infers time from cached bytes, and keeps focused controls', async () => {
  const job = { id: 'eta', state: 'downloading', isM3U8: true, filename: 'movie.ts', totalSegments: 576, completedSegments: 498, cachedSegments: 498, bytesReceived: 500000000, bytesPerSecond: 20000000, etaSeconds: null };
  const ui = await setup({ jobs: [job] });
  const card = ui.elements.get('jobList').querySelector('.job-card'), eta = card.querySelector('.job-eta');
  const cancel = card.querySelector('.job-button'); cancel.focus();
  assert.equal(eta.hidden, false);
  assert.equal(eta.textContent, '预计剩余 · 估算中');
  Object.assign(job, { etaSeconds: 124, etaBasis: 'network-segments' }); await ui.updateJobs();
  assert.equal(eta.textContent, '预计剩余约 2 分 4 秒');
  assert.equal(ui.document.activeElement, cancel);
  assert.equal(card.querySelector('.job-eta'), eta);
  for (const invalid of [undefined, null, 0, -1, Infinity]) {
    job.etaSeconds = invalid; await ui.updateJobs();
    assert.equal(eta.textContent, '预计剩余 · 估算中');
  }
  job.etaSeconds = 3; job.retryAttempt = 2; await ui.updateJobs();
  assert.equal(eta.textContent, '预计剩余 · 估算中');
  job.retryAttempt = 0; job.completedSegments = 576; await ui.updateJobs();
  assert.equal(eta.textContent, '数据已收齐，正在准备保存');
});

test('direct-download ETA uses engine time and countdowns disappear outside downloading', async () => {
  const job = { id: 'direct-eta', state: 'downloading', isM3U8: false, concurrency: 64, filename: 'movie.mp4', bytesReceived: 50, totalBytes: 100, etaSeconds: 45, etaBasis: 'chrome' };
  const ui = await setup({ jobs: [job] });
  const eta = ui.elements.get('jobList').querySelector('.job-eta');
  assert.equal(eta.textContent, '预计剩余约 45 秒');
  assert.equal(ui.elements.get('jobList').querySelector('.job-concurrency').hidden, true, 'Chrome direct downloads do not use the HLS slider');
  for (const state of ['queued', 'parsing', 'saving', 'complete', 'interrupted', 'cancelled']) {
    job.state = state; await ui.updateJobs();
    assert.equal(eta.hidden, true, state); assert.equal(eta.textContent, '', state);
  }
});



test('a failed concurrency save keeps the selected value and keyboard focus for retry', async () => {
  const ui = await setup();
  const slider = ui.elements.get('concurrency'); slider.focus();
  ui.state.settingsError = '写入失败'; await ui.input('concurrency', '128');
  assert.equal(slider.value, '128'); assert.equal(ui.document.activeElement, slider);
  assert.equal(ui.elements.get('saveStatus').textContent, '未保存');
  assert.equal(ui.elements.get('saveError').hidden, false);
  ui.state.settingsError = null; await ui.input('concurrency', '128');
  assert.equal(ui.state.settings.concurrency, 128);
  assert.equal(ui.elements.get('saveStatus').textContent, '已保存');
  assert.equal(ui.elements.get('saveError').hidden, true);
});

test('manual concurrency accepts 375 while invalid values and obsolete environment rows stay hidden', async () => {
  const job = { id: 'manual-limit', state: 'downloading', isM3U8: true, filename: 'video.ts', totalSegments: 500, completedSegments: 5,
    targetConcurrency: 375, bytesPerSecond: 1048576, networkEnvironment: 'balanced', decisionReason: 'throughput-gain', etaSeconds: 60, etaBasis: 'network-segments' };
  const ui = await setup({ jobs: [job] }); const card = ui.elements.get('jobList').querySelector('.job-card');
  const disclosure = card.querySelector('.job-explain');
  assert.equal(Boolean(disclosure.open), false);
  assert.equal(card.querySelector('.job-concurrency').textContent, '并发 375');
  assert.equal(card.querySelector('.job-eta').textContent, '预计剩余约 1 分');
  for (const name of ['measured', 'requests', 'buffering', 'adjustment']) assert.equal(card.querySelector(`.explain-${name}`), null);
  disclosure.open = true; const summary = disclosure.querySelector('.explain-summary'); summary.focus();
  job.targetConcurrency = 1; await ui.updateJobs();
  assert.equal(card.querySelector('.job-concurrency').textContent, '并发 1');
  assert.equal(disclosure.open, true); assert.equal(ui.document.activeElement, summary);
  job.targetConcurrency = 376; await ui.updateJobs();
  assert.equal(card.querySelector('.job-concurrency').hidden, true);
  assert.equal(card.querySelector('.job-concurrency').textContent, '并发 —');
  job.state = 'saving'; await ui.updateJobs();
  assert.equal(card.querySelector('.job-eta').hidden, true);
});

test('the jobs-tab slider starts at 64, saves both endpoints, and restores its last position on reopen', async () => {
  const ui = await setup();
  assert.equal(ui.elements.get('concurrency').value, '64');
  assert.equal(ui.elements.get('concurrencyValue').textContent, '64');
  assert.equal(ui.elements.get('concurrency').disabled, false);
  assert.equal(ui.elements.has('btnSettings'), false);
  for (const value of ['1', '375']) {
    await ui.input('concurrency', value);
    assert.equal(ui.elements.get('concurrencyValue').textContent, value);
    assert.equal(ui.elements.get('concurrency').getAttribute('aria-valuetext'), `${value} 路`);
    assert.equal(ui.state.settings.concurrency, Number(value));
    assert.equal(ui.elements.get('saveStatus').textContent, '已保存');
  }
  const saved = structuredClone(ui.state.settings); ui.close();
  const reopened = await setup({ settings: saved });
  assert.equal(reopened.elements.get('concurrency').value, '375');
  assert.equal(reopened.messages.some(message => message.action === 'saveSettings'), false);
  assert.match(html, /id="concurrency" type="range" min="1" max="375" step="1"/);
  assert.match(html, /id="concurrencyCalm"[^>]*>稳<\/span>.*id="concurrency".*id="concurrencyFast"[^>]*>急<\/span>/);
  assert.match(html, /id="concurrencyHint"[^>]*>实时控制所有分片任务<\/p>/);
  assert.match(ui.elements.get('concurrency').getAttribute('title'), /降低并发.*已发请求会自然结束/);
});

test('slider input sends every latest edit before close and late acknowledgements preserve its position and focus', async () => {
  const ui = await setup({ settings: { subfolder: '收藏', askWhereToSave: true, concurrency: 64 }, deferredActions: ['saveSettings'] });
  const slider = ui.elements.get('concurrency'); slider.focus();
  const first = ui.input('concurrency', '96'); await tick();
  const second = ui.input('concurrency', '375'); await tick();
  const requests = ui.messages.filter(message => message.action === 'saveSettings');
  assert.deepEqual(requests.map(message => message.settings.concurrency), [96, 375]);
  assert.deepEqual(requests[1].settings, { concurrency: 375 });
  assert.equal(ui.elements.get('concurrencyValue').textContent, '375');
  await ui.finishAction('saveSettings'); await first;
  assert.equal(slider.value, '375'); assert.equal(ui.document.activeElement, slider);
  assert.equal(ui.elements.get('saveStatus').textContent, '保存中…');
  ui.close(); await ui.finishAction('saveSettings'); await second;
  assert.equal(ui.state.settings.concurrency, 375);
});

test('saved but unapplied concurrency remains truthful and can resend the same value with keyboard focus', async () => {
  const ui = await setup({ liveApplied: false, liveWarning: '执行端暂时未响应，请重试应用。', blurDisabledFocus: true });
  await ui.input('concurrency', '96');
  assert.equal(ui.state.settings.concurrency, 96, 'Persistence succeeded despite pending live delivery');
  assert.equal(ui.elements.get('saveStatus').textContent, '已保存 · 待应用');
  assert.equal(ui.elements.get('saveError').textContent, '执行端暂时未响应，请重试应用。');
  const retry = ui.elements.get('btnReloadPreferences');
  assert.equal(retry.hidden, false); assert.equal(retry.textContent, '重试应用');
  retry.focus(); ui.state.liveApplied = true; await ui.click(retry);
  assert.deepEqual(ui.messages.filter(message => message.action === 'saveSettings').map(message => message.settings.concurrency), [96, 96]);
  assert.equal(ui.elements.get('saveStatus').textContent, '已保存 · 已应用');
  assert.equal(ui.elements.get('saveError').hidden, true); assert.equal(retry.hidden, true);
  assert.equal(ui.document.activeElement, ui.elements.get('concurrency'));
  await ui.change('concurrency', '96');
  assert.equal(ui.messages.filter(message => message.action === 'saveSettings').length, 2);
  assert.equal(ui.elements.get('saveStatus').textContent, '已保存 · 已应用', 'Unchanged change events preserve the acknowledgement');
});

test('an old live-delivery warning cannot replace the status of a newer slider edit', async () => {
  const ui = await setup({ deferredActions: ['saveSettings'], liveApplied: false });
  const first = ui.input('concurrency', '96'); await tick();
  const second = ui.input('concurrency', '128'); await tick();
  await ui.finishAction('saveSettings'); await first;
  assert.equal(ui.elements.get('saveStatus').textContent, '保存中…');
  assert.equal(ui.elements.get('saveError').hidden, true);
  assert.equal(ui.elements.get('btnReloadPreferences').hidden, true);
  ui.state.liveApplied = true; await ui.finishAction('saveSettings'); await second;
  assert.equal(ui.elements.get('concurrency').value, '128');
  assert.equal(ui.elements.get('saveStatus').textContent, '已保存 · 已应用');
  assert.equal(ui.elements.get('btnReloadPreferences').hidden, true);
});

test('a persisted setting with pending live delivery does not block starting a new task', async () => {
  const ui = await setup({ media: [media()], liveApplied: false });
  await ui.input('concurrency', '128');
  assert.match(ui.elements.get('saveError').textContent, /并发已保存.*尚未应用/);
  await ui.click(ui.elements.get('mediaList').querySelector('.btn-primary'));
  assert.equal(ui.messages.some(message => message.action === 'startDownload'), true);
  assert.equal(ui.elements.get('saveStatus').textContent, '已保存 · 待应用');
  assert.equal(ui.state.settings.concurrency, 128);
});

test('retry waits for the latest saved value before restarting an interrupted task', async () => {
  const job = { id: 'cached', state: 'interrupted', isM3U8: true, resumable: true, totalSegments: 10, cachedSegments: 3, targetConcurrency: 64 };
  const ui = await setup({ jobs: [job], deferredActions: ['saveSettings'] });
  const pending = ui.input('concurrency', '120'); await tick();
  const retry = ui.click(ui.elements.get('jobList').querySelectorAll('.job-button')[1]); await tick();
  assert.equal(ui.messages.some(message => message.action === 'retryJob'), false);
  assert.equal(job.targetConcurrency, 64);
  await ui.finishAction('saveSettings'); await pending; await retry;
  assert.equal(ui.state.settings.concurrency, 120);
  assert.equal(ui.messages.some(message => message.action === 'retryJob'), true);
});

test('missing or invalid stored concurrency uses 64 without overwriting saved preferences', async () => {
  for (const concurrency of [undefined, 0, 376, 2.5, 'auto']) {
    const ui = await setup({ settings: { subfolder: '保留', askWhereToSave: true, concurrency } });
    assert.equal(ui.elements.get('concurrency').value, '64');
    assert.equal(ui.messages.some(message => message.action === 'saveSettings'), false);
  }
  const ui = await setup({ getSettingsError: '暂时不可用' });
  assert.equal(ui.elements.get('concurrency').disabled, true);
  await ui.input('concurrency', '120');
  assert.equal(ui.messages.some(message => message.action === 'saveSettings'), false);
});

test('active tasks offer cancellation and every terminal state offers explicit deletion', async () => {
  for (const state of ['queued', 'parsing', 'downloading', 'saving', 'complete', 'interrupted', 'cancelled']) {
    const ui = await setup({ jobs: [{ id: state, state, isM3U8: true }] });
    const card = ui.elements.get('jobList').querySelector('.job-card');
    const terminal = ['complete', 'interrupted', 'cancelled'].includes(state);
    assert.equal(card.querySelector('.job-button').textContent, '取消任务');
    assert.equal(card.querySelector('.job-button').hidden, terminal);
    assert.equal(card.querySelector('.job-remove').hidden, !terminal);
    assert.equal(card.querySelector('.job-remove').textContent, '删除任务');
    assert.match(card.querySelector('.job-remove').title, /不删除已保存的文件/);
  }
});

test('cancellation stays visibly pending through a stale poll, then exposes deletion as a separate action', async () => {
  const ui = await setup({ cancelPending: true, blurDisabledFocus: true, jobs: [{ id: 'stop', state: 'downloading', isM3U8: true, etaSeconds: 60 }] });
  const card = ui.elements.get('jobList').querySelector('.job-card'), cancel = card.querySelector('.job-button');
  cancel.focus(); ui.state.deferJobs = true; await ui.updateJobs(); // Snapshot predates cancellation.
  await ui.click(cancel);
  assert.equal(cancel.textContent, '正在取消…'); assert.equal(cancel.disabled, true);
  assert.match(card.querySelector('.job-retry-status').textContent, /正在取消任务/);
  assert.equal(card.querySelector('.job-eta').hidden, true);
  assert.equal(card.querySelector('.job-remove').hidden, true);
  ui.state.deferJobs = false; await ui.finishAction('getJobs');
  assert.equal(cancel.textContent, '正在取消…'); assert.equal(cancel.disabled, true);
  await ui.click(cancel);
  assert.equal(ui.messages.filter(message => message.action === 'cancelJob').length, 1);
  assert.equal(ui.messages.some(message => message.action === 'removeJob'), false);
  ui.state.jobs[0].state = 'cancelled'; await ui.updateJobs();
  const remove = card.querySelector('.job-remove');
  assert.equal(cancel.hidden, true); assert.equal(remove.hidden, false);
  assert.equal(ui.document.activeElement, remove, 'Browser focus loss caused by disabling cancel must recover to the new action');
  await ui.click(remove);
  assert.deepEqual(ui.messages.find(message => message.action === 'removeJob'), { action: 'removeJob', jobId: 'stop' });
  assert.equal(ui.elements.get('jobList').querySelectorAll('.job-card').length, 0);
  assert.equal(ui.document.activeElement, ui.elements.get('jobsTab'));
});

test('cancel completion does not steal focus after the user moves to another control', async () => {
  const ui = await setup({ cancelPending: true, blurDisabledFocus: true, jobs: [{ id: 'stop', state: 'downloading', isM3U8: true }] });
  const cancel = ui.elements.get('jobList').querySelector('.job-button'); cancel.focus(); await ui.click(cancel);
  const slider = ui.elements.get('concurrency'); slider.focus();
  ui.state.jobs[0].state = 'cancelled'; await ui.updateJobs();
  assert.equal(ui.document.activeElement, slider);
});

test('failed cancellation restores the action and focus for retry', async () => {
  const ui = await setup({ blurDisabledFocus: true, actionErrors: { cancelJob: '取消请求未送达' }, jobs: [{ id: 'stop', state: 'downloading', isM3U8: true }] });
  const cancel = ui.elements.get('jobList').querySelector('.job-button'); cancel.focus(); await ui.click(cancel);
  assert.equal(cancel.disabled, false); assert.equal(cancel.textContent, '取消任务');
  assert.equal(ui.document.activeElement, cancel);
  assert.equal(ui.elements.get('toast').textContent, '取消请求未送达');
});

test('deleting terminal tasks updates records and counts, preserving saved files and moving focus to the adjacent delete action', async () => {
  const ui = await setup({ blurDisabledFocus: true, jobs: [{ id: 'saved', state: 'complete', savedPath: 'movie.ts' }, { id: 'stopped', state: 'cancelled' }] });
  let remove = ui.elements.get('jobList').querySelector('.job-remove'); remove.focus(); await ui.click(remove);
  assert.equal(ui.elements.get('jobList').querySelectorAll('.job-card').length, 1);
  assert.equal(String(ui.elements.get('jobsTabCount').textContent), '1');
  assert.deepEqual(ui.state.jobs.map(job => job.id), ['stopped']);
  remove = ui.elements.get('jobList').querySelector('.job-remove');
  assert.equal(ui.document.activeElement, remove);
  assert.equal(ui.downloadCalls.length, 0);
  await ui.click(remove);
  assert.equal(String(ui.elements.get('jobsTabCount').textContent), '0');
  assert.ok(ui.elements.get('jobList').querySelector('.empty-box'));
  assert.equal(ui.document.activeElement, ui.elements.get('jobsTab'));
});

test('a confirmed removal cannot be resurrected by a getJobs response that began before deletion', async () => {
  const ui = await setup({ jobs: [{ id: 'old', state: 'interrupted', resumable: true, isM3U8: true, cachedSegments: 3 }] });
  const remove = ui.elements.get('jobList').querySelector('.job-remove'); remove.focus();
  ui.state.deferJobs = true; await ui.updateJobs();
  await ui.click(remove);
  assert.equal(ui.elements.get('jobList').querySelectorAll('.job-card').length, 0);
  ui.state.deferJobs = false; await ui.finishAction('getJobs');
  assert.equal(ui.elements.get('jobList').querySelectorAll('.job-card').length, 0);
  assert.equal(String(ui.elements.get('jobsTabCount').textContent), '0');
  await ui.updateJobs(); assert.equal(ui.state.jobs.length, 0);
});

test('pending removal excludes competing actions and failed removal remains visible and retryable through polls', async () => {
  const errors = { removeJob: '缓存仍在使用' };
  const ui = await setup({ blurDisabledFocus: true, actionErrors: errors, deferredActions: ['removeJob'],
    jobs: [{ id: 'cached', state: 'interrupted', isM3U8: true, resumable: true, cachedSegments: 3 }] });
  const card = ui.elements.get('jobList').querySelector('.job-card'), remove = card.querySelector('.job-remove'); remove.focus();
  let pending = ui.click(remove); await tick();
  assert.ok(card.querySelectorAll('.job-button').every(button => button.disabled));
  await ui.updateJobs(); await ui.click(remove); await ui.click(card.querySelectorAll('.job-button')[1]); await ui.click(card.querySelector('.job-discard'));
  assert.equal(ui.messages.filter(message => message.action === 'removeJob').length, 1);
  assert.equal(ui.messages.some(message => ['retryJob', 'discardJob'].includes(message.action)), false);
  await ui.finishAction('removeJob'); await pending;
  assert.equal(remove.disabled, false); assert.equal(ui.document.activeElement, remove);
  assert.match(card.querySelector('.job-error').textContent, /删除失败.*缓存仍在使用/);
  await ui.updateJobs(); assert.equal(ui.elements.get('jobList').querySelector('.job-card'), card);
  assert.match(card.querySelector('.job-error').textContent, /删除失败/);
  delete errors.removeJob; pending = ui.click(remove); await tick(); await ui.finishAction('removeJob'); await pending;
  assert.equal(ui.elements.get('jobList').querySelectorAll('.job-card').length, 0);
});

test('every retained job remains reachable for explicit deletion beyond twenty records', async () => {
  const jobs = Array.from({ length: 25 }, (_, index) => ({ id: `retained-${index}`, filename: `video-${index}.ts`, state: 'interrupted', isM3U8: true, resumable: true }));
  const ui = await setup({ jobs });
  assert.equal(ui.elements.get('jobList').querySelectorAll('.job-card').length, 25);
  const last = ui.elements.get('jobList').querySelectorAll('.job-card')[24]; await ui.click(last.querySelector('.job-remove'));
  assert.equal(ui.elements.get('jobList').querySelectorAll('.job-card').length, 24);
  assert.equal(ui.state.jobs.some(job => job.id === 'retained-24'), false);
});

test('all discovered sources are displayed without filtering and refresh retains surviving cards', async () => {
  const first = media(), second = { ...media(false), suggestedFilename: '另一个来源.mp4' };
  const ui = await setup({ media: [first, second] });
  const cards = ui.elements.get('mediaList').querySelectorAll('.media-card');
  assert.equal(cards.length, 2);
  assert.equal(String(ui.elements.get('sourceTabCount').textContent), '2');
  assert.ok(cards.every(card => !card.hidden));
  ui.state.media = [second]; await ui.click('btnRefresh');
  assert.equal(ui.elements.get('mediaList').querySelector('.media-card'), cards[1]);
  assert.equal(String(ui.elements.get('sourceTabCount').textContent), '1');
});

test('brand, empty states and task progress share the new decorative mascot', async () => {
  const empty = await setup();
  assert.equal(empty.document.body.querySelector('.brand-mark').children[0].getAttribute('src'), 'icons/yangmo-mascot.png');
  const companion = empty.elements.get('mediaList').querySelector('.companion-mascot');
  assert.equal(companion.src, 'icons/yangmo-mascot.png');
  const ui = await setup({ jobs: [{ id: 'mascot', state: 'downloading', totalSegments: 10, completedSegments: 2 }] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  const lane = card.querySelector('.job-mascot-lane'), image = lane.querySelector('.job-mascot-image');
  assert.equal(lane.getAttribute('aria-hidden'), 'true');
  assert.equal(image.src, 'icons/yangmo-mascot.png'); assert.equal(image.alt, ''); assert.equal(image.draggable, false);
  assert.equal(card.querySelector('.job-progress').getAttribute('role'), 'progressbar');
  assert.equal(card.querySelector('.job-progress').getAttribute('aria-valuenow'), '20');
});

test('the mascot follows the exact bounded progress value and keeps the progressbar and controls stable', async () => {
  const job = { id: 'moving', state: 'downloading', isM3U8: true, totalSegments: 100, completedSegments: 0 };
  const ui = await setup({ jobs: [job] }); const card = ui.elements.get('jobList').querySelector('.job-card');
  const runner = card.querySelector('.job-mascot-runner'), bar = card.querySelector('.job-progress');
  const cancel = card.querySelector('.job-button'); cancel.focus();
  for (const [completed, expected] of [[0, 0], [37, 37], [100, 100], [120, 100], [-1, 0]]) {
    job.completedSegments = completed; await ui.updateJobs();
    assert.equal(runner.style.left, `${expected}%`);
    assert.equal(card.querySelector('.job-progress-fill').style.width, `${expected}%`);
    assert.equal(bar.getAttribute('aria-valuenow'), String(expected));
    assert.equal(card.querySelector('.job-mascot-runner'), runner);
    assert.equal(ui.document.activeElement, cancel);
  }
  Object.assign(job, { state: 'saving', completedSegments: 100 }); await ui.updateJobs();
  assert.equal(runner.style.left, '100%'); assert.equal(card.dataset.animating, 'true');
  assert.match(card.querySelector('.explain-result').textContent, /尚未确认/);
  job.state = 'complete'; await ui.updateJobs();
  assert.equal(card.dataset.animating, 'false'); assert.equal(runner.style.left, '100%');
});

test('unknown totals keep the mascot at the origin without fabricating a percentage', async () => {
  const job = { id: 'unknown', state: 'downloading', bytesReceived: 9999999, totalBytes: 0 };
  const ui = await setup({ jobs: [job] }); const card = ui.elements.get('jobList').querySelector('.job-card');
  const runner = card.querySelector('.job-mascot-runner'), bar = card.querySelector('.job-progress');
  assert.equal(runner.style.left, '0%'); assert.equal(bar.dataset.indeterminate, 'true');
  assert.equal(bar.getAttribute('aria-valuenow'), null); assert.equal(card.querySelector('.job-percent').textContent, '');
  await ui.advance(60000);
  assert.equal(runner.style.left, '0%', 'Elapsed time cannot move the mascot along the track');
  Object.assign(job, { totalBytes: 100, bytesReceived: 25 }); await ui.updateJobs();
  assert.equal(runner.style.left, '25%'); assert.equal(bar.dataset.indeterminate, 'false');
});

test('only parsing, downloading and saving animate and cancellation stops motion immediately', async () => {
  const job = { id: 'motion', state: 'queued', isM3U8: true, totalSegments: 10, completedSegments: 3 };
  const ui = await setup({ cancelPending: true, deferredActions: ['cancelJob'], jobs: [job] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  for (const state of ['queued', 'parsing', 'downloading', 'saving', 'complete', 'interrupted', 'cancelled']) {
    job.state = state; await ui.updateJobs();
    assert.equal(card.dataset.animating, String(['parsing', 'downloading', 'saving'].includes(state)), state);
  }
  job.state = 'downloading'; await ui.updateJobs();
  const pending = ui.click(card.querySelector('.job-button')); await tick();
  assert.equal(card.dataset.animating, 'false', 'Stop on local cancellation intent, before its acknowledgement');
  await ui.finishAction('cancelJob'); await pending;
  assert.equal(card.dataset.animating, 'false');
  assert.equal(card.querySelector('.job-mascot-runner').style.left, '30%');
});

test('job animation pauses independently when hidden or viewing sources without creating decoration timers', async () => {
  const ui = await setup({ jobs: [{ id: 'active', state: 'downloading', totalSegments: 10, completedSegments: 1 }] });
  const app = ui.elements.get('appContent');
  assert.equal(app.dataset.jobArtPaused, 'false'); assert.equal(app.dataset.artPaused, 'true');
  await ui.click('sourceTab');
  assert.equal(app.dataset.jobArtPaused, 'true'); assert.equal(app.dataset.artPaused, 'false');
  await ui.click('jobsTab'); await ui.visibility(true);
  assert.equal(app.dataset.jobArtPaused, 'true'); assert.equal(app.dataset.artPaused, 'true');
  await ui.visibility(false);
  assert.equal(app.dataset.jobArtPaused, 'false');
  await ui.updateJobs(); await ui.updateJobs();
  assert.deepEqual(ui.timers, { intervals: 1, timeouts: 0 }, 'Only the existing refresh poll runs; decoration is CSS-only');
});
