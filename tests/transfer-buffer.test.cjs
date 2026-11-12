const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { createBuffer } = require('../engine/transfer-buffer.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
function observe(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  state.promise = promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}

test('later segments cannot consume the head reserve, so the writer head can always reach its resource limit', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    await buffer.reserve(1, 4); // Eight copied bytes.
    await buffer.reserve(2, 2); // Four copied bytes; the remaining twenty belong to the head.
    const next = observe(buffer.reserve(3, 1, controller.signal));
    await tick();
    assert.equal(next.settled, false, 'Another later segment must wait instead of starving segment zero');
    assert.equal(buffer.stats().reservedBytes, 12);
    await buffer.reserve(0, 10);
    assert.equal(buffer.stats().reservedBytes, 32, 'The head can still reserve its entire two-copy resource limit');
    assert.equal(buffer.stats().peakReservedBytes, 32);
    assert.equal(buffer.stats().waiting, 1);
    controller.abort(); await next.promise;
    assert.equal(next.error.name, 'AbortError');
  } finally { controller.abort(); buffer.release(0); buffer.release(1); buffer.release(2); buffer.release(3); }
});

test('a later streaming segment grows chunk by chunk, waits at the protected boundary, then advances with the writer', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    await buffer.reserve(0, 2);
    await buffer.reserve(1, 2);
    await buffer.reserve(1, 4);
    await buffer.reserve(1, 6);
    assert.equal(buffer.stats().reservedBytes, 16);
    const growing = observe(buffer.reserve(1, 7, controller.signal));
    await tick();
    assert.equal(growing.settled, false);
    assert.equal(buffer.stats().reservedBytes, 16, 'A waiting growth request must not charge unallocated bytes');
    await buffer.reserve(0, 10);
    assert.equal(buffer.stats().reservedBytes, 32);
    buffer.release(0);
    await tick();
    assert.equal(growing.settled, false, 'Release alone preserves the old writer position until advance');
    buffer.advance(1);
    await growing.promise;
    assert.equal(growing.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 14);
    assert.equal(buffer.stats().waiting, 0);
    await buffer.reserve(1, 10);
    assert.equal(buffer.stats().reservedBytes, 20);
  } finally { controller.abort(); buffer.release(0); buffer.release(1); }
});

test('releasing the completed head and advancing wakes the new head ahead of queued later demand', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 20, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    await buffer.reserve(0, 10);
    // The farther request enters the wait queue first; queue order must not defeat head protection.
    const later = observe(buffer.reserve(2, 1, controller.signal));
    const nextHead = observe(buffer.reserve(1, 10, controller.signal));
    await tick();
    assert.equal(buffer.stats().waiting, 2);
    buffer.release(0); buffer.advance(1);
    await nextHead.promise;
    assert.equal(nextHead.error, undefined);
    await tick();
    assert.equal(later.settled, false);
    assert.equal(buffer.stats().reservedBytes, 20);
    buffer.release(1); buffer.advance(2);
    await later.promise;
    assert.equal(later.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 2);
    assert.equal(buffer.stats().waiting, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'Successful admissions must detach wait listeners');
  } finally { controller.abort(); for (const index of [0, 1, 2]) buffer.release(index); }
});

test('aborting a waiting growth clears its waiter without losing the already-accounted payload', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 24, resourceLimitBytes: 10 });
  const controller = new AbortController(), reason = new Error('User cancelled this segment');
  await buffer.reserve(1, 2);
  const growing = observe(buffer.reserve(1, 3, controller.signal));
  await tick();
  assert.equal(buffer.stats().waiting, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(reason); await growing.promise;
  assert.equal(growing.error, reason);
  assert.equal(buffer.stats().waiting, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(buffer.stats().reservedBytes, 4, 'Only the owner can release previously acquired bytes');
  buffer.release(1); buffer.release(1);
  assert.equal(buffer.stats().reservedBytes, 0, 'Owner cleanup and repeated cleanup must not make usage negative');
  buffer.advance(1); await tick();
  assert.equal(buffer.stats().waiting, 0, 'Cancelled work must not rejoin the waiter set after a notification');
});

