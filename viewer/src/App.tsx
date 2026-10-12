import SortableHeader from './SortableHeader.tsx';
import { version } from '../package.json';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import Timeline from './Timeline.tsx';
import SourceContext from './SourceContext.tsx';
import RecordingControls from './RecordingControls.tsx';
import type { RecordingStatus } from './RecordingControls.tsx';
import RecordingStage from './RecordingStage.tsx';
import Frames from './Frames.tsx';
import Comparison from './Comparison.tsx';
import Telemetry from './Telemetry.tsx';
import CaptureFolder from './CaptureFolder.tsx';
import { savedCaptureDirectory } from './capture-folder.ts';
import type { CaptureEntry } from './capture-folder.ts';
import { recordingLabel, recordingOrder } from './recording-files.ts';
import { saveAnalysis } from './save-analysis.ts';
import type { ProcessingProgress } from './stream.ts';
import type { AnalysisHandle } from './save-analysis.ts';
import './recording.css';
import {
  forgetFolder,
  rememberSelection,
  restoreFolder,
  saveFolder,
} from './folder-cache.ts';
import type { FolderRecording } from './folder-cache.ts';
import { color, count, createWorker, ms } from './trace.ts';
import type {
  LoadedTrace,
  Metric,
  Query,
  Results,
  Row,
  Selection,
  SortKey,
  TraceEvent,
  TreeRow,
  WorkerClient,
} from './types.ts';

type Tab =
  | 'Summary'
  | 'Bottom-up'
  | 'Call tree'
  | 'Event log'
  | 'Frames'
  | 'Telemetry'
  | 'Compare';
const tabs: Tab[] = [
  'Summary',
  'Bottom-up',
  'Call tree',
  'Event log',
  'Frames',
  'Telemetry',
  'Compare',
];
type PickerWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple: boolean;
    mode: 'readwrite';
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle[]>;
};

function recordingKey(file: File) {
  return file.webkitRelativePath || file.name;
}

