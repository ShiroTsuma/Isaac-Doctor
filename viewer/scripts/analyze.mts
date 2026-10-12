import { frameDetail } from '../src/frame-detail.ts';
import { presentationCapture } from '../src/presentation.ts';
import { instructionCapture } from '../src/instruction-samples.ts';
import { nativeWaitCapture } from '../src/native-waits.ts';
import type { FrameCost } from '../src/frame-detail.ts';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { CaptureFile } from './capture-file.mts';
import { recordingTimestamp } from '../src/recording-files.ts';
import { StreamCapture } from '../src/stream.ts';
import {
  eventsCapture,
  framesCapture,
  matchesQuery,
  rankCapture,
  summaryCapture,
  treeCapture,
} from '../src/analysis.ts';
import { diagnoseCapture } from '../src/diagnosis.ts';
import { matchSources } from '../src/source-files.ts';
import type {
  Metric,
  Query,
  Row,
  Telemetry,
  TraceEvent,
} from '../src/types.ts';

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

const commands = [
  'list',
  'info',
  'report',
  'diagnose',
  'summary',
  'rank',
  'metrics',
  'events',
  'frames',
  'frame',
  'tree',
  'markers',
  'telemetry',
  'presentation',
  'waits',
  'samples',
  'source',
  'screenshots',
  'screenshot',
  'verify',
  'prepare',
  'serve',
] as const;
type Command = (typeof commands)[number];
interface Options {
  command: Command;
  capture: string;
  start?: number;
  end?: number;
  top: number;
  depth: number;
  children: number;
  group: Query['mode'];
  sort: string;
  ascending: boolean;
  search: string;
  mod?: string;
  hook?: string;
  metric?: number;
  errorsOnly: boolean;
  minimumUs: number;
  clock: 1 | 2;
  summaryOnly: boolean;
  mods?: string;
  sourceFile?: string;
  before: number;
  after: number;
  samples: number;
  index: number;
  frameID?: number;
  output?: string;
  maxReadMiB: number;
  format: 'json' | 'table';
  write?: boolean;
  nonInteractive?: boolean;
  windowMs?: number;
}
const commonOptions = ['--format', '--max-read-mib', '--non-interactive'];
const range = ['--start-ms', '--end-ms'];
const filters = ['--search', '--mod', '--hook', '--metric'];
const ranking = ['--top', '--sort', '--ascending', '--descending'];
const allowed: Record<Command, string[]> = {
  list: ['--top'],
  info: [],
  diagnose: [...range, '--top', '--clock', '--window-ms'],
  report: [...range, ...filters, '--top', '--minimum-us', '--summary-only'],
  summary: range,
  rank: [...range, ...filters, ...ranking, '--group', '--depth', '--children'],
  metrics: [...range, ...filters, ...ranking, '--errors-only'],
  events: [...range, ...filters, ...ranking, '--minimum-us', '--errors-only'],
  frames: [
    ...range,
    ...ranking,
    '--clock',
    '--minimum-us',
    '--summary-only',
    '--search',
  ],
  frame: ['--id', '--clock', '--top'],
  tree: [...range, ...filters, ...ranking, '--depth', '--children'],
  markers: [...range, '--top'],
  telemetry: [...range, '--samples', '--top'],
  presentation: [...range, ...ranking],
  waits: [...range, '--top'],
  samples: [...range, '--top'],
  source: ['--metric', '--mods', '--source-file', '--before', '--after'],
  screenshots: [...range, '--top'],
  screenshot: ['--index', '--output'],
  verify: [],
  prepare: ['--write'],
  serve: [],
};
const help = `IsaacProf headless analysis (Node x64; no browser or game process required)
Usage: isaacprof-cli COMMAND CAPTURE.isaacprof [options]
       isaacprof-cli --describe  (machine-readable command capabilities)
Commands: ${commands.join(', ')}
  list FOLDER      Available recordings sorted newest first (filesystem metadata only)
  info/report      Channels, coverage, environment / bounded diagnostic snapshot
  diagnose         One raw pass: typical/slow cohorts, callback increases and time windows
  rank             Mod -> hook -> function rankings; native totals or retained range
  events/tree      Exact retained calls and ancestry (select a range for large traces)
  frames/summary   Slowest 500 intervals / FPS, UPS and percentiles
  presentation    SwapBuffers intervals, render state and native waits
  samples         Instruction snapshots, wait occupancy and sampler pause cost
  waits           Native Sleep/wait spans, APIs and call-site rankings
  frame --id N     Matched reference comparison and callback breakdown of one interval
  source           Lua context: --metric ID --mods FOLDER [--source-file FILE]
  screenshots      Screenshot timestamps/dimensions; screenshot exports one PNG
  verify           Verify all native block headers and payload CRCs (reads entire trace)
  prepare --write  Save binary statistics and full-session timeline LOD in the same file
  serve            JSONL stdin/stdout queries against one open capture; retains cache
Options:
  --non-interactive          Suppress progress; clean JSON stdout/stderr for automation
  --start-ms N --end-ms N      Start-inclusive/end-exclusive membership by call start
  --depth 0..8 --children 0..100   Bounded grouping/tree expansion (default 2 / 5)
  --group mods|hooks|callbacks --sort FIELD --ascending|--descending --top 1..500
  --search TEXT --mod NAME --hook NAME_OR_ID --metric ID --errors-only
  --minimum-us N              Event duration / frame interval threshold; 1000 = 1 ms
  --clock render|update --summary-only   Skip frame callback attribution
  --window-ms 100..60000      Diagnose windows (default 5000; at most 300 windows)
  --mods FOLDER --source-file FILE --before 0..100 --after 0..100
  --samples 1..1000            Number of telemetry rows returned (totals use all samples)
  --index N --output FILE.png  Explicit screenshot export; never overwrites an existing file
  --max-read-mib N             Optional total I/O budget, including initial load
  --format json|table         Default JSON, with schema, units and I/O diagnostics
Capture files are read-only. Full totals include filtered calls; range details contain retained calls.
Self time includes native APIs and subtracts nested instrumented callbacks. FPS is callback cadence.
Serve request: {"id":1,"command":"rank","args":["--start-ms","1000","--end-ms","1100","--group","hooks"]}
`;

