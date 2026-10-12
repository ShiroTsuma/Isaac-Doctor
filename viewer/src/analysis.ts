import Core from './core.ts';
import { StreamCapture } from './stream.ts';
import { frameResults } from './frames.ts';
import { cachedFrames, quarterRange } from './analysis-cache.ts';
import type { FrameSummary } from './analysis-cache.ts';
import type {
  Model,
  Metric,
  Row,
  Query,
  Results,
  WorkerOperations,
  TraceEvent,
  TreeRow,
  FrameQuery,
} from './types.ts';
interface Branch extends Omit<Row, 'children'> {
  metric: Metric;
  children: Map<number, Branch>;
}
export function matchesQuery(
  metric: Metric,
  query: Pick<Query, 'search' | 'mod' | 'hook' | 'metric'>,
) {
  return (
    Core.matches(metric, query.search) &&
    (query.mod === undefined || metric.mod === query.mod) &&
    (query.hook === undefined ||
      metric.callback_id === query.hook ||
      metric.callback_name === query.hook) &&
    (query.metric === undefined || metric.id === query.metric)
  );
}
function attachGroups(rows: Row[], model: Model, query: Query) {
  if (query.mode === 'callbacks') return;
  const leaves = Core.rank(model, { ...query, mode: 'callbacks' });
  const compare = (a: Row, b: Row) =>
    (query.descending ? -1 : 1) *
      (query.sort === 'label' ? a.label.localeCompare(b.label) : a[query.sort] - b[query.sort]) ||
    a.key.localeCompare(b.key);
  for (const row of rows) {
    const children = leaves.filter((leaf) =>
      query.mode === 'mods' ? leaf.mod === row.mod : leaf.metric!.callback_id === row.key,
    );
    if (query.mode === 'hooks') {
      row.children = children.sort(compare);
      continue;
    }
    const hooks = new Map<string, Row>();
    for (const leaf of children) {
      const m = leaf.metric!,
        key = `${row.key}/hook/${m.callback_id}`;
      let hook = hooks.get(key);
      if (!hook) {
        hook = {
          key,
          label: m.callback_name || m.callback_id,
          mod: row.mod,
          metric: null,
          calls: 0,
          errors: 0,
          inclusive: 0,
          exclusive: 0,
          maximum: 0,
          children: [],
        };
        hooks.set(key, hook);
      }
      hook.children!.push({ ...leaf, key: `${key}/${leaf.key}` });
      hook.calls += leaf.calls;
      hook.errors += leaf.errors;
      hook.inclusive += leaf.inclusive;
      hook.exclusive += leaf.exclusive;
      hook.maximum = Math.max(hook.maximum, leaf.maximum);
    }
    row.children = [...hooks.values()].sort(compare);
    for (const hook of row.children) hook.children!.sort(compare);
  }
}