function Icon({
  name,
}: {
  name:
    | 'open'
    | 'save'
    | 'clear'
    | 'folder'
    | 'plus'
    | 'minus'
    | 'fit'
    | 'settings'
    | 'chevron';
}) {
  const paths = {
    open: 'M3 12v2h10v-2M8 11V2m-3 3 3-3 3 3',
    save: 'M3 12v2h10v-2M8 2v9m-3-3 3 3 3-3',
    clear: 'M3 13 13 3M3 3l10 10',
    folder: 'M2 4h5l2 2h5v7H2z',
    plus: 'M3 8h10M8 3v10',
    minus: 'M3 8h10',
    fit: 'M2 6V2h4m4 0h4v4M2 10v4h4m4 0h4v-4',
    settings: 'M3 4h10M3 8h10M3 12h10M6 2v4M10 6v4M6 10v4',
    chevron: 'm6 4 4 4-4 4',
  };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={paths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Operation failed';
}

function TableHeader({
  sort,
  descending,
  onSort,
}: {
  sort: SortKey;
  descending: boolean;
  onSort: (key: SortKey) => void;
}) {
  return (
    <SortableHeader
      columns={(
        [
          ['exclusive', 'Self time'],
          ['inclusive', 'Total time'],
          ['maximum', 'Max time'],
          ['calls', 'Calls'],
          ['errors', 'Errors'],
          ['label', 'Activity'],
        ] as [SortKey, string][]
      ).map(([key, label]) => ({ key, label }))}
      sort={sort}
      descending={descending}
      onSort={onSort}
    />
  );
}

function heat(duration: number, warningUs: number): CSSProperties {
  return {
    backgroundColor: `rgba(242,139,130,${Math.min(1, (duration * 1000) / warningUs) * 0.3})`,
    color: duration * 1000 >= warningUs ? '#f28b82' : undefined,
  };
}

function ResultRow({
  row,
  percent,
  select,
  selected,
  depth = 0,
  expand,
  expanded,
  warningUs,
}: {
  row: Row;
  percent: number;
  select: () => void;
  selected: boolean;
  depth?: number;
  expand?: () => void;
  expanded?: boolean;
  warningUs: number;
}) {
  return (
    <tr className={selected ? 'selected' : ''} onClick={select}>
      <td
        className="time-cell"
        style={{ '--bar-width': `${percent}%` } as CSSProperties}
      >
        <span>{ms(row.exclusive)}</span>
      </td>
      <td>{ms(row.inclusive)}</td>
      <td style={heat(row.maximum, warningUs)}>{ms(row.maximum)}</td>
      <td>{count(row.calls)}</td>
      <td>{count(row.errors)}</td>
      <td className="activity">
        <div style={{ paddingLeft: depth * 14 }}>
          {expand ? (
            <button
              className="tree-toggle"
              aria-label={expanded ? 'Collapse call' : 'Expand call'}
              onClick={(e) => {
                e.stopPropagation();
                expand();
              }}
            >
              {expanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="tree-spacer" />
          )}
          <span className="swatch" style={{ background: color(row.mod) }} />
          <button className="row-button" onClick={select}>
            {row.label}
          </button>
          {row.metric && (
            <span className="source-inline" title={row.metric.source}>
              {row.metric.source.split('/').at(-1)}:{row.metric.line}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function Summary({
  data,
  range,
  stats,
  selected,
  request,
}: {
  data: LoadedTrace;
  range: [number, number];
  stats: Results['stats'];
  selected: Selection | null;
  request: WorkerClient['request'];
}) {
  const [session, setSession] = useState<{
    data: LoadedTrace;
    render: import('./analysis-cache.ts').FrameSummary;
    update: import('./analysis-cache.ts').FrameSummary;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (data.streaming) {
      void request('frameSummary', null)
        .then((result) => {
          if (active) {
            setSession({ data, ...result });
          }
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [data, request]);
  const frames = session?.data === data ? session : data.analysis;
  const event = selected?.event;
  const metric = selected?.metric;
  const row = selected?.row;
  const span = range[1] - range[0];
  const measured = event ? event.self : row ? row.exclusive : stats.self;
  const total = event ? event.duration : row ? row.inclusive : span;
  const share = Math.min(100, total ? (measured / total) * 100 : 0);
  const values: [string, string][] = event
    ? [
        ['Duration', `${ms(event.duration)} (self ${ms(event.self)})`],
        ['Timestamp', ms(event.start)],
        ['Thread', `Main [${event.thread}]`],
        ['Nesting depth', String(event.depth)],
        ['Error', event.error ? 'Yes' : 'No'],
      ]
    : metric
      ? [
          ['Total time', ms(row?.inclusive ?? metric.inclusive_ns / 1e6)],
          ['Self time', ms(row?.exclusive ?? metric.exclusive_ns / 1e6)],
          [
            'Average',
            ms(
              (row?.inclusive ?? metric.inclusive_ns / 1e6) /
                (row?.calls ?? metric.calls),
            ),
          ],
          ['Calls', count(row?.calls ?? metric.calls)],
          ['Errors', count(row?.errors ?? metric.errors)],
        ]
      : [
          [
            'Recording',
            `${ms(data.duration)} · ${data.document.complete ? 'complete' : 'snapshot'}`,
          ],
          ['Measured calls', count(stats.calls)],
          ['Retained events', count(data.count)],
          ['Callback errors', count(stats.errors)],
          ['Process', `Isaac · PID ${data.document.pid}`],
          ...(frames
            ? ([
                [
                  'Session FPS',
                  frames.render.count
                    ? frames.render.rate.toFixed(1)
                    : 'Unavailable (no render markers)',
                ],
                [
                  'Session p95',
                  frames.render.count ? ms(frames.render.p95) : '?',
                ],
                [
                  'Session UPS',
                  frames.update.count
                    ? frames.update.rate.toFixed(1)
                    : 'Unavailable (no update markers)',
                ],
              ] as [string, string][])
            : []),
        ];
  return (
    <div className="summary-content" id="detail-content">
      <div className="summary-title">
        {metric ? (
          <>
            <span
              className="swatch"
              style={{ background: color(metric.mod) }}
            />
            {metric.callback_name || metric.callback_id}
            <span className="quiet"> — {metric.mod}</span>
          </>
        ) : (
          <>
            Range: {ms(range[0])} – {ms(range[1])}
          </>
        )}
      </div>
      <div className="summary-layout">
        <div className="summary-chart">
          <div
            className="donut"
            style={{
              background: `conic-gradient(${metric ? color(metric.mod) : '#d4b650'} 0 ${share}%, #5f6368 ${share}% 100%)`,
            }}
          >
            <div>
              <b>{ms(total)}</b>
            </div>
          </div>
          <div className="legend">
            <div title="Elapsed callback time excluding instrumented child callbacks; includes native game API calls and waiting, not only Lua CPU execution.">
              <span
                className="swatch"
                style={{ background: metric ? color(metric.mod) : '#d4b650' }}
              />
              {ms(measured)} <span>Callback self</span>
            </div>
            <div
              title={
                event || row
                  ? 'Total minus self: instrumented child callbacks. Group totals can overlap.'
                  : 'Selected wall-clock range minus retained callback self: includes engine work, waiting, profiling and other unmeasured time; not a separate CPU measurement.'
              }
            >
              <span className="swatch" style={{ background: '#5f6368' }} />
              {ms(Math.max(0, total - measured))}{' '}
              <span>
                {event || row
                  ? 'Nested callbacks'
                  : 'Not attributed to callbacks'}
              </span>
            </div>
          </div>
        </div>
        <dl className="summary-fields">
          {values.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          {metric && (
            <>
              <div>
                <dt>Function</dt>
                <dd>{metric.callback_name || metric.callback_id}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd className="source" id="source-location">
                  {metric.source}:{metric.line}
                </dd>
              </div>
            </>
          )}
        </dl>
      </div>
      <SourceContext
        metric={selected?.metric}
        request={request}
        capture={data}
      />
    </div>
  );
}

export default function App() {
  const [callbackWarningUs, setCallbackWarningUs] = useState(() => {
    const value = Number(localStorage.getItem('isaacprof.callback-warning-us'));
    return Number.isSafeInteger(value) && value > 0 ? value : 50000;
  });
  const [minimumCall, setMinimumCall] = useState('0');
  const [durationUnit, setDurationUnit] = useState<'us' | 'ms'>('us');
  const minimumUs =
    Math.max(0, Number(minimumCall) || 0) * (durationUnit === 'ms' ? 1000 : 1);
  const [recordingStatus, setRecordingStatus] =
    useState<RecordingStatus | null>(null);
  const [data, setData] = useState<LoadedTrace | null>(null);
  const [name, setName] = useState('');
  const [range, setRangeState] = useState<[number, number]>([0, 1]);
  const [tab, setTab] = useState<Tab>('Summary');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'mods' | 'callbacks' | 'hooks'>('callbacks');
  const [sort, setSort] = useState<SortKey>('exclusive');
  const [descending, setDescending] = useState(true);
  const [results, setResults] = useState<Results>({
    rows: [],
    count: 0,
    stats: { self: 0, calls: 0, errors: 0 },
  });
  const [eventSort, setEventSort] = useState<
    'start' | 'duration' | 'self' | 'depth' | 'activity'
  >('start');
  const [eventDescending, setEventDescending] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [eventOmitted, setEventOmitted] = useState({
    calls: 0,
    self: 0,
    total: 0,
  });
  const [tree, setTree] = useState<TreeRow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [eventRows, setEventRows] = useState<TraceEvent[]>([]);
  const [eventCount, setEventCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [directoryFiles, setDirectoryFiles] = useState<FolderRecording[]>([]);
  const [settings, setSettings] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [folderSummary, setFolderSummary] = useState('');
  const [currentRecordingKey, setCurrentRecordingKey] = useState('');
  const [captureFolderEpoch, setCaptureFolderEpoch] = useState(0);
  const originalHandle = useRef<FileSystemFileHandle | null>(null);
  const captureHandles = useRef(new Map<string, FileSystemFileHandle>());
  const processingAbort = useRef<AbortController | null>(null);
  const [hasOriginalHandle, setHasOriginalHandle] = useState(false);
  const [panelHeight, setPanelHeight] = useState(() =>
    Math.max(
      150,
      Math.min(
        innerHeight * 0.45,
        Number(localStorage.getItem('isaacprof.drawer-height')) || 240,
      ),
    ),
  );
  const worker = useRef<WorkerClient | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const originalFile = useRef<File | null>(null);
  const loadSequence = useRef(0);
  const folderSequence = useRef(0);
  const splitDrag = useRef<{ y: number; height: number } | null>(null);
  const [processingProgress, setProcessingProgress] =
    useState<ProcessingProgress | null>(null);
  useEffect(() => {
    worker.current = createWorker(setProcessingProgress);
    return () => {
      processingAbort.current?.abort();
      worker.current?.close();
    };
  }, []);
  const requestWorker = useCallback<WorkerClient['request']>(
    (type, payload) => {
      const client = worker.current;
      if (!client) {
        return Promise.reject(Error('Worker unavailable'));
      }
      return client.request(type, payload);
    },
    [],
  );
  const setRange = useCallback(
    (next: [number, number]) => {
      if (!data?.count) {
        return;
      }
      const duration = Math.max(0.001, data.duration);
      const span = Math.min(duration, Math.max(0.01, next[1] - next[0]));
      const start = Math.max(0, Math.min(next[0], duration - span));
      setRangeState([start, start + span]);
    },
    [data],
  );
  const full = !data?.count || (range[0] <= 0 && range[1] >= data.duration);
  const query = useMemo<Query>(
    () => ({
      mode,
      start: range[0],
      end: range[1],
      search,
      range: !full,
      sort,
      descending,
      minimumUs,
    }),
    [mode, range, search, full, sort, descending, minimumUs],
  );
  useEffect(() => {
    if (!data) {
      return;
    }
    let active = true;
    const epoch = loadSequence.current;
    const timer = setTimeout(() => {
      const client = worker.current;
      if (!client) {
        return;
      }
      void client
        .request('rank', query)
        .then((result) => {
          if (active && epoch === loadSequence.current) {
            setResults(result);
          }
        })
        .catch((error) => {
          if (active && epoch === loadSequence.current) {
            setMessage(errorMessage(error));
          }
        });
      if (tab === 'Call tree') {
        void client
          .request('tree', query)
          .then((result) => {
            if (active && epoch === loadSequence.current) {
              setTree(result.rows);
            }
          })
          .catch((error) => {
            if (active && epoch === loadSequence.current) {
              setMessage(errorMessage(error));
            }
          });
      }
      if (tab === 'Event log') {
        void client
          .request('events', {
            ...query,
            sort: eventSort,
            descending: eventDescending,
            errorsOnly,
          })
          .then((result) => {
            if (active && epoch === loadSequence.current) {
              setEventRows(result.rows);
              setEventCount(result.count);
              setEventOmitted(
                result.omitted ?? { calls: 0, self: 0, total: 0 },
              );
            }
          })
          .catch((error) => {
            if (active && epoch === loadSequence.current) {
              setMessage(errorMessage(error));
            }
          });
      }
    }, 60);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, query, tab, eventSort, eventDescending, errorsOnly]);
  const load = useCallback(
    async (
      file: File | undefined,
      key = file ? recordingKey(file) : '',
      handle?: FileSystemFileHandle,
    ) => {
      if (!file || !worker.current) {
        return;
      }
      processingAbort.current?.abort();
      const abort = new AbortController();
      processingAbort.current = abort;
      worker.current.close();
      worker.current = createWorker(setProcessingProgress);
      const client = worker.current;
      setData(null);
      const sequence = ++loadSequence.current;
      setBusy(true);
      setProcessingProgress(null);
      setMessage('Reading file on disk…');
      try {
        let result = await client.request('load', { file });
        let loadedFile = file;
        let cacheNotice = '';
        if (sequence !== loadSequence.current) {
          return;
        }
        if (result.analysis?.state === 'computed' && handle) {
          const writable = handle as AnalysisHandle;
          const permission = await writable.queryPermission({
            mode: 'readwrite',
          });
          if (sequence !== loadSequence.current) {
            return;
          }
          if (permission === 'granted') {
            try {
              const section = await client.request('analysis', {
                key: result.analysis.key,
              });
              if (sequence !== loadSequence.current) {
                return;
              }
              setMessage('Saving prepared analysis locally…');
              loadedFile = await saveAnalysis(
                handle,
                file,
                section.sourceSize,
                section.appendix,
                abort.signal,
              );
              if (sequence !== loadSequence.current) {
                return;
              }
              result = await client.request('load', { file: loadedFile });
            } catch (error) {
              cacheNotice = `Prepared analysis could not be saved: ${errorMessage(error)}`;
            }
          }
        }
        if (sequence !== loadSequence.current) {
          return;
        }
        originalFile.current = loadedFile;
        originalHandle.current = handle ?? null;
        setHasOriginalHandle(!!handle);
        setData(result);
        setName(loadedFile.name);
        setCurrentRecordingKey(key);
        setRangeState([0, Math.max(result.duration, 0.001)]);
        setSelected(null);
        setTab('Summary');
        setSearch('');
        setExpanded(new Set());
        setResults({ rows: [], count: 0, stats: result.stats });
        void rememberSelection(key).catch(() => {
          if (sequence === loadSequence.current) {
            setFolderSummary(
              'Could not remember selected recording in local storage.',
            );
          }
        });
        const t = result.document.timeline;
        const warnings: string[] = cacheNotice ? [cacheNotice] : [];
        const shots = result.document.screenshots;
        if (shots?.interval_ms && !shots.images.length) {
          warnings.push(
            'No screenshots captured (requires a supported OpenGL context)',
          );
        }
        if (shots?.omitted) {
          warnings.push(`${count(shots.omitted)} screenshots omitted`);
        }
        if (!result.document.complete) {
          warnings.push('Incomplete snapshot');
        }
        if (t.dropped_events) {
          warnings.push(
            `${count(t.dropped_events)} events omitted (producer buffer overflow)`,
          );
        }
        if (t.filtered_events) {
          warnings.push(`${count(t.filtered_events)} short events filtered`);
        }
        if (result.document.dropped_calls) {
          warnings.push(
            `${count(result.document.dropped_calls)} calls discarded`,
          );
        }
        if (!t.enabled) {
          warnings.push('Aggregate-only recording');
        }
        setMessage(warnings.join(' · '));
      } catch (error) {
        if (sequence === loadSequence.current) {
          setMessage(errorMessage(error));
        }
      } finally {
        if (sequence === loadSequence.current) {
          setBusy(false);
        }
      }
    },
    [],
  );
  const loadFromHandle = useCallback(
    (file: File, handle: FileSystemFileHandle) => load(file, file.name, handle),
    [load],
  );
  const refreshCaptures = useCallback(
    (folder: string, files: CaptureEntry[]) => {
      folderSequence.current++;
      captureHandles.current = new Map(
        files.map(({ key, handle }) => [key, handle]),
      );
      setDirectoryFiles(files);
      setFolderSummary(
        `${folder}: ${count(files.length)} recordings \u00b7 live folder`,
      );
    },
    [],
  );

  function clearRecording() {
    loadSequence.current++;
    processingAbort.current?.abort();
    worker.current?.close();
    worker.current = createWorker(setProcessingProgress);
    originalFile.current = null;
    originalHandle.current = null;
    setHasOriginalHandle(false);
    setBusy(false);
    setProcessingProgress(null);
    setData(null);
    setName('');
    setCurrentRecordingKey('');
    setSelected(null);
    setMessage('');
    setRangeState([0, 1]);
    setTree([]);
    setEventRows([]);
    setEventCount(0);
    setExpanded(new Set());
    setResults({ rows: [], count: 0, stats: { self: 0, calls: 0, errors: 0 } });
  }

  useEffect(() => {
    let active = true;
    void restoreFolder()
      .then((snapshot) => {
        if (
          !active ||
          !snapshot ||
          loadSequence.current ||
          folderSequence.current
        ) {
          return;
        }
        setDirectoryFiles(snapshot.recordings);
        setFolderSummary(
          `${snapshot.name}: ${count(snapshot.recordings.length)} recordings · restored local snapshot; select again to refresh`,
        );
        const selected =
          snapshot.recordings.find(
            (recording) => recording.key === snapshot.selectedKey,
          ) ?? snapshot.recordings[0];
        if (selected) {
          void load(selected.file, selected.key);
        }
      })
      .catch(() => {
        if (active && !folderSequence.current) {
          setFolderSummary(
            'Local folder cache is unavailable. Choose a folder to read recordings.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [load]);

  async function pickFile() {
    try {
      const picker = window as PickerWindow;
      if (picker.showOpenFilePicker) {
        const [handle] = await picker.showOpenFilePicker({
          multiple: false,
          mode: 'readwrite',
          types: [
            {
              description: 'IsaacProf recording',
              accept: { 'application/octet-stream': ['.isaacprof'] },
            },
          ],
        });
        const file = await handle.getFile();
        await load(file, file.name, handle);
      } else {
        fileInput.current?.click();
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setMessage(errorMessage(error));
      }
    }
  }

  function pickDirectory() {
    const input = folderInput.current;
    if (!input) {
      return;
    }
    input.value = '';
    input.click();
  }

  async function acceptDirectory(selectedFiles: File[]) {
    const sequence = ++folderSequence.current;
    captureHandles.current.clear();
    const files = selectedFiles
      .filter((file) => file.name.toLowerCase().endsWith('.isaacprof'))
      .map((file) => ({ key: recordingKey(file), file }))
      .sort(recordingOrder);
    const folder =
      selectedFiles[0]?.webkitRelativePath.split('/')[0] || 'Selected folder';
    setDirectoryFiles(files);
    setFolderSummary(
      `${folder}: ${count(files.length)} recordings · folder snapshot; select again to refresh`,
    );
    void saveFolder({
      name: folder,
      recordings: files,
      selectedKey: files[0]?.key ?? '',
    }).catch((error) => {
      if (sequence === folderSequence.current) {
        setFolderSummary(
          `${folder}: could not remember folder — ${errorMessage(error)}`,
        );
      }
    });
    if (files.length) {
      await load(files[0].file, files[0].key);
    } else {
      clearRecording();
      setMessage(
        'No .isaacprof recordings found in the selected folder or its subfolders.',
      );
    }
  }

  async function forgetRememberedFolder() {
    folderSequence.current++;
    try {
      await Promise.all([forgetFolder(), savedCaptureDirectory(null)]);
      captureHandles.current.clear();
      setCaptureFolderEpoch((epoch) => epoch + 1);
      setDirectoryFiles([]);
      setFolderSummary('');
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function exportTrace() {
    if (!worker.current || !data?.count) {
      return;
    }
    try {
      const bytes = await worker.current.request('export', null);
      const url = URL.createObjectURL(
        bytes instanceof Blob
          ? bytes
          : new Blob([bytes], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name.replace(/\.[^.]+$/, '') + '.chrome-trace.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function saveBinary() {
    const file = originalFile.current;
    if (!file) {
      return;
    }
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function savePreparedAnalysis() {
    const client = worker.current;
    const file = originalFile.current;
    let handle = originalHandle.current;
    if (!client || !file || !data?.analysis) {
      return;
    }
    const sequence = loadSequence.current;
    const abort = new AbortController();
    processingAbort.current?.abort();
    processingAbort.current = abort;
    try {
      let target = file;
      const picker = window as PickerWindow;
      if (!handle && picker.showOpenFilePicker) {
        [handle] = await picker.showOpenFilePicker({
          multiple: false,
          mode: 'readwrite',
          types: [
            {
              description: `Grant write access to ${file.name}`,
              accept: { 'application/octet-stream': ['.isaacprof'] },
            },
          ],
        });
        target = await handle.getFile();
        abort.signal.throwIfAborted();
        await client.request('analysisTarget', {
          file: target,
          key: data.analysis.key,
        });
      }
      if (
        handle &&
        (await (handle as AnalysisHandle).requestPermission({
          mode: 'readwrite',
        })) !== 'granted'
      ) {
        throw Error('Write permission is required to save prepared analysis.');
      }
      abort.signal.throwIfAborted();
      setBusy(true);
      setProcessingProgress(null);
      const section = await client.request('analysis', {
        key: data.analysis.key,
      });
      if (sequence !== loadSequence.current) {
        return;
      }
      if (handle) {
        const fresh = await saveAnalysis(
          handle,
          target,
          section.sourceSize,
          section.appendix,
          abort.signal,
        );
        if (sequence !== loadSequence.current) {
          return;
        }
        await load(fresh, currentRecordingKey, handle);
      } else {
        const url = URL.createObjectURL(
          new Blob([file.slice(0, section.sourceSize), section.appendix], {
            type: 'application/octet-stream',
          }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name.replace(
          /\.isaacprof$/i,
          '.analyzed.isaacprof',
        );
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(
          'Downloaded a binary recording with prepared analysis. Reopen it to reuse the cache.',
        );
      }
    } catch (error) {
      if (
        sequence === loadSequence.current &&
        !(error instanceof DOMException && error.name === 'AbortError')
      ) {
        setMessage(errorMessage(error));
      }
    } finally {
      if (sequence === loadSequence.current) {
        setBusy(false);
      }
    }
  }

  function selectEvent(event: TraceEvent, metric: Metric) {
    setSelected({ event, metric });
    setTab('Summary');
  }

  function selectRow(row: Row) {
    setSelected({ metric: row.metric ?? undefined, row });
  }

  function onSort(key: SortKey) {
    if (sort === key) {
      setDescending(!descending);
    } else {
      setSort(key);
      setDescending(key !== 'label');
    }
  }

  function zoom(factor: number) {
    const span = range[1] - range[0];
    const center = (range[0] + range[1]) / 2;
    setRange([center - (span * factor) / 2, center + (span * factor) / 2]);
  }

  function resize(e: ReactPointerEvent<HTMLDivElement>) {
    if (!splitDrag.current) {
      return;
    }
    const height = Math.max(
      100,
      Math.min(
        innerHeight - 220,
        splitDrag.current.height + splitDrag.current.y - e.clientY,
      ),
    );
    setPanelHeight(height);
  }

  function finishResize(e: ReactPointerEvent<HTMLDivElement>) {
    splitDrag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    localStorage.setItem('isaacprof.drawer-height', String(panelHeight));
  }

  const visibleTree: TreeRow[] = useMemo(() => {
    const flat: TreeRow[] = [];

    function visit(rows: TreeRow[]) {
      for (const row of rows) {
        flat.push(row);
        if (expanded.has(row.key)) {
          visit(row.children);
        }
      }
    }

    visit(tree);
    return flat;
  }, [tree, expanded]);
  const bottomRows = useMemo(() => {
    const flat: (Row & { depth: number })[] = [];

    function visit(rows: Row[], depth = 0) {
      for (const row of rows) {
        flat.push({ ...row, depth });
        if (expanded.has(row.key) && row.children) {
          visit(row.children, depth + 1);
        }
      }
    }

    visit(results.rows);
    return flat;
  }, [results.rows, expanded]);
  const metricMap = useMemo(
    () => new Map(data?.metrics.map((m) => [m.id, m]) || []),
    [data],
  );
  const style = { '--drawer-height': `${panelHeight}px` } as CSSProperties;
  return (
    <main
      className="devtools"
      style={style}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void load(e.dataTransfer.files[0]);
      }}
    >
      <header className="panel-bar">
        <h1>Performance</h1>
        <img
          className="app-icon"
          src="/favicon.png"
          width="24"
          height="24"
          alt=""
        />
        <span className="app-name">Isaac Doctor</span>
        <span id="filename" className="recording-name" title={name}>
          {name || 'No recording'}
        </span>
        <span className="version">{version}</span>
      </header>
      <div className="toolbar" role="toolbar" aria-label="Performance controls">
        <button
          className="tool-button"
          title="Open recording from disk"
          aria-label="Open recording"
          onClick={() => void pickFile()}
        >
          <Icon name="open" />
        </button>
        <button
          className="tool-button"
          title="Read recordings folder locally. Browser may say Upload; no files are sent. Select again to refresh."
          aria-label="Open folder"
          onClick={pickDirectory}
        >
          <Icon name="folder" />
        </button>
        <button
          className="tool-button"
          title="Save binary recording"
          aria-label="Save recording"
          disabled={!data}
          onClick={saveBinary}
        >
          <Icon name="save" />
        </button>
        <button
          className="tool-button"
          title="Clear recording"
          aria-label="Clear recording"
          disabled={!data && !busy}
          onClick={clearRecording}
        >
          <Icon name="clear" />
        </button>
        <span className="toolbar-separator" />
        <select
          id="captures"
          aria-label="Files in selected folder"
          title={
            folderSummary ||
            'Choose a folder to list local recordings, including subfolders'
          }
          disabled={!directoryFiles.length}
          value={
            directoryFiles.some(
              (recording) => recording.key === currentRecordingKey,
            )
              ? currentRecordingKey
              : ''
          }
          onChange={(e) => {
            const recording = directoryFiles.find(
              (item) => item.key === e.target.value,
            );
            if (recording) {
              const handle = captureHandles.current.get(recording.key);
              if (handle) {
                void handle
                  .getFile()
                  .then((file) => load(file, recording.key, handle))
                  .catch((error) => setMessage(errorMessage(error)));
              } else {
                void load(recording.file, recording.key);
              }
            }
          }}
        >
          <option value="">
            {directoryFiles.length
              ? `${count(directoryFiles.length)} recordings — select…`
              : 'Open a local folder…'}
          </option>
          {directoryFiles.map((recording) => (
            <option value={recording.key} key={recording.key}>
              {recordingLabel(recording.file, recording.key)}
            </option>
          ))}
        </select>
        <span className="toolbar-separator" />
        <button
          id="zoom-in"
          className="tool-button"
          title="Zoom in (W)"
          aria-label="Zoom in"
          disabled={!data}
          onClick={() => zoom(0.5)}
        >
          <Icon name="plus" />
        </button>
        <button
          id="zoom-out"
          className="tool-button"
          title="Zoom out (S)"
          aria-label="Zoom out"
          disabled={!data}
          onClick={() => zoom(2)}
        >
          <Icon name="minus" />
        </button>
        <button
          id="reset"
          className="tool-button"
          title="Show entire recording"
          aria-label="Show all"
          disabled={!data}
          onClick={() => setRange([0, data?.duration ?? 1])}
        >
          <Icon name="fit" />
        </button>
        <output id="range">
          {data ? `${ms(range[0])} – ${ms(range[1])}` : ''}
        </output>
        <span className="toolbar-fill" />
        <button
          id="export"
          className="export-button"
          disabled={!data?.count}
          onClick={() => void exportTrace()}
        >
          Export Chrome Trace
        </button>
        <button
          className="tool-button"
          title="Viewer settings"
          aria-label="Settings"
          onClick={() => setSettings(!settings)}
        >
          <Icon name="settings" />
        </button>
      </div>
      <RecordingControls onStatus={setRecordingStatus} />
      <CaptureFolder
        key={captureFolderEpoch}
        status={recordingStatus}
        open={loadFromHandle}
        onFiles={refreshCaptures}
      />
      {data?.analysis && (
        <div className="analysis-cache-controls">
          <output id="analysis-cache-status">
            {data.analysis.state === 'stored'
              ? 'Prepared analysis loaded from recording'
              : 'Analysis prepared: session, halves and quarters'}
          </output>
          <label className="analysis-range-preset">
            Range{' '}
            <select
              aria-label="Prepared range"
              value=""
              onChange={(e) => {
                const [a, b] = e.target.value.split(':').map(Number);
                if (Number.isFinite(a) && Number.isFinite(b)) {
                  setRange([(a * data.duration) / 4, (b * data.duration) / 4]);
                }
              }}
            >
              <option value="">Custom / current</option>
              {[
                [0, 4, 'Session'],
                [0, 2, 'First half'],
                [2, 4, 'Second half'],
                [0, 1, 'Quarter 1'],
                [1, 2, 'Quarter 2'],
                [2, 3, 'Quarter 3'],
                [3, 4, 'Quarter 4'],
              ].map(([a, b, label]) => (
                <option key={`${a}:${b}`} value={`${a}:${b}`}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label
            className="call-duration-filter"
            title="Hide individual callbacks shorter than this total duration. Callback tables use retained matching events; frame statistics and FPS stay unchanged."
          >
            Min call{' '}
            <input
              id="minimum-call-duration"
              aria-label="Minimum callback duration"
              type="number"
              min="0"
              step="any"
              value={minimumCall}
              onChange={(e) => {
                setMinimumCall(e.target.value);
                setSelected(null);
              }}
            />
            <select
              aria-label="Callback duration unit"
              value={durationUnit}
              onChange={(e) => {
                const next = e.target.value as 'us' | 'ms';
                setMinimumCall(String(minimumUs / (next === 'ms' ? 1000 : 1)));
                setDurationUnit(next);
              }}
            >
              <option value="us">?s</option>
              <option value="ms">ms</option>
            </select>
          </label>
          <span className="toolbar-fill" />
          <button
            id="save-analysis-cache"
            disabled={busy || data.analysis.state === 'stored'}
            onClick={() => void savePreparedAnalysis()}
          >
            {hasOriginalHandle || 'showOpenFilePicker' in window
              ? 'Save prepared analysis in recording'
              : 'Download with prepared analysis'}
          </button>
        </div>
      )}
      <input
        id="file"
        ref={fileInput}
        type="file"
        accept=".isaacprof"
        hidden
        onChange={(e) => void load(e.target.files?.[0])}
      />
      <input
        id="folder-input"
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => void acceptDirectory(Array.from(e.target.files ?? []))}
      />
      {settings && (
        <div className="settings-pane">
          <b>Callback warning</b>
          <label>
            Red at{' '}
            <input
              id="callback-warning-us"
              type="number"
              min="1"
              max="10000000"
              step="1"
              value={callbackWarningUs}
              onChange={(e) => {
                const value = e.target.valueAsNumber;
                if (
                  Number.isSafeInteger(value) &&
                  value > 0 &&
                  value <= 10000000
                ) {
                  setCallbackWarningUs(value);
                  localStorage.setItem(
                    'isaacprof.callback-warning-us',
                    String(value),
                  );
                }
              }}
            />{' '}
            µs
          </label>
          <b>Navigation</b>
          <span>
            Wheel: zoom · Shift + wheel: pan · W/A/S/D: navigate · Shift + drag:
            select range
          </span>
          <b>Local processing</b>
          <span>
            File System Access / file input → Web Worker → transferable timeline
            buffers. Recordings never leave the browser.
          </span>
          <b>Remembered folder</b>
          <span>
            Connect captures folder remembers access and refreshes the file list
            automatically. Open folder is a snapshot fallback. Forget
            disconnects the folder and removes any saved snapshot.
          </span>
          <button
            id="forget-folder"
            className="small-button"
            onClick={() => void forgetRememberedFolder()}
          >
            Forget folder access and snapshot
          </button>
        </div>
      )}
      <div className="timeline-stage-host">
        <RecordingStage
          status={recordingStatus}
          loading={busy}
          processing={processingProgress}
        />
        <Timeline
          data={data}
          range={range}
          setRange={setRange}
          selected={selected}
          selectEvent={selectEvent}
          search={search}
          minimumUs={minimumUs}
          request={requestWorker}
        />
      </div>
      <div
        className="drawer-splitter"
        id="drawer-splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize analysis panel"
        aria-valuemin={100}
        aria-valuemax={Math.max(100, innerHeight - 220)}
        aria-valuenow={Math.round(panelHeight)}
        tabIndex={0}
        onPointerDown={(e) => {
          splitDrag.current = { y: e.clientY, height: panelHeight };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={() => (splitDrag.current = null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            setPanelHeight((h) =>
              Math.max(
                100,
                Math.min(
                  innerHeight - 220,
                  h + (e.key === 'ArrowUp' ? 20 : -20),
                ),
              ),
            );
          }
        }}
      />
      <section
        className="analysis-drawer"
        id="analysis-drawer"
        aria-label="Performance analysis"
      >
        <div className="drawer-tab-bar" role="tablist">
          {tabs.map((item) => (
            <button
              role="tab"
              aria-selected={tab === item}
              id={'tab-' + item.toLowerCase().replaceAll(' ', '-')}
              aria-controls="analysis-content"
              key={item}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ))}
          <span className="toolbar-fill" />
          <span className="range-label">
            {data ? `${ms(range[1] - range[0])} selected` : ''}
          </span>
        </div>
        <div
          id="analysis-content"
          role="tabpanel"
          aria-labelledby={'tab-' + tab.toLowerCase().replaceAll(' ', '-')}
        >
          {data && (
            <div hidden={tab !== 'Summary'} className="summary-pane">
              <Summary
                data={data}
                range={range}
                stats={results.stats}
                selected={selected}
                request={requestWorker}
              />
            </div>
          )}
          {!data ? (
            <div className="no-analysis">No recording selected.</div>
          ) : tab === 'Summary' ? null : tab === 'Compare' ? (
            <Comparison data={data} range={range} request={requestWorker} />
          ) : tab === 'Telemetry' ? (
            <Telemetry
              data={data}
              range={range}
              request={requestWorker}
              setRange={setRange}
            />
          ) : tab === 'Frames' ? (
            <Frames
              data={data}
              range={range}
              request={requestWorker}
              setRange={setRange}
              inspect={(frame, id) => {
                setRange([frame.start, frame.start + frame.duration]);
                setSelected(id ? { metric: metricMap.get(id) } : null);
                setTab(id ? 'Summary' : 'Bottom-up');
              }}
            />
          ) : (
            <>
              <div className="analysis-toolbar">
                <input
                  id="search"
                  type="search"
                  placeholder="Filter activities"
                  aria-label="Filter activities"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {tab === 'Bottom-up' && (
                  <>
                    <span className="toolbar-separator" />
                    <button
                      id="callbacks"
                      className={
                        mode === 'callbacks' ? 'toggle active' : 'toggle'
                      }
                      aria-pressed={mode === 'callbacks'}
                      onClick={() => setMode('callbacks')}
                    >
                      Callbacks
                    </button>
                    <button
                      id="mods"
                      className={mode === 'mods' ? 'toggle active' : 'toggle'}
                      aria-pressed={mode === 'mods'}
                      onClick={() => setMode('mods')}
                    >
                      Mods
                    </button>
                    <button
                      id="hooks"
                      className={mode === 'hooks' ? 'toggle active' : 'toggle'}
                      aria-pressed={mode === 'hooks'}
                      onClick={() => setMode('hooks')}
                    >
                      Hooks
                    </button>
                  </>
                )}
                {tab === 'Event log' && (
                  <label className="toolbar-checkbox">
                    <input
                      id="event-errors-only"
                      type="checkbox"
                      checked={errorsOnly}
                      onChange={(e) => setErrorsOnly(e.target.checked)}
                    />{' '}
                    Errors only
                  </label>
                )}
                <span className="toolbar-fill" />
                <span id="row-count">
                  {count(
                    tab === 'Event log'
                      ? eventCount
                      : tab === 'Call tree'
                        ? visibleTree.length
                        : results.count,
                  )}{' '}
                  activities
                </span>
                <button
                  className="small-button"
                  disabled={!selected}
                  onClick={() => setTab('Summary')}
                >
                  Show summary
                </button>
              </div>
              {minimumUs > 0 && (
                <div
                  className="short-calls-group"
                  role="status"
                  title="Short callbacks are grouped here. Total time can overlap for nested calls; self time excludes instrumented children."
                >
                  <b>
                    &lt; {minimumCall || '0'}{' '}
                    {durationUnit === 'us' ? '?s' : 'ms'}
                  </b>
                  <span>
                    {count(
                      (tab === 'Event log' ? eventOmitted : results.omitted)
                        ?.calls ?? 0,
                    )}{' '}
                    calls
                  </span>
                  <span>
                    {ms(
                      (tab === 'Event log' ? eventOmitted : results.omitted)
                        ?.self ?? 0,
                    )}{' '}
                    self
                  </span>
                  <span>
                    {ms(
                      (tab === 'Event log' ? eventOmitted : results.omitted)
                        ?.total ?? 0,
                    )}{' '}
                    total
                  </span>
                </div>
              )}
              <div className="analysis-table-scroll">
                {tab === 'Event log' ? (
                  <table className="event-log-table">
                    <SortableHeader
                      columns={(
                        [
                          ['start', 'Start time'],
                          ['duration', 'Total time'],
                          ['self', 'Self time'],
                          ['depth', 'Depth'],
                          ['activity', 'Activity'],
                        ] as [typeof eventSort, string][]
                      ).map(([key, label]) => ({ key, label }))}
                      sort={eventSort}
                      descending={eventDescending}
                      onSort={(key) => {
                        if (eventSort === key) {
                          setEventDescending(!eventDescending);
                        } else {
                          setEventSort(key);
                          setEventDescending(
                            key === 'duration' || key === 'self',
                          );
                        }
                      }}
                      trailing="Error"
                    />
                    <tbody id="rows">
                      {eventRows.map((event, i) => {
                        const metric = metricMap.get(event.metric)!;
                        return (
                          <tr
                            key={i}
                            onClick={() => selectEvent(event, metric)}
                          >
                            <td>{ms(event.start)}</td>
                            <td style={heat(event.duration, callbackWarningUs)}>
                              {ms(event.duration)}
                            </td>
                            <td>{ms(event.self)}</td>
                            <td>{event.depth}</td>
                            <td className="activity">
                              <span
                                className="swatch"
                                style={{ background: color(metric.mod) }}
                              />
                              {metric.callback_name || metric.callback_id}
                              <span className="source-inline">
                                {metric.mod}
                              </span>
                            </td>
                            <td>{event.error ? 'Yes' : '\u2014'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <table className="ranking-table">
                    <TableHeader
                      sort={sort}
                      descending={descending}
                      onSort={onSort}
                    />
                    <tbody id="rows">
                      {(tab === 'Call tree' ? visibleTree : bottomRows).map(
                        (row) => (
                          <ResultRow
                            warningUs={callbackWarningUs}
                            row={row}
                            key={row.key}
                            percent={
                              results.stats.self
                                ? (row.exclusive / results.stats.self) * 100
                                : 0
                            }
                            selected={
                              selected?.row?.key === row.key ||
                              (!!row.metric &&
                                selected?.metric?.id === row.metric.id)
                            }
                            select={() => selectRow(row)}
                            depth={(row as TreeRow).depth}
                            expand={
                              row.children?.length
                                ? () =>
                                    setExpanded((current) => {
                                      const next = new Set(current);
                                      if (next.has(row.key)) {
                                        next.delete(row.key);
                                      } else {
                                        next.add(row.key);
                                      }
                                      return next;
                                    })
                                : undefined
                            }
                            expanded={expanded.has(row.key)}
                          />
                        ),
                      )}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="table-status">
                {minimumUs
                  ? `Retained calls ? ${minimumUs} ?s total duration`
                  : full
                    ? 'Full aggregate totals'
                    : 'Retained calls starting in the selected range'}
                {tab === 'Call tree'
                  ? ' · hierarchy of retained callback events'
                  : ''}{' '}
                ·{' '}
                {tab === 'Event log'
                  ? 'First 500 events in selected sort order'
                  : 'First 500 groups; expand for hook / function breakdown'}
              </div>
            </>
          )}
        </div>
      </section>
      <footer className="status-bar" role="status" aria-live="polite">
        <span className={message ? 'notice' : ''}>
          {busy
            ? 'Processing recording in worker…'
            : message ||
              (data
                ? `${count(data.stats.calls)} calls · ${count(data.count)} retained events`
                : 'Ready')}
        </span>
        <span id="folder-status" title={folderSummary}>
          {folderSummary}
        </span>
        <span className="toolbar-fill" />
        <span>Callback wall time · native API included · local files only</span>
      </footer>
      {dragOver && (
        <div className="drop-overlay">Drop .isaacprof recording</div>
      )}
    </main>
  );
}
