const test = require('node:test');
const assert = require('node:assert/strict');
const { jobExplanation, concurrencyReason, jobConcurrency } = require('../ui/explain.js');
const { formatSize, mediaUrl, formatRemaining } = require('../ui/format.js');

test('saving remains unconfirmed even after every segment has downloaded', () => {
  const job = { isM3U8: true, state: 'saving', completedSegments: 12, totalSegments: 12 };
  assert.match(jobExplanation(job).phase, /等待 Chrome 确认/);
  assert.match(jobExplanation(job).result, /尚未确认/);
  assert.match(jobExplanation(job).order, /并行获取 → 按序合并/);
  job.state = 'complete';
  assert.match(jobExplanation(job).result, /已保存/);
});

test('task explanation preserves broker reasons and separates HLS scheduling from Chrome direct downloads', () => {
  const waiting = jobExplanation({ isM3U8: true, state: 'queued', queuePosition: 2 });
  assert.match(waiting.phase, /排队第 2 位/);
  assert.match(waiting.concurrency, /视频任务逐个处理/);
  assert.equal(jobExplanation({ state: 'interrupted', stateReason: '浏览器会话已结束，请重新下载。' }).phase, '浏览器会话已结束，请重新下载。');
  const direct = jobExplanation({ state: 'downloading', isM3U8: false });
  assert.match(direct.concurrency, /由 Chrome 管理/);
  assert.doesNotMatch(direct.order, /分片|合并/);
});

test('presentation helpers reject non-network addresses and invalid sizes', () => {
  for (const url of ['javascript:alert(1)', 'blob:https://video.test/id', 'file:///video.mp4']) assert.equal(mediaUrl(url), null);
  assert.equal(mediaUrl('https://video.test/a.mp4').hostname, 'video.test');
  assert.equal(formatSize(Infinity), '0 B');
  assert.equal(formatSize(1536), '1.5 KB');
});

test('quality explanation only reports a selection actually supplied by the engine', () => {
  assert.equal(jobExplanation({ isM3U8: true, state: 'parsing' }).quality, '');
  const reason = '较高档位未通过准备：返回内容不是有效的 m3u8 播放清单';
  assert.equal(jobExplanation({ isM3U8: true, qualityLabel: '2400000 bps · 第 2/3 档', qualityReason: reason }).quality,
    `2400000 bps · 第 2/3 档。${reason}`);
});

test('remaining time rounds small positive estimates up and never formats unknown as zero', () => {
  for (const seconds of [undefined, null, NaN, Infinity, -1, 0]) assert.equal(formatRemaining(seconds), '');
  assert.equal(formatRemaining(0.2), '1 秒');
  assert.equal(formatRemaining(124), '2 分 4 秒');
  assert.equal(formatRemaining(3601), '1 小时 1 分');
});

test('manual concurrency displays the live target without an environment judgment', () => {
  for (const value of [1, 64, 375]) {
    const job = { state: 'downloading', isM3U8: true, targetConcurrency: value, networkEnvironment: 'server-limited', decisionReason: 'rate-limited' };
    assert.equal(jobConcurrency(job), value);
    const explanation = jobExplanation(job);
    assert.match(explanation.concurrency, new RegExp(`并发 ${value}`));
    assert.match(explanation.concurrency, /请求并行，文件按序写入/);
    for (const key of ['measured', 'requests', 'buffering', 'adjustment']) assert.equal(key in explanation, false);
    assert.doesNotMatch(Object.values(explanation).join(' '), /探测|环境|调节判断|限速|吞吐增益/);
  }
  assert.equal(jobConcurrency({ concurrency: 96 }), 96);
  assert.equal(jobConcurrency({ activeConcurrency: 32 }), 32);
  assert.equal(concurrencyReason({ decisionReason: 'no-gain' }), '请求并行，文件按序写入。');
});

test('queued HLS shows its latest desired concurrency while terminal zero remains inactive', () => {
  const job = { isM3U8: true, state: 'queued', targetConcurrency: 0, concurrency: 96 };
  assert.equal(jobConcurrency(job), 96);
  assert.match(jobExplanation(job).concurrency, /并发 96/);
  job.concurrency = 375;
  assert.equal(jobConcurrency(job), 375);
  job.targetConcurrency = 120;
  assert.equal(jobConcurrency(job), 120, 'A positive current target takes precedence');
  for (const state of ['complete', 'interrupted', 'cancelled']) {
    Object.assign(job, { state, targetConcurrency: 0 });
    assert.equal(jobConcurrency(job), null);
    assert.doesNotMatch(jobExplanation(job).concurrency, /并发 \d/);
  }
});

test('invalid concurrency is never presented as a task setting', () => {
  for (const value of [0, 376, -1, 1.5, NaN, Infinity, '64']) {
    const job = { isM3U8: true, targetConcurrency: value };
    assert.equal(jobConcurrency(job), null);
    assert.doesNotMatch(jobExplanation(job).concurrency, /并发 \d/);
  }
});
