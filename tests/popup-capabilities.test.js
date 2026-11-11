const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the shipped popup unchanged. This small DOM boundary parses its HTML,
// retains real event registrations, and exposes the Chrome calls made by clicks.
const decode = (value) => String(value).replace(/&(amp|lt|gt|quot|#39);/g,
  (_match, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[key]));
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.handlers = new Map();
    this.style = {};
    this.disabled = false;
    this.scrollLeft = 0;
    this._text = '';
    this.classList = {
      add: (name) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' '); },
      remove: (name) => { this.className = this.className.split(/\s+/).filter((item) => item !== name).join(' '); },
      contains: (name) => this.className.split(/\s+/).includes(name)
    };
  }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = value; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(name, value) {
    this.attributes[name] = decode(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = decode(value);
    if (name === 'src') this.src = decode(value);
    if (name === 'disabled') this.disabled = true;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  addEventListener(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(callback);
  }
  click() { for (const callback of this.handlers.get('click') || []) callback({ target: this }); }
  scrollIntoView() { this.scrolledIntoView = true; }
  select() {}
  querySelectorAll(selector) {
    const matches = (element) => selector[0] === '.' ? element.classList.contains(selector.slice(1))
      : selector[0] === '#' ? element.getAttribute('id') === selector.slice(1) : element.tagName === selector;
    const results = [];
    const visit = (element) => { for (const child of element.children) { if (matches(child)) results.push(child); visit(child); } };
    visit(this);
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(html) {
    this.children = []; this._text = '';
    const stack = [this];
    const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
    for (const token of tokens) {
      if (token.startsWith('<!')) continue;
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1)._text += decode(token); continue; }
      const tagName = /^<([\w-]+)/.exec(token)?.[1];
      if (!tagName) continue;
      const element = new Element(tagName);
      const attrs = token.slice(tagName.length + 1, -1);
      const attrPattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s=<>]+)))?/g;
      for (const match of attrs.matchAll(attrPattern)) element.setAttribute(match[1], match[2] ?? match[3] ?? match[4] ?? '');
      stack.at(-1).appendChild(element);
      if (!['img', 'br', 'meta', 'link', 'input', 'hr'].includes(tagName) && !token.endsWith('/>')) stack.push(element);
    }
  }
}

