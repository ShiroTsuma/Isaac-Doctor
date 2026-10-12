import { useEffect, useState } from 'react';
import type { RecordingStatus } from './RecordingControls.tsx';
import type { ProcessingProgress } from './stream.ts';
export default function RecordingStage({
  status,
  loading,
  processing,
}: {
  status: RecordingStatus | null;
  loading: boolean;
  processing?: ProcessingProgress | null;
}) {
  const [clock, setClock] = useState(() => performance.now());
  const collecting = status?.state === 'recording';
  const armed = status?.state === 'armed';
  const saving = status?.state === 'saving';
  useEffect(() => {
    if (!collecting) {
      return;
    }
    const timer = setInterval(() => setClock(performance.now()), 200);
    return () => clearInterval(timer);
  }, [collecting]);
  if (!loading && !collecting && !armed && !saving) {
    return null;
  }
  const elapsed =
    (status?.elapsedMs ?? 0) +
    Math.max(0, clock - (status?.updatedAt ?? clock));
  const duration = status?.durationMs ?? 0;
  const finishing = collecting && duration > 0 && elapsed >= duration;
  const title = loading
    ? 'Loading profile…'
    : armed
      ? 'Waiting for start trigger…'
      : saving || finishing
        ? 'Saving recording…'
        : 'Collecting profile…';
  return (
    <div className="recording-stage" role="status" aria-live="polite">
      <div className="recording-stage-card">
        <span
          className={
            collecting && !finishing ? 'collecting-dot' : 'stage-spinner'
          }
        />
        <b>{title}</b>
        {loading && processing ? (
          <>
            <span>
              {processing.stage}: {processing.percent}%
            </span>
            <span>
              {processing.completed.toLocaleString()} /{' '}
              {processing.total.toLocaleString()} blocks
            </span>
            <progress
              max={Math.max(1, processing.total)}
              value={processing.completed}
              aria-label="Analysis processing progress"
            />
          </>
        ) : collecting && duration > 0 ? (
          <>
            <span>
              {(Math.min(elapsed, duration) / 1000).toFixed(1)} /{' '}
              {(duration / 1000).toFixed(0)} s
            </span>
            <progress
              max={duration}
              value={Math.min(elapsed, duration)}
              aria-label="Recording progress"
            />
          </>
        ) : (
          <span>
            {loading
              ? 'Reading local file in Web Worker'
              : armed
                ? status?.message || 'Waiting for configured start trigger'
                : collecting
                  ? status?.message || 'Waiting for configured stop trigger'
                  : 'Collector is finishing the binary capture'}
          </span>
        )}
      </div>
    </div>
  );
}
