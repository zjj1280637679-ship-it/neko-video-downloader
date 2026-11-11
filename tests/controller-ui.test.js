const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'controller_ui.js'), 'utf8');
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function controllerUI() {
  const drawings = [], clears = [];
  class Element {
    constructor() {
      this.value = '';
      this.open = false;
      this.style = {};
      this.dataset = {};
      this.options = [];
      this.handlers = {};
      this.width = 1280;
      this.height = 800;
    }
    addEventListener(event, callback) { this.handlers[event] = callback; }
    replaceChildren() { this.options = []; }
    append(child) { this.options.push(child); }
    get selectedOptions() { return this.options.filter(option => option.value === this.value); }
    getContext() { return { clearRect() { clears.push(true); }, drawImage(image) { drawings.push(image.src); } }; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 800 }; }
    matches() { return false; }
    blur() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const sent = [], sockets = [];
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; sockets.push(this); }
    send(raw) { sent.push(JSON.parse(raw)); }
    close() {}
  }
  const context = vm.createContext({
    document: { getElementById: element, createElement: () => new Element(), activeElement: null },
    window: { addEventListener() {} },
    location: { protocol: 'http:', host: '127.0.0.1:8899' },
    WebSocket: Socket, HTMLElement: Element, Image: class {
      width = 1280;
      height = 800;
      set src(value) { this.value = value; this.onload(); }
      get src() { return this.value; }
    },
    sessionStorage: { getItem() { return null; } },
    setTimeout() { return 1; }, clearTimeout() {}, performance: { now() { return 0; } }, console,
  });
  vm.runInContext(source, context);
  const emit = message => sockets[0].onmessage({ data: JSON.stringify(message) });
  const selection = () => sent.filter(message => message.action === 'select').at(-1);
  const confirm = request => emit({ type: 'selected', id: request.id, targetId: request.targetId });
  emit({ type: 'ready', tabs: [
    { id: 'A', title: 'Page A', url: 'https://example.test/A' },
    { id: 'B', title: 'Page B', url: 'https://example.test/B' },
  ] });
  confirm(selection());
  return {
    sent, element, emit, selection, confirm, drawings, clears,
    select(targetId) {
      element('tabSelect').value = targetId;
      element('tabSelect').handlers.change();
      return selection();
    },
    click(id) { return element(id).handlers.click(); },
    reply(request, result) { emit({ type: 'response', id: request.id, ok: true, result }); },
  };
}

for (const [button, entryId] of [['btnBack', 1001], ['btnForward', 1003]]) {
  test(`${button} keeps its starting target through a tab switch while history is pending`, async () => {
    const ui = controllerUI();
    const action = ui.click(button);
    const historyRequest = ui.sent.find(message => message.method === 'Page.getNavigationHistory');
    assert.equal(historyRequest.targetId, 'A');
    ui.confirm(ui.select('B'));
    ui.reply(historyRequest, { currentIndex: 1, entries: [{ id: 1001 }, { id: 1002 }, { id: 1003 }] });
    await tick();
    const navigation = ui.sent.find(message => message.method === 'Page.navigateToHistoryEntry');
    assert.ok(navigation, 'The original navigation action should still complete');
    assert.equal(navigation.targetId, 'A', 'A history entry must never be sent to the newly selected B');
    assert.deepEqual(navigation.params, { entryId });
    ui.reply(navigation, {});
    await action;
  });
}

test('a failed selection keeps the confirmed target and its usable picture', async () => {
  const ui = controllerUI();
  ui.emit({ type: 'frame', targetId: 'A', data: 'picture-A' });
  const clearCount = ui.clears.length;
  const failed = ui.select('B');
  ui.click('btnReload');
  const duringSelection = ui.sent.find(message => message.method === 'Page.reload');
  assert.equal(duringSelection.targetId, 'A', 'Controls should still operate the picture the user can see');
  ui.reply(duringSelection, {});
  ui.emit({
    type: 'response', action: 'select', id: failed.id, targetId: 'B', selectedTargetId: 'A',
    ok: false, error: { code: 'cdp_error', message: 'Screencast unavailable for B' },
  });
  assert.equal(ui.selection(), failed, 'A failed preparation must not restart the usable A stream');
  assert.equal(ui.element('tabSelect').value, 'A');
  assert.equal(ui.clears.length, clearCount);
  assert.deepEqual(ui.drawings, ['data:image/jpeg;base64,picture-A']);
  ui.click('btnReload');
  const reload = ui.sent.filter(message => message.method === 'Page.reload').at(-1);
  assert.equal(reload.targetId, 'A');
  ui.reply(reload, {});
  await tick();
});

test('a candidate first frame appears only after its selection is confirmed', () => {
  const ui = controllerUI();
  ui.emit({ type: 'frame', targetId: 'A', data: 'picture-A' });
  const requested = ui.select('B');
  ui.emit({ type: 'frame', targetId: 'B', data: 'picture-B' });
  assert.deepEqual(ui.drawings, ['data:image/jpeg;base64,picture-A']);
  ui.confirm(requested);
  assert.deepEqual(ui.drawings, ['data:image/jpeg;base64,picture-A', 'data:image/jpeg;base64,picture-B']);
  ui.click('btnReload');
  assert.equal(ui.sent.find(message => message.method === 'Page.reload').targetId, 'B');
});

test('a stale failure for the same target cannot undo a later selection request', () => {
  const ui = controllerUI();
  const older = ui.select('B');
  ui.select('A');
  const latest = ui.select('B');
  assert.notEqual(older.id, latest.id);
  const count = ui.sent.length;
  ui.emit({
    type: 'response', action: 'select', id: older.id, targetId: 'B', selectedTargetId: 'A',
    ok: false, error: { code: 'selection_superseded', message: 'A newer selection was requested' },
  });
  assert.equal(ui.sent.length, count, 'An older failure must not trigger a restore over a new selection');
  assert.equal(ui.element('tabSelect').value, 'B');
  ui.confirm(latest);
  ui.click('btnReload');
  const reload = ui.sent.find(message => message.method === 'Page.reload');
  assert.equal(reload.targetId, 'B');
});
