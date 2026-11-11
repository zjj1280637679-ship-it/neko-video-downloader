// Real HTTP and filesystem smoke test. DOM/picker are substitutes, not a browser.
// Usage: node tests/http-download-smoke.cjs /tmp/neko-browser-fixtures
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');
const fixtureDir = path.resolve(process.argv[2]);
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'neko-http-'));
const base = 'http://127.0.0.1:8765';
const server = spawn('python', [path.join(__dirname, 'browser_fixture_server.py'), '--fixtures', fixtureDir], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', chunk => { logs += chunk; });
server.stderr.on('data', chunk => { logs += chunk; });

async function boot(name) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', value: '', style: {}, handlers: {},
      addEventListener(event, fn) { this.handlers[event] = fn; }, select() {} });
    return elements.get(id);
  };
  let readyHandler;
  const requests = [];
  const document = { getElementById: element, addEventListener(_event, fn) { readyHandler = fn; } };
  const filename = path.join(output, name + '.mp4');
  const temp = filename + '.partial';
  const context = vm.createContext({
    document, window: { location: { search: `?url=${encodeURIComponent(base + '/' + name + '.m3u8')}&title=${name}` },
      showSaveFilePicker: async () => ({ createWritable: async () => {
        fs.writeFileSync(temp, '');
        return { async write(buf) { fs.appendFileSync(temp, new Uint8Array(buf)); },
          async close() { fs.renameSync(temp, filename); },
          async abort() { fs.rmSync(temp, { force: true }); } };
      } }) },
    navigator: { clipboard: { async writeText() {} } },
    chrome: { downloads: { download() {} } },
    fetch: (...args) => { requests.push(args[0]); return fetch(...args); }, URL, URLSearchParams, TextDecoder, Uint8Array, ArrayBuffer, Blob, AbortController,
    crypto: require('node:crypto').webcrypto, performance, console,
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  for (const file of ['adaptive-concurrency.js', 'adaptive-download.js', 'downloader.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  }
  const ready = readyHandler();
  return { ready, element, filename, requests, click: id => element(id).handlers.click() };
}

(async () => {
  for (let i = 0; ; i++) {
    try { if ((await fetch(base)).ok) break; } catch (_) {}
    if (i === 50 || server.exitCode !== null) throw new Error('Fixture server did not start: ' + logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const expected = fs.readFileSync(path.join(fixtureDir, 'valid.m4s'));
  for (const name of ['valid', 'full']) {
    const app = await boot(name); await app.ready; await app.click('btnStart');
    assert.deepEqual(fs.readFileSync(app.filename), expected);
    execFileSync('ffmpeg', ['-v', 'error', '-i', app.filename, '-f', 'null', '-']);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', app.filename]));
    console.log(JSON.stringify({ case: name, bytes: expected.length, byteExact: true, decode: 'passed', probe }));
  }
  const bad = await boot('broken'); await bad.ready; await bad.click('btnStart');
  assert.equal(fs.existsSync(bad.filename), false);
  assert.match(bad.element('statusMsg').textContent, /全部切片下载失败/);
  assert.equal(bad.requests.filter(url => url.endsWith('/broken.ts')).length, 3);
  console.log(JSON.stringify({ case: 'broken', retries: 3, committedFile: false }));
  const hang = await boot('hang');
  await hang.click('btnCopyUrl'); await hang.click('btnCancel'); await hang.ready;
  assert.match(hang.element('statusMsg').textContent, /已取消清单加载/);
  assert.equal(hang.element('btnStart').disabled, false);
  console.log(JSON.stringify({ case: 'hang', cancel: 'passed', retryEnabled: true }));
  const started = performance.now();
  const timeout = await boot('hang'); await timeout.ready;
  assert.match(timeout.element('statusMsg').textContent, /30 秒未收到数据/);
  console.log(JSON.stringify({ case: 'timeout', elapsedSeconds: (performance.now() - started) / 1000, retryEnabled: !timeout.element('btnStart').disabled }));
  console.log('Outputs: ' + output);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.kill(); await once(server, 'exit');
});
