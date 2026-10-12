import { summaryCapture } from './analysis.ts';
import type { StreamCapture } from './stream.ts';
import type { CaptureInventory, Metric } from './types.ts';
import type { FrameSummary } from './analysis-cache.ts';

export interface ComparisonRow {
  key: string;
  mod: string;
  hook: string;
  source: string;
  lineA: number | null;
  lineB: number | null;
  identity: 'group' | 'same-line' | 'ordinal' | 'unmatched';
  code: 'same' | 'changed' | 'unavailable';
  callsA: number;
  callsB: number;
  selfA: number;
  selfB: number;
  meanA: number | null;
  meanB: number | null;
}
export interface Comparison {
  durationA: number;
  durationB: number;
  renderA: FrameSummary;
  renderB: FrameSummary;
  rows: ComparisonRow[];
  incomplete: boolean;
}
const localSource = (m: Metric) => {
  const source = m.source.replaceAll('\\', '/');
  const mods = source.toLowerCase().lastIndexOf('/mods/');
  return mods >= 0 ? source.slice(mods + 6) : source;
};
export function compareMetrics(
  a: Metric[],
  b: Metric[],
  inventoryA?: CaptureInventory,
  inventoryB?: CaptureInventory,
): ComparisonRow[] {
  const groups = new Map<string, { a: Metric[]; b: Metric[] }>();
  for (const [side, values] of [
    ['a', a],
    ['b', b],
  ] as const) {
    for (const m of values) {
      const key = JSON.stringify([
        m.mod,
        m.callback_name || m.callback_id,
        localSource(m),
      ]);
      let group = groups.get(key);
      if (!group) {
        group = { a: [], b: [] };
        groups.set(key, group);
      }
      group[side].push(m);
    }
  }
  const rows: ComparisonRow[] = [];
  for (const [key, g] of groups) {
    g.a.sort((x, y) => x.line - y.line || x.id - y.id);
    g.b.sort((x, y) => x.line - y.line || x.id - y.id);
    const append = (
      x: Metric | undefined,
      y: Metric | undefined,
      index: string,
      identity: ComparisonRow['identity'],
    ) => {
      const m = x ?? y!;
      const hashA =
        x &&
        inventoryA?.sources.find(
          (s) => s.mod === x.mod && s.source === x.source,
        )?.sha256;
      const hashB =
        y &&
        inventoryB?.sources.find(
          (s) => s.mod === y.mod && s.source === y.source,
        )?.sha256;
      rows.push({
        key: JSON.stringify([key, index]),
        mod: m.mod,
        hook: m.callback_name || m.callback_id,
        source: localSource(m),
        lineA: x?.line ?? null,
        lineB: y?.line ?? null,
        identity,
        code:
          hashA && hashB
            ? hashA === hashB
              ? 'same'
              : 'changed'
            : 'unavailable',
        callsA: x?.calls ?? 0,
        callsB: y?.calls ?? 0,
        selfA: (x?.exclusive_ns ?? 0) / 1e6,
        selfB: (y?.exclusive_ns ?? 0) / 1e6,
        meanA: x?.calls ? x.exclusive_ns / x.calls / 1000 : null,
        meanB: y?.calls ? y.exclusive_ns / y.calls / 1000 : null,
      });
    };
    if (g.a.length === g.b.length) {
      for (let i = 0; i < g.a.length; i++) {
        append(
          g.a[i],
          g.b[i],
          String(i),
          g.a[i].line === g.b[i].line ? 'same-line' : 'ordinal',
        );
      }
    } else {
      const used = new Set<Metric>();
      for (const x of g.a) {
        const matches = g.b.filter((y) => y.line === x.line && !used.has(y));
        const y = matches.length === 1 ? matches[0] : undefined;
        if (y) {
          used.add(y);
        }
        append(x, y, 'a' + x.id, y ? 'same-line' : 'unmatched');
      }
      for (const y of g.b) {
        if (!used.has(y)) {
          append(undefined, y, 'b' + y.id, 'unmatched');
        }
      }
    }
  }
  return rows;
}
export async function compareCaptures(
  a: StreamCapture,
  b: StreamCapture,
  start = 0,
  end = a.duration,
): Promise<Comparison> {
  const [metricsA, inventoryA, inventoryB, summaryA, summaryB] =
    await Promise.all([
      start === 0 && end === a.duration
        ? Promise.resolve([...a.metrics.values()])
        : a.rankMetrics(start, end),
      a.telemetry(0, a.duration),
      b.telemetry(0, b.duration),
      summaryCapture(a, start, end),
      summaryCapture(b),
    ]);
  return {
    durationA: end - start,
    durationB: b.duration,
    renderA: summaryA.render,
    renderB: summaryB.render,
    rows: compareMetrics(
      metricsA,
      [...b.metrics.values()],
      inventoryA.inventory,
      inventoryB.inventory,
    ),
    incomplete:
      !a.document.complete ||
      !b.document.complete ||
      !!a.document.timeline.dropped_events ||
      !!b.document.timeline.dropped_events ||
      ((start !== 0 || end !== a.duration) &&
        !!a.document.timeline.filtered_events),
  };
}
