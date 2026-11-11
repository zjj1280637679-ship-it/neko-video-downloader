const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

// Execute the shipped script unchanged. The DOM, picker and network are the test
// boundary; crypto, promises, AbortController and Blob use Node implementations.
const source = fs.readFileSync(path.join(__dirname, "../downloader.js"), "utf8");
const base = "https://media.test/";
const masterUrl = `${base}master.m3u8`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const bytes = (...values) => new Uint8Array(values);
const mediaPlaylist = (count) => `#EXTM3U\n${Array.from({ length: count }, (_, i) => `#EXTINF:1\ns${i}.ts`).join("\n")}\n#EXT-X-ENDLIST`;

function makeWriter(overrides = {}) {
  const state = { writes: [], closes: 0, aborts: 0 };
  const writer = {
    async write(buffer) { state.writes.push([...new Uint8Array(buffer)]); },
    async close() { state.closes++; },
    async abort() { state.aborts++; },
    ...overrides
  };
  return { state, writer };
}

async function boot(options = {}) {
  const elements = new Map();
  const state = { requests: [], downloads: [], blobs: [], copied: [], events: [] };
  function element(id) {
    if (!elements.has(id)) {
      const handlers = new Map();
      elements.set(id, {
        id, textContent: "", value: "", hidden: ["audioNotice", "btnCancel"].includes(id),
        disabled: ["btnStart", "btnCancel"].includes(id), style: {}, handlers,
        addEventListener(name, handler) { handlers.set(name, handler); },
        select() { this.selected = true; },
        set innerHTML(_value) { throw new Error(`Unsafe HTML assignment to ${id}`); }
      });
    }
    return elements.get(id);
  }
  let onReady;
  const document = {
    getElementById: element,
    addEventListener(_name, handler) { onReady = handler; },
    createElement(name) {
      assert.equal(name, "a");
      return { click() { state.downloads.push({ href: this.href, filename: this.download }); } };
    },
    body: { appendChild() {}, removeChild() {} }
  };
  const routes = { [masterUrl]: options.playlist || mediaPlaylist(1), ...options.routes };
  const fetch = async (url, init = {}) => {
    state.requests.push({ url, ...init });
    state.events.push(`fetch:${url}`);
    if (options.fetch) {
      const response = await options.fetch(url, init, state);
      if (response !== undefined) {
        // Redirect fixtures use plain objects to provide a final URL.
        if (response.text && !response.arrayBuffer) response.arrayBuffer = async () => new TextEncoder().encode(await response.text()).buffer;
        return response;
      }
    }
    if (Object.hasOwn(routes, url)) return new Response(routes[url]);
    const index = /^s(\d+)\.ts$/.exec(url.slice(base.length));
    if (index) return new Response(bytes(Number(index[1]) + 1));
    throw new Error(`Unexpected request: ${url}`);
  };
  const window = {
    location: { search: `?url=${encodeURIComponent(masterUrl)}&title=${encodeURIComponent(options.title || "Video")}` }
  };
  if (options.picker) window.showSaveFilePicker = options.picker;
  class TestURL extends URL {}
  TestURL.createObjectURL = (blob) => {
    state.blobs.push(blob);
    return `blob:test-${state.blobs.length}`;
  };
  TestURL.revokeObjectURL = () => {};
  const context = vm.createContext({
    document, window, URLSearchParams, URL: TestURL,
    Uint8Array, ArrayBuffer, Map, Blob, AbortController, TextDecoder, crypto: webcrypto, fetch,
    navigator: { clipboard: { async writeText(value) { state.copied.push(value); } } },
    chrome: { downloads: { download() {} } },
    console: { warn() {}, error() {} },
    performance, setInterval, clearInterval,
    setTimeout(fn, ms) { return ms >= 60000 ? null : setTimeout(fn, ms === 30000 ? (options.idleTimeoutMs ?? ms) : 0); },
    clearTimeout
  });
  for (const file of ["adaptive-concurrency.js", "adaptive-download.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  if (options.initialConcurrency) {
    const ActualController = context.NekoAdaptive.ThroughputController;
    context.NekoAdaptive.ThroughputController = class extends ActualController {
      constructor() { super({ initialConcurrency: options.initialConcurrency }); }
    };
  }
  vm.runInContext(source, context);
  const ready = onReady();
  if (!options.deferReady) await ready;
  return {
    state, element, ready,
    async click(id) {
      const target = element(id);
      assert.equal(target.disabled, false, `${id} should be enabled`);
      return await target.handlers.get("click")();
    }
  };
}

function assertReset(app) {
  assert.equal(app.element("btnStart").disabled, false);
  assert.equal(app.element("btnDownloadM3U8").disabled, false);
  assert.equal(app.element("btnCancel").disabled, true);
  assert.equal(app.element("btnCancel").hidden, true);
}

test("canceling the save picker fetches no segments, exports nothing and permits retry", async () => {
  const { state, writer } = makeWriter();
  let picks = 0;
  const app = await boot({ picker: async () => {
    if (++picks === 1) throw Object.assign(new Error("Canceled"), { name: "AbortError" });
    return { createWritable: async () => writer };
  } });
  await app.click("btnStart");
  assert.deepEqual(app.state.requests.map((request) => request.url), [masterUrl]);
  assert.equal(app.state.downloads.length, 0);
  assert.match(app.element("statusMsg").textContent, /已取消/);
  assertReset(app);
  await app.click("btnStart");
  assert.deepEqual(state.writes, [[1]]);
  assert.equal(state.closes, 1);
  assertReset(app);
});

test("disk write errors do not retry segments or double-count progress, and abort the writer", async () => {
  const { state, writer } = makeWriter({ async write() { throw new Error("Disk full"); } });
  const app = await boot({ picker: async () => ({ createWritable: async () => writer }) });
  await app.click("btnStart");
  assert.equal(app.state.requests.filter((request) => request.url.endsWith("s0.ts")).length, 1);
  assert.equal(app.element("percentText").textContent, "100%");
  assert.match(app.element("statusMsg").textContent, /Disk full/);
  assert.equal(state.aborts, 1);
  assert.equal(state.closes, 0);
  assert.equal(app.state.downloads.length, 0);
  assertReset(app);
});

test("creating or closing a writable file cannot leave the UI locked", async (t) => {
  await t.test("createWritable failure", async () => {
    const app = await boot({ picker: async () => ({ createWritable: async () => { throw new Error("Access denied"); } }) });
    await app.click("btnStart");
    assert.equal(app.state.requests.length, 1);
    assert.match(app.element("statusMsg").textContent, /Access denied/);
    assertReset(app);
  });
  await t.test("close failure", async () => {
    const { state, writer } = makeWriter({ async close() { throw new Error("Commit failed"); } });
    const app = await boot({ picker: async () => ({ createWritable: async () => writer }) });
    await app.click("btnStart");
    assert.match(app.element("statusMsg").textContent, /Commit failed/);
    assert.equal(state.aborts, 1);
    assertReset(app);
  });
});

test("all failed segments never export an empty Blob or commit a streaming file", async (t) => {
  for (const streaming of [false, true]) {
    await t.test(streaming ? "streaming" : "Blob fallback", async () => {
      const { state, writer } = makeWriter();
      const app = await boot({
        playlist: mediaPlaylist(2),
        picker: streaming ? async () => ({ createWritable: async () => writer }) : undefined,
        fetch: async (url) => url.endsWith(".ts") ? new Response("Unavailable", { status: 503 }) : undefined
      });
      await app.click("btnStart");
      assert.equal(app.state.requests.filter((request) => request.url.endsWith(".ts")).length, 6);
      assert.equal(app.state.blobs.length, 0);
      assert.equal(app.state.downloads.length, 0);
      assert.equal(state.closes, 0);
      assert.equal(state.aborts, streaming ? 1 : 0);
      assert.match(app.element("statusMsg").textContent, /全部切片下载失败/);
      assert.equal(app.element("percentText").textContent, "100%");
      assertReset(app);
    });
  }
});

test("cancel aborts all in-flight requests and stops replenishment", async () => {
  const { state, writer } = makeWriter();
  const started = deferred();
  let pending = 0;
  let aborted = 0;
  const app = await boot({
    playlist: mediaPlaylist(8),
    initialConcurrency: 3,
    picker: async () => ({ createWritable: async () => writer }),
    fetch: async (url, { signal }) => {
      if (!url.endsWith(".ts")) return undefined;
      if (++pending === 3) started.resolve();
      return await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted++;
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    }
  });
  const running = app.click("btnStart");
  await started.promise;
  await app.click("btnCancel");
  await running;
  assert.equal(pending, 3);
  assert.equal(aborted, 3);
  assert.equal(state.writes.length, 0);
  assert.equal(state.closes, 0);
  assert.equal(state.aborts, 1);
  assert.match(app.element("statusMsg").textContent, /已取消/);
  assertReset(app);
});

test("small bodies continue downloading during an outstanding write and are saved in order", async () => {
  const firstWrite = deferred();
  const unblock = deferred();
  const written = [];
  const { writer } = makeWriter({ async write(buffer) {
    if (written.length === 0) {
      firstWrite.resolve();
      await unblock.promise;
    }
    written.push(new Uint8Array(buffer)[0]);
  } });
  const app = await boot({ playlist: mediaPlaylist(12), picker: async () => ({ createWritable: async () => writer }) });
  const running = app.click("btnStart");
  await firstWrite.promise;
  await tick();
  // Twelve one-byte bodies fit under the independent byte watermark. The
  // network queue must keep replenishing rather than wait for a written batch.
  assert.equal(app.state.requests.filter((request) => request.url.endsWith(".ts")).length, 12);
  unblock.resolve();
  await running;
  assert.deepEqual(written, Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(app.state.blobs.length, 0);
  assertReset(app);
});

test("out-of-order responses still produce the original segment order", async () => {
  const pending = Array.from({ length: 6 }, () => deferred());
  const started = deferred();
  let count = 0;
  const { state, writer } = makeWriter();
  const app = await boot({
    playlist: mediaPlaylist(6),
    initialConcurrency: 3,
    picker: async () => ({ createWritable: async () => writer }),
    fetch: async (url) => {
      const match = /s(\d+)\.ts$/.exec(url);
      if (!match) return undefined;
      if (++count === 3) started.resolve();
      return await pending[Number(match[1])].promise;
    }
  });
  const running = app.click("btnStart");
  await started.promise;
  for (const index of [2, 3, 4, 5, 1, 0]) {
    pending[index].resolve(new Response(bytes(index + 1)));
    await tick();
  }
  await running;
  assert.deepEqual(state.writes, [[1], [2], [3], [4], [5], [6]]);
});

test("partial failures retain available segments in order and clearly report missing content", async () => {
  const app = await boot({
    playlist: mediaPlaylist(3),
    fetch: async (url) => url.endsWith("s1.ts") ? new Response("", { status: 500 }) : undefined
  });
  await app.click("btnStart");
  assert.equal(app.state.downloads.length, 1);
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1, 3]);
  assert.match(app.element("statusMsg").textContent, /有缺失/);
  assert.match(app.element("statusMsg").textContent, /1 个切片下载失败/);
  assert.equal(app.element("percentText").textContent, "100%");
  assertReset(app);
});