const file = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
async function boot(snapshot, options = {}) {
  const root = new Element('document');
  root.innerHTML = file('popup.html');
  const state = { snapshot, requests: [], downloads: [], openedTabs: [], originalRequests: [] };
  let ready, broadcast;
  const chrome = {
    runtime: {
      getURL: (name) => 'chrome-extension://test/' + name,
      onMessage: { addListener: (listener) => { broadcast = listener; } },
      sendMessage(message, reply) {
        const request = copy(message); state.requests.push(request);
        if (request.action === 'getMedia') return reply(state.snapshot);
        if (request.action === 'getCapturedFrame') return state.originalRequests.push({ request, reply });
        if (request.action === 'captureCurrentFrame') return reply(options.capture?.(request) || { success: false, error: 'No fixture for capture' });
        if (request.action === 'download') return reply({ success: true, downloadId: 7 });
        throw new Error('Unexpected popup message: ' + request.action);
      }
    },
    tabs: {
      query: async () => [{ id: 1, title: 'Local fixture', url: 'https://page.test/watch' }],
      create: (value) => { state.openedTabs.push(copy(value)); }
    },
    downloads: { download(value, callback) { state.downloads.push(copy(value)); callback(8); } }
  };
  const document = {
    body: root.querySelector('body'),
    getElementById: (id) => root.querySelector('#' + id),
    createElement: (tagName) => new Element(tagName),
    addEventListener: (_name, callback) => { ready = callback; },
    execCommand: () => true
  };
  vm.runInNewContext(file('popup.js'), {
    document, chrome, console, window: { addEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 1, setInterval: () => 1, clearInterval() {}
  });
  await ready();
  return {
    state, root,
    element: (id) => document.getElementById(id),
    click(target) {
      const element = typeof target === 'string' ? root.querySelector(target) : target;
      assert.ok(element, 'click target must exist');
      assert.equal(element.disabled, false, 'click target must be enabled');
      element.click();
    },
    update(next) { state.snapshot = next; broadcast({ action: 'mediaListUpdated', tabId: 1 }); }
  };
}

const frame = (id) => ({ id, dataUrl: 'data:image/jpeg;base64,thumbnail', timeStr: '00:03', seconds: 3,
  width: 1920, height: 1080, timestamp: 1 });
const player = (videoId, sourceUrl, frames = []) => ({ frameId: 7, documentId: 'player-document', videoId, sourceUrl,
  title: 'Local fixture', isPlaying: true, width: 1920, height: 1080, frames });
const media = (overrides = {}) => ({ id: 'media-1', url: 'https://media.test/watch?id=1', ext: 'mp4', mime: 'video/mp4',
  suggestedFilename: 'Episode.mp4', isM3U8: false, size: 0, frames: [], ...overrides });

test('a blob player with no downloadable URL exposes its saved original and downloads only that original', async () => {
  const saved = frame('capture-1');
  const app = await boot({ media: [], players: [player('video-1', 'blob:local', [saved])], frames: [saved] });
  assert.equal(app.root.querySelectorAll('.player-card').length, 1);
  assert.equal(app.root.querySelectorAll('.btn-download').length, 0);
  app.click('.frame-card');
  assert.equal(app.element('btnSaveFrame').disabled, true);
  assert.equal(app.state.originalRequests[0].request.captureId, 'capture-1');
  const originalDataUrl = 'data:image/jpeg;base64,original-1920x1080';
  app.state.originalRequests[0].reply({ success: true, frame: { ...saved, originalDataUrl } });
  assert.equal(app.element('modalImg').src, originalDataUrl);
  assert.equal(app.element('btnSaveFrame').disabled, false);
  app.click('#btnSaveFrame');
  assert.equal(app.state.downloads.length, 1);
  assert.equal(app.state.downloads[0].url, originalDataUrl);
  assert.match(app.state.downloads[0].filename, /00-03\.jpg$/);
});

test('an empty-source player can be selected and captured by its exact identity', async () => {
  const selected = player('video-stream', '');
  const originalDataUrl = 'data:image/jpeg;base64,stream-original';
  const app = await boot({ media: [], frames: [], players: [selected] }, {
    capture: () => ({ success: true, sourceMatched: true, frame: { ...frame('new-frame'), originalDataUrl } })
  });
  app.click('.btn-player-snap');
  const request = app.state.requests.find((item) => item.action === 'captureCurrentFrame');
  assert.deepEqual(request, { action: 'captureCurrentFrame', tabId: 1, sourceUrl: '',
    frameId: 7, documentId: 'player-document', videoId: 'video-stream' });
  assert.equal(app.element('modalImg').src, originalDataUrl);
  app.click('#btnSaveFrame');
  assert.equal(app.state.downloads[0].url, originalDataUrl);
});

test('ambiguous HLS capture offers player cards and clicking one sends only its identity', async () => {
  const players = [player('video-1', 'blob:first'), player('video-2', 'blob:second')];
  const source = media({ isM3U8: true, ext: 'm3u8', mime: 'application/vnd.apple.mpegurl' });
  const app = await boot({ media: [source], players, frames: [] }, {
    capture: (request) => request.videoId
      ? { success: true, sourceMatched: true, frame: { ...frame('selected'), originalDataUrl: 'data:image/jpeg;base64,second-original' } }
      : { success: false, error: '找到多个可能的播放器，请选择', candidates: players }
  });
  assert.equal(app.root.querySelectorAll('.player-card').length, 2);
  app.click('#btnSnap_0');
  assert.match(app.element('toast').textContent, /多个可能的播放器/);
  assert.equal(app.state.requests.filter((item) => item.action === 'captureCurrentFrame').length, 1);
  assert.equal(app.root.querySelector('.player-card').scrolledIntoView, true);
  app.click(app.root.querySelectorAll('.btn-player-snap')[1]);
  const request = app.state.requests.filter((item) => item.action === 'captureCurrentFrame').at(-1);
  assert.equal(request.videoId, 'video-2');
  assert.equal(request.documentId, 'player-document');
  assert.equal(request.sourceUrl, 'blob:second');
  app.click('#btnSaveFrame');
  assert.equal(app.state.downloads[0].url, 'data:image/jpeg;base64,second-original');
});

test('a media type update changes the actual download route even if URL, size and title are unchanged', async () => {
  const first = media({ suggestedFilename: 'Episode' });
  const app = await boot({ media: [first], players: [], frames: [] });
  app.click('.btn-download');
  assert.equal(app.state.requests.filter((item) => item.action === 'download').length, 1);
  const stream = { ...first, isM3U8: true, ext: 'm3u8', mime: 'application/vnd.apple.mpegurl' };
  app.update({ media: [stream], players: [], frames: [] });
  assert.match(app.root.querySelector('.badge-tag').textContent, /m3u8/);
  app.click('.btn-download');
  assert.equal(app.state.openedTabs.length, 1);
  assert.match(app.state.openedTabs[0].url, /downloader\.html\?url=/);
  assert.equal(app.state.requests.filter((item) => item.action === 'download').length, 1);
  app.update({ media: [first], players: [], frames: [] });
  app.click('.btn-download');
  assert.equal(app.state.requests.filter((item) => item.action === 'download').length, 2);
  assert.equal(app.state.openedTabs.length, 1);
});

test('players sharing one direct source each retain a selectable player card', async () => {
  const source = media();
  const app = await boot({ media: [source], frames: [], players: [
    player('video-1', source.url), player('video-2', source.url)
  ] });
  assert.equal(app.root.querySelectorAll('.player-card').length, 2);
  assert.equal(app.root.querySelectorAll('.btn-player-snap').length, 2);
});
