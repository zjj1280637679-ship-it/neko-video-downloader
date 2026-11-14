/* Ordinary Bilibili uploads only. The current page is part of the identity. */
(function (root) {
  'use strict';
  const hosts = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);
  function parse(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !hosts.has(url.hostname)) return null;
      const videoId = /^\/(?:zh-Hans\/|zh-Hant\/)?video\/(BV[A-Za-z0-9]{10}|av[1-9][0-9]*)\/?$/.exec(url.pathname)?.[1];
      if (!videoId || (videoId.startsWith('av') && !Number.isSafeInteger(Number(videoId.slice(2))))) return null;
      const pages = url.searchParams.getAll('p');
      if (pages.length > 1 || (pages.length && !/^[1-9][0-9]*$/.test(pages[0]))) return null;
      const page = pages.length ? Number(pages[0]) : 1;
      if (!Number.isSafeInteger(page) || page < 1) return null;
      // Explicit p=1 also tells extractors to select one part of a multi-P upload.
      return { videoId, page, url: `https://www.bilibili.com/video/${videoId}/?p=${page}` };
    } catch { return null; }
  }
  function cleanTitle(value) {
    return String(value || '').replace(/\s*[_\-–—|]\s*(?:哔哩哔哩(?:_bilibili)?|bilibili)\s*$/i, '').trim().slice(0, 300) || 'B站视频';
  }
  function isTransport(value) {
    try {
      const url = new URL(value);
      // Match known track/fragment extensions, not every MP4 hosted on a CDN.
      return /(?:^|\.)(?:bilivideo\.(?:com|cn)|hdslb\.com|bilibili\.com)$/.test(url.hostname) &&
        (/\.(?:m4s|m4v_frag|f4f)(?:$|\/)/i.test(url.pathname) ||
          /\/(?:upgcxcode|live-bvc|live-bvc-mux)\/.*\.ts(?:$|\/)/i.test(url.pathname));
    } catch { return false; }
  }
  const api = Object.freeze({ parse, cleanTitle, isTransport });
  root.NekoBilibili = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
