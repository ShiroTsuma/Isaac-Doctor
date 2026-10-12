export interface Metric {
  id: number;
  line: number;
  calls: number;
  errors: number;
  inclusive_ns: number;
  exclusive_ns: number;
  mean_ns: number;
  max_ns: number;
  mod: string;
  callback_id: string;
  callback_name: string;
  source: string;
  function: string;
}
export interface TraceEvent {
  index?: number;
  span?: number;
  parent?: number;
  parentMetric?: number;
  metric: number;
  start: number;
  duration: number;
  self: number;
  depth: number;
  thread: number;
  error: boolean;
}
export interface TimelineMetadata {
  version: number;
  enabled: boolean;
  capacity: number;
  dropped_events: number;
  filtered_events: number;
  minimum_duration_ns: number;
  columns: string[];
  events?: number[][];
}
export interface Screenshot {
  time_ns: number;
  width: number;
  height: number;
  png: Uint8Array<ArrayBuffer>;
}
export interface Screenshots {
  interval_ms: number;
  omitted: number;
  overhead_ns: number;
  images: Screenshot[];
}
export interface LossInterval {
  count: number;
  start_ns: number;
  end_ns: number;
}
export interface FrameInterval {
  id: number;
  start: number;
  duration: number;
  kind: 1 | 2;
  thread: number;
}
export interface FrameRow extends FrameInterval {
  hasUpdate?: boolean;
  calls: number;
  self: number;
  worstMod: string;
  modSelf: number;
  worstMetric: number | null;
  metricSelf: number;
}
export interface FrameQuery {
  kind: 1 | 2;
  start: number;
  end: number;
  minimumUs: number;
  search: string;
}
export interface CounterSample {
  time: number;
  workingSet: number;
  privateBytes: number;
  pageFaults: number;
  processUser: number;
  processKernel: number;
  threadUser: number;
  threadKernel: number;
  thread: number;
  valid: number;
}
export interface HeapSample {
  time: number;
  bytes: number;
}
export interface RunMarker {
  time: number;
  run: number;
  room: number;
  level: number;
  kind: number;
  flags: number;
}
export interface SourceIdentity {
  mod: string;
  source: string;
  path: string;
  sha256: string;
  status: number;
}
export interface CaptureInventory {
  intervalMs: number;
  gameVersion: string;
  windowTitle: string;
  luaModule: string;
  sources: SourceIdentity[];
}
export interface RoomContext {
  time: number;
  room: number;
  stage: number;
  stageType: number;
  roomType: number;
  width: number;
  height: number;
  gridSlots: number;
  grids: number;
  entities: number;
  enemies: number;
  tears: number;
  projectiles: number;
  effects: number;
  pickups: number;
  valid: number;
}
export interface OverheadSample {
  time: number;
  calls: number;
  samples: number;
  wrapperMs: number;
  observerMs: number;
  auxiliaryDropped: number;
  contextFailures: number;
  errorsOmitted: number;
}
export interface LuaError {
  time: number;
  metric: number;
  thread: number;
  span: number;
  message: string;
  stack: string;
}
export interface PresentationSample {
  id: number;
  thread: number;
  start: number;
  duration: number;
  swapStart: number;
  swap: number;
  readbackStart: number;
  readback: number;
  cycles: number | null;
  swapCycles: number | null;
  success: boolean;
}
export interface Telemetry {
  counters: CounterSample[];
  heap: HeapSample[];
  markers: RunMarker[];
  inventory?: CaptureInventory;
  context?: RoomContext[];
  overhead?: OverheadSample[];
  errors?: LuaError[];
}
export interface FrameResults {
  rows: FrameRow[];
  count: number;
  slow: number;
  mean: number;
  rate: number;
  p50: number;
  p95: number;
  p99: number;
  maximum: number;
  incomplete: boolean;
  sessionCount?: number;
  enclosingRange?: [number, number] | null;
}
export interface CaptureConfiguration {
  version: number;
  channels: number;
  startOn: number;
  stopOn: number;
  startDelayMs: number;
  stopDelayMs: number;
  maxDurationMs?: number;
  selectedMods: string[];
  selectedHooks: string[];
}
export interface CaptureDocument {
  configuration?: CaptureConfiguration;
  losses?: LossInterval[];
  binary_version?: number;
  format: string;
  schema_version: number;
  profiler_version: string;
  pid: number;
  architecture: string;
  lua_version: number;
  lua: string;
  exe: string;
  duration_ns: number;
  qpc_frequency: number;
  registered_metrics: number;
  dropped_calls: number;
  skipped_coroutine_calls: number;
  host_lua_entries: number;
  complete: boolean;
  metrics?: Metric[];
  timeline: TimelineMetadata;
  limitations?: string[];
  screenshots?: Screenshots;
}
export interface NormalizedLane {
  key: string;
  thread: number;
  depth: number;
  events: TraceEvent[];
}
export interface Model {
  document: CaptureDocument;
  metrics: Map<number, Metric>;
  events: TraceEvent[];
  duration: number;
  lanes: NormalizedLane[];
  hasTimeline: boolean;
}
export interface Lane {
  key: string;
  thread: number;
  depth: number;
  indices: Uint32Array;
}
export interface Stats {
  self: number;
  calls: number;
  errors: number;
}
export interface LoadedTrace {
  markers?: RunMarker[];
  analysis?: {
    key: string;
    state: 'stored' | 'computed';
    render: import('./analysis-cache.ts').FrameSummary;
    update: import('./analysis-cache.ts').FrameSummary;
  };
  streaming?: boolean;
  stride?: number;
  visibleCount?: number;
  document: CaptureDocument;
  duration: number;
  metrics: Metric[];
  packed: Float64Array;
  lanes: Lane[];
  bins: Float64Array;
  stats: Stats;
  count: number;
}
export interface Row {
  key: string;
  label: string;
  mod: string;
  metric: Metric | null;
  calls: number;
  errors: number;
  inclusive: number;
  exclusive: number;
  maximum: number;
  children?: Row[];
}
export interface TreeRow extends Row {
  depth: number;
  children: TreeRow[];
}
export type SortKey =
  'label' | 'exclusive' | 'inclusive' | 'maximum' | 'calls' | 'errors';
