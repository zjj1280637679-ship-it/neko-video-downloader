/* Site identity/configuration shared by discovery, task routing and consent UI. */
(function (root) {
  'use strict';
  const commonJS = typeof module === 'object' && module.exports;
  const youtube = commonJS ? require('./youtube.js') : root.NekoYouTube;
  const bilibili = commonJS ? require('./bilibili.js') : root.NekoBilibili;
  const entries = [
    { id: 'youtube', label: 'YouTube', engine: 'youtube-native', cookieDomains: ['youtube.com', '.youtube.com'], cookieQueryDomain: 'youtube.com', rules: youtube },
    { id: 'bilibili', label: 'B站', engine: 'bilibili-native', cookieDomains: ['bilibili.com', '.bilibili.com'], cookieQueryDomain: 'bilibili.com', rules: bilibili }
  ];
  const configs = new Map(entries.map(({ rules, ...config }) => [config.id, Object.freeze({ ...config, cookieDomains: Object.freeze(config.cookieDomains) })]));
  function get(site) { return configs.get(site) || null; }
  function parse(value) {
    for (const entry of entries) {
      const identity = entry.rules.parse(value);
      if (identity) return { ...identity, site: entry.id, siteLabel: entry.label, engine: entry.engine };
    }
    return null;
  }
  function forJob(job) {
    if (!job || typeof job !== 'object') return null;
    const config = entries.find(entry => entry.engine === job.engine);
    if (!config || (job.site && job.site !== config.id)) return null;
    if (job.url && parse(job.url)?.site !== config.id) return null;
    return get(config.id);
  }
  function isNativeJob(job) { return forJob(job) !== null; }
  function cleanTitle(value, site) {
    const entry = entries.find(item => item.id === site);
    return entry ? entry.rules.cleanTitle(value) : String(value || '').trim().slice(0, 300) || '视频';
  }
  function isTransport(value) { return entries.some(entry => entry.rules.isTransport(value)); }
  const api = Object.freeze({ parse, get, forJob, isNativeJob, cleanTitle, isTransport });
  root.NekoSites = api;
  if (commonJS) module.exports = api;
})(globalThis);
