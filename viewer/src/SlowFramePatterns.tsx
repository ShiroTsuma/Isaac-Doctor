import { useEffect, useState } from 'react';
import SortableHeader from './SortableHeader.tsx';
import type { FrameRow, LoadedTrace, WorkerClient, WorkerOperations } from './types.ts';
import { count, ms } from './trace.ts';

type Result = WorkerOperations['diagnose']['result'];
type Pattern = Result['matched_slow_frames']['recurring_callback_increases'][number];
type Sort =
  | 'mod'
  | 'affected_intervals'
  | 'total_extra_self_ms'
  | 'mean_extra_self_ms_when_present'
  | 'maximum_extra_self_ms';
export default function SlowFramePatterns({
  data,
  range,
  kind,
  request,
  close,
  inspect,
}: {
  data: LoadedTrace;
  range: [number, number];
  kind: 1 | 2;
  request: WorkerClient['request'];
  close: () => void;
  inspect: (frame: FrameRow) => void;
}) {
  const key = JSON.stringify([range, kind]),
    [state, setState] = useState<{
      owner: LoadedTrace;
      key: string;
      result?: Result;
      error?: string;
    } | null>(null);
  const [sort, setSort] = useState<Sort>('total_extra_self_ms'),
    [descending, setDescending] = useState(true);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void request('diagnose', { start: range[0], end: range[1], kind, top: 20 })
        .then((result) => {
          if (active) setState({ owner: data, key, result });
        })
        .catch((error: unknown) => {
          if (active)
            setState({
              owner: data,
              key,
              error: error instanceof Error ? error.message : 'Slow-frame analysis failed',
            });
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, range, kind, key, request]);
  const resolved = state?.owner === data && state.key === key,
    result = resolved ? state.result : undefined,
    matched = result?.matched_slow_frames;
  const rows = [...(matched?.recurring_callback_increases ?? [])].sort((a: Pattern, b: Pattern) => {
    const x = a[sort],
      y = b[sort];
    return (
      (descending ? -1 : 1) *
        (typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y)) ||
      a.metric_id - b.metric_id
    );
  });
  return (
    <div className="frames-panel">
      <div className="analysis-toolbar">
        <button className="small-button" onClick={close}>
          Back to frames
        </button>
        <b>Slow-frame patterns · {kind === 2 ? 'Render' : 'Update'}</b>
      </div>
      {!matched ? (
        <div className="frame-note" role="status">
          {resolved
            ? state.error || 'Comparing slow intervals with nearby references…'
            : 'Comparing slow intervals with nearby references…'}
        </div>
      ) : (
        <>
          <div className="frame-stats">
            <span>
              p95+ intervals <b>{count(matched.slow_intervals)}</b>
            </span>
            <span>
              Compared{' '}
              <b>
                {count(matched.matched_intervals)} / {count(matched.analyzed_intervals)}
              </b>
            </span>
            <span>
              With matched room context <b>{count(matched.context_matched_intervals)}</b>
            </span>
            <span>
              Mean extra wall{' '}
              <b>
                {matched.mean_extra_wall_ms === null
                  ? 'Unavailable'
                  : ms(matched.mean_extra_wall_ms)}
              </b>
            </span>
            <span>
              Mean extra callback self{' '}
              <b>
                {matched.mean_extra_callback_self_ms === null
                  ? 'Unavailable'
                  : ms(matched.mean_extra_callback_self_ms)}
              </b>
            </span>
            <span>
              Mean extra unattributed wall{' '}
              <b>
                {matched.mean_extra_unattributed_wall_ms === null
                  ? 'Unavailable'
                  : ms(matched.mean_extra_unattributed_wall_ms)}
              </b>
            </span>
          </div>
          <div className="frame-note">
            Callback increases of at least 50 µs, repeated in at least 3 compared slow intervals.
            References match clock, thread, update activity and recorded room/entity state when
            available. This is an association, not proof that a mod causes a drop.{' '}
            {result.coverage.attribution_incomplete || result.coverage.selected_scope
              ? 'Callback attribution is partial.'
              : ''}
          </div>
          <div className="analysis-table-scroll">
            <table>
              <SortableHeader
                columns={(
                  [
                    ['mod', 'Mod / hook / source'],
                    ['affected_intervals', 'Affected intervals'],
                    ['total_extra_self_ms', 'Sum extra self'],
                    ['mean_extra_self_ms_when_present', 'Mean extra self'],
                    ['maximum_extra_self_ms', 'Max extra self'],
                  ] as [Sort, string][]
                ).map(([key, label]) => ({ key, label }))}
                sort={sort}
                descending={descending}
                onSort={(key) => {
                  if (sort === key) setDescending(!descending);
                  else {
                    setSort(key);
                    setDescending(key !== 'mod');
                  }
                }}
              />
              <tbody>
                {rows.map((row) => (
                  <tr key={row.metric_id}>
                    <td>
                      {row.mod} / {row.hook}
                      <span className="source-inline">
                        {row.source.split(/[/\\]/).at(-1)}:{row.line}
                      </span>
                    </td>
                    <td>
                      {row.affected_intervals} / {row.matched_slow_intervals}
                    </td>
                    <td>{ms(row.total_extra_self_ms)}</td>
                    <td>{ms(row.mean_extra_self_ms_when_present)}</td>
                    <td>{ms(row.maximum_extra_self_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="frame-note">
                No callback increase meets the recurrence threshold in this range. This does not
                establish that callbacks are cheap or that engine work is the cause.
              </div>
            )}
            <div className="frame-note">
              Slowest intervals — inspect an interval to see the matching quality, reference
              population and individual differences.
            </div>
            <table>
              <thead>
                <tr>
                  <th>Interval</th>
                  <th>Wall</th>
                  <th>Extra self</th>
                  <th>Extra unattributed wall</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {matched.slowest_intervals.map((f) => (
                  <tr key={`${f.thread}:${f.id}`}>
                    <td>
                      <button
                        className="row-button"
                        onClick={() =>
                          inspect({
                            id: f.id,
                            start: f.start_ms,
                            duration: f.duration_ms,
                            kind,
                            thread: f.thread,
                            self: f.callback_self_ms,
                            calls: f.calls,
                            worstMod: '',
                            modSelf: 0,
                            worstMetric: null,
                            metricSelf: 0,
                            hasUpdate: f.has_update,
                          })
                        }
                      >
                        #{f.id} · {ms(f.start_ms)}
                      </button>
                    </td>
                    <td>{ms(f.duration_ms)}</td>
                    <td>
                      {f.comparison ? ms(f.comparison.extra_callback_self_ms) : 'Unavailable'}
                    </td>
                    <td>
                      {f.comparison ? ms(f.comparison.extra_unattributed_wall_ms) : 'Unavailable'}
                    </td>
                    <td title={f.reference.reason}>
                      {f.reference.quality} · {f.reference.intervals.length} intervals
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="frame-note">
            {matched.analyzed_intervals < matched.slow_intervals
              ? 'Comparisons are limited to the worst 500 intervals. '
              : ''}
            {matched.boundary_crossing_calls
              ? `${matched.boundary_crossing_calls} calls cross interval boundaries. `
              : ''}
            References average up to 5 nearby typical intervals. CPU, GPU and GC are not separately
            attributed.
          </div>
        </>
      )}
    </div>
  );
}
