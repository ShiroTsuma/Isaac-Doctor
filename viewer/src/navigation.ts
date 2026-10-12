export type NavigationTab =
  | 'Summary'
  | 'Bottom-up'
  | 'Call tree'
  | 'Event log'
  | 'Frames'
  | 'Telemetry'
  | 'Compare';
export type FrameView = 'frames' | 'presentation' | 'patterns';
export interface NavigationEntry {
  id: string;
  label: string;
  description: string;
  category: 'View' | 'Command' | 'Recording' | 'Mod' | 'Hook' | 'Source';
  keywords: string;
  requiresRecording?: boolean;
  tab?: NavigationTab;
  frameView?: FrameView;
  target?: string;
  selector?: string;
  metric?: number;
  value?: string;
  graph?: string;
}
export const navigationViews: NavigationEntry[] = [
  ...(
    [
      'Summary',
      'Bottom-up',
      'Call tree',
      'Event log',
      'Frames',
      'Telemetry',
      'Compare',
    ] as NavigationTab[]
  ).map((tab) => ({
    id: tab,
    label: tab,
    description: 'Analysis view',
    category: 'View' as const,
    keywords: tab,
    requiresRecording: true,
    tab,
    target: '#analysis-content',
  })),
  {
    id: 'swap',
    label: 'SwapBuffers / Presentation',
    description:
      'Frames / Presentation - presentation intervals and driver synchronization',
    category: 'View',
    keywords: 'swap buffers swapbuffers presentation render driver gpu vsync',
    requiresRecording: true,
    tab: 'Frames',
    frameView: 'presentation',
    target: '#presentation-panel',
  },
  {
    id: 'samples',
    label: 'Native instruction samples',
    description:
      'Frames / Presentation - Lua owners and sampled function definitions',
    category: 'View',
    keywords: 'native instruction samples sampling lua hotspots functions',
    requiresRecording: true,
    tab: 'Frames',
    frameView: 'presentation',
    target: '#instruction-samples',
  },
  {
    id: 'waits',
    label: 'Native waits / Sleep',
    description: 'Frames / Presentation - observed waiting APIs',
    category: 'View',
    keywords: 'waits sleep limiter waiting',
    requiresRecording: true,
    tab: 'Frames',
    frameView: 'presentation',
    target: '#presentation-panel',
  },
  {
    id: 'patterns',
    label: 'Slow-frame patterns',
    description: 'Frames - compare slow and reference intervals',
    category: 'View',
    keywords: 'slow frame patterns drops reference lows',
    requiresRecording: true,
    tab: 'Frames',
    frameView: 'patterns',
    target: '#analysis-content',
  },
  {
    id: 'scope',
    label: 'Configure capture scope',
    description: 'Channels, mod/hook filters and recording options',
    category: 'View',
    keywords:
      'configure capture scope channels mods hooks instrumentation settings',
    target: '.record-scope',
  },
  {
    id: 'trigger',
    label: 'Recording triggers and duration',
    description: 'Start/stop conditions, delays and time limits',
    category: 'View',
    keywords: 'recording triggers start stop delay duration manual',
    target: '.record-trigger-controls',
  },
  ...[
    [
      'fps',
      'FPS graph / percentiles',
      'fps frames per second p50 p90 p95 p99 drops',
    ],
    [
      'ups',
      'UPS graph / percentiles',
      'ups updates per second p50 p90 p95 p99',
    ],
    ['effects', 'Effects graph', 'effects count'],
    ['entities', 'Room entities graph', 'room entities count'],
    ['heap', 'Lua heap graph', 'heap lua memory allocation'],
    ['cpu', 'Lua thread CPU graph', 'cpu thread cycles'],
    ['projectiles', 'Enemy projectiles graph', 'enemy projectiles count'],
  ].map(([graph, label, keywords]) => ({
    id: 'graph-' + graph,
    label,
    description: 'Switch the first graph; keep additional graphs',
    category: 'View' as const,
    keywords,
    requiresRecording: true,
    graph,
    target: '.graph-stack',
  })),
];
export const navigationCommands: NavigationEntry[] = [
  [
    'save',
    'Save recording',
    '[aria-label="Save recording"]',
    'save binary trace',
  ],
  [
    'clear',
    'Clear loaded recording',
    '[aria-label="Clear recording"]',
    'clear reset analysis cancel processing',
  ],
  [
    'connect-captures',
    'Connect captures folder',
    '#connect-captures',
    'connect directory automatic completed recording',
  ],
  [
    'prepare',
    'Save prepared analysis in recording',
    '#save-analysis-cache',
    'prepare summary cache analysis',
  ],
  [
    'open',
    'Open recording',
    '[aria-label="Open recording"]',
    'file disk binary trace',
  ],
  [
    'folder',
    'Open recordings folder',
    '[aria-label="Open folder"]',
    'directory local files captures',
  ],
  ['connect', 'Connect game', '#attach-game', 'attach isaac'],
  ['record', 'Start recording', '#record-game', 'record capture collect'],
  ['stop', 'Stop recording', '#stop-game', 'stop capture finish'],
  ['fit', 'Show entire recording', '#reset', 'fit reset zoom range'],
  ['zoom', 'Zoom in', '#zoom-in', 'zoom'],
  ['export', 'Export Chrome Trace', '#export', 'export json chrome'],
  [
    'settings',
    'Viewer settings',
    '[aria-label="Settings"]',
    'settings preferences',
  ],
].map(([id, label, selector, keywords]) => ({
  id: 'command-' + id,
  label,
  description: 'Run application command',
  category: 'Command',
  selector,
  keywords,
}));
export function searchNavigation(
  entries: NavigationEntry[],
  query: string,
  limit = 12,
) {
  const prefix = query.trim()[0];
  const terms = query
    .trim()
    .replace(/^[>/@]/, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .filter(Boolean);
  return entries
    .filter(
      (entry) =>
        (prefix !== '>' || entry.category === 'Command') &&
        (prefix !== '/' ||
          entry.category === 'Recording' ||
          entry.category === 'Source') &&
        (prefix !== '@' ||
          entry.category === 'Mod' ||
          entry.category === 'Hook'),
    )
    .map((entry) => {
      const label = entry.label.toLowerCase();
      const haystack = (
        label +
        ' ' +
        entry.keywords +
        ' ' +
        entry.description
      ).toLowerCase();
      return {
        entry,
        score: terms.every((term) => haystack.includes(term))
          ? terms.reduce(
              (n, term) =>
                n + (label.startsWith(term) ? 4 : label.includes(term) ? 2 : 1),
              0,
            )
          : -1,
      };
    })
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}
