// Visual fixtures only. Served on loopback, never bundled into the extension.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const relative = decodeURIComponent(url.pathname === '/' ? '/popup.html' : url.pathname);
  const file = path.resolve(root, '.' + relative);
  if (!file.startsWith(root + path.sep) || !/\.(html|js|css|svg|png)$/.test(file) || !fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  let body = fs.readFileSync(file);
  if (file === path.join(root, 'popup.html')) body = body.toString().replace('<body>', '<body><script src="/scripts/preview-fixture.js"></script>');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' }); res.end(body);
});
server.listen(4173, '127.0.0.1', () => console.log('Visual fixtures: http://127.0.0.1:4173/?case=source (also jobs, empty, error). All data is simulated.'));
