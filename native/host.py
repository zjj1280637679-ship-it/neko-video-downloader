"""Chrome Native Messaging host: one queue, explicit state, isolated workers."""
from __future__ import annotations

import ctypes
import hashlib
from itertools import islice
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import threading
import time

from artifacts import ArtifactServer
from common import VERSION, YTDLP_VERSION, TERMINAL, atomic_json, identifier, job_video, policy, readable_error, site_cookies, task_path
from process_tree import ProcessTree

MAX_MESSAGE = 262144
ACTIVE = {'queued', 'parsing', 'downloading', 'muxing', 'saving'}
PUBLIC = {'id', 'runId', 'url', 'title', 'filename', 'revision', 'state', 'phase', 'bytesReceived',
          'totalBytes', 'totalSegments', 'completedSegments', 'bytesPerSecond', 'etaSeconds',
          'concurrency', 'concurrencyRevision', 'targetConcurrency', 'inFlightRequests', 'segmented',
          'error', 'artifact', 'createdAt', 'qualityLabel', 'queuePosition', 'authRequired', 'site', 'page', 'videoId'}


def read_exact(stream, count):
    result = bytearray()
    while len(result) < count:
        chunk = stream.read(count - len(result))
        if not chunk:
            if result:
                raise ValueError('Truncated native message')
            return None
        result.extend(chunk)
    return bytes(result)


def read_message(stream):
    prefix = read_exact(stream, 4)
    if prefix is None:
        return None
    size = struct.unpack('<I', prefix)[0]
    if not 0 < size <= MAX_MESSAGE:
        raise ValueError('Native message too large')
    data = read_exact(stream, size)
    if data is None:
        raise ValueError('Truncated native message')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('Native message must be an object')
    return value


