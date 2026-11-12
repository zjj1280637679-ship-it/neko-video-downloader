// Pure presentation helpers. No Chrome APIs or mutable application state.
(function (root) {
  function formatSize(bytes) {
    if (!(bytes > 0) || !Number.isFinite(bytes)) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }
  function safeFilename(name) {
    return String(name || "视频").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120) || "视频";
  }
  function mediaUrl(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url : null; } catch { return null; }
  }
  function formatRemaining(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const rounded = Math.ceil(seconds);
    if (rounded < 60) return `${rounded} 秒`;
    if (rounded < 3600) return `${Math.floor(rounded / 60)} 分${rounded % 60 ? ` ${rounded % 60} 秒` : ""}`;
    const minutes = Math.ceil(rounded / 60), hours = Math.floor(minutes / 60);
    return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  }
  const api = Object.freeze({ formatSize, safeFilename, mediaUrl, formatRemaining });
  root.NekoFormat = api;
  if (typeof module === "object") module.exports = api;
})(globalThis);
