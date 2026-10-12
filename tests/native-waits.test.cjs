const test = require('node:test');
const assert = require('node:assert/strict');
const { nativeWaitCapture } = require('../viewer/src/native-waits.ts');
const { graphCapture } = require('../viewer/src/graphs.ts');

function capture(rows, channels = 4096) {
  return {
    duration: 100,
    document: { configuration: { channels } },
    blocks: [],
    async *waits(start, end) {
      yield* rows.filter(r => r.start < end && r.start + r.duration > start);
    },
    async nativeModules() {
      return [{ base: 0x1000n, size: 0x100n, path: 'G:\\Game\\isaac.exe' }];
    },
  };
}
const row = (start, duration, kind = 1, caller = '0x1010', thread = 7) =>
  ({ start, duration, kind, caller, thread, requestedMs: 1, result: 0 });

test('native wait analysis clips overlaps but retains full longest spans and module offsets', async () => {
  const result = await nativeWaitCapture(capture([
    row(5, 10), row(15, 2), row(18, 10, 3, '0x2000', 8), row(0, 5), row(20, 5),
  ]), 10, 20, 1);
  assert.equal(result.count, 3);
  assert.equal(result.wall, 9);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].duration, 10);
  assert.equal(result.rows[0].callSite, 'isaac.exe+0x10');
  assert.deepEqual(result.groups.map(g => [g.api, g.count, g.wall]),
    [['Sleep', 2, 7], ['WaitForSingleObject', 1, 2]]);
  assert.equal(result.callers[0].count, 2);
  assert.match(result.limitation, /must not be added/);
});

test('wait top-N pruning preserves aggregate totals and resolves unknown callers safely', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(i, i / 10 + .1, 2, '0x2000'));
  const result = await nativeWaitCapture(capture(rows), 0, 100, 3);
  assert.equal(result.count, 50);
  assert.deepEqual(result.rows.map(r => r.start), [49, 48, 47]);
  assert.equal(result.rows[0].callSite, '0x2000');
  assert.equal(result.callers[0].count, 50);
});

test('missing wait channel and invalid range/budget are explicit', async () => {
  assert.equal((await nativeWaitCapture(capture([], 0), 0, 100)).available, false);
  assert.equal((await nativeWaitCapture(capture([]), 0, 100)).available, true);
  for (const [start, end, limit] of [[-1, 10, 1], [0, 101, 1], [5, 5, 1], [0, 10, 0], [0, 10, 501]]) {
    await assert.rejects(nativeWaitCapture(capture([]), start, end, limit), /Invalid/);
  }
});

test('wait graph preserves sparse long spans separately from object waits', async () => {
  const stream = capture([row(5, 1), row(5.1, 35), row(6, 2, 3), row(70, 1)]);
  const result = await graphCapture(stream, 'waits-ms', 0, 100, 2);
  assert.equal(result.count, 4);
  assert.equal(result.series.length, 2);
  assert.equal(Math.max(...result.series[0].points.map(p => p.value)), 35);
  assert.equal(Math.max(...result.series[1].points.map(p => p.value)), 2);
});
