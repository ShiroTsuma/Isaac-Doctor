import type { StreamCapture } from './stream.ts';
import type { NativeWait } from './types.ts';

export const waitNames = [
  '',
  'Sleep',
  'SleepEx',
  'WaitForSingleObject',
  'WaitForSingleObjectEx',
  'WaitForMultipleObjects',
  'WaitForMultipleObjectsEx',
];

export async function nativeWaitCapture(
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
    throw Error('Invalid native wait range.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw Error('Invalid native wait row limit.');
  }
  const groups = new Map<
    number,
    { api: string; count: number; wall: number; maximum: number }
  >();
  const callers = new Map<
    string,
    { caller: string; api: string; thread: number; count: number; wall: number }
  >();
  const rows: NativeWait[] = [];
  let count = 0;
  let wall = 0;
  for await (const row of stream.waits(start, end)) {
    const clipped = Math.max(
      0,
      Math.min(end, row.start + row.duration) - Math.max(start, row.start),
    );
    const group = groups.get(row.kind) ?? {
      api: waitNames[row.kind],
      count: 0,
      wall: 0,
      maximum: 0,
    };
    group.count++;
    group.wall += clipped;
    group.maximum = Math.max(group.maximum, row.duration);
    groups.set(row.kind, group);
    const key = `${row.thread}:${row.kind}:${row.caller}`;
    const caller = callers.get(key) ?? {
      caller: row.caller,
      api: group.api,
      thread: row.thread,
      count: 0,
      wall: 0,
    };
    caller.count++;
    caller.wall += clipped;
    callers.set(key, caller);
    if (callers.size > 10000) {
      throw Error('More than 10,000 native wait call sites; narrow the range.');
    }
    count++;
    wall += clipped;
    rows.push(row);
    if (rows.length >= limit * 2) {
      rows.sort((a, b) => b.duration - a.duration || a.start - b.start);
      rows.length = limit;
    }
  }
  rows.sort((a, b) => b.duration - a.duration || a.start - b.start);
  rows.length = Math.min(limit, rows.length);
  const modules = await stream.nativeModules();
  const callSite = (caller: string) => {
    const address = BigInt(caller);
    const module = modules.find(
      (m) => address >= m.base && address < m.base + m.size,
    );
    return module
      ? `${module.path.split(/[/\\]/).at(-1)}+0x${(address - module.base).toString(16)}`
      : caller;
  };
  return {
    available:
      !!(
        stream.document.configuration?.channels &&
        stream.document.configuration.channels & 4096
      ) || stream.blocks.some((b) => b.type === 17),
    count,
    wall,
    groups: [...groups.values()].sort((a, b) => b.wall - a.wall),
    callers: [...callers.values()]
      .sort((a, b) => b.wall - a.wall)
      .slice(0, limit)
      .map((caller) => ({ ...caller, callSite: callSite(caller.caller) })),
    rows: rows.map((row) => ({ ...row, callSite: callSite(row.caller) })),
    limitation:
      'Observed API wall spans on registered Lua/render threads, clipped to range. Spans can overlap callback and SwapBuffers wall time and must not be added to them. These six APIs do not cover all waits or thread scheduling; raw call-site addresses are session-specific.',
  };
}
