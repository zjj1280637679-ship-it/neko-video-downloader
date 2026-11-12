/* Per-job OPFS checkpoints. Only verified, fully closed segments are reusable. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NekoSegmentCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const OWNER = 'neko-segments-v1';
  const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
  const encoder = new TextEncoder();
  async function digest(cryptoApi, data) {
    return Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function directoryName(jobId, cryptoApi) { return `neko-cache-${await digest(cryptoApi, encoder.encode(jobId))}`; }
  function planIdentity(plan) {
    return JSON.stringify({ version: 1, url: plan.url, isFmp4: plan.isFmp4,
      segments: plan.segments, maps: Array.from(plan.maps || []) });
  }
  async function writeFile(directory, name, data) {
    const file = await directory.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    try { await writer.write(data); await writer.close(); }
    catch (error) { try { await writer.abort(); } catch {} throw error; }
  }
  async function removeJob(root, jobId, cryptoApi) {
    const name = await directoryName(jobId, cryptoApi);
    try { await root.removeEntry(name, { recursive: true }); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
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
    const records = Object.create(null);
    const rawRecords = previous?.records && typeof previous.records === 'object' && !Array.isArray(previous.records) ? previous.records : {};
    for (const [index, record] of Object.entries(rawRecords)) {
      if (/^(0|[1-9]\d*)$/.test(index) && Number(index) < plan.segments.length &&
        Number.isSafeInteger(record?.size) && record.size > 0 && record.size <= MAX_SEGMENT_BYTES && /^[a-f0-9]{64}$/.test(record.sha256)) records[index] = { size: record.size, sha256: record.sha256 };
    }
    let chain = Promise.resolve();
    const count = () => Object.keys(records).length;
    function checkpoint(change = () => {}) {
      const operation = chain.then(async () => {
        const before = { ...records };
        change();
        try { await writeFile(directory, 'checkpoint.json', JSON.stringify({ owner: OWNER, signature, records })); }
        catch (error) {
          for (const key of Object.keys(records)) delete records[key];
          Object.assign(records, before);
          throw error;
        }
        await onCount(count());
      });
      chain = operation.catch(() => {});
      return operation;
    }
    await checkpoint();
    return {
      count,
      async getSegment(index, _segment, reserve) {
        const record = records[index];
        if (!record) return null;
        let data;
        try {
          const file = await (await directory.getFileHandle(`${index}.bin`)).getFile();
          if (file.size === record.size) {
            await reserve?.(file.size);
            data = await file.arrayBuffer();
            if (await digest(cryptoApi, data) === record.sha256) return data;
          }
        } catch (error) { if (error.name !== 'NotFoundError') throw error; }
        await checkpoint(() => { delete records[index]; });
        return null;
      },
      async putSegment(index, _segment, data) {
        if (!Number.isInteger(index) || index < 0 || index >= plan.segments.length) throw new Error('分片缓存索引无效');
        if (!data?.byteLength || data.byteLength > MAX_SEGMENT_BYTES) throw new Error('分片超过缓存处理上限');
        const record = { size: data.byteLength, sha256: await digest(cryptoApi, data) };
        await writeFile(directory, `${index}.bin`, data);
        await checkpoint(() => { records[index] = record; });
      },
      async clear() {
        await chain;
        await removeJob(root, jobId, cryptoApi);
        for (const key of Object.keys(records)) delete records[key];
        await onCount(0);
      }
    };
  }
  return { open, removeJob, prune };
});