function number(
  value: string,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
  whole = false,
) {
  const n = Number(value);
  if (
    !value.trim() ||
    !Number.isFinite(n) ||
    n < 0 ||
    n > maximum ||
    (whole && !Number.isSafeInteger(n))
  ) {
    throw Error(`Invalid ${name}: ${value}`);
  }
  return n;
}

function choice<T extends string>(
  value: string,
  values: readonly T[],
  name: string,
): T {
  if (!values.includes(value as T)) {
    throw Error(`Invalid ${name}; choose ${values.join(', ')}.`);
  }
  return value as T;
}

function parse(args: string[]): Options {
  const command = choice(args[0] ?? '', commands, 'command');
  const capture = args[1];
  if (!capture || capture.startsWith('--')) {
    throw Error('Specify a capture path after the command.');
  }
  const result: Options = {
    command,
    capture,
    top: 20,
    depth: 2,
    children: 5,
    group: 'mods',
    sort: '',
    ascending: command === 'events' && !args.includes('--sort'),
    search: '',
    errorsOnly: false,
    minimumUs: 0,
    clock: 2,
    summaryOnly: false,
    before: 3,
    after: 20,
    samples: 100,
    index: 0,
    maxReadMiB: Infinity,
    format: 'json',
  };
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const option = args[i];
    if (seen.has(option)) {
      throw Error(`Duplicate option: ${option}`);
    }
    seen.add(option);
    if (option === '--ascending') {
      result.ascending = true;
      continue;
    }
    if (option === '--descending') {
      result.ascending = false;
      continue;
    }
    if (option === '--errors-only') {
      result.errorsOnly = true;
      continue;
    }
    if (option === '--summary-only') {
      result.summaryOnly = true;
      continue;
    }
    if (option === '--write') {
      result.write = true;
      continue;
    }
    if (option === '--non-interactive') {
      result.nonInteractive = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined) {
      throw Error(`Missing value for ${option}.`);
    }
    switch (option) {
      case '--start-ms':
        result.start = number(value, option);
        break;
      case '--end-ms':
        result.end = number(value, option);
        break;
      case '--top':
        result.top = number(value, option, 500, true);
        if (!result.top) {
          throw Error('--top must be positive.');
        }
        break;
      case '--depth':
        result.depth = number(value, option, 8, true);
        break;
      case '--children':
        result.children = number(value, option, 100, true);
        break;
      case '--group':
        result.group = choice(value, ['mods', 'hooks', 'callbacks'], option);
        break;
      case '--sort':
        result.sort = value;
        break;
      case '--search':
        result.search = value;
        break;
      case '--mod':
        result.mod = value;
        break;
      case '--hook':
        result.hook = value;
        break;
      case '--metric':
        result.metric = number(value, option, 0xffffffff, true);
        break;
      case '--minimum-us':
        result.minimumUs = number(value, option, 10000000, true);
        break;
      case '--clock':
        result.clock =
          choice(value, ['render', 'update'], option) === 'render' ? 2 : 1;
        break;
      case '--mods':
        result.mods = value;
        break;
      case '--source-file':
        result.sourceFile = value;
        break;
      case '--before':
        result.before = number(value, option, 100, true);
        break;
      case '--after':
        result.after = number(value, option, 100, true);
        break;
      case '--window-ms':
        result.windowMs = number(value, option, 60000, true);
        if (result.windowMs < 100) {
          throw Error('--window-ms must be at least 100.');
        }
        break;
      case '--samples':
        result.samples = number(value, option, 1000, true);
        if (!result.samples) {
          throw Error('--samples must be positive.');
        }
        break;
      case '--id':
        result.frameID = number(value, option, 0xffffffff, true);
        break;
      case '--index':
        result.index = number(value, option, 239, true);
        break;
      case '--output':
        result.output = value;
        break;
      case '--max-read-mib':
        result.maxReadMiB = number(value, option);
        break;
      case '--format':
        result.format = choice(value, ['json', 'table'], option);
        break;
      default:
        throw Error(`Unknown option: ${option}`);
    }
  }
  for (const option of seen) {
    if (!commonOptions.includes(option) && !allowed[command].includes(option)) {
      throw Error(`${option} is not supported by ${command}.`);
    }
  }
  if (command === 'frame' && result.frameID === undefined) {
    throw Error('frame requires --id from the frames/diagnose output.');
  }
  if (command === 'serve' && result.format !== 'json') {
    throw Error('Serve replies are always JSON.');
  }
  if (command === 'prepare' && !result.write) {
    throw Error(
      'prepare requires --write to update the optional analysis in this recording.',
    );
  }
  if (seen.has('--ascending') && seen.has('--descending')) {
    throw Error('Choose one sort direction.');
  }
  if (result.errorsOnly && !['events', 'metrics'].includes(command)) {
    throw Error('--errors-only is supported for events and metrics.');
  }
  if (result.minimumUs && !['events', 'frames', 'report'].includes(command)) {
    throw Error(
      '--minimum-us applies to events or frame intervals, not aggregate rankings.',
    );
  }
  if (result.output && command !== 'screenshot') {
    throw Error(
      '--output is reserved for screenshot export; redirect stdout to save reports.',
    );
  }
  return result;
}

function query(stream: StreamCapture, options: Options): Query {
  const start = options.start ?? 0;
  const end = options.end ?? stream.duration;
  if (
    (start >= end && !(start === 0 && end === 0 && stream.duration === 0)) ||
    end > stream.duration + 1e-6
  ) {
    throw Error(
      `Range must satisfy 0 <= start < end <= ${stream.duration} ms.`,
    );
  }
  return {
    start,
    end,
    range: options.start !== undefined || options.end !== undefined,
    mode: options.group,
    sort: choice(
      options.sort || 'exclusive',
      ['exclusive', 'inclusive', 'maximum', 'calls', 'errors', 'label'],
      'rank sort',
    ),
    descending: !options.ascending,
    search: options.search,
    mod: options.mod,
    hook: options.hook,
    metric: options.metric,
  };
}

