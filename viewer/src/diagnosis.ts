import { slowFrameComparisons } from './slow-frames.ts';
import { FrameReferenceIndex } from './frame-reference.ts';
import type { StreamCapture } from './stream.ts';
import type { FrameInterval, RoomContext } from './types.ts';

interface Frame extends FrameInterval {
  self: number;
  calls: number;
  cohort: number;
  window: number;
  update: boolean;
  metrics: Map<number, Cost>;
  boundaryCrossingCalls: number;
  context?: RoomContext;
  contextGroups?: number[];
}
interface Cost {
  calls: number;
  self: number;
}
function quantile(sorted: number[], p: number) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
}
function correlation(a: number[], b: number[]) {
  if (a.length < 3) return null;
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length,
    ma = mean(a),
    mb = mean(b);
  let ab = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma,
      y = b[i] - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : null;
}

/** One bounded raw pass for all intervals, rather than attribution of only 500 stalls. */
export async function diagnoseCapture(
  stream: StreamCapture,
  {
    start = 0,
    end = stream.duration,
    kind = 2,
    top = 10,
    windowMs = 5000,
  }: { start?: number; end?: number; kind?: 1 | 2; top?: number; windowMs?: number } = {},
) {
  const data = await stream.telemetry(start, end);
  const frames: Frame[] = [],
    updateObservations: { time: number; thread: number }[] = [];
  for await (const f of stream.intervals(start, end)) {
    if (kind === 2 && f.kind === 1) {
      updateObservations.push({ time: f.start + f.duration, thread: f.thread });
      if (updateObservations.length > 200000)
        throw Error('Diagnosis exceeds 200,000 update observations; select a smaller range.');
    }
    if (f.kind === kind && f.start >= start && f.start + f.duration <= end) {
      frames.push({
        ...f,
        self: 0,
        calls: 0,
        cohort: 0,
        window: 0,
        update: false,
        metrics: new Map(),
        boundaryCrossingCalls: 0,
      });
      if (frames.length > 200000)
        throw Error('Diagnosis exceeds 200,000 intervals; select a smaller range.');
    }
  }
  const sorted = frames.map((f) => f.duration).sort((a, b) => a - b),
    p45 = quantile(sorted, 0.45),
    p55 = quantile(sorted, 0.55),
    p95 = quantile(sorted, 0.95);
  const step = Math.max(windowMs, Math.ceil((end - start) / 300)),
    windowCount = Math.ceil((end - start) / step),
    windows = Array.from({ length: windowCount }, () => ({
      frames: [] as Frame[],
      metrics: new Map<number, Cost>(),
    }));
  const cohorts = [
      'baseline_below_p95',
      'typical_p45_p55',
      'slow_p95_plus',
      ...(kind === 2
        ? [
            'baseline_with_update',
            'baseline_without_update',
            'slow_with_update',
            'slow_without_update',
          ]
        : []),
    ].map((name) => ({ name, frames: [] as Frame[], metrics: new Map<number, Cost>() })),
    byThread = new Map<number, Frame[]>();
  for (const f of frames) {
    f.cohort = f.duration >= p95! ? 2 : 0;
    f.window = Math.min(windowCount - 1, Math.floor((f.start - start) / step));
    cohorts[f.cohort].frames.push(f);
    if (f.duration >= p45! && f.duration <= p55!) cohorts[1].frames.push(f);
    windows[f.window].frames.push(f);
    if (!byThread.has(f.thread)) byThread.set(f.thread, []);
    byThread.get(f.thread)!.push(f);
  }
  for (const rows of byThread.values()) rows.sort((a, b) => a.start - b.start);
  const locate = (at: number, thread: number) => {
    const rows = byThread.get(thread);
    if (!rows) return;
    let low = 0,
      high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rows[mid].start <= at) low = mid + 1;
      else high = mid;
    }
    const f = rows[low - 1];
    return f && at < f.start + f.duration ? f : undefined;
  };
  for (const update of updateObservations) {
    const f = locate(update.time, update.thread);
    if (f) f.update = true;
  }
  const controlled = (f: Frame) => 3 + (f.cohort === 2 ? 2 : 0) + (f.update ? 0 : 1);
  if (kind === 2) for (const f of frames) cohorts[controlled(f)].frames.push(f);
  const contextGroups = [
    'grid_135_or_less',
    'grid_over_135',
    'effects_under_20',
    'effects_20_to_49',
    'effects_50_plus',
  ].map((name) => ({ name, frames: [] as Frame[], metrics: new Map<number, Cost>() }));
  const contexts = (data.context ?? [])
      .filter((c) => c.valid === 7)
      .sort((a, b) => a.time - b.time),
    transitions = data.markers
      .filter((m) => [2, 3, 4, 5, 6].includes(m.kind))
      .map((m) => m.time)
      .sort((a, b) => a - b);
  const prior = (times: readonly number[], at: number) => {
    let lo = 0,
      hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  const contextTimes = contexts.map((c) => c.time);
  for (const f of frames) {
    // Exclude transitions and pauses; compare render intervals containing an update.
    if (f.duration >= 100 || (kind === 2 && !f.update)) continue;
    const context = contexts[prior(contextTimes, f.start)],
      transition = prior(transitions, f.start);
    if (
      !context ||
      f.start - context.time > 500 ||
      context.time < (transitions[transition] ?? -Infinity) ||
      (transitions[transition + 1] ?? Infinity) < f.start + f.duration
    )
      continue;
    f.context = context;
    f.contextGroups = [
      context.gridSlots <= 135 ? 0 : 1,
      context.effects < 20 ? 2 : context.effects < 50 ? 3 : 4,
    ];
    for (const group of f.contextGroups) contextGroups[group].frames.push(f);
  }
  const observations: FrameInterval[] = updateObservations.map((f, i) => ({
    id: i,
    start: f.time,
    duration: 0,
    kind: 1,
    thread: f.thread,
  }));
  const referenceIndex = new FrameReferenceIndex([...frames, ...observations], data);
  const detailedFrames = new Set<FrameInterval>();
  for (const frame of frames
    .filter((f) => p95 !== null && f.duration >= p95)
    .sort((a, b) => b.duration - a.duration || a.start - b.start)
    .slice(0, 500)) {
    detailedFrames.add(frame);
    for (const reference of referenceIndex.match(frame).frames) detailedFrames.add(reference);
  }
  let retainedCalls = 0,
    attributedCalls = 0,
    entries = 0;
  const add = (map: Map<number, Cost>, id: number, self: number) => {
    let value = map.get(id);
    if (!value) {
      if (++entries > 500000)
        throw Error('Diagnosis exceeds 500,000 callback/window entries; select a smaller range.');
      value = { calls: 0, self: 0 };
      map.set(id, value);
    }
    value.calls++;
    value.self += self;
  };
  if (frames.length)
    await stream.visitEvents(start, end, (_event, id, ticks, duration, self, thread) => {
      const at = (ticks / stream.frequency) * 1000;
      if (at < start || at >= end) return;
      retainedCalls++;
      const f = locate(at, thread);
      if (!f) return;
      const cost = (self / stream.frequency) * 1000;
      attributedCalls++;
      f.calls++;
      f.self += cost;
      if (at + (duration / stream.frequency) * 1000 > f.start + f.duration)
        f.boundaryCrossingCalls++;
      if (detailedFrames.has(f)) add(f.metrics, id, cost);
      add(cohorts[f.cohort].metrics, id, cost);
      if (kind === 2) add(cohorts[controlled(f)].metrics, id, cost);
      if (f.duration >= p45! && f.duration <= p55!) add(cohorts[1].metrics, id, cost);
      add(windows[f.window].metrics, id, cost);
      if (f.contextGroups)
        for (const group of f.contextGroups) add(contextGroups[group].metrics, id, cost);
    });
  const stats = (rows: Frame[]) => {
    const durations = rows.map((f) => f.duration).sort((a, b) => a - b),
      total = rows.reduce((s, f) => s + f.duration, 0),
      self = rows.reduce((s, f) => s + f.self, 0);
    return {
      count: rows.length,
      rate: total ? (rows.length * 1000) / total : null,
      mean_ms: rows.length ? total / rows.length : null,
      p50_ms: quantile(durations, 0.5),
      p95_ms: quantile(durations, 0.95),
      p99_ms: quantile(durations, 0.99),
      maximum_ms: durations.at(-1) ?? null,
      mean_callback_self_ms: rows.length ? self / rows.length : null,
      callback_self_ms: self,
      interval_wall_ms: total,
      callback_self_fraction: total ? self / total : null,
      mean_calls: rows.length ? rows.reduce((s, f) => s + f.calls, 0) / rows.length : null,
      self_exceeds_wall: rows.filter((f) => f.self > f.duration + 1e-6).length,
    };
  };
  const costs = (map: Map<number, Cost>, count: number) => {
    const mods = new Map<string, Cost>();
    for (const [id, value] of map) {
      const mod = stream.metrics.get(id)!.mod,
        old = mods.get(mod) ?? { calls: 0, self: 0 };
      old.calls += value.calls;
      old.self += value.self;
      mods.set(mod, old);
    }
    const wire = (value: Cost) => ({
      self_ms: value.self,
      calls: value.calls,
      self_ms_per_interval: count ? value.self / count : 0,
      calls_per_interval: count ? value.calls / count : 0,
      mean_self_us_per_call: value.calls ? (value.self * 1000) / value.calls : 0,
    });
    return {
      mods: [...mods]
        .sort((a, b) => b[1].self - a[1].self)
        .slice(0, top)
        .map(([mod, cost]) => ({ mod, ...wire(cost) })),
      callbacks: [...map]
        .sort((a, b) => b[1].self - a[1].self)
        .slice(0, top)
        .map(([id, cost]) => {
          const m = stream.metrics.get(id)!;
          return {
            metric_id: id,
            mod: m.mod,
            hook: m.callback_name || m.callback_id,
            source: m.source,
            line: m.line,
            ...wire(cost),
          };
        }),
    };
  };
  const slow = cohorts[2],
    baseline = cohorts[0];
  const increases = (slow: (typeof cohorts)[number], baseline: (typeof cohorts)[number]) =>
    [...slow.metrics]
      .map(([id, cost]) => {
        const other = baseline.metrics.get(id),
          slowMean = cost.self / Math.max(1, slow.frames.length),
          baseMean = (other?.self ?? 0) / Math.max(1, baseline.frames.length),
          m = stream.metrics.get(id)!;
        return {
          metric_id: id,
          mod: m.mod,
          hook: m.callback_name || m.callback_id,
          source: m.source,
          line: m.line,
          slow_self_ms_per_interval: slowMean,
          baseline_self_ms_per_interval: baseMean,
          increase_ms_per_interval: slowMean - baseMean,
          ratio: baseMean ? slowMean / baseMean : null,
          slow_calls_per_interval: cost.calls / Math.max(1, slow.frames.length),
          baseline_calls_per_interval: (other?.calls ?? 0) / Math.max(1, baseline.frames.length),
        };
      })
      .sort((a, b) => b.increase_ms_per_interval - a.increase_ms_per_interval)
      .slice(0, top);
  const summary = stats(frames),
    rates = sorted.map((x) => 1000 / x).reverse();
  const matched = slowFrameComparisons(
    frames,
    observations,
    data,
    stream.metrics,
    p95,
    top,
    referenceIndex,
  );
  return {
    matched_slow_frames: matched,
    clock: kind === 2 ? 'render' : 'update',
    range_ms: [start, end],
    population: 'complete native intervals; retained callback self by call start and thread',
    summary: {
      ...summary,
      instantaneous_rate_percentiles: {
        p1: quantile(rates, 0.01),
        p5: quantile(rates, 0.05),
        p50: quantile(rates, 0.5),
        unit: kind === 2 ? 'FPS' : 'UPS',
      },
    },
    correlations: {
      duration_vs_callback_self: correlation(
        frames.map((f) => f.duration),
        frames.map((f) => f.self),
      ),
      duration_vs_callback_count: correlation(
        frames.map((f) => f.duration),
        frames.map((f) => f.calls),
      ),
      under_100ms_duration_vs_callback_self: correlation(
        frames.filter((f) => f.duration < 100).map((f) => f.duration),
        frames.filter((f) => f.duration < 100).map((f) => f.self),
      ),
      association_is_not_causation: true,
    },
    context_cohorts: contextGroups.map((c) => ({
      name: c.name,
      ...stats(c.frames),
      ...costs(c.metrics, c.frames.length),
    })),
    context_coverage: {
      sample_count: contexts.length,
      attributed_intervals: frames.filter((f) => f.context).length,
      maximum_sample_age_ms: 500,
      excludes_transitions_and_intervals_100ms_plus: true,
      requires_update: kind === 2,
      sampled_not_per_frame: true,
    },
    cohorts: cohorts.map((c) => ({
      name: c.name,
      ...stats(c.frames),
      ...costs(c.metrics, c.frames.length),
    })),
    slow_callback_increases: increases(slow, baseline),
    update_controlled_callback_increases: kind === 2 ? increases(cohorts[5], cohorts[3]) : [],
    windows: windows.map((w, i) => {
      const a = start + i * step,
        b = Math.min(end, a + step),
        heap = data.heap.filter((h) => h.time >= a && h.time < b);
      return {
        start_ms: a,
        end_ms: b,
        ...stats(w.frames),
        ...costs(w.metrics, w.frames.length),
        markers: data.markers.filter((m) => m.time >= a && m.time < b),
        heap_sample_min_bytes: heap.length ? Math.min(...heap.map((h) => h.bytes)) : null,
        heap_sample_max_bytes: heap.length ? Math.max(...heap.map((h) => h.bytes)) : null,
      };
    }),
    coverage: {
      configuration: stream.document.configuration ?? null,
      selected_scope:
        !!stream.document.configuration &&
        (!(stream.document.configuration.channels & 1) ||
          stream.document.configuration.selectedMods.length > 0 ||
          stream.document.configuration.selectedHooks.length > 0),
      complete: stream.document.complete,
      attribution_incomplete:
        !stream.document.complete ||
        !!stream.document.timeline.filtered_events ||
        !!stream.document.timeline.dropped_events ||
        !!stream.document.dropped_calls,
      native_dropped_calls: stream.document.dropped_calls,
      skipped_coroutine_calls: stream.document.skipped_coroutine_calls,
      retained_calls_read: retainedCalls,
      attributed_calls: attributedCalls,
      unattributed_calls: retainedCalls - attributedCalls,
      filtered_calls: stream.document.timeline.filtered_events,
      dropped_events: stream.document.timeline.dropped_events,
    },
    limitations: [
      'Selected mod/hook scope excludes callbacks outside that scope; unmeasured children remain in measured parent self time. Disabled callback timings prevent callback attribution.',
      'Percentiles in ms describe interval duration: lower is better. Rate percentiles describe its reciprocal: higher is better.',
      'Render update-controlled cohorts use native update observation boundaries; they are an observational comparison, not a matched experiment.',
      'Typical p45-p55 cohort can overlap another cohort when durations tie; it is a reference sample, not a partition.',
      'Callback self is wall time including native API and waiting, not measured CPU utilisation.',
      'Calls are attributed by start; a boundary-crossing call can exceed the selected interval.',
      'Engine, GPU, GC, scheduling, recorder overhead and screenshots are not separately timed by these channels.',
      'Room/entity cohorts use preceding context samples at most 500 ms old. Counts are sampled, not exact per-frame. Cohorts overlap and are observational, not an A/B experiment.',
      'Heap samples are VM-wide, not proof of GC pauses. No baseline without instrumentation is present.',
    ],
  };
}
