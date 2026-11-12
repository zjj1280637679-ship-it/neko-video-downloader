/* Account for payload copies and reserve enough room for the ordered writer's
 * head segment. A slow head must never deadlock behind later completed data. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NekoTransferBuffer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function createBuffer({ budgetBytes, resourceLimitBytes }) {
    const budget = Math.max(resourceLimitBytes * 2, budgetBytes);
    const held = new Map(), expected = new Map(), waiting = new Set();
    let head = 0, used = 0, peak = 0;
    function notify() { for (const wake of [...waiting]) wake(); }
    function check(signal) { if (signal?.aborted) throw signal.reason || new DOMException('下载已取消', 'AbortError'); }
    function checkSize(payloadBytes) {
      if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > resourceLimitBytes) throw new Error('分片超过传输缓冲资源上限');
    }
    function setExpectedSize(index, payloadBytes) {
      if (!Number.isSafeInteger(index) || index < 0) throw new Error('分片序号必须是非负安全整数');
      checkSize(payloadBytes);
      if ((held.get(index) || 0) > payloadBytes * 2) throw new Error('声明分片大小小于已预留正文大小');
      if (expected.has(index) && expected.get(index) !== payloadBytes) throw new Error('同一次传输的声明分片大小不能改变');
      if (head !== null && index >= head) {
        const retained = [...held].reduce((sum, [key, amount]) => sum + (key >= index ? amount : 0), 0);
        const missing = Math.max(0, payloadBytes * 2 - (held.get(index) || 0));
        if (retained + missing > budget) throw new Error('声明分片大小与现有缓冲保护冲突');
      }
      expected.set(index, payloadBytes);
      notify();
    }
    function fitsFutureHeads(index, projected) {
      if (projected > budget) return false;
      if (head === null || index <= head) return true;
      // Every earlier unfinished segment will eventually become the writer head.
      // Its predecessors will then have been released, but later data is still
      // resident. Protect that future state too, or a small current head can let
      // later responses fill the space needed by a larger next head.
      const checkpoints = new Set([head]);
      const before = [...held].filter(([key]) => key < index).sort(([a], [b]) => a - b);
      for (const key of new Set([...held.keys(), ...expected.keys()])) {
        if (key < head || key >= index) continue;
        checkpoints.add(key);
        if (key + 1 < index) checkpoints.add(key + 1);
      }
      // A gap has unchanged accounting and the same unknown-size guard, so only
      // its first index needs checking; never iterate over an unbounded index gap.
      let retained = projected, cursor = 0;
      for (const candidate of [...checkpoints].sort((a, b) => a - b)) {
        while (cursor < before.length && before[cursor][0] < candidate) retained -= before[cursor++][1];
        const missing = Math.max(0, (expected.get(candidate) ?? resourceLimitBytes) * 2 - (held.get(candidate) || 0));
        if (retained + missing > budget) return false;
      }
      return true;
    }
    async function reserve(index, payloadBytes, signal) {
      checkSize(payloadBytes);
      const amount = payloadBytes * 2;
      for (;;) {
        check(signal);
        if (expected.has(index) && payloadBytes > expected.get(index)) throw new Error('分片正文超过声明大小');
        const previous = held.get(index) || 0, projected = used - previous + amount;
        if (fitsFutureHeads(index, projected)) {
          used = projected; held.set(index, amount); peak = Math.max(peak, used);
          if (amount < previous) notify();
          return;
        }
        await new Promise((resolve, reject) => {
          const wake = () => { waiting.delete(wake); signal?.removeEventListener('abort', abort); resolve(); };
          const abort = () => { waiting.delete(wake); reject(signal.reason || new DOMException('下载已取消', 'AbortError')); };
          waiting.add(wake); signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    }
    function release(index) { used -= held.get(index) || 0; held.delete(index); expected.delete(index); notify(); }
    return { reserve, release, setExpectedSize, advance(index) { head = index; notify(); }, drain() { head = null; notify(); },
      stats() { return { reservedBytes: used, peakReservedBytes: peak, budgetBytes: budget, waiting: waiting.size }; } };
  }
  return { createBuffer };
});