test("AES-128 supports media-sequence IV, explicit IV and METHOD=NONE across segments", async () => {
  const keyBytes = bytes(...Array.from({ length: 16 }, (_, index) => index));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const sequenceIv = new Uint8Array(16);
  sequenceIv[15] = 42;
  const explicitIv = new Uint8Array(16);
  explicitIv[15] = 9;
  const first = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: sequenceIv }, key, bytes(1, 2, 3));
  const second = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: explicitIv }, key, bytes(4, 5));
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1\nfirst.ts\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x09\n#EXTINF:1\nsecond.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1\nclear.ts\n#EXT-X-ENDLIST',
    routes: { [`${base}key.bin`]: keyBytes, [`${base}first.ts`]: first, [`${base}second.ts`]: second, [`${base}clear.ts`]: bytes(6, 7) }
  });
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(app.state.requests.filter((request) => request.url.endsWith("key.bin")).length, 1);
});

test("MAP transitions and byte ranges preserve init bytes, implicit offsets and 200/206 handling", async () => {
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-MAP:URI="init-a.bin",BYTERANGE="2@1"\n#EXT-X-BYTERANGE:2@1\n#EXTINF:1\nshared.m4s\n#EXT-X-BYTERANGE:2\n#EXTINF:1\nshared.m4s\n#EXT-X-MAP:URI="init-b.bin",BYTERANGE="1@2"\n#EXTINF:1\nlast.m4s\n#EXT-X-ENDLIST',
    routes: { [`${base}init-a.bin`]: bytes(0, 1, 2, 3), [`${base}shared.m4s`]: bytes(9, 10, 11, 12, 13, 14), [`${base}last.m4s`]: bytes(30) },
    fetch: async (url, { headers }) => {
      if (url.endsWith("init-b.bin")) {
        assert.equal(headers.Range, "bytes=2-2");
        return new Response(bytes(22), { status: 206, headers: { "Content-Range": "bytes 2-2/3" } });
      }
      return undefined;
    }
  });
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1, 2, 10, 11, 12, 13, 22, 30]);
  assert.deepEqual(app.state.requests.filter((request) => request.url.endsWith("shared.m4s")).map((request) => request.headers.Range), ["bytes=1-2", "bytes=3-4"]);
  assert.equal(app.state.downloads[0].filename, "Video.mp4");
});

