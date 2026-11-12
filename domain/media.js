/* Pure media evidence rules. No browser, storage, DOM or network dependencies. */
(() => {
  'use strict';
  const FILE_MIMES = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-flv': 'flv', 'video/flv': 'flv',
    'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv', 'video/mp2t': 'ts', 'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm'
  };
  const FILE_EXTENSIONS = new Set(['mp4', 'webm', 'flv', 'mov', 'mkv', 'm4v', 'mp3', 'm4a', 'aac', 'ogg', 'ogv', 'avi', 'ts', 'm4s']);
  const normalizeMime = value => String(value || '').toLowerCase().split(';')[0].trim();
  function normalizeUrl(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }
  const knownMime = mime => /^(?:video|audio)\//.test(mime) || /mpegurl|iso\.segment/.test(mime);
  function mergeObservations(previous = {}, item = {}) {
    const next = { ...previous };
    const mime = normalizeMime(item.mime);
    if (item.observation === 'response' && mime && (knownMime(mime) || !knownMime(next.responseMime || ''))) next.responseMime = mime;
    if (item.observation === 'url') next.networkUrl = true;
    if (item.observation === 'dom') {
      if (mime) next.domMime = mime;
      if (item.directVideo) next.domVideo = true;
      if (item.active) next.domSelection = true;
      if (item.streamHint) next.streamHint = true;
      next.domSource = true;
    }
    return next;
  }
  function classify(url, observations = {}) {
    const path = new URL(url).pathname;
    const pathExt = /\.([a-z0-9_]+)$/i.exec(path)?.[1].toLowerCase() || '';
    const responseMime = normalizeMime(observations.responseMime);
    const mime = knownMime(responseMime) ? responseMime : normalizeMime(observations.domMime);
    const isM3U8 = /mpegurl/.test(mime) || (!knownMime(mime) &&
      (pathExt === 'm3u8' || (!FILE_EXTENSIONS.has(pathExt) && observations.streamHint === true)));
    // A directory named hls/part/chunk is not evidence of a media fragment.
    // A <video> actually using .ts is stronger evidence than that suffix.
    const isFragment = !isM3U8 && !observations.domVideo &&
      (/mp2t|iso\.segment/.test(mime) || (!knownMime(mime) && ['ts', 'm4s', 'm4v_frag', 'f4f'].includes(pathExt)));
    const ext = isM3U8 ? 'm3u8' : FILE_MIMES[mime] || (FILE_EXTENSIONS.has(pathExt) ? pathExt : 'mp4');
    const evidence = [];
    if (observations.networkUrl) evidence.push('network-url');
    if (observations.responseMime) evidence.push('network-mime');
    if (observations.domVideo) evidence.push('dom-video');
    if (observations.domSelection) evidence.push('dom-selection');
    if (observations.domSource && !observations.domVideo && !observations.domSelection) evidence.push('dom-source');
    return { kind: isM3U8 ? 'hls' : isFragment ? 'fragment' : 'direct', isM3U8, isFragment, ext,
      mime: mime || (isM3U8 ? 'application/vnd.apple.mpegurl' : `video/${ext}`), evidence };
  }
  function sanitizeFilename(name) {
    return String(name || '视频').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 100) || '视频';
  }
  const api = { normalizeUrl, normalizeMime, mergeObservations, classify, sanitizeFilename, knownMime };
  globalThis.NekoMedia = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
