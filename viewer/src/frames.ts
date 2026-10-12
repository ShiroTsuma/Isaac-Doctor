import type {
  FrameInterval,
  FrameQuery,
  FrameResults,
  FrameRow,
  Metric,
  TraceEvent,
} from './types.ts';
import type { FrameSummary } from './analysis-cache.ts';

// Fixed memory histogram: percentile upper bounds have <=0.1% relative error.
// Native QPC durations are kept intact in the file; only summary quantiles are binned.
const ratio = 1.001,
  logRatio = Math.log(ratio),
  minimum = 1e-6;
export async function frameResults(
  intervals: AsyncIterable<FrameInterval>,
  events: (start: number, end: number) => AsyncIterable<TraceEvent>,
  metrics: Map<number, Metric>,
  query: FrameQuery,
  incomplete: boolean,
  summary?: FrameSummary,
  visitEvents?: (
    start: number,
    end: number,
    visit: (event: TraceEvent) => void,
    ranges: [number, number][],
  ) => Promise<void>,
  candidateLimit = 500,
): Promise<FrameResults> {
  const bins = new Float64Array(32768),
    candidates: FrameRow[] = [];
  let count = 0,
    slow = 0,
    total = 0,
    maximum = 0;
  for await (const f of intervals) {
    if (f.kind !== query.kind || f.start < query.start || f.start >= query.end) continue;
    count++;
    total += f.duration;
    maximum = Math.max(maximum, f.duration);
    if (!summary)
      bins[
        Math.min(
          bins.length - 1,
          Math.max(0, Math.ceil(Math.log(Math.max(minimum, f.duration) / minimum) / logRatio)),
        )
      ]++;
    if (f.duration * 1000 < query.minimumUs) continue;
    slow++;
    candidates.push({
      ...f,
      calls: 0,
      self: 0,
      worstMod: '',
      modSelf: 0,
      worstMetric: null,
      metricSelf: 0,
    });
    if (candidates.length >= candidateLimit * 2) {
      candidates.sort((a, b) => b.duration - a.duration || a.start - b.start);
      candidates.length = candidateLimit;
    }
  }
  candidates.sort((a, b) => b.duration - a.duration || a.start - b.start);
  candidates.length = Math.min(candidates.length, candidateLimit);
  // The Cartesian product of 500 intervals and thousands of registered metrics
  // used to exceed 200k counters. Bound only live counters, release each batch.
  const batchSize = Math.max(1, Math.min(32, Math.floor(200000 / Math.max(1, metrics.size))));
  const chronological = candidates.slice().sort((a, b) => a.start - b.start);
  for (let at = 0; at < chronological.length; at += batchSize) {
    const batch = chronological.slice(at, at + batchSize),
      byThread = new Map<number, FrameRow[]>(),
      totals = new Map<FrameRow, Map<number, number>>();
    for (const f of batch) {
      if (!byThread.has(f.thread)) byThread.set(f.thread, []);
      byThread.get(f.thread)!.push(f);
      totals.set(f, new Map());
    }
    const start = Math.min(...batch.map((f) => f.start)),
      end = Math.max(...batch.map((f) => f.start + f.duration));
    const consume = (e: TraceEvent) => {
      const rows = byThread.get(e.thread);
      if (!rows) return;
      let low = 0,
        high = rows.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (rows[mid].start <= e.start) low = mid + 1;
        else high = mid;
      }
      const f = rows[low - 1];
      if (!f || e.start >= f.start + f.duration) return;
      const m = metrics.get(e.metric);
      if (!m) return;
      f.calls++;
      f.self += e.self;
      const t = totals.get(f)!;
      t.set(e.metric, (t.get(e.metric) ?? 0) + e.self);
    };
    if (visitEvents)
      await visitEvents(
        start,
        end,
        consume,
        batch.map((f) => [f.start, f.start + f.duration]),
      );
    else for await (const e of events(start, end)) consume(e);
    for (const f of batch) {
      const mods = new Map<string, number>();
      for (const [id, self] of totals.get(f)!) {
        const m = metrics.get(id)!;
        mods.set(m.mod, (mods.get(m.mod) ?? 0) + self);
        if (f.worstMetric === null || self > f.metricSelf) {
          f.worstMetric = id;
          f.metricSelf = self;
        }
      }
      for (const [mod, self] of mods)
        if (!f.worstMod || self > f.modSelf) {
          f.worstMod = mod;
          f.modSelf = self;
        }
    }
  }
  function percentile(p: number) {
    if (!count) return 0;
    const target = Math.ceil(count * p);
    let sum = 0;
    for (let i = 0; i < bins.length; i++) {
      sum += bins[i];
      if (sum >= target) return Math.min(maximum, minimum * Math.pow(ratio, i));
    }
    return maximum;
  }
  const search = query.search.trim().toLowerCase();
  return {
    rows: candidates.filter(
      (f) =>
        !search ||
        `${f.worstMod} ${metrics.get(f.worstMetric ?? 0)?.callback_name ?? ''}`
          .toLowerCase()
          .includes(search),
    ),
    count,
    slow,
    mean: count ? total / count : 0,
    rate: total ? (count * 1000) / total : 0,
    p50: summary?.p50 ?? percentile(0.5),
    p95: summary?.p95 ?? percentile(0.95),
    p99: summary?.p99 ?? percentile(0.99),
    maximum,
    incomplete,
    ...summary,
  };
}
