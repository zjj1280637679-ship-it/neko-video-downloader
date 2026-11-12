'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, parsePlaylist } = require('../hls-core.js');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const plan = count => parsePlaylist('#EXTM3U\n' + Array.from({ length: count }, (_, i) => `#EXTINF:1,\n${i}.ts\n`).join('') + '#EXT-X-ENDLIST', 'https://fixture.test/list.m3u8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

function liveConcurrency(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { value = next; for (const listener of listeners) listener(); },
    get subscribers() { return listeners.size; }
  };
}

function streamingTransfer(count, concurrency, options = {}) {
  const cancellation = new AbortController(), requests = [], output = [], metrics = [], starts = [];
  const client = createClient({
    retries: 1, retryDelayMs: 0, metricsIntervalMs: 60000, ...options, signal: cancellation.signal,
    onMetrics: value => metrics.push(value),
    fetch: async (url, { signal }) => {
      const index = Number(/(\d+)\.ts/.exec(url)[1]);
      let ended = false, controller;
      const abort = () => { if (!ended) { ended = true; request.aborted = true; controller.error(signal.reason); } };
      const request = { index, aborted: false,
        finish() { if (ended) throw new Error('Response already ended'); ended = true; signal.removeEventListener('abort', abort);
          controller.enqueue(Uint8Array.of(index % 256, 255)); controller.close(); },
        fail() { ended = true; signal.removeEventListener('abort', abort); controller.error(new Error('stream interrupted')); }
      };
      const body = new ReadableStream({ start(value) { controller = value; }, cancel() { ended = true; signal.removeEventListener('abort', abort); } });
      signal.addEventListener('abort', abort, { once: true });
      requests.push(request);
      for (const wake of starts.splice(0)) wake();
      return new Response(body, { headers: { 'Content-Length': '2' } });
    }
  });
  const result = client.download(plan(count), {
    async write(bytes) { await options.write?.(bytes); output.push(Buffer.from(bytes)); }
  }, undefined, concurrency);
  return { result, cancellation, requests, output, metrics,
    async request(index, attempt = 1) {
      for (;;) {
        const found = requests.filter(request => request.index === index)[attempt - 1];
        if (found) return found;
        await new Promise(resolve => starts.push(resolve));
      }
    }
  };
}

test('actual body arrival is visible before any segment completes, independently of ETA', async () => {
  let now = 0;
  const readers = [], observations = [], output = [];
  const client = createClient({ now: () => now, metricsIntervalMs: 10, retries: 1,
    fetch: async () => new Response(new ReadableStream({ start(controller) { readers.push(controller); } })),
    onMetrics: value => observations.push(value) });
  const pending = client.download(plan(2), { async write(bytes) { output.push(Buffer.from(bytes)); } });
  await wait(0);
  try {
    now = 1000; readers[0].enqueue(Uint8Array.of(1, 2, 3));
    await wait(20);
    const sample = observations.at(-1);
    assert.equal(output.length, 0);
    assert.equal(sample.sampleCount, 0);
    assert.equal(sample.etaSeconds, null);
    assert.equal(sample.inFlightRequests, 2);
    assert.equal(sample.bufferedBytes, 3);
    assert.ok(sample.networkBytesPerSecond > 0);
  } finally {
    now = 1500; readers[0].close(); readers[1].enqueue(Uint8Array.of(4)); readers[1].close(); await pending;
  }
  assert.deepEqual(Buffer.concat(output), Buffer.from([1, 2, 3, 4]));
});

