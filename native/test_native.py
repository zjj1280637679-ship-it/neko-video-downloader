"""Offline regressions; no YouTube network calls or account material."""
import concurrent.futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import socket
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from artifacts import ArtifactServer
from common import atomic_json, auth_required, policy, safe_filename, task_path, youtube_cookies, youtube_url
from host import Host, MAX_MESSAGE, read_message
from process_tree import ProcessTree
from scheduler import Cancelled, ordered_dynamic_map
from worker import Progress, make_downloader


class QuietHost(Host):
    def run_queue(self):
        with self.condition:
            while not self.closing:
                self.condition.wait(0.1)


class NativeTests(unittest.TestCase):
    def test_filename_nfc_and_utf16_limit_preserves_suffix(self):
        self.assertEqual(safe_filename('Cafe\u0301 视频', 'mp4'), 'Café 视频.mp4')
        for extension in ('mp4', 'mkv', 'webm'):
            filename = safe_filename('✨😀' * 100, extension)
            self.assertTrue(filename.endswith('.' + extension))
            self.assertLessEqual(len(filename.encode('utf-16-le')) // 2, 140)
        self.assertEqual(safe_filename('CON', 'mp4'), '_CON.mp4')
        with self.assertRaises(ValueError): safe_filename('title', '../exe')

    def test_url_boundary(self):
        for url in ('https://youtu.be/jNQXAC9IVRw?t=3', 'https://www.youtube.com/shorts/jNQXAC9IVRw',
                    'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=irrelevant'):
            self.assertEqual(youtube_url(url), 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
        for url in ('https://evil.test/watch?v=jNQXAC9IVRw', 'file:///video', 'https://youtube.com@evil.test/watch?v=jNQXAC9IVRw',
                    'https://youtube.com:443/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=abc',
                    'https://youtube.com/watch?v=jNQXAC9IVRw&v=aaaaaaaaaaa'):
            with self.assertRaises(ValueError): youtube_url(url)

    def test_native_framing_and_size(self):
        data = json.dumps({'requestId': 'a', 'action': 'ping'}).encode()
        self.assertEqual(read_message(io.BytesIO(struct.pack('<I', len(data)) + data))['action'], 'ping')
        self.assertIsNone(read_message(io.BytesIO()))
        for data in (b'\x01', struct.pack('<I', MAX_MESSAGE + 1), struct.pack('<I', 12) + b'{}'):
            with self.assertRaises(ValueError): read_message(io.BytesIO(data))

    def test_paths_and_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in ('..', '../outside', 'a/b', 'a\\b', ''):
                with self.assertRaises(ValueError): task_path(directory, value, 'run')
            self.assertTrue(task_path(directory, 'job', 'run').is_relative_to(Path(directory).resolve()))
        for value in (0, 376, 1.5, True):
            with self.assertRaises(ValueError): policy({'concurrency': value})

    def test_worker_reuses_unchanged_control_and_observes_same_revision_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            control = Path(directory) / 'control.json'
            atomic_json(control, {'concurrency': 64, 'concurrencyRevision': 2, 'cancelled': False})
            progress = Progress(control)
            original_read = Path.read_text
            with patch.object(Path, 'read_text', autospec=True, side_effect=original_read) as read:
                for _ in range(1000):
                    self.assertEqual(progress.control()['concurrency'], 64)
                self.assertEqual(read.call_count, 1)
                atomic_json(control, {'concurrency': 65, 'concurrencyRevision': 3, 'cancelled': False})
                self.assertEqual(progress.control()['concurrency'], 65)
                # Cancellation does not necessarily bump the concurrency revision.
                atomic_json(control, {'concurrency': 65, 'concurrencyRevision': 3, 'cancelled': True})
                self.assertTrue(progress.control()['cancelled'])
                self.assertEqual(read.call_count, 3)

    def test_progress_burst_shares_control_checks_and_detects_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            control = Path(directory) / 'control.json'
            pref = {'concurrency': 8, 'concurrencyRevision': 2}
            atomic_json(control, pref)
            progress = Progress(control)
            event = {'status': 'downloading', 'filename': 'one-track'}
            with patch('worker.time.monotonic', return_value=1) as clock, patch('builtins.print'):
                with patch.object(Path, 'stat', autospec=True, side_effect=Path.stat) as stat:
                    for index in range(1000):
                        progress.download_hook({**event, 'downloaded_bytes': index})
                    self.assertEqual(stat.call_count, 1)
                self.assertEqual(progress.current['bytesReceived'], 999)
                atomic_json(control, {**pref, 'cancelled': True})
                clock.return_value = 1.051
                with self.assertRaises(Cancelled):
                    progress.download_hook(event)

    def test_cookies_domain_and_non_persistence(self):
        cookie = {'name': 'SESSION_TEST', 'value': 'SECRET_NOT_FOR_DISK', 'domain': '.youtube.com', 'path': '/', 'secure': True}
        self.assertEqual(len(youtube_cookies([cookie])), 1)
        for changes in ({'domain': '.google.com'}, {'value': 'bad\r\nheader'}, {'path': '//x\n'}):
            with self.assertRaises(ValueError): youtube_cookies([{**cookie, **changes}])
        with tempfile.TemporaryDirectory() as directory:
            events = []
            host = QuietHost({'data_dir': directory}, events.append)
            try:
                reply = host.start({'job': {'id': 'job', 'runId': 'run', 'url': 'https://youtu.be/jNQXAC9IVRw',
                                           'concurrency': 64, 'concurrencyRevision': 1}, 'cookies': [cookie]})
                self.assertTrue(reply['success'])
                self.assertNotIn('SECRET_NOT_FOR_DISK', json.dumps(events))
                for file in Path(directory).rglob('*.json'):
                    self.assertNotIn('SECRET_NOT_FOR_DISK', file.read_text(encoding='utf-8'))
                host.cancel({'jobId': 'job', 'runId': 'run'})
                self.assertNotIn('_cookies', host.jobs['job'])
            finally:
                host.close()

    def test_control_revision_cancel_cleanup_idempotency(self):
        with tempfile.TemporaryDirectory() as directory:
            host = QuietHost({'data_dir': directory}, lambda _: None)
            try:
                payload = {'job': {'id': 'job', 'runId': 'run', 'url': 'https://youtu.be/jNQXAC9IVRw',
                                   'concurrency': 64, 'concurrencyRevision': 1}}
                first = host.start(payload)
                self.assertEqual(host.start(payload)['job']['id'], first['job']['id'])
                host.set_concurrency({'concurrency': 1, 'concurrencyRevision': 2})
                host.set_concurrency({'concurrency': 375, 'concurrencyRevision': 1})
                self.assertEqual(host.jobs['job']['concurrency'], 1)
                with self.assertRaises(ValueError): host.set_concurrency({'concurrency': 3, 'concurrencyRevision': 2})
                with self.assertRaises(ValueError): host.release({'jobId': 'job', 'runId': 'run'})
                host.cancel({'jobId': 'job', 'runId': 'run'})
                self.assertEqual(host.jobs['job']['state'], 'cancelled')
                self.assertTrue(host.release({'jobId': 'job', 'runId': 'run'})['success'])
                self.assertTrue(host.release({'jobId': 'job', 'runId': 'run'})['success'])
                self.assertFalse((Path(directory) / 'jobs/job/run').exists())
            finally:
                host.close()

    def test_auth_required_and_unicode_worker_error(self):
        self.assertTrue(auth_required('Sign in to confirm you are not a bot'))
        self.assertFalse(auth_required('HTTP Error 403'))
        original = subprocess.Popen

        def fake_worker(command, **kwargs):
            self.assertEqual(command[1:4], ['-X', 'utf8', '-u'])
            script = 'import json,sys; sys.stdin.buffer.readline(); print(json.dumps({"event":"failed","error":"YouTube 需要登录测试 ✨","authRequired":True},ensure_ascii=False),flush=True); sys.exit(1)'
            return original([sys.executable, '-X', 'utf8', '-u', '-c', script], **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            host = QuietHost({'data_dir': directory, 'python': sys.executable, '_config_path': 'unused.json'}, lambda _: None)
            try:
                host.start({'job': {'id': 'job', 'runId': 'run', 'url': 'https://youtu.be/jNQXAC9IVRw'}})
                with patch('host.subprocess.Popen', side_effect=fake_worker):
                    host.run_worker(host.jobs['job'])
                self.assertEqual(host.jobs['job']['state'], 'interrupted')
                self.assertTrue(host.snapshot(host.jobs['job'])['authRequired'])
                self.assertEqual(host.jobs['job']['error'], 'YouTube 需要登录测试 ✨')
            finally:
                host.close()

    def test_restore_never_claims_success(self):
        with tempfile.TemporaryDirectory() as directory:
            host = QuietHost({'data_dir': directory}, lambda _: None)
            host.start({'job': {'id': 'job', 'runId': 'run', 'url': 'https://youtu.be/jNQXAC9IVRw'}})
            host.close()
            recovered = QuietHost({'data_dir': directory}, lambda _: None)
            try:
                self.assertEqual(recovered.jobs['job']['state'], 'interrupted')
                self.assertNotIn('artifact', recovered.jobs['job'])
            finally:
                recovered.close()

    def test_artifact_range_head_retries_and_revocation(self):
        server = ArtifactServer()
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'video.mp4'
                path.write_bytes(b'0123456789')
                url = server.register('job', 'run', path)
                with urllib.request.urlopen(urllib.request.Request(url, method='HEAD')) as response:
                    self.assertEqual(response.headers['Content-Length'], '10')
                for bounds, expected in [('bytes=2-5', b'2345'), ('bytes=-3', b'789'), ('bytes=7-', b'789')]:
                    with urllib.request.urlopen(urllib.request.Request(url, headers={'Range': bounds})) as response:
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.read(), expected)
                with urllib.request.urlopen(url) as response:
                    self.assertEqual(response.read(), b'0123456789')
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(urllib.request.Request(url, headers={'Range': 'bytes=90-100'}))
                self.assertEqual(error.exception.code, 416)
                self.assertTrue(server.revoke('job', 'run'))
                with self.assertRaises(urllib.error.HTTPError): urllib.request.urlopen(url)
        finally:
            server.close()

    def test_artifact_slow_connection_limit(self):
        server = ArtifactServer()
        sockets = []
        try:
            for _ in range(16):
                connection = socket.create_connection(('127.0.0.1', server.port), timeout=1)
                connection.sendall(b'GET / HTTP/1.1\r\n')  # Intentionally incomplete headers.
                sockets.append(connection)
            time.sleep(.15)
            extra = socket.create_connection(('127.0.0.1', server.port), timeout=1)
            try:
                self.assertEqual(extra.recv(1), b'')
            finally:
                extra.close()
        finally:
            for connection in sockets: connection.close()
            server.close()

    def test_dynamic_increase_decrease_and_order(self):
        state = {'concurrency': 1}
        lock = threading.Lock()
        active = peak = 0
        admitted = []
        allow_finish = threading.Event()

        def work(index):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(active, peak)
                admitted.append(index)
            if index < 4:
                allow_finish.wait(3)
            else:
                time.sleep(0.03)
            with lock:
                active -= 1
            return index

        output = []
        thread = threading.Thread(target=lambda: output.extend(ordered_dynamic_map(work, range(12), lambda: dict(state))))
        thread.start()
        deadline = time.monotonic() + 3
        while len(admitted) < 1 and time.monotonic() < deadline: time.sleep(.01)
        self.assertEqual(len(admitted), 1)
        state['concurrency'] = 4
        deadline = time.monotonic() + 3
        while len(admitted) < 4 and time.monotonic() < deadline: time.sleep(.01)
        self.assertEqual(len(admitted), 4)  # Raising works while first fragment is blocked.
        state['concurrency'] = 1
        time.sleep(.1)
        self.assertEqual(len(admitted), 4)  # Existing work is not cancelled.
        allow_finish.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(output, list(range(12)))
        self.assertEqual(peak, 4)

    def test_missing_fragment_is_fatal(self):
        def work(index):
            if index == 2: raise ValueError('bad fragment')
            return index
        with self.assertRaisesRegex(ValueError, 'bad fragment'):
            list(ordered_dynamic_map(work, range(8), lambda: {'concurrency': 3}))

    def test_ordered_writer_can_overlap_next_request_with_bounded_lookahead(self):
        second_finished = threading.Event()
        started = []
        observed = []

        def work(index):
            started.append(index)
            if index == 1:
                second_finished.set()
            return index

        def observe(active, submitted, consumed, _):
            observed.append((active, submitted - consumed))

        stream = ordered_dynamic_map(work, range(5), lambda: {'concurrency': 1}, observe, max_ahead=2)
        try:
            self.assertEqual(next(stream), 0)
            # Leave the first result with the writer. Exactly one more fetch fits.
            self.assertTrue(second_finished.wait(2))
            self.assertEqual(started, [0, 1])
            self.assertEqual(list(stream), [1, 2, 3, 4])
            self.assertTrue(all(active <= 1 and ahead <= 2 for active, ahead in observed))
            self.assertEqual(observed[-1], (0, 0))
        finally:
            stream.close()

    def test_windows_process_tree_cancel(self):
        if os.name != 'nt': self.skipTest('Windows process ownership check')
        command = [sys.executable, '-u', '-c',
                   'import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); print(p.pid,flush=True); time.sleep(60)']
        process = subprocess.Popen(command, stdout=subprocess.PIPE, **ProcessTree.popen_options())
        tree = ProcessTree(process)
        try:
            child_id = int(process.stdout.readline())
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            child = kernel.OpenProcess(0x100000, False, child_id)
            self.assertTrue(child)
            tree.terminate()
            self.assertEqual(kernel.WaitForSingleObject(child, 3000), 0)
            kernel.CloseHandle(child)
            self.assertIsNotNone(process.poll())
        finally:
            tree.terminate()
            tree.close()
            process.stdout.close()

    def test_actual_hls_adapter_local_http(self):
        blocks = [bytes([index + 1]) * 512 for index in range(8)]
        active = peak = 0
        lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                nonlocal active, peak
                if self.path == '/index.m3u8':
                    body = ('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n' + ''.join(f'#EXTINF:1,\n/{i}.ts\n' for i in range(8)) + '#EXT-X-ENDLIST\n').encode()
                else:
                    index = int(self.path[1:-3])
                    with lock:
                        active += 1
                        peak = max(peak, active)
                    time.sleep(.1)
                    body = blocks[index]
                    with lock: active -= 1
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                control = Path(directory) / 'control.json'
                atomic_json(control, {'concurrency': 4, 'concurrencyRevision': 1})
                progress = Progress(control)
                progress.emit = lambda **kwargs: progress.current.update({k: v for k, v in kwargs.items() if k != 'force'})
                target = Path(directory) / 'output.ts'
                with make_downloader(progress)({'quiet': True, 'noprogress': True, 'hls_prefer_native': True,
                    'skip_unavailable_fragments': False, 'continuedl': False, 'retries': 0, 'fragment_retries': 0,
                    'progress_hooks': [progress.download_hook]}) as ydl:
                    ok, _ = ydl.dl(str(target), {'url': f'http://127.0.0.1:{server.server_address[1]}/index.m3u8',
                                              'ext': 'ts', 'protocol': 'm3u8_native', 'http_headers': {}, 'is_live': False})
                self.assertTrue(ok)
                self.assertEqual(target.read_bytes(), b''.join(blocks))
                self.assertGreaterEqual(peak, 2)
                self.assertLessEqual(peak, 4)
                target_dash = Path(directory) / 'output.mp4'
                with make_downloader(progress)({'quiet': True, 'noprogress': True,
                    'skip_unavailable_fragments': False, 'continuedl': False, 'retries': 0, 'fragment_retries': 0,
                    'progress_hooks': [progress.download_hook]}) as ydl:
                    base = f'http://127.0.0.1:{server.server_address[1]}'
                    ok, _ = ydl.dl(str(target_dash), {'url': base + '/manifest.mpd', 'ext': 'mp4',
                        'protocol': 'http_dash_segments', 'http_headers': {}, 'is_live': False,
                        'fragments': [{'url': base + f'/{i}.ts'} for i in range(8)]})
                self.assertTrue(ok)
                self.assertEqual(target_dash.read_bytes(), b''.join(blocks))
        finally:
            server.shutdown()
            server.server_close()

    def test_oversized_fragment_is_rejected_before_assembly(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                if self.path == '/index.m3u8':
                    body = b'#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/big.ts\n#EXT-X-ENDLIST\n'
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(body)))
                else:
                    body = b'x' * 4096
                    self.send_response(200)
                    # No Content-Length: the streaming hook must enforce the cap.
                    self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            from yt_dlp.utils import DownloadError
            with tempfile.TemporaryDirectory() as directory:
                control = Path(directory) / 'control.json'
                atomic_json(control, {'concurrency': 1, 'concurrencyRevision': 1})
                progress = Progress(control)
                progress.emit = lambda **kwargs: progress.current.update({k: v for k, v in kwargs.items() if k != 'force'})
                target = Path(directory) / 'output.ts'
                with patch('worker.MAX_FRAGMENT_BYTES', 1024):
                    with make_downloader(progress)({'quiet': True, 'noprogress': True, 'hls_prefer_native': True,
                        'skip_unavailable_fragments': False, 'continuedl': False, 'retries': 0, 'fragment_retries': 0}) as ydl:
                        with self.assertRaises(DownloadError):
                            ydl.dl(str(target), {'url': f'http://127.0.0.1:{server.server_address[1]}/index.m3u8',
                                                'ext': 'ts', 'protocol': 'm3u8_native', 'http_headers': {}, 'is_live': False})
                self.assertFalse(target.exists())
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
