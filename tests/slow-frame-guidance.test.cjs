const test = require('node:test');
const assert = require('node:assert/strict');
const { slowFrameGuidance, framePacing } = require('../viewer/src/slow-frame-guidance.ts');

const comparison = (wall, self) => ({
  matched_intervals: 10,
  boundary_crossing_calls: 0,
  mean_extra_wall_ms: wall,
  mean_extra_callback_self_ms: self,
  mean_extra_unattributed_wall_ms: wall - self,
});

test('guidance distinguishes observed callback increases from unresolved wall without claiming a cause', () => {
  assert.equal(slowFrameGuidance(comparison(10, 8), false).status, 'callbacks');
  const outside = slowFrameGuidance(comparison(10, 1), false);
  assert.equal(outside.status, 'outside');
  assert.match(outside.next, /without disabling mods/);
  assert.equal(slowFrameGuidance(comparison(10, 5), false).status, 'mixed');
  assert.equal(slowFrameGuidance(comparison(.05, .02), false).status, 'little-extra');
  assert.equal(slowFrameGuidance(comparison(1, 4), false).status, 'redistributed');
  assert.equal(slowFrameGuidance(comparison(10, 8), true).status, 'partial');
  assert.equal(slowFrameGuidance({ ...comparison(10, 8), matched_intervals: 2 }, false).status, 'insufficient');
  assert.equal(slowFrameGuidance({ ...comparison(10, 8), boundary_crossing_calls: 1 }, false).status, 'partial');
});

test('pacing detects regular update alternation while refusing gaps and small samples', () => {
  let start = 0;
  const frames = Array.from({ length: 60 }, (_, i) => {
    const duration = i % 2 ? 23 : 10;
    const row = { start, duration, thread: 1, update: !!(i % 2) };
    start += duration;
    return row;
  });
  const pacing = framePacing(frames, true);
  assert.equal(pacing.alternating_update_pattern, true);
  assert.equal(pacing.mean_pair_ms, 33);
  assert.equal(pacing.with_update_mean_ms, 23);
  assert.equal(pacing.without_update_mean_ms, 10);
  assert.equal(pacing.alternating_pairs, 59);
  assert.equal(framePacing(frames, false).alternating_update_pattern, false);
  assert.equal(framePacing(frames.slice(0, 10), true).alternating_update_pattern, false);
  assert.equal(framePacing(frames.map(f => ({ ...f, start: f.start * 2 })), true).adjacent_pairs, 0);
  assert.equal(framePacing(frames.map((f, i) => ({ ...f, thread: i % 2 })), true).adjacent_pairs, 0);
});