test('waiting for local payload budget does not cause network timeout or retries', async () => {
  const gate = deferred(), output = [], retries = [];
  let writes = 0, requests = 0;
  const client = createClient({ timeoutMs: 15, maxResourceBytes: 1024, maxBufferedBytes: 4096,
    fetch: async url => { requests++; return new Response(Buffer.alloc(1024, Number(/(\d+)\.ts/.exec(url)[1]) + 1), { headers: { 'Content-Length': '1024' } }); },
    onRetry: value => retries.push(value) });
  const pending = client.download(plan(8), { async write(bytes) { if (++writes === 1) await gate.promise; output.push(Buffer.from(bytes)); } }, undefined, 3);
  try { await wait(65); } finally { gate.resolve(); await pending; }
  assert.equal(requests, 8);
  assert.equal(retries.length, 0);
  assert.deepEqual(output.map(bytes => bytes[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('later cache failure promptly aborts a waiting head request', async () => {
  let headAborted = false;
  const client = createClient({ retries: 1, fetch: async (url, { signal }) => {
    if (url.endsWith('/0.ts')) return new Promise((resolve, reject) => signal.addEventListener('abort', () => { headAborted = true; reject(signal.reason); }, { once: true }));
    return new Response(Uint8Array.of(1));
  } });
  const result = client.download(plan(2), { async write() {} }, undefined, 2, {
    async putSegment() { throw new DOMException('Disk quota exhausted', 'QuotaExceededError'); }
  });
  await assert.rejects(result, error => error.stage === 'cache-write' && /Disk quota/.test(error.message));
  assert.equal(headAborted, true);
});

test('a retried head progresses under buffer pressure without changing selected concurrency', async () => {
  let headAttempts = 0;
  const cancellation = new AbortController(), output = [], observed = [];
  const timer = setTimeout(() => cancellation.abort(new Error('head permit deadlock')), 500);
  try {
    const client = createClient({ signal: cancellation.signal, retries: 2, retryDelayMs: 0,
      maxResourceBytes: 1024, maxBufferedBytes: 4096,
      onMetrics: value => observed.push(value),
      fetch: async url => {
        const index = Number(/(\d+)\.ts/.exec(url)[1]);
        if (index === 0 && ++headAttempts === 1) return new Response('', { status: 429 });
        return new Response(Buffer.alloc(1024, index + 1), { headers: { 'Content-Length': '1024' } });
      } });
    await client.download(plan(4), { async write(bytes) { output.push(Buffer.from(bytes)[0]); } }, undefined, 3);
    assert.deepEqual(output, [1, 2, 3, 4]);
    assert.equal(headAttempts, 2);
    assert.ok(observed.every(item => item.targetConcurrency === 3));
  } finally { clearTimeout(timer); }
});

test('encoded Content-Length is not treated as decompressed body size', async () => {
  const output = [];
  const client = createClient({ maxResourceBytes: 2048, maxBufferedBytes: 8192, retries: 1,
    fetch: async () => new Response(Buffer.alloc(1024, 71), { headers: { 'Content-Length': '20', 'Content-Encoding': 'gzip' } }) });
  await client.download(plan(2), { async write(bytes) { output.push(bytes.byteLength); } });
  assert.deepEqual(output, [1024, 1024]);
});

test('live increases fill immediately and decreases retain streams while preserving output order', { timeout: 2000 }, async () => {
  const concurrency = liveConcurrency(1), h = streamingTransfer(8, concurrency);
  try {
    assert.deepEqual(h.requests.map(request => request.index), [0]);
    concurrency.set(3);
    assert.deepEqual(h.requests.map(request => request.index), [0, 1, 2]);
    assert.equal(h.metrics.at(-1).targetConcurrency, 3);
    assert.equal(h.metrics.at(-1).activeConcurrency, 3);
    (await h.request(2)).finish(); (await h.request(1)).finish();
    await h.request(4); await settle();
    assert.equal(h.output.length, 0);
    concurrency.set(1);
    (await h.request(4)).finish(); (await h.request(3)).finish();
    await settle();
    assert.deepEqual(h.requests.map(request => request.index), [0, 1, 2, 3, 4]);
    assert.equal(h.requests.some(request => request.aborted), false);
    (await h.request(0)).finish();
    (await h.request(5)).finish();
    await h.request(6);
    concurrency.set(2);
    assert.equal(h.requests.at(-1).index, 7);
    (await h.request(7)).finish(); (await h.request(6)).finish();
    assert.equal((await h.result).completed, 8);
    assert.deepEqual(h.output.map(bytes => bytes[0]), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(concurrency.subscribers, 0);
  } finally { h.cancellation.abort(); await h.result.catch(() => {}); }
});

test('a downshift keeps the existing fragment retry slot without admitting another segment', { timeout: 2000 }, async () => {
  const concurrency = liveConcurrency(3), h = streamingTransfer(5, concurrency, { retries: 2 });
  try {
    concurrency.set(1);
    (await h.request(1)).fail();
    const retry = await h.request(1, 2);
    assert.deepEqual(h.requests.map(request => request.index), [0, 1, 2, 1]);
    retry.finish(); (await h.request(2)).finish();
    await settle();
    assert.equal(h.requests.length, 4);
    (await h.request(0)).finish();
    (await h.request(3)).finish();
    (await h.request(4)).finish();
    await h.result;
    assert.deepEqual(h.output.map(bytes => bytes[0]), [0, 1, 2, 3, 4]);
    assert.equal(concurrency.subscribers, 0);
  } finally { h.cancellation.abort(); await h.result.catch(() => {}); }
});

test('rapid live changes honor the full 375 limit and cancellation detaches the control', { timeout: 3000 }, async () => {
  const concurrency = liveConcurrency(1), h = streamingTransfer(400, concurrency);
  concurrency.set(375);
  assert.equal(h.requests.length, 375);
  concurrency.set(2); concurrency.set(64); concurrency.set(1);
  assert.equal(h.requests.length, 375);
  assert.equal(h.metrics.at(-1).targetConcurrency, 1);
  h.cancellation.abort(new DOMException('test cancel', 'AbortError'));
  await assert.rejects(h.result, { name: 'AbortError' });
  assert.equal(h.requests.every(request => request.aborted), true);
  assert.equal(concurrency.subscribers, 0);
  const samples = h.metrics.length;
  concurrency.set(375);
  await settle();
  assert.equal(h.requests.length, 375);
  assert.equal(h.metrics.length, samples);
});

test('sink failure aborts remaining streams and detaches a live concurrency subscription', { timeout: 2000 }, async () => {
  const concurrency = liveConcurrency(2);
  const h = streamingTransfer(4, concurrency, { async write() { throw new Error('disk unavailable'); } });
  (await h.request(0)).finish();
  await assert.rejects(h.result, error => error.stage === 'sink-write' && /disk unavailable/.test(error.message));
  assert.equal(concurrency.subscribers, 0);
  assert.equal(h.requests.filter(request => request.index !== 0).every(request => request.aborted), true);
  const count = h.requests.length;
  concurrency.set(375); await settle();
  assert.equal(h.requests.length, count);
});