class Host:
    def __init__(self, config, output):
        self.config = config
        self.output = output
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.jobs = {}
        self.current = None
        self.closing = False
        self.preference = {'concurrency': 64, 'concurrencyRevision': 0}
        self.server = ArtifactServer()
        self.restore()
        self.runner = threading.Thread(target=self.run_queue, name='download-queue', daemon=True)
        self.runner.start()

    @staticmethod
    def snapshot(job):
        return {key: value for key, value in job.items() if key in PUBLIC}

    def persist(self, job):
        value = self.snapshot(job)
        value.pop('artifact', None)  # Ephemeral delivery tokens never survive a host.
        atomic_json(Path(job['_directory']) / 'job.json', value)

    def update(self, job, **patch):
        with self.lock:
            job.update(patch)
            job['revision'] += 1
            self.persist(job)
            snapshot = self.snapshot(job)
        if not self.closing:
            try:
                self.output({'event': 'job', 'job': snapshot})
            except (BrokenPipeError, OSError):
                with self.condition:
                    self.closing = True
                    self.condition.notify_all()
        return snapshot

    def restore(self):
        root = (Path(self.config['data_dir']) / 'jobs').resolve()
        root.mkdir(parents=True, exist_ok=True)
        # Restore only known, shallow, bounded manifest locations, never recurse.
        for manifest in islice(root.glob('*/*/job.json'), 200):
            try:
                value = json.loads(manifest.read_text(encoding='utf-8'))
                directory = task_path(self.config['data_dir'], value['id'], value['runId'])
                if manifest.resolve() != directory / 'job.json':
                    continue
                job = {key: item for key, item in value.items() if key in PUBLIC and key != 'artifact'}
                job.update(job_video(job))
                job['_directory'] = str(directory)
                job['revision'] = max(0, int(job.get('revision', 0)))
                if job.get('state') not in TERMINAL:
                    job.update(state='interrupted', phase='interrupted', error='浏览器或本地内核已退出，请重新下载。',
                               targetConcurrency=0, inFlightRequests=0, etaSeconds=None)
                    job['revision'] += 1
                self.jobs[job['id']] = job
                self.persist(job)
            except (OSError, ValueError, KeyError, TypeError):
                continue

    def set_concurrency(self, payload):
        incoming = policy(payload)
        with self.lock:
            if incoming['concurrencyRevision'] < self.preference['concurrencyRevision']:
                return {'success': True, **self.preference}
            if incoming['concurrencyRevision'] == self.preference['concurrencyRevision'] and incoming['concurrency'] != self.preference['concurrency']:
                raise ValueError('同一并发版本不能包含不同数值')
            self.preference = incoming
            for job in self.jobs.values():
                if job['state'] not in ACTIVE or job['state'] == 'saving':
                    continue
                control = {**incoming, 'cancelled': bool(job.get('_cancelled'))}
                atomic_json(Path(job['_directory']) / 'control.json', control)
                changes = {**incoming}
                if job.get('segmented') and job['state'] == 'downloading':
                    changes['targetConcurrency'] = incoming['concurrency']
                self.update(job, **changes)
            self.condition.notify_all()
        return {'success': True, **incoming}

    def start(self, payload):
        incoming = payload.get('job')
        if not isinstance(incoming, dict):
            raise ValueError('任务数据无效')
        job_id, run_id = identifier(incoming.get('id')), identifier(incoming.get('runId'))
        identity = job_video(incoming)
        pref = policy(incoming)
        cookies = site_cookies(payload.get('cookies'), identity['site'])
        with self.lock:
            old = self.jobs.get(job_id)
            if old:
                if old['runId'] == run_id:
                    if old['url'] != identity['url'] or old['site'] != identity['site']:
                        raise ValueError('同一下载尝试不能切换视频或站点')
                    return {'success': True, 'job': self.snapshot(old)}
                raise ValueError('旧下载尝试尚未移除，请先删除旧任务')
            if sum(job['state'] in ACTIVE for job in self.jobs.values()) >= 10:
                raise ValueError('最多安排 10 个本地任务')
            if pref['concurrencyRevision'] > self.preference['concurrencyRevision'] or not self.jobs:
                self.preference = pref
            directory = task_path(self.config['data_dir'], job_id, run_id)
            directory.mkdir(parents=True, exist_ok=False)
            fallback_title = 'B站视频' if identity['site'] == 'bilibili' else 'YouTube 视频'
            job = {'id': job_id, 'runId': run_id, **identity,
                   'title': str(incoming.get('title') or fallback_title)[:300], 'filename': fallback_title + '.mp4',
                   'revision': 0, 'state': 'queued', 'phase': 'queued', 'segmented': False,
                   'bytesReceived': 0, 'totalBytes': 0, 'completedSegments': 0, 'totalSegments': 0,
                   'bytesPerSecond': 0, 'etaSeconds': None, 'targetConcurrency': 0, 'inFlightRequests': 0,
                   'error': '', 'authRequired': False, 'createdAt': int(time.time() * 1000), **self.preference,
                   '_directory': str(directory), '_cookies': cookies}
            # request.json is deliberately generated from a fixed public subset.
            atomic_json(directory / 'request.json', {'directory': str(directory), 'job': {
                key: job[key] for key in ('id', 'runId', 'url', 'title', 'site', 'page', 'videoId')}})
            atomic_json(directory / 'control.json', {**self.preference, 'cancelled': False})
            self.jobs[job_id] = job
            snapshot = self.update(job)
            self.condition.notify_all()
        return {'success': True, 'job': snapshot}

    def lookup(self, payload):
        job_id, run_id = identifier(payload.get('jobId')), identifier(payload.get('runId'))
        job = self.jobs.get(job_id)
        if job and job['runId'] != run_id:
            raise ValueError('这是已过期的下载尝试')
        return job, job_id, run_id

    def cancel(self, payload):
        with self.lock:
            job, job_id, run_id = self.lookup(payload)
            if not job:
                return {'success': True}
            if job['state'] in TERMINAL:
                return {'success': True, 'job': self.snapshot(job)}
            job['_cancelled'] = True
            job.pop('_cookies', None)
            atomic_json(Path(job['_directory']) / 'control.json', {**self.preference, 'cancelled': True})
            tree = job.get('_tree')
            if job['state'] == 'saving':
                self.server.revoke(job_id, run_id)
            if not tree:
                snapshot = self.update(job, state='cancelled', phase='cancelled', error='',
                                       targetConcurrency=0, inFlightRequests=0, etaSeconds=None)
                return {'success': True, 'job': snapshot}
        tree.terminate()
        # Queue worker confirms process exit before its terminal event.
        finished = job.get('_finished')
        if finished and not finished.wait(12):
            raise ValueError('下载程序正在退出，请稍后重试取消')
        with self.lock:
            return {'success': True, 'job': self.snapshot(job)}

    def release(self, payload):
        with self.lock:
            job, job_id, run_id = self.lookup(payload)
            if not job:
                return {'success': True}
            if job.get('_tree') or job['state'] not in TERMINAL | {'saving'}:
                raise ValueError('下载仍在运行，不能清理临时文件')
            if not self.server.revoke(job_id, run_id):
                raise ValueError('Chrome 仍在读取临时文件，请稍后重试')
            directory = task_path(self.config['data_dir'], job_id, run_id)
            if directory != Path(job['_directory']).resolve():
                raise ValueError('任务目录不匹配')
            if directory.exists():
                shutil.rmtree(directory)
            self.jobs.pop(job_id, None)
            try:
                directory.parent.rmdir()
            except OSError:
                pass
        return {'success': True}

    def dispatch(self, request):
        action, payload = request.get('action'), request.get('payload', {})
        if not isinstance(payload, dict):
            raise ValueError('请求参数无效')
        if action == 'ping':
            return {'success': True, 'version': VERSION, 'ytDlpVersion': YTDLP_VERSION,
                    'capabilities': {'youtube': True, 'bilibili': True, 'liveFragmentConcurrency': True, 'browserSave': True}}
        if action == 'start': return self.start(payload)
        if action == 'setConcurrency': return self.set_concurrency(payload)
        if action == 'cancel': return self.cancel(payload)
        if action in ('release', 'remove'): return self.release(payload)
        if action == 'status':
            with self.lock:
                return {'success': True, 'jobs': [self.snapshot(job) for job in self.jobs.values()]}
        raise ValueError('不支持的本地内核命令')

    def run_queue(self):
        while True:
            with self.condition:
                pending = next((job for job in self.jobs.values() if job['state'] == 'queued'), None)
                if self.closing:
                    return
                if not pending:
                    self.condition.wait(0.5)
                    continue
                self.current = pending['id']
            self.run_worker(pending)
            with self.lock:
                self.current = None

    def run_worker(self, job):
        process = tree = None
        result = None
        failure = None
        failure_auth = False
        finished = threading.Event()
        with self.lock:
            if job.get('_cancelled') or job['state'] != 'queued':
                return
            job['_finished'] = finished
            self.update(job, state='parsing', phase='extracting')
            directory = Path(job['_directory'])
            command = [self.config['python'], '-X', 'utf8', '-u', str(Path(__file__).with_name('worker.py')),
                       '--config', self.config['_config_path'], '--request', str(directory / 'request.json'),
                       '--control', str(directory / 'control.json'), '--credentials-stdin']
            try:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.DEVNULL, cwd=directory, **ProcessTree.popen_options())
                tree = ProcessTree(process)
                job['_tree'] = tree
                secret = json.dumps({'cookies': job.pop('_cookies', [])}, ensure_ascii=False).encode('utf-8') + b'\n'
                process.stdin.write(secret)
                process.stdin.close()
                del secret
            except Exception as error:
                failure = readable_error(error, job['site'])
        try:
            if process and not failure:
                while True:
                    line = process.stdout.readline(65537)
                    if not line:
                        break
                    if len(line) > 65536:
                        raise ValueError('Invalid worker output')
                    event = json.loads(line)
                    if event.get('event') == 'progress':
                        self.accept_progress(job, event.get('job', {}))
                    elif event.get('event') == 'artifact':
                        result = event
                    elif event.get('event') == 'failed':
                        failure = str(event.get('error') or '本地下载失败')[:500]
                        failure_auth = event.get('authRequired') is True
                    elif event.get('event') == 'cancelled':
                        job['_cancelled'] = True
                code = process.wait()
                if code != 0 and not failure:
                    failure = '本地下载程序已退出，请重新下载。'
        except Exception as error:
            failure = readable_error(error, job['site'])
            if tree:
                tree.terminate()
        finally:
            if tree:
                tree.close()
            if process and process.stdout:
                process.stdout.close()
            with self.lock:
                job.pop('_tree', None)
                job.pop('_cookies', None)
                try:
                    if job.get('_cancelled'):
                        self.update(job, state='cancelled', phase='cancelled', error='',
                                    targetConcurrency=0, inFlightRequests=0, etaSeconds=None)
                    elif self.closing:
                        self.update(job, state='interrupted', phase='interrupted', error='浏览器或本地内核已退出，请重新下载。')
                    elif failure or not result:
                        self.update(job, state='interrupted', phase='interrupted', error=failure or '未得到完整音视频文件。',
                                    targetConcurrency=0, inFlightRequests=0, etaSeconds=None, authRequired=failure_auth)
                    else:
                        name = result['path']
                        path = (directory / name).resolve()
                        if Path(name).name != name or path.parent != directory.resolve() or not path.is_file() or path.suffix not in ('.mp4', '.mkv', '.webm'):
                            raise ValueError('Invalid artifact path')
                        url = self.server.register(job['id'], job['runId'], path)
                        self.update(job, state='saving', phase='ready', filename=result['filename'],
                                    title=str(result.get('title') or job['title'])[:300],
                                    qualityLabel=str(result.get('qualityLabel') or '')[:40],
                                    artifact={'url': url, 'filename': result['filename'], 'size': path.stat().st_size},
                                    targetConcurrency=0, inFlightRequests=0, etaSeconds=None)
                except Exception:
                    self.update(job, state='interrupted', phase='interrupted', error='成品交付失败，请重新下载。')
                finished.set()

    def accept_progress(self, job, incoming):
        with self.lock:
            if job.get('_cancelled') or job['state'] in TERMINAL:
                return
            patch = {}
            if incoming.get('state') in ('parsing', 'downloading', 'muxing'):
                patch['state'] = incoming['state']
            if isinstance(incoming.get('phase'), str):
                patch['phase'] = incoming['phase'][:80]
            if type(incoming.get('segmented')) is bool:
                patch['segmented'] = incoming['segmented']
            for key in ('bytesReceived', 'totalBytes', 'totalSegments', 'completedSegments', 'bytesPerSecond', 'inFlightRequests'):
                value = incoming.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value < 1e15:
                    patch[key] = value
            eta = incoming.get('etaSeconds')
            patch['etaSeconds'] = eta if isinstance(eta, (int, float)) and math.isfinite(eta) and 0 < eta < 1e10 else None
            # A delayed worker sample may never roll back the newest control.
            patch.update(self.preference)
            patch['targetConcurrency'] = self.preference['concurrency'] if incoming.get('segmented') and incoming.get('state') == 'downloading' else 0
            self.update(job, **patch)

    def close(self):
        with self.condition:
            self.closing = True
            self.condition.notify_all()
            trees = [job['_tree'] for job in self.jobs.values() if job.get('_tree')]
        for tree in trees:
            tree.terminate()
        self.runner.join(timeout=15)
        with self.lock:
            for job in self.jobs.values():
                job.pop('_cookies', None)
                if job['state'] in ACTIVE:
                    self.update(job, state='interrupted', phase='interrupted', error='浏览器或本地内核已退出，请重新下载。')
        self.server.close()


