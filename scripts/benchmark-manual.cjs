#!/usr/bin/env node
'use strict';
// Fixed concurrency only. Real loopback HTTP/fetch; no remote media or video files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const MiB = 1024 ** 2;
const SCENARIOS = ['ordered', 'slow-head', 'slow-sink', 'retry-after'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(value * 1000) / 1000;

function parseArgs(argv) {
  const args = { baselines: [1, 64, 375], segments: 384, repeat: 1,
    scenarios: ['ordered', 'slow-head', 'slow-sink'], quick: false, chunked: false, memoryStress: false,
    core: path.resolve(__dirname, '../hls-core.js'), output: null, headerDelayMs: 5, cancelAfterMs: null,
    persistentLimit: false, retryAttempts: null,
    maxBufferedBytes: 192 * MiB, maxResourceBytes: 64 * MiB };
  for (const arg of argv) {
    if (arg === '--quick') args.quick = true;
    else if (arg === '--chunked') args.chunked = true;
    else if (arg === '--memory-stress') args.memoryStress = true;
    else if (arg === '--persistent-limit') args.persistentLimit = true;
    else if (arg.startsWith('--baseline=')) args.baselines = arg.slice(11).split(',').map(Number);
    else if (arg.startsWith('--scenario=')) args.scenarios = arg.slice(11).split(',');
    else if (arg.startsWith('--segments=')) args.segments = Number(arg.slice(11));
    else if (arg.startsWith('--repeat=')) args.repeat = Number(arg.slice(9));
    else if (arg.startsWith('--output=')) args.output = path.resolve(arg.slice(9));
    else if (arg.startsWith('--core=')) args.core = path.resolve(arg.slice(7));
    else if (arg.startsWith('--header-delay=')) args.headerDelayMs = Number(arg.slice(15));
    else if (arg.startsWith('--cancel-after=')) args.cancelAfterMs = Number(arg.slice(15));
    else if (arg.startsWith('--retry-attempts=')) args.retryAttempts = Number(arg.slice(17));
    else if (arg === '--help') {
      process.stdout.write('node scripts/benchmark-manual.cjs [--baseline=1,64,375] [--scenario=ordered,slow-head,slow-sink,retry-after] [--segments=384] [--memory-stress] [--chunked] [--quick] [--repeat=1] [--header-delay=5] [--cancel-after=50] [--output=path]\n');
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.memoryStress) {
    args.maxBufferedBytes = 4 * MiB; args.maxResourceBytes = MiB;
    if (!argv.some(arg => arg.startsWith('--segments='))) args.segments = 12;
    if (!argv.some(arg => arg.startsWith('--scenario='))) args.scenarios = ['slow-head', 'slow-sink'];
  }
  assert(args.baselines.length && args.baselines.every(n => Number.isInteger(n) && n >= 1 && n <= 375), 'concurrency must be an integer in 1..375');
  args.baselines = [...new Set(args.baselines)];
  assert(Number.isInteger(args.segments) && args.segments >= 1 && args.segments <= 2048, 'segments must be 1..2048');
  assert(Number.isInteger(args.repeat) && args.repeat >= 1 && args.repeat <= 10, 'repeat must be 1..10');
  assert(Number.isFinite(args.headerDelayMs) && args.headerDelayMs >= 0 && args.headerDelayMs <= 5000, 'header delay must be 0..5000ms');
  assert(args.cancelAfterMs === null || Number.isFinite(args.cancelAfterMs) && args.cancelAfterMs >= 1 && args.cancelAfterMs <= 10000, 'cancel delay must be 1..10000ms');
  assert(args.retryAttempts === null || Number.isInteger(args.retryAttempts) && args.retryAttempts >= 1 && args.retryAttempts <= 10, 'retry attempts must be 1..10');
  for (const scenario of args.scenarios) assert(SCENARIOS.includes(scenario), `Unknown scenario: ${scenario}`);
  return args;
}

function makeFixture(count, packets = 16) {
  const segments = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.alloc(188 * packets);
    for (let offset = 0; offset < bytes.length; offset += 188) {
      bytes[offset] = 0x47; bytes[offset + 1] = (index >>> 8) & 0x1f;
      bytes[offset + 2] = index & 0xff; bytes[offset + 3] = 0x10 | ((offset / 188) & 15);
      for (let n = offset + 4; n < offset + 188; n++) bytes[n] = (index * 37 + n * 13) & 255;
    }
    return bytes;
  });
  const hash = crypto.createHash('sha256');
  for (const bytes of segments) hash.update(bytes);
  return { segments, bytes: segments.reduce((sum, bytes) => sum + bytes.length, 0), sha256: hash.digest('hex') };
}

