/* Native Messaging control channel. Video bytes never travel through JSON. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NekoNative = api;
})(globalThis, function () {
  'use strict';
  const HOST = 'org.yangmo.downloader';
  function createClient(runtime, options = {}) {
    const later = options.setTimeout || setTimeout;
    const clear = options.clearTimeout || clearTimeout;
    const pending = new Map(), jobListeners = new Set(), disconnectListeners = new Set();
    let port = null, sequence = 0;
    function rejectPending(message) {
      for (const item of pending.values()) { clear(item.timer); item.reject(new Error(message)); }
      pending.clear();
    }
    function connect() {
      if (port) return port;
      if (typeof runtime.connectNative !== 'function') throw new Error('请先安装羊魔本机下载内核，并重新加载扩展');
      const current = runtime.connectNative(HOST);
      port = current;
      current.onMessage.addListener(message => {
        if (port !== current || !message || typeof message !== 'object') return;
        if (message.event === 'job' && message.job && typeof message.job.id === 'string') {
          for (const listener of jobListeners) listener(message.job);
          return;
        }
        const item = pending.get(message.requestId);
        if (!item) return;
        pending.delete(message.requestId); clear(item.timer);
        if (message.success !== true) item.reject(new Error(String(message.error || '本机内核未完成请求').slice(0, 500)));
        else item.resolve(message);
      });
      current.onDisconnect.addListener(() => {
        // Always consume lastError, even for an obsolete connection.
        const reason = runtime.lastError?.message || '';
        if (port !== current) return;
        port = null;
        const missing = /not found|not registered|specified native|forbidden|access.*denied/i.test(reason);
        const message = missing ? '未找到羊魔本机下载内核，请运行配套安装脚本后重试' : '本机下载内核连接已断开，请重新下载';
        rejectPending(message);
        for (const listener of disconnectListeners) listener(message);
      });
      return current;
    }
    function request(action, payload = {}) {
      return new Promise((resolve, reject) => {
        let current;
        try { current = connect(); } catch (error) { reject(error); return; }
        const requestId = `yangmo-${++sequence}`;
        const timer = later(() => {
          if (!pending.delete(requestId)) return;
          reject(new Error('本机下载内核响应超时，请查看任务状态后重试'));
        }, options.timeoutMs || 30000);
        pending.set(requestId, { resolve, reject, timer });
        try { current.postMessage({ requestId, action, payload }); }
        catch (error) { pending.delete(requestId); clear(timer); reject(error); }
      });
    }
    return {
      request,
      connected: () => port !== null,
      onJob(listener) { jobListeners.add(listener); return () => jobListeners.delete(listener); },
      onDisconnect(listener) { disconnectListeners.add(listener); return () => disconnectListeners.delete(listener); },
      close() {
        const current = port; port = null;
        rejectPending('本机内核连接已关闭');
        current?.disconnect();
      }
    };
  }
  return { HOST, createClient };
});
