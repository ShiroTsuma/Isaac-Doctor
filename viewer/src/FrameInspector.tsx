import { useEffect, useState } from 'react';
import SortableHeader from './SortableHeader.tsx';
import type { FrameDetail, FrameCost } from './frame-detail.ts';
import type { FrameInterval, LoadedTrace, WorkerClient } from './types.ts';
import { count, ms } from './trace.ts';

type Sort = 'label' | 'self' | 'baselineSelf' | 'delta' | 'calls' | 'perCall' | 'baselinePerCall';
const signed = (value: number) => `${value >= 0 ? '+' : ''}${ms(value)}`;
export default function FrameInspector({
  data,
  frame,
  request,
  close,
  inspect,
}: {
  data: LoadedTrace;
  frame: FrameInterval;
  request: WorkerClient['request'];
  close: () => void;
  inspect: (id: number) => void;
}) {
  const [state, setState] = useState<{
      owner: LoadedTrace;
      frame: FrameInterval;
      result?: FrameDetail;
      error?: string;
    } | null>(null),
    [expanded, setExpanded] = useState(new Set<string>());
  const [sort, setSort] = useState<Sort>('delta'),
    [descending, setDescending] = useState(true);
  useEffect(() => {
    let active = true;
    void request('frameDetail', frame)
      .then((result) => {
        if (active) setState({ owner: data, frame, result });
      })
      .catch((e: unknown) => {
        if (active)
          setState({
            owner: data,
            frame,
            error: e instanceof Error ? e.message : 'Cannot read frame details',
          });
      });
    return () => {
      active = false;
    };
  }, [data, frame, request]);
  const result = state?.owner === data && state.frame === frame ? state.result : undefined;
  const rows: (FrameCost & { depth: number })[] = [];
  function value(c: FrameCost) {
    return sort === 'delta'
      ? c.self - c.baselineSelf
      : sort === 'perCall'
        ? c.calls
          ? c.self / c.calls
          : 0
        : sort === 'baselinePerCall'
          ? c.baselineCalls
            ? c.baselineSelf / c.baselineCalls
            : 0
          : c[sort];
  }
  function visit(costs: FrameCost[], depth = 0) {
    for (const cost of [...costs].sort((a, b) => {
      const x = value(a),
        y = value(b);
      return (
        (descending ? -1 : 1) *
          (typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)) ||
        a.key.localeCompare(b.key)
      );
    })) {
      rows.push({ ...cost, depth });
      if (cost.children && expanded.has(cost.key)) visit(cost.children, depth + 1);
    }
  }
  if (result) visit(result.costs);
  const wallDelta =
    result?.baselineWall !== null && result?.baselineWall !== undefined
      ? frame.duration - result.baselineWall
      : null;
  const selfDelta = result ? result.self - result.baselineSelf : 0,
    remainingDelta = wallDelta === null ? null : wallDelta - selfDelta;
  const explanation = !result?.baseline
    ? 'No comparable reference intervals.'
    : wallDelta !== null && wallDelta <= 0.1
      ? 'This interval has no substantial extra wall time relative to the reference.'
      : result.incomplete
        ? 'Recorded callback attribution is partial; missing work can affect this comparison.'
        : result.boundaryCrossingCalls
          ? 'Boundary-crossing callbacks limit the wall-time comparison.'
          : wallDelta !== null && selfDelta >= wallDelta * 0.6
            ? 'Most observed extra wall time is accompanied by higher callback self time.'
            : wallDelta !== null && remainingDelta !== null && remainingDelta >= wallDelta * 0.6
              ? 'Most extra wall time is not attributed to measured callbacks. Engine work, waiting, GC and recorder overhead are not separately resolved.'
              : 'Both callback self and unattributed wall time increased.';
  return (
    <div className="frame-inspector">
      <div className="analysis-toolbar">
        <button className="small-button" onClick={close}>
          Back to frames
        </button>
        <b>
          {frame.kind === 2 ? 'Render' : 'Update'} #{frame.id} · {ms(frame.start)}
        </b>
      </div>
      {!result ? (
        <div className="frame-note" role="status">
          {state?.owner === data && state.frame === frame
            ? state.error || 'Reading frame breakdown…'
            : 'Reading frame breakdown…'}
        </div>
      ) : (
        <>
          <div className="frame-stats">
            <span>
              Wall <b>{ms(frame.duration)}</b>
            </span>
            <span>
              Callback self <b>{ms(result.self)}</b>
            </span>
            <span title="Wall minus retained callback self; not a CPU/GPU measurement">
              Unattributed wall <b>{ms(Math.max(0, frame.duration - result.self))}</b>
            </span>
            <span>
              {frame.kind === 2
                ? result.hasUpdate
                  ? 'With update observation'
                  : 'Without update observation'
                : 'Update interval'}
            </span>
          </div>
          <div className="frame-explanation" id="frame-explanation">
            <b>Why was this interval slow?</b>
            <p>{explanation}</p>
            <div>
              {[
                ['Extra wall', wallDelta],
                ['Extra callback self', wallDelta === null ? null : selfDelta],
                ['Extra unattributed wall', remainingDelta],
              ].map(([label, value]) => (
                <span key={String(label)}>
                  {label}{' '}
                  <strong>{typeof value === 'number' ? signed(value) : 'Unavailable'}</strong>
                </span>
              ))}
            </div>
            <small>
              Differences are observations, not proof of causation. Native game API work and waiting
              inside a callback count as callback self.
            </small>
          </div>
          <div className="frame-note">
            {result.baseline ? (
              <>
                Reference: mean of {result.reference.frames.length} nearby intervals near the
                typical duration, from {count(result.baselinePopulation)} candidates with the same
                clock, thread and update activity. Mean wall {ms(result.baselineWall!)}.{' '}
                {result.reference.reason}{' '}
                {result.reference.frames.length < 3
                  ? 'Small reference population; treat differences cautiously.'
                  : ''}
              </>
            ) : (
              result.reference.reason
            )}{' '}
            {result.incomplete ? 'Attribution is incomplete or filtered.' : ''}
          </div>
          <div className="frame-note">
            {result.context ? (
              <>
                Room {result.context.room} · stage {result.context.stage}/{result.context.stageType}{' '}
                · {result.context.width}×{result.context.height} · grids {result.context.grids}/
                {result.context.gridSlots} · entities {result.context.entities} · enemies{' '}
                {result.context.enemies} · tears {result.context.tears} · projectiles{' '}
                {result.context.projectiles} · effects {result.context.effects} · sample{' '}
                {ms(frame.start - result.context.time)} before interval
              </>
            ) : (
              'Fresh room context is unavailable for this interval.'
            )}
          </div>
          <div className="analysis-table-scroll">
            <table>
              <SortableHeader
                columns={(
                  [
                    ['label', 'Mod → hook → function'],
                    ['self', 'Self'],
                    ['baselineSelf', 'Reference self'],
                    ['delta', 'Extra self'],
                    ['calls', 'Calls / reference'],
                    ['perCall', 'Self / call (µs)'],
                    ['baselinePerCall', 'Reference / call (µs)'],
                  ] as [Sort, string][]
                ).map(([key, label]) => ({ key, label }))}
                sort={sort}
                descending={descending}
                onSort={(key) => {
                  if (sort === key) setDescending(!descending);
                  else {
                    setSort(key);
                    setDescending(key !== 'label');
                  }
                }}
              />
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td style={{ paddingLeft: 8 + row.depth * 16 }}>
                      {row.children && (
                        <button
                          className="tree-toggle"
                          aria-label={`${expanded.has(row.key) ? 'Collapse' : 'Expand'} ${row.label}`}
                          onClick={() =>
                            setExpanded((old) => {
                              const next = new Set(old);
                              if (next.has(row.key)) next.delete(row.key);
                              else next.add(row.key);
                              return next;
                            })
                          }
                        >
                          {expanded.has(row.key) ? '▾' : '▸'}
                        </button>
                      )}
                      {row.metric ? (
                        <button className="row-button" onClick={() => inspect(row.metric!)}>
                          {row.label}
                        </button>
                      ) : (
                        row.label
                      )}
                    </td>
                    <td>{ms(row.self)}</td>
                    <td>{result.baseline ? ms(row.baselineSelf) : '—'}</td>
                    <td>{result.baseline ? signed(row.self - row.baselineSelf) : '—'}</td>
                    <td>
                      {count(row.calls)} / {result.baseline ? row.baselineCalls.toFixed(1) : '—'}
                    </td>
                    <td>{row.calls ? ((row.self * 1000) / row.calls).toFixed(2) : '—'}</td>
                    <td>
                      {row.baselineCalls
                        ? ((row.baselineSelf * 1000) / row.baselineCalls).toFixed(2)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.telemetry.errors?.map((error, i) => (
              <details className="lua-error" key={`${error.span}:${i}`}>
                <summary>
                  {ms(error.time)} · {error.message}
                </summary>
                <button className="row-button" onClick={() => inspect(error.metric)}>
                  Inspect callback
                </button>
                <pre>{error.stack}</pre>
              </details>
            ))}
          </div>
          <div className="frame-note">
            Self attribution uses retained calls starting in this interval on its thread.{' '}
            {result.boundaryCrossingCalls > 0
              ? `${count(result.boundaryCrossingCalls)} calls cross its end and include self time beyond the boundary.`
              : ''}{' '}
            Reference self/calls are averaged over the comparison intervals.
          </div>
        </>
      )}
    </div>
  );
}
