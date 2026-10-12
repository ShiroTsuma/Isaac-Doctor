import type { FrameInterval, Metric, TraceEvent } from './types.ts';

export const analysisVersion = 2;
export const overviewColumns = 4096,
  overviewLimit = 200000;
export interface Overview {
  columns: number;
  events: TraceEvent[];
}
const histogramSize = 32768,
  ratio = 1.001,
  logRatio = Math.log(ratio),
  floor = 1e-6;
export interface Totals {
  id: number;
  calls: number;
  errors: number;
  inclusive: number;
  exclusive: number;
  maximum: number;
}
export interface FrameTotals {
  count: number;
  total: number;
  maximum: number;
  histogram: Float64Array;
}
export interface AnalysisTile {
  metrics: Map<number, Totals>;
  frames: [FrameTotals, FrameTotals];
}
export interface AnalysisCache {
  duration: number;
  bins: Float64Array;
  quarters: AnalysisTile[];
  summaries: Map<string, FrameSummary>;
  overview?: Overview;
}
export interface FrameSummary {
  count: number;
  mean: number;
  rate: number;
  maximum: number;
  p50: number;
  p95: number;
  p99: number;
}
function clock(): FrameTotals {
  return { count: 0, total: 0, maximum: 0, histogram: new Float64Array(histogramSize) };
}
function tile(): AnalysisTile {
  return { metrics: new Map(), frames: [clock(), clock()] };
}
export function quarterRange(
  start: number,
  end: number,
  duration: number,
): [number, number] | null {
  if (!duration) return null;
  const a = (start / duration) * 4,
    b = (end / duration) * 4;
  const left = Math.round(a),
    right = Math.round(b);
  return Math.abs(a - left) < 1e-9 &&
    Math.abs(b - right) < 1e-9 &&
    left >= 0 &&
    right <= 4 &&
    left < right
    ? [left, right]
    : null;
}
export async function prepareAnalysis(
  duration: number,
  events: AsyncIterable<TraceEvent>,
  intervals: AsyncIterable<FrameInterval>,
  bins: Float64Array,
): Promise<AnalysisCache> {
  const quarters = Array.from({ length: 4 }, tile);
  let entries = 0;
  for await (const e of events) {
    const q =
      quarters[Math.min(3, Math.max(0, Math.floor((e.start / Math.max(duration, 1e-9)) * 4)))];
    let m = q.metrics.get(e.metric);
    if (!m) {
      if (++entries > 400000) throw Error('Analysis cache exceeds the callback limit.');
      m = { id: e.metric, calls: 0, errors: 0, inclusive: 0, exclusive: 0, maximum: 0 };
      q.metrics.set(e.metric, m);
    }
    m.calls++;
    m.errors += +e.error;
    m.inclusive += e.duration;
    m.exclusive += e.self;
    m.maximum = Math.max(m.maximum, e.duration);
  }
  for await (const f of intervals) {
    const q =
        quarters[Math.min(3, Math.max(0, Math.floor((f.start / Math.max(duration, 1e-9)) * 4)))],
      s = q.frames[f.kind - 1];
    s.count++;
    s.total += f.duration;
    s.maximum = Math.max(s.maximum, f.duration);
    s.histogram[
      Math.min(
        histogramSize - 1,
        Math.max(0, Math.ceil(Math.log(Math.max(floor, f.duration) / floor) / logRatio)),
      )
    ]++;
  }
  const result: AnalysisCache = { duration, bins: bins.slice(), quarters, summaries: new Map() };
  for (const range of [
    [0, 4],
    [0, 2],
    [2, 4],
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ] as [number, number][])
    for (const kind of [1, 2] as const) cachedFrames(result, range, kind);
  return result;
}
export function cachedMetrics(
  cache: AnalysisCache,
  range: [number, number],
  metrics: Map<number, Metric>,
): Metric[] {
  const totals = new Map<number, Totals>();
  for (const q of cache.quarters.slice(...range))
    for (const m of q.metrics.values()) {
      let t = totals.get(m.id);
      if (!t) {
        t = { ...m };
        totals.set(m.id, t);
      } else {
        t.calls += m.calls;
        t.errors += m.errors;
        t.inclusive += m.inclusive;
        t.exclusive += m.exclusive;
        t.maximum = Math.max(t.maximum, m.maximum);
      }
    }
  return [...totals.values()].map((t) => ({
    ...metrics.get(t.id)!,
    calls: t.calls,
    errors: t.errors,
    inclusive_ns: t.inclusive * 1e6,
    exclusive_ns: t.exclusive * 1e6,
    max_ns: t.maximum * 1e6,
    mean_ns: t.calls ? (t.inclusive / t.calls) * 1e6 : 0,
  }));
}
export function cachedFrames(
  cache: AnalysisCache,
  range: [number, number],
  kind: 1 | 2,
): FrameSummary {
  const key = `${range[0]}:${range[1]}:${kind}`,
    saved = cache.summaries.get(key);
  if (saved) return saved;
  const result = clock();
  for (const q of cache.quarters.slice(...range)) {
    const f = q.frames[kind - 1];
    result.count += f.count;
    result.total += f.total;
    result.maximum = Math.max(result.maximum, f.maximum);
    for (let i = 0; i < histogramSize; i++) result.histogram[i] += f.histogram[i];
  }
  function percentile(p: number) {
    if (!result.count) return 0;
    const target = Math.ceil(result.count * p);
    let total = 0;
    for (let i = 0; i < histogramSize; i++) {
      total += result.histogram[i];
      if (total >= target) return Math.min(result.maximum, floor * Math.pow(ratio, i));
    }
    return result.maximum;
  }
  const summary = {
    count: result.count,
    mean: result.count ? result.total / result.count : 0,
    rate: result.total ? (result.count * 1000) / result.total : 0,
    maximum: result.maximum,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
  cache.summaries.set(key, summary);
  return summary;
}
export function rangePlan(
  cache: AnalysisCache | null,
  metrics: Map<number, Metric>,
  start: number,
  end: number,
) {
  const totals = new Map<number, Metric>();
  let edges: [number, number][] = [[start, end]];
  if (cache?.duration) {
    const step = cache.duration / 4,
      left = Math.max(0, Math.ceil(start / step)),
      right = Math.min(4, Math.floor(end / step));
    if (left < right) {
      for (const m of cachedMetrics(cache, [left, right], metrics)) totals.set(m.id, m);
      edges = [
        [start, left * step],
        [right * step, end],
      ].filter(([a, b]) => b > a) as [number, number][];
    }
  }
  return { totals, edges };
}
export async function rangeMetrics(
  cache: AnalysisCache | null,
  metrics: Map<number, Metric>,
  events: (start: number, end: number) => AsyncIterable<TraceEvent>,
  start: number,
  end: number,
): Promise<Metric[]> {
  const { totals, edges } = rangePlan(cache, metrics, start, end);
  for (const [a, b] of edges)
    for await (const e of events(a, b)) {
      if (e.start < a || e.start >= b) continue;
      let m = totals.get(e.metric);
      if (!m) {
        m = {
          ...metrics.get(e.metric)!,
          calls: 0,
          errors: 0,
          inclusive_ns: 0,
          exclusive_ns: 0,
          max_ns: 0,
        };
        totals.set(e.metric, m);
      }
      m.calls++;
      m.errors += +e.error;
      m.inclusive_ns += e.duration * 1e6;
      m.exclusive_ns += e.self * 1e6;
      m.max_ns = Math.max(m.max_ns, e.duration * 1e6);
    }
  return [...totals.values()].map((m) => ({
    ...m,
    mean_ns: m.calls ? m.inclusive_ns / m.calls : 0,
  }));
}
// Sparse histograms, fixed-width metric records; no JSON or source/event duplication.
export function encodeAnalysis(cache: AnalysisCache): Uint8Array<ArrayBuffer> {
  const summaries = [...cache.summaries].filter(([key]) =>
    ['0:4', '0:2', '2:4', '0:1', '1:2', '2:3', '3:4'].includes(key.slice(0, -2)),
  );
  let size = 24 + 400 * 8 + summaries.length * 72;
  for (const q of cache.quarters) {
    size += 4 + q.metrics.size * 48;
    for (const f of q.frames) size += 28 + f.histogram.reduce((n, x) => n + (x ? 12 : 0), 0);
  }
  size += 8 + (cache.overview?.events.length ?? 0) * 80;
  const bytes = new Uint8Array(size),
    v = new DataView(bytes.buffer);
  let p = 0;
  const u32 = (x: number) => {
      v.setUint32(p, x, true);
      p += 4;
    },
    u64 = (x: number) => {
      v.setBigUint64(p, BigInt(x), true);
      p += 8;
    },
    f64 = (x: number) => {
      v.setFloat64(p, x, true);
      p += 8;
    };
  f64(cache.duration);
  u32(4);
  u32(400);
  u32(summaries.length);
  u32(0);
  for (const b of cache.bins) f64(b);
  for (const [key, s] of summaries) {
    const [a, b, kind] = key.split(':').map(Number);
    u32(a);
    u32(b);
    u32(kind);
    u32(0);
    u64(s.count);
    for (const x of [s.mean, s.rate, s.maximum, s.p50, s.p95, s.p99]) f64(x);
  }
  for (const q of cache.quarters) {
    u32(q.metrics.size);
    for (const m of q.metrics.values()) {
      u32(m.id);
      u32(0);
      u64(m.calls);
      u64(m.errors);
      f64(m.inclusive);
      f64(m.exclusive);
      f64(m.maximum);
    }
    for (const f of q.frames) {
      u64(f.count);
      f64(f.total);
      f64(f.maximum);
      u32(f.histogram.reduce((n, x) => n + (x ? 1 : 0), 0));
      for (let i = 0; i < histogramSize; i++)
        if (f.histogram[i]) {
          u32(i);
          u64(f.histogram[i]);
        }
    }
  }
  u32(cache.overview?.columns ?? 0);
  u32(cache.overview?.events.length ?? 0);
  for (const e of cache.overview?.events ?? [])
    for (const value of [
      e.metric,
      e.start,
      e.duration,
      e.self,
      e.depth,
      e.thread,
      +e.error,
      e.index ?? e.span ?? 0,
      e.parent ?? 0,
      e.parentMetric ?? 0,
    ])
      f64(value);
  return bytes;
}
export function decodeAnalysis(
  bytes: ArrayBuffer,
  metrics: Map<number, Metric>,
  duration: number,
  version = analysisVersion,
): AnalysisCache {
  const v = new DataView(bytes);
  let p = 0;
  function room(n: number) {
    if (p + n > v.byteLength) throw Error('Truncated analysis cache.');
  }
  const u32 = () => {
      room(4);
      const x = v.getUint32(p, true);
      p += 4;
      return x;
    },
    u64 = () => {
      room(8);
      const x = Number(v.getBigUint64(p, true));
      p += 8;
      if (!Number.isSafeInteger(x)) throw Error('Invalid analysis counter.');
      return x;
    },
    f64 = () => {
      room(8);
      const x = v.getFloat64(p, true);
      p += 8;
      if (!Number.isFinite(x) || x < 0) throw Error('Invalid analysis timing.');
      return x;
    };
  if (f64() !== duration || u32() !== 4 || u32() !== 400)
    throw Error('Unsupported analysis layout.');
  const summaryCount = u32();
  u32();
  if (summaryCount !== 14) throw Error('Invalid analysis summary count.');
  const bins = Float64Array.from({ length: 400 }, f64),
    quarters = Array.from({ length: 4 }, tile),
    summaries = new Map<string, FrameSummary>();
  for (let i = 0; i < summaryCount; i++) {
    const a = u32(),
      b = u32(),
      kind = u32();
    u32();
    const key = `${a}:${b}:${kind}`,
      count = u64(),
      mean = f64(),
      rate = f64(),
      maximum = f64(),
      p50 = f64(),
      p95 = f64(),
      p99 = f64();
    if (
      !['0:4', '0:2', '2:4', '0:1', '1:2', '2:3', '3:4'].includes(`${a}:${b}`) ||
      (kind !== 1 && kind !== 2) ||
      summaries.has(key) ||
      p50 > p95 ||
      p95 > p99 ||
      p99 > maximum
    )
      throw Error('Invalid analysis summary.');
    summaries.set(key, { count, mean, rate, maximum, p50, p95, p99 });
  }
  for (const q of quarters) {
    const n = u32();
    if (n > 100000) throw Error('Invalid analysis callback count.');
    for (let i = 0; i < n; i++) {
      const id = u32();
      u32();
      if (!metrics.has(id) || q.metrics.has(id)) throw Error('Invalid cached metric ID.');
      const calls = u64(),
        errors = u64(),
        inclusive = f64(),
        exclusive = f64(),
        maximum = f64();
      if (errors > calls || exclusive > inclusive + 1e-6 || maximum > inclusive + 1e-6)
        throw Error('Invalid cached metric totals.');
      q.metrics.set(id, { id, calls, errors, inclusive, exclusive, maximum });
    }
    for (const f of q.frames) {
      f.count = u64();
      f.total = f64();
      f.maximum = f64();
      const n = u32();
      if (n > histogramSize) throw Error('Invalid analysis histogram.');
      let total = 0,
        last = -1;
      for (let i = 0; i < n; i++) {
        const index = u32(),
          count = u64();
        if (index <= last || index >= histogramSize || !count)
          throw Error('Invalid analysis histogram bin.');
        last = index;
        f.histogram[index] = count;
        total += count;
      }
      if (total !== f.count || f.maximum > f.total + 1e-6)
        throw Error('Invalid frame analysis totals.');
    }
  }
  let overview: Overview | undefined;
  // v1 ends here. The optional v2 tail is independently bounded and validated.
  if (version === 2) {
    const columns = u32(),
      count = u32();
    if (
      (columns !== 0 && columns !== overviewColumns) ||
      count > overviewLimit ||
      (!columns && count) ||
      v.byteLength - p !== count * 80
    )
      throw Error('Invalid timeline overview layout.');
    const events: TraceEvent[] = [];
    for (let i = 0; i < count; i++) {
      const metric = f64(),
        start = f64(),
        durationMs = f64(),
        self = f64(),
        depth = f64(),
        thread = f64(),
        error = f64(),
        index = f64(),
        parent = f64(),
        parentMetric = f64();
      if (
        !metrics.has(metric) ||
        ![metric, depth, thread, error, index, parent, parentMetric].every(Number.isSafeInteger) ||
        depth > 1024 ||
        thread > 0xffffffff ||
        error > 1 ||
        parentMetric > 0xffffffff ||
        self > durationMs ||
        start + durationMs > duration + 1e-6
      )
        throw Error('Invalid timeline overview event.');
      events.push({
        metric,
        start,
        duration: durationMs,
        self,
        depth,
        thread,
        error: !!error,
        index,
        span: index,
        parent,
        parentMetric,
      });
    }
    if (columns) overview = { columns, events };
  }
  if (p !== v.byteLength) throw Error('Unexpected analysis bytes.');
  return { duration, bins, quarters, summaries, overview };
}
