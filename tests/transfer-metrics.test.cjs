const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('../engine/transfer-metrics.js');

test('body bytes show before completion, decay during stalls and stop after finish', () => {
  let now = 0; const tracker = createTracker({ now: () => now });
  tracker.onRequestStart(1); now = 1000; tracker.onBytes(1, 1000);
  assert.equal(tracker.metrics().bytesPerSecond, 1000);
  assert.equal(tracker.metrics().sampleCount, 0);
  now = 6000; assert.equal(tracker.metrics().bytesPerSecond, 0);
  tracker.onBytes(1, 1000); tracker.finish(); assert.equal(tracker.metrics().bytesPerSecond, 0);
});

test('failed requests and later invalid payloads do not inflate useful speed', () => {
  let now = 0; const tracker = createTracker({ now: () => now });
  tracker.onRequestStart(1); now = 1000; tracker.onBytes(1, 1000); tracker.onRequestEnd(1, { ok: false });
  tracker.onRequestStart(2); now = 1500; tracker.onBytes(2, 2000); tracker.onRequestEnd(2, { ok: true });
  tracker.onRequestInvalid(2); tracker.onRequestInvalid(2);
  const metrics = tracker.metrics();
  assert.equal(metrics.bytesPerSecond, 0); assert.equal(metrics.networkBytesPerSecond, 2000);
  assert.equal(metrics.sampleCount, 0); assert.equal(metrics.inFlightRequests, 0);
  assert.equal(Object.hasOwn(metrics, 'targetConcurrency'), false);
});
