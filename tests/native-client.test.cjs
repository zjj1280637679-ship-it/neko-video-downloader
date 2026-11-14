const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, HOST } = require('../engine/native-client');
function event() { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(value) { for (const fn of listeners) fn(value); } }; }
function setup() {
  const ports = [], runtime = { connectNative(name) {
    assert.equal(name, HOST);
    const port = { onMessage: event(), onDisconnect: event(), sent: [], postMessage(value) { this.sent.push(value); }, disconnect() { this.onDisconnect.emit(); } };
    ports.push(port); return port;
  } };
  return { ports, runtime, client: createClient(runtime, { timeoutMs: 1000 }) };
}
test('native requests correlate responses and job events never satisfy control requests', async () => {
  const h = setup(), jobs = [];
  h.client.onJob(job => jobs.push(job));
  const first = h.client.request('ping'), second = h.client.request('status');
  const p = h.ports[0];
  p.onMessage.emit({ event: 'job', job: { id: 'a', state: 'parsing' } });
  p.onMessage.emit({ requestId: p.sent[1].requestId, success: true, jobs: [] });
  p.onMessage.emit({ requestId: p.sent[0].requestId, success: true, version: 1 });
  assert.equal((await first).version, 1); assert.deepEqual((await second).jobs, []); assert.equal(jobs.length, 1);
  h.client.close();
});
test('missing native host rejects outstanding requests and a later request reconnects', async () => {
  const h = setup(), errors = [];
  h.client.onDisconnect(error => errors.push(error));
  const first = h.client.request('ping');
  h.runtime.lastError = { message: 'Specified native messaging host not found.' };
  h.ports[0].onDisconnect.emit(); delete h.runtime.lastError;
  await assert.rejects(first, /未找到/); assert.equal(errors.length, 1);
  const second = h.client.request('ping'), p = h.ports[1];
  // A late message from the previous port cannot complete a new request.
  h.ports[0].onMessage.emit({ requestId: p.sent[0].requestId, success: true, version: 'stale' });
  p.onMessage.emit({ requestId: p.sent[0].requestId, success: true, version: 'new' });
  assert.equal((await second).version, 'new'); h.client.close(); assert.equal(errors.length, 1);
});
test('native request timeout is visible and removes its waiter', async () => {
  let expire;
  const runtime = { connectNative() { return { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }; } };
  const client = createClient(runtime, { setTimeout: fn => { expire = fn; return 1; }, clearTimeout() {} });
  const pending = client.request('start'); expire(); await assert.rejects(pending, /超时/); client.close();
});
