'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const youtube = require('../domain/youtube.js');

test('YouTube identity canonicalizes one video without playlist or tracking parameters', () => {
  const id = 'BaW_jenozKc';
  for (const value of [
    `https://www.youtube.com/watch?v=${id}&list=ignored&index=3&t=20`,
    `https://youtube.com/watch?v=${id}`,
    `https://m.youtube.com/shorts/${id}?feature=share`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=tracking`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`
  ]) assert.deepEqual(youtube.parse(value), { videoId: id, url: `https://www.youtube.com/watch?v=${id}` });
});

test('YouTube identity rejects spoofed hosts, credentials, ports, playlists and ambiguous IDs', () => {
  for (const value of [
    'https://youtube.com.evil.test/watch?v=BaW_jenozKc',
    'https://youtube.com@evil.test/watch?v=BaW_jenozKc',
    'https://user@www.youtube.com/watch?v=BaW_jenozKc',
    'https://www.youtube.com:9999/watch?v=BaW_jenozKc',
    'https://evil.test/?next=https://youtube.com/watch?v=BaW_jenozKc',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=BaW_jenozKc&v=aqz-KE-bpKQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=BaW_jenozKc%2F',
    'https://youtu.be/BaW_jenozKc/extra',
    'blob:https://www.youtube.com/anything',
    'javascript:alert(1)', null, ''
  ]) assert.equal(youtube.parse(value), null, value);
});

test('transport detection excludes googlevideo ranges without matching lookalike domains', () => {
  assert.equal(youtube.isTransport('https://rr1---sn-test.googlevideo.com/videoplayback?itag=137&range=0-99'), true);
  assert.equal(youtube.isTransport('https://googlevideo.com/videoplayback?source=youtube'), true);
  assert.equal(youtube.isTransport('https://googlevideo.com.evil.test/videoplayback'), false);
  assert.equal(youtube.isTransport('https://cdn.test/videoplayback?source=googlevideo.com'), false);
  assert.equal(youtube.isTransport('https://cdn.test/movie.mp4'), false);
});

test('YouTube title cleanup removes only the service suffix and keeps Chinese text', () => {
  assert.equal(youtube.cleanTitle('小羊的视频 - YouTube'), '小羊的视频');
  assert.equal(youtube.cleanTitle('YouTube 教程 — 第一期'), 'YouTube 教程 — 第一期');
  assert.equal(youtube.cleanTitle(''), 'YouTube 视频');
});
