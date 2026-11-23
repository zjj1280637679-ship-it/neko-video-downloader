/* A discovery URL identifies a part. Only a recent anonymous track read attests readiness. */
(function (root) {
  'use strict';
  function createBroker({ parse, getTab, probe, now = Date.now }) {
    const cache = new Map(), pending = new Map(), interruptedDuringProbe = new WeakSet();
    let queue = Promise.resolve();
    const ttl = { ready: 60000, unavailable: 10000, unknown: 3000 };
    function result(state, reason, extra = {}) {
      return { success: true, state, reason, checkedAt: now(), ttlMs: ttl[state], ...extra };
    }
    async function confirmTab(tabId, identity) {
      if (!Number.isInteger(tabId) || tabId < 0 || identity?.site !== 'bilibili') throw new Error('请选择当前 B 站视频来源');
      const tab = await getTab(tabId);
      if (parse(tab?.url)?.url !== identity.url || (tab.pendingUrl && parse(tab.pendingUrl)?.url !== identity.url)) {
        throw new Error('当前视频或分 P 已切换，请重新读取视频来源');
      }
    }
    async function measure(identity) {
      try {
        const reply = await probe({ site: identity.site, url: identity.url, page: identity.page });
        if (reply?.success !== true || reply.url !== identity.url || reply.site !== identity.site ||
            reply.page !== identity.page || reply.videoId !== identity.videoId || !Object.hasOwn(ttl, reply.readiness)) {
          return result('unknown', '未收到当前分 P 的有效验证结果，请重新验证');
        }
        return result(reply.readiness, String(reply.reason || '').slice(0, 250), {
          authRequired: reply.readiness !== 'ready' && reply.authRequired === true,
          qualityLabel: reply.readiness === 'ready' ? String(reply.qualityLabel || '').slice(0, 60) : ''
        });
      } catch (error) {
        const reason = String(error?.message || '');
        return result('unknown', /不支持的本地内核命令/.test(reason) ? '请更新配套本机内核，再验证 B 站来源' :
          '本机内核未能完成验证，请检查内核连接后重试');
      }
    }
    async function check({ url, tabId, force }) {
      const identity = parse(url);
      await confirmTab(tabId, identity);
      const key = identity.url, cached = cache.get(key);
      let work = pending.get(key);
      if (!work && force !== true && cached && now() < cached.checkedAt + cached.ttlMs) return cached;
      if (!work) {
        // The host admits one sample at a time. Downloads use their own controls.
        if (pending.size >= 3) return result('unknown', '其他来源正在验证，请稍后重试');
        cache.delete(key);
        work = queue.then(() => measure(identity)).then(measured => {
          const value = interruptedDuringProbe.has(work) ? result('unknown', '下载已中断，请重新验证来源') : measured;
          if (cache.size >= 32) cache.delete(cache.keys().next().value);
          cache.set(key, value);
          return value;
        }).finally(() => pending.delete(key));
        pending.set(key, work);
        queue = work.catch(() => {});
      }
      const measured = await work;
      await confirmTab(tabId, identity);
      return measured;
    }
    function invalidate(url) {
      cache.delete(url);
      if (pending.has(url)) interruptedDuringProbe.add(pending.get(url));
    }
    return { check, invalidate, async confirmCurrent({ tabId, url }) { await confirmTab(tabId, parse(url)); } };
  }
  const api = { createBroker };
  root.NekoSourceReadiness = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
