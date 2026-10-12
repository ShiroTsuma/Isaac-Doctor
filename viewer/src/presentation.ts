import type { StreamCapture } from './stream.ts';
import type { PresentationSample } from './types.ts';

export type PresentationSort =
  'start' | 'duration' | 'swap' | 'readback' | 'outside' | 'cycles';
export interface PresentationQuery {
  start: number;
  end: number;
  sort?: PresentationSort;
  descending?: boolean;
  limit?: number;
}
export interface PresentationRow extends PresentationSample {
  outside: number;
}
export interface TimingStats {
  count: number;
  mean: number;
  maximum: number;
  p50: number;
  p95: number;
  p99: number;
}
export interface PresentationResult {
  available: boolean;
  count: number;
  failed: number;
  gaps: number;
  rate: number | null;
  threads: number[];
  interval: TimingStats;
  swap: TimingStats;
  readback: TimingStats;
  outside: TimingStats;
  rows: PresentationRow[];
}

class Distribution {
  private bins = new Uint32Array(32768);
  private count = 0;
  private total = 0;
  private maximum = 0;
  add(value: number) {
    this.count++;
    this.total += value;
    this.maximum = Math.max(this.maximum, value);
    const index =
      value === 0
        ? 0
        : Math.min(
            32767,
            Math.max(
              1,
              Math.ceil(
                Math.log(Math.max(1e-6, value) / 1e-6) / Math.log(1.001),
              ) + 1,
            ),
          );
    this.bins[index]++;
  }

  result(): TimingStats {
    const percentile = (p: number) => {
      if (!this.count) {
        return 0;
      }
      const target = Math.ceil(this.count * p);
      let count = 0;
      for (let i = 0; i < this.bins.length; i++) {
        count += this.bins[i];
        if (count >= target) {
          return i === 0 ? 0 : Math.min(this.maximum, 1e-6 * 1.001 ** (i - 1));
        }
      }
      return this.maximum;
    };
    return {
      count: this.count,
      mean: this.count ? this.total / this.count : 0,
      maximum: this.maximum,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  }
}

export async function presentationCapture(
  stream: StreamCapture,
  query: PresentationQuery,
): Promise<PresentationResult> {
  if (
    !Number.isFinite(query.start) ||
    !Number.isFinite(query.end) ||
    query.start < 0 ||
    query.end <= query.start ||
    query.end > stream.duration + 0.001
  ) {
    throw Error('Invalid presentation range.');
  }
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw Error('Presentation row limit must be 1..500.');
  }
  const interval = new Distribution();
  const swap = new Distribution();
  const readback = new Distribution();
  const outside = new Distribution();
  const rows: PresentationRow[] = [];
  const threads = new Set<number>();
  const previous = new Map<number, number>();
  let count = 0;
  let failed = 0;
  let gaps = 0;
  const sort = query.sort ?? 'duration';
  if (
    !['start', 'duration', 'swap', 'readback', 'outside', 'cycles'].includes(
      sort,
    )
  ) {
    throw Error('Invalid presentation sort.');
  }
  const order = (a: PresentationRow, b: PresentationRow) =>
    ((query.descending ?? true) ? -1 : 1) *
      ((a[sort] ?? -1) - (b[sort] ?? -1)) ||
    a.start - b.start ||
    a.thread - b.thread ||
    a.id - b.id;
  for await (const record of stream.presentations(query.start, query.end)) {
    // Statistics use complete intervals selected by start, like the frame view.
    if (
      record.start < query.start ||
      record.start + record.duration > query.end + 0.0001
    ) {
      continue;
    }
    count++;
    if (!record.success) {
      failed++;
    }
    threads.add(record.thread);
    const last = previous.get(record.thread);
    if (last !== undefined && record.id > last + 1) {
      gaps += record.id - last - 1;
    }
    previous.set(record.thread, record.id);
    const other = Math.max(0, record.duration - record.swap - record.readback);
    interval.add(record.duration);
    swap.add(record.swap);
    readback.add(record.readback);
    outside.add(other);
    rows.push({ ...record, outside: other });
    if (rows.length >= limit * 2) {
      rows.sort(order);
      rows.length = limit;
    }
  }
  rows.sort(order);
  rows.length = Math.min(rows.length, limit);
  const stats = interval.result();
  return {
    available: stream.blocks.some((b) => b.type === 16),
    count,
    failed,
    gaps,
    rate: count && threads.size === 1 ? 1000 / stats.mean : null,
    threads: [...threads],
    interval: stats,
    swap: swap.result(),
    readback: readback.result(),
    outside: outside.result(),
    rows,
  };
}
export interface PresentationWindow {
  available: boolean;
  count: number;
  coverage: number;
  swap: number;
  readback: number;
  rows: PresentationSample[];
}
export async function presentationWindow(
  stream: StreamCapture,
  start: number,
  end: number,
  thread: number,
): Promise<PresentationWindow> {
  const rows: PresentationSample[] = [];
  let coverage = 0;
  let swap = 0;
  let readback = 0;
  const overlap = (time: number, duration: number) =>
    Math.max(0, Math.min(end, time + duration) - Math.max(start, time));
  for await (const record of stream.presentations(start, end)) {
    if (record.thread !== thread) {
      continue;
    }
    coverage += overlap(record.start, record.duration);
    swap += overlap(record.swapStart, record.swap);
    readback += overlap(record.readbackStart, record.readback);
    rows.push(record);
    if (rows.length > 10000) {
      throw Error(
        'Presentation window exceeds 10,000 intervals; narrow the range.',
      );
    }
  }
  return {
    available: stream.blocks.some((b) => b.type === 16),
    count: rows.length,
    coverage,
    swap,
    readback,
    rows,
  };
}