test("selected variant exposes its external audio, preserves master copying, and permits video-only saving", async () => {
  const app = await boot({
    title: '<img src=x onerror="bad()">',
    playlist: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="low",NAME="Low",URI="low-audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="Japanese",URI="ja.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="English",URI="en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="low"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,AUDIO="high"\nhigh.m3u8',
    routes: { [`${base}high.m3u8`]: mediaPlaylist(1) }
  });
  assert.equal(app.element("audioNotice").hidden, false);
  assert.match(app.element("audioNoticeText").textContent, /Japanese、English/);
  assert.equal(app.element("audioUrls").value, `${base}ja.m3u8\n${base}en.m3u8`);
  assert.equal(app.element("btnStart").disabled, false);
  assert.match(app.element("btnStart").textContent, /不合并独立音轨/);
  await app.click("btnCopyAudio");
  await app.click("btnCopyUrl");
  assert.deepEqual(app.state.copied, [`${base}ja.m3u8\n${base}en.m3u8`, masterUrl]);
  await app.click("btnStart");
  assert.equal(app.state.downloads.length, 1);
  assert.equal(app.state.requests.some((request) => /(?:ja|en|low-audio)\.m3u8$/.test(request.url)), false);
  assert.match(app.element("statusMsg").textContent, /独立音轨未合并/);
  assert.match(app.element("statusMsg").textContent, /<img src=x/);
  assertReset(app);
});