export function rankModel(model: Model, query: Query, limit = 500): Results {
  const rows = Core.rank(model, query);
  attachGroups(rows, model, query);
  // Expanded rows share one React sibling list. Hook IDs and metric IDs use
  // separate namespaces and ancestry; raw numeric IDs can collide (e.g. 68).
  const identify = (items: Row[], parent: string[]) => {
    for (const row of items) {
      const path = [...parent, row.key];
      row.key = JSON.stringify([query.mode, ...path]);
      if (row.children) identify(row.children, path);
    }
  };
  identify(rows, []);
  rows.sort(
    (a, b) =>
      (query.descending ? -1 : 1) *
        (query.sort === 'label' ? a.label.localeCompare(b.label) : a[query.sort] - b[query.sort]) ||
      a.label.localeCompare(b.label),
  );
  const omitted = { calls: 0, self: 0, total: 0 };
  if (query.minimumUs)
    for (const e of model.events)
      if (
        (!query.range || (e.start >= query.start && e.start < query.end)) &&
        e.duration * 1000 < query.minimumUs &&
        matchesQuery(model.metrics.get(e.metric)!, query)
      ) {
        omitted.calls++;
        omitted.self += e.self;
        omitted.total += e.duration;
      }
  return {
    omitted,
    rows: rows.slice(0, limit),
    count: rows.length,
    stats: rows.reduce(
      (s, r) => ({
        self: s.self + r.exclusive,
        calls: s.calls + r.calls,
        errors: s.errors + r.errors,
      }),
      { self: 0, calls: 0, errors: 0 },
    ),
  };
}
export async function rankCapture(stream: StreamCapture, query: Query, limit = 500) {
  const selection =
    query.range || query.minimumUs
      ? await stream.rankSelection(
          query.range ? query.start : 0,
          query.range ? query.end : stream.duration,
          query.minimumUs,
        )
      : { metrics: [...stream.metrics.values()], omittedMetrics: [] };
  const result = rankModel(
    {
      document: stream.document,
      metrics: new Map(selection.metrics.map((m) => [m.id, m])),
      events: [],
      duration: stream.duration,
      lanes: [],
      hasTimeline: true,
    },
    { ...query, range: false, minimumUs: 0 },
    limit,
  );
  result.omitted = selection.omittedMetrics
    .filter((m) => matchesQuery(m, query))
    .reduce(
      (s, m) => ({
        calls: s.calls + m.calls,
        self: s.self + m.exclusive_ns / 1e6,
        total: s.total + m.inclusive_ns / 1e6,
      }),
      { calls: 0, self: 0, total: 0 },
    );
  return result;
}
export async function eventsCapture(
  stream: StreamCapture,
  payload: WorkerOperations['events']['payload'],
  limit = 500,
  minimumUs = payload.minimumUs ?? 0,
) {
  const metrics = stream.metrics;
  const compare = (a: TraceEvent, b: TraceEvent) => {
    const v =
      payload.sort === 'activity'
        ? `${metrics.get(a.metric)!.mod} / ${metrics.get(a.metric)!.callback_name}`.localeCompare(
            `${metrics.get(b.metric)!.mod} / ${metrics.get(b.metric)!.callback_name}`,
          )
        : a[payload.sort] - b[payload.sort];
    return (payload.descending ? -1 : 1) * v || a.start - b.start || a.metric - b.metric;
  };
  if (
    !payload.range &&
    !payload.search &&
    payload.mod === undefined &&
    payload.hook === undefined &&
    payload.metric === undefined &&
    !payload.errorsOnly &&
    !minimumUs &&
    payload.sort === 'start' &&
    !payload.descending
  )
    return { rows: await stream.earliest(limit), count: stream.count };
  const rows: TraceEvent[] = [],
    omitted = { calls: 0, self: 0, total: 0 };
  let count = 0;
  await stream.visitEvents(
    payload.range ? payload.start : 0,
    payload.range ? payload.end : stream.duration,
    (event, id, ticks, duration, self, _thread, _depth, error) => {
      const start = (ticks / stream.frequency) * 1000;
      if (
        (payload.range && (start < payload.start || start >= payload.end)) ||
        (payload.errorsOnly && !error) ||
        !matchesQuery(metrics.get(id)!, payload)
      )
        return;
      if ((duration / stream.frequency) * 1e6 < minimumUs) {
        omitted.calls++;
        omitted.self += (self / stream.frequency) * 1000;
        omitted.total += (duration / stream.frequency) * 1000;
        return;
      }
      count++;
      rows.push(event());
      if (rows.length >= limit * 2) {
        rows.sort(compare);
        rows.length = limit;
      }
    },
  );
  rows.sort(compare);
  return { rows: rows.slice(0, limit), count, omitted };
}
export async function summaryCapture(
  stream: StreamCapture,
  start = 0,
  end = stream.duration,
): Promise<{ render: FrameSummary; update: FrameSummary }> {
  const range = stream.analysis && quarterRange(start, end, stream.duration);
  const empty = async function* () {};
  const summary = async (kind: 1 | 2) => {
    if (range && stream.analysis) {
      const saved = cachedFrames(stream.analysis, range, kind);
      if (saved.count || !stream.blocks.some((b) => b.type === 7)) return saved;
    }
    const result = await frameResults(
      stream.intervals(start, end),
      () => empty(),
      stream.metrics,
      { kind, start, end, minimumUs: Infinity, search: '' },
      !stream.document.complete,
    );
    const { count, mean, rate, maximum, p50, p95, p99 } = result;
    return { count, mean, rate, maximum, p50, p95, p99 };
  };
  return { render: await summary(2), update: await summary(1) };
}
export async function framesCapture(
  stream: StreamCapture,
  query: FrameQuery,
  breakdown = true,
  candidateLimit = 500,
) {
  const range = stream.analysis && quarterRange(query.start, query.end, stream.duration),
    empty = async function* () {};
  const cached =
    range && stream.analysis ? cachedFrames(stream.analysis, range, query.kind) : undefined;
  const result = await frameResults(
    stream.intervals(query.start, query.end),
    (start, end) => (breakdown ? stream.events(start, end) : empty()),
    stream.metrics,
    query,
    !stream.document.complete || !!stream.document.timeline.dropped_events,
    cached?.count ? cached : undefined,
    breakdown ? (_start, _end, visit, ranges) => stream.visitRanges(ranges, visit) : undefined,
    candidateLimit,
  );
  if (!result.count) {
    const session = await summaryCapture(stream);
    result.sessionCount = (query.kind === 2 ? session.render : session.update).count;
    result.enclosingRange = null;
    if (result.sessionCount)
      for await (const f of stream.intervals(query.start, query.end))
        if (f.kind === query.kind && f.start < query.end && f.start + f.duration > query.start) {
          const previous: [number, number] | null = result.enclosingRange;
          result.enclosingRange = [
            Math.min(previous?.[0] ?? f.start, f.start),
            Math.max(previous?.[1] ?? f.start + f.duration, f.start + f.duration),
          ];
        }
  }
  if (query.kind === 2 && result.rows.length) {
    const byThread = new Map<number, number[]>();
    for await (const f of stream.intervals(query.start, query.end))
      if (f.kind === 1) {
        if (!byThread.has(f.thread)) byThread.set(f.thread, []);
        const times = byThread.get(f.thread)!;
        times.push(f.start + f.duration);
        if (times.length > 200000)
          throw Error('Too many update observations; select a smaller range.');
      }
    for (const times of byThread.values()) times.sort((a, b) => a - b);
    for (const f of result.rows) {
      const times = byThread.get(f.thread) ?? [];
      let low = 0,
        high = times.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (times[mid] < f.start) low = mid + 1;
        else high = mid;
      }
      f.hasUpdate = low < times.length && times[low] < f.start + f.duration;
    }
  }
  return result;
}

