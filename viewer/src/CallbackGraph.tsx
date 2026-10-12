import useGraphNavigation from './useGraphNavigation.ts';
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { axisTime, color, eventAt, ms, visibleIndices } from './trace.ts';

import type {
  Lane,
  LoadedTrace,
  Metric,
  Selection,
  TraceEvent,
  WorkerClient,
} from './types.ts';
interface Props {
  id?: string;
  request: WorkerClient['request'];
  data: LoadedTrace | null;
  range: [number, number];
  setRange: (range: [number, number]) => void;
  selected: Selection | null;
  selectEvent: (event: TraceEvent, metric: Metric) => void;
  search: string;
  minimumUs: number;
}
interface Hit {
  x: number;
  y: number;
  w: number;
  e: TraceEvent;
}

function canvasSize(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.font = '11px Arial, sans-serif';
  return ctx;
}

export default function CallbackGraph({
  data,
  range,
  setRange,
  selected,
  selectEvent,
  search,
  minimumUs,
  id = 'timeline',
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hits = useRef<Hit[]>([]);
  const [width, setWidth] = useState(1);
  const [tooltip, setTooltip] = useState<{
    event: TraceEvent;
    x: number;
    y: number;
  } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const flameHost = useRef<HTMLDivElement>(null);
  const [availableHeight, setAvailableHeight] = useState(150);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setAvailableHeight(Math.max(150, Math.floor(entry.contentRect.height))),
    );
    observer.observe(flameHost.current!);
    return () => observer.disconnect();
  }, []);
  const chart = data;
  const metricMap = useMemo(
    () => new Map(data?.metrics.map((m) => [m.id, m]) || []),
    [data],
  );
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(1, entry.contentRect.width)),
    );
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  const tracks = useMemo(() => {
    if (!data) {
      return [];
    }
    const threads = new Map<number, Lane[]>();
    for (const lane of chart?.lanes ?? []) {
      if (!threads.has(lane.thread)) {
        threads.set(lane.thread, []);
      }
      threads.get(lane.thread)!.push(lane);
    }
    let y = 51;
    return [...threads].map(([thread, lanes]) => {
      const rows = collapsed.has(thread) ? [] : lanes.slice(0, 160);
      const track = { thread, lanes: rows, y };
      y += 24 + rows.length * 18 + 16;
      return track;
    });
  }, [data, chart, collapsed]);
  const height = Math.max(
    availableHeight,
    tracks.length
      ? tracks.at(-1)!.y + 24 + tracks.at(-1)!.lanes.length * 18 + 16
      : 150,
  );
  useEffect(() => {
    const ctx = canvasSize(canvas.current!, width, height);
    ctx.fillStyle = '#202124';
    ctx.fillRect(0, 0, width, height);
    hits.current = [];
    const span = Math.max(0.001, range[1] - range[0]);
    const ticks = Math.max(2, Math.floor(width / 130));
    ctx.fillStyle = '#aeb0b5';
    for (let i = 0; i <= ticks; i++) {
      const x = (i / ticks) * width;
      ctx.fillText(
        axisTime(range[0] + (i / ticks) * span, span),
        Math.min(width - 70, x + 5),
        13,
      );
      ctx.strokeStyle = '#303134';
      ctx.beginPath();
      ctx.moveTo(x, 20);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    if (!data) {
      return;
    }
    ctx.fillStyle = '#292a2d';
    ctx.fillRect(0, 21, width, 24);
    let lastMarker = -100;
    for (const marker of data.markers ?? []) {
      if (marker.time < range[0] || marker.time > range[1]) {
        continue;
      }
      const x = ((marker.time - range[0]) / span) * width;
      ctx.strokeStyle = '#8ab4f8';
      ctx.beginPath();
      ctx.moveTo(x, 23);
      ctx.lineTo(x, 45);
      ctx.stroke();
      if (x - lastMarker > 85) {
        ctx.fillStyle = '#8ab4f8';
        ctx.fillText(
          ['', 'Context', 'Run', 'Room', 'Level', 'Run end', 'Exit'][
            marker.kind
          ],
          x + 4,
          36,
        );
        lastMarker = x;
      }
    }
    for (const loss of data.document.losses ?? []) {
      const a = ((loss.start_ns / 1e6 - range[0]) / span) * width;
      const b = ((loss.end_ns / 1e6 - range[0]) / span) * width;
      if (b < 0 || a > width) {
        continue;
      }
      ctx.fillStyle = '#ed6a5e';
      ctx.fillRect(
        Math.max(0, a),
        46,
        Math.max(2, Math.min(width, b) - Math.max(0, a)),
        3,
      );
    }
    for (const track of tracks) {
      ctx.fillStyle = '#292a2d';
      ctx.fillRect(0, track.y, width, 23);
      ctx.fillStyle = '#e0e0e0';
      ctx.fillText(
        `${collapsed.has(track.thread) ? '\u25b8' : '\u25be'} Main \u2014 Lua callbacks [${track.thread}]`,
        6,
        track.y + 15,
      );
      for (let li = 0; li < track.lanes.length; li++) {
        const lane = track.lanes[li];
        const y = track.y + 25 + li * 18;
        let lastPixel = -1;
        for (const index of visibleIndices(chart!, lane, range[0], range[1])) {
          const e = eventAt(chart!, index);
          const m = metricMap.get(e.metric)!;
          const x = Math.max(0, ((e.start - range[0]) / span) * width);
          const right = Math.min(
            width,
            ((e.start + e.duration - range[0]) / span) * width,
          );
          const w = Math.max(0.7, right - x);
          if (!m || e.duration * 1000 < minimumUs) {
            continue;
          }
          if (
            w < 1 &&
            Math.floor(x) === lastPixel &&
            selected?.event?.index !== e.index
          ) {
            continue;
          }
          lastPixel = Math.floor(x);
          const matching =
            !search ||
            `${m.mod} ${m.callback_name} ${m.source}`
              .toLowerCase()
              .includes(search.toLowerCase());
          ctx.globalAlpha = matching ? 1 : 0.2;
          ctx.fillStyle = color(m.mod);
          ctx.fillRect(x, y, w, 16);
          if (e.error) {
            ctx.fillStyle = '#ef756c';
            ctx.beginPath();
            ctx.moveTo(x + w - 6, y);
            ctx.lineTo(x + w, y);
            ctx.lineTo(x + w, y + 6);
            ctx.fill();
          }
          if (
            selected?.event?.index === e.index ||
            (!selected?.event && selected?.metric?.id === e.metric)
          ) {
            ctx.strokeStyle = '#9fc4ff';
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 1, y + 1, Math.max(1, w - 2), 14);
            ctx.lineWidth = 1;
          }
          if (w > 35) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + 2, y, w - 4, 16);
            ctx.clip();
            ctx.fillStyle = '#202124';
            ctx.fillText(m.callback_name || m.callback_id, x + 3, y + 12);
            ctx.restore();
          }
          ctx.globalAlpha = 1;
          hits.current.push({ x, y, w, e });
        }
      }
    }
  }, [
    data,
    chart,
    width,
    height,
    range,
    selected,
    search,
    minimumUs,
    tracks,
    metricMap,
    collapsed,
  ]);

  function point(
    e:
      | React.PointerEvent<HTMLCanvasElement>
      | React.MouseEvent<HTMLCanvasElement>,
    el: HTMLCanvasElement,
  ) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.x, y: e.clientY - r.y };
  }

  function hit(p: { x: number; y: number }) {
    return hits.current.findLast(
      (h) => p.y >= h.y && p.y <= h.y + 16 && p.x >= h.x && p.x <= h.x + h.w,
    )?.e;
  }

  function hover(e: React.PointerEvent<HTMLCanvasElement>) {
    const found = hit(point(e, e.currentTarget));
    setTooltip(found ? { event: found, x: e.clientX, y: e.clientY } : null);
  }

  const navigation = useGraphNavigation({
    element: canvas,
    range,
    duration: data?.count ? data.duration : 0,
    setRange,
    onClick: (e) => {
      const p = point(e, e.currentTarget);
      const track = tracks.find((t) => p.y >= t.y && p.y < t.y + 24);
      if (track) {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(track.thread)) {
            next.delete(track.thread);
          } else {
            next.add(track.thread);
          }
          return next;
        });
      } else {
        const found = hit(p);
        if (found) {
          selectEvent(found, metricMap.get(found.metric)!);
        }
      }
    },
  });
  return (
    <div className="timeline-region" ref={host}>
      <div className="flame-scroll" ref={flameHost}>
        <canvas
          id={id}
          ref={canvas}
          tabIndex={0}
          aria-label="Main callback flame chart"
          {...navigation}
          onPointerMove={(e) => {
            navigation.onPointerMove(e);
            if (!e.buttons) {
              hover(e);
            } else {
              setTooltip(null);
            }
          }}
          onPointerLeave={() => setTooltip(null)}
          onDoubleClick={(e) => {
            const found = hit(point(e, e.currentTarget));
            if (found) {
              const padding = Math.max(0.01, found.duration * 0.1);
              setRange([
                found.start - padding,
                found.start + found.duration + padding,
              ]);
              selectEvent(found, metricMap.get(found.metric)!);
            }
          }}
        />
        {!data && (
          <div className="empty-trace">
            <p>Load a recording to analyze performance</p>
            <span>Open an .isaacprof file or drag it into this window.</span>
            <span>Data is read from your disk and processed in a worker.</span>
          </div>
        )}
        {data && !data.count && (
          <div className="empty-trace">
            <p>This recording contains aggregate timings only</p>
            <span>
              Record with --trace to inspect individual callback events.
            </span>
          </div>
        )}
      </div>
      {tooltip && (
        <div
          className="event-tooltip"
          style={{
            left: Math.min(tooltip.x + 14, innerWidth - 330),
            top: Math.min(tooltip.y + 14, innerHeight - 110),
          }}
        >
          <b>
            {metricMap.get(tooltip.event.metric)?.callback_name ||
              metricMap.get(tooltip.event.metric)?.callback_id}
          </b>
          <span>{metricMap.get(tooltip.event.metric)?.mod}</span>
          <span>
            {ms(tooltip.event.duration)} total · {ms(tooltip.event.self)} self
          </span>
        </div>
      )}
    </div>
  );
}