test('an already-aborted request neither allocates nor waits', async () => {
  const buffer = createBuffer({ budgetBytes: 40, resourceLimitBytes: 10 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(buffer.reserve(0, 10, controller.signal), { name: 'AbortError' });
  assert.deepEqual(buffer.stats(), { reservedBytes: 0, peakReservedBytes: 0, budgetBytes: 40, waiting: 0 });
});

test('resource limits reject oversized or malformed payload sizes without changing reservations', async () => {
  const buffer = createBuffer({ budgetBytes: 40, resourceLimitBytes: 10 });
  await buffer.reserve(0, 4);
  for (const invalid of [-1, 1.5, NaN, Infinity, '4', 11, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(buffer.reserve(0, invalid), /资源上限/);
    assert.equal(buffer.stats().reservedBytes, 8);
    assert.equal(buffer.stats().waiting, 0);
  }
  await buffer.reserve(0, 10); // Exact payload limit remains supported.
  assert.equal(buffer.stats().reservedBytes, 20);
  buffer.release(0);
});

test('accounting replaces each payload reservation, includes two copies, and preserves its peak after release', async () => {
  const buffer = createBuffer({ budgetBytes: 64, resourceLimitBytes: 10 });
  await buffer.reserve(0, 4);
  await buffer.reserve(0, 4);
  assert.equal(buffer.stats().reservedBytes, 8, 'Re-reporting an unchanged chunk total is idempotent');
  await buffer.reserve(0, 7);
  await buffer.reserve(1, 5);
  assert.equal(buffer.stats().reservedBytes, 24);
  await buffer.reserve(0, 2);
  assert.equal(buffer.stats().reservedBytes, 14);
  await buffer.reserve(1, 0);
  assert.equal(buffer.stats().reservedBytes, 4);
  buffer.release(999); buffer.release(0); buffer.release(1); buffer.release(0);
  assert.deepEqual(buffer.stats(), { reservedBytes: 0, peakReservedBytes: 24, budgetBytes: 64, waiting: 0 });
});

test('shrinking an existing reservation wakes waiting work without oversubscribing the total budget', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 40, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    await buffer.reserve(0, 10); await buffer.reserve(1, 8);
    const waiting = observe(buffer.reserve(2, 3, controller.signal));
    await tick(); assert.equal(waiting.settled, false);
    await buffer.reserve(1, 5);
    await waiting.promise;
    assert.equal(waiting.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 36);
    assert.ok(buffer.stats().peakReservedBytes <= buffer.stats().budgetBytes);
  } finally { controller.abort(); for (const index of [0, 1, 2]) buffer.release(index); }
});

test('a too-small configured budget still protects one full head, and draining removes only the head guard', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 8, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    assert.equal(buffer.stats().budgetBytes, 20);
    const waiting = observe(buffer.reserve(2, 10, controller.signal));
    await tick(); assert.equal(waiting.settled, false);
    buffer.drain(); await waiting.promise;
    assert.equal(waiting.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 20);
    const overBudget = observe(buffer.reserve(3, 1, controller.signal));
    await tick(); assert.equal(overBudget.settled, false, 'Draining must not disable total memory accounting');
    buffer.release(2); await overBudget.promise;
    assert.equal(overBudget.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 2);
    assert.equal(buffer.stats().peakReservedBytes, 20);
  } finally { controller.abort(); buffer.release(2); buffer.release(3); }
});

test('a late trusted head length wakes later reads while preserving the full declared head payload', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    buffer.setExpectedSize(1, 6);
    await buffer.reserve(1, 6);
    const later = observe(buffer.reserve(2, 8, controller.signal));
    await tick(); assert.equal(later.settled, false);
    buffer.setExpectedSize(0, 2);
    await later.promise;
    assert.equal(later.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 28);
    await buffer.reserve(0, 2);
    assert.equal(buffer.stats().reservedBytes, 32, 'The smaller trusted head still has its complete two-copy allowance');
    await assert.rejects(buffer.reserve(0, 3), /超过声明大小/);
    assert.equal(buffer.stats().reservedBytes, 32);
  } finally { controller.abort(); for (const index of [0, 1, 2]) buffer.release(index); }
});

test('advancing uses the next head declaration and not the old head or the unknown-size limit', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    buffer.setExpectedSize(1, 2);
    buffer.setExpectedSize(2, 6);
    await buffer.reserve(2, 6);
    const later = observe(buffer.reserve(3, 8, controller.signal));
    await tick(); assert.equal(later.settled, false);
    buffer.advance(1);
    await later.promise;
    assert.equal(later.error, undefined);
    await buffer.reserve(1, 2);
    assert.equal(buffer.stats().reservedBytes, 32);
    assert.equal(buffer.stats().waiting, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { controller.abort(); for (const index of [1, 2, 3]) buffer.release(index); }
});

test('trusted declarations validate index and size and cannot change during one attempt', async () => {
  const buffer = createBuffer({ budgetBytes: 40, resourceLimitBytes: 10 });
  for (const invalid of [-1, 1.5, NaN, Infinity, '4', 11, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buffer.setExpectedSize(0, invalid), /资源上限/);
  }
  for (const invalid of [-1, 1.5, NaN, Infinity, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buffer.setExpectedSize(invalid, 4), /序号/);
  }
  buffer.setExpectedSize(0, 4); buffer.setExpectedSize(0, 4);
  assert.equal(buffer.stats().reservedBytes, 0, 'A declaration protects capacity without charging unreceived data');
  assert.throws(() => buffer.setExpectedSize(0, 8), /不能改变/);
  await assert.rejects(buffer.reserve(0, 5), /超过声明大小/);
  await buffer.reserve(0, 4);
  buffer.release(0);
  buffer.setExpectedSize(0, 8); // A retry may have a different validated response length.
  await buffer.reserve(0, 8);
  assert.equal(buffer.stats().reservedBytes, 16);
  buffer.release(0);
  await buffer.reserve(0, 10); // Released declarations cannot constrain a later unknown-length attempt.
  assert.equal(buffer.stats().reservedBytes, 20);
});

