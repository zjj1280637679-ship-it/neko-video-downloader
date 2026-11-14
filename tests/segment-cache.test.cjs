const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');
const cacheApi = require('../segment-cache.js');
const core = require('../hls-core.js');
const { createMemoryOpfs } = require('./helpers/memory-opfs.cjs');
const bytes = (...values) => Uint8Array.from(values).buffer;
const directoryFor = id => `neko-cache-${createHash('sha256').update(id).digest('hex')}`;
const checkpointFor = id => `${directoryFor(id)}/checkpoint.json`;
async function metadata(fs, id) { return JSON.parse(await (await fs.file(checkpointFor(id))).text()); }
const segmentFile = (id, index, signature) => `${directoryFor(id)}/${index}.${signature}.bin`;
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

test('concurrent segment commits store SHA-256 with the payload and write the plan checkpoint once', async () => {
  const fs = createMemoryOpfs(), counts = [], p = plan();
  const cache = await cacheApi.open(fs.root, 'sha-job', p, webcrypto, count => counts.push(count));
  await Promise.all([cache.putSegment(0, p.segments[0], bytes(1, 2, 3)), cache.putSegment(1, p.segments[1], bytes(4, 5, 6, 7))]);
  const meta = await metadata(fs, 'sha-job');
  assert.equal(meta.owner, 'neko-segments-v1'); assert.match(meta.signature, /^[a-f0-9]{64}$/);
  for (const [index, data] of [[0, Buffer.of(1, 2, 3)], [1, Buffer.of(4, 5, 6, 7)]]) {
    const file = await fs.file(segmentFile('sha-job', index, meta.signature));
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.concat([data, createHash('sha256').update(data).digest()]));
  }
  assert.equal(counts.at(-1), 2);
  const reopened = await cacheApi.open(fs.root, 'sha-job', plan(), webcrypto);
  assert.equal(reopened.count(), 2);
  assert.deepEqual(new Uint8Array(await reopened.getSegment(1)), Uint8Array.of(4, 5, 6, 7));
  assert.equal(fs.events.filter(event => event.type === 'close' && event.path === checkpointFor('sha-job')).length, 1);
});

test('reopening retains legacy segment records alongside new transactional files and skips an unfinished write', async () => {
  const fs = createMemoryOpfs(), p = plan(), id = 'upgrade';
  const directory = await fs.root.getDirectoryHandle(directoryFor(id), { create: true });
  await cacheApi.open(fs.root, id, p, webcrypto);
  const meta = await metadata(fs, id);
  const legacy = Buffer.of(71, 1, 2);
  await fs.write(`${directoryFor(id)}/0.bin`, legacy);
  await fs.write(checkpointFor(id), JSON.stringify({ ...meta, records: {
    0: { size: legacy.length, sha256: createHash('sha256').update(legacy).digest('hex') }
  } }));
  const old = await cacheApi.open(fs.root, id, p, webcrypto);
  await old.putSegment(1, p.segments[1], bytes(71, 3, 4));
  const file = await directory.getFileHandle(`2.${meta.signature}.bin`, { create: true });
  const uncommitted = await file.createWritable();
  await uncommitted.write(bytes(71, 5, 6, 7));
  const resumed = await cacheApi.open(fs.root, id, p, webcrypto);
  assert.equal(resumed.count(), 2);
  assert.deepEqual(Buffer.from(await resumed.getSegment(0)), legacy);
  assert.deepEqual(new Uint8Array(await resumed.getSegment(1)), Uint8Array.of(71, 3, 4));
  assert.equal(await resumed.getSegment(2), null);
  await uncommitted.abort();
  await resumed.putSegment(2, p.segments[2], bytes(71, 5, 6, 7));
  const repaired = await cacheApi.open(fs.root, id, p, webcrypto);
  assert.equal(repaired.count(), 3);
  assert.deepEqual(new Uint8Array(await repaired.getSegment(2)), Uint8Array.of(71, 5, 6, 7));
});

test('a missing or malformed plan checkpoint can be rebuilt using only same-plan segments', async () => {
  const fs = createMemoryOpfs(), p = plan(), id = 'rebuild';
  const created = await cacheApi.open(fs.root, id, p, webcrypto);
  const segment = bytes(71, 4, 1);
  await created.putSegment(0, p.segments[0], segment);
  const { signature } = await metadata(fs, id);
  const data = await (await fs.file(segmentFile(id, 0, signature))).arrayBuffer();
  await fs.write(segmentFile(id, 1, 'a'.repeat(64)), data);
  await fs.remove(checkpointFor(id));
  const missingMarker = await cacheApi.open(fs.root, id, p, webcrypto);
  assert.equal(missingMarker.count(), 1);
  assert.deepEqual(await missingMarker.getSegment(0), segment);
  assert.equal(await missingMarker.getSegment(1), null);
  await fs.write(checkpointFor(id), '{');
  const malformedMarker = await cacheApi.open(fs.root, id, p, webcrypto);
  assert.equal(malformedMarker.count(), 1);
  assert.deepEqual(await malformedMarker.getSegment(0), segment);
  assert.equal((await metadata(fs, id)).signature, signature);
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
    assert.equal(fs.paths().some(path => path.endsWith('.bin')), false);
  }
});

test('same-length corruption and a missing cached segment are re-fetched while verified bytes are reused', async () => {
  const fs = createMemoryOpfs(), p = plan(), expected = [bytes(71, 1, 1), bytes(71, 2, 2), bytes(71, 3, 3)];
  const cache = await cacheApi.open(fs.root, 'repair', p, webcrypto);
  await Promise.all(expected.map((data, index) => cache.putSegment(index, p.segments[index], data)));
  const { signature } = await metadata(fs, 'repair');
  const damagedPath = segmentFile('repair', 1, signature);
  const damaged = Buffer.from(await (await fs.file(damagedPath)).arrayBuffer());
  damaged[1] ^= 0xff;
  await fs.write(damagedPath, damaged);
  await fs.remove(segmentFile('repair', 2, signature));
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
