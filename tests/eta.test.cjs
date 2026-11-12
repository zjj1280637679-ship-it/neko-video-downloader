const test = require('node:test');
const assert = require('node:assert/strict');
const { createEtaEstimator, createClient, parsePlaylist } = require('../hls-core.js');

test('ETA waits for three real samples and two seconds, includes stalls, then expires', () => {
  let now = 0;
  const eta = createEtaEstimator({ totalSegments: 10, now: () => now });
  assert.equal(eta.metrics().etaSeconds, null);
  now = 500; eta.recordNetwork(0, 100);
  now = 1000; eta.recordNetwork(1, 100);
  now = 1500; eta.recordNetwork(2, 100);
  assert.equal(eta.metrics().etaSeconds, null);
  now = 3000;
  assert.deepEqual(eta.metrics(), { etaSeconds: 7, etaBasis: 'network-segments' });
  now = 6000;
  assert.equal(eta.metrics().etaSeconds, 14, 'Backoff/stall time decreases effective throughput');
  now = 14000;
  assert.equal(eta.metrics().etaSeconds, null, 'A stale sample must not promise a countdown');
});

test('cached segments reduce remaining work without becoming speed or size samples', () => {
  let now = 0;
  const eta = createEtaEstimator({ totalSegments: 10, now: () => now });
  for (let i = 0; i < 6; i++) eta.recordCached(i);
  now = 3000;
  assert.equal(eta.metrics().etaSeconds, null);
  for (let i = 6; i < 9; i++) eta.recordNetwork(i, 100);
  assert.equal(eta.metrics().etaSeconds, 1);
  eta.recordNetwork(8, 1000000); // Duplicate/old completions do not add throughput.
  assert.equal(eta.metrics().etaSeconds, 1);
  eta.recordCached(9);
  assert.equal(eta.metrics().etaSeconds, null, 'Writing/final save time cannot be estimated from network samples');
});

test('a new attempt starts without inherited speed, and finished attempts expose no ETA', () => {
  let now = 0;
  const eta = createEtaEstimator({ totalSegments: 10, now: () => now });
  now = 3000;
  for (let i = 0; i < 3; i++) eta.recordNetwork(i, 100);
  assert.equal(eta.metrics().etaSeconds, 7);
  eta.finish();
  assert.equal(eta.metrics().etaSeconds, null);
  const retry = createEtaEstimator({ totalSegments: 10, now: () => now });
  for (let i = 0; i < 3; i++) retry.recordCached(i);
  now += 3000;
  assert.equal(retry.metrics().etaSeconds, null);
});

test('actual ordered downloader emits transfer ETA and clears it after the last network segment', async () => {
  let now = 0;
  const metrics = [], written = [];
  const plan = parsePlaylist('#EXTM3U\n' + Array.from({ length: 10 }, (_, i) => `#EXTINF:5,\n${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST', 'https://fixture.test/list.m3u8');
  const client = createClient({ now: () => now, retries: 1, async fetch() {
    now += 1000;
    return new Response(Uint8Array.of(71, 1, 2, 3));
  }, onMetrics(value) { metrics.push(value); } });
  await client.download(plan, { async write(bytes) { written.push(bytes); } }, () => {}, 1);
  assert.equal(written.length, 10);
  assert.ok(metrics.some(value => value.etaSeconds === 7 && value.etaBasis === 'network-segments'));
  assert.equal(metrics.at(-1).etaSeconds, null);
});
