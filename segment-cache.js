/* Per-job OPFS checkpoints. Only verified, fully closed segments are reusable. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NekoSegmentCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const OWNER = 'neko-segments-v1';
  const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
  const HASH_BYTES = 32;
  const SEGMENT_FILE = /^(0|[1-9]\d*)(?:\.([a-f0-9]{64}))?\.bin$/;
  const encoder = new TextEncoder();
  async function hash(cryptoApi, data) {
    return new Uint8Array(await cryptoApi.subtle.digest('SHA-256', data));
  }
  async function digest(cryptoApi, data) {
    return Array.from(await hash(cryptoApi, data), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function directoryName(jobId, cryptoApi) { return `neko-cache-${await digest(cryptoApi, encoder.encode(jobId))}`; }
  function planIdentity(plan) {
    return JSON.stringify({ version: 1, url: plan.url, isFmp4: plan.isFmp4,
      segments: plan.segments, maps: Array.from(plan.maps || []) });
  }
  async function writeFile(directory, name, ...parts) {
    const file = await directory.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    try {
      for (const part of parts) await writer.write(part);
      await writer.close();
    }
    catch (error) { try { await writer.abort(); } catch {} throw error; }
  }
  async function removeFile(directory, name, options) {
    try { await directory.removeEntry(name, options); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }
  async function removeJob(root, jobId, cryptoApi) {
    await removeFile(root, await directoryName(jobId, cryptoApi), { recursive: true });
  }
  async function prune(root, retainedIds, cryptoApi) {
    if (typeof root.entries !== 'function') return;
    const retained = new Set(await Promise.all(retainedIds.map(id => directoryName(id, cryptoApi))));
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'directory' || !/^neko-cache-[a-f0-9]{64}$/.test(name) || retained.has(name)) continue;
      // Never remove unrelated OPFS data, even if a name resembles our prefix.
      let meta;
      try { meta = JSON.parse(await (await (await handle.getFileHandle('checkpoint.json')).getFile()).text()); }
      catch { continue; }
      if (meta?.owner === OWNER) await root.removeEntry(name, { recursive: true });
    }
  }
  async function loadRecords(directory, previous, signature, segmentCount) {
    const records = new Map();
    const legacyRecords = previous?.records && typeof previous.records === 'object' && !Array.isArray(previous.records)
      ? previous.records : {};
    for await (const [fileName, handle] of directory.entries()) {
      const match = handle.kind === 'file' && SEGMENT_FILE.exec(fileName);
      if (!match) continue;
      const index = Number(match[1]), storedSignature = match[2];
      if (index >= segmentCount || (storedSignature && storedSignature !== signature)) continue;
      const legacy = storedSignature ? null : legacyRecords[index];
      if (!storedSignature && (!legacy || records.has(index) || !/^[a-f0-9]{64}$/.test(legacy.sha256))) continue;
      let file;
      try { file = await handle.getFile(); }
      catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
      const size = file.size - (legacy ? 0 : HASH_BYTES);
      if (size > 0 && size <= MAX_SEGMENT_BYTES && (!legacy || legacy.size === size)) {
        records.set(index, { fileName, size, legacyHash: legacy?.sha256 });
      }
    }
    return records;
  }
  async function open(root, jobId, plan, cryptoApi, onCount = () => {}) {
    if (typeof root?.getDirectoryHandle !== 'function') return null;
    const name = await directoryName(jobId, cryptoApi);
    const signature = await digest(cryptoApi, encoder.encode(planIdentity(plan)));
    let directory = await root.getDirectoryHandle(name, { create: true });
    let previous;
    try { previous = JSON.parse(await (await (await directory.getFileHandle('checkpoint.json')).getFile()).text()); }
    catch (error) { if (error.name !== 'NotFoundError' && !(error instanceof SyntaxError)) throw error; }
    if (previous && (previous.owner !== OWNER || previous.signature !== signature)) {
      await root.removeEntry(name, { recursive: true });
      directory = await root.getDirectoryHandle(name, { create: true });
      previous = null;
    }
    if (!previous) await writeFile(directory, 'checkpoint.json', JSON.stringify({ owner: OWNER, signature }));
    const records = await loadRecords(directory, previous, signature, plan.segments.length);
    await onCount(records.size);
    return {
      count: () => records.size,
      async getSegment(index, _segment, reserve) {
        const record = records.get(index);
        if (!record) return null;
        try {
          const file = await (await directory.getFileHandle(record.fileName)).getFile();
          if (file.size === record.size + (record.legacyHash ? 0 : HASH_BYTES)) {
            await reserve?.(record.size);
            if (record.legacyHash) {
              const data = await file.arrayBuffer();
              if (await digest(cryptoApi, data) === record.legacyHash) return data;
            } else {
              const data = await file.slice(0, record.size).arrayBuffer();
              const expected = new Uint8Array(await file.slice(record.size).arrayBuffer());
              const actual = await hash(cryptoApi, data);
              if (actual.every((byte, offset) => byte === expected[offset])) return data;
            }
          }
        } catch (error) { if (error.name !== 'NotFoundError') throw error; }
        await removeFile(directory, record.fileName);
        records.delete(index);
        await onCount(records.size);
        return null;
      },
      async putSegment(index, _segment, data) {
        if (!Number.isInteger(index) || index < 0 || index >= plan.segments.length) throw new Error('分片缓存索引无效');
        if (!data?.byteLength || data.byteLength > MAX_SEGMENT_BYTES) throw new Error('分片超过缓存处理上限');
        const fileName = `${index}.${signature}.bin`;
        // Payload and checksum commit together on close, so workers can save
        // independently without rewriting a shared checkpoint for each segment.
        await writeFile(directory, fileName, data, await hash(cryptoApi, data));
        records.set(index, { fileName, size: data.byteLength });
        await onCount(records.size);
      },
      async clear() {
        await removeJob(root, jobId, cryptoApi);
        records.clear();
        await onCount(0);
      }
    };
  }
  return { open, removeJob, prune };
});
