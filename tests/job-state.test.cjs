const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../engine/job-state.js');

test('the shared segment limit permits the complete1..375 slider range', () => {
  assert.equal(state.LIMITS.segments, 375);
  assert.equal(Object.isFrozen(state.LIMITS), true);
});

test('job snapshots can skip observed phases but never move backwards or reopen a terminal attempt', () => {
  assert.equal(state.canAdvance('queued', 'saving'), true);
  assert.equal(state.canAdvance('saving', 'downloading'), false);
  assert.equal(state.canAdvance('interrupted', 'queued'), false);
  assert.equal(state.canAdvance('complete', 'cancelled'), false);
  assert.equal(state.canAdvance('downloading', 'complete'), true); // Chrome evidence is checked by broker.
});

test('new attempts accept only matching, increasing protocol revisions', () => {
  const job = { runId: 'new', state: 'downloading', progressRevision: 5 };
  for (const incoming of [
    { runId: 'old', revision: 10, state: 'interrupted' },
    { runId: 'new', revision: 5, state: 'downloading' },
    { runId: 'new', revision: 6, state: 'queued' },
    { revision: 6, state: 'saving' }
  ]) assert.equal(state.accepts(job, incoming), false);
  assert.equal(state.accepts(job, { runId: 'new', revision: 6, state: 'saving' }), true);
  assert.equal(state.accepts({ state: 'downloading' }, { state: 'saving' }), true, 'Legacy worker snapshots can migrate');
});

test('each public state has a user-readable execution explanation', () => {
  for (const value of state.STATES) assert.ok(state.describe({ state: value, isM3U8: true }).length > 3);
  assert.match(state.describe({ state: 'downloading', isM3U8: true }), /并行.*顺序/);
  assert.match(state.describe({ state: 'saving' }), /等待 Chrome/);
});
