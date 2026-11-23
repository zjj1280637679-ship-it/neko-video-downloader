"""Anonymous, read-only source check. One selected Bilibili part per process."""
import json
from pathlib import Path
import re
import sys

from common import YTDLP_VERSION, job_video


SAMPLE_BYTES = 32


class ProbeResult(Exception):
    """A local, displayable explanation with no upstream URLs or secrets."""
    def __init__(self, state, reason):
        super().__init__(reason)
        self.state = state


def check_tracks(ydl, info, source):
    from yt_dlp.networking import Request
    from yt_dlp.utils.networking import HTTPHeaderDict
    from bilibili_adapter import track_headers, validate_track_range
    from worker import validate_vod

    tracks = info.get('requested_formats') or [info]
    if len(tracks) > 2:
        raise ProbeResult('unknown', '当前选轨组合暂不支持快速验证。')
    validate_vod(info)
    for track in tracks:
        validate_vod(track)
        if (track.get('protocol') not in ('http', 'https') or track.get('fragments')
                or not track.get('url') or track.get('request_data')):
            raise ProbeResult('unknown', '当前传输格式暂不支持快速验证。')
    for codec, label in [('vcodec', '画面'), ('acodec', '声音')]:
        if codec == 'acodec' and source.get('expected_audio') is False:
            continue
        if all(t.get(codec) == 'none' for t in tracks):
            raise ProbeResult('unavailable', f'当前分P缺少可下载的{label}轨。')
        if not any(t.get(codec) and t[codec] not in ('none', 'unknown') for t in tracks):
            raise ProbeResult('unknown', f'尚未确认当前分P的{label}编码。')

    for track in tracks:
        # Match HttpFD and our whole-track adapter, including the open-ended
        # range required by some CDNs. Close immediately after the prefix.
        headers = HTTPHeaderDict({'Accept-Encoding': 'identity'}, track_headers(ydl, track))
        if headers.get('Range') not in (None, 'bytes=0-'):
            raise ProbeResult('unknown', '当前媒体请求范围暂不支持快速验证。')
        with ydl.urlopen(Request(track['url'], headers=headers)) as response:
            if response.status == 206:
                validate_track_range(response, headers.get('Range'), track.get('filesize'))
            elif response.status == 200:
                length = response.headers.get('Content-Length')
                if length and track.get('filesize') and length != str(track['filesize']):
                    raise ValueError('Bilibili incomplete HTTP track')
            elif 400 <= response.status < 600:
                raise ValueError(f'HTTP Error {response.status}')
            else:
                raise ProbeResult('unavailable', 'B站未能返回可读取的媒体轨。')
            prefix = response.read(SAMPLE_BYTES)
            if len(prefix) != SAMPLE_BYTES or prefix.lstrip().startswith((b'<', b'{', b'[')):
                raise ProbeResult('unavailable', '媒体地址返回了空白、错误页面或截断的数据。')
            if prefix[4:8] not in (b'ftyp', b'styp', b'moov', b'moof') and not prefix.startswith((b'FLV\x01', b'\x1a\x45\xdf\xa3')):
                raise ProbeResult('unknown', '已收到数据，但尚未识别出可用的媒体文件头。')


def check_source(config, identity):
    from yt_dlp import YoutubeDL
    from yt_dlp.version import __version__
    from bilibili_adapter import CurrentBilibiliIE, extraction_url
    from worker import extraction_params, validate_vod

    if __version__ != YTDLP_VERSION:
        raise ProbeResult('unknown', '本地解析器版本不匹配，请更新本地内核。')
    extractor = CurrentBilibiliIE(identity)
    params = {**extraction_params(config, 'bilibili'), 'cachedir': False,
              'socket_timeout': 5, 'extractor_retries': 0, 'retries': 0,
              'check_formats': False, 'match_filter': validate_vod}
    with YoutubeDL(params) as ydl:
        ydl.add_info_extractor(extractor)
        info = ydl.extract_info(extraction_url(identity), download=False, ie_key='BiliBili')
        if not info or not extractor.source:
            raise ProbeResult('unavailable', 'B站未返回当前分P的可下载媒体。')
        check_tracks(ydl, info, extractor.source)
    height = info.get('height')
    return {'readiness': 'ready', 'reason': '', 'authRequired': False,
            'qualityLabel': f'{height}p' if isinstance(height, int) and height > 0 else ''}


def failure(error):
    def result(state, reason, auth=False):
        return {'readiness': state, 'reason': reason, 'authRequired': auth}
    if isinstance(error, ProbeResult):
        return result(error.state, str(error))
    # Exceptions from yt-dlp can include signed CDN URLs; return fixed text only.
    detail = re.sub(r'https?://\S+', '', str(error)).lower()
    if any(s in detail for s in ('timed out', 'timeout', 'connection', 'certificate', 'getaddrinfo')):
        return result('unknown', '连接超时或中断，暂时无法确认下载源。')
    status = re.search(r'\bhttp(?:\s*error)?[\s:]+([45]\d\d)\b', detail)
    code = int(status[1]) if status else None
    if code in (408, 412, 429) or (code and code >= 500):
        return result('unknown', f'B站暂时无法完成来源检查（HTTP {code}），请稍后重试。')
    if any(s in detail for s in ('-352', '-401', 'riskdata', 'risk control', 'rate limit',
                                  'too many requests', 'session required', '风控', '限流')):
        return result('unknown', 'B站暂时限制了来源检查，请稍后重试。')
    if 'preview or incomplete duration' in detail:
        return result('unavailable', '媒体时长短于当前分P，暂时无法确认完整来源。')
    if any(s in detail for s in ('registered users', 'supporter-only', 'premium members', 'members-only',
                                  'preview', 'sign in', 'login required', 'login_required', 'log in')):
        return result('unavailable', 'B站未向当前匿名会话提供完整媒体。', True)
    if 'drm' in detail or 'live videos' in detail:
        return result('unavailable', '该来源受保护或正在直播。')
    if status:
        return result('unavailable', f'B站当前未提供所需资源（HTTP {status[1]}）。')
    if 'bilibili incomplete http track' in detail:
        return result('unavailable', 'B站返回的媒体范围或文件长度不完整。')
    if any(s in detail for s in ('bilibili unsupported', 'bilibili page', 'bilibili identity',
                                  'not available', 'unavailable', 'no video formats')):
        return result('unavailable', 'B站未提供与当前分P匹配的完整媒体。')
    return result('unknown', '本地内核暂时无法确认当前分P的媒体来源。')


if __name__ == '__main__':
    try:
        config = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
        identity = job_video({'site': 'bilibili', 'url': sys.argv[2]})
        outcome = check_source(config, identity)
    except Exception as error:
        outcome = failure(error)
    print(json.dumps(outcome), flush=True)
