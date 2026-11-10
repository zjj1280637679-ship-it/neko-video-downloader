const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { parsePlaylist, parseIv, sequenceToIv, createClient, safeFilename, absolutizePlaylist } = require('../hls-core.js');
const BASE = 'https://fixture.test/video/list.m3u8';
const playlist = (body, end = true) => `#EXTM3U\n${body}\n${end ? '#EXT-X-ENDLIST' : ''}\n`;
const segment = name => `#EXTINF:5.5,\n${name}`;
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

test('a slow first segment cannot grow the pending window beyond concurrency', async () => {
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
  assert.equal(requested.length, 3);
  assert.equal(sink.chunks.length, 0);
  releaseFirst();
  await pending;
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
