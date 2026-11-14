"""One isolated yt-dlp job. stdout contains only bounded JSON progress lines.

The adapter is intentionally pinned to yt-dlp 2026.10.26. It subclasses the
selected native HLS/DASH downloader instead of changing global yt-dlp classes.
Manifest parsing, fragment HTTP IO, decryption and ordered assembly stay in
yt-dlp; admission is owned by our live, bounded scheduler.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from common import YTDLP_VERSION, auth_required, job_video, policy, readable_error, safe_filename, site_cookies
from scheduler import Cancelled, ordered_dynamic_map

MAX_FRAGMENT_BYTES = 128 * 1024 * 1024


class Progress:
    def __init__(self, control_path):
        self.control_path = Path(control_path)
        self.lock = threading.RLock()
        self.last_emit = 0
        self.tracks = {}
        self.segments = {}
        self.current = {'state': 'parsing', 'phase': 'extracting', 'segmented': False,
                        'bytesReceived': 0, 'totalBytes': 0, 'completedSegments': 0,
                        'totalSegments': 0, 'bytesPerSecond': 0, 'etaSeconds': None,
                        'targetConcurrency': 0, 'inFlightRequests': 0}
        self.last_control = {'concurrency': 64, 'concurrencyRevision': 0}

    def control(self):
        with self.lock:
            try:
                value = json.loads(self.control_path.read_text(encoding='utf-8'))
                checked = policy(value)
                if checked['concurrencyRevision'] >= self.last_control['concurrencyRevision']:
                    self.last_control = {**checked, 'cancelled': bool(value.get('cancelled'))}
            except (OSError, ValueError):
                pass  # Atomic replacement can briefly race antivirus on Windows.
            return dict(self.last_control)

    def emit(self, force=False, **changes):
        with self.lock:
            self.current.update(changes)
            now = time.monotonic()
            if not force and now - self.last_emit < 0.25:
                return
            self.last_emit = now
            snapshot = {**self.current, **self.control()}
            snapshot.pop('cancelled', None)
            if snapshot['state'] != 'downloading':
                snapshot['etaSeconds'] = None
                snapshot['targetConcurrency'] = snapshot['inFlightRequests'] = 0
            print(json.dumps({'event': 'progress', 'job': snapshot}, ensure_ascii=False), flush=True)

    def download_hook(self, event):
        if self.control().get('cancelled'):
            raise Cancelled()
        status = event.get('status')
        if status not in ('downloading', 'finished'):
            return
        key = str(event.get('filename', 'track'))
        with self.lock:
            previous = self.tracks.get(key, {})
            downloaded = max(int(event.get('downloaded_bytes') or 0), previous.get('bytes', 0))
            self.tracks[key] = {'bytes': downloaded, 'total': max(downloaded, int(event.get('total_bytes') or event.get('total_bytes_estimate') or 0)),
                                'done': status == 'finished'}
            speed = event.get('speed')
            eta = event.get('eta')
            self.emit(state='downloading', phase='fragments' if self.current['segmented'] else 'transfer',
                      bytesReceived=sum(x['bytes'] for x in self.tracks.values()),
                      totalBytes=sum(x['total'] for x in self.tracks.values()),
                      bytesPerSecond=float(speed) if isinstance(speed, (int, float)) and math.isfinite(speed) and speed >= 0 else 0,
                      etaSeconds=math.ceil(eta) if isinstance(eta, (int, float)) and math.isfinite(eta) and eta > 0 else None)

    def segment_observer(self, key, total):
        self.segments[key] = {'total': total or 0, 'done': 0}
        self.emit(force=True, state='downloading', phase='fragments', segmented=True,
                  totalSegments=sum(v['total'] for v in self.segments.values()))

        def observe(active, submitted, consumed, state):
            with self.lock:
                self.segments[key]['done'] = consumed
                self.emit(completedSegments=sum(v['done'] for v in self.segments.values()),
                          totalSegments=sum(v['total'] for v in self.segments.values()),
                          targetConcurrency=state['concurrency'], inFlightRequests=active)
        return observe


def make_downloader(progress):
    import yt_dlp
    from yt_dlp.downloader import get_suitable_downloader
    from yt_dlp.downloader.dash import DashSegmentsFD
    from yt_dlp.downloader.hls import HlsFD
    from yt_dlp.downloader.fragment import FragmentFD
    from yt_dlp.utils import DownloadError, RetryManager
    from yt_dlp.networking.exceptions import HTTPError, IncompleteRead
    from yt_dlp.utils.networking import HTTPHeaderDict

    class DynamicFragments:
        def _prepare_frag_download(self, ctx):
            super()._prepare_frag_download(ctx)
            # Scope this cap to fragment HTTP transfers, never normal videos.
            def enforce_fragment_limit(event):
                if max(event.get('downloaded_bytes') or 0, event.get('total_bytes') or 0) > MAX_FRAGMENT_BYTES:
                    raise DownloadError('Fragment exceeds byte limit')
                if progress.control().get('cancelled'):
                    raise Cancelled()
            ctx['dl'].add_progress_hook(enforce_fragment_limit)

        def download_and_append_fragments_multiple(self, *tracks, **kwargs):
            # Both tracks share the same task cap; no hidden 64+64 multiplication.
            for ctx, fragments, info in tracks:
                if not self.download_and_append_fragments(ctx, fragments, info, **kwargs):
                    return False
            return True

        def download_and_append_fragments(self, ctx, fragments, info_dict, *, is_fatal=lambda _: True,
                                          pack_func=lambda content, _: content, finish_func=None,
                                          tpe=None, interrupt_trigger=(True,)):
            observe = progress.segment_observer(ctx['filename'], ctx.get('total_frags'))
            decrypt = self.decrypter(info_dict)

            def download(fragment):
                if progress.control().get('cancelled') or not interrupt_trigger[0]:
                    raise Cancelled()
                copy = ctx.copy()
                copy['fragment_index'] = fragment['frag_index']
                headers = HTTPHeaderDict(info_dict.get('http_headers'))
                if fragment.get('byte_range'):
                    bounds = fragment['byte_range']
                    headers['Range'] = f"bytes={bounds['start']}-{bounds['end'] - 1}"

                def retry_error(error, count, retries):
                    if count > retries:
                        raise DownloadError('Fragment download failed')

                for retry in RetryManager(self.params.get('fragment_retries', 2), retry_error):
                    try:
                        if not self._download_fragment(copy, fragment['url'], info_dict, headers, info_dict.get('request_data')):
                            raise DownloadError('Fragment download failed')
                        path = copy.get('fragment_filename_sanitized')
                        if not path or not Path(path).is_file() or Path(path).stat().st_size == 0:
                            raise DownloadError('Empty fragment')
                        if Path(path).stat().st_size > MAX_FRAGMENT_BYTES:
                            raise DownloadError('Fragment exceeds byte limit')
                        return fragment, copy
                    except (HTTPError, IncompleteRead) as error:
                        retry.error = error
                raise DownloadError('Fragment download failed')

            try:
                for fragment, result in ordered_dynamic_map(download, fragments, progress.control, observe):
                    ctx['fragment_index'] = fragment['frag_index']
                    ctx['fragment_filename_sanitized'] = result['fragment_filename_sanitized']
                    if Path(ctx['fragment_filename_sanitized']).stat().st_size > MAX_FRAGMENT_BYTES:
                        raise DownloadError('Fragment exceeds byte limit')
                    if result.get('fragment_filetime'):
                        ctx['fragment_filetime'] = result['fragment_filetime']
                    content = self._read_fragment(ctx)
                    if not content:
                        raise DownloadError('Empty fragment')
                    content = decrypt(fragment, content)
                    if not content:
                        raise DownloadError('Invalid decrypted fragment')
                    self._append_fragment(ctx, pack_func(content, fragment['frag_index']))
                if finish_func is not None:
                    ctx['dest_stream'].write(finish_func())
                    ctx['dest_stream'].flush()
                return self._finish_frag_download(ctx, info_dict)
            except BaseException:
                ctx['dest_stream'].close()
                raise

    class DynamicHls(DynamicFragments, HlsFD):
        def real_download(self, filename, info_dict):
            # Do not silently delegate a fragmented transfer to FFmpeg, which
            # has no live admission interface. Preflight then reuse HlsFD parsing.
            prepared = dict(info_dict)
            manifest = prepared.get('hls_media_playlist_data')
            if not manifest:
                with self.ydl.urlopen(self._prepare_url(prepared, prepared['url'])) as response:
                    data = response.read(4 * 1024 * 1024 + 1)
                    if len(data) > 4 * 1024 * 1024:
                        raise DownloadError('HLS manifest is too large')
                    manifest = data.decode('utf-8')
                    prepared['url'] = response.url
            if '#EXT-X-ENDLIST' not in manifest:
                raise DownloadError('Live HLS videos are not supported')
            if not self.can_download(manifest, prepared, False):
                raise DownloadError('DRM protected HLS' if self._has_drm(manifest) else 'Unsupported fragmented transport')
            prepared['hls_media_playlist_data'] = manifest
            return super().real_download(filename, prepared)

    class DynamicDash(DynamicFragments, DashSegmentsFD):
        pass

    class YangmoYDL(yt_dlp.YoutubeDL):
        def dl(self, name, info, subtitle=False, test=False):
            if test or subtitle:
                return super().dl(name, info, subtitle=subtitle, test=test)
            selected = get_suitable_downloader(info, self.params, to_stdout=name == '-')
            dynamic = DynamicHls if selected is HlsFD else DynamicDash if selected is DashSegmentsFD else None
            if dynamic is None:
                if issubclass(selected, FragmentFD):
                    raise DownloadError('This fragmented protocol needs an additional downloader adapter')
                progress.emit(force=True, segmented=False, totalSegments=0, completedSegments=0,
                              targetConcurrency=0, inFlightRequests=0)
                return super().dl(name, info, subtitle=subtitle, test=test)
            # These lines mirror the small public dl dispatch boundary of the
            # pinned yt-dlp version; all non-fragment behavior delegates upstream.
            downloader = dynamic(self, self.params)
            for hook in self._progress_hooks:
                downloader.add_progress_hook(hook)
            new_info = self._copy_infodict(info)
            if new_info.get('http_headers') is None:
                new_info['http_headers'] = self._calc_headers(new_info)
            return downloader.download(name, new_info, subtitle)

    return YangmoYDL


class QuietLogger:
    def debug(self, text): pass
    def info(self, text): pass
    def warning(self, text): pass
    def error(self, text): pass


def verify_media(path, config, expected_duration=None, expected_audio=True, details=None):
    result = subprocess.run([config['ffprobe'], '-v', 'error', '-show_entries',
                             'stream=codec_type,codec_name,width,height,duration:format=duration,size',
                             '-of', 'json', str(path)], capture_output=True, timeout=45,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode != 0:
        raise ValueError('ffprobe failed')
    parsed = json.loads(result.stdout)
    streams = parsed.get('streams', [])
    if not any(x.get('codec_type') == 'video' and x.get('width', 0) > 0 for x in streams):
        raise ValueError('ffprobe: missing video track')
    if expected_audio and not any(x.get('codec_type') == 'audio' for x in streams):
        raise ValueError('ffprobe: missing audio track')
    duration = float(parsed.get('format', {}).get('duration') or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError('ffprobe: invalid duration')
    if isinstance(expected_duration, (int, float)) and expected_duration > 0 and abs(duration - expected_duration) > max(3, expected_duration * 0.02):
        raise ValueError('ffprobe: incomplete duration')
    if details is not None:
        details.update(next(x for x in streams if x.get('codec_type') == 'video' and x.get('width', 0) > 0))
    return duration


def run(config, request, control_path, cookies=None):
    from yt_dlp.version import __version__
    if __version__ != YTDLP_VERSION:
        raise ValueError(f'yt-dlp version mismatch; expected {YTDLP_VERSION}')
    progress = Progress(control_path)
    progress.emit(force=True)
    job = request['job']
    identity = job_video(job)
    url, site = identity['url'], identity['site']
    output = Path(request['directory']).resolve()
    metadata = {}

    def filter_video(info, *, incomplete=False):
        if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming'):
            raise ValueError('Live videos are not supported')
        if info.get('has_drm') is True:
            raise ValueError('DRM protected video')
        if info.get('title'):
            metadata['title'] = info['title']
        if info.get('duration'):
            metadata['duration'] = info['duration']
        return None

    def postprocessor(event):
        if progress.control().get('cancelled'):
            raise Cancelled()
        if event.get('status') == 'started':
            progress.emit(force=True, state='muxing', phase='muxing')

    params = {
        'logger': QuietLogger(), 'quiet': True, 'no_warnings': True, 'noprogress': True,
        'noplaylist': True, 'ignoreerrors': False, 'skip_unavailable_fragments': False,
        'continuedl': False, 'overwrites': True, 'retries': 2, 'fragment_retries': 2,
        '_no_ytdl_file': True,  # First version does not claim cross-process resume.
        'extractor_retries': 1, 'socket_timeout': 20, 'hls_prefer_native': True,
        'concurrent_fragment_downloads': 1,  # Scheduling is handled by DynamicFragments.
        'format': 'bv[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv+ba/b',
        'merge_output_format': 'mp4/mkv', 'outtmpl': str(output / 'video.%(ext)s'),
        'ffmpeg_location': config['ffmpeg'], 'js_runtimes': {'node': {'path': config['node']}},
        'progress_hooks': [progress.download_hook], 'postprocessor_hooks': [postprocessor],
        'match_filter': filter_video, 'allow_unplayable_formats': False,
    }
    # Optional provider arguments are fixed installation configuration, never
    # arbitrary arguments received from a webpage or extension message.
    if isinstance(config.get('extractor_args'), dict):
        params['extractor_args'] = config['extractor_args']
    bili_extractor = None
    if site == 'bilibili':
        from bilibili_adapter import CurrentBilibiliIE, extraction_url
        bili_extractor = CurrentBilibiliIE(identity)
        url = extraction_url(identity)
        # Explicitly silent source formats need the video-only fallback. Output
        # audio remains mandatory unless raw source metadata proves it is absent.
        params['format'] += '/bv'
    with make_downloader(progress)(params) as ydl:
        if bili_extractor:
            ydl.add_info_extractor(bili_extractor)
        if cookies:
            from http.cookiejar import Cookie
            for cookie in site_cookies(cookies, site):
                expires = cookie['expirationDate']
                ydl.cookiejar.set_cookie(Cookie(
                    version=0, name=cookie['name'], value=cookie['value'], port=None, port_specified=False,
                    domain=cookie['domain'], domain_specified=cookie['domain'].startswith('.'),
                    domain_initial_dot=cookie['domain'].startswith('.'), path=cookie['path'], path_specified=True,
                    secure=cookie['secure'], expires=int(expires) if expires else None,
                    discard=not bool(expires), comment=None, comment_url=None, rest={}, rfc2109=False))
        info = ydl.extract_info(url, download=True, ie_key='BiliBili' if bili_extractor else None)
    if not info:
        raise ValueError('No video formats available')
    progress.emit(force=True, state='muxing', phase='verifying')
    candidates = [p for p in output.glob('video.*') if p.suffix.lower() in ('.mp4', '.mkv', '.webm') and p.is_file()]
    if len(candidates) != 1:
        raise ValueError('ffprobe: missing merged result')
    path = candidates[0]
    details = {}
    duration = verify_media(path, config, metadata.get('duration') or info.get('duration'),
                            expected_audio=bili_extractor.source.get('expected_audio', True) if bili_extractor else True,
                            details=details)
    title = metadata.get('title') or info.get('title') or job.get('title') or ('B站视频' if bili_extractor else 'YouTube 视频')
    print(json.dumps({'event': 'artifact', 'path': path.name,
                      'filename': safe_filename(title, path.suffix[1:]),
                      'title': title, 'qualityLabel': f'{details.get("height", 0)}p',
                      'size': path.stat().st_size, 'duration': duration}, ensure_ascii=False), flush=True)


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='strict')
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--request', required=True)
    parser.add_argument('--control', required=True)
    parser.add_argument('--credentials-stdin', action='store_true')
    args = parser.parse_args()
    site = 'youtube'
    try:
        config = json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
        request = json.loads(Path(args.request).read_text(encoding='utf-8'))
        site = job_video(request['job'])['site']
        credentials = {}
        if args.credentials_stdin:
            data = sys.stdin.buffer.readline(240001)
            if len(data) > 240000 or not data.endswith(b'\n'):
                raise ValueError('Invalid credential packet')
            credentials = json.loads(data)
        run(config, request, args.control, site_cookies(credentials.get('cookies'), site))
    except Cancelled:
        print(json.dumps({'event': 'cancelled'}), flush=True)
        return 2
    except Exception as error:
        print(json.dumps({'event': 'failed', 'error': readable_error(error, site), 'authRequired': auth_required(error, site)}, ensure_ascii=False), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