test("audio groups with no external URI and unused audio groups do not trigger a video-only warning", async () => {
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="embedded",NAME="Original"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="unused",NAME="Other",URI="other.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="embedded"\nvideo.m3u8',
    routes: { [`${base}video.m3u8`]: mediaPlaylist(1) }
  });
  assert.equal(app.element("audioNotice").hidden, true);
  await app.click("btnStart");
  assert.doesNotMatch(app.element("statusMsg").textContent, /独立音轨未合并/);
});

test("AES-128 selects identity among multiple KEYFORMAT choices in either order", async (t) => {
  const keyBytes = bytes(...Array.from({ length: 16 }, (_, index) => index));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const iv = new Uint8Array(16);
  iv[15] = 1;
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv }, key, bytes(1, 2));
  for (const unknownFirst of [false, true]) {
    await t.test(unknownFirst ? "unknown format first" : "identity first", async () => {
      const keys = [
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="identity",IV=0x1',
        '#EXT-X-KEY:METHOD=AES-128,URI="vendor.key",KEYFORMAT="vendor.test",IV=0x1'
      ];
      if (unknownFirst) keys.reverse();
      const app = await boot({
        playlist: `#EXTM3U\n#EXT-X-VERSION:6\n${keys.join("\n")}\n#EXTINF:1\nenc.ts\n#EXT-X-KEY:METHOD=AES-128,URI="vendor-next.key",KEYFORMAT="vendor.test",IV=0x1\n#EXTINF:1\nenc.ts\n#EXT-X-ENDLIST`,
        routes: { [`${base}key.bin`]: keyBytes, [`${base}enc.ts`]: cipher }
      });
      await app.click("btnStart");
      assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1, 2, 1, 2]);
      assert.equal(app.state.requests.filter((request) => request.url.endsWith("key.bin")).length, 1);
      assert.equal(app.state.requests.some((request) => request.url.endsWith(".key")), false);
    });
  }
});

test("key capability is checked where it applies, without treating unknown encryption as clear", async (t) => {
  await t.test("unused unsupported key replaced by NONE permits clear media", async () => {
    const app = await boot({
      playlist: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="unused.key"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1\ns0.ts\n#EXT-X-ENDLIST'
    });
    await app.click("btnStart");
    assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1]);
    assert.equal(app.state.requests.some((request) => request.url.endsWith("unused.key")), false);
  });
  for (const prefix of ["", "#EXT-X-KEY:METHOD=NONE\n"]) {
    await t.test(prefix ? "unknown encryption after NONE" : "only unknown KEYFORMAT", async () => {
      const app = await boot({
        playlist: `#EXTM3U\n${prefix}#EXT-X-KEY:METHOD=AES-128,URI="vendor.key",KEYFORMAT="vendor.test"\n#EXTINF:1\ns0.ts\n#EXT-X-ENDLIST`
      });
      assert.equal(app.element("btnStart").disabled, false);
      assert.equal(app.element("btnStart").textContent, "重新解析清单");
      assert.match(app.element("statusMsg").textContent, /没有可用的密钥格式.*vendor\.test/);
      assert.equal(app.state.requests.length, 1);
      assert.equal(app.state.blobs.length, 0);
    });
  }
  await t.test("sample encryption stays explicitly unsupported", async () => {
    const app = await boot({
      playlist: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="sample.key"\n#EXTINF:1\ns0.ts\n#EXT-X-ENDLIST'
    });
    assert.equal(app.element("btnStart").disabled, false);
      assert.equal(app.element("btnStart").textContent, "重新解析清单");
    assert.match(app.element("statusMsg").textContent, /METHOD=SAMPLE-AES/);
    assert.equal(app.state.requests.length, 1);
  });
});

