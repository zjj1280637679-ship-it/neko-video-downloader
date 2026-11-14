/* YouTube page identity only. A playback request is never a complete video. */
(function (root) {
  'use strict';
  const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
  const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
  function parse(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
      let videoId;
      if (url.hostname === 'youtu.be') {
        videoId = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
      } else if (hosts.has(url.hostname)) {
        if (/^\/watch\/?$/.test(url.pathname) && url.searchParams.getAll('v').length === 1) videoId = url.searchParams.get('v');
        else videoId = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
      }
      if (!videoIdPattern.test(videoId || '')) return null;
      return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
    } catch { return null; }
  }
  function cleanTitle(value) {
    return String(value || '').replace(/\s*[-–—|]\s*YouTube\s*$/i, '').trim().slice(0, 300) || 'YouTube 视频';
  }
  function isTransport(value) {
    try {
      const url = new URL(value);
      return /(?:^|\.)googlevideo\.com$/.test(url.hostname) && /^\/videoplayback(?:\/|$)/.test(url.pathname);
    } catch { return false; }
  }
  const api = Object.freeze({ parse, cleanTitle, isTransport });
  root.NekoYouTube = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
