"""Small shared boundary rules; no browser or model/session credentials."""
from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = '2.4.0'
YTDLP_VERSION = '2026.10.26'
MAX_CONCURRENCY = 375
IDENTIFIER = re.compile(r'^[A-Za-z0-9_-]{1,128}$')
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
TERMINAL = {'interrupted', 'cancelled'}


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError('任务标识无效')
    return value


def youtube_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('YouTube 地址无效')
    url = urlparse(value)
    if url.scheme not in ('http', 'https') or url.username or url.password or url.port:
        raise ValueError('仅支持标准 YouTube 视频地址')
    host = (url.hostname or '').lower()
    if host == 'youtu.be':
        video_id = url.path.strip('/')
    elif host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com'):
        pieces = url.path.strip('/').split('/')
        if url.path == '/watch':
            values = parse_qs(url.query).get('v', [])
            video_id = values[0] if len(values) == 1 else ''
        elif len(pieces) == 2 and pieces[0] in ('shorts', 'embed', 'live'):
            video_id = pieces[1]
        else:
            video_id = ''
    else:
        video_id = ''
    if not VIDEO_ID.fullmatch(video_id):
        raise ValueError('请打开一个具体的 YouTube 视频，不支持播放列表地址')
    return f'https://www.youtube.com/watch?v={video_id}'


def site_video(value, expected_site=None):
    """A concrete video identity, never a collection or an extractor redirect."""
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('视频地址无效')
    parsed = urlparse(value)
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password or parsed.port:
        raise ValueError('仅支持标准视频地址')
    if (parsed.hostname or '').lower() in ('bilibili.com', 'www.bilibili.com', 'm.bilibili.com'):
        match = re.fullmatch(r'/(?:zh-Hans/|zh-Hant/)?video/(BV[A-Za-z0-9]{10}|av[1-9][0-9]*)/?', parsed.path)
        if not match:
            raise ValueError('B站仅支持普通投稿的 BV/av 视频地址')
        video_id = match[1]
        if video_id.startswith('av') and int(video_id[2:]) > 9007199254740991:
            raise ValueError('B站视频编号无效')
        pages = parse_qs(parsed.query, keep_blank_values=True).get('p', ['1'])
        if len(pages) != 1 or not re.fullmatch(r'[1-9][0-9]*', pages[0]) or len(pages[0]) > 16:
            raise ValueError('B站分P编号无效')
        page = int(pages[0])
        if page > 9007199254740991:
            raise ValueError('B站分P编号无效')
        result = {'site': 'bilibili', 'url': f'https://www.bilibili.com/video/{video_id}/?p={page}',
                  'page': page, 'videoId': video_id}
    else:
        canonical = youtube_url(value)
        result = {'site': 'youtube', 'url': canonical, 'page': 1,
                  'videoId': parse_qs(urlparse(canonical).query)['v'][0]}
    if expected_site is not None and expected_site != result['site']:
        raise ValueError('任务站点与视频地址不一致')
    return result


def job_video(job):
    # Old hosts only accepted YouTube; a missing site must not expand cookie scope.
    expected_site = job.get('site', 'youtube')
    if expected_site not in ('youtube', 'bilibili'):
        raise ValueError('任务站点无效')
    result = site_video(job.get('url'), expected_site)
    if 'page' in job and (type(job['page']) is not int or job['page'] != result['page']):
        raise ValueError('任务分P与视频地址不一致')
    return result


def policy(value):
    concurrency, revision = value.get('concurrency', 64), value.get('concurrencyRevision', 0)
    if type(concurrency) is not int or not 1 <= concurrency <= MAX_CONCURRENCY:
        raise ValueError('分片并发必须为 1–375 的整数')
    if type(revision) is not int or not 0 <= revision <= 9007199254740991:
        raise ValueError('并发版本无效')
    return {'concurrency': concurrency, 'concurrencyRevision': revision}


def site_cookies(value, site):
    """Optional explicitly authorized session material; never persist this return."""
    domains = {'youtube': ('.youtube.com', 'youtube.com'), 'bilibili': ('.bilibili.com', 'bilibili.com')}
    if site not in domains:
        raise ValueError('会话站点无效')
    label = 'B站' if site == 'bilibili' else 'YouTube'
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError(f'{label} 会话数据无效')
    result = []
    for item in value:
        if not isinstance(item, dict) or item.get('domain') not in domains[site]:
            raise ValueError(f'只接受 {label} 本站会话')
        name, contents = item.get('name'), item.get('value')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_!#$%&\x27*+.^`|~-]{1,128}', name):
            raise ValueError(f'{label} 会话名称无效')
        if not isinstance(contents, str) or len(contents) > 8192 or any(c in contents for c in '\r\n\x00'):
            raise ValueError(f'{label} 会话内容无效')
        path = item.get('path', '/')
        if not isinstance(path, str) or not path.startswith('/') or len(path) > 1024 or any(c in path for c in '\r\n\x00'):
            raise ValueError(f'{label} 会话路径无效')
        expires = item.get('expirationDate')
        if expires is not None and (not isinstance(expires, (int, float)) or not 0 < expires < 1e12):
            raise ValueError(f'{label} 会话时间无效')
        result.append({'name': name, 'value': contents, 'domain': item['domain'], 'path': path,
                       'secure': bool(item.get('secure', True)), 'expirationDate': expires})
    if len(json.dumps(result)) > 200000:
        raise ValueError(f'{label} 会话数据过大')
    return result