def main():
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    config_path = Path(__file__).with_name('runtime-config.json')
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    config['_config_path'] = str(config_path.resolve())
    for name in ('python', 'ffmpeg', 'ffprobe', 'node'):
        if not Path(config[name]).is_absolute() or not Path(config[name]).is_file():
            raise ValueError('本地内核依赖缺失，请重新安装')
    if not Path(config['data_dir']).is_absolute():
        raise ValueError('本地数据目录无效')
    allowed = config.get('allowed_origins', [])
    if not allowed or len(sys.argv) < 2 or sys.argv[1] not in allowed:
        raise ValueError('Native host origin is not authorized')
    mutex = kernel = None
    if os.name == 'nt':
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        key = hashlib.sha256(str(Path(config['data_dir']).resolve()).encode()).hexdigest()[:24]
        mutex = kernel.CreateMutexW(None, False, 'Local\\YangmoNative_' + key)
        if not mutex or ctypes.get_last_error() == 183:
            if mutex: kernel.CloseHandle(mutex)
            raise ValueError('另一个本地下载内核仍在运行，请稍后重试')
    output_lock = threading.Lock()

    def output(value):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        if len(data) > MAX_MESSAGE:
            raise ValueError('Native output too large')
        with output_lock:
            sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
            sys.stdout.buffer.flush()

    host = None
    try:
        host = Host(config, output)
        while True:
            request = read_message(sys.stdin.buffer)
            if request is None:
                break
            request_id = request.get('requestId')
            if not isinstance(request_id, (str, int)) or isinstance(request_id, bool) or len(str(request_id)) > 128:
                raise ValueError('Invalid request ID')
            try:
                response = host.dispatch(request)
            except (ValueError, OSError) as error:
                # Boundary errors are our own messages, never upstream URLs.
                response = {'success': False, 'error': str(error)[:500]}
            output({'requestId': request_id, **response})
    finally:
        if host: host.close()
        if mutex: kernel.CloseHandle(mutex)


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, EOFError, OSError, ValueError):
        raise SystemExit(1)
