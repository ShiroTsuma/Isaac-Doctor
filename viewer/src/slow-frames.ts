import { FrameReferenceIndex } from './frame-reference.ts';
import type { FrameInterval, Metric, Telemetry } from './types.ts';
export interface IntervalCost {
  self: number;
  calls: number;
}
export interface AttributedInterval extends FrameInterval {
  self: number;
  calls: number;
  metrics: Map<number, IntervalCost>;
  boundaryCrossingCalls: number;
}

/** Observed deltas against matched references; never labels a mod as the cause. */
export function slowFrameComparisons(
  frames: AttributedInterval[],
  observations: FrameInterval[],
  telemetry: Telemetry,
  metrics: Map<number, Metric>,
  p95: number | null,
  top = 10,
  index = new FrameReferenceIndex([...frames, ...observations], telemetry),
) {
  const costs = new Map<FrameInterval, AttributedInterval>(frames.map((f) => [f, f]));
  const slow = frames
      .filter((f) => p95 !== null && f.duration >= p95)
      .sort((a, b) => b.duration - a.duration || a.start - b.start),
    selected = slow.slice(0, 500);
  const recurrent = new Map<
    number,
    { count: number; total: number; max: number; calls: number; baselineCalls: number }
  >();
  let matched = 0,
    contextMatched = 0,
    extraWall = 0,
    extraSelf = 0,
    crossing = 0;
  const details = selected.map((frame) => {
    const reference = index.match(frame),
      base = reference.frames.map((f) => costs.get(f)!),
      n = base.length;
    if (!n) return { frame, reference, comparison: null };
    matched++;
    if (reference.quality === 'context-matched') contextMatched++;
    const baselineSelf = base.reduce((s, f) => s + f.self, 0) / n,
      wallDelta = frame.duration - reference.meanWall!,
      selfDelta = frame.self - baselineSelf;
    extraWall += wallDelta;
    extraSelf += selfDelta;
    crossing += frame.boundaryCrossingCalls;
    const referenceCosts = new Map<number, IntervalCost>();
    for (const f of base)
      for (const [id, c] of f.metrics) {
        const old = referenceCosts.get(id) ?? { self: 0, calls: 0 };
        old.self += c.self / n;
        old.calls += c.calls / n;
        referenceCosts.set(id, old);
      }
    const increases = [...frame.metrics]
      .map(([id, c]) => {
        const b = referenceCosts.get(id) ?? { self: 0, calls: 0 },
          m = metrics.get(id)!,
          delta = c.self - b.self;
        // 50 µs is an analysis reporting threshold, not a capture/view filter.
        if (delta >= 0.05) {
          const old = recurrent.get(id) ?? {
            count: 0,
            total: 0,
            max: 0,
            calls: 0,
            baselineCalls: 0,
          };
          old.count++;
          old.total += delta;
          old.max = Math.max(old.max, delta);
          old.calls += c.calls;
          old.baselineCalls += b.calls;
          recurrent.set(id, old);
        }
        return {
          metric_id: id,
          mod: m.mod,
          hook: m.callback_name || m.callback_id,
          source: m.source,
          line: m.line,
          self_ms: c.self,
          reference_self_ms: b.self,
          extra_self_ms: delta,
          calls: c.calls,
          reference_calls: b.calls,
        };
      })
      .filter((c) => c.extra_self_ms > 0)
      .sort((a, b) => b.extra_self_ms - a.extra_self_ms)
      .slice(0, top);
    return {
      frame,
      reference,
      comparison: {
        reference_self_ms: baselineSelf,
        extra_wall_ms: wallDelta,
        extra_callback_self_ms: selfDelta,
        extra_unattributed_wall_ms: wallDelta - selfDelta,
        boundary_crossing_calls: frame.boundaryCrossingCalls,
        callback_increases: increases,
      },
    };
  });
  const recurring = [...recurrent]
    .filter(([, r]) => r.count >= 3)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, top)
    .map(([id, r]) => {
      const m = metrics.get(id)!;
      return {
        metric_id: id,
        mod: m.mod,
        hook: m.callback_name || m.callback_id,
        source: m.source,
        line: m.line,
        affected_intervals: r.count,
        matched_slow_intervals: matched,
        total_extra_self_ms: r.total,
        mean_extra_self_ms_when_present: r.total / r.count,
        maximum_extra_self_ms: r.max,
        mean_calls_when_present: r.calls / r.count,
        reference_mean_calls_when_present: r.baselineCalls / r.count,
      };
    });
  return {
    slow_intervals: slow.length,
    analyzed_intervals: selected.length,
    matched_intervals: matched,
    context_matched_intervals: contextMatched,
    unmatched_intervals: selected.length - matched,
    reference_limit: 5,
    slow_interval_limit: 500,
    recurrence_minimum_intervals: 3,
    recurrence_minimum_extra_self_us: 50,
    mean_extra_wall_ms: matched ? extraWall / matched : null,
    mean_extra_callback_self_ms: matched ? extraSelf / matched : null,
    mean_extra_unattributed_wall_ms: matched ? (extraWall - extraSelf) / matched : null,
    boundary_crossing_calls: crossing,
    recurring_callback_increases: recurring,
    slowest_intervals: details.slice(0, top).map(({ frame, reference, comparison }) => ({
      id: frame.id,
      start_ms: frame.start,
      duration_ms: frame.duration,
      thread: frame.thread,
      callback_self_ms: frame.self,
      calls: frame.calls,
      has_update: reference.hasUpdate,
      reference: {
        quality: reference.quality,
        reason: reference.reason,
        population: reference.population,
        mean_wall_ms: reference.meanWall,
        intervals: reference.frames.map((f) => ({
          id: f.id,
          start_ms: f.start,
          duration_ms: f.duration,
        })),
        context: reference.context ?? null,
      },
      comparison,
    })),
    limitations: [
      'Worst 500 p95+ intervals only; an increase must occur in at least 3 matched intervals and exceed 50 µs to enter the recurring ranking.',
      'References are up to 5 intervals near the median of the neighborhood excluding the upper duration decile, within 5 seconds, same clock/thread/update activity and transition segment.',
      'Recorded context is at most 500 ms old; room/layout/enemies match, entity counts differ by at most 2 or 10%. Missing context permits a weaker clock-only comparison; stale context does not.',
      'Differences are observational. Callback self includes native API work and waiting; unattributed wall is not an engine, GPU or GC measurement.',
      'Start-based attribution retains full self time for calls crossing interval boundaries. Selected capture scope, filtering and losses can hide costs.',
    ],
  };
}
