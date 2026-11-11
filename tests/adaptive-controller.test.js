const test = require("node:test");
const assert = require("node:assert/strict");
const { ThroughputController } = require("../adaptive-concurrency.js");

// These response functions are independent acceptance scenarios. Each sample
// represents an entire, continuously occupied network measurement window: N is
// the number of actual requests and V is their combined received bytes/second.
// The tests deliberately avoid prescribing the implementation's fitted curve,
// exact target sequence, or number of internal search phases.
function exercise(controller, response, windows, noise = () => 1) {
  const history = [];
  for (let step = 0; step < windows; step++) {
    const concurrency = controller.targetConcurrency;
    assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0,
      `invalid actual concurrency ${concurrency}`);
    const bytesPerSecond = response(concurrency) * noise(step);
    const next = controller.observe({ concurrency, bytesPerSecond });
    assert.equal(next, controller.targetConcurrency);
    assert.ok(Number.isSafeInteger(next) && next > 0, `invalid target ${next}`);
    history.push({ concurrency, bytesPerSecond, next });
  }
  return history;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function seededNoise(seed = 123456789) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return 0.9 + (state / 2 ** 32) * 0.2;
  };
}

const plateau = (knee) => (n) => 1_000_000 * Math.min(n / knee, 1);
const peak = (optimum) => (n) => 1_000_000 * Math.max(0.01,
  (n / optimum) * Math.exp(1 - n / optimum));

test("continued aggregate-throughput growth escapes five and common fixed caps with non-unit probes", () => {
  const controller = new ThroughputController({ initialConcurrency: 1 });
  const history = [];
  for (let step = 0; step < 90 && controller.targetConcurrency < 257; step++) {
    history.push(...exercise(controller, (n) => 100_000 * n, 1));
  }
  assert.ok(controller.targetConcurrency >= 257,
    `linear response stopped exploring at ${controller.targetConcurrency}`);
  assert.ok(history.some(({ concurrency, next }) => next - concurrency > 1),
    "all upward probes were mechanical +1 steps");
});

test("a measured throughput plateau settles near its earliest full-speed concurrency", () => {
  const controller = new ThroughputController();
  const response = plateau(8);
  const history = exercise(controller, response, 180);
  const tail = history.slice(-60);
  const typical = median(tail.map(({ concurrency }) => concurrency));
  assert.ok(history.some(({ concurrency }) => concurrency > 8),
    "the plateau was never probed from above");
  assert.ok(typical >= 7 && typical <= 16,
    `plateau settled at ${typical}, expected a small full-speed target`);
  assert.ok(tail.reduce((sum, point) => sum + response(point.concurrency), 0) / tail.length >= 850_000,
    "plateau operation abandoned too much measured throughput");
});

test("a declining response curve returns from an overshoot to the observed throughput peak", () => {
  const controller = new ThroughputController();
  const response = peak(8);
  const history = exercise(controller, response, 210);
  const tail = history.slice(-60);
  assert.ok(history.some(({ concurrency }) => concurrency > 8),
    "the response peak was never crossed");
  const typical = median(tail.map(({ concurrency }) => concurrency));
  assert.ok(typical >= 5 && typical <= 12,
    `peaked response remained at concurrency ${typical}`);
  assert.ok(tail.reduce((sum, point) => sum + response(point.concurrency), 0) / tail.length >= 850_000,
    "the settled target stays far from the throughput peak");
});

test("repeatable measurement noise does not drive an unbounded search or persistent throughput loss", () => {
  const controller = new ThroughputController();
  const response = peak(10);
  const history = exercise(controller, response, 330, seededNoise());
  const tail = history.slice(-90);
  const typical = median(tail.map(({ concurrency }) => concurrency));
  assert.ok(typical >= 5 && typical <= 18,
    `noisy measurements settled at concurrency ${typical}`);
  assert.ok(tail.reduce((sum, point) => sum + response(point.concurrency), 0) / tail.length >= 800_000,
    "noise caused persistent operation far from the underlying response peak");
});

test("tiny between-group speed variation does not repeatedly discard a sharply peaked response curve", () => {
  const controller = new ThroughputController();
  const response = (n) => 1_000_000 * (n <= 8 ? n / 8 : Math.exp(-(n - 8) / 2));
  // Each three-window group has zero internal deviation, but successive groups
  // differ by 0.1%. Treating a zero within-group MAD as perfect certainty would
  // repeatedly discard the same useful curve and make expensive broad probes.
  const history = exercise(controller, response, 600,
    (step) => 1 + (Math.floor(step / 3) % 2) * 0.001);
  const tail = history.slice(-120);
  const actualAverage = tail.reduce((sum, point) => sum + response(point.concurrency), 0) / tail.length;
  assert.ok(actualAverage >= 900_000,
    `0.1% speed variation reduced underlying steady throughput to ${actualAverage}`);
});

test("a smooth response approaching its bandwidth limit settles at a useful plateau without perpetual upward drift", () => {
  const controller = new ThroughputController();
  const response = (n) => 1_000_000 * (1 - Math.exp(-n / 8));
  // N=24 already yields 95% of the limiting throughput. Indefinite growth on
  // its positive but vanishing derivative buys negligible additional capacity.
  const history = exercise(controller, response, 360);
  const tail = history.slice(-120);
  const typical = median(tail.map(({ concurrency }) => concurrency));
  assert.ok(typical >= 20 && typical <= 40,
    `smooth bandwidth saturation was treated as useful growth up to ${typical} requests`);
  const actualAverage = tail.reduce((sum, point) => sum + response(point.concurrency), 0) / tail.length;
  assert.ok(actualAverage >= 900_000,
    `the practical plateau lost too much aggregate speed: ${actualAverage}`);
  const earlier = median(tail.slice(0, 60).map(({ concurrency }) => concurrency));
  const later = median(tail.slice(60).map(({ concurrency }) => concurrency));
  assert.ok(later <= earlier + 4,
    `target continued drifting upward after saturation: ${earlier} to ${later}`);
});

