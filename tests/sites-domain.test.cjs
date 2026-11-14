'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sites = require('../domain/sites.js');
const bili = require('../domain/bilibili.js');

test('ordinary Bilibili BV and av identities preserve exactly the current part', () => {
  for (const id of ['BV13x41117TL', 'av1074402']) {
    for (const host of ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com']) {
      assert.deepEqual(bili.parse(`http://${host}/video/${id}?p=2&spm_id_from=tracking`), {
        videoId: id, page: 2, url: `https://www.bilibili.com/video/${id}/?p=2`
      });
      assert.equal(bili.parse(`https://${host}/video/${id}/`).url, `https://www.bilibili.com/video/${id}/?p=1`);
    }
  }
  assert.equal(sites.parse('https://www.bilibili.com/video/BV13x41117TL?p=3').engine, 'bilibili-native');
});

test('Bilibili accepts only explicit official Chinese locale prefixes and normalizes the current part', () => {
  for (const locale of ['zh-Hans', 'zh-Hant']) {
    assert.equal(bili.parse(`https://www.bilibili.com/${locale}/video/BV1bK411W797/?p=2`).url,
      'https://www.bilibili.com/video/BV1bK411W797/?p=2');
  }
  for (const prefix of ['arbitrary', 'en-US', 'zh', 'zh-hans', 'zh-Hans/extra']) {
    assert.equal(bili.parse(`https://www.bilibili.com/${prefix}/video/BV1bK411W797/?p=2`), null);
  }
});

test('Bilibili rejects unsupported pages, spoofed origins, malformed IDs and ambiguous parts', () => {
  for (const url of [
    'https://bilibili.com.evil.test/video/BV13x41117TL', 'https://bilibili.com@evil.test/video/BV13x41117TL',
    'https://user@www.bilibili.com/video/BV13x41117TL', 'https://www.bilibili.com:1234/video/BV13x41117TL',
    'https://www.bilibili.com/video/BVshort', 'https://www.bilibili.com/video/av0', 'https://www.bilibili.com/video/av9007199254740992',
    'https://www.bilibili.com/video/BV13x41117TL/extra', 'https://www.bilibili.com/video/BV13x41117TL%2F',
    'https://www.bilibili.com/bangumi/play/ep123', 'https://live.bilibili.com/123',
    'https://www.bilibili.com/medialist/play/123', 'https://space.bilibili.com/123/lists/456',
    'https://www.bilibili.com/list/123?sid=456', 'https://www.bilibili.com/festival/test?bvid=BV13x41117TL',
    'https://b23.tv/abc', 'blob:https://www.bilibili.com/123', '', null
  ]) assert.equal(bili.parse(url), null, url);
  for (const page of ['0', '-1', '1.5', '1e2', '', '01', '9007199254740992', '2&p=3']) {
    assert.equal(bili.parse(`https://www.bilibili.com/video/BV13x41117TL?p=${page}`), null, page);
  }
});

test('registry is independently requireable and isolates native job sites and cookie domains', () => {
  assert.equal(sites.parse('https://youtu.be/BaW_jenozKc').site, 'youtube');
  assert.equal(sites.isNativeJob({ engine: 'youtube-native' }), true, 'Legacy YouTube jobs remain supported');
  assert.equal(sites.forJob({ engine: 'bilibili-native', site: 'bilibili' }).label, 'B站');
  assert.equal(sites.forJob({ engine: 'youtube-native', site: 'bilibili' }), null);
  assert.equal(sites.forJob({ engine: 'bilibili-native', url: 'https://youtu.be/BaW_jenozKc' }), null);
  assert.equal(sites.forJob({ site: 'bilibili' }), null);
  assert.equal(sites.get('evil'), null);
  assert.deepEqual(sites.get('bilibili').cookieDomains, ['bilibili.com', '.bilibili.com']);
  assert.equal(sites.get('bilibili').cookieQueryDomain, 'bilibili.com');
  assert.deepEqual(sites.get('youtube').cookieDomains, ['youtube.com', '.youtube.com']);
  assert.equal(Object.isFrozen(sites.get('bilibili').cookieDomains), true);
});

test('transport filtering removes known Bilibili tracks without suppressing ordinary CDN videos', () => {
  for (const url of ['https://xy.bilivideo.com/upgcxcode/123/123-1-30080.m4s?deadline=1',
    'https://xy.bilivideo.cn/path/audio.m4s', 'https://xy.hdslb.com/upgcxcode/123/segment.ts',
    'https://rr1.googlevideo.com/videoplayback?range=0-99']) assert.equal(sites.isTransport(url), true, url);
  for (const url of ['https://xy.bilivideo.com/ordinary.mp4', 'https://xy.hdslb.com/ordinary.flv', 'https://xy.hdslb.com/ordinary.ts',
    'https://bilivideo.com.evil.test/path/segment.m4s', 'https://cdn.test/path/segment.m4s']) assert.equal(sites.isTransport(url), false, url);
});

test('site-specific titles trim service suffixes without crossing website identities', () => {
  assert.equal(sites.cleanTitle('中文教程_哔哩哔哩_bilibili', 'bilibili'), '中文教程');
  assert.equal(sites.cleanTitle('中文教程 - bilibili', 'bilibili'), '中文教程');
  assert.equal(sites.cleanTitle('', 'bilibili'), 'B站视频');
  assert.equal(sites.cleanTitle('中文教程 - YouTube', 'youtube'), '中文教程');
  assert.equal(sites.cleanTitle('YouTube 教程', 'bilibili'), 'YouTube 教程');
  assert.equal(sites.cleanTitle('认识bilibili', 'bilibili'), '认识bilibili');
});
