const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function abortError() {
  return Object.assign(new Error("Canceled by acceptance test"), { name: "AbortError" });
}

class VirtualClock {
  constructor() { this.now = 0; this.nextId = 1; this.timers = new Map(); }
  schedule(callback, delay, interval = 0) {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.now + Math.max(0, Number(delay) || 0), interval });
    return id;
  }
  async advance(milliseconds) {
    const end = this.now + milliseconds;
    let fired = 0;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      assert.ok(++fired < 10_000, "virtual timer loop did not make progress");
      const [id, timer] = due;
      this.now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else this.timers.delete(id);
      timer.callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

async function bootShippedDownloader() {
  const clock = new VirtualClock();
  const elements = new Map();
  const state = { requests: [], metrics: [], writes: [], arrayBufferCalls: 0, closes: 0, aborts: 0, errors: [] };
  let ready;
  function element(id) {
    if (!elements.has(id)) {
      const handlers = new Map();
      elements.set(id, {
        textContent: "", value: "", style: {}, hidden: false, disabled: false,
        addEventListener(name, handler) { handlers.set(name, handler); },
        handlers,
        select() {}
      });
    }
    return elements.get(id);
  }
  const document = {
    getElementById: element,
    addEventListener(_name, handler) { ready = handler; },
    createElement() { throw new Error("streaming acceptance scenario must not export a Blob"); },
    body: { appendChild() {}, removeChild() {} }
  };
  const writer = {
    async write(buffer) { state.writes.push(buffer.byteLength); },
    async close() { state.closes++; },
    async abort() { state.aborts++; }
  };
  const playlistUrl = "https://stream.test/master.m3u8";
  const context = {
    document,
    window: {
      location: { search: `?url=${encodeURIComponent(playlistUrl)}&title=Streaming` },
      showSaveFilePicker: async () => ({ createWritable: async () => writer })
    },
    URL, URLSearchParams, TextDecoder, Uint8Array, ArrayBuffer, Blob, AbortController, Map, Set,
    crypto: require("node:crypto").webcrypto,
    navigator: { clipboard: { async writeText() {} } },
    chrome: { downloads: { download() {} } },
    console: { warn() {}, error(error) { state.errors.push(String(error)); } },
    performance: { now: () => clock.now },
    setTimeout: (callback, delay) => clock.schedule(callback, delay),
    setInterval: (callback, delay) => clock.schedule(callback, delay, Math.max(1, delay)),
    clearTimeout: (id) => clock.timers.delete(id),
    clearInterval: (id) => clock.timers.delete(id),
    async fetch(url, { signal } = {}) {
      if (url === playlistUrl) {
        // Deliberately misleading media durations and content lengths prevent
        // nominal metadata from being substituted for received chunk bytes.
        return new Response(`#EXTM3U\n${Array.from({ length: 200 }, (_, i) => `#EXTINF:9999\ns${i}.ts`).join("\n")}\n#EXT-X-ENDLIST`);
      }
      const index = Number(/s(\d+)\.ts$/.exec(url)[1]);
      const request = { index, signal, aborted: false, controller: null };
      const body = new ReadableStream({
        start(controller) {
          request.controller = controller;
          signal.addEventListener("abort", () => {
            request.aborted = true;
            controller.error(abortError());
          }, { once: true });
        }
      });
      state.requests.push(request);
      const response = new Response(body, { headers: { "Content-Length": "999999999" } });
      response.arrayBuffer = async () => {
        state.arrayBufferCalls++;
        throw new Error("arrayBuffer hides the ongoing network stream");
      };
      return response;
    }
  };
  vm.createContext(context);
  for (const file of ["adaptive-concurrency.js", "adaptive-download.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  const realRun = context.NekoAdaptive.runAdaptiveDownload;
  context.NekoAdaptive.runAdaptiveDownload = (options) => realRun({
    ...options,
    onMetrics(metric) {
      state.metrics.push({ ...metric });
      if (options.onMetrics) options.onMetrics(metric);
    }
  });
  context.window.NekoAdaptive = context.NekoAdaptive;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../downloader.js"), "utf8"), context);
  await ready();
  return {
    clock, state, element,
    click(id) { return element(id).handlers.get("click")(); }
  };
}

test("the shipped downloader feeds real reader chunks to adaptive scheduling before any media segment is complete", async () => {
  const app = await bootShippedDownloader();
  const running = app.click("btnStart");
  await flush();
  try {
    for (let quarter = 0; quarter < 160 && app.state.requests.length <= 5; quarter++) {
      for (const request of [...app.state.requests]) {
        assert.equal(request.aborted, false);
        request.controller.enqueue(new Uint8Array(4000));
      }
      await flush();
      await app.clock.advance(250);
    }
    assert.equal(app.state.arrayBufferCalls, 0, app.state.errors.join("\n"));
    assert.ok(app.state.requests.length > 5,
      `original downloader only opened ${app.state.requests.length} requests while its streams were running`);
    assert.equal(app.state.writes.length, 0);
    assert.equal(app.element("percentText").textContent, "0%");
    const samples = app.state.metrics.filter((metric) => metric.eligible && metric.bytesPerSecond > 0);
    assert.ok(samples.length > 0, "the original downloader never supplied a valid in-progress measurement");
    for (const sample of samples) {
      assert.ok(Math.abs(sample.bytesPerSecond / sample.concurrency - 16_000) < 1,
        `metadata, segment completion, or repeated byte accounting distorted the measured aggregate speed: ${JSON.stringify(sample)}`);
    }
  } finally {
    await app.click("btnCancel");
    await running;
  }
  assert.ok(app.state.requests.every((request) => request.aborted));
  assert.equal(app.state.aborts, 1);
  assert.equal(app.state.closes, 0);
  assert.equal(app.element("btnStart").disabled, false);
});