test("MAP ranges sharing one URI remain distinct and cached maps are reinserted on transitions", async () => {
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-MAP:URI="init.bin",BYTERANGE="2@0"\n#EXTINF:1\nfirst.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init.bin",BYTERANGE="2@2"\n#EXTINF:1\nsecond.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init.bin",BYTERANGE="2@0"\n#EXTINF:1\nthird.m4s\n#EXT-X-ENDLIST',
    routes: {
      [`${base}init.bin`]: bytes(10, 11, 20, 21),
      [`${base}first.m4s`]: bytes(1), [`${base}second.m4s`]: bytes(2), [`${base}third.m4s`]: bytes(3)
    }
  });
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [10, 11, 1, 20, 21, 2, 10, 11, 3]);
  assert.deepEqual(app.state.requests.filter((request) => request.url.endsWith("init.bin")).map((request) => request.headers.Range), ["bytes=0-1", "bytes=2-3"]);
});

test("encrypted MAP uses the key and explicit IV active at its declaration", async () => {
  const mapKeyBytes = bytes(...Array.from({ length: 16 }, (_, index) => index));
  const mediaKeyBytes = bytes(...Array.from({ length: 16 }, (_, index) => 15 - index));
  const mapKey = await webcrypto.subtle.importKey("raw", mapKeyBytes, "AES-CBC", false, ["encrypt"]);
  const mediaKey = await webcrypto.subtle.importKey("raw", mediaKeyBytes, "AES-CBC", false, ["encrypt"]);
  const mapIv = new Uint8Array(16);
  mapIv[15] = 9;
  const mediaIv = new Uint8Array(16);
  mediaIv[15] = 3;
  const mapCipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: mapIv }, mapKey, bytes(9, 8, 7));
  const mediaCipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: mediaIv }, mediaKey, bytes(1, 2));
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="map.key",IV=0x09\n#EXT-X-MAP:URI="init.bin"\n#EXT-X-KEY:METHOD=AES-128,URI="media.key",IV=0x03\n#EXTINF:1\nenc.m4s\n#EXT-X-ENDLIST',
    routes: {
      [`${base}map.key`]: mapKeyBytes, [`${base}media.key`]: mediaKeyBytes,
      [`${base}init.bin`]: mapCipher, [`${base}enc.m4s`]: mediaCipher
    }
  });
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [9, 8, 7, 1, 2]);
  assert.match(app.element("statusMsg").textContent, /已保存/);
});

test("MAP identity includes its IV even when URI, range and key are unchanged", async () => {
  const keyBytes = bytes(...Array.from({ length: 16 }, (_, index) => index));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const firstIv = new Uint8Array(16);
  firstIv[15] = 1;
  const secondIv = new Uint8Array(16);
  secondIv[15] = 2;
  const firstMap = bytes(...Array.from({ length: 16 }, (_, index) => index + 10));
  // Changing the IV changes the corresponding plaintext byte of the first
  // CBC block. The separate padding block remains valid in both contexts.
  const secondMap = firstMap.slice();
  secondMap[15] ^= 3;
  const mapCipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: firstIv }, key, firstMap);
  const firstCipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: firstIv }, key, bytes(1));
  const secondCipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv: secondIv }, key, bytes(2));
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01\n#EXT-X-MAP:URI="init.bin"\n#EXTINF:1\nfirst.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x02\n#EXT-X-MAP:URI="init.bin"\n#EXTINF:1\nsecond.m4s\n#EXT-X-ENDLIST',
    routes: {
      [`${base}key.bin`]: keyBytes, [`${base}init.bin`]: mapCipher,
      [`${base}first.m4s`]: firstCipher, [`${base}second.m4s`]: secondCipher
    }
  });
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [...firstMap, 1, ...secondMap, 2]);
  assert.equal(app.state.requests.filter((request) => request.url.endsWith("init.bin")).length, 2);
});

test("an encrypted MAP without explicit IV reports the missing condition and exports nothing", async () => {
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.bin"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1\ns0.ts\n#EXT-X-ENDLIST'
  });
  assert.equal(app.element("btnStart").disabled, false);
      assert.equal(app.element("btnStart").textContent, "重新解析清单");
  assert.match(app.element("statusMsg").textContent, /初始化段缺少显式 IV/);
  assert.equal(app.state.requests.length, 1);
  assert.equal(app.state.blobs.length, 0);
  assert.equal(app.state.downloads.length, 0);
});

