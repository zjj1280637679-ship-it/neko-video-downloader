const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
const cacheApi = require('../segment-cache.js');
const core = require('../hls-core.js');
const { createMemoryOpfs } = require('./helpers/memory-opfs.cjs');
const bytes = (...values) => Uint8Array.from(values).buffer;
const directoryFor = id => `neko-cache-${createHash('sha256').update(id).digest('hex')}`;
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n0.ts\n#EXTINF:5,\n1.ts\n#EXTINF:5,\n2.ts\n#EXT-X-ENDLIST';
function plan() { return core.parsePlaylist(playlist, 'https://fixture.test/list.m3u8'); }

test('memory OPFS commits mixed data only on close and preserves original content on abort', async () => {
  const fs = createMemoryOpfs(); const file = await fs.root.getFileHandle('fixture', { create: true });
  const writer = await file.createWritable();
  await writer.write('A'); await writer.write(new Blob(['B'])); await writer.write(bytes(67)); await writer.write(Uint8Array.of(68));
  assert.equal((await file.getFile()).size, 0);
  await writer.close(); assert.equal(await (await file.getFile()).text(), 'ABCD');
  const aborted = await file.createWritable(); await aborted.write('bad'); await aborted.abort();
  assert.equal(await (await file.getFile()).text(), 'ABCD');
});

test('checkpoints persist per-segment size and SHA256, including concurrent segment commits', async () => {
  const fs = createMemoryOpfs(), counts = [], p = plan();
  const cache = await cacheApi.open(fs.root, 'sha-job', p, webcrypto, count => counts.push(count));
  await Promise.all([cache.putSegment(0, p.segments[0], bytes(1, 2, 3)), cache.putSegment(1, p.segments[1], bytes(4, 5, 6, 7))]);
  const meta = JSON.parse(await (await fs.file(`${directoryFor('sha-job')}/checkpoint.json`)).text());
  assert.equal(meta.owner, 'neko-segments-v1'); assert.match(meta.signature, /^[a-f0-9]{64}$/);
  assert.deepEqual(meta.records['0'], { size: 3, sha256: createHash('sha256').update(Uint8Array.of(1, 2, 3)).digest('hex') });
  assert.deepEqual(meta.records['1'], { size: 4, sha256: createHash('sha256').update(Uint8Array.of(4, 5, 6, 7)).digest('hex') });
  assert.equal(counts.at(-1), 2);
  const reopened = await cacheApi.open(fs.root, 'sha-job', plan(), webcrypto);
  assert.equal(reopened.count(), 2);
  assert.deepEqual(new Uint8Array(await reopened.getSegment(1)), Uint8Array.of(4, 5, 6, 7));
});

test('changing segment identity, playlist URL, maps, encryption or byte ranges invalidates old cache', async () => {
  const variants = [
    p => { p.url += '?version=2'; },
    p => { p.segments[0].url = 'https://fixture.test/new.ts'; },
    p => { p.segments[0].key = { method: 'AES-128', url: 'https://fixture.test/key' }; },
    p => { p.segments[0].iv = Uint8Array.from({ length: 16 }, (_, index) => index); },
    p => { p.segments[0].byteRange = { offset: 188, length: 188 }; },
    p => { p.maps.set('init', { url: 'https://fixture.test/init.mp4' }); },
    p => { p.isFmp4 = true; }
  ];
  for (const mutate of variants) {
    const fs = createMemoryOpfs(), original = plan();
    const old = await cacheApi.open(fs.root, 'identity', original, webcrypto);
    await old.putSegment(0, original.segments[0], bytes(71, 1, 2));
    const changed = plan(); mutate(changed);
    const fresh = await cacheApi.open(fs.root, 'identity', changed, webcrypto);
    assert.equal(fresh.count(), 0); assert.equal(await fresh.getSegment(0), null);
    assert.equal(fs.paths().some(path => path.endsWith('/0.bin')), false);
  }
});

test('same-length corruption and a missing cached segment are re-fetched while verified bytes are reused', async () => {
  const fs = createMemoryOpfs(), p = plan(), expected = [bytes(71, 1, 1), bytes(71, 2, 2), bytes(71, 3, 3)];
  const cache = await cacheApi.open(fs.root, 'repair', p, webcrypto);
  await Promise.all(expected.map((data, index) => cache.putSegment(index, p.segments[index], data)));
  await fs.write(`${directoryFor('repair')}/1.bin`, bytes(71, 9, 9));
  await fs.remove(`${directoryFor('repair')}/2.bin`);
  const reopened = await cacheApi.open(fs.root, 'repair', p, webcrypto);
  const requests = [], written = [];
  const client = core.createClient({ crypto: webcrypto, retryDelayMs: 0, async fetch(url) {
    requests.push(url); const index = Number(new URL(url).pathname.match(/(\d)\.ts$/)[1]); return new Response(expected[index]);
  } });
  await client.download(p, { async write(buffer) { written.push(Buffer.from(buffer)); } }, () => {}, 3, reopened);
  assert.deepEqual(requests.sort(), ['https://fixture.test/1.ts', 'https://fixture.test/2.ts']);
  assert.deepEqual(Buffer.concat(written), Buffer.concat(expected.map(data => Buffer.from(data))));
  assert.equal(reopened.count(), 3);
});

test('clear removes only its own job and preserves other job caches and unrelated files', async () => {
  const fs = createMemoryOpfs(), p = plan();
  const own = await cacheApi.open(fs.root, 'own', p, webcrypto), other = await cacheApi.open(fs.root, 'other', p, webcrypto);
  await own.putSegment(0, p.segments[0], bytes(71, 1)); await other.putSegment(0, p.segments[0], bytes(71, 2));
  await fs.write('unrelated/document.txt', 'keep me');
  await own.clear();
  assert.equal(own.count(), 0);
  assert.equal(fs.paths().some(path => path.startsWith(directoryFor('own'))), false);
  assert.deepEqual(new Uint8Array(await other.getSegment(0)), Uint8Array.of(71, 2));
  assert.equal(await (await fs.file('unrelated/document.txt')).text(), 'keep me');
  await cacheApi.removeJob(fs.root, 'own', webcrypto); // Idempotent cleanup.
});

test('pruning removes only owned stale directories and keeps known, foreign and malformed entries', async () => {
  const fs = createMemoryOpfs(), p = plan();
  await cacheApi.open(fs.root, 'keep', p, webcrypto); await cacheApi.open(fs.root, 'old', p, webcrypto);
  const foreign = `neko-cache-${'a'.repeat(64)}`, malformed = `neko-cache-${'b'.repeat(64)}`, noMetadata = `neko-cache-${'c'.repeat(64)}`;
  await fs.write(`${foreign}/checkpoint.json`, JSON.stringify({ owner: 'someone-else' }));
  await fs.write(`${malformed}/checkpoint.json`, '{invalid');
  await fs.write(`${noMetadata}/other.txt`, 'not a cache');
  await fs.write('neko-cache-short/checkpoint.json', JSON.stringify({ owner: 'neko-segments-v1' }));
  await fs.write(`neko-cache-${'d'.repeat(64)}`, 'regular file');
  await cacheApi.prune(fs.root, ['keep'], webcrypto);
  const paths = fs.paths();
  assert.ok(paths.includes(directoryFor('keep'))); assert.equal(paths.includes(directoryFor('old')), false);
  for (const name of [foreign, malformed, noMetadata, 'neko-cache-short', `neko-cache-${'d'.repeat(64)}`]) assert.ok(paths.includes(name));
  assert.deepEqual(fs.events.filter(event => event.type === 'remove').map(event => event.path), [directoryFor('old')]);
});