export async function treeCapture(source: StreamCapture | Model, payload: Query, limit = 1000) {
  const stream = source instanceof StreamCapture ? source : null,
    model = source as Model;

  const roots = new Map<number, Branch>(),
    stacks = new Map<number, TraceEvent[]>();
  function consume(events: TraceEvent[], start: number, end: number) {
    const bySpan = new Map(events.filter((e) => e.span !== undefined).map((e) => [e.span!, e]));
    for (const e of events) {
      let stack = stacks.get(e.thread);
      if (!stack) {
        stack = [];
        stacks.set(e.thread, stack);
      }
      while (
        stack.length &&
        (stack.at(-1)!.depth >= e.depth ||
          stack.at(-1)!.start + stack.at(-1)!.duration < e.start + e.duration)
      )
        stack.pop();
      let ancestry = [...stack, e];
      stack.push(e);
      if (e.span !== undefined) {
        ancestry = [e];
        let parent = bySpan.get(e.parent!);
        const seen = new Set<number>([e.span]);
        while (parent && !seen.has(parent.span!)) {
          seen.add(parent.span!);
          ancestry.unshift(parent);
          parent = bySpan.get(parent.parent!);
        }
      }
      if (e.start < start || e.start >= end || e.duration * 1000 < (payload.minimumUs ?? 0))
        continue;
      const m = (stream?.metrics ?? model.metrics).get(e.metric)!;
      if (!matchesQuery(m, payload)) continue;
      let branch = roots;
      for (const ancestor of ancestry) {
        if (!branch.has(ancestor.metric)) {
          const metric = (stream?.metrics ?? model.metrics).get(ancestor.metric)!;
          branch.set(ancestor.metric, {
            key: '',
            metric,
            label: `${metric.mod} / ${metric.callback_name || metric.callback_id}`,
            mod: metric.mod,
            calls: 0,
            errors: 0,
            inclusive: 0,
            exclusive: 0,
            maximum: 0,
            children: new Map(),
          });
        }
        const node = branch.get(ancestor.metric)!;
        if (ancestor === e) {
          node.calls++;
          node.errors += +e.error;
          node.inclusive += e.duration;
          node.exclusive += e.self;
          node.maximum = Math.max(node.maximum, e.duration);
        }
        branch = node.children;
      }
    }
  }
  if (stream) {
    const start = payload.range ? payload.start : 0,
      end = payload.range ? payload.end : stream.duration;
    let at = start,
      step = Math.max(0.0001, (end - start) * Math.min(1, 10000 / Math.max(1, stream.count)));
    while (at < end) {
      const until = Math.min(end, at + step),
        events: TraceEvent[] = [];
      let overflow = false;
      for await (const e of stream.events(at, until)) {
        events.push(e);
        if (events.length > 100000) {
          overflow = true;
          break;
        }
      }
      if (overflow) {
        if (step <= 0.0001) throw Error('Call tree range is too dense. Zoom in.');
        step /= 2;
        continue;
      }
      events.sort((a, b) => a.start - b.start || a.depth - b.depth);
      stacks.clear();
      consume(events, at, until);
      at = until;
    }
  } else
    consume(
      model.events,
      payload.range ? payload.start : 0,
      payload.range ? payload.end : Number.POSITIVE_INFINITY,
    );
  let count = 0;
  const treeSort = payload.sort,
    treeDescending = payload.descending;
  function flatten(branch: Map<number, Branch>, prefix = '', depth = 0): TreeRow[] {
    const rows: TreeRow[] = [];
    for (const node of [...branch.values()].sort(
      (a, b) =>
        (treeDescending ? -1 : 1) *
          (treeSort === 'label' ? a.label.localeCompare(b.label) : a[treeSort] - b[treeSort]) ||
        a.metric.id - b.metric.id,
    )) {
      if (count >= limit) break;
      count++;
      const key = prefix + '/' + node.metric.id;
      rows.push({ ...node, key, depth, children: flatten(node.children, key, depth + 1) });
    }
    return rows;
  }
  return { rows: flatten(roots), count };
}