def youtube_cookies(value):
    return site_cookies(value, 'youtube')


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, path)


def task_path(data_dir, job_id, run_id):
    root = (Path(data_dir) / 'jobs').resolve()
    target = root / identifier(job_id) / identifier(run_id)
    resolved = target.resolve()
    if not resolved.is_relative_to(root) or resolved == root:
        raise ValueError('任务目录越界')
    # An existing reparse point must never become a recursive deletion target.
    for parent in (target.parent, target):
        if parent.exists() and (parent.is_symlink() or getattr(parent, 'is_junction', lambda: False)()):
            raise ValueError('任务目录不能是链接')
    return resolved


def safe_filename(title, extension):
    if extension not in ('mp4', 'mkv', 'webm'):
        raise ValueError('视频文件扩展名无效')
    normalized = unicodedata.normalize('NFC', str(title or 'YouTube 视频'))
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*\ud800-\udfff]', '_', normalized).strip(' .')
    if not name:
        name = 'YouTube 视频'
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', name, re.I):
        name = '_' + name
    suffix = '.' + extension
    # Chrome coordinator uses JS slice(0, 140), i.e. UTF-16 code units.
    # Reserve its suffix before clipping so long astral/emoji titles remain
    # identical under the coordinator's normalization and keep a real extension.
    budget = 140 - len(suffix)
    clipped = []
    for character in name:
        units = 2 if ord(character) > 0xffff else 1
        if units > budget:
            break
        clipped.append(character)
        budget -= units
    return ''.join(clipped).rstrip(' .') + suffix


def readable_error(error, site='youtube'):
    text = str(error).lower()
    label = 'B站' if site == 'bilibili' else 'YouTube'
    if site == 'bilibili':
        if 'preview' in text or 'supporter-only' in text or 'premium members' in text:
            return 'B站仅提供试看或受限内容，未将其保存为完整视频；请确认账号有观看权限后授权重试。'
        if any(marker in text for marker in ('412', '-352', '-401', 'riskdata', 'rate limit', 'session required')):
            return 'B站触发访问验证或限流；请稍后重试，或在网页可播放后明确授权当前会话重试。'
        if auth_required(error, site):
            return '该B站视频需要有观看权限的登录状态，请在明确授权后重试。'
        if any(marker in text for marker in ('bilibili unsupported', 'bilibili identity', 'bilibili page')):
            return '暂仅支持普通投稿的当前分P；该来源的页面或分P信息无法确认，未下载合集或其他内容。'
        if '403' in text or 'forbidden' in text:
            return 'B站拒绝了媒体请求（403）；请重新读取来源后重试。'
        if '429' in text or 'too many requests' in text:
            return 'B站暂时限制请求频率，请稍后重试。'
    if 'fragment exceeds byte limit' in text or 'max-filesize' in text:
        return '单个视频分片超过 128 MiB 的处理上限，已停止下载，未保存不完整文件。'
    if 'fragmented protocol' in text or 'unsupported fragmented transport' in text:
        return '当前分片传输格式尚未适配，未降级为无法实时控制的下载方式。'
    if 'confirm' in text and ('bot' in text or 'sign in' in text):
        return f'{label} 要求验证当前访问会话，匿名下载暂不可用；请稍后重试。'
    if 'private video' in text or 'members-only' in text or 'sign in' in text or 'login' in text:
        return f'该视频需要 {label} 登录状态，请在明确授权后重试。'
    if 'drm' in text:
        return '该来源受 DRM 保护，无法下载。'
    if '403' in text or 'forbidden' in text:
        return f'{label} 拒绝了媒体请求（403）；来源或访问令牌可能已失效，请重新下载。'
    if '429' in text or 'too many requests' in text:
        return f'{label} 暂时限制请求频率，请稍后重试。'
    if 'unavailable' in text or 'not available' in text or 'no video formats' in text:
        return '当前视频或可下载格式不可用，请换一个公开视频重试。'
    if 'timed out' in text or 'timeout' in text or 'connection' in text:
        return '连接视频来源失败或超时，请检查网络后重新下载。'
    if 'live' in text:
        return '当前版本仅支持完整点播，暂不下载正在直播的视频。'
    if 'incomplete duration' in text:
        return '成品时长与当前视频分P不符，已停止保存不完整文件。'
    if 'ffmpeg' in text or 'ffprobe' in text:
        return '音视频合并或成品校验失败，请检查本地内核安装。'
    if 'disk' in text or 'space' in text or isinstance(error, OSError):
        return '本地读写失败，请检查临时目录权限和磁盘空间。'
    return '本地下载未完成；请重新下载或检查本地内核版本。'


def auth_required(error, site='youtube'):
    text = str(error).lower()
    if site == 'bilibili' and any(marker in text for marker in (
            'registered users', 'supporter-only', 'premium members', 'preview',
            '412', '-352', '-401', 'riskdata', 'rate limit', 'session required')):
        # This permits an explicit session retry, not a claim that login solves risk control.
        return True
    return any(marker in text for marker in ('sign in', 'login_required', 'login required',
                                             'private video', 'members-only', 'confirm you’re not a bot',
                                             "confirm you're not a bot"))