function retryDelay(value, now = Date.now()) {
  if (/^\d+$/.test(value || '')) return Number(value) * 1000;
  const date = Date.parse(value || '');
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

async function startServer(scenario, fixture, args) {
  const active = new Set(), attempts = new Map(), retryUntil = new Map();
  const started = performance.now(), scale = args.quick ? 0.25 : 1;
  const stats = { requests: 0, peakActive: 0, sentBytes: 0, rejected429: 0, rejected503: 0,
    retryAfterViolations: 0, requestLog: [] };
  const server = http.createServer((req, res) => {
    if (req.url === '/list.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n${fixture.segments.map((_, i) => `#EXTINF:5,\n/${i}.ts`).join('\n')}\n#EXT-X-ENDLIST\n`);
      return;
    }
    const match = /^\/(\d+)\.ts$/.exec(req.url || '');
    const index = match ? Number(match[1]) : -1;
    if (!fixture.segments[index]) { res.writeHead(404); res.end(); return; }
    const now = performance.now(), attempt = (attempts.get(index) || 0) + 1;
    attempts.set(index, attempt); stats.requests++;
    if (now < (retryUntil.get(index) || 0) - 30) stats.retryAfterViolations++;
    const status = args.persistentLimit && index === 0 ? 429 : scenario === 'retry-after' && attempt === 1 ? (index % 11 === 10 ? 503 : index % 7 === 6 ? 429 : 200) : 200;
    const row = { index, attempt, status, startMs: round(now - started), headersAtMs: null, firstBodyAtMs: null, endMs: null, bytes: 0 };
    stats.requestLog.push(row);
    if (status !== 200) {
      stats[status === 429 ? 'rejected429' : 'rejected503']++;
      const value = status === 429 ? '1' : new Date(Date.now() + 2000).toUTCString();
      const wait = retryDelay(value);
      retryUntil.set(index, now + wait); row.retryAfter = value; row.retryAfterMs = wait;
      res.writeHead(status, { 'Retry-After': value, 'Content-Length': '0' }); res.end();
      row.endMs = round(performance.now() - started); return;
    }
    const entry = { index, res, row, offset: 0, credit: 0, headers: false, waitingDrain: false,
      readyAt: now + args.headerDelayMs * scale + (scenario === 'slow-head' && index === 0 ? 400 * scale : 0) };
    active.add(entry); stats.peakActive = Math.max(stats.peakActive, active.size);
    res.on('close', () => { active.delete(entry); if (row.endMs === null) row.endMs = round(performance.now() - started); });
    res.on('drain', () => { entry.waitingDrain = false; });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), elapsed = Math.min(100, now - lastTick) / 1000;
    lastTick = now;
    const rate = 4 * MiB / scale;
    for (const entry of [...active]) {
      if (now < entry.readyAt || entry.waitingDrain) continue;
      const bytes = fixture.segments[entry.index];
      if (!entry.headers) {
        entry.res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store',
          ...(args.chunked ? {} : { 'Content-Length': bytes.length }) });
        entry.res.flushHeaders(); entry.headers = true; entry.row.headersAtMs = round(now - started);
      }
      entry.credit = Math.min(rate * 0.2, entry.credit + rate * elapsed);
      const amount = Math.floor(Math.min(bytes.length - entry.offset, entry.credit));
      if (!amount) continue;
      if (entry.row.firstBodyAtMs === null) entry.row.firstBodyAtMs = round(now - started);
      entry.waitingDrain = !entry.res.write(bytes.subarray(entry.offset, entry.offset + amount));
      entry.offset += amount; entry.credit -= amount; entry.row.bytes += amount; stats.sentBytes += amount;
      if (entry.offset === bytes.length) { entry.res.end(); active.delete(entry); entry.row.endMs = round(now - started); }
    }
  }, args.quick ? 5 : 20);
  return { url: `http://127.0.0.1:${server.address().port}`, stats, active,
    async close() { clearInterval(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

function instrumentFetch(origin, stats) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, origin, 'benchmark must stay on loopback');
    const segment = /\/\d+\.ts$/.test(new URL(url).pathname);
    let done = false;
    const finalize = () => { if (segment && !done) { done = true; stats.active--; } };
    if (segment) {
      if (performance.now() < stats.originWaitUntil - 30) stats.originCooldownViolations++;
      stats.active++; stats.peakActive = Math.max(stats.peakActive, stats.active);
    }
    let response;
    try { response = await fetch(url, options); } catch (error) { finalize(); throw error; }
    if (segment && [429, 503].includes(response.status)) {
      stats.originWaitUntil = Math.max(stats.originWaitUntil, performance.now() + retryDelay(response.headers.get('retry-after')));
    }
    if (segment && response.ok) stats[response.headers.has('content-length') ? 'responsesWithLength' : 'responsesWithoutLength']++;
    if (!segment || !response.body) { finalize(); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) { finalize(); controller.close(); return; }
          if (response.ok) {
            stats.deliveredBytes += item.value.byteLength;
            stats.peakUnwrittenBytes = Math.max(stats.peakUnwrittenBytes, stats.deliveredBytes - stats.writtenBytes);
          }
          controller.enqueue(item.value);
        } catch (error) { finalize(); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { finalize(); } }
    }, { highWaterMark: 0 });
    const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(wrapped, 'url', { value: response.url });
    return wrapped;
  };
}