test("TS initialization maps are retained without renaming the transport stream to MP4", async () => {
  const init = new Uint8Array(376);
  init.fill(0xff);
  init[0] = 0x47;
  init[188] = 0x47;
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-MAP:URI="init.bin"\n#EXTINF:1\npart.ts\n#EXT-X-ENDLIST',
    routes: { [`${base}init.bin`]: init, [`${base}part.ts`]: bytes(1, 2) }
  });
  await app.click("btnStart");
  assert.equal(app.state.downloads[0].filename, "Video.ts");
  assert.equal(app.state.blobs[0].type, "video/mp2t");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [...init, 1, 2]);
  assert.doesNotMatch(app.element("segmentVal").textContent, /fMP4/);
});

test("initialization bytes identify fMP4 when resource URLs have no file extension", async () => {
  const init = bytes(0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0);
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-MAP:URI="init?id=1"\n#EXTINF:1\nsegment?id=1\n#EXT-X-ENDLIST',
    routes: { [`${base}init?id=1`]: init, [`${base}segment?id=1`]: bytes(1, 2) }
  });
  await app.click("btnStart");
  assert.equal(app.state.downloads[0].filename, "Video.mp4");
  assert.equal(app.state.blobs[0].type, "video/mp4");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [...init, 1, 2]);
});

test("redirected playlists resolve variants, audio, keys, maps and segments against their final URLs", async () => {
  const keyBytes = bytes(...Array.from({ length: 16 }, (_, index) => index));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const iv = new Uint8Array(16);
  iv[15] = 1;
  const mapCipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv }, key, bytes(8, 9));
  const mediaCipher = await webcrypto.subtle.encrypt({ name: "AES-CBC", iv }, key, bytes(1, 2));
  const app = await boot({
    routes: {
      "https://edge.test/episode/key.bin": keyBytes,
      "https://edge.test/episode/init.bin": mapCipher,
      "https://edge.test/episode/part.m4s": mediaCipher
    },
    fetch: async (url) => {
      if (url === masterUrl) return {
        ok: true, url: "https://cdn.test/show/master.m3u8",
        text: async () => '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="main",NAME="Original",URI="audio/ja.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=900,AUDIO="main"\nvideo/main.m3u8'
      };
      if (url === "https://cdn.test/show/video/main.m3u8") return {
        ok: true, url: "https://edge.test/episode/list.m3u8",
        text: async () => '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1\n#EXT-X-MAP:URI="init.bin"\n#EXTINF:1\npart.m4s\n#EXT-X-ENDLIST'
      };
      return undefined;
    }
  });
  assert.equal(app.element("audioUrls").value, "https://cdn.test/show/audio/ja.m3u8");
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [8, 9, 1, 2]);
  assert.deepEqual(app.state.requests.map((request) => request.url), [
    masterUrl, "https://cdn.test/show/video/main.m3u8",
    "https://edge.test/episode/key.bin", "https://edge.test/episode/init.bin", "https://edge.test/episode/part.m4s"
  ]);
});

test("failed variants fall back in bandwidth order and retain reasons plus only the selected audio group", async () => {
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="high",NAME="High",URI="high-audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="selected",NAME="Selected",URI="selected-audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="selected"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,AUDIO="high"\nunavailable.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800,AUDIO="high"\nunsupported.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=700,AUDIO="high"\ncyclic.m3u8',
    routes: {
      [`${base}low.m3u8`]: mediaPlaylist(1),
      [`${base}unsupported.m3u8`]: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="vendor.key",KEYFORMAT="vendor.test"\n#EXTINF:1\ns0.ts\n#EXT-X-ENDLIST',
      [`${base}cyclic.m3u8`]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=700\nmaster.m3u8'
    },
    fetch: async (url) => url.endsWith("unavailable.m3u8") ? new Response("Unavailable", { status: 503 }) : undefined
  });
  assert.deepEqual(app.state.requests.map((request) => request.url), [
    masterUrl, `${base}unavailable.m3u8`, `${base}unsupported.m3u8`, `${base}cyclic.m3u8`, `${base}low.m3u8`
  ]);
  assert.equal(app.element("audioUrls").value, `${base}selected-audio.m3u8`);
  assert.match(app.element("audioNoticeText").textContent, /Selected/);
  assert.doesNotMatch(app.element("audioNoticeText").textContent, /High/);
  const selection = app.element("segmentVal").textContent;
  assert.match(selection, /已选 100 bps（第 4\/4 档）/);
  assert.match(selection, /900 bps：.*HTTP 503/);
  assert.match(selection, /800 bps：.*vendor\.test/);
  assert.match(selection, /700 bps：.*清单引用循环/);
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1]);
  assert.equal(app.element("segmentVal").textContent, selection);
});

