"""Offline evidence for Bilibili source readiness and asynchronous host RPC."""
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from common import site_video
from probe import SAMPLE_BYTES, ProbeResult, check_tracks, failure
from test_bilibili import URL, extract_fixture
from test_native import QuietHost


class Sample(io.BytesIO):
    def __init__(self, body=b'\0\0\0\x20ftyp' + b'0' * 300, headers=None):
        super().__init__(body)
        self.status = 206
        self.headers = headers or {'Content-Range': 'bytes 0-307/308', 'Content-Length': '308'}
        self.sizes = []

    def read(self, size=-1):
        self.sizes.append(size)
        return super().read(size)


class ProbeTests(unittest.TestCase):
    def test_selected_part_reads_each_track_once_using_real_download_headers(self):
        from yt_dlp import YoutubeDL
        extractor, info = extract_fixture()
        samples = [Sample(), Sample()]
        with YoutubeDL({'quiet': True}) as ydl, patch.object(ydl, 'urlopen', side_effect=samples) as open_media:
            check_tracks(ydl, info, extractor.source)
        self.assertEqual(open_media.call_count, 2)
        for track, sample, call in zip(info['requested_formats'], samples, open_media.call_args_list):
            request = call.args[0]
            self.assertEqual(request.url, track['url'])
            self.assertEqual(request.headers['Range'], 'bytes=0-')
            self.assertEqual(request.headers['Referer'], track['http_headers']['Referer'])
            self.assertEqual(sample.sizes, [SAMPLE_BYTES])
            self.assertTrue(sample.closed)

    def test_partial_success_html_or_bad_range_never_pass(self):
        from yt_dlp import YoutubeDL
        extractor, info = extract_fixture()
        for audio in (ValueError('HTTP Error 403'), Sample(b'<html>' * 20), Sample(b''),
                      Sample(headers={'Content-Range': 'bytes 0-99/200'})):
            samples = [Sample(), audio]
            with YoutubeDL({'quiet': True}) as ydl, patch.object(ydl, 'urlopen', side_effect=samples):
                with self.assertRaises((ValueError, ProbeResult)) as error:
                    check_tracks(ydl, info, extractor.source)
                self.assertEqual(failure(error.exception)['readiness'], 'unavailable')
                self.assertTrue(samples[0].closed)
                if isinstance(audio, Sample):
                    self.assertTrue(audio.closed)

    def test_silent_only_if_explicit_and_unknown_transport_stays_unknown(self):
        from yt_dlp import YoutubeDL
        _, info = extract_fixture()
        track = info['requested_formats'][0]
        with YoutubeDL({'quiet': True}) as ydl, patch.object(ydl, 'urlopen', return_value=Sample()) as media:
            with self.assertRaises(ProbeResult) as missing:
                check_tracks(ydl, track, {'expected_audio': True})
            self.assertEqual(missing.exception.state, 'unavailable')
            with self.assertRaises(ProbeResult) as unsupported:
                check_tracks(ydl, {**track, 'protocol': 'm3u8_native'}, {'expected_audio': False})
            self.assertEqual(unsupported.exception.state, 'unknown')
            with self.assertRaisesRegex(ValueError, 'DRM'):
                check_tracks(ydl, {**track, 'has_drm': True}, {'expected_audio': False})
            media.assert_not_called()
            check_tracks(ydl, track, {'expected_audio': False})
            media.assert_called_once()

    def test_transient_auth_and_signed_link_errors(self):
        self.assertEqual(failure(TimeoutError('socket timed out'))['readiness'], 'unknown')
        self.assertTrue(failure(ValueError('only the preview will be extracted'))['authRequired'])
        self.assertTrue(failure(ValueError('only available for registered users'))['authRequired'])
        self.assertFalse(failure(ValueError('Bilibili preview or incomplete duration'))['authRequired'])
        for message in ('HTTP Error 408', 'HTTP Error 412', 'HTTPError 429', 'HTTP Error 503',
                        'HTTP Error 567', 'You have exceeded the rate limit', 'API returned -352',
                        'Bilibili session required'):
            self.assertEqual(failure(ValueError(message))['readiness'], 'unknown')
            self.assertFalse(failure(ValueError(message))['authRequired'])
        result = failure(ValueError('HTTP Error 403: https://cdn.test/signed?private=412'))
        self.assertEqual(result['readiness'], 'unavailable')
        self.assertFalse(result['authRequired'])
        self.assertNotIn('private', json.dumps(result))

    def test_slow_probe_leaves_queue_responsive_and_times_out(self):
        with tempfile.TemporaryDirectory() as directory:
            events, completed = [], threading.Event()
            def receive(event):
                events.append(event)
                if 'requestId' in event:
                    completed.set()
            host = QuietHost({'data_dir': directory, 'python': sys.executable, '_config_path': 'unused'}, receive)
            identity = site_video(URL)
            request = {'action': 'probeBilibili', 'requestId': 'check', 'payload': identity}
            # A real, deliberately stalled process exercises timeout/termination.
            popen = subprocess.Popen
            def stalled(command, **kw):
                return popen([sys.executable, '-c', 'import time; time.sleep(30)'], **kw)
            try:
                for bad in ({'cookies': []}, {'videoId': 'another'}, {'page': 1}, {'site': 'youtube'}):
                    with self.assertRaises(ValueError):
                        host.dispatch({**request, 'payload': {**identity, **bad}})
                with patch('host.subprocess.Popen', side_effect=stalled), patch('host.PROBE_TIMEOUT', .6):
                    self.assertIsNone(host.dispatch(request))
                    self.assertEqual(host.dispatch(request)['readiness'], 'unknown')
                    self.assertTrue(host.dispatch({'action': 'ping'})['capabilities']['bilibiliProbe'])
                    self.assertEqual(host.dispatch({'action': 'status'})['jobs'], [])
                    host.start({'job': {**identity, 'id': 'job', 'runId': 'run'}})
                    target = {'jobId': 'job', 'runId': 'run'}
                    self.assertEqual(host.cancel(target)['job']['state'], 'cancelled')
                    self.assertTrue(host.release(target)['success'])
                    self.assertTrue(completed.wait(7))
                replies = [event for event in events if 'requestId' in event]
                self.assertEqual(len(replies), 1)
                self.assertEqual(replies[0]['page'], 2)
                self.assertEqual(replies[0]['requestId'], 'check')
                self.assertIn('超时', replies[0]['reason'])
                self.assertEqual(replies[0]['readiness'], 'unknown')
                self.assertEqual(list((Path(directory) / 'jobs').iterdir()), [])
            finally:
                host.close()


if __name__ == '__main__':
    unittest.main()