async function runOne(core, scenario, concurrency, fixture, args) {
  const source = await startServer(scenario, fixture, args);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('manual benchmark exceeded 120 seconds')), 120000);
  const stats = { active: 0, peakActive: 0, deliveredBytes: 0, writtenBytes: 0, peakUnwrittenBytes: 0,
    originWaitUntil: 0, originCooldownViolations: 0, responsesWithLength: 0, responsesWithoutLength: 0 };
  const initialMemory = process.memoryUsage();
  let peakRss = initialMemory.rss, peakArrayBuffers = initialMemory.arrayBuffers;
  let maximumReportedBuffer = 0, maximumReportedReservation = 0, nextIndex = 0;
  let startedAt = performance.now();
  let cancelTimer = null, cancelledAt = null;
  const reportedTargets = new Set(), timeline = [], metrics = [], hash = crypto.createHash('sha256');
  const sample = () => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss); peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
    timeline.push({ elapsedMs: round(performance.now() - startedAt), inFlight: stats.active, serverActive: source.active.size,
      deliveredBytes: stats.deliveredBytes, writtenBytes: stats.writtenBytes, completedSegments: nextIndex });
  };
  const timer = setInterval(sample, 1000);
  function checkCommon() {
    assert.equal(source.stats.retryAfterViolations, 0, 'same-resource retry arrived before Retry-After');
    assert.equal(stats.originCooldownViolations, 0, 'new origin work started before observed Retry-After elapsed');
    assert.equal(args.chunked ? stats.responsesWithLength : stats.responsesWithoutLength, 0, 'response framing');
    assert(stats.peakActive <= concurrency, 'fixed request ceiling');
    assert(stats.peakUnwrittenBytes <= args.maxBufferedBytes, 'observed unread-to-sink bytes exceed budget');
    assert(maximumReportedBuffer <= args.maxBufferedBytes, 'reported payload exceeds budget');
    assert(maximumReportedReservation <= args.maxBufferedBytes, 'reported reserved accounting exceeds budget');
    assert(reportedTargets.size > 0 && [...reportedTargets].every(target => target === concurrency), 'fixed concurrency target changed');
  }
  function snapshot(error, result) {
    sample(); const elapsedMs = performance.now() - startedAt;
    return { concurrency, ok: !error, ...(error ? { error: { name: error.name, message: error.message,
      httpStatus: error.httpStatus, attempts: error.attempts, stage: error.stage } } : {}),
      elapsedMs: round(elapsedMs), usefulBytes: stats.writtenBytes, expectedBytes: fixture.bytes, completedSegments: nextIndex,
      goodputBytesPerSecond: round(stats.writtenBytes / (elapsedMs / 1000)),
      peakClientRequests: stats.peakActive, peakServerRequests: source.stats.peakActive,
      peakUnwrittenBytes: stats.peakUnwrittenBytes, peakReportedBufferedBytes: maximumReportedBuffer,
      peakReportedReservedBytes: maximumReportedReservation, peakRssBytes: peakRss, peakArrayBuffersBytes: peakArrayBuffers,
      sha256: hash.copy().digest('hex'), integrityPassed: !error, reportedTargets: [...reportedTargets],
      originCooldownViolations: stats.originCooldownViolations,
      responseFraming: { withContentLength: stats.responsesWithLength, withoutContentLength: stats.responsesWithoutLength },
      result, http: source.stats, timeline, metrics };
  }
  try {
    const client = core.createClient({ fetch: instrumentFetch(source.url, stats), signal: abort.signal,
      ...(args.memoryStress ? { maxBufferedBytes: args.maxBufferedBytes, maxResourceBytes: args.maxResourceBytes } : {}),
      ...(args.retryAttempts === null ? {} : { retries: args.retryAttempts }),
      onMetrics(data) {
        if (Number.isFinite(data.bufferedBytes)) maximumReportedBuffer = Math.max(maximumReportedBuffer, data.bufferedBytes);
        if (Number.isFinite(data.reservedBufferBytes)) maximumReportedReservation = Math.max(maximumReportedReservation, data.reservedBufferBytes);
        const target = data.targetConcurrency ?? data.activeConcurrency;
        if (Number.isFinite(target)) reportedTargets.add(target);
        metrics.push({ elapsedMs: round(performance.now() - startedAt), ...data });
      } });
    const plan = await client.loadPlan(`${source.url}/list.m3u8`); startedAt = performance.now();
    const sink = { async write(value) {
      const bytes = ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
      assert(nextIndex < fixture.segments.length, 'unexpected extra output');
      assert(bytes.equals(fixture.segments[nextIndex]), `incorrect bytes or ordering at segment ${nextIndex}`);
      if (scenario === 'slow-sink') await sleep(args.quick ? 2 : 8);
      hash.update(bytes); stats.writtenBytes += bytes.length; nextIndex++;
    } };
    if (args.cancelAfterMs !== null) cancelTimer = setTimeout(() => {
      cancelledAt = performance.now(); abort.abort(new DOMException('Controlled cancellation', 'AbortError'));
    }, args.cancelAfterMs);
    const result = await client.download(plan, sink, () => {}, concurrency);
    assert.equal(args.cancelAfterMs, null, 'controlled cancellation should interrupt this configured workload');
    assert.equal(hash.copy().digest('hex'), fixture.sha256, 'final SHA-256');
    assert.equal(stats.writtenBytes, fixture.bytes, 'output bytes');
    assert.equal(nextIndex, fixture.segments.length, 'all segments written');
    checkCommon();
    return snapshot(null, result);
  } catch (error) {
    if (args.cancelAfterMs !== null && cancelledAt !== null && error.name === 'AbortError') {
      try {
        const deadline = performance.now() + 1500;
        while ((stats.active || source.active.size) && performance.now() < deadline) await sleep(10);
        assert.equal(stats.active, 0, 'all client requests must retire after cancellation');
        assert.equal(source.active.size, 0, 'server must observe all cancelled requests closing');
        checkCommon();
        return { ...snapshot(null), outcome: 'cancelled', integrityPassed: false, prefixIntegrityPassed: true,
          cancelLatencyMs: round(performance.now() - cancelledAt) };
      } catch (failure) { error = failure; }
    }
    process.stderr.write(`  ${scenario}/${concurrency} failed: ${error.message}\n`);
    return snapshot(error);
  } finally { clearInterval(timer); clearTimeout(timeout); clearTimeout(cancelTimer); abort.abort(); await source.close(); }
}

