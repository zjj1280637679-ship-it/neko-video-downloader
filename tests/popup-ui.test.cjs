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
  let ready;
  const elements = new Map(), messages = [], downloadCalls = [], runtimeListeners = new Set();
  const state = {
    media: options.media || [], frames: options.frames || [], jobs: options.jobs || [],
    settings: options.settings || { subfolder: '', askWhereToSave: false },
    settingsError: null, nextJob: 1
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
        if (selector.includes(':not([disabled])') && ['BUTTON', 'INPUT'].includes(child.tagName) && !child.disabled) matches.push(child);
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
          case 'getMedia': return callback({ media: state.media, frames: state.frames, pageTitle: '测试视频' });
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
          case 'showJob': case 'openDownloadSettings': return callback({ success: true });
          default: throw new Error(`Unexpected message ${message.action}`);
        }
      }
    },
    tabs: { async query() { return [{ id: 7, title: '测试视频', url: options.tabUrl || 'https://video.test/watch' }]; }, create() { throw new Error('Popup must never open a download page'); } },
    downloads: { async download(value) { downloadCalls.push(value); return 42; } }
  };
  const context = vm.createContext({ document, chrome, window: { addEventListener() {} }, navigator: { clipboard: { async writeText() {} } }, URL, URLSearchParams, console, queueMicrotask, setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 2; }, clearInterval() {} });
  vm.runInContext(source, context); await ready(); await tick();
  return {
    elements, messages, downloadCalls, state, document,
    async click(element) { await (typeof element === 'string' ? elements.get(element) : element).listeners.click?.({ target: element }); await tick(); },
    async submit() { await elements.get('settingsForm').listeners.submit({ preventDefault() {} }); await tick(); },
    async updateJobs() { for (const listener of runtimeListeners) listener({ action: 'jobsUpdated' }); await tick(); }
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
