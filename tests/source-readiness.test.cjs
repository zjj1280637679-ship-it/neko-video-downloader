const test = require('node:test');
const assert = require('node:assert/strict');
const { createBroker } = require('../engine/source-readiness.js');
const { parse } = require('../domain/sites.js');
const part = n => 'https://www.bilibili.com/video/BV1xx411c7mD/?p=' + n;
const success = ({ url }) => ({ ...parse(url), success: true, readiness: 'ready', qualityLabel: '1080p' });

test('one anonymous measurement serves concurrent probes and clicks until its timestamp expires', async () => {
  let count = 0, time = 5000;
  const broker = createBroker({ parse, getTab: () => ({ url: part(2) }), now: () => time,
    probe: async payload => { count++; return success(payload); } });
  const request = { tabId: 1, url: part(2) };
  const [first, second] = await Promise.all([broker.check(request), broker.check({ ...request, force: true })]);
  assert.deepEqual(first, second);
  assert.equal(first.state, 'ready');
  time += first.ttlMs - 1;
  assert.equal((await broker.check(request)).checkedAt, first.checkedAt);
  assert.equal(count, 1);
  time++;
  assert.equal((await broker.check(request)).checkedAt, time);
  assert.equal(count, 2);
});

test('navigation during a probe and a host reply naming the wrong part cannot arm a new part', async () => {
  let current = part(1), finish, started;
  const inFlight = new Promise(resolve => { started = resolve; });
  const broker = createBroker({ parse, getTab: () => ({ url: current }),
    probe: ({ page }) => {
      if (page === 2) return success({ url: part(1) });
      started(); return new Promise(resolve => { finish = resolve; });
    } });
  const oldCheck = broker.check({ tabId: 1, url: current });
  await inFlight;
  current = part(2);
  const newCheck = broker.check({ tabId: 1, url: current });
  finish(success({ url: part(1) }));
  await assert.rejects(oldCheck, /切换/);
  assert.equal((await newCheck).state, 'unknown');
});

test('old or disconnected hosts leave readiness unknown and foreign pages never reach the host', async () => {
  let count = 0;
  const broker = createBroker({ parse, getTab: () => ({ url: part(1) }),
    probe: () => { count++; throw new Error('不支持的本地内核命令'); } });
  for (const url of [part(3), 'https://example.test/']) {
    await assert.rejects(broker.check({ tabId: 1, url }));
  }
  assert.equal(count, 0);
  const reply = await broker.check({ tabId: 1, url: part(1) });
  assert.equal(reply.state, 'unknown');
  assert.match(reply.reason, /更新/);
});

test('a failed download invalidates earlier evidence, including a probe still running', async () => {
  let started, finish, calls = 0;
  const during = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { finish = resolve; });
  const broker = createBroker({ parse, getTab: () => ({ url: part(1) }),
    probe: async payload => {
      if (++calls === 2) { started(); await wait; }
      return success(payload);
    } });
  const request = { url: part(1), tabId: 1 };
  assert.equal((await broker.check(request)).state, 'ready');
  broker.invalidate(request.url);
  const second = broker.check(request);
  await during;
  broker.invalidate(request.url);
  finish();
  assert.equal((await second).state, 'unknown');
  assert.equal((await broker.check({ ...request, force: true })).state, 'ready');
});
