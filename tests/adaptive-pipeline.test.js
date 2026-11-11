const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ThroughputController } = require("../adaptive-concurrency.js");

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
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

function loadPipeline(clock) {
  const context = {
    module: { exports: {} },
    NekoAdaptive: { ThroughputController },
    require(name) {
      assert.ok(/adaptive-concurrency/.test(name), `unexpected module dependency ${name}`);
      return { ThroughputController };
    },
    AbortController, ArrayBuffer, Uint8Array, Map, Set, Promise,
    performance: { now: () => clock.now },
    setTimeout: (callback, delay) => clock.schedule(callback, delay),
    setInterval: (callback, delay) => clock.schedule(callback, delay, Math.max(1, delay)),
    clearTimeout: (id) => clock.timers.delete(id),
    clearInterval: (id) => clock.timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../adaptive-download.js"), "utf8"), context);
  return context.module.exports.runAdaptiveDownload || context.NekoAdaptive.runAdaptiveDownload;
}

function fixedController(targetConcurrency, onObservation) {
  const observations = [];
  return {
    targetConcurrency, observations,
    observe(observation) {
      observations.push({ ...observation });
      if (onObservation) onObservation(this, observation);
      return this.targetConcurrency;
    }
  };
}

async function fixture(options = {}) {
  const clock = new VirtualClock();
  const runAdaptiveDownload = loadPipeline(clock);
  const controller = options.controller || fixedController(3);
  const abort = new AbortController();
  const slots = new Map();
  const starts = [];
  const writes = [];
  const metrics = [];
  const events = [];
  function begin(slot) {
    assert.equal(slot.active, false);
    slot.active = true;
    slot.telemetry.start();
    events.push({ at: clock.now, type: "start", index: slot.index });
  }
  function end(slot, discarded = false) {
    if (!slot.active) return;
    slot.active = false;
    slot.telemetry.end({ discarded });
    events.push({ at: clock.now, type: "end", index: slot.index });
    if (discarded) slot.size = 0;
  }
  const running = runAdaptiveDownload({
    total: options.total || 40,
    controller,
    signal: abort.signal,
    now: () => clock.now,
    sampleIntervalMs: 1000,
    bufferHighWaterBytes: options.bufferHighWaterBytes || 64 * 1024 * 1024,
    onMetrics: (metric) => metrics.push({ at: clock.now, ...metric }),
    async fetchItem(index, telemetry, signal) {
      const pending = deferred();
      const slot = { index, telemetry, signal, pending, active: false, size: 0, settled: false };
      slots.set(index, slot);
      starts.push(index);
      if (!options.startPaused || !options.startPaused.includes(index)) begin(slot);
      const onAbort = () => {
        if (slot.settled) return;
        slot.settled = true;
        end(slot, true);
        pending.reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        return await pending.promise;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    async writeItem(result) {
      if (options.writeItem) await options.writeItem(result);
      if (result.buffer) writes.push({ index: result.index, size: result.buffer.byteLength });
    }
  });
  // Failures are asserted at the scenario boundary; attaching a handler now
  // prevents a deliberately aborted pending network task becoming unhandled.
  running.catch(() => {});
  await flush();
  async function emit(index, size) {
    const slot = slots.get(index);
    assert.ok(slot && slot.active, `request ${index} is not reading`);
    await slot.telemetry.waitForCapacity();
    slot.size += size;
    slot.telemetry.bytes(size);
    events.push({ at: clock.now, type: "bytes", index, size });
    await flush();
  }
  async function complete(index, success = true) {
    const slot = slots.get(index);
    assert.ok(slot && !slot.settled, `request ${index} is already settled`);
    if (success && slot.size === 0) await emit(index, 1);
    end(slot, !success);
    slot.settled = true;
    slot.pending.resolve({ index, buffer: success ? new ArrayBuffer(slot.size) : null });
    await flush();
  }
  async function cancel() {
    abort.abort();
    await assert.rejects(running, (error) => error.name === "AbortError");
    await flush();
    assert.ok([...slots.values()].every((slot) => !slot.active), "cancel left a network request active");
  }
  return { clock, controller, abort, slots, starts, writes, metrics, events, running, emit, complete, cancel, begin, end };
}

test("actual streaming bytes produce aggregate V before any segment completes and a new target is really filled", async () => {
  const controller = fixedController(3, (self) => { self.targetConcurrency = 7; });
  const app = await fixture({ controller });
  try {
    assert.equal(app.starts.length, 3);
    for (let quarter = 0; quarter < 4; quarter++) {
      for (const index of [0, 1, 2]) await app.emit(index, 1000);
      await app.clock.advance(250);
    }
    assert.equal(app.writes.length, 0);
    assert.equal(controller.observations.length, 1);
    assert.equal(controller.observations[0].concurrency, 3);
    assert.equal(controller.observations[0].bytesPerSecond, 12_000);
    assert.equal(app.starts.length, 7, "controller target changed but live request count did not");
    assert.equal([...app.slots.values()].filter((slot) => slot.active).length, 7);
  } finally {
    await app.cancel();
  }
});

test("the real controller and scheduler jointly grow beyond five while all original segments are still streaming", async () => {
  const controller = new ThroughputController();
  const app = await fixture({ controller, total: 200 });
  try {
    for (let quarter = 0; quarter < 160 && app.starts.length <= 5; quarter++) {
      for (const slot of [...app.slots.values()].filter((slot) => slot.active)) {
        await app.emit(slot.index, 1000);
      }
      await app.clock.advance(250);
    }
    assert.ok(app.starts.length > 5, `only ${app.starts.length} real requests opened`);
    assert.equal(app.writes.length, 0);
    assert.equal(app.starts.length, controller.targetConcurrency,
      "actual concurrency did not follow the fitted target");
    assert.ok(app.metrics.some((metric) => metric.eligible && metric.bytesPerSecond > 0));
  } finally {
    await app.cancel();
  }
});

test("one finished segment immediately releases a slot while earlier segments remain pending, and output stays ordered", async () => {
  const app = await fixture({ total: 12 });
  try {
    assert.deepEqual(app.starts, [0, 1, 2]);
    await app.complete(1);
    assert.ok(app.starts.includes(3), "finishing one request waited for its batch peers");
    assert.equal(app.writes.length, 0, "a later segment was written ahead of segment zero");
    await app.complete(2);
    assert.ok(app.starts.includes(4));
    await app.complete(0);
    for (let turns = 0; turns < 30 && app.slots.size < 12; turns++) {
      const newest = [...app.slots.values()].filter((slot) => !slot.settled).sort((a, b) => b.index - a.index)[0];
      assert.ok(newest, "pipeline lost all active work before exhaustion");
      await app.complete(newest.index, newest.index !== 7);
    }
    for (const slot of [...app.slots.values()].filter((slot) => !slot.settled).sort((a, b) => b.index - a.index)) {
      await app.complete(slot.index, slot.index !== 7);
    }
    await app.running;
    assert.deepEqual(app.writes.map(({ index }) => index), Array.from({ length: 12 }, (_, i) => i).filter((i) => i !== 7));
  } finally {
    app.abort.abort();
  }
});

test("reported N follows actual HTTP occupancy and an underfilled or terminal window cannot train the model", async () => {
  const controller = fixedController(3);
  const app = await fixture({ controller, startPaused: [2] });
  try {
    await app.emit(0, 1000);
    await app.emit(1, 1000);
    await app.clock.advance(500);
    app.begin(app.slots.get(2));
    await app.emit(2, 1000);
    await app.clock.advance(500);
    const sample = app.metrics.find((metric) => metric.at === 1000 && metric.bytesPerSecond > 0);
    assert.ok(sample, "no measurement was exposed");
    assert.equal(sample.concurrency, 2.5);
    assert.equal(sample.bytesPerSecond, 3000);
    assert.equal(sample.eligible, false);
    assert.equal(controller.observations.length, 0, "target N was substituted for actual occupancy");
  } finally {
    await app.cancel();
  }

  const tailController = fixedController(8);
  const tail = await fixture({ total: 2, controller: tailController });
  try {
    await tail.emit(0, 1000);
    await tail.emit(1, 1000);
    await tail.clock.advance(1000);
    assert.equal(tailController.observations.length, 0, "the draining tail trained a lower-concurrency response");
    assert.ok(tail.metrics.some((metric) => metric.bytesPerSecond > 0 && !metric.eligible));
  } finally {
    await tail.cancel();
  }
});

test("an excluded network window clears the real controller's incomplete group before later valid samples", async () => {
  const controller = new ThroughputController();
  const app = await fixture({ controller });
  try {
    for (let window = 0; window < 2; window++) {
      await app.emit(0, 1000);
      await app.clock.advance(1000);
    }
    assert.equal(controller.snapshot().pendingSamples, 2);
    assert.equal(controller.targetConcurrency, 1);
    await app.clock.advance(1000);
    assert.ok(app.metrics.some((metric) => metric.reason === "no-received-bytes" && !metric.eligible));
    assert.equal(controller.snapshot().pendingSamples, 0,
      "the excluded interval left stale partial response measurements behind");
    await app.emit(0, 1000);
    await app.clock.advance(1000);
    assert.equal(controller.targetConcurrency, 1,
      "two pre-gap windows and one post-gap window incorrectly triggered an upward probe");
    assert.equal(controller.snapshot().pendingSamples, 1);
  } finally {
    await app.cancel();
  }
});

test("disk and byte-buffer backpressure pauses stream reads and excludes its window from throughput decisions", async () => {
  const writing = deferred();
  const releaseWrite = deferred();
  const controller = fixedController(3);
  const app = await fixture({
    controller,
    bufferHighWaterBytes: 8,
    writeItem: async () => { writing.resolve(); await releaseWrite.promise; }
  });
  try {
    await app.clock.advance(250);
    await app.emit(0, 8);
    await app.complete(0);
    await writing.promise;
    let readAllowed = false;
    const waiting = app.slots.get(1).telemetry.waitForCapacity().then(() => { readAllowed = true; });
    waiting.catch(() => {});
    await flush();
    assert.equal(readAllowed, false, "the byte high-water mark did not pause further reads");
    await app.clock.advance(750);
    assert.equal(controller.observations.length, 0, "writer backpressure was fitted as a network response");
    assert.ok(app.metrics.some((metric) => metric.bytesPerSecond > 0 && !metric.eligible));
    releaseWrite.resolve();
    await flush();
    await waiting;
    assert.equal(readAllowed, true);
  } finally {
    releaseWrite.resolve();
    await app.cancel();
  }
});

test("a discarded retry contributes received wire bytes once and releases its old buffered body", async () => {
  const app = await fixture({ controller: fixedController(2) });
  try {
    await app.emit(0, 600);
    await app.emit(1, 400);
    await app.clock.advance(250);
    app.end(app.slots.get(0), true);
    await app.clock.advance(50);
    app.begin(app.slots.get(0));
    await app.emit(0, 500);
    await app.emit(1, 500);
    await app.clock.advance(700);
    const sample = app.metrics.find((metric) => metric.at === 1000 && metric.bytesPerSecond > 0);
    assert.ok(sample);
    assert.equal(sample.bytesPerSecond, 2000, "wire bytes were lost or counted again at retry/segment completion");
    assert.equal(sample.bufferedBytes, 1400, "discarded retry bytes remained in the byte-buffer budget");
    await app.complete(0);
    await app.complete(1);
    assert.deepEqual(app.writes.slice(0, 2), [{ index: 0, size: 500 }, { index: 1, size: 900 }]);
  } finally {
    await app.cancel();
  }
});

test("a writer failure aborts pending network requests and surfaces the original error", async () => {
  const diskError = new Error("Disk full acceptance fixture");
  const app = await fixture({ writeItem: async () => { throw diskError; } });
  await app.complete(0);
  await assert.rejects(app.running, (error) => error === diskError);
  await flush();
  assert.ok([...app.slots.values()].every((slot) => !slot.active));
  assert.equal(new Set(app.starts).size, app.starts.length, "writer failure retried a network item");
});