function metricIdentity(metric: Metric) {
  return {
    id: metric.id,
    mod: metric.mod,
    hook: metric.callback_name || metric.callback_id,
    hook_id: metric.callback_id,
    function: metric.function,
    source: metric.source,
    line: metric.line,
  };
}

function wireMetric(metric: Metric) {
  return {
    ...metricIdentity(metric),
    calls: metric.calls,
    errors: metric.errors,
    self_ms: metric.exclusive_ns / 1e6,
    total_ms: metric.inclusive_ns / 1e6,
    maximum_ms: metric.max_ns / 1e6,
    average_ms: metric.mean_ns / 1e6,
  };
}

function wireRows(
  rows: Row[],
  options: Options,
  depth = options.depth,
): unknown[] {
  let budget = 1000;
  const visit = (items: Row[], level: number, limit: number): unknown[] => {
    const result: unknown[] = [];
    for (const row of items.slice(0, limit)) {
      if (budget <= 0) {
        break;
      }
      budget--;
      const children =
        level > 0 && row.children
          ? visit(row.children, level - 1, options.children)
          : undefined;
      result.push({
        key: row.key,
        label: row.label,
        mod: row.mod,
        metric_id: row.metric?.id,
        source: row.metric?.source,
        line: row.metric?.line,
        calls: row.calls,
        errors: row.errors,
        self_ms: row.exclusive,
        total_ms: row.inclusive,
        maximum_ms: row.maximum,
        average_ms: row.calls ? row.inclusive / row.calls : 0,
        children_count: row.children?.length,
        children,
        truncated:
          !!row.children &&
          (!children || children.length < row.children.length),
      });
    }
    return result;
  };
  return visit(rows, depth, options.top);
}

function wireEvent(event: TraceEvent, stream: StreamCapture) {
  const metric = stream.metrics.get(event.metric)!;
  return {
    id: event.span,
    parent_id: event.parent,
    metric_id: event.metric,
    mod: metric.mod,
    hook: metric.callback_name || metric.callback_id,
    source: metric.source,
    line: metric.line,
    start_ms: event.start,
    duration_ms: event.duration,
    self_ms: event.self,
    thread: event.thread,
    depth: event.depth,
    error: event.error,
  };
}

const channelNames: Record<number, string> = {
  17: 'native_waits',
  18: 'render_state',
  19: 'native_modules',
  20: 'instruction-samples',
  21: 'sampling-stats',
  16: 'presentation',
  1: 'aggregate_snapshots',
  2: 'callbacks',
  3: 'screenshots',
  4: 'loss_intervals',
  5: 'index',
  6: 'timeline_previews',
  7: 'frame_intervals',
  8: 'process_counters',
  9: 'lua_heap',
  10: 'run_markers',
  11: 'environment',
  12: 'room_context',
  13: 'profiler_overhead',
  14: 'lua_errors',
  15: 'capture_configuration',
};

function info(stream: StreamCapture, file: CaptureFile) {
  const channels = new Map<
    number,
    {
      type: number;
      name: string;
      blocks: number;
      records: number;
      payload_bytes: number;
    }
  >();
  for (const block of stream.blocks) {
    let channel = channels.get(block.type);
    if (!channel) {
      channel = {
        type: block.type,
        name: channelNames[block.type] ?? 'unknown_optional',
        blocks: 0,
        records: 0,
        payload_bytes: 0,
      };
      channels.set(block.type, channel);
    }
    channel.blocks++;
    channel.records += [1, 3, 11, 15].includes(block.type) ? 1 : block.count;
    channel.payload_bytes += block.bytes;
  }
  const d = stream.document;
  return {
    configuration: d.configuration ?? null,
    file_bytes: file.size,
    native_bytes: stream.sourceSize,
    duration_ms: stream.duration,
    pid: d.pid,
    architecture: d.architecture,
    profiler_version: d.profiler_version,
    lua_version: d.lua_version,
    lua_module: d.lua,
    executable: d.exe,
    complete: d.complete,
    registered_metrics: d.registered_metrics,
    retained_events: stream.count,
    dropped_calls: d.dropped_calls,
    dropped_events: d.timeline.dropped_events,
    filtered_events: d.timeline.filtered_events,
    minimum_duration_us: d.timeline.minimum_duration_ns / 1000,
    skipped_coroutines: d.skipped_coroutine_calls,
    analysis: stream.analysisStored ? 'stored' : 'not_stored',
    timeline_overview: stream.analysis?.overview
      ? {
          columns: stream.analysis.overview.columns,
          events: stream.analysis.overview.events.length,
        }
      : null,
    validation:
      'index and requested payloads; use verify for all native payload CRCs',
    channels: [...channels.values()],
    loss_intervals: d.losses,
    limitations: d.limitations,
  };
}

function wireSummary(summary: Awaited<ReturnType<typeof summaryCapture>>) {
  const clock = (value: typeof summary.render) => ({
    ...value,
    available: value.count > 0,
    rate: value.count ? value.rate : null,
    mean: value.count ? value.mean : null,
    p50: value.count ? value.p50 : null,
    p95: value.count ? value.p95 : null,
    p99: value.count ? value.p99 : null,
    maximum: value.count ? value.maximum : null,
  });
  return { render: clock(summary.render), update: clock(summary.update) };
}

function inventoryView(inventory: Telemetry['inventory'], limit: number) {
  if (!inventory) {
    return null;
  }
  const { sources, ...environment } = inventory;
  return {
    ...environment,
    source_count: sources.length,
    resolved_sources: sources.filter((s) => s.status === 1).length,
    sources: sources.slice(0, limit),
    sources_truncated: sources.length > limit,
  };
}

