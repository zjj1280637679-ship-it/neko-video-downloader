"""Bilibili boundary and pinned extractor regressions; entirely offline."""
import copy
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from yt_dlp import YoutubeDL
from yt_dlp.extractor.bilibili import BiliBiliIE

from bilibili_adapter import CurrentBilibiliIE, extraction_url
from common import atomic_json, auth_required, job_video, readable_error, site_cookies, site_video
from test_native import QuietHost
from worker import Progress, QuietLogger, make_downloader, verify_media


URL = 'https://www.bilibili.com/video/BV1bK411W797/?p=2'


def fixture():
    video = {'bvid': 'BV1bK411W797', 'aid': 498159642, 'title': '测试投稿', 'duration': 180,
             'cid': 22, 'rights': {}, 'pages': [
                 {'page': 1, 'cid': 11, 'part': '第一部分', 'duration': 60},
                 {'page': 2, 'cid': 22, 'part': '第二部分', 'duration': 120}]}
    play = {'timelength': 120000, 'accept_description': ['高清 1080P'], 'support_formats': [],
            'dash': {'video': [{'id': 80, 'baseUrl': 'https://media.example.invalid/video.m4s',
                              'mimeType': 'video/mp4', 'codecs': 'avc1.640028', 'width': 1920, 'height': 1080}],
                     'audio': [{'id': 30280, 'baseUrl': 'https://media.example.invalid/audio.m4s',
                                'mimeType': 'audio/mp4', 'codecs': 'mp4a.40.2'}]}}
    return video, play


def extract_fixture(video=None, play=None, url=URL, final_url=None):
    default_video, default_play = fixture()
    video, play = video or default_video, play or default_play
    extractor = CurrentBilibiliIE(site_video(url))
    webpage = '<script>window.__INITIAL_STATE__=' + json.dumps({'videoData': video}) + ';</script>'
    webpage += '<script>window.__playinfo__=' + json.dumps({'data': play}) + ';</script>'
    with YoutubeDL({'quiet': True, 'logger': QuietLogger(), 'noplaylist': True,
                    'format': 'bv+ba/b/bv'}) as ydl, ExitStack() as stack:
        ydl.add_info_extractor(extractor)
        stack.enter_context(patch.object(BiliBiliIE, '_download_webpage_handle', return_value=(webpage, SimpleNamespace(url=final_url or url))))
        stack.enter_context(patch.object(extractor, '_download_json', return_value={'data': video['pages']}))
        stack.enter_context(patch.object(extractor, '_download_playinfo', return_value=play))
        stack.enter_context(patch.object(extractor, '_get_chapters', return_value=[]))
        stack.enter_context(patch.object(extractor, 'extract_subtitles', return_value={}))
        result = ydl.extract_info(url, download=False, ie_key='BiliBili')
    return extractor, result