test("all failed variants report every candidate rather than silently selecting unusable media", async () => {
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nunavailable.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nempty.m3u8',
    routes: { [`${base}empty.m3u8`]: "#EXTM3U\n#EXT-X-ENDLIST" },
    fetch: async (url) => url.endsWith("unavailable.m3u8") ? new Response("Not found", { status: 404 }) : undefined
  });
  assert.equal(app.element("btnStart").disabled, false);
      assert.equal(app.element("btnStart").textContent, "重新解析清单");
  assert.match(app.element("statusMsg").textContent, /全部 2 档码率均不可用/);
  assert.match(app.element("statusMsg").textContent, /900 bps：.*HTTP 404/);
  assert.match(app.element("statusMsg").textContent, /100 bps：清单中没有可下载的分片/);
  assert.equal(app.state.downloads.length, 0);
});

test("a highest-bandwidth variant returning an HTTP 200 login page falls back to a valid playlist", async () => {
  const app = await boot({
    playlist: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8',
    routes: {
      [`${base}high.m3u8`]: '<!DOCTYPE html>\n<html><body>Sign in to continue</body></html>',
      [`${base}low.m3u8`]: mediaPlaylist(1)
    }
  });
  assert.deepEqual(app.state.requests.map((request) => request.url), [masterUrl, `${base}high.m3u8`, `${base}low.m3u8`]);
  assert.match(app.element("segmentVal").textContent, /已选 100 bps（第 2\/2 档）/);
  assert.match(app.element("segmentVal").textContent, /900 bps：.*缺少 #EXTM3U 文件头/);
  await app.click("btnStart");
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1]);
  assert.deepEqual(app.state.requests.map((request) => request.url), [masterUrl, `${base}high.m3u8`, `${base}low.m3u8`, `${base}s0.ts`]);
});

test("invalid root responses report a missing HLS header without interpreting body lines as media URLs", async (t) => {
  for (const [name, playlist] of [
    ["HTML login page", '<!DOCTYPE html>\n<html><body>Sign in to continue</body></html>'],
    ["media lines without header", '#EXTINF:1\ns0.ts\n#EXT-X-ENDLIST']
  ]) {
    await t.test(name, async () => {
      const app = await boot({ playlist });
      assert.equal(app.element("btnStart").disabled, false);
      assert.equal(app.element("btnStart").textContent, "重新解析清单");
      assert.match(app.element("statusMsg").textContent, /响应不是有效的 HLS 清单，缺少 #EXTM3U 文件头/);
      assert.equal(app.state.requests.length, 1);
      assert.equal(app.state.blobs.length, 0);
      assert.equal(app.state.downloads.length, 0);
      await app.click("btnCopyUrl");
      assert.deepEqual(app.state.copied, [masterUrl]);
    });
  }
});

test("master cycle detection recognizes redirect aliases and leaves acyclic nesting unrestricted", async (t) => {
  await t.test("redirect back to an ancestor", async () => {
    const app = await boot({
      playlist: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nalias.m3u8',
      fetch: async (url) => url.endsWith("alias.m3u8") ? {
        ok: true, url: masterUrl,
        text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nalias.m3u8'
      } : undefined
    });
    assert.equal(app.element("btnStart").disabled, false);
      assert.equal(app.element("btnStart").textContent, "重新解析清单");
    assert.match(app.element("statusMsg").textContent, /清单引用循环/);
    assert.equal(app.state.requests.length, 2);
  });
  await t.test("twenty distinct nested masters", async () => {
    const routes = {};
    for (let index = 0; index < 20; index++) {
      routes[`${base}nested-${index}.m3u8`] = index === 19
        ? mediaPlaylist(1)
        : `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nnested-${index + 1}.m3u8`;
    }
    const app = await boot({
      playlist: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nnested-0.m3u8', routes
    });
    await app.click("btnStart");
    assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1]);
    assert.equal(app.state.requests.filter((request) => request.url.endsWith(".m3u8")).length, 21);
  });
});

