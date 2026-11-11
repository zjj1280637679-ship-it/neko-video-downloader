// In-memory File System Access API double. Writes are transactional: getFile()
// observes committed bytes only, close commits, and abort preserves the old file.
function createMemoryOpfs() {
  const events = [];
  const rootNode = { kind: 'directory', name: '', children: new Map() };
  const fail = (name, message) => { throw new DOMException(message, name); };
  function validateName(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new TypeError('A single entry name is required');
  }
  async function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    throw new TypeError('Expected string, Blob, ArrayBuffer or typed array');
  }
  function fileHandle(entry, path) {
    return {
      kind: 'file', name: entry.name,
      async getFile() {
        const file = new Blob([entry.bytes]); Object.defineProperty(file, 'name', { value: entry.name }); return file;
      },
      async createWritable(options = {}) {
        let pending = options.keepExistingData ? entry.bytes.slice() : new Uint8Array();
        let cursor = 0, closed = false;
        const assertOpen = () => { if (closed) fail('InvalidStateError', 'Writer is already closed'); };
        function truncate(size) {
          if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Invalid file size');
          const next = new Uint8Array(size); next.set(pending.subarray(0, size)); pending = next; cursor = Math.min(cursor, size);
        }
        return {
          async write(value) {
            assertOpen();
            if (value && typeof value === 'object' && Object.hasOwn(value, 'type')) {
              if (value.type === 'seek') { cursor = value.position; return; }
              if (value.type === 'truncate') { truncate(value.size); return; }
              if (value.type !== 'write') throw new TypeError('Unknown write command');
              if (value.position !== undefined) cursor = value.position;
              value = value.data;
            }
            if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Invalid write position');
            const bytes = await toBytes(value);
            const next = new Uint8Array(Math.max(pending.byteLength, cursor + bytes.byteLength));
            next.set(pending); next.set(bytes, cursor); pending = next; cursor += bytes.byteLength;
            events.push({ type: 'write', path, bytes: bytes.byteLength });
          },
          async seek(position) { assertOpen(); if (!Number.isSafeInteger(position) || position < 0) throw new TypeError('Invalid seek position'); cursor = position; },
          async truncate(size) { assertOpen(); truncate(size); },
          async close() { assertOpen(); entry.bytes = pending.slice(); closed = true; events.push({ type: 'close', path }); },
          async abort() { assertOpen(); closed = true; events.push({ type: 'abort', path }); }
        };
      }
    };
  }
  function directoryHandle(entry, path) {
    const childPath = name => path ? `${path}/${name}` : name;
    async function child(name, kind, options = {}) {
      validateName(name);
      let node = entry.children.get(name);
      if (!node) {
        if (!options.create) fail('NotFoundError', `${childPath(name)} does not exist`);
        node = kind === 'file' ? { kind, name, bytes: new Uint8Array() } : { kind, name, children: new Map() };
        entry.children.set(name, node); events.push({ type: 'create', path: childPath(name), kind });
      }
      if (node.kind !== kind) fail('TypeMismatchError', `${childPath(name)} is not a ${kind}`);
      return kind === 'file' ? fileHandle(node, childPath(name)) : directoryHandle(node, childPath(name));
    }
    return {
      kind: 'directory', name: entry.name,
      getDirectoryHandle(name, options) { return child(name, 'directory', options); },
      getFileHandle(name, options) { return child(name, 'file', options); },
      async removeEntry(name, options = {}) {
        validateName(name); const node = entry.children.get(name);
        if (!node) fail('NotFoundError', `${childPath(name)} does not exist`);
        if (node.kind === 'directory' && node.children.size && !options.recursive) fail('InvalidModificationError', 'Directory is not empty');
        entry.children.delete(name); events.push({ type: 'remove', path: childPath(name), recursive: options.recursive === true });
      },
      async *entries() {
        for (const [name, node] of entry.children) yield [name, node.kind === 'file' ? fileHandle(node, childPath(name)) : directoryHandle(node, childPath(name))];
      }
    };
  }
  const root = directoryHandle(rootNode, '');
  async function parent(path, create = false) {
    const parts = path.split('/'); const name = parts.pop(); let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
    return { directory, name };
  }
  return {
    root, events, storage: { async getDirectory() { return root; } },
    async write(path, data) { const { directory, name } = await parent(path, true); const writer = await (await directory.getFileHandle(name, { create: true })).createWritable(); await writer.write(data); await writer.close(); },
    async file(path) { const { directory, name } = await parent(path); return (await directory.getFileHandle(name)).getFile(); },
    async remove(path, recursive = false) { const { directory, name } = await parent(path); return directory.removeEntry(name, { recursive }); },
    paths() {
      const paths = [];
      const visit = (entry, prefix) => { for (const [name, node] of entry.children) { const path = prefix ? `${prefix}/${name}` : name; paths.push(path); if (node.kind === 'directory') visit(node, path); } };
      visit(rootNode, ''); return paths.sort();
    }
  };
}
module.exports = { createMemoryOpfs };