class BilibiliTests(unittest.TestCase):
    def test_url_and_explicit_identity(self):
        expected = {'site': 'bilibili', 'url': URL, 'page': 2, 'videoId': 'BV1bK411W797'}
        self.assertEqual(site_video('https://m.bilibili.com/video/BV1bK411W797?p=2&spm_id_from=ignored'), expected)
        for locale in ('zh-Hans', 'zh-Hant'):
            self.assertEqual(site_video(f'https://www.bilibili.com/{locale}/video/BV1bK411W797/?p=2'), expected)
        self.assertEqual(site_video('http://bilibili.com/video/av498159642')['url'],
                         'https://www.bilibili.com/video/av498159642/?p=1')
        for suffix in ('?p=0', '?p=01', '?p=-1', '?p=1.5', '?p=', '?p=2&p=1', '?p=9007199254740992'):
            with self.assertRaises(ValueError): site_video('https://bilibili.com/video/BV1bK411W797/' + suffix)
        for value in ('https://b23.tv/abc', 'https://live.bilibili.com/1', 'https://bilibili.com/bangumi/play/ep1',
                      'https://bilibili.com/medialist/play/1', 'https://space.bilibili.com/1',
                      'https://bilibili.com/video/av9007199254740992', 'https://bilibili.com:443/video/BV1bK411W797',
                      'https://bilibili.com@evil.test/video/BV1bK411W797'):
            with self.assertRaises(ValueError): site_video(value)
        self.assertEqual(job_video({'site': 'bilibili', 'url': URL, 'page': 2}), expected)
        for job in ({'url': URL}, {'site': None, 'url': URL}, {'site': 'unknown', 'url': URL},
                    {'site': 'youtube', 'url': URL}, {'site': 'bilibili', 'url': URL, 'page': 1}):
            with self.assertRaises(ValueError): job_video(job)
        self.assertEqual(job_video({'url': 'https://youtu.be/jNQXAC9IVRw'})['site'], 'youtube')

    def test_site_cookie_isolation_and_host_persistence(self):
        cookie = {'name': 'SESSDATA', 'value': 'SYNTHETIC_SECRET', 'domain': '.bilibili.com'}
        self.assertEqual(len(site_cookies([cookie], 'bilibili')), 1)
        for site, domain in [('youtube', '.bilibili.com'), ('bilibili', '.youtube.com'), ('bilibili', 'api.bilibili.com')]:
            with self.assertRaises(ValueError): site_cookies([{**cookie, 'domain': domain}], site)
        with tempfile.TemporaryDirectory() as directory:
            events = []
            host = QuietHost({'data_dir': directory}, events.append)
            try:
                result = host.start({'job': {'id': 'bili', 'runId': 'run', 'url': URL, 'site': 'bilibili', 'page': 2}, 'cookies': [cookie]})
                self.assertEqual(result['job']['page'], 2)
                self.assertEqual(result['job']['site'], 'bilibili')
                with self.assertRaises(ValueError):
                    host.start({'job': {'id': 'bili', 'runId': 'run', 'url': URL.replace('p=2', 'p=1'), 'site': 'bilibili'}})
                self.assertTrue(host.dispatch({'action': 'ping', 'payload': {}})['capabilities']['bilibili'])
                self.assertNotIn('SYNTHETIC_SECRET', json.dumps(events))
                for file in Path(directory).rglob('*.json'):
                    self.assertNotIn('SYNTHETIC_SECRET', file.read_text(encoding='utf-8'))
            finally:
                host.close()
            restored = QuietHost({'data_dir': directory}, lambda _: None)
            try:
                self.assertEqual(restored.jobs['bili']['url'], URL)
                self.assertEqual(restored.jobs['bili']['state'], 'interrupted')
            finally:
                restored.close()

    def test_real_pinned_extractor_selects_one_p_and_http_tracks(self):
        extractor, info = extract_fixture()
        self.assertEqual(info['id'], 'BV1bK411W797_p2')
        self.assertEqual(info['duration'], 120)  # Not the anthology's 180 seconds.
        self.assertEqual(info['title'], '测试投稿 P02 第二部分')
        self.assertEqual(len(info['requested_formats']), 2)
        self.assertTrue(extractor.source['expected_audio'])
        for fmt in info['requested_formats']:
            self.assertEqual(fmt['protocol'], 'https')
            self.assertNotIn('fragments', fmt)
        _, av_info = extract_fixture(url='https://www.bilibili.com/video/av498159642/?p=2')
        self.assertEqual(av_info['id'], info['id'])
        _, localized = extract_fixture(final_url='https://www.bilibili.com/zh-Hans/video/BV1bK411W797/?p=2')
        self.assertEqual(localized['id'], info['id'])
        self.assertEqual(localized['duration'], 120)

    def test_video_redirect_guard_does_not_intercept_internal_json_api(self):
        identity = site_video(URL)
        self.assertEqual(extraction_url(identity), 'https://www.bilibili.com/zh-Hans/video/BV1bK411W797/?p=2')
        extractor = CurrentBilibiliIE(identity)
        api_url = 'https://api.bilibili.com/x/player/pagelist'
        handle = SimpleNamespace(url=api_url)
        with patch.object(BiliBiliIE, '_download_webpage_handle', return_value=('{}', handle)):
            self.assertEqual(extractor._download_webpage_handle(api_url, identity['videoId']), ('{}', handle))
            with self.assertRaises(ValueError): extractor._download_webpage_handle(extraction_url(identity), identity['videoId'])

    def test_preview_wrong_p_redirect_interactive_and_legacy_are_rejected(self):
        video, play = fixture()
        for changed in ({**play, 'accept_description': ['试看']}, {**play, 'is_preview': True}, {**play, 'timelength': 30000}):
            with self.assertRaisesRegex(ValueError, 'preview'): extract_fixture(play=changed)
        with self.assertRaisesRegex(ValueError, 'page'): extract_fixture(url=URL.replace('p=2', 'p=3'))
        with self.assertRaisesRegex(ValueError, 'page'):
            extract_fixture(final_url='https://www.bilibili.com/zh-Hans/video/BV1bK411W797/')
        with self.assertRaisesRegex(ValueError, 'identity'): extract_fixture(video={**video, 'bvid': 'BV1234567890'})
        with self.assertRaisesRegex(ValueError, 'unsupported'): extract_fixture(video={**video, 'rights': {'is_stein_gate': 1}})
        with self.assertRaisesRegex(ValueError, 'unsupported'): extract_fixture(video={**video, 'redirect_url': 'https://bilibili.com/bangumi/play/ep1'})
        legacy = {'timelength': 120000, 'quality': 32, 'durl': [
            {'url': 'https://example.invalid/1.flv', 'length': 60000},
            {'url': 'https://example.invalid/2.flv', 'length': 60000}]}
        with self.assertRaisesRegex(ValueError, 'multi_video'): extract_fixture(play=legacy)
        for result in ({'_type': 'url', 'url': 'https://example.invalid'}, {'_type': 'playlist', 'entries': []}):
            with patch.object(BiliBiliIE, '_real_extract', return_value=result):
                with self.assertRaisesRegex(ValueError, 'unsupported'): CurrentBilibiliIE(site_video(URL))._real_extract(URL)

    def test_silent_source_is_explicit_and_probe_does_not_hide_missing_audio(self):
        _, play = fixture()
        play['dash']['audio'] = []
        extractor, info = extract_fixture(play=play)
        self.assertFalse(extractor.source['expected_audio'])
        self.assertEqual(info['acodec'], 'none')
        ambiguous = copy.deepcopy(play)
        del ambiguous['dash']['audio']
        extractor, _ = extract_fixture(play=ambiguous)
        self.assertTrue(extractor.source['expected_audio'])
        payload = {'streams': [{'codec_type': 'video', 'width': 1920, 'height': 1080}], 'format': {'duration': '120'}}
        with patch('worker.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(payload).encode())):
            with self.assertRaisesRegex(ValueError, 'missing audio'): verify_media('unused', {'ffprobe': 'unused'}, 120)
            self.assertEqual(verify_media('unused', {'ffprobe': 'unused'}, 120, expected_audio=False), 120)
            with self.assertRaisesRegex(ValueError, 'incomplete duration'):
                verify_media('unused', {'ffprobe': 'unused'}, 240, expected_audio=False)

    def test_bilibili_errors_offer_explicit_retry_without_promising_access(self):
        for text in ('HTTP Error 412', 'This video is only available for registered users',
                     'supporter-only video', 'only the preview will be extracted', 'API returned -352',
                     'You have exceeded the rate limit'):
            self.assertTrue(auth_required(text, 'bilibili'))
            self.assertIn('B站', readable_error(text, 'bilibili'))
            self.assertNotIn('YouTube', readable_error(text, 'bilibili'))
        self.assertFalse(auth_required('HTTP Error 403', 'bilibili'))
        self.assertFalse(auth_required('HTTP Error 412', 'youtube'))

    def test_direct_http_tracks_never_become_fragments(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                body = self.path.encode() * 32
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                control = Path(directory) / 'control.json'
                atomic_json(control, {'concurrency': 375, 'concurrencyRevision': 1})
                progress = Progress(control)
                progress.emit = lambda **kw: progress.current.update({k: v for k, v in kw.items() if k != 'force'})
                with make_downloader(progress)({'quiet': True, 'noprogress': True, 'progress_hooks': [progress.download_hook]}) as ydl:
                    for track in ('video', 'audio'):
                        path = Path(directory) / f'{track}.mp4'
                        ok, _ = ydl.dl(str(path), {'url': f'http://127.0.0.1:{server.server_port}/{track}',
                                                'ext': 'mp4', 'protocol': 'http', 'http_headers': {}})
                        self.assertTrue(ok)
                        self.assertEqual(path.read_bytes(), f'/{track}'.encode() * 32)
                self.assertFalse(progress.current['segmented'])
                self.assertEqual(progress.current['targetConcurrency'], 0)
                self.assertEqual(progress.current['totalSegments'], 0)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