function telemetryStats(data: Telemetry) {
  let processTime = 0;
  let processCPU = 0;
  let threadTime = 0;
  let threadCPU = 0;
  let processMax: number | null = null;
  let threadMax: number | null = null;
  for (let i = 1; i < data.counters.length; i++) {
    const a = data.counters[i - 1];
    const b = data.counters[i];
    const duration = b.time - a.time;
    if (duration <= 0) {
      continue;
    }
    const process =
      b.processUser + b.processKernel - a.processUser - a.processKernel;
    const thread =
      b.threadUser + b.threadKernel - a.threadUser - a.threadKernel;
    if (a.valid & 2 && b.valid & 2 && process >= 0) {
      processTime += duration;
      processCPU += process;
      processMax = Math.max(processMax ?? 0, process / duration / 100);
    }
    if (a.valid & 4 && b.valid & 4 && a.thread === b.thread && thread >= 0) {
      threadTime += duration;
      threadCPU += thread;
      threadMax = Math.max(threadMax ?? 0, thread / duration / 100);
    }
  }
  const validMemory = data.counters.filter((s) => (s.valid & 1) !== 0);
  return {
    counter_samples: data.counters.length,
    heap_samples: data.heap.length,
    working_set_sample_max_bytes: validMemory.length
      ? Math.max(...validMemory.map((s) => s.workingSet))
      : null,
    private_commit_sample_max_bytes: validMemory.length
      ? Math.max(...validMemory.map((s) => s.privateBytes))
      : null,
    lua_heap_sample_max_bytes: data.heap.length
      ? Math.max(...data.heap.map((s) => s.bytes))
      : null,
    process_mean_cpu_percent_one_core: processTime
      ? processCPU / processTime / 100
      : null,
    process_max_sample_cpu_percent_one_core: processMax,
    lua_thread_mean_cpu_percent_one_core: threadTime
      ? threadCPU / threadTime / 100
      : null,
    lua_thread_max_sample_cpu_percent_one_core: threadMax,
    delta_observation_ms: processTime,
    includes_preceding_baseline: true,
  };
}

async function source(stream: StreamCapture, options: Options) {
  if (options.metric === undefined) {
    throw Error(
      'source requires --metric ID. Use metrics or rank --group callbacks to find IDs.',
    );
  }
  const metric = stream.metrics.get(options.metric);
  if (!metric) {
    throw Error('Unknown metric ID.');
  }
  if (!options.mods) {
    throw Error(
      'source requires --mods pointing to a local mod, mods, game or repository folder.',
    );
  }
  const root = path.resolve(options.mods);
  const candidates: { path: string }[] = [];
  let entries = 0;

  async function walk(dir: string, depth = 0) {
    if (depth > 32) {
      throw Error('Source folder exceeds maximum nesting depth.');
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > 100000) {
        throw Error(
          'Source folder exceeds 100,000 entries. Select a narrower mod folder.',
        );
      }
      if (
        entry.isSymbolicLink() ||
        ['.git', 'node_modules', 'build', 'dist'].includes(entry.name)
      ) {
        continue;
      }
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lua')) {
        candidates.push({ path: target });
      }
    }
  }

  await walk(root);
  const matches = matchSources(metric.source, candidates);
  const selected = options.sourceFile
    ? matches.find(
        (item) =>
          path.resolve(item.path).toLowerCase() ===
          path.resolve(options.sourceFile!).toLowerCase(),
      )
    : matches.length === 1
      ? matches[0]
      : undefined;
  if (!selected) {
    return {
      status: matches.length ? 'ambiguous' : 'not_found',
      metric: wireMetric(metric),
      candidates: matches.map((item) => item.path),
      hint: 'Ambiguous matches require --source-file with one of these paths.',
    };
  }
  const size = (await stat(selected.path)).size;
  if (size > 4 * 1024 * 1024) {
    throw Error('Source file exceeds 4 MiB.');
  }
  const bytes = await readFile(selected.path);
  const lines = bytes.toString('utf8').split(/\r?\n/);
  const line = Math.max(1, Math.min(lines.length, metric.line));
  const start = Math.max(1, line - options.before);
  const end = Math.min(lines.length, line + options.after);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const inventory = (await stream.telemetry(0, stream.duration)).inventory;
  const captured = inventory?.sources.find(
    (item) =>
      item.mod === metric.mod && item.source === metric.source && item.sha256,
  );
  return {
    status: 'found',
    metric: wireMetric(metric),
    path: selected.path,
    sha256: hash,
    captured_sha256: captured?.sha256,
    identity: captured
      ? captured.sha256 === hash
        ? 'matches_disk_snapshot'
        : 'differs_from_disk_snapshot'
      : 'capture_hash_unavailable',
    total_lines: lines.length,
    definition_line: metric.line,
    lines: lines.slice(start - 1, end).map((text, i) => ({
      line: start + i,
      text,
      definition: start + i === metric.line,
    })),
  };
}

async function screenshots(stream: StreamCapture, options: Options) {
  const result = [];
  let index = 0;
  for (const block of stream.blocks) {
    if (block.type === 3) {
      const id = index++;
      if (options.command === 'screenshot' && id !== options.index) {
        continue;
      }
      const payload = await stream.payload(block);
      const view = new DataView(payload);
      const time = view.getFloat64(0, true);
      if (
        options.command !== 'screenshot' &&
        (time / 1e6 < (options.start ?? 0) ||
          time / 1e6 >= (options.end ?? stream.duration))
      ) {
        continue;
      }
      if (
        view.byteLength < 28 ||
        view.getUint32(12, true) !== 1 ||
        view.getUint32(16, true) !== view.byteLength - 20
      ) {
        throw Error('Invalid screenshot layout.');
      }
      const png = new Uint8Array(payload, 20);
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => png[i] === n)) {
        throw Error('Invalid screenshot PNG.');
      }
      const row = {
        index: id,
        time_ms: time / 1e6,
        width: view.getUint16(8, true),
        height: view.getUint16(10, true),
        png_bytes: png.byteLength,
      };
      result.push(row);
      if (options.command === 'screenshot') {
        if (!options.output) {
          throw Error('screenshot requires --output FILE.png.');
        }
        await writeFile(options.output, png, { flag: 'wx' });
        return { ...row, path: path.resolve(options.output) };
      }
    }
  }
  if (options.command === 'screenshot') {
    throw Error(
      'Screenshot index not found. Use screenshots to list available images.',
    );
  }
  return { count: result.length, rows: result.slice(0, options.top) };
}

