/* Shared capture model; runs offline in browsers and under Node for tests. */
import type {
  CaptureDocument,
  Metric,
  Model,
  NormalizedLane,
  Query,
  Row,
  Screenshot,
  TraceEvent,
} from './types.ts';
interface ChromeEvent {
  ph: string;
  name: string;
  pid: number;
  tid: number;
  cat?: string;
  ts?: number;
  dur?: number;
  args: Record<string, string | number | boolean>;
}
const columns = [
  'metric_id',
  'start_ns',
  'duration_ns',
  'exclusive_ns',
  'depth',
  'thread_id',
  'error',
];
const numeric = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;

function decode(buffer: ArrayBuffer | Uint8Array): CaptureDocument {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder();
  let offset = 0;

  function get(type: 'u16' | 'u32' | 'i32' | 'u64' | 'f64') {
    const sizes = { u16: 2, u32: 4, i32: 4, u64: 8, f64: 8 };
    const size = sizes[type];
    if (offset + size > view.byteLength) {
      throw Error('Ucięty plik nagrania.');
    }
    const n =
      type === 'u64'
        ? Number(view.getBigUint64(offset, true))
        : view[
            (
              {
                u16: 'getUint16',
                u32: 'getUint32',
                i32: 'getInt32',
                f64: 'getFloat64',
              } as const
            )[type]
          ](offset, true);
    offset += size;
    if (type === 'u64' && !Number.isSafeInteger(n)) {
      throw Error('Licznik przekracza dokładność przeglądarki.');
    }
    return n;
  }

  function string() {
    const size = get('u32');
    if (size > 1048576 || offset + size > view.byteLength) {
      throw Error('Nieprawidłowy tekst w nagraniu.');
    }
    const value = utf8.decode(bytes.subarray(offset, offset + size));
    offset += size;
    return value;
  }

  if (utf8.decode(bytes.subarray(0, 8)) !== 'ISAACPRF') {
    throw Error(
      'To nie jest binarne nagranie .isaacprof. Nagraj nową sesję profilerem 0.3.',
    );
  }
  offset = 8;
  const binaryVersion = get('u32');
  if (binaryVersion !== 1 && binaryVersion !== 2) {
    throw Error('Nieobsługiwana wersja binarnego nagrania.');
  }
  const flags = get('u32');
  const pid = get('u32');
  const lua_version = get('u32');
  const duration_ns = get('f64');
  const qpc_frequency = get('u64');
  const registered_metrics = get('u32');
  const count = get('u32');
  const eventCount = get('u32');
  const capacity = get('u32');
  if (count > 100000 || eventCount > 2000000) {
    throw Error('Nieprawidłowa liczba rekordów.');
  }
  const dropped_calls = get('u64');
  const skipped_coroutine_calls = get('u64');
  const host_lua_entries = get('u64');
  const dropped_events = get('u64');
  const filtered_events = get('u64');
  const minimum_duration_ns = get('f64');
  const profiler_version = string();
  const exe = string();
  const lua = string();
  const metrics: Metric[] = [];
  for (let i = 0; i < count; i++) {
    const id = get('u32');
    const line = get('i32');
    const calls = get('u64');
    const errors = get('u64');
    const inclusive_ns = get('f64');
    const exclusive_ns = get('f64');
    const mean_ns = get('f64');
    const max_ns = get('f64');
    const mod = string();
    const callback_id = string();
    const callback_name = string();
    const source = string();
    const fn = string();
    metrics.push({
      id,
      line,
      calls,
      errors,
      inclusive_ns,
      exclusive_ns,
      mean_ns,
      max_ns,
      mod,
      callback_id,
      callback_name,
      source,
      function: fn,
    });
  }
  if (offset + eventCount * 36 > view.byteLength) {
    throw Error('Nieprawidłowy rozmiar bloku zdarzeń.');
  }
  const events: number[][] = [];
  for (let i = 0; i < eventCount; i++) {
    const id = get('u32');
    const depth = get('u16');
    const error = get('u16');
    const thread = get('u32');
    const start = get('f64');
    const duration = get('f64');
    const self = get('f64');
    events.push([id, start, duration, self, depth, thread, error]);
  }
  const images: Screenshot[] = [];
  let interval_ms = 0;
  let omitted = 0;
  let overhead_ns = 0;
  if (binaryVersion === 2) {
    const screenshotCount = get('u32');
    interval_ms = get('u32');
    omitted = get('u32');
    overhead_ns = get('u64');
    if (screenshotCount > 240) {
      throw Error('Invalid screenshot count.');
    }
    for (let i = 0; i < screenshotCount; i++) {
      const time_ns = get('f64');
      const width = get('u16');
      const height = get('u16');
      const encoding = get('u32');
      const size = get('u32');
      if (
        !numeric(time_ns) ||
        time_ns > duration_ns ||
        !width ||
        !height ||
        width > 320 ||
        height > 240 ||
        encoding !== 1 ||
        size < 8 ||
        size > 1048576 ||
        offset + size > view.byteLength
      ) {
        throw Error('Invalid screenshot record.');
      }
      const png = new Uint8Array(size);
      png.set(bytes.subarray(offset, offset + size));
      offset += size;
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((n, j) => png[j] === n)) {
        throw Error('Invalid screenshot PNG.');
      }
      images.push({ time_ns, width, height, png });
    }
  }
  if (offset !== view.byteLength) {
    throw Error('Unexpected trailing capture bytes.');
  }
  return {
    format: 'isaacprof',
    schema_version: 1,
    profiler_version,
    pid,
    architecture: 'x86',
    lua_version,
    lua,
    exe,
    duration_ns,
    qpc_frequency,
    registered_metrics,
    dropped_calls,
    skipped_coroutine_calls,
    host_lua_entries,
    complete: !!(flags & 1),
    metrics,
    screenshots: { interval_ms, omitted, overhead_ns, images },
    timeline: {
      version: 1,
      enabled: !!(flags & 2),
      capacity,
      dropped_events,
      filtered_events,
      minimum_duration_ns,
      columns,
      events,
    },
  };
}

