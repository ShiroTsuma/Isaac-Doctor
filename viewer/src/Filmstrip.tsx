import { useEffect, useMemo, useRef, useState } from 'react';
import { ms } from './trace.ts';
import type { LoadedTrace, Screenshot } from './types.ts';
interface Frame {
  shot: Screenshot;
  bitmap: ImageBitmap;
  closed: boolean;
}
function closeFrame(frame: Frame) {
  if (!frame.closed) {
    frame.closed = true;
    frame.bitmap.close();
  }
}
function drawable(frame: Frame) {
  return !frame.closed && frame.bitmap.width > 0 && frame.bitmap.height > 0;
}
export default function Filmstrip({
  data,
  range,
  setRange,
}: {
  data: LoadedTrace;
  range: [number, number];
  setRange: (range: [number, number]) => void;
}) {
  const [loaded, setLoaded] = useState<{ source: LoadedTrace; frames: Frame[] } | null>(null),
    [hovered, setHovered] = useState<{ source: LoadedTrace; frame: Frame; x: number } | null>(null),
    host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    preview = useRef<HTMLCanvasElement>(null),
    [width, setWidth] = useState(1);
  const frames = useMemo(() => (loaded?.source === data ? loaded.frames : []), [loaded, data]),
    hover = hovered?.source === data && drawable(hovered.frame) ? hovered : null;
  useEffect(() => {
    let active = true;
    const images: Frame[] = [];
    void Promise.all(
      (data.document.screenshots?.images ?? []).map(async (shot) => {
        const bitmap = await createImageBitmap(new Blob([shot.png], { type: 'image/png' })),
          frame = { shot, bitmap, closed: false };
        images.push(frame);
        if (!active) closeFrame(frame);
        return frame;
      }),
    )
      .then((next) => {
        if (active) setLoaded({ source: data, frames: next });
      })
      .catch(() => {
        if (active) setLoaded({ source: data, frames: [] });
        active = false;
        for (const frame of images) closeFrame(frame);
      });
    return () => {
      active = false;
      for (const frame of images) closeFrame(frame);
    };
  }, [data]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const dpr = devicePixelRatio || 1;
    target.width = width * dpr;
    target.height = 90 * dpr;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, 90);
    const span = range[1] - range[0];
    for (let x = 0; x < width; x += 132) {
      const time = range[0] + ((x + 66) / width) * span,
        frame = frames.findLast((item) => drawable(item) && item.shot.time_ns / 1e6 <= time);
      if (!frame) continue;
      ctx.drawImage(frame.bitmap, x + 2, 4, 128, 72);
      ctx.fillStyle = '#bdc1c6';
      ctx.font = '10px Arial';
      ctx.fillText(ms(frame.shot.time_ns / 1e6), x + 5, 87);
    }
  }, [frames, range, width]);
  useEffect(() => {
    if (!hover || !drawable(hover.frame) || !preview.current) return;
    const ctx = preview.current.getContext('2d');
    if (ctx) ctx.drawImage(hover.frame.bitmap, 0, 0, 320, 180);
  }, [hover]);
  function frameAt(x: number) {
    const time = range[0] + (x / width) * (range[1] - range[0]);
    return frames.findLast((item) => drawable(item) && item.shot.time_ns / 1e6 <= time);
  }
  return (
    <div className="filmstrip" ref={host}>
      <canvas
        id="filmstrip"
        ref={canvas}
        height={90}
        style={{ width }}
        aria-label="Game screenshots aligned to recording time"
        onPointerMove={(e) => {
          const frame = frameAt(e.clientX - e.currentTarget.getBoundingClientRect().x);
          setHovered(frame ? { source: data, frame, x: e.clientX } : null);
        }}
        onPointerLeave={() => setHovered(null)}
        onClick={(e) => {
          const frame = frameAt(e.clientX - e.currentTarget.getBoundingClientRect().x);
          if (frame) {
            const time = frame.shot.time_ns / 1e6,
              span = Math.min(data.duration, Math.max(50, range[1] - range[0]));
            setRange([time - span / 2, time + span / 2]);
          }
        }}
      />
      {hover && (
        <div
          className="screenshot-preview"
          style={{ left: Math.max(0, Math.min(innerWidth - 330, hover.x - 160)) }}
        >
          <canvas ref={preview} width={320} height={180} />
          <span>{ms(hover.frame.shot.time_ns / 1e6)}</span>
        </div>
      )}
    </div>
  );
}