export interface Query {
  minimumUs?: number;
  mode: 'mods' | 'callbacks' | 'hooks';
  start: number;
  end: number;
  search: string;
  mod?: string;
  hook?: string;
  metric?: number;
  errorsOnly?: boolean;
  range: boolean;
  sort: SortKey;
  descending: boolean;
}
export interface Results {
  rows: Row[];
  count: number;
  stats: Stats;
  omitted?: { calls: number; self: number; total: number };
}
export interface WorkerOperations {
  presentation: {
    payload: import('./presentation.ts').PresentationQuery;
    result: import('./presentation.ts').PresentationResult;
  };
  diagnose: {
    payload: { start: number; end: number; kind: 1 | 2; top: number };
    result: Awaited<
      ReturnType<typeof import('./diagnosis.ts').diagnoseCapture>
    >;
  };
  inventory: { payload: null; result: CaptureInventory | null };
  graph: {
    payload: {
      kind: import('./graphs.ts').GraphKind;
      slot: number;
      start: number;
      end: number;
      columns: number;
      windowMs: number;
    };
    result: import('./graphs.ts').GraphResult;
  };
  frameDetail: {
    payload: FrameInterval;
    result: import('./frame-detail.ts').FrameDetail;
  };
  compare: {
    payload: { file: File; start: number; end: number };
    result: import('./comparison.ts').Comparison;
  };
  frameSummary: {
    payload: null;
    result: {
      render: import('./analysis-cache.ts').FrameSummary;
      update: import('./analysis-cache.ts').FrameSummary;
    };
  };
  telemetry: { payload: { start: number; end: number }; result: Telemetry };
  analysisTarget: { payload: { file: File; key: string }; result: null };
  analysis: {
    payload: { key: string };
    result: { sourceSize: number; appendix: Uint8Array<ArrayBuffer> };
  };
  frames: { payload: FrameQuery; result: FrameResults };
  load: { payload: { file: File }; result: LoadedTrace };
  viewport: {
    payload: { start: number; end: number; width: number; minimumUs?: number };
    result: {
      packed: Float64Array;
      lanes: Lane[];
      stride: number;
      visibleCount: number;
    };
  };
  source: {
    payload: { file: File; line: number };
    result: { start: number; lines: string[]; total: number; sha256?: string };
  };
  rank: { payload: Query; result: Results };
  events: {
    payload: Omit<Query, 'sort'> & {
      sort: 'start' | 'duration' | 'self' | 'depth' | 'activity';
    };
    result: {
      rows: TraceEvent[];
      count: number;
      omitted?: { calls: number; self: number; total: number };
    };
  };
  tree: { payload: Query; result: { rows: TreeRow[]; count: number } };
  export: { payload: null; result: Uint8Array<ArrayBuffer> | Blob };
}
export interface CoreAPI {
  decode(buffer: ArrayBuffer | Uint8Array): CaptureDocument;
  parse(document: CaptureDocument): Model;
  rank(model: Model, query: Query): Row[];
  matches(metric: Metric, search: string): boolean;
  chromeTrace(model: Model): unknown;
}
export interface Selection {
  event?: TraceEvent;
  metric?: Metric;
  row?: Row;
}
export interface WorkerClient {
  request<K extends keyof WorkerOperations>(
    type: K,
    payload: WorkerOperations[K]['payload'],
  ): Promise<WorkerOperations[K]['result']>;
  close(): void;
}
