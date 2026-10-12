import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import CallbackGraph from './CallbackGraph.tsx';
import PerformanceGraph from './PerformanceGraph.tsx';
import Filmstrip from './Filmstrip.tsx';
import type { GraphKind, GraphResult } from './graphs.ts';
import type {
  LoadedTrace,
  Metric,
  Selection,
  TraceEvent,
  WorkerClient,
  WorkerOperations,
} from './types.ts';
import { ms } from './trace.ts';
import './graphs.css';
type Kind = 'callbacks' | GraphKind;
interface Props {
  request: WorkerClient['request'];
  data: LoadedTrace | null;
  range: [number, number];
  setRange: (range: [number, number]) => void;
  selected: Selection | null;
  selectEvent: (event: TraceEvent, metric: Metric) => void;
  search: string;
  minimumUs: number;
}
const options: [Kind, string][] = [
  ['callbacks', 'Callbacks'],
  ['render-ms', 'Render interval (ms)'],
  ['render-percentiles', 'Render interval percentiles'],
  ['fps', 'FPS + percentiles'],
  ['presentation-ms', 'Presentation / SwapBuffers (ms)'],
  ['update-ms', 'Update interval (ms)'],
  ['update-percentiles', 'Update interval percentiles'],
  ['ups', 'UPS + percentiles'],
  ['self', 'Callback self'],
  ['calls', 'Callback count'],
  ['cpu', 'Lua thread CPU'],
  ['heap', 'Lua heap'],
  ['entities', 'Room entities'],
  ['projectiles', 'Enemy projectiles'],
  ['effects', 'Effects'],
];
export default function Timeline(props: Props) {
  const { data, range, setRange, request, minimumUs } = props;
  const host = useRef<HTMLDivElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<number | null>(null);
  const serial = useRef(1);
  const [width, setWidth] = useState(1000);
  const [panes, setPanes] = useState<
    { id: number; kind: Kind; windowMs: number }[]
  >([{ id: 0, kind: 'callbacks', windowMs: 1000 }]);
  const primary = panes[0];
  const overviewKey = JSON.stringify([primary.kind, primary.windowMs, width]);
  const [overviewState, setOverviewState] = useState<{
    owner: LoadedTrace;
    key: string;
    result?: GraphResult;
    error?: string;
  } | null>(null);
  const overviewResult =
    overviewState?.owner === data && overviewState.key === overviewKey
      ? overviewState.result
      : undefined;
  useEffect(() => {
    if (!data?.streaming || primary.kind === 'callbacks') {
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void request('graph', {
        kind: primary.kind as GraphKind,
        slot: -1,
        start: 0,
        end: data.duration,
        columns: Math.round(width),
        windowMs: primary.windowMs,
      })
        .then((result) => {
          if (active) {
            setOverviewState({ owner: data, key: overviewKey, result });
          }
        })
        .catch((e: unknown) => {
          if (active) {
            setOverviewState({
              owner: data,
              key: overviewKey,
              error: e instanceof Error ? e.message : 'Cannot read overview',
            });
          }
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, primary.kind, primary.windowMs, width, overviewKey, request]);
  const hasCallbacks = panes.some((p) => p.kind === 'callbacks');
  const [viewport, setViewport] = useState<{
    owner: LoadedTrace;
    key: string;
    view: WorkerOperations['viewport']['result'];
  } | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify([range, width, minimumUs]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(100, entry.contentRect.width)),
    );
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!data?.streaming || !hasCallbacks) {
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void request('viewport', {
        start: range[0],
        end: range[1],
        width,
        minimumUs,
      })
        .then((view) => {
          if (active) {
            setViewport({ owner: data, key, view });
            setError('');
          }
        })
        .catch((e: unknown) => {
          if (active) {
            setError(e instanceof Error ? e.message : 'Cannot read callbacks');
          }
        });
    }, 60);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, range, width, key, hasCallbacks, request, minimumUs]);
  useEffect(() => {
    const canvas = overview.current!;
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = 94 * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#252629';
    ctx.fillRect(0, 0, width, 94);
    ctx.font = '11px Arial';
    ctx.fillStyle = '#aeb0b5';
    const duration = Math.max(0.001, data?.duration ?? 1);
    const ticks = Math.max(2, Math.floor(width / 130));
    for (let i = 0; i <= ticks; i++) {
      ctx.fillText(
        ms((i / ticks) * duration),
        Math.min(width - 70, (i / ticks) * width + 5),
        12,
      );
    }
    if (!data) {
      return;
    }
    const series =
      primary.kind === 'callbacks'
        ? [
            {
              color: '#d2b252',
              points: Array.from(data.bins, (value, i) => ({
                time: (i / data.bins.length) * duration,
                value,
              })),
            },
          ]
        : (overviewResult?.series ?? [
            { color: '#8ab4f8', points: overviewResult?.points ?? [] },
          ]);
    let max = 0.001;
    for (const line of series) {
      for (const point of line.points) {
        max = Math.max(max, point.value);
      }
    }
    for (const line of series) {
      ctx.strokeStyle = line.color;
      ctx.beginPath();
      line.points.forEach((p, i) => {
        const x = (p.time / duration) * width;
        const y = 75 - (p.value / max) * 42;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    }
    ctx.fillStyle = '#bdc1c6';
    ctx.fillText(
      `Overview \u00b7 ${options.find(([kind]) => kind === primary.kind)?.[1] ?? primary.kind}${primary.kind !== 'callbacks' && !overviewResult ? ' \u00b7 reading\u2026' : ''}`,
      7,
      28,
    );
    const a = (range[0] / duration) * width;
    const b = (range[1] / duration) * width;
    ctx.fillStyle = '#08090ba0';
    ctx.fillRect(0, 17, a, 77);
    ctx.fillRect(b, 17, width - b, 77);
    ctx.strokeStyle = '#91b5f8';
    ctx.strokeRect(a + 0.5, 17.5, Math.max(1, b - a - 1), 76);
  }, [data, range, width, primary.kind, overviewResult]);
  const shown =
    data && viewport?.owner === data && viewport.key === key
      ? { ...data, ...viewport.view }
      : data;

  function position(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * (data?.duration ?? 1);
  }

  return (
    <div className="timeline-region" ref={host}>
      <canvas
        id="overview"
        ref={overview}
        aria-label={`Timeline overview: ${options.find(([kind]) => kind === primary.kind)?.[1] ?? primary.kind}`}
        title={
          overviewState?.owner === data && overviewState.key === overviewKey
            ? overviewState.error
            : undefined
        }
        onPointerDown={(e) => {
          if (!data) {
            return;
          }
          drag.current = position(e);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current !== null) {
            const time = position(e);
            setRange([
              Math.min(drag.current, time),
              Math.max(drag.current, time),
            ]);
          }
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => (drag.current = null)}
      />
      {!!data?.document.screenshots?.images.length && (
        <Filmstrip data={data} range={range} setRange={setRange} />
      )}
      {data?.streaming &&
        hasCallbacks &&
        (error || viewport?.owner !== data || viewport.key !== key) && (
          <div className="trace-load-status" role="status">
            {error || 'Reading visible range from local file…'}
          </div>
        )}
      <div className="graph-stack">
        {panes.map((pane, index) => (
          <section
            className="graph-pane"
            key={pane.id}
            aria-label={`Graph ${index + 1}`}
          >
            <div className="graph-toolbar">
              <label>
                Graph{' '}
                <select
                  id={index === 0 ? 'graph-kind' : `graph-kind-${pane.id}`}
                  aria-label={`Graph ${index + 1} channel`}
                  value={pane.kind}
                  onChange={(e) =>
                    setPanes((old) =>
                      old.map((p) =>
                        p.id === pane.id
                          ? { ...p, kind: e.target.value as Kind }
                          : p,
                      ),
                    )
                  }
                >
                  {options.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="small-button"
                aria-label="Add graph"
                title="Add an independent graph below"
                onClick={() => {
                  const id = serial.current++;
                  setPanes((old) => [
                    ...old,
                    { id, kind: 'fps', windowMs: 1000 },
                  ]);
                }}
              >
                ＋
              </button>
              {panes.length > 1 && (
                <button
                  className="small-button"
                  aria-label={`Remove graph ${index + 1}`}
                  onClick={() =>
                    setPanes((old) => old.filter((p) => p.id !== pane.id))
                  }
                >
                  ×
                </button>
              )}
              {(pane.kind === 'fps' ||
                pane.kind === 'ups' ||
                pane.kind.endsWith('percentiles')) && (
                <label>
                  Window{' '}
                  <select
                    aria-label={`Graph ${index + 1} rolling window`}
                    value={pane.windowMs}
                    onChange={(e) =>
                      setPanes((old) =>
                        old.map((p) =>
                          p.id === pane.id
                            ? { ...p, windowMs: Number(e.target.value) }
                            : p,
                        ),
                      )
                    }
                  >
                    {[250, 500, 1000, 2000, 5000, 10000].map((ms) => (
                      <option key={ms} value={ms}>
                        {ms / 1000} s
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <span className="toolbar-fill" />
              <span>
                {ms(range[0])} – {ms(range[1])}
              </span>
            </div>
            {pane.kind === 'callbacks' ? (
              <CallbackGraph
                {...props}
                data={shown}
                id={index === 0 ? 'timeline' : `timeline-${pane.id}`}
              />
            ) : data?.streaming ? (
              <PerformanceGraph
                data={data}
                range={range}
                request={request}
                setRange={setRange}
                kind={pane.kind}
                slot={pane.id}
                windowMs={pane.windowMs}
              />
            ) : (
              <div className="no-analysis">
                Load a streaming recording to view this channel.
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