async function execute(
  stream: StreamCapture,
  file: CaptureFile,
  options: Options,
): Promise<unknown> {
  // Event, frame and presentation sorts have their own fields.
  const q = query(stream, {
    ...options,
    sort: ['events', 'frames', 'presentation'].includes(options.command)
      ? ''
      : options.sort,
  });
  switch (options.command) {
    case 'list':
      throw Error('list is available outside a capture session.');
    case 'info':
      return info(stream, file);
    case 'frame': {
      let selected;
      for await (const f of stream.intervals(0, stream.duration)) {
        if (f.kind === options.clock && f.id === options.frameID) {
          if (selected) {
            throw Error('Frame ID is ambiguous across threads.');
          }
          selected = f;
        }
      }
      if (!selected) {
        throw Error('Frame ID not found for this clock.');
      }
      const detail = await frameDetail(stream, selected);
      let count = 0;
      const wire = (rows: FrameCost[]): unknown[] =>
        rows.slice(0, options.top).flatMap((row) => {
          if (count++ >= 500) {
            return [];
          }
          return [
            {
              label: row.label,
              metric: row.metric
                ? metricIdentity(stream.metrics.get(row.metric)!)
                : null,
              self_ms: row.self,
              reference_self_ms: detail.baseline ? row.baselineSelf : null,
              extra_self_ms: detail.baseline
                ? row.self - row.baselineSelf
                : null,
              calls: row.calls,
              reference_calls: detail.baseline ? row.baselineCalls : null,
              ...(row.children ? { children: wire(row.children) } : {}),
            },
          ];
        });
      const delta =
        detail.baselineWall === null
          ? null
          : detail.frame.duration - detail.baselineWall;
      const self = detail.self - detail.baselineSelf;
      return {
        ...detail,
        costs: wire(detail.costs),
        extra_wall_ms: delta,
        extra_callback_self_ms: delta === null ? null : self,
        extra_unattributed_wall_ms: delta === null ? null : delta - self,
        group_limit: options.top,
        node_limit: 500,
      };
    }
    case 'diagnose':
      return diagnoseCapture(stream, {
        start: q.start,
        end: q.end,
        kind: options.clock,
        top: options.top,
        windowMs: options.windowMs,
      });
    case 'summary':
      return wireSummary(await summaryCapture(stream, q.start, q.end));
    case 'rank': {
      const result = await rankCapture(stream, q, options.top);
      return {
        ...result,
        rows: wireRows(result.rows, options),
        population: q.range
          ? 'retained_calls_by_start'
          : 'native_unfiltered_aggregates',
      };
    }
    case 'metrics': {
      const metrics = (
        q.range
          ? await stream.rankMetrics(q.start, q.end)
          : [...stream.metrics.values()]
      ).filter((m) => matchesQuery(m, q) && (!options.errorsOnly || m.errors));
      const field = (m: Metric) =>
        q.sort === 'calls'
          ? m.calls
          : q.sort === 'errors'
            ? m.errors
            : q.sort === 'maximum'
              ? m.max_ns
              : q.sort === 'inclusive'
                ? m.inclusive_ns
                : m.exclusive_ns;
      metrics.sort(
        (a, b) =>
          (q.descending ? -1 : 1) *
            (q.sort === 'label'
              ? `${a.mod}/${a.callback_name}/${a.source}`.localeCompare(
                  `${b.mod}/${b.callback_name}/${b.source}`,
                )
              : field(a) - field(b)) || a.id - b.id,
      );
      return {
        count: metrics.length,
        rows: metrics.slice(0, options.top).map(wireMetric),
      };
    }
    case 'events': {
      const sort = choice(
        options.sort || 'start',
        ['start', 'duration', 'self', 'depth', 'activity'],
        'event sort',
      );
      const result = await eventsCapture(
        stream,
        {
          ...q,
          sort,
          descending: !options.ascending,
          errorsOnly: options.errorsOnly,
        },
        options.top,
        options.minimumUs,
      );
      return {
        count: result.count,
        rows: result.rows.map((event) => wireEvent(event, stream)),
        sort,
        descending: !options.ascending,
      };
    }
    case 'frames': {
      if (options.mod || options.hook || options.metric !== undefined) {
        throw Error(
          'Frame attribution covers all callbacks. Use --search for the costliest activity, or rank the selected frame range.',
        );
      }
      const result = await framesCapture(
        stream,
        {
          kind: options.clock,
          start: q.start,
          end: q.end,
          minimumUs: options.minimumUs,
          search: options.search,
        },
        !options.summaryOnly,
        options.top,
      );
      const sort = choice(
        options.sort || 'duration',
        ['start', 'duration', 'self', 'calls'],
        'frame sort',
      );
      result.rows.sort(
        (a, b) =>
          (options.ascending ? 1 : -1) * (a[sort] - b[sort]) ||
          a.start - b.start,
      );
      return {
        ...result,
        available: result.count > 0,
        rate: result.count ? result.rate : null,
        mean: result.count ? result.mean : null,
        p50: result.count ? result.p50 : null,
        p95: result.count ? result.p95 : null,
        p99: result.count ? result.p99 : null,
        maximum: result.count ? result.maximum : null,
        rows: result.rows.slice(0, options.top).map((row) => ({
          id: row.id,
          start_ms: row.start,
          duration_ms: row.duration,
          self_ms: options.summaryOnly ? null : row.self,
          calls: options.summaryOnly ? null : row.calls,
          thread: row.thread,
          costliest_mod: options.summaryOnly ? null : row.worstMod,
          mod_self_ms: options.summaryOnly ? null : row.modSelf,
          costliest_metric:
            row.worstMetric === null
              ? null
              : metricIdentity(stream.metrics.get(row.worstMetric)!),
          metric_self_ms: options.summaryOnly ? null : row.metricSelf,
        })),
        attribution: !options.summaryOnly,
        selection: `slowest_${options.top}_then_sort_and_filter`,
        clock: options.clock === 2 ? 'render' : 'update',
      };
    }
    case 'tree': {
      if (!q.range && stream.count > 1000000) {
        throw Error(
          'For large recordings tree requires --start-ms / --end-ms. Start with report to find useful ranges.',
        );
      }
      const result = await treeCapture(stream, q, Math.min(1000, options.top));
      return {
        count: result.count,
        rows: wireRows(result.rows, options),
        node_limit: options.top,
      };
    }
    case 'markers': {
      const rows = (await stream.lifecycleMarkers())
        .filter((m) => m.time >= q.start && m.time < q.end)
        .map((m) => ({
          ...m,
          time_ms: m.time,
          kind_name: [
            '',
            'context',
            'run_start',
            'room_transition',
            'level_transition',
            'run_end',
            'game_exit',
          ][m.kind],
        }));
      return {
        count: rows.length,
        rows: rows.slice(0, options.top),
        identity: 'observed_transition_ordinals_not_game_ids',
      };
    }
    case 'samples':
      return instructionCapture(stream, q.start, q.end, options.top);
    case 'waits':
      return nativeWaitCapture(stream, q.start, q.end, options.top);
    case 'presentation': {
      const sort = choice(
        options.sort || 'duration',
        ['start', 'duration', 'swap', 'readback', 'outside', 'cycles'],
        'presentation sort',
      );
      return presentationCapture(stream, {
        start: q.start,
        end: q.end,
        sort,
        descending: !options.ascending,
        limit: options.top,
      });
    }
    case 'telemetry': {
      const data = await stream.telemetry(q.start, q.end);
      return {
        summary: telemetryStats(data),
        inventory: inventoryView(data.inventory, options.top),
        counters: data.counters.slice(0, options.samples),
        heap: data.heap.slice(0, options.samples),
        markers: data.markers.slice(0, options.samples),
        context: data.context?.slice(0, options.samples),
        overhead: data.overhead?.slice(0, options.samples),
        errors: data.errors?.slice(0, options.top),
        sample_limit: options.samples,
      };
    }
    case 'source':
      return source(stream, options);
    case 'screenshots':
    case 'screenshot':
      return screenshots(stream, options);
    case 'verify': {
      let blocks = 0;
      let payloadBytes = 0;
      stream.onProgress({
        stage: 'Verifying capture',
        completed: 0,
        total: stream.blocks.length,
        percent: 0,
      });
      for (const block of stream.blocks) {
        const header = new DataView(
          await file.slice(block.offset, block.offset + 48).arrayBuffer(),
        );
        if (
          header.getUint32(0, true) !== 0x4b4e4843 ||
          header.getUint16(4, true) !== block.type ||
          header.getUint16(6, true) !== block.version ||
          header.getUint32(8, true) !== block.bytes ||
          header.getUint32(12, true) !== block.count ||
          header.getBigUint64(16, true) !== BigInt(blocks) ||
          header.getBigUint64(24, true) !== BigInt(block.minimum) ||
          header.getBigUint64(32, true) !== BigInt(block.maximum) ||
          header.getUint32(40, true) !== block.crc
        ) {
          throw Error(`Header/index mismatch at ${block.offset}.`);
        }
        await stream.payload(block);
        blocks++;
        payloadBytes += block.bytes;
        if (blocks % 256 === 0 || blocks === stream.blocks.length) {
          stream.onProgress({
            stage: 'Verifying capture',
            completed: blocks,
            total: stream.blocks.length,
            percent: Math.floor((blocks / stream.blocks.length) * 100),
          });
        }
      }
      return {
        blocks,
        payload_bytes: payloadBytes,
        scope:
          'all indexed native headers and payload CRCs; derived appendix independently validated on load',
        complete: stream.document.complete,
      };
    }
    case 'report': {
      const data = await stream.telemetry(q.start, q.end);
      const frames = await framesCapture(
        stream,
        {
          kind: 2,
          start: q.start,
          end: q.end,
          minimumUs: options.minimumUs,
          search: '',
        },
        !options.summaryOnly,
        Math.min(options.top, 10),
      );
      const mods = await rankCapture(
        stream,
        { ...q, mode: 'mods' },
        options.top,
      );
      const hooks = await rankCapture(
        stream,
        { ...q, mode: 'hooks' },
        options.top,
      );
      const callbacks = await rankCapture(
        stream,
        { ...q, mode: 'callbacks' },
        options.top,
      );
      const summary = await summaryCapture(stream, q.start, q.end);
      return {
        recording: info(stream, file),
        summary: wireSummary(summary),
        telemetry: telemetryStats(data),
        inventory: inventoryView(data.inventory, options.top),
        mods: wireRows(mods.rows, options, 0),
        hooks: wireRows(hooks.rows, options, 0),
        hot_callbacks: wireRows(callbacks.rows, options, 0),
        errors: [...stream.metrics.values()]
          .filter((m) => m.errors && matchesQuery(m, q))
          .sort((a, b) => b.errors - a.errors)
          .slice(0, options.top)
          .map(wireMetric),
        errors_population: 'native_session_aggregates',
        markers: data.markers.slice(0, options.top),
        marker_count: data.markers.length,
        slow_render_intervals: frames.rows.slice(0, options.top).map((f) => ({
          id: f.id,
          start_ms: f.start,
          duration_ms: f.duration,
          thread: f.thread,
          markers: data.markers.filter(
            (m) => m.time >= f.start && m.time < f.start + f.duration,
          ),
          retained_callback_self_ms: options.summaryOnly ? null : f.self,
          calls: options.summaryOnly ? null : f.calls,
          costliest_mod: options.summaryOnly ? null : f.worstMod,
          mod_self_ms: options.summaryOnly ? null : f.modSelf,
          metric_self_ms: options.summaryOnly ? null : f.metricSelf,
          costliest_metric:
            options.summaryOnly || f.worstMetric === null
              ? null
              : metricIdentity(stream.metrics.get(f.worstMetric)!),
          attribution: !options.summaryOnly,
        })),
        suggested_queries: frames.rows.slice(0, 5).map((f) => ({
          command: 'rank',
          args: [
            '--start-ms',
            String(f.start),
            '--end-ms',
            String(Math.min(stream.duration, f.start + f.duration)),
            '--group',
            'mods',
          ],
        })),
        interpretation: [
          'Raw/range attribution omits filtered and dropped events; session aggregates include short filtered calls.',
          'Frame interval includes waiting, engine work and scheduling; high interval duration alone does not establish a mod cause.',
          'Process/VM memory is not per-mod memory; CPU percent uses one logical core as 100%.',
          'Structured Lua error messages and stacks are available in telemetry when recorded.',
          'Source hashes describe a bounded disk snapshot, not proof of the exact loaded Lua code.',
        ],
      };
    }
    case 'prepare':
      throw Error(
        'prepare is available only outside a read-only capture session.',
      );
    case 'serve':
      throw Error('Nested serve is unavailable.');
  }
}

