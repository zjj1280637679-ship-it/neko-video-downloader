"""Pinned BiliBiliIE boundary: one ordinary upload, one explicitly selected P.

The upstream extractor remains responsible for API signing and formats. These
guards run before YoutubeDL can expand a playlist/redirect or download media.
"""
from __future__ import annotations

import math

from yt_dlp.extractor.bilibili import BiliBiliIE
from common import site_video


def extraction_url(identity):
    # One observed official locale route, not an alternating retry/evade loop.
    # Persisted identity remains the locale-independent canonical video URL.
    return f'https://www.bilibili.com/zh-Hans/video/{identity["videoId"]}/?p={identity["page"]}'


class CurrentBilibiliIE(BiliBiliIE):
    # Official localized ordinary-video routes still identify the same upload.
    # Upstream's broad festival/redirect matching is intentionally not inherited.
    _VALID_URL = r'https?://(?:www\.)?bilibili\.com/(?:zh-Hans/|zh-Hant/)?video/(?P<prefix>BV|av)(?P<id>[^/?#&]+)'

    def __init__(self, identity):
        super().__init__()
        self.identity = identity
        self.source = {}

    @classmethod
    def ie_key(cls):
        # Replace this instance's registry entry, not global yt-dlp classes.
        return BiliBiliIE.ie_key()

    def _download_webpage_handle(self, url, video_id, *args, **kwargs):
        webpage, handle = super()._download_webpage_handle(url, video_id, *args, **kwargs)
        # yt-dlp's JSON helpers also call this method for its own fixed API URLs.
        # Validate redirects of the initial video document, not API responses.
        if url in (self.identity['url'], extraction_url(self.identity)):
            actual = site_video(handle.url, 'bilibili')
            if actual['page'] != self.identity['page'] or (
                    self.identity['videoId'].startswith('BV') and actual['videoId'] != self.identity['videoId']):
                raise ValueError('Bilibili page redirect changed identity')
        return webpage, handle

    def _search_json(self, start_pattern, string, name, video_id, **kwargs):
        value = super()._search_json(start_pattern, string, name, video_id, **kwargs)
        if name == 'initial state' and isinstance(value, dict) and value.get('videoData'):
            self.capture_source(value['videoData'])
        return value

    def capture_source(self, video):
        bvid, aid = video.get('bvid'), video.get('aid')
        expected = self.identity['videoId']
        if (expected.startswith('BV') and bvid != expected) or (
                expected.startswith('av') and str(aid) != expected[2:]):
            raise ValueError('Bilibili identity mismatch')
        if video.get('redirect_url') or video.get('rights', {}).get('is_stein_gate'):
            raise ValueError('Bilibili unsupported redirect or interactive video')
        pages, page = video.get('pages'), self.identity['page']
        if not isinstance(pages, list) or not 1 <= page <= len(pages):
            raise ValueError('Bilibili page is unavailable')
        part = pages[page - 1]
        if not isinstance(part, dict) or part.get('page') != page or not part.get('cid'):
            raise ValueError('Bilibili page identity unavailable')
        duration = part.get('duration')
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
            raise ValueError('Bilibili page duration unavailable')
        title = str(video.get('title') or 'B站视频')
        part_name = str(part.get('part') or '').strip()
        self.source.update(bvid=bvid, cid=part['cid'], duration=duration,
                           title=f'{title} P{page:02d}' + (f' {part_name}' if part_name and part_name != title else ''),
                           expected_audio=True)

    def extract_formats(self, play_info):
        if not isinstance(play_info, dict):
            raise ValueError('Bilibili video formats unavailable')
        descriptions = play_info.get('accept_description') or []
        if play_info.get('is_preview') or play_info.get('isPreview') or any('试看' in str(x) for x in descriptions):
            raise ValueError('Bilibili preview is not a complete video')
        expected = self.source.get('duration')
        actual = play_info.get('timelength')
        if expected and type(actual) in (int, float) and actual > 0:
            if actual / 1000 < expected - max(3, expected * .02):
                raise ValueError('Bilibili preview or incomplete duration')
        formats = super().extract_formats(play_info)
        dash = play_info.get('dash')
        # Only the source's explicit empty audio list permits a genuinely silent
        # output. Missing/ambiguous codec metadata still requires an audio track.
        if isinstance(dash, dict) and 'audio' in dash and dash['audio'] in (None, []):
            has_extra_audio = (dash.get('dolby') or {}).get('audio') or (dash.get('flac') or {}).get('audio')
            if dash.get('video') and not has_extra_audio and not play_info.get('durl'):
                self.source['expected_audio'] = False
                for fmt in formats:
                    if fmt.get('vcodec') != 'none':
                        fmt['acodec'] = 'none'
        return formats

    def report_warning(self, message, *args, **kwargs):
        # Upstream 2026.10.26 only warns for supporter previews. Never let a quiet
        # logger convert that warning into a successful full-video delivery.
        if 'preview' in str(message).lower():
            raise ValueError('Bilibili preview is not a complete video')
        return super().report_warning(message, *args, **kwargs)

    def _real_extract(self, url):
        result = super()._real_extract(url)
        if not isinstance(result, dict) or result.get('_type', 'video') != 'video' or 'entries' in result:
            raise ValueError('Bilibili unsupported collection, redirect or legacy multi_video')
        expected_id = f'{self.source.get("bvid")}_p{self.identity["page"]}'
        if not self.source or result.get('id') != expected_id:
            raise ValueError('Bilibili page identity mismatch')
        result['title'] = self.source['title']
        result['duration'] = self.source['duration']
        return result
