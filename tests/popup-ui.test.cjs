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
  const elements = new Map(), messages = [], downloadCalls = [], runtimeListeners = new Set(), pendingActions = new Map();
  const state = {
    media: options.media || [], frames: options.frames || [], jobs: options.jobs || [],
    settings: options.settings || { subfolder: '', askWhereToSave: false, concurrency: 5 },
    settingsError: null, nextJob: 1, now: 1000,
    capturePhase: options.capturePhase || (options.media?.length ? 'found' : 'checking'), playback: options.playback || {}, chunkCount: 0
  };
  const document = { hidden: false, activeElement: null, addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready = fn; }, getElementById(id) { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); } };
  class Element {
    constructor(tag, id = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.className = ''; this.checked = false; this.parentElement = null;
      const classes = new Set(); this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
    }
    get isConnected() { return Boolean(this.id || this.parentElement); }
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
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1], match[3]); element.hidden = /\bhidden\b/.test(match[2]); elements.set(element.id, element);
  }
  document.createElement = tag => new Element(tag);
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { runtimeListeners.add(fn); }, removeListener(fn) { runtimeListeners.delete(fn); } },
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        switch (message.action) {
          case 'getMedia': return callback(state.mediaError ? { success: false, error: state.mediaError } : { media: state.media, frames: state.frames, pageTitle: '测试视频', capturePhase: state.capturePhase, playback: state.playback, chunkCount: state.chunkCount });
          case 'getJobs': return callback({ success: true, jobs: state.jobs });
          case 'getSettings': return callback({ success: true, settings: state.settings });
          case 'saveSettings':
            if (state.settingsError) return callback({ success: false, error: state.settingsError });
            state.settings = message.settings; return callback({ success: true, settings: state.settings });
          case 'startDownload': {
            const job = { ...message, id: `job-${state.nextJob++}`, state: 'queued', bytesReceived: 0 };
            state.jobs.unshift(job); return callback({ success: true, job });
          }
          case 'cancelJob': state.jobs.find(job => job.id === message.jobId).state = 'cancelled'; return callback({ success: true });
          case 'retryJob': case 'discardJob': {
            const finish = () => {
              if (options.actionErrors?.[message.action]) return callback({ success: false, error: options.actionErrors[message.action] });
              const job = state.jobs.find(job => job.id === message.jobId);
              if (message.action === 'retryJob') Object.assign(job, { state: 'queued', error: '', retryAttempt: 0, retryMessage: '' });
              else Object.assign(job, { resumable: false, cachedSegments: 0 });
              callback({ success: true, job });
            };
            if (options.deferredActions?.includes(message.action)) pendingActions.set(message.action, finish);
            else finish();
            return;
          }
          case 'showJob': case 'openDownloadSettings': return callback({ success: true });
          default: throw new Error(`Unexpected message ${message.action}`);
        }
      }
    },
    tabs: { async query() { return [{ id: 7, title: '测试视频', url: options.tabUrl || 'https://video.test/watch' }]; }, create() { throw new Error('Popup must never open a download page'); } },
    downloads: { async download(value) { downloadCalls.push(value); return 42; } }
  };
  class Clock extends Date { static now() { return state.now; } }
  const context = vm.createContext({ document, chrome, window: { addEventListener() {} }, navigator: { clipboard: { async writeText() {} } }, URL, URLSearchParams, Date: Clock, console, queueMicrotask, setTimeout() { return 1; }, clearTimeout() {}, setInterval(fn, duration) { assert.equal(duration, 2000); poll = fn; return 2; }, clearInterval() {} });
  vm.runInContext(source, context); await ready(); await tick();
  return {
    elements, messages, downloadCalls, state, document,
    async finishAction(action) { pendingActions.get(action)(); pendingActions.delete(action); await tick(); },
    async click(element) { await (typeof element === 'string' ? elements.get(element) : element).listeners.click?.({ target: element }); await tick(); },
    async change(id, value) { const element = elements.get(id); element.value = value; await element.listeners.change?.({ target: element }); await tick(); },
    async submit() { await elements.get('settingsForm').listeners.submit({ preventDefault() {} }); await tick(); },
    async updateJobs() { for (const listener of runtimeListeners) listener({ action: 'jobsUpdated' }); await tick(); },
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

test('settings save false by default and invalid folders remain reviewable', async () => {
  const ui = await setup(); await ui.click('btnSettings');
  assert.equal(ui.elements.get('askWhereToSave').checked, false);
  ui.elements.get('subfolder').value = '../bad'; ui.state.settingsError = '子文件夹不能包含上级目录'; await ui.submit();
  assert.equal(ui.elements.get('settingsModal').hidden, false);
  assert.equal(ui.elements.get('settingsError').textContent, '子文件夹不能包含上级目录');
  assert.equal(ui.elements.get('subfolder').value, '../bad');
  ui.state.settingsError = null; ui.elements.get('subfolder').value = '喵喵/视频'; await ui.submit();
  assert.equal(ui.elements.get('settingsModal').hidden, true);
  assert.equal(ui.state.settings.askWhereToSave, false);
  assert.match(ui.elements.get('saveLocation').textContent, /喵喵\/视频/);
});

test('screenshots follow the current subfolder and askWhereToSave setting', async () => {
  for (const askWhereToSave of [false, true]) {
    const ui = await setup({ media: [media()], frames: [{ dataUrl: 'data:image/jpeg;base64,AA==', timeStr: '00:12' }], settings: { subfolder: '截图', askWhereToSave } });
    await ui.click(ui.elements.get('framesList').querySelector('.frame-card'));
    await ui.click('btnSaveFrame');
    assert.equal(ui.downloadCalls[0].saveAs, askWhereToSave);
    assert.match(ui.downloadCalls[0].filename, /^截图\/.*00_12\.jpg$/);
    assert.equal(ui.elements.get('imageModal').hidden, true);
  }
});

test('resumable interrupted task continues with the same job id and retained segments', async () => {
  const ui = await setup({ jobs: [{ id: 'partially-saved', url: media().url, filename: 'film.ts', isM3U8: true, state: 'interrupted', completedSegments: 498, totalSegments: 576, cachedSegments: 498, resumable: true, error: '分片解密失败' }] });
  const card = ui.elements.get('jobList').querySelector('.job-card');
  const retry = card.querySelectorAll('.job-button')[1];
  assert.equal(retry.textContent, '继续下载');
  assert.match(card.querySelector('.job-cache-status').textContent, /已保留 498 个分片/);
  assert.match(card.querySelector('.job-cache-status').textContent, /仅在本次浏览器会话内/);
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

test('automatic concurrency is the default for new and migrated settings', async () => {
  for (const settings of [{}, { concurrency: 8 }, { concurrency: 3, concurrencyMode: 'auto' }]) {
    const ui = await setup({ settings }); await ui.click('btnSettings');
    assert.equal(ui.elements.get('concurrencyMode').value, 'auto');
    assert.equal(ui.elements.get('concurrencyCountRow').hidden, true);
    assert.equal(ui.elements.get('concurrency').value, String(settings.concurrency || 5));
    assert.match(ui.elements.get('concurrencyModeHint').textContent, /总下载速度/);
    await ui.submit(); assert.equal(ui.state.settings.concurrencyMode, 'auto');
  }
});

test('manual concurrency exposes all supported counts and retains its preference when returning to automatic', async () => {
  const ui = await setup({ settings: { subfolder: '', askWhereToSave: false } });
  await ui.click('btnSettings'); assert.equal(ui.elements.get('concurrency').value, '5');
  for (const concurrency of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await ui.click('btnSettings'); await ui.change('concurrencyMode', 'manual');
    assert.equal(ui.elements.get('concurrencyCountRow').hidden, false);
    ui.elements.get('concurrency').value = String(concurrency); await ui.submit();
    assert.equal(ui.state.settings.concurrency, concurrency);
    assert.equal(ui.state.settings.concurrencyMode, 'manual');
    assert.equal(ui.elements.get('settingsModal').hidden, true);
  }
  await ui.click('btnSettings'); await ui.change('concurrencyMode', 'auto');
  assert.equal(ui.elements.get('concurrencyCountRow').hidden, true); await ui.submit();
  assert.equal(ui.state.settings.concurrency, 8);
  await ui.click('btnSettings'); await ui.change('concurrencyMode', 'manual');
  assert.equal(ui.elements.get('concurrency').value, '8');
});

test('invalid concurrency does not reach settings storage, and valid existing values are retained', async () => {
  const ui = await setup({ settings: { subfolder: '', askWhereToSave: false, concurrency: 4 } });
  await ui.click('btnSettings'); await ui.change('concurrencyMode', 'manual'); assert.equal(ui.elements.get('concurrency').value, '4');
  await ui.submit(); assert.equal(ui.state.settings.concurrency, 4);
  const before = ui.messages.filter(message => message.action === 'saveSettings').length;
  for (const invalid of ['', '0', '9', '1.5', 'not-a-number']) {
    await ui.click('btnSettings'); ui.elements.get('concurrency').value = invalid; await ui.submit();
    assert.equal(ui.elements.get('settingsModal').hidden, false);
    assert.match(ui.elements.get('settingsError').textContent, /1 到 8 之间的整数/);
  }
  assert.equal(ui.messages.filter(message => message.action === 'saveSettings').length, before);
  await ui.click('btnSettings'); await ui.change('concurrencyMode', 'unexpected'); await ui.submit();
  assert.match(ui.elements.get('settingsError').textContent, /自动调节或手动固定/);
  assert.equal(ui.messages.filter(message => message.action === 'saveSettings').length, before);
});

test('job telemetry reports aggregate network speed and adaptive count without replacing focused controls', async () => {
  const job = { id: 'adaptive', filename: 'film.ts', state: 'downloading', bytesReceived: 500 * 1024 ** 2, cachedSegments: 498, bytesPerSecond: 1.2 * 1024 ** 2, activeConcurrency: 3, concurrencyMode: 'auto', concurrencyReason: 'probing' };
  const ui = await setup({ jobs: [job] });
  const card = ui.elements.get('jobList').querySelector('.job-card'), cancel = card.querySelector('.job-button'); cancel.focus();
  assert.equal(card.querySelector('.job-telemetry').hidden, false);
  assert.equal(card.querySelector('.job-speed').textContent, '合计 1.2 MB/s');
  assert.equal(card.querySelector('.job-concurrency').textContent, '自动 · 3 路');
  assert.match(card.querySelector('.job-concurrency').title, /比较增加并行数后的总速度/);
  Object.assign(job, { bytesPerSecond: 0, activeConcurrency: 1, concurrencyReason: 'errors' }); await ui.updateJobs();
  assert.equal(card.querySelector('.job-speed').textContent, '合计 0 B/s', 'Restored cached bytes cannot become fake transfer speed');
  assert.match(card.querySelector('.job-concurrency').title, /降低并行数/);
  assert.equal(ui.document.activeElement, cancel);
  Object.assign(job, { concurrencyMode: 'manual', activeConcurrency: 8, concurrencyReason: 'manual' }); await ui.updateJobs();
  assert.equal(card.querySelector('.job-concurrency').textContent, '手动 · 8 路');
  for (const state of ['queued', 'parsing', 'saving', 'complete', 'interrupted', 'cancelled']) {
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
