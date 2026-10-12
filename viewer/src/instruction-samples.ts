import type { StreamCapture } from './stream.ts';
import type { NativeWait } from './types.ts';

export interface InstructionGroup {
  location: string;
  thread: number;
  count: number;
  coveredWait: number;
}

export async function instructionCapture(
  stream: StreamCapture,
  start: number,
  end: number,
  limit = 100,
) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > stream.duration + 0.001
  ) {
    throw Error('Invalid instruction sample range.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw Error('Invalid instruction sample row limit.');
  }
  const available =
    !!((stream.document.configuration?.channels ?? 0) & 8192) ||
    stream.blocks.some((b) => b.type === 20);
  const waitCoverage =
    !!((stream.document.configuration?.channels ?? 0) & 4096) ||
    stream.blocks.some((b) => b.type === 17);
  const modules = available ? await stream.nativeModules() : [];
  const locate = (raw: string, bucket: boolean) => {
    const address = BigInt(raw);
    const module = modules.find(
      (m) => address >= m.base && address < m.base + m.size,
    );
    const relative = module ? address - module.base : address;
    const offset = bucket ? (relative / 64n) * 64n : relative;
    return `${module ? module.path.split(/[/\\]/).at(-1) + '+' : ''}0x${offset.toString(16)}${bucket ? '–0x' + (offset + 63n).toString(16) : ''}`;
  };
  const hotspots = new Map<string, InstructionGroup>();
  const moduleGroups = new Map<string, InstructionGroup>();
  const returns = new Map<string, InstructionGroup>();

  function add(
    groups: Map<string, InstructionGroup>,
    location: string,
    thread: number,
    waiting: boolean,
  ) {
    const key = `${thread}:${location}`;
    const row = groups.get(key) ?? {
      location,
      thread,
      count: 0,
      coveredWait: 0,
    };
    row.count++;
    row.coveredWait += Number(waiting);
    groups.set(key, row);
    if (groups.size > 20000) {
      throw Error('More than 20,000 sample locations; narrow the range.');
    }
  }

  let count = 0;
  let coveredWait = 0;
  let pauseTotal = 0;
  let pauseMaximum = 0;
  if (available) {
    for (let from = start; from < end; from += 250) {
      const to = Math.min(end, from + 250);
      const waits: NativeWait[] = [];
      if (waitCoverage) {
        for await (const wait of stream.waits(from, to)) {
          waits.push(wait);
          if (waits.length > 10000) {
            throw Error(
              'More than 10,000 waits in a sample window; narrow the range.',
            );
          }
        }
      }
      // A snapshot during an observed wait is wall-time occupancy, not CPU work.
      for await (const sample of stream.instructionSamples(from, to)) {
        const waiting = waits.some(
          (w) =>
            w.thread === sample.thread &&
            w.start <= sample.time &&
            sample.time < w.start + w.duration,
        );
        count++;
        coveredWait += Number(waiting);
        pauseTotal += sample.pause;
        pauseMaximum = Math.max(pauseMaximum, sample.pause);
        const address = BigInt(sample.address);
        const module = modules.find(
          (m) => address >= m.base && address < m.base + m.size,
        );
        add(
          moduleGroups,
          module?.path.split(/[/\\]/).at(-1) ?? 'Unresolved module',
          sample.thread,
          waiting,
        );
        add(hotspots, locate(sample.address, true), sample.thread, waiting);
        for (const candidate of new Set(sample.returns)) {
          add(returns, locate(candidate, false), sample.thread, waiting);
        }
      }
    }
  }
  const ranked = (groups: Map<string, InstructionGroup>) =>
    [...groups.values()]
      .sort(
        (a, b) =>
          b.count - a.count ||
          a.location.localeCompare(b.location) ||
          a.thread - b.thread,
      )
      .slice(0, limit);
  return {
    available,
    waitCoverage,
    count,
    coveredWait: waitCoverage ? coveredWait : null,
    outsideCoveredWait: waitCoverage ? count - coveredWait : null,
    pauseTotal,
    pauseMaximum,
    modules: ranked(moduleGroups),
    hotspots: ranked(hotspots),
    returns: ranked(returns),
    sessionStats: available ? await stream.samplingStats() : null,
    limitation:
      'Discrete wall-time instruction snapshots on registered Lua/render threads, including sleeping threads; counts are not CPU time or GPU time. Locations use 64-byte buckets. Covered waits include only the six instrumented APIs. Up to four frame-pointer return candidates are partial and may be absent or inaccurate when frame pointers are omitted. Sampling briefly suspends threads. Measured pause covers context readback through resume; it excludes entering SuspendThread and other profiler work.',
  };
}
