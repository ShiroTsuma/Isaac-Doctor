import type { StreamCapture } from './stream.ts';
import type { NativeWait } from './types.ts';

export interface InstructionGroup {
  location: string;
  thread: number;
  count: number;
  coveredWait: number;
  insideSwap: number;
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
  const presentationCoverage =
    !!((stream.document.configuration?.channels ?? 0) & 2048) ||
    stream.blocks.some((b) => b.type === 16);
  const modules = available ? await stream.nativeModules() : [];
  const luaAvailable = stream.blocks.some((b) => b.type === 22);
  const luaOwners = new Map<
    string,
    {
      metric: number;
      thread: number;
      mod: string;
      hook: string;
      source: string;
      line: number;
      count: number;
      coveredWait: number;
    }
  >();
  const sourceDefinitions = stream.blocks.some((b) => b.type === 23)
    ? await stream.luaInstructionSources()
    : new Map<number, { source: string; line: number }>();
  const luaSources = new Map<
    string,
    {
      metric: number;
      thread: number;
      mod: string;
      hook: string;
      source: string;
      line: number;
      count: number;
      coveredWait: number;
    }
  >();
  let luaSourceFailures = 0;
  let luaMissingSources = 0;
  let luaContexts = 0;
  let luaAttributed = 0;
  let luaUnverified = 0;
  let luaReadFailures = 0;
  let luaPartial = 0;
  let luaMissingMetrics = 0;
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
    swapping: boolean,
  ) {
    const key = `${thread}:${location}`;
    const row = groups.get(key) ?? {
      location,
      thread,
      count: 0,
      coveredWait: 0,
      insideSwap: 0,
    };
    row.count++;
    row.coveredWait += Number(waiting);
    row.insideSwap += Number(swapping);
    groups.set(key, row);
    if (groups.size > 20000) {
      throw Error('More than 20,000 sample locations; narrow the range.');
    }
  }

  let insideSwap = 0;
  let outsideSwapAndCoveredWait = 0;
  let count = 0;
  let coveredWait = 0;
  let pauseTotal = 0;
  let pauseMaximum = 0;
  if (available) {
    for (let from = start; from < end; from += 250) {
      const to = Math.min(end, from + 250);
      const swaps: { thread: number; start: number; end: number }[] = [];
      if (presentationCoverage) {
        for await (const frame of stream.presentations(from, to)) {
          swaps.push({
            thread: frame.thread,
            start: frame.swapStart,
            end: frame.swapStart + frame.swap,
          });
          if (swaps.length > 10000) {
            throw Error(
              'Too many presentation intervals in a sample window; narrow the range.',
            );
          }
        }
      }
      const waits: NativeWait[] = [];
      const contexts = new Map<
        string,
        { flags: number; metrics: number[]; source: number }
      >();
      if (luaAvailable) {
        for await (const context of stream.luaInstructionContexts(from, to)) {
          const key = `${context.thread}:${context.time}`;
          if (contexts.has(key)) {
            throw Error('Duplicate Lua instruction context.');
          }
          contexts.set(key, context);
          if (contexts.size > 10000) {
            throw Error(
              'Too many Lua contexts in a sample window; narrow the range.',
            );
          }
        }
      }
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
        const swapping = swaps.some(
          (s) =>
            s.thread === sample.thread &&
            sample.time >= s.start &&
            sample.time < s.end,
        );
        insideSwap += Number(swapping);
        outsideSwapAndCoveredWait += Number(!swapping && !waiting);
        count++;
        const context = contexts.get(`${sample.thread}:${sample.time}`);
        if (context) {
          luaContexts++;
          luaUnverified += Number(!(context.flags & 1));
          luaReadFailures += Number(!!(context.flags & 4));
          luaPartial += Number(!!(context.flags & 2));
          luaSourceFailures += Number(!!(context.flags & 8));
          const metric = stream.metrics.get(context.metrics[0]);
          if (context.metrics.length && !metric) {
            luaMissingMetrics++;
          }
          if (metric && !(context.flags & 4)) {
            luaAttributed++;
            const key = `${sample.thread}:${metric.id}`;
            const owner = luaOwners.get(key) ?? {
              metric: metric.id,
              thread: sample.thread,
              mod: metric.mod,
              hook: metric.callback_name,
              source: metric.source,
              line: metric.line,
              count: 0,
              coveredWait: 0,
            };
            owner.count++;
            owner.coveredWait += Number(waiting);
            luaOwners.set(key, owner);
          }
          const definition = sourceDefinitions.get(context.source);
          if (context.source && !definition) {
            luaMissingSources++;
          }
          if (definition && !(context.flags & 4)) {
            const key = `${sample.thread}:${context.source}:${metric?.id ?? 0}`;
            const source = luaSources.get(key) ?? {
              metric: metric?.id ?? 0,
              thread: sample.thread,
              mod: metric?.mod ?? 'Unwrapped Lua',
              hook: metric?.callback_name ?? 'No wrapper',
              ...definition,
              count: 0,
              coveredWait: 0,
            };
            source.count++;
            source.coveredWait += Number(waiting);
            luaSources.set(key, source);
          }
        }
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
          swapping,
        );
        add(
          hotspots,
          locate(sample.address, true),
          sample.thread,
          waiting,
          swapping,
        );
        for (const candidate of new Set(sample.returns)) {
          add(
            returns,
            locate(candidate, false),
            sample.thread,
            waiting,
            swapping,
          );
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
    presentationCoverage,
    insideSwap: presentationCoverage ? insideSwap : null,
    outsideSwapAndCoveredWait:
      presentationCoverage && waitCoverage ? outsideSwapAndCoveredWait : null,
    luaSourceFailures,
    luaMissingSources,
    luaSources: [...luaSources.values()]
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
      .slice(0, limit),
    luaAvailable,
    luaContexts,
    luaAttributed,
    luaUnverified,
    luaReadFailures,
    luaPartial,
    luaMissingMetrics,
    luaOwners: [...luaOwners.values()]
      .sort((a, b) => b.count - a.count || a.metric - b.metric)
      .slice(0, limit),
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
      'Discrete wall-time instruction snapshots on registered Lua/render threads, including sleeping threads; counts are not CPU time or GPU time. Locations use 64-byte buckets. Covered waits include only the six instrumented APIs. Inside SwapBuffers is measured wall time including driver work and synchronization, not GPU execution. Outside swap and covered waits can still include unobserved waits or scheduling. Up to four frame-pointer return candidates are partial and may be absent or inaccurate when frame pointers are omitted. Lua owners identify the innermost existing profiler wrapper on the main Lua state; Lua source snapshots identify the nearest main-state Lua function definition, not its currently executing line. Owner source lines identify wrapper definitions. Unwrapped work and coroutine interiors can remain unattributed. Sampling briefly suspends threads. Measured pause covers context readback through resume, including Lua context reads; it excludes entering SuspendThread and other profiler work.',
  };
}
