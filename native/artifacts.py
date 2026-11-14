"""Read-only, task-bound loopback delivery. Never a filesystem/command API."""
from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import secrets
import threading
import time


class ArtifactServer:
    def __init__(self):
        self.entries = {}
        self.lock = threading.RLock()
        owner = self

        class LimitedServer(ThreadingHTTPServer):
            daemon_threads = True
            slots = threading.BoundedSemaphore(16)

            def process_request(self, request, address):
                if not self.slots.acquire(blocking=False):
                    self.shutdown_request(request)
                    return
                try:
                    super().process_request(request, address)
                except BaseException:
                    self.slots.release()
                    raise

            def process_request_thread(self, request, address):
                try:
                    super().process_request_thread(request, address)
                finally:
                    self.slots.release()

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def setup(self):
                super().setup()
                self.connection.settimeout(5)

            def handle(self):
                try:
                    super().handle()
                except (ConnectionError, TimeoutError, OSError):
                    # Closing a browser download or an unfinished HTTP header
                    # is normal cancellation, not an error to print with a URL.
                    self.close_connection = True

            def log_message(self, *args):
                pass

            def do_HEAD(self): self.deliver(head=True)
            def do_GET(self): self.deliver(head=False)

            def deliver(self, head):
                self.connection.settimeout(5)
                if self.headers.get('Host') != f'127.0.0.1:{owner.port}':
                    self.send_error(403)
                    return
                match = re.fullmatch(r'/artifact/([A-Za-z0-9_-]{43})', self.path)
                if not match:
                    self.send_error(404)
                    return
                with owner.lease(match[1]) as entry:
                    if not entry:
                        self.send_error(404)
                        return
                    try:
                        path = entry['path']
                        size = path.stat().st_size
                        start, end, ranged = 0, size - 1, False
                        header = self.headers.get('Range')
                        if header:
                            bounds = re.fullmatch(r'bytes=(\d*)-(\d*)', header)
                            if not bounds or not any(bounds.groups()):
                                raise ValueError('range')
                            first, last = bounds.groups()
                            if first:
                                start = int(first)
                                end = min(int(last), size - 1) if last else size - 1
                            else:
                                length = int(last)
                                if length <= 0:
                                    raise ValueError('range')
                                start = max(0, size - length)
                            if start < 0 or start >= size or end < start:
                                raise ValueError('range')
                            ranged = True
                        self.send_response(206 if ranged else 200)
                        self.send_header('Content-Type', {'.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska'}.get(path.suffix, 'application/octet-stream'))
                        self.send_header('Content-Length', str(end - start + 1))
                        self.send_header('Accept-Ranges', 'bytes')
                        self.send_header('Cache-Control', 'no-store')
                        self.send_header('X-Content-Type-Options', 'nosniff')
                        if ranged:
                            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                        self.end_headers()
                        if head:
                            return
                        with path.open('rb') as stream:
                            stream.seek(start)
                            remaining = end - start + 1
                            while remaining and entry['live']:
                                block = stream.read(min(65536, remaining))
                                if not block:
                                    break
                                self.wfile.write(block)
                                remaining -= len(block)
                        if remaining:
                            self.close_connection = True
                    except ValueError:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{entry["path"].stat().st_size}')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                    except (OSError, BrokenPipeError):
                        self.close_connection = True

        self.server = LimitedServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, name='artifact-server', daemon=True)
        self.thread.start()

    def register(self, job_id, run_id, path):
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.entries[token] = {'jobId': job_id, 'runId': run_id, 'path': Path(path),
                                   'expires': time.monotonic() + 3600, 'live': True, 'readers': 0}
        return f'http://127.0.0.1:{self.port}/artifact/{token}'

    @contextmanager
    def lease(self, token):
        with self.lock:
            entry = self.entries.get(token)
            if not entry or not entry['live'] or entry['expires'] < time.monotonic():
                entry = None
            else:
                entry['readers'] += 1
        try:
            yield entry
        finally:
            if entry:
                with self.lock:
                    entry['readers'] -= 1

    def revoke(self, job_id, run_id, wait=True):
        with self.lock:
            matched = [(key, value) for key, value in self.entries.items()
                       if value['jobId'] == job_id and value['runId'] == run_id]
            for _, entry in matched:
                entry['live'] = False
        deadline = time.monotonic() + (6 if wait else 0)
        while any(entry['readers'] for _, entry in matched):
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.02)
        with self.lock:
            for key, _ in matched:
                self.entries.pop(key, None)
        return True

    def close(self):
        with self.lock:
            for entry in self.entries.values():
                entry['live'] = False
        self.server.shutdown()
        self.server.server_close()
