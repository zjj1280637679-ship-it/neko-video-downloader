"""Serve the unmodified downloader page and local HLS fixtures for manual browser QA.

Generate fixtures (requires ffmpeg), then run:
  python tests/browser_fixture_server.py --fixtures /tmp/neko-browser-fixtures
This is a webpage test, not an installed-extension acceptance test.
"""
import argparse
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            name = urlsplit(self.path).path.lstrip('/')
            if name == 'hang.m3u8':
                threading.Event().wait(45)
                return
            status, headers = 200, {}
            mime = 'application/octet-stream'
            if not name:
                mime = 'text/html; charset=utf-8'
                links = ''.join(f'<li><a href="/downloader.html?url={quote(f"http://127.0.0.1:{args.port}/{case}.m3u8", safe="")}&title={case}">{case}</a></li>'
                                for case in ('valid', 'full', 'broken', 'hang'))
                body = ('<!doctype html><meta charset="utf-8"><title>Neko browser QA</title>'
                        '<h1>Neko browser QA</h1><p>Original downloader scripts, real HTTP and browser APIs.</p>'
                        '<ul>' + links + '</ul>').encode()
            elif name in ('broken.m3u8', 'full.m3u8'):
                mime = 'application/vnd.apple.mpegurl'
                if name == 'full.m3u8':
                    body = (args.fixtures / 'valid.m3u8').read_bytes().replace(b'valid.m4s', b'full.m4s')
                else:
                    body = b'#EXTM3U\n#EXT-X-BYTERANGE:4@4\n#EXTINF:1\nbroken.ts\n#EXT-X-ENDLIST\n'
            elif name == 'broken.ts':
                body = b'bad'  # Deliberately ignore Range and truncate.
            elif name in ('valid.m3u8', 'valid.m4s', 'full.m4s'):
                body = (args.fixtures / ('valid.m4s' if name == 'full.m4s' else name)).read_bytes()
                if name.endswith('.m3u8'):
                    mime = 'application/vnd.apple.mpegurl'
                else:
                    mime = 'video/mp4'
                    spec = self.headers.get('Range')
                    if spec and name != 'full.m4s':
                        match = re.fullmatch(r'bytes=(\d+)-(\d+)', spec)
                        if not match:
                            self.send_error(416)
                            return
                        start, end = map(int, match.groups())
                        if not 0 <= start <= end < len(body):
                            self.send_error(416)
                            return
                        status = 206
                        headers['Content-Range'] = f'bytes {start}-{end}/{len(body)}'
                        body = body[start:end + 1]
            elif name in ('downloader.html', 'downloader.js', 'adaptive-download.js', 'adaptive-concurrency.js'):
                body = (ROOT / name).read_bytes()
                mime = 'text/html; charset=utf-8' if name.endswith('.html') else 'text/javascript'
            else:
                self.send_error(404)
                return
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            print(json.dumps({'path': name, 'range': self.headers.get('Range'), 'status': status, 'bytes': len(body)}), flush=True)

    print(f'Open http://127.0.0.1:{args.port}/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
