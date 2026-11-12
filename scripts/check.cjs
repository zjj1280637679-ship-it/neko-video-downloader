// Validate the actual extension entry points without adding a build dependency.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../manifest.json');
const pkg = require('../package.json');
const assert = require('node:assert/strict');
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
const files = [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(s => s.js)];
for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), `Missing entry: ${file}`);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', 'dist'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
let count = 0;
for (const file of walk(root)) {
  if (/\.(?:c?js)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    count++;
  }
  if (/\.html$/.test(file)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      assert.ok(!/^https?:/.test(match[1]), 'Runtime scripts must be local');
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1])), `Missing script: ${match[1]}`);
    }
  }
}
console.log(`Verified manifest ${manifest.version}, entry points and ${count} JavaScript files.`);