test("changed network capacity replaces stale evidence and supports renewed upward and downward discovery", () => {
  const controller = new ThroughputController();
  exercise(controller, plateau(4), 180);
  const expanded = exercise(controller, plateau(24), 360);
  const expansionTarget = median(expanded.slice(-90).map(({ concurrency }) => concurrency));
  assert.ok(expansionTarget >= 18 && expansionTarget <= 48,
    `new capacity was not found: typical concurrency ${expansionTarget}`);
  const contracted = exercise(controller, peak(5), 360);
  const contractionTarget = median(contracted.slice(-90).map(({ concurrency }) => concurrency));
  assert.ok(contractionTarget >= 3 && contractionTarget <= 9,
    `old high-concurrency evidence survived the network change: ${contractionTarget}`);
});

test("periodic probing discovers extra capacity even when throughput at the old operating target is unchanged", () => {
  const controller = new ThroughputController();
  const previousResponse = (n) => Math.min(100_000 * n, 400_000);
  const improvedResponse = (n) => Math.min(100_000 * n, 2_400_000);
  const established = exercise(controller, previousResponse, 180);
  const oldTarget = median(established.slice(-60).map(({ concurrency }) => concurrency));
  assert.equal(previousResponse(oldTarget), improvedResponse(oldTarget),
    "the acceptance scenario must leave throughput at its old operating point unchanged");
  const expanded = exercise(controller, improvedResponse, 420);
  const typical = median(expanded.slice(-90).map(({ concurrency }) => concurrency));
  assert.ok(typical >= 18 && typical <= 48,
    `unchanged anchor throughput concealed the new capacity; typical target ${typical}`);
});

test("invalid and zero-speed observations cannot manufacture a target change", () => {
  const controller = new ThroughputController();
  const initial = controller.targetConcurrency;
  for (const observation of [
    { concurrency: 1, bytesPerSecond: 0 },
    { concurrency: 1, bytesPerSecond: NaN },
    { concurrency: 1, bytesPerSecond: Infinity },
    { concurrency: 0, bytesPerSecond: 1_000_000 },
    { concurrency: -1, bytesPerSecond: 1_000_000 },
    { concurrency: NaN, bytesPerSecond: 1_000_000 },
    { concurrency: Infinity, bytesPerSecond: 1_000_000 }
  ]) {
    assert.equal(controller.observe(observation), initial);
    assert.equal(controller.targetConcurrency, initial);
  }
});

test("near-full real occupancy with differing fractional N forms a response point without rounding N to the target", () => {
  const controller = new ThroughputController({ initialConcurrency: 3 });
  for (const concurrency of [2.71, 2.88, 2.96]) {
    controller.observe({ concurrency, bytesPerSecond: concurrency * 100_000 });
  }
  assert.ok(controller.targetConcurrency > 3,
    "fractional occupancy windows never accumulated into a useful observation");
  const points = controller.snapshot().curve;
  assert.ok(points.length > 0);
  const point = points.find((candidate) => candidate.probeTarget === 3);
  assert.ok(point, "the original operating target was not retained separately");
  assert.ok(point.concurrency >= 2.71 && point.concurrency <= 2.96,
    `measured occupancy ${point.concurrency} was replaced by the nominal target`);

  const history = [];
  for (let step = 0; step < 90 && controller.targetConcurrency < 129; step++) {
    const target = controller.targetConcurrency;
    const concurrency = target * [0.91, 0.96, 0.99][step % 3];
    const next = controller.observe({ concurrency, bytesPerSecond: concurrency * 100_000 });
    history.push({ target, concurrency, next });
  }
  assert.ok(controller.targetConcurrency >= 129,
    `time-weighted real N stalled learning at target ${controller.targetConcurrency}`);
  assert.ok(history.some(({ target, next }) => next > target + 1));
});

test("discarding incomplete measurement windows prevents cross-gap mixing without changing the fitted decision", () => {
  const controller = new ThroughputController();
  for (let index = 0; index < 2; index++) {
    controller.observe({ concurrency: 1, bytesPerSecond: 100_000 });
  }
  assert.equal(controller.snapshot().pendingSamples, 2);
  controller.discardPendingSamples();
  assert.equal(controller.snapshot().pendingSamples, 0);
  assert.equal(controller.targetConcurrency, 1);
  for (let index = 0; index < 2; index++) {
    controller.observe({ concurrency: 1, bytesPerSecond: 200_000 });
  }
  assert.equal(controller.targetConcurrency, 1);
  assert.equal(controller.snapshot().curve.length, 0,
    "old partial windows were mixed into a new-network response point");
  controller.observe({ concurrency: 1, bytesPerSecond: 200_000 });
  assert.ok(controller.targetConcurrency > 1);
  assert.equal(controller.snapshot().curve[0].bytesPerSecond, 200_000);

  controller.observe({ concurrency: controller.targetConcurrency, bytesPerSecond: 300_000 });
  const before = controller.snapshot();
  controller.discardPendingSamples();
  const after = controller.snapshot();
  assert.equal(after.pendingSamples, 0);
  assert.equal(after.targetConcurrency, before.targetConcurrency);
  assert.equal(after.phase, before.phase);
  assert.deepEqual(after.curve, before.curve);
  assert.deepEqual(after.lastDecision, before.lastDecision);
  assert.equal(after.acceptedObservations, before.acceptedObservations);
  assert.equal(after.rejectedObservations, before.rejectedObservations);
});
