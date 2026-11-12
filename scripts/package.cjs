// Only the extension runtime goes into the installable directory.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, 'dist', `yangmo-${require('../manifest.json').version}`));
if (destination === root || root.startsWith(destination + path.sep)) throw new Error('Package destination must not contain the source tree');
const runtime = ['manifest.json', 'background.js', 'content.js', 'download-manager.js',
  'hls-core.js', 'segment-cache.js', 'offscreen.html', 'offscreen.js',
  'popup.html', 'popup.css', 'popup.js', 'domain', 'engine', 'ui'];
fs.mkdirSync(destination, { recursive: true });
for (const file of runtime) fs.cpSync(path.join(root, file), path.join(destination, file), { recursive: true });
fs.mkdirSync(path.join(destination, 'icons'), { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'icons'))) {
  if (/\.(png|svg)$/.test(name)) fs.copyFileSync(path.join(root, 'icons', name), path.join(destination, 'icons', name));
}
console.log(`Packaged ${require('../manifest.json').version}: ${destination}`);
