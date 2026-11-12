const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { parsePlaylist, parseIv, sequenceToIv, createClient, safeFilename, absolutizePlaylist } = require('../hls-core.js');
const BASE = 'https://fixture.test/video/list.m3u8';
const playlist = (body, end = true) => `#EXTM3U\n${body}\n${end ? '#EXT-X-ENDLIST' : ''}\n`;
const segment = name => `#EXTINF:5.5,\n${name}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function response(body, url, init) {
  const value = new Response(body, init);
  if (url) Object.defineProperty(value, 'url', { value: url });
  return value;
}
function client(fetcher, extra = {}) { return createClient({ fetch: fetcher, crypto: webcrypto, retries: 1, ...extra }); }
function collectSink() {
  const chunks = [];
  return { chunks, async write(data) { chunks.push(Buffer.from(data)); } };
}

test('identity AES remains usable alongside unknown KEYFORMAT and decrypts the actual bytes', async () => {
  const keyBytes = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const plain = Uint8Array.of(71, 21, 22, 23);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: sequenceToIv(0) }, key, plain);
  for (const tags of [
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="unknown",URI="drm"',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="unknown",URI="drm"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'
  ]) {
    const p = parsePlaylist(playlist(tags + '\n' + segment('a.ts')), BASE);
    const sink = collectSink();
    await client(async url => new Response(url.endsWith('key.bin') ? keyBytes : encrypted)).download(p, sink);
    assert.deepEqual(Buffer.concat(sink.chunks), Buffer.from(plain));
  }
});

test('unused unknown keys do not prevent later METHOD=NONE segments', () => {
  const p = parsePlaylist(playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="unknown",URI="drm"\n#EXT-X-KEY:METHOD=NONE\n' + segment('a.ts')), BASE);
  assert.equal(p.segments[0].key, null);
});

test('invalid highest playlist falls back to the next listed variant and reports actual selection', async () => {
  const seen = [], selections = [];
  const c = client(async url => {
    seen.push(url);
    if (url === BASE) return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8', BASE);
    if (url.endsWith('high.m3u8')) return response('<html>login</html>', url);
    return response(playlist(segment('movie.ts')), 'https://redirect.test/final/low.m3u8');
  }, { onVariant(_variant, _total, selection) { selections.push(selection); } });
  const p = await c.loadPlan(BASE);
  assert.equal(seen.length, 3);
  assert.equal(p.segments[0].url, 'https://redirect.test/final/movie.ts');
  assert.equal(selections[0].rank, 2);
  assert.equal(selections[0].bandwidth, 100);
  assert.match(selections[0].failures[0], /有效.*清单/);
});

test('MPEG-TS MAP bytes determine the output container during preparation', async () => {
  const ts = new Uint8Array(188); ts[0] = 0x47;
  const c = client(async url => response(url.endsWith('init') ? ts : playlist('#EXT-X-MAP:URI="init"\n' + segment('movie.ts')), url));
  const p = await c.loadPlan(BASE);
  assert.equal(p.maps.size, 1);
  assert.equal(p.isFmp4, false);
});

test('response limits stop oversized streams without retrying or accumulating the full response', async () => {
  let requests = 0, cancelled = 0;
  const c = createClient({ maxResourceBytes: 4, retries: 6, retryDelayMs: 0, fetch: async () => {
    requests++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); controller.enqueue(Uint8Array.of(4, 5, 6)); },
      cancel() { cancelled++; }
    }));
  } });
  await assert.rejects(c.request('https://fixture.test/large.ts'), error => error.stage === 'resource-limit' && error.retryable === false);
  assert.equal(requests, 1);
  assert.equal(cancelled, 1);
});

test('declared response and playlist size limits reject before processing media', async () => {
  const resource = client(async () => new Response(Uint8Array.of(71), { headers: { 'content-length': '999' } }), { maxResourceBytes: 4 });
  await assert.rejects(resource.request('https://fixture.test/large.ts'), /处理上限/);
  const manifest = client(async url => response(playlist(segment('a.ts')), url), { maxPlaylistBytes: 16 });
  await assert.rejects(manifest.loadPlan(BASE), /播放清单.*上限/);
});

test('environment scheduler records requests and preserves ordered bounded output', async () => {
  let now = 0, active = 0, maxActive = 0, written = 0;
  const gates = new Map(), metrics = [], progress = [];
  const plan = parsePlaylist(playlist(Array.from({ length: 28 }, (_, index) => segment(`${index}.ts`)).join('\n')), BASE);
  const output = [];
  const task = client(async url => {
    const index = Number(url.match(/(\d+)\.ts$/)[1]);
    assert.ok(index < written + 512, 'pending reorder window is bounded independently of active requests');
    const gate = deferred(); gates.set(index, gate);
    maxActive = Math.max(maxActive, ++active);
    await gate.promise; active--;
    return response(Buffer.alloc(1000, index + 1));
  }, { now: () => now, onMetrics: item => metrics.push(item) }).download(plan, {
    async write(data) { output.push(new Uint8Array(data)[0]); written++; }
  }, item => progress.push(item), 'auto');
  await tick();
  assert.equal(gates.size, 28);
  for (let index = 0; index < 28; index++) {
    assert.ok(gates.has(index), `segment ${index} is scheduled`);
    now += 1000;
    gates.get(index).resolve();
    await tick();
  }
  await task;
  assert.deepEqual(output, Array.from({ length: 28 }, (_, index) => index + 1));
  assert.ok(metrics.some(item => item.inFlightRequests > 0 && item.responseSampleCount > 0));
  assert.equal(maxActive, 28);
  assert.ok(metrics.every(item => item.reservedBufferBytes <= item.bufferBudgetBytes));
  assert.ok(progress.every(item => item.concurrencyMode === 'manual' && Number.isFinite(item.bytesPerSecond)));
  assert.equal(metrics.at(-1).bytesPerSecond, 0);
});

test('cached segments contribute output bytes but no network speed or concurrency learning', async () => {
  let now = 0;
  const metrics = [], progress = [];
  const plan = parsePlaylist(playlist(Array.from({ length: 20 }, (_, index) => segment(`${index}.ts`)).join('\n')), BASE);
  const result = await client(() => { throw new Error('cache must avoid network'); }, {
    now: () => now, onMetrics: item => metrics.push(item)
  }).download(plan, collectSink(), item => progress.push(item), 'auto', {
    async getSegment() { now += 1000; return new ArrayBuffer(1000); }
  });
  assert.equal(result.bytes, 20000);
  assert.ok(metrics.every(item => item.bytesPerSecond === 0 && item.activeConcurrency === 64));
  assert.ok(progress.every(item => item.bytesPerSecond === 0));
});

test('speed fluctuations and errors never change the selected concurrency', async () => {
  const plan = parsePlaylist(playlist(Array.from({ length: 3 }, (_, index) => segment(`${index}.ts`)).join('\n')), BASE);
  for (const concurrency of ['auto', 5]) {
    let now = 0, failed = false;
    const metrics = [];
    await client(async url => {
      now += 2000;
      if (!failed && url.endsWith('/0.ts')) { failed = true; return response('busy', null, { status: 500 }); }
      return response(Buffer.alloc(1000));
    }, { now: () => now, retries: 2, retryDelayMs: 0, onMetrics: item => metrics.push(item) })
      .download(plan, collectSink(), undefined, concurrency);
    if (concurrency === 'auto') {
      assert.ok(metrics.every(item => item.activeConcurrency === 64));
      assert.ok(metrics.every(item => item.concurrencyReason !== 'errors'));
    } else assert.ok(metrics.every(item => item.activeConcurrency === 5 && item.concurrencyMode === 'manual'));
    assert.equal(metrics.at(-1).bytesPerSecond, 0);
  }
});

test('metrics decay to zero while requests are stalled, before download completion', async () => {
  let now = 0;
  const gates = [deferred(), deferred()], metrics = [];
  const plan = parsePlaylist(playlist(segment('0.ts') + '\n' + segment('1.ts')), BASE);
  const task = client(async url => {
    await gates[Number(url.match(/(\d+)\.ts$/)[1])].promise;
    return response(Buffer.alloc(1000));
  }, { now: () => now, onMetrics: item => metrics.push(item) }).download(plan, collectSink(), undefined, 'auto');
  now = 1000; gates[0].resolve();
  await tick();
  assert.ok(metrics.some(item => item.bytesPerSecond > 0));
  now = 7000;
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(metrics.at(-1).bytesPerSecond, 0);
  gates[1].resolve();
  await task;
  const count = metrics.length;
  await tick();
  assert.equal(metrics.length, count, 'no telemetry emitted after the task settles');
});

test('short IV pads to 128 bits and sequence IV preserves integers beyond 2^53', () => {
  assert.equal(Buffer.from(parseIv('0x00000000000000000000000000000000')).toString('hex'), '00000000000000000000000000000000');
  assert.equal(Buffer.from(parseIv('0x1')).toString('hex'), '00000000000000000000000000000001');
  assert.equal(Buffer.from(sequenceToIv('9007199254740993')).toString('hex'), '00000000000000000020000000000001');
  assert.throws(() => parseIv('0xZZ'), /IV/);
});

test('playlist resolves URLs, tracks key rotation and implicit IV', () => {
  const plan = parsePlaylist(playlist('#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXT-X-KEY:METHOD=AES-128,URI="../enc.key"\n' + segment('one.ts') + '\n#EXT-X-KEY:METHOD=NONE\n' + segment('two.ts')), BASE);
  assert.equal(plan.segments[0].key.url, 'https://fixture.test/enc.key');
  assert.equal(plan.segments[0].sequence, '9007199254740993');
  assert.equal(plan.segments[1].key, null);
  assert.equal(plan.totalDuration, 11);
});

test('rejects HTML, live windows, missing init, unsupported encryption and preview-only streams', () => {
  assert.throws(() => parsePlaylist('<html>error</html>', BASE), /不是有效/);
  assert.throws(() => parsePlaylist(playlist(segment('x.ts'), false), BASE), /直播/);
  assert.throws(() => parsePlaylist(playlist(segment('x.m4s')), BASE), /初始化段/);
  assert.throws(() => parsePlaylist(playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n' + segment('x.ts')), BASE), /加密方式/);
  assert.throws(() => parsePlaylist(playlist('#EXT-X-I-FRAMES-ONLY\n' + segment('x.ts')), BASE), /关键帧/);
});

test('redirected playlists use final URL; highest complete variant is selected', async () => {
  const urls = [];
  const c = client(async url => {
    urls.push(url);
    if (urls.length === 1) return response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8', 'https://cdn.test/new/master.m3u8');
    return response(playlist(segment('one.ts')), url);
  });
  const plan = await c.loadPlan(BASE);
  assert.equal(urls[1], 'https://cdn.test/new/high.m3u8');
  assert.equal(plan.segments[0].url, 'https://cdn.test/new/one.ts');
});

test('does not silently export a stream that requires separate audio', async () => {
  const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900,AUDIO="a"\nvideo.m3u8';
  await assert.rejects(client(async url => response(text, url)).loadPlan(BASE), /音视频分轨/);
});

test('detects recursive master playlists', async () => {
  await assert.rejects(client(async url => response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlist.m3u8', url)).loadPlan(BASE), /循环引用/);
});

test('implicit byte range requires immediately preceding range of same resource', () => {
  const plan = parsePlaylist(playlist('#EXT-X-BYTERANGE:4@0\n' + segment('file.ts') + '\n#EXT-X-BYTERANGE:4\n' + segment('file.ts')), BASE);
  assert.deepEqual(plan.segments[1].byteRange, { length: 4, offset: 4 });
  assert.throws(() => parsePlaylist(playlist('#EXT-X-BYTERANGE:4\n' + segment('file.ts')), BASE), /隐式偏移/);
  assert.throws(() => parsePlaylist(playlist('#EXT-X-BYTERANGE:4@0\n' + segment('a.ts') + '\n#EXT-X-BYTERANGE:4\n' + segment('b.ts')), BASE), /隐式偏移/);
});

test('200 full body range is sliced and 206 is checked for exact range and length', async () => {
  const range = { length: 3, offset: 2 };
  const full = await client(async () => response(new Uint8Array([0, 1, 2, 3, 4, 5]))).request(BASE, range);
  assert.deepEqual([...new Uint8Array(full)], [2, 3, 4]);
  await assert.rejects(client(async () => response(new Uint8Array([2, 3, 4]))).request(BASE, range), /不足/);
  await assert.rejects(client(async () => response(new Uint8Array([2, 3]), null, { status: 206, headers: { 'Content-Range': 'bytes 2-4/6' } })).request(BASE, range), /不完整/);
  await assert.rejects(client(async () => response(new Uint8Array([2, 3, 4]), null, { status: 206, headers: { 'Content-Range': 'bytes 0-2/6' } })).request(BASE, range), /错误的字节范围/);
});

test('MAP identity includes byte range; changed initialization requires remux', async () => {
  const plan = parsePlaylist(playlist('#EXT-X-MAP:URI="init.mp4",BYTERANGE="2@0"\n' + segment('a.m4s') + '\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="2@2"\n' + segment('b.m4s')), BASE);
  assert.equal(plan.maps.size, 2);
  const sink = collectSink();
  await assert.rejects(client(async () => response('data')).download(plan, sink), /需要重新封装/);
  assert.equal(sink.chunks.length, 0);
});

test('one MAP byte range is prepended once to ordered fMP4 fragments', async () => {
  const plan = parsePlaylist(playlist('#EXT-X-MAP:URI="init.mp4",BYTERANGE="2@2"\n' + segment('a.m4s') + '\n' + segment('b.m4s')), BASE);
  const sink = collectSink();
  await client(async url => response(url.endsWith('init.mp4') ? Buffer.from('XXIN') : Buffer.from(url.endsWith('a.m4s') ? 'A' : 'B'))).download(plan, sink);
  assert.equal(Buffer.concat(sink.chunks).toString(), 'INAB');
});

test('unknown-length fragments refill requests while the first fragment is slow', async () => {
  const plan = parsePlaylist(playlist(Array.from({ length: 8 }, (_, i) => segment(`${i}.ts`)).join('\n')), BASE);
  let releaseFirst;
  const requested = [];
  const sink = collectSink();
  const pending = client(async url => {
    requested.push(url);
    if (url.endsWith('/0.ts')) await new Promise(resolve => { releaseFirst = resolve; });
    return response(new URL(url).pathname.match(/(\d+)\.ts/)[1]);
  }).download(plan, sink, () => {}, 3);
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(requested.length, 8);
    assert.equal(sink.chunks.length, 0);
  } finally { releaseFirst(); await pending; }
  assert.equal(Buffer.concat(sink.chunks).toString(), '01234567');
});

test('AES-128 decrypts all segments and concurrently requested key is fetched once', async () => {
  const rawKey = new Uint8Array(16).fill(7);
  const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
  const iv = parseIv('0x0');
  const payload = Buffer.from('deterministic media fixture');
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, payload);
  let keyReads = 0;
  const plan = parsePlaylist(playlist('#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00000000000000000000000000000000\n' + segment('a.ts') + '\n' + segment('b.ts')), BASE);
  const sink = collectSink();
  await client(async url => {
    if (url.endsWith('enc.key')) { keyReads++; return response(rawKey); }
    return response(encrypted);
  }).download(plan, sink);
  assert.equal(keyReads, 1);
  assert.equal(Buffer.concat(sink.chunks).toString(), payload.toString().repeat(2));
});

test('encrypted MAP requires IV and is decrypted before writing', async () => {
  const rawKey = new Uint8Array(16).fill(3);
  const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: parseIv('0x1') }, key, Buffer.from('INIT'));
  assert.throws(() => parsePlaylist(playlist('#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init"\n' + segment('one.m4s')), BASE), /显式 IV/);
  const plan = parsePlaylist(playlist('#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXT-X-MAP:URI="init"\n#EXT-X-KEY:METHOD=NONE\n' + segment('one.m4s')), BASE);
  const sink = collectSink();
  await client(async url => response(url.endsWith('/key') ? rawKey : url.endsWith('/init') ? encrypted : Buffer.from('MEDIA'))).download(plan, sink);
  assert.equal(Buffer.concat(sink.chunks).toString(), 'INITMEDIA');
});

test('retry completes in order and failure never writes a gap or starts next window', async () => {
  let attempts = 0;
  const c = client(async () => ++attempts < 3 ? response('', null, { status: 503 }) : response('OK'), { retries: 3, retryDelayMs: 1 });
  assert.equal(Buffer.from(await c.request(BASE)).toString(), 'OK');
  assert.equal(attempts, 3);
  const plan = parsePlaylist(playlist(Array.from({ length: 9 }, (_, i) => segment(`${i}.ts`)).join('\n')), BASE);
  const requested = [];
  const sink = collectSink();
  await assert.rejects(client(async url => { requested.push(url); return url.endsWith('/1.ts') ? response('', null, { status: 404 }) : response('data'); }).download(plan, sink, () => {}, 3), /第 2 个分片/);
  assert.equal(requested.length, 3);
  assert.equal(sink.chunks.length, 0);
});

test('disk failure is not retried as a network failure', async () => {
  let requests = 0;
  const plan = parsePlaylist(playlist(segment('x.ts')), BASE);
  await assert.rejects(client(async () => { requests++; return response('data'); }, { retries: 3 }).download(plan, { async write() { throw new Error('disk full'); } }), /disk full/);
  assert.equal(requests, 1);
});

test('cancel aborts pending requests without success or writes', async () => {
  const controller = new AbortController();
  const c = client((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))), { signal: controller.signal });
  const plan = parsePlaylist(playlist(segment('x.ts')), BASE);
  const sink = collectSink();
  const pending = c.download(plan, sink);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(sink.chunks.length, 0);
});

test('HTTP 200 HTML body cannot be exported as media', async () => {
  const plan = parsePlaylist(playlist(segment('x.ts')), BASE);
  await assert.rejects(client(async () => response('<!doctype html><html>Access denied</html>')).download(plan, collectSink()), /错误页面/);
});

test('file names cannot escape directories or use reserved Windows devices', () => {
  assert.equal(safeFilename('a/b:<x>?', 'ts'), 'a_b__x__.ts');
  assert.equal(safeFilename('CON', 'mp4'), '_CON.mp4');
});

test('saved manifest preserves relative key, map, media and master URIs as absolute URLs', () => {
  const saved = absolutizePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../enc.key"\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="4@0"\n#EXTINF:5,\npart.ts?token=a,b\n#EXT-X-ENDLIST', 'https://cdn.test/redirect/video/list.m3u8');
  assert.match(saved, /URI="https:\/\/cdn.test\/redirect\/enc.key"/);
  assert.match(saved, /URI="https:\/\/cdn.test\/redirect\/video\/init.mp4"/);
  assert.match(saved, /https:\/\/cdn.test\/redirect\/video\/part.ts\?token=a,b/);
  const master = absolutizePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo/list.m3u8', 'https://cdn.test/master.m3u8');
  assert.match(master, /URI="https:\/\/cdn.test\/audio\/list.m3u8"/);
  assert.match(master, /\nhttps:\/\/cdn.test\/video\/list.m3u8$/);
  assert.throws(() => absolutizePlaylist('<html>no manifest</html>', BASE), /不是有效/);
});

test('sliding window schedules new segments before a slow later peer finishes', async () => {
  const plan = parsePlaylist(playlist(Array.from({ length: 8 }, (_, i) => segment(`${i}.ts`)).join('\n')), BASE);
  const gate = deferred(), requested = [];
  let completed = 0, maxAhead = 0;
  const sink = collectSink();
  const pending = client(async url => {
    const index = Number(/(\d+)\.ts/.exec(url)[1]);
    requested.push(index);
    maxAhead = Math.max(maxAhead, requested.length - completed);
    if (index === 2) await gate.promise;
    return response(String(index), null, { headers: { 'Content-Length': '1' } });
  }).download(plan, sink, progress => { completed = progress.completed; }, 3);
  await tick(); await tick();
  try {
    assert.deepEqual(requested, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(maxAhead > 3 && maxAhead <= 64);
  } finally { gate.resolve(); await pending; }
  assert.equal(Buffer.concat(sink.chunks).toString(), '01234567');
});

test('default six-attempt budget recovers transient HTTP and never retries permanent 4xx', async () => {
  let attempts = 0;
  const c = createClient({ fetch: async () => ++attempts < 6 ? response('busy', null, { status: 503 }) : response('OK'), retryDelayMs: 0 });
  assert.equal(Buffer.from(await c.request(BASE)).toString(), 'OK');
  assert.equal(attempts, 6);
  attempts = 0;
  await assert.rejects(createClient({ fetch: async () => { attempts++; return response('denied', null, { status: 403 }); }, retryDelayMs: 0 }).request(BASE), error => {
    assert.equal(error.retryable, false);
    assert.equal(error.httpStatus, 403);
    assert.equal(error.resourceUrl, BASE);
    return true;
  });
  assert.equal(attempts, 1);
});

test('full server Retry-After is honored without blocking cancellation', async () => {
  const controller = new AbortController();
  let retry;
  const pending = createClient({
    signal: controller.signal, fetch: async () => response('busy', null, { status: 429, headers: { 'Retry-After': '120' } }),
    onRetry(info) { retry = info; controller.abort(); }
  }).request(BASE);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(retry.delayMs, 120000);
  assert.equal(retry.error.httpStatus, 429);
  assert.equal(retry.error.retryable, true);
});

test('request timeout retries as TimeoutError, while user abort does not retry', async () => {
  let requests = 0;
  const stages = [];
  const c = createClient({ timeoutMs: 1, retryDelayMs: 0, fetch: async (_url, { signal }) => {
    if (++requests === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('fetch aborted', 'AbortError'))));
    return response('OK');
  }, onRetry(info) { stages.push(info.error.name); } });
  assert.equal(Buffer.from(await c.request(BASE)).toString(), 'OK');
  assert.deepEqual(stages, ['TimeoutError']);
  const controller = new AbortController();
  let retries = 0;
  const pending = createClient({ signal: controller.signal, fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))), onRetry() { retries++; } }).request(BASE);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(retries, 0);
});

async function encryptedFixture() {
  const keyBytes = new Uint8Array(16).fill(9);
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
  const iv = parseIv('0x0');
  const plain = new Uint8Array(40).fill(65);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain);
  return { keyBytes, encrypted, plain, descriptor: { url: 'https://fixture.test/part.ts', key: { url: 'https://fixture.test/key' }, iv } };
}

test('corrupted AES segment is refetched without browser cache and key is refreshed', async () => {
  const fixture = await encryptedFixture();
  const requests = [], retries = [];
  let segments = 0, keys = 0;
  const c = createClient({ crypto: webcrypto, retryDelayMs: 0, fetch: async (url, init) => {
    requests.push({ url, cache: init.cache });
    if (url.endsWith('/key')) { keys++; return response(fixture.keyBytes); }
    return response(++segments === 1 ? fixture.encrypted.slice(0, 16) : fixture.encrypted);
  }, onRetry(info) { retries.push(info.stage); } });
  assert.deepEqual(new Uint8Array(await c.readResource(fixture.descriptor)), fixture.plain);
  assert.equal(segments, 2);
  assert.equal(keys, 2);
  assert.deepEqual(retries, ['decrypt']);
  assert.equal(requests[2].cache, 'no-store');
  assert.equal(requests[3].cache, 'no-store');
});

test('permanently corrupt AES stops after six total attempts, not nested retry budgets', async () => {
  const fixture = await encryptedFixture();
  let segments = 0, keys = 0;
  const c = createClient({ crypto: webcrypto, retryDelayMs: 0, fetch: async url => {
    if (url.endsWith('/key')) { keys++; return response(fixture.keyBytes); }
    segments++; return response(fixture.encrypted.slice(0, 16));
  } });
  await assert.rejects(c.readResource(fixture.descriptor), error => {
    assert.equal(error.retryable, true);
    assert.equal(error.stage, 'decrypt');
    assert.equal(error.attempts, 6);
    assert.equal(error.httpStatus, 200);
    return true;
  });
  assert.equal(segments, 6);
  assert.equal(keys, 6);
});

test('same key URL refresh recovers a transient wrong encryption key', async () => {
  const fixture = await encryptedFixture();
  let keys = 0;
  const c = createClient({ crypto: webcrypto, retryDelayMs: 0, fetch: async url => {
    if (url.endsWith('/key')) return response(++keys === 1 ? new Uint8Array(16) : fixture.keyBytes);
    return response(fixture.encrypted);
  } });
  assert.deepEqual(new Uint8Array(await c.readResource(fixture.descriptor)), fixture.plain);
  assert.equal(keys, 2);
});

test('late failure using an old key cannot evict the refreshed concurrent key', async () => {
  const fixture = await encryptedFixture(), late = deferred();
  let decryptions = 0, keyRequests = 0;
  const crypto = { subtle: {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    async decrypt(...args) {
      const call = ++decryptions;
      if (call === 1) throw new DOMException('first transient decode failure', 'OperationError');
      if (call === 2) { await late.promise; throw new DOMException('late old-key failure', 'OperationError'); }
      return webcrypto.subtle.decrypt(...args);
    }
  } };
  const c = createClient({ crypto, retryDelayMs: 0, fetch: async url => {
    if (url.endsWith('/key')) { keyRequests++; return response(fixture.keyBytes); }
    return response(fixture.encrypted);
  } });
  const first = c.readResource(fixture.descriptor);
  const second = c.readResource({ ...fixture.descriptor, url: 'https://fixture.test/second.ts' });
  await first;
  assert.equal(keyRequests, 2);
  late.resolve();
  assert.deepEqual(new Uint8Array(await second), fixture.plain);
  assert.equal(keyRequests, 2);
});

test('successful peers persist after a failed segment, and retry fetches only missing segments', async () => {
  const plan = parsePlaylist(playlist(Array.from({ length: 6 }, (_, i) => segment(`${i}.ts`)).join('\n')), BASE);
  const cache = new Map();
  const hooks = { async getSegment(index) { return cache.get(index) || null; }, async putSegment(index, _segment, data) { await tick(); cache.set(index, data); } };
  const first = client(async url => response('' + /(\d+)\.ts/.exec(url)[1], null, url.endsWith('/1.ts') ? { status: 503 } : undefined), { retries: 2, retryDelayMs: 0 });
  await assert.rejects(first.download(plan, collectSink(), () => {}, 3, hooks), error => {
    assert.equal(error.segmentIndex, 1);
    assert.equal(error.segmentNumber, 2);
    assert.equal(error.retryable, true);
    assert.equal(error.httpStatus, 503);
    return true;
  });
  assert.ok(cache.has(0)); assert.ok(cache.has(2)); assert.equal(cache.has(1), false);
  const retained = new Set(cache.keys()), requests = [], sink = collectSink();
  await client(async url => { const index = Number(/(\d+)\.ts/.exec(url)[1]); requests.push(index); return response(String(index)); }).download(plan, sink, () => {}, 3, hooks);
  assert.deepEqual(new Set(requests), new Set([0, 1, 2, 3, 4, 5].filter(index => !retained.has(index))));
  assert.equal(Buffer.concat(sink.chunks).toString(), '012345');
});

test('failed request waits for successful peer cache writes before rejecting', async () => {
  const plan = parsePlaylist(playlist(segment('0.ts') + '\n' + segment('1.ts')), BASE);
  const gate = deferred(), cache = new Map();
  let putStarted = false, settled = false;
  const pending = client(async url => url.endsWith('/0.ts') ? response('bad', null, { status: 404 }) : response('good')).download(plan, collectSink(), () => {}, 2, {
    async putSegment(index, _segment, data) { putStarted = true; await gate.promise; cache.set(index, data); }
  }).catch(error => { settled = true; return error; });
  await tick(); await tick();
  assert.equal(putStarted, true); assert.equal(settled, false);
  gate.resolve();
  const error = await pending;
  assert.equal(error.segmentIndex, 0);
  assert.equal(cache.has(1), true);
  const count = cache.size; await tick(); assert.equal(cache.size, count);
});

test('cache errors are terminal and are never retried as network failures', async () => {
  const plan = parsePlaylist(playlist(segment('0.ts')), BASE);
  let requests = 0, puts = 0;
  await assert.rejects(createClient({ retryDelayMs: 0, fetch: async () => { requests++; return response('data'); } }).download(plan, collectSink(), () => {}, 2, {
    async putSegment() { puts++; throw new DOMException('quota', 'QuotaExceededError'); }
  }), error => { assert.equal(error.retryable, false); assert.equal(error.stage, 'cache-write'); assert.equal(error.name, 'QuotaExceededError'); return true; });
  assert.equal(requests, 1); assert.equal(puts, 1);
});

test('user cancellation settles an in-flight cache write before allowing caller cleanup', async () => {
  const plan = parsePlaylist(playlist(segment('0.ts')), BASE);
  const controller = new AbortController(), gate = deferred();
  let putStarted = false, settled = false, cacheWritten = false;
  const pending = client(async () => response('data'), { signal: controller.signal }).download(plan, collectSink(), () => {}, 1, {
    async putSegment() { putStarted = true; await gate.promise; cacheWritten = true; }
  }).catch(error => { settled = true; return error; });
  await tick(); assert.equal(putStarted, true);
  controller.abort(); await tick(); assert.equal(settled, false);
  gate.resolve();
  assert.equal((await pending).name, 'AbortError');
  assert.equal(cacheWritten, true);
});

test('recovered notification clears the matching request operation only after success', async () => {
  let requests = 0;
  const retries = [], recovered = [];
  const c = createClient({ retryDelayMs: 0, fetch: async () => ++requests === 1 ? response('busy', null, { status: 503 }) : response('OK'),
    onRetry(info) { retries.push(info); }, onRecovered(info) { recovered.push(info); } });
  await c.request(BASE);
  assert.equal(retries[0].operationUrl, BASE);
  assert.deepEqual(recovered, [{ resourceUrl: BASE, attempt: 2 }]);
  await c.request(BASE);
  assert.equal(recovered.length, 1, 'first-attempt success must not emit a recovery');
});

test('key retry and recovery share the parent segment operation URL', async () => {
  const fixture = await encryptedFixture();
  let keys = 0;
  const retries = [], recovered = [];
  const c = createClient({ crypto: webcrypto, retryDelayMs: 0, fetch: async url => {
    if (url.endsWith('/key')) return ++keys === 1 ? response('busy', null, { status: 503 }) : response(fixture.keyBytes);
    return response(fixture.encrypted);
  }, onRetry(info) { retries.push(info); }, onRecovered(info) { recovered.push(info); } });
  await c.readResource(fixture.descriptor);
  assert.equal(retries[0].resourceUrl, fixture.descriptor.key.url);
  assert.equal(retries[0].operationUrl, fixture.descriptor.url);
  assert.deepEqual(recovered, [{ resourceUrl: fixture.descriptor.url, attempt: 2 }]);
});