function parse(document: CaptureDocument): Model {
  if (document?.format !== 'isaacprof' || document.schema_version !== 1) {
    throw Error('Nieobsługiwany format nagrania.');
  }
  if (!numeric(document.duration_ns) || !Array.isArray(document.metrics)) {
    throw Error('Nieprawidłowe metadane nagrania.');
  }
  const metrics = new Map<number, Metric>();
  for (const m of document.metrics) {
    if (
      !Number.isSafeInteger(m.id) ||
      metrics.has(m.id) ||
      typeof m.mod !== 'string' ||
      typeof m.callback_id !== 'string' ||
      typeof m.source !== 'string' ||
      typeof m.callback_name !== 'string' ||
      ![m.calls, m.errors, m.inclusive_ns, m.exclusive_ns, m.max_ns].every(
        numeric,
      ) ||
      !Number.isSafeInteger(m.calls) ||
      !Number.isSafeInteger(m.errors) ||
      m.errors > m.calls ||
      m.exclusive_ns > m.inclusive_ns
    ) {
      throw Error('Nieprawidłowy rekord callbacka.');
    }
    metrics.set(m.id, m);
  }
  const t = document.timeline;
  if (
    t &&
    (t.version !== 1 ||
      JSON.stringify(t.columns) !== JSON.stringify(columns) ||
      !Array.isArray(t.events))
  ) {
    throw Error('Nieobsługiwana wersja osi czasu.');
  }
  const events: TraceEvent[] = [];
  for (const e of t?.events || []) {
    if (
      !Array.isArray(e) ||
      e.length !== 7 ||
      !metrics.has(e[0]) ||
      !e.every(numeric) ||
      e[3] > e[2] ||
      e[1] + e[2] > document.duration_ns + 1 ||
      !Number.isSafeInteger(e[4]) ||
      e[4] > 1024 ||
      !Number.isSafeInteger(e[5]) ||
      ![0, 1].includes(e[6])
    ) {
      throw Error('Nieprawidłowe zdarzenie osi czasu.');
    }
    events.push({
      metric: e[0],
      start: e[1] / 1e6,
      duration: e[2] / 1e6,
      self: e[3] / 1e6,
      depth: e[4],
      thread: e[5],
      error: !!e[6],
    });
  }
  events.sort((a, b) => a.start - b.start || a.depth - b.depth);
  const lanes = new Map<string, NormalizedLane>();
  for (const event of events) {
    const key = `${event.thread}:${event.depth}`;
    if (!lanes.has(key)) {
      lanes.set(key, {
        key,
        thread: event.thread,
        depth: event.depth,
        events: [],
      });
    }
    lanes.get(key)!.events.push(event);
  }
  return {
    document,
    metrics,
    events,
    duration: document.duration_ns / 1e6,
    lanes: [...lanes.values()].sort(
      (a, b) => a.thread - b.thread || a.depth - b.depth,
    ),
    hasTimeline: !!t?.enabled,
  };
}