function sourceHashes(corePath) {
  const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const enginePath = path.join(path.dirname(corePath), 'engine');
  return { benchmarkSha256: hashFile(__filename), coreSha256: hashFile(corePath),
    engineSha256: fs.existsSync(enginePath) ? Object.fromEntries(fs.readdirSync(enginePath).filter(name => name.endsWith('.js')).sort()
      .map(name => [name, hashFile(path.join(enginePath, name))])) : {} };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv); if (!args) return;
  const hashes = sourceHashes(args.core), core = require(args.core);
  const fixture = makeFixture(args.segments, args.memoryStress ? 4096 : 16);
  const report = { schemaVersion: 3, mode: 'manual-only', generatedAt: new Date().toISOString(), nodeVersion: process.version,
    ...hashes, corePath: args.core, baselines: args.baselines, quick: args.quick, chunked: args.chunked, memoryStress: args.memoryStress,
    fixture: { segments: fixture.segments.length, segmentBytes: fixture.segments[0].length, bytes: fixture.bytes, sha256: fixture.sha256 },
    limits: { concurrency: 375, payloadPoolBytes: args.maxBufferedBytes, maxResourceBytes: args.maxResourceBytes },
    headerDelayMs: args.headerDelayMs, cancelAfterMs: args.cancelAfterMs,
    persistentLimit: args.persistentLimit, configuredRetryAttempts: args.retryAttempts,
    retrySlotPolicy: 'A retry remains in its original fixed task slot; the selected concurrency is never increased.',
    method: 'Fixed numeric concurrency only, real loopback HTTP/fetch, deterministic ordered synthetic bytes; no remote media.',
    limitations: ['Node is not Chrome or a remote CDN.', 'RSS includes the fixture server and GC.',
      'Payload observations exclude browser/network internal caches.', 'These bytes are transport fixtures, not a playback acceptance test.'], scenarios: [] };
  for (let repeat = 1; repeat <= args.repeat; repeat++) {
    for (const scenario of args.scenarios) {
      const runs = [];
      for (const concurrency of repeat % 2 ? args.baselines : [...args.baselines].reverse()) {
        process.stderr.write(`[${repeat}/${args.repeat}] ${scenario}: fixed ${concurrency}\n`);
        runs.push(await runOne(core, scenario, concurrency, fixture, args));
      }
      report.scenarios.push({ scenario, repeat, runs });
      process.stderr.write(`  ${scenario}: ${runs.map(run => `${run.concurrency}=${run.ok ? 'pass' : 'FAIL'} (${run.elapsedMs}ms, peak ${run.peakClientRequests})`).join(', ')}\n`);
    }
  }
  report.passed = report.scenarios.every(row => row.runs.every(run => run.ok));
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) { fs.mkdirSync(path.dirname(args.output), { recursive: true }); fs.writeFileSync(args.output, json); }
  process.stdout.write(json); if (!report.passed) process.exitCode = 1;
  return report;
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
module.exports = { parseArgs, makeFixture, retryDelay, startServer, runOne, main };
