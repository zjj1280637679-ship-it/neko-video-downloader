// Include the extension runtime and the files needed to install its native host.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, 'dist', `yangmo-${require('../manifest.json').version}`));
if (destination === root || root.startsWith(destination + path.sep)) throw new Error('Package destination must not contain the source tree');
const runtime = ['manifest.json', 'background.js', 'content.js', 'download-manager.js',
  'hls-core.js', 'segment-cache.js', 'offscreen.html', 'offscreen.js',
  'popup.html', 'popup.css', 'popup.js', 'domain', 'engine', 'ui',
  'README.md', 'VALIDATION.md', 'docs',
  'scripts/install-native.ps1', 'scripts/uninstall-native.ps1'];
for (const name of fs.readdirSync(path.join(root, 'native'))) {
  if (/^(?!test_)[a-z_]+\.py$/.test(name)) runtime.push(path.join('native', name));
}
fs.mkdirSync(destination, { recursive: true });
for (const file of runtime) {
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(root, file), target, { recursive: true });
}
fs.mkdirSync(path.join(destination, 'icons'), { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'icons'))) {
  if (/\.(png|svg)$/.test(name)) fs.copyFileSync(path.join(root, 'icons', name), path.join(destination, 'icons', name));
}
console.log(`Packaged ${require('../manifest.json').version}: ${destination}`);
