import { FrameReferenceIndex } from './frame-reference.ts';
import type { ReferenceMatch } from './frame-reference.ts';
import type { StreamCapture } from './stream.ts';
import type { FrameInterval, Metric, RoomContext, Telemetry } from './types.ts';

export interface FrameCost {
  key: string;
  label: string;
  metric?: number;
  self: number;
  calls: number;
  baselineSelf: number;
  baselineCalls: number;
  children?: FrameCost[];
}
export interface FrameDetail {
  frame: FrameInterval;
  hasUpdate: boolean;
  baseline: FrameInterval | null;
  baselinePopulation: number;
  reference: ReferenceMatch;
  baselineWall: number | null;
  boundaryCrossingCalls: number;
  costs: FrameCost[];
  self: number;
  baselineSelf: number;
  context?: RoomContext;
  baselineContext?: RoomContext;
  telemetry: Telemetry;
  incomplete: boolean;
}
export function containsUpdate(frame: FrameInterval, observations: FrameInterval[]) {
  return observations.some(
    (f) =>
      f.kind === 1 &&
      f.thread === frame.thread &&
      f.start + f.duration >= frame.start &&
      f.start + f.duration < frame.start + frame.duration,
  );
}
export function contextAt(context: RoomContext[] | undefined, time: number) {
  return context?.findLast((c) => c.time <= time);
}
export async function frameDetail(
  stream: StreamCapture,
  selected: FrameInterval,
): Promise<FrameDetail> {
  if (
    !Number.isFinite(selected.start) ||
    !Number.isFinite(selected.duration) ||
    selected.duration <= 0 ||
    selected.start < 0 ||
    selected.start + selected.duration > stream.duration + 0.001
  )
    throw Error('Invalid frame interval.');
  const start = Math.max(0, selected.start - 5000),
    end = Math.min(stream.duration, selected.start + selected.duration + 5000),
    intervals: FrameInterval[] = [];
  for await (const f of stream.intervals(start, end)) {
    intervals.push(f);
    if (intervals.length > 200000) throw Error('Frame neighborhood exceeds 200,000 intervals.');
  }
  const frame = intervals.find(
    (f) =>
      f.id === selected.id &&
      f.kind === selected.kind &&
      f.thread === selected.thread &&
      Math.abs(f.start - selected.start) < 0.0001,
  );
  if (!frame) throw Error('Selected frame is no longer available.');
  const telemetry = await stream.telemetry(start, end),
    index = new FrameReferenceIndex(intervals, telemetry),
    reference = index.match(frame),
    hasUpdate = reference.hasUpdate,
    context = reference.context;
  const baseline = reference.frames[0] ?? null;
  const selectedCosts = new Map<number, { self: number; calls: number }>(),
    baselineCosts = new Map<number, { self: number; calls: number }>();
  let boundaryCrossingCalls = 0;
  await stream.visitRanges(
    [
      [frame.start, frame.start + frame.duration],
      ...reference.frames.map((f) => [f.start, f.start + f.duration] as [number, number]),
    ],
    (event) => {
      if (event.thread !== frame.thread) return;
      const costs =
        event.start >= frame.start && event.start < frame.start + frame.duration
          ? selectedCosts
          : reference.frames.some(
                (f) => event.start >= f.start && event.start < f.start + f.duration,
              )
            ? baselineCosts
            : null;
      if (!costs) return;
      if (costs === selectedCosts && event.start + event.duration > frame.start + frame.duration)
        boundaryCrossingCalls++;
      let cost = costs.get(event.metric);
      if (!cost) {
        cost = { self: 0, calls: 0 };
        costs.set(event.metric, cost);
      }
      cost.self += event.self;
      cost.calls++;
    },
  );
  const mods = new Map<string, FrameCost>(),
    hooks = new Map<string, FrameCost>();
  for (const id of new Set([...selectedCosts.keys(), ...baselineCosts.keys()])) {
    const m = stream.metrics.get(id) as Metric,
      a = selectedCosts.get(id),
      b = baselineCosts.get(id),
      values = {
        self: a?.self ?? 0,
        calls: a?.calls ?? 0,
        baselineSelf: (b?.self ?? 0) / Math.max(1, reference.frames.length),
        baselineCalls: (b?.calls ?? 0) / Math.max(1, reference.frames.length),
      };
    let mod = mods.get(m.mod);
    if (!mod) {
      mod = {
        key: JSON.stringify([m.mod]),
        label: m.mod,
        self: 0,
        calls: 0,
        baselineSelf: 0,
        baselineCalls: 0,
        children: [],
      };
      mods.set(m.mod, mod);
    }
    const key = JSON.stringify([m.mod, m.callback_id]);
    let hook = hooks.get(key);
    if (!hook) {
      hook = {
        key,
        label: m.callback_name || m.callback_id,
        self: 0,
        calls: 0,
        baselineSelf: 0,
        baselineCalls: 0,
        children: [],
      };
      hooks.set(key, hook);
      mod.children!.push(hook);
    }
    for (const row of [mod, hook]) {
      row.self += values.self;
      row.calls += values.calls;
      row.baselineSelf += values.baselineSelf;
      row.baselineCalls += values.baselineCalls;
    }
    hook.children!.push({
      key: JSON.stringify([m.mod, m.callback_id, id]),
      label: `${m.source.split(/[/\\]/).at(-1)}:${m.line}`,
      metric: id,
      ...values,
    });
  }
  const costs = [...mods.values()];
  function order(rows: FrameCost[]) {
    rows.sort(
      (a, b) =>
        b.self - b.baselineSelf - (a.self - a.baselineSelf) ||
        b.self - a.self ||
        a.key.localeCompare(b.key),
    );
    for (const row of rows) if (row.children) order(row.children);
  }
  order(costs);
  return {
    frame,
    hasUpdate,
    baseline,
    baselinePopulation: reference.population,
    reference,
    baselineWall: reference.meanWall,
    boundaryCrossingCalls,
    costs,
    self: costs.reduce((s, c) => s + c.self, 0),
    baselineSelf: costs.reduce((s, c) => s + c.baselineSelf, 0),
    context,
    baselineContext: baseline ? contextAt(telemetry.context, baseline.start) : undefined,
    telemetry: {
      ...telemetry,
      errors: telemetry.errors?.filter(
        (e) => e.time >= frame.start && e.time < frame.start + frame.duration,
      ),
    },
    incomplete:
      !stream.document.complete ||
      !!stream.document.timeline.dropped_events ||
      !!stream.document.timeline.filtered_events ||
      !!stream.document.dropped_calls ||
      (!!stream.document.configuration &&
        (!(stream.document.configuration.channels & 1) ||
          stream.document.configuration.selectedMods.length > 0 ||
          stream.document.configuration.selectedHooks.length > 0)),
  };
}
