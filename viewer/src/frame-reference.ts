import type { FrameInterval, RoomContext, Telemetry } from './types.ts';

export interface ReferenceMatch {
  frames: FrameInterval[];
  population: number;
  meanWall: number | null;
  hasUpdate: boolean;
  context?: RoomContext;
  quality: 'context-matched' | 'clock-only' | 'unavailable';
  reason: string;
}

function lowerBound(values: number[], value: number) {
  let a = 0;
  let b = values.length;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (values[m] < value) {
      a = m + 1;
    } else {
      b = m;
    }
  }
  return a;
}

function upperBound(values: number[], value: number) {
  let a = 0;
  let b = values.length;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (values[m] <= value) {
      a = m + 1;
    } else {
      b = m;
    }
  }
  return a;
}

function near(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(2, Math.min(a, b) * 0.1);
}

export function similarRoom(a: RoomContext, b: RoomContext) {
  return (
    a.room === b.room &&
    a.stage === b.stage &&
    a.stageType === b.stageType &&
    a.roomType === b.roomType &&
    a.width === b.width &&
    a.height === b.height &&
    a.gridSlots === b.gridSlots &&
    a.grids === b.grids &&
    a.enemies === b.enemies &&
    near(a.entities, b.entities) &&
    near(a.effects, b.effects) &&
    near(a.projectiles, b.projectiles) &&
    near(a.tears, b.tears) &&
    near(a.pickups, b.pickups)
  );
}

/** Shared by CLI diagnosis and the inspector. Matching never crosses a recorded transition. */
export class FrameReferenceIndex {
  private updates = new Map<number, number[]>();
  private groups = new Map<
    string,
    { frames: FrameInterval[]; times: number[] }
  >();

  private contexts: RoomContext[];
  private recordedContext: boolean;
  private contextTimes: number[];
  private transitions: number[];
  constructor(intervals: FrameInterval[], telemetry: Telemetry) {
    this.recordedContext = !!telemetry.context?.length;
    this.contexts = (telemetry.context ?? [])
      .filter((c) => c.valid === 7)
      .sort((a, b) => a.time - b.time);
    this.contextTimes = this.contexts.map((c) => c.time);
    this.transitions = telemetry.markers
      .filter((m) => [2, 3, 4, 5, 6].includes(m.kind))
      .map((m) => m.time)
      .sort((a, b) => a - b);
    for (const f of intervals) {
      if (f.kind === 1) {
        const times = this.updates.get(f.thread) ?? [];
        times.push(f.start + f.duration);
        this.updates.set(f.thread, times);
      }
    }
    for (const times of this.updates.values()) {
      times.sort((a, b) => a - b);
    }
    for (const f of intervals) {
      const key = this.key(f);
      const group = this.groups.get(key) ?? { frames: [], times: [] };
      group.frames.push(f);
      this.groups.set(key, group);
    }
    for (const group of this.groups.values()) {
      group.frames.sort((a, b) => a.start - b.start);
      group.times = group.frames.map((f) => f.start);
    }
  }

  hasUpdate(f: FrameInterval) {
    const times = this.updates.get(f.thread) ?? [];
    const at = lowerBound(times, f.start);
    return at < times.length && times[at] < f.start + f.duration;
  }

  private key(f: FrameInterval) {
    return `${f.kind}:${f.thread}:${f.kind === 2 && this.hasUpdate(f)}`;
  }

  context(f: FrameInterval) {
    const c = this.contexts[upperBound(this.contextTimes, f.start) - 1];
    const transition = upperBound(this.transitions, f.start) - 1;
    return c &&
      f.start - c.time <= 500 &&
      c.time >= (this.transitions[transition] ?? -Infinity) &&
      (this.transitions[transition + 1] ?? Infinity) >= f.start + f.duration
      ? c
      : undefined;
  }

  match(frame: FrameInterval): ReferenceMatch {
    const hasUpdate = this.hasUpdate(frame);
    const context = this.context(frame);
    const epoch = upperBound(this.transitions, frame.start);
    const empty = (reason: string): ReferenceMatch => ({
      frames: [],
      population: 0,
      meanWall: null,
      hasUpdate,
      context,
      quality: 'unavailable',
      reason,
    });
    if ((this.transitions[epoch] ?? Infinity) < frame.start + frame.duration) {
      return empty('Interval crosses a recorded run/room/level transition.');
    }
    if (this.recordedContext && !context) {
      return empty(
        'No valid room sample within 500 ms after the most recent transition.',
      );
    }
    const group = this.groups.get(this.key(frame));
    if (!group) {
      return empty(
        'No intervals with the same clock, thread and update activity.',
      );
    }
    const a = lowerBound(group.times, frame.start - 5000);
    const b = upperBound(group.times, frame.start + 5000);
    if (b - a > 10000) {
      return empty(
        'Too many nearby intervals for bounded matching; select a shorter range.',
      );
    }
    const candidates = group.frames.slice(a, b).filter(
      (f) =>
        !(f.id === frame.id && f.start === frame.start) &&
        Math.abs(f.start - frame.start) <= 5000 &&
        upperBound(this.transitions, f.start) === epoch &&
        (this.transitions[epoch] ?? Infinity) >= f.start + f.duration &&
        (!context ||
          (() => {
            const other = this.context(f);
            return !!other && similarRoom(context, other);
          })()),
    );
    if (!candidates.length) {
      return empty('No nearby intervals with comparable recorded state.');
    }
    const durations = candidates.map((f) => f.duration).sort((a, b) => a - b);
    const normalLimit =
      durations[Math.max(0, Math.ceil(durations.length * 0.9) - 1)];
    const normal = candidates.filter((f) => f.duration <= normalLimit);
    const sorted = normal.map((f) => f.duration).sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    normal.sort(
      (a, b) =>
        Math.abs(a.duration - median) - Math.abs(b.duration - median) ||
        Math.abs(a.start - frame.start) - Math.abs(b.start - frame.start) ||
        a.id - b.id,
    );
    const frames = normal.slice(0, 5);
    return {
      frames,
      population: candidates.length,
      meanWall: frames.reduce((s, f) => s + f.duration, 0) / frames.length,
      hasUpdate,
      context,
      quality: context ? 'context-matched' : 'clock-only',
      reason: context
        ? 'Same room, layout and enemy count; entity counts within 2 or 10%.'
        : 'Room context unavailable; matching uses clock, thread, update activity and recorded transitions only.',
    };
  }
}