function table(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return JSON.stringify(result);
  }
  const value = result as Record<string, unknown>;
  const rows = value.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return JSON.stringify(result, null, 2);
  }
  const display = (value: unknown) =>
    typeof value === 'number'
      ? Number.isInteger(value)
        ? String(value)
        : value.toFixed(3)
      : typeof value === 'string'
        ? value
        : typeof value === 'boolean'
          ? String(value)
          : '';
  const records = rows as Record<string, unknown>[];
  const keys = Object.keys(records[0]).filter(
    (key) => key !== 'key' && records.some((row) => display(row[key])),
  );
  const widths = keys.map((key) =>
    Math.min(
      80,
      Math.max(key.length, ...records.map((row) => display(row[key]).length)),
    ),
  );
  const line = (values: string[]) =>
    values
      .map((value, i) => value.slice(0, widths[i]).padEnd(widths[i]))
      .join('  ');
  const output = [line(keys)];

  function visit(row: Record<string, unknown>, depth = 0) {
    output.push(
      line(
        keys.map(
          (key) =>
            (key === 'label' ? '  '.repeat(depth) : '') + display(row[key]),
        ),
      ),
    );
    if (Array.isArray(row.children)) {
      for (const child of row.children as Record<string, unknown>[]) {
        visit(child, depth + 1);
      }
    }
  }

  for (const row of records) {
    visit(row);
  }
  return output.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--describe') {
    console.log(
      JSON.stringify(
        {
          schema: 'isaacprof-cli-capabilities/v1',
          runtime: { node: process.version, architecture: process.arch },
          capture_versions: [3],
          default_format: 'json',
          capture_access: 'read_only_except_explicit_prepare_write',
          network: false,
          commands: commands.map((command) => ({
            command,
            options: [...commonOptions, ...allowed[command]],
            requires_directory: command === 'list',
            writes:
              command === 'screenshot'
                ? 'explicit new PNG file'
                : command === 'prepare'
                  ? 'optional analysis appendix in original capture; requires --write'
                  : 'none',
          })),
          limits: {
            top: 500,
            expanded_nodes: 1000,
            diagnosis_intervals: 200000,
            diagnosis_cost_entries: 500000,
            diagnosis_windows: 300,
            source_bytes: 4194304,
            request_line_bytes: 65536,
            telemetry_rows: 1000,
            cache_payload_bytes: 67108864,
          },
          session_request: {
            id: 'string | integer | null',
            command: 'read-only query command',
            args: 'string[]',
          },
          units: {
            timings: 'ms',
            duration_threshold: 'us',
            memory: 'bytes',
            cumulative_cpu: '100ns',
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!args.length || args.includes('--help') || args[0] === 'help') {
    console.log(help);
    return;
  }
  const options = parse(args);
  const begin = performance.now();
  if (options.command === 'list') {
    const entries = (
      await readdir(options.capture, { withFileTypes: true })
    ).filter(
      (entry) =>
        entry.isFile() && entry.name.toLowerCase().endsWith('.isaacprof'),
    );
    if (entries.length > 10000) {
      throw Error('Capture directory exceeds 10,000 recordings.');
    }
    const rows = [];
    for (let at = 0; at < entries.length; at += 32) {
      const batch = await Promise.all(
        entries.slice(at, at + 32).map(async (entry) => {
          const target = path.resolve(options.capture, entry.name);
          const info = await stat(target);
          const captured = recordingTimestamp(entry.name);
          return {
            name: entry.name,
            path: target,
            bytes: info.size,
            modified: info.mtime.toISOString(),
            recorded_at_utc:
              captured === null ? null : new Date(captured).toISOString(),
            sort_time_utc: new Date(captured ?? info.mtimeMs).toISOString(),
            time_source:
              captured === null ? 'filesystem_modified' : 'filename_utc',
          };
        }),
      );
      rows.push(...batch);
    }
    rows.sort(
      (a, b) =>
        b.sort_time_utc.localeCompare(a.sort_time_utc) ||
        a.path.localeCompare(b.path),
    );
    const result = { count: rows.length, rows: rows.slice(0, options.top) };
    console.log(
      options.format === 'table'
        ? table(result)
        : JSON.stringify(
            {
              schema: 'isaacprof-cli/v1',
              ok: true,
              command: 'list',
              result,
              diagnostics: {
                elapsed_ms: performance.now() - begin,
                read_bytes: 0,
              },
            },
            null,
            2,
          ),
    );
    return;
  }
  const file = await CaptureFile.open(
    options.capture,
    options.maxReadMiB * 1048576,
    options.command === 'prepare',
  );
  let progressWidth = 0;
  let lastProgress = -Infinity;
  const showProgress = (
    progress: import('../src/stream.ts').ProcessingProgress,
  ) => {
    if (
      options.nonInteractive ||
      !process.stderr.isTTY ||
      options.command === 'serve'
    ) {
      return;
    }
    const now = performance.now();
    if (now - lastProgress < 250 && progress.percent !== 100) {
      return;
    }
    lastProgress = now;
    const line = `${progress.stage}: ${progress.percent}% (${progress.completed.toLocaleString('en-US')}/${progress.total.toLocaleString('en-US')} blocks)`;
    process.stderr.write('\r' + line.padEnd(progressWidth));
    progressWidth = line.length;
  };
  const finishProgress = () => {
    if (progressWidth) {
      process.stderr.write('\n');
      progressWidth = 0;
    }
  };
  try {
    const header = new DataView(await file.slice(0, 12).arrayBuffer());
    if (
      new TextDecoder().decode(header.buffer.slice(0, 8)) !== 'ISAACPRF' ||
      header.getUint32(8, true) !== 3
    ) {
      throw Error(
        'Headless analysis supports streaming v3 captures. Legacy v1/v2 remain supported by the viewer and native analyze.exe.',
      );
    }
    const stream = new StreamCapture(file);
    stream.onProgress = showProgress;
    await stream.load({ screenshots: false, overview: false });
    if (options.command === 'prepare') {
      const start = performance.now();
      const alreadyStored =
        stream.analysisStored && !!stream.analysis?.overview;
      let bytes = file.size;
      let appendixBytes = file.size - stream.sourceSize;
      if (!alreadyStored) {
        const section = await stream.appendix();
        appendixBytes = section.appendix.length;
        showProgress({
          stage: 'Saving prepared analysis',
          completed: 0,
          total: 1,
          percent: 0,
        });
        bytes = await file.writeAppendix(section.sourceSize, section.appendix);
        showProgress({
          stage: 'Saving prepared analysis',
          completed: 1,
          total: 1,
          percent: 100,
        });
      } else {
        await file.unchanged();
      }
      const result = {
        path: path.resolve(options.capture),
        updated: !alreadyStored,
        native_bytes: stream.sourceSize,
        file_bytes: bytes,
        appendix_bytes: appendixBytes,
        overview_columns: stream.analysis?.overview?.columns,
        overview_events: stream.analysis?.overview?.events.length,
        analysis_version: 2,
      };
      finishProgress();
      console.log(
        options.format === 'table'
          ? table(result)
          : JSON.stringify(
              {
                schema: 'isaacprof-cli/v1',
                ok: true,
                command: 'prepare',
                capture_key: stream.captureKey,
                result,
                diagnostics: {
                  elapsed_ms: performance.now() - start,
                  total_elapsed_ms: performance.now() - begin,
                  reads: file.reads,
                  read_bytes: file.readBytes,
                  process_arch: process.arch,
                },
              },
              null,
              2,
            ),
      );
      return;
    }
    const envelope = async (current: Options) => {
      const start = performance.now();
      const reads = file.reads;
      const bytes = file.readBytes;
      const result = await execute(stream, file, current);
      await file.unchanged();
      return {
        schema: 'isaacprof-cli/v1',
        ok: true,
        command: current.command,
        capture_key: stream.captureKey,
        range_ms: [current.start ?? 0, current.end ?? stream.duration],
        units: {
          timings: 'ms',
          metric_native_fields: 'ns',
          cpu_cumulative: '100ns',
          rate: 'intervals/s',
          telemetry_time: 'ms',
          memory: 'bytes',
          minimum_duration: 'us',
        },
        result,
        diagnostics: {
          elapsed_ms: performance.now() - start,
          reads: file.reads - reads,
          read_bytes: file.readBytes - bytes,
          total_read_bytes: file.readBytes,
          cache_bytes: stream.cacheBytes,
          process_arch: process.arch,
        },
      };
    };
    if (options.command !== 'serve') {
      const result = await envelope(options);
      finishProgress();
      console.log(
        options.format === 'table'
          ? table(result.result)
          : JSON.stringify(
              {
                ...result,
                diagnostics: {
                  ...result.diagnostics,
                  total_elapsed_ms: performance.now() - begin,
                },
              },
              null,
              2,
            ),
      );
      return;
    }
    console.log(
      JSON.stringify({
        schema: 'isaacprof-cli/v1',
        ok: true,
        type: 'ready',
        capture_key: stream.captureKey,
        duration_ms: stream.duration,
        commands: commands.filter(
          (c) =>
            c !== 'serve' &&
            c !== 'screenshot' &&
            c !== 'list' &&
            c !== 'prepare',
        ),
      }),
    );
    const input = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    for await (const line of input) {
      let id: unknown = null;
      try {
        if (line.length > 65536) {
          throw Error('Request exceeds 64 KiB.');
        }
        const request: unknown = JSON.parse(line);
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
          throw Error('Expected request object.');
        }
        const value = request as Record<string, unknown>;
        id = value.id ?? null;
        if (
          id !== null &&
          (typeof id !== 'string' || id.length > 128) &&
          (typeof id !== 'number' || !Number.isSafeInteger(id))
        ) {
          throw Error(
            'Request id must be null, a string of at most 128 characters, or a safe integer.',
          );
        }
        if (
          typeof value.command !== 'string' ||
          !Array.isArray(value.args) ||
          !value.args.every((arg: unknown) => typeof arg === 'string')
        ) {
          throw Error('Expected command:string and args:string[].');
        }
        if (
          ['serve', 'screenshot', 'list', 'prepare'].includes(value.command)
        ) {
          throw Error('Serve permits read-only query commands.');
        }
        if (value.args.includes('--max-read-mib')) {
          throw Error('Set the session read budget when starting serve.');
        }
        const current = parse([value.command, options.capture, ...value.args]);
        if (current.format !== 'json') {
          throw Error('Serve replies are always JSON.');
        }
        console.log(JSON.stringify({ id, ...(await envelope(current)) }));
      } catch (error) {
        console.log(
          JSON.stringify({
            schema: 'isaacprof-cli/v1',
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  } finally {
    finishProgress();
    await file.close();
  }
}

await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      schema: 'isaacprof-cli/v1',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