function matches(m: Metric, search: string) {
  return (
    !search ||
    `${m.mod} ${m.callback_name} ${m.callback_id} ${m.source}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase())
  );
}

function rank(
  model: Model,
  {
    mode = 'mods',
    start = 0,
    end = model.duration,
    search = '',
    range = false,
    mod,
    hook,
    metric,
    minimumUs = 0,
  }: Partial<Query> = {},
) {
  const groups = new Map<string, Row>();

  function add(
    m: Metric,
    calls: number,
    errors: number,
    inclusive: number,
    exclusive: number,
    maximum: number,
  ) {
    if (
      !matches(m, search) ||
      (mod !== undefined && m.mod !== mod) ||
      (hook !== undefined &&
        m.callback_id !== hook &&
        m.callback_name !== hook) ||
      (metric !== undefined && m.id !== metric)
    ) {
      return;
    }
    const key =
      mode === 'mods' ? m.mod : mode === 'hooks' ? m.callback_id : String(m.id);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label:
          mode === 'mods'
            ? m.mod
            : mode === 'hooks'
              ? m.callback_name || m.callback_id
              : `${m.mod} / ${m.callback_name || m.callback_id}`,
        mod: m.mod,
        metric: mode === 'callbacks' ? m : null,
        calls: 0,
        errors: 0,
        inclusive: 0,
        exclusive: 0,
        maximum: 0,
      });
    }
    const r = groups.get(key)!;
    r.calls += calls;
    r.errors += errors;
    r.inclusive += inclusive;
    r.exclusive += exclusive;
    r.maximum = Math.max(r.maximum, maximum);
  }

  if (range || minimumUs > 0) {
    for (const e of model.events) {
      if (
        (!range || (e.start >= start && e.start < end)) &&
        e.duration * 1000 >= minimumUs
      ) {
        add(
          model.metrics.get(e.metric)!,
          1,
          +e.error,
          e.duration,
          e.self,
          e.duration,
        );
      }
    }
  } else {
    for (const m of model.metrics.values()) {
      add(
        m,
        m.calls,
        m.errors,
        m.inclusive_ns / 1e6,
        m.exclusive_ns / 1e6,
        m.max_ns / 1e6,
      );
    }
  }
  return [...groups.values()];
}

function visible(lane: NormalizedLane, start: number, end: number) {
  // Same-depth synchronous callbacks do not overlap; their ends are ordered.
  let lo = 0;
  let hi = lane.events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const e = lane.events[mid];
    if (e.start + e.duration < start) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const found: TraceEvent[] = [];
  for (let i = lo; i < lane.events.length && lane.events[i].start <= end; i++) {
    found.push(lane.events[i]);
  }
  return found;
}

function chromeTrace(model: Model) {
  if (!model.events.length) {
    throw Error('Nagranie nie zawiera zdarzeń osi czasu.');
  }
  const pid = model.document.pid || 1;
  const traceEvents: ChromeEvent[] = [
    {
      ph: 'M',
      name: 'process_name',
      pid,
      tid: 0,
      args: { name: 'Isaac / callback profiler' },
    },
  ];
  for (const thread of new Set(model.events.map((e) => e.thread))) {
    traceEvents.push({
      ph: 'M',
      name: 'thread_name',
      pid,
      tid: thread,
      args: { name: 'Lua callbacks' },
    });
  }
  for (const e of model.events) {
    const m = model.metrics.get(e.metric)!;
    traceEvents.push({
      ph: 'X',
      cat: m.mod,
      name: m.callback_name || m.callback_id,
      pid,
      tid: e.thread,
      ts: e.start * 1000,
      dur: e.duration * 1000,
      args: {
        mod: m.mod,
        source: m.source,
        line: m.line,
        self_us: e.self * 1000,
        error: e.error,
        metric_id: m.id,
      },
    });
  }
  return {
    traceEvents,
    displayTimeUnit: 'ms',
    isaacprof: {
      dropped_events: model.document.timeline?.dropped_events || 0,
      filtered_events: model.document.timeline?.filtered_events || 0,
      limitations: model.document.limitations || [],
    },
  };
}

const api = { decode, parse, rank, visible, matches, chromeTrace };

export default api;