test('a declaration smaller than an acquired reservation is rejected without rewriting its guard', async () => {
  const buffer = createBuffer({ budgetBytes: 40, resourceLimitBytes: 10 });
  await buffer.reserve(0, 4);
  assert.throws(() => buffer.setExpectedSize(0, 3), /小于已预留正文大小/);
  assert.equal(buffer.stats().reservedBytes, 8);
  buffer.setExpectedSize(0, 5);
  await buffer.reserve(0, 5);
  await assert.rejects(buffer.reserve(0, 6), /超过声明大小/);
  assert.equal(buffer.stats().reservedBytes, 10);
});

test('a late declaration rejects an oversized pending growth and removes its abort listener', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 20, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    await buffer.reserve(0, 10);
    const waiting = observe(buffer.reserve(1, 6, controller.signal));
    await tick(); assert.equal(buffer.stats().waiting, 1);
    buffer.setExpectedSize(1, 5);
    await waiting.promise;
    assert.match(waiting.error.message, /超过声明大小/);
    assert.equal(buffer.stats().reservedBytes, 20);
    assert.equal(buffer.stats().waiting, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { controller.abort(); buffer.release(0); buffer.release(1); }
});

test('zero-length declarations and draining free only the head guard, never size checks or accounting', async () => {
  const buffer = createBuffer({ budgetBytes: 20, resourceLimitBytes: 10 });
  buffer.setExpectedSize(0, 0);
  await buffer.reserve(0, 0);
  await buffer.reserve(1, 10);
  assert.equal(buffer.stats().reservedBytes, 20);
  await assert.rejects(buffer.reserve(0, 1), /超过声明大小/);
  buffer.drain();
  await assert.rejects(buffer.reserve(0, 1), /超过声明大小/);
  buffer.release(1);
  await buffer.reserve(2, 10);
  assert.equal(buffer.stats().reservedBytes, 20);
  assert.equal(buffer.stats().peakReservedBytes, 20);
});

test('small trusted current heads cannot let later data starve a larger next head', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    buffer.setExpectedSize(0, 1); buffer.setExpectedSize(1, 3);
    await buffer.reserve(0, 1); await buffer.reserve(2, 10);
    const later = observe(buffer.reserve(3, 4, controller.signal));
    await tick(); assert.equal(later.settled, false, 'Index three must leave enough for index one after the small current head leaves');
    buffer.release(0); buffer.advance(1);
    await buffer.reserve(1, 3);
    assert.equal(buffer.stats().reservedBytes, 26, 'The new head can immediately reach its entire declared size');
    await tick(); assert.equal(later.settled, false);
    buffer.release(1); buffer.advance(2);
    await later.promise;
    assert.equal(later.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 28);
    assert.ok(buffer.stats().peakReservedBytes <= buffer.stats().budgetBytes);
  } finally { controller.abort(); for (const index of [0, 1, 2, 3]) buffer.release(index); }
});

test('unknown future heads keep their full limit until a trusted declaration arrives', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  const controller = new AbortController();
  try {
    buffer.setExpectedSize(0, 1); await buffer.reserve(0, 1);
    const later = observe(buffer.reserve(2, 8, controller.signal));
    await tick(); assert.equal(later.settled, false, 'Unknown index one still needs twenty copied bytes after index zero completes');
    buffer.setExpectedSize(1, 3); await later.promise;
    assert.equal(later.error, undefined);
    assert.equal(buffer.stats().reservedBytes, 18);
    buffer.release(0); buffer.advance(1);
    await buffer.reserve(1, 3);
    assert.equal(buffer.stats().reservedBytes, 22);
  } finally { controller.abort(); for (const index of [0, 1, 2]) buffer.release(index); }
});

test('future-head accounting subtracts predecessors that will be released and skips huge unknown gaps', { timeout: 1500 }, async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  await buffer.reserve(0, 10);
  await buffer.reserve(1, 6);
  assert.equal(buffer.stats().reservedBytes, 32, 'A future unknown head reuses the current head space; guards must not be summed');
  buffer.release(0); buffer.release(1);
  buffer.setExpectedSize(0, 1);
  await buffer.reserve(Number.MAX_SAFE_INTEGER, 6);
  assert.equal(buffer.stats().reservedBytes, 12, 'A sparse far-ahead reservation still protects every equivalent unknown gap without scanning it');
});

test('a larger retry declaration fails promptly when retained later data makes its new head guard impossible', async () => {
  const buffer = createBuffer({ budgetBytes: 32, resourceLimitBytes: 10 });
  buffer.setExpectedSize(0, 1); buffer.setExpectedSize(1, 10); buffer.setExpectedSize(2, 4);
  await buffer.reserve(0, 1); await buffer.reserve(1, 10); await buffer.reserve(2, 4);
  buffer.release(0);
  assert.throws(() => buffer.setExpectedSize(0, 3), /缓冲保护冲突/);
  assert.equal(buffer.stats().waiting, 0);
  assert.equal(buffer.stats().reservedBytes, 28);
  buffer.setExpectedSize(0, 1); // Retrying with the original bound is still safe.
  await buffer.reserve(0, 1);
  assert.equal(buffer.stats().reservedBytes, 30);
});