function stalledFetch(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

test('playlist loading keeps copy/cancel alive and can retry in the same page', async () => {
  let stall = true;
  const app = await boot({ deferReady: true,
    fetch: (url, { signal }) => stall ? stalledFetch(signal) : undefined });
  await app.click('btnCopyUrl');
  assert.deepEqual(app.state.copied, [masterUrl]);
  await app.click('btnCancel');
  await app.ready;
  assert.equal(app.state.requests[0].signal.aborted, true);
  assert.match(app.element('statusMsg').textContent, /已取消清单加载/);
  stall = false;
  await app.click('btnStart'); // Reparse only, no surprise download.
  assert.equal(app.state.requests.length, 2);
  assert.equal(app.state.blobs.length, 0);
  await app.click('btnStart');
  assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())], [1]);
});

test('cancel reaches key/MAP preparation and does not fall through to another variant', async (t) => {
  for (const stage of ['key.bin', 'init.bin']) await t.test(stage, async () => {
    const reached = deferred();
    const app = await boot({ deferReady: true,
      playlist: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8',
      routes: { [`${base}high.m3u8`]: stage === 'key.bin'
        ? '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1\ns0.ts'
        : '#EXTM3U\n#EXT-X-MAP:URI="init.bin"\n#EXTINF:1\ns0.ts' },
      fetch: (url, { signal }) => {
        if (url.endsWith(stage)) { reached.resolve(); return stalledFetch(signal); }
      }
    });
    await reached.promise;
    await app.click('btnCancel'); await app.ready;
    assert.match(app.element('statusMsg').textContent, /已取消/);
    assert.equal(app.state.requests.some(r => r.url.endsWith('low.m3u8')), false);
    assert.equal(app.state.blobs.length, 0);
  });
});

test('idle deadline covers both response headers and body then permits retry', async (t) => {
  for (const stage of ['headers', 'body']) await t.test(stage, async () => {
    const app = await boot({ idleTimeoutMs: 10,
      fetch: (_url, { signal }) => stage === 'headers' ? stalledFetch(signal)
        : new Response(new ReadableStream({ start(controller) {
          signal.addEventListener('abort', () => controller.error(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
        } }))
    });
    assert.match(app.element('statusMsg').textContent, /30 秒未收到数据/);
    assert.equal(app.element('btnStart').textContent, '重新解析清单');
    assert.equal(app.element('btnStart').disabled, false);
    await app.click('btnCopyUrl');
    assert.deepEqual(app.state.copied, [masterUrl]);
  });
});

test('invalid Range bodies retry but cannot commit corrupt bytes', async (t) => {
  const cases = [
    ['short 200', 200, [1,2,3], {}],
    ['length equals range but misses offset', 200, [1,2,3,4], {}],
    ['short 206', 206, [1,2,3], { 'Content-Range': 'bytes 4-7/8' }],
    ['wrong offset 206', 206, [1,2,3,4], { 'Content-Range': 'bytes 0-3/8' }],
    ['missing Content-Range', 206, [1,2,3,4], {}],
    ['invalid total', 206, [1,2,3,4], { 'Content-Range': 'bytes 4-7/7' }]
  ];
  for (const [name,status,body,headers] of cases) await t.test(name, async () => {
    const {state,writer}=makeWriter();
    const app=await boot({playlist:'#EXTM3U\n#EXT-X-BYTERANGE:4@4\n#EXTINF:1\nrange.ts\n#EXT-X-ENDLIST',
      picker:async()=>({createWritable:async()=>writer}),
      fetch:async url=>url.endsWith('range.ts')?new Response(bytes(...body),{status,headers}):undefined});
    await app.click('btnStart');
    assert.equal(app.state.requests.filter(r=>r.url.endsWith('range.ts')).length,3);
    assert.deepEqual(state.writes,[]); assert.equal(state.closes,0); assert.equal(state.aborts,1);
    assert.match(app.element('statusMsg').textContent,/全部切片下载失败/);
  });
});

test('Range retry accepts a later valid 206 and valid full 200 is sliced exactly', async (t) => {
  for (const full of [false,true]) await t.test(full?'full 200':'retry 206',async()=>{
    let attempt=0;
    const app=await boot({playlist:'#EXTM3U\n#EXT-X-BYTERANGE:4@4\n#EXTINF:1\nrange.ts\n#EXT-X-ENDLIST',
      fetch:async url=>{
        if(!url.endsWith('range.ts'))return;
        attempt++;
        if(full)return new Response(bytes(0,1,2,3,4,5,6,7));
        return attempt===1 ? new Response(bytes(1,2,3)) : new Response(bytes(4,5,6,7),{status:206,headers:{'Content-Range':'bytes 4-7/8'}});
      }});
    await app.click('btnStart');
    assert.deepEqual([...new Uint8Array(await app.state.blobs[0].arrayBuffer())],[4,5,6,7]);
    assert.equal(attempt,full?1:2);
    assert.match(app.element('statusMsg').textContent,/视频文件已保存/);
  });
});
