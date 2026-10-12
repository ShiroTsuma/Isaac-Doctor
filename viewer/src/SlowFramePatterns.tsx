import { useEffect, useState } from 'react';
import SortableHeader, { ResizableTableHeader } from './SortableHeader.tsx';
import type {
  FrameRow,
  LoadedTrace,
  WorkerClient,
  WorkerOperations,
} from './types.ts';
import { count, ms } from './trace.ts';

type Result = WorkerOperations['diagnose']['result'];
type Pattern =
  Result['matched_slow_frames']['recurring_callback_increases'][number];
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
  openPresentation,
  inspectCallback,
}: {
  data: LoadedTrace;
  range: [number, number];
  kind: 1 | 2;
  request: WorkerClient['request'];
  close: () => void;
  inspect: (frame: FrameRow) => void;
  openPresentation: () => void;
  inspectCallback: (frame: FrameRow, metric: number) => void;
}) {
  const key = JSON.stringify([range, kind]);
  const [state, setState] = useState<{
    owner: LoadedTrace;
    key: string;
    result?: Result;
    error?: string;
  } | null>(null);
  const [sort, setSort] = useState<Sort>('total_extra_self_ms');
  const [descending, setDescending] = useState(true);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void request('diagnose', {
        start: range[0],
        end: range[1],
        kind,
        top: 20,
      })
        .then((result) => {
          if (active) {
            setState({ owner: data, key, result });
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setState({
              owner: data,
              key,
              error:
                error instanceof Error
                  ? error.message
                  : 'Slow-frame analysis failed',
            });
          }
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, range, kind, key, request]);
  const resolved = state?.owner === data && state.key === key;
  const result = resolved ? state.result : undefined;
  const matched = result?.matched_slow_frames;
  const rows = [...(matched?.recurring_callback_increases ?? [])].sort(
    (a: Pattern, b: Pattern) => {
      const x = a[sort];
      const y = b[sort];
      return (
        (descending ? -1 : 1) *
          (typeof x === 'string'
            ? x.localeCompare(String(y))
            : Number(x) - Number(y)) || a.metric_id - b.metric_id
      );
    },
  );

  function frameRow(
    f: NonNullable<typeof matched>['slowest_intervals'][number],
  ) {
    return {
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
    };
  }

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
                {count(matched.matched_intervals)} /{' '}
                {count(matched.analyzed_intervals)}
              </b>
            </span>
            <span>
              With matched room context{' '}
              <b>{count(matched.context_matched_intervals)}</b>
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
            Callback increases of at least 50 µs, repeated in at least 3
            compared slow intervals. References match clock, thread, update
            activity and recorded room/entity state when available. This is an
            association, not proof that a mod causes a drop.{' '}
            {result.coverage.attribution_incomplete ||
            result.coverage.selected_scope
              ? 'Callback attribution is partial.'
              : ''}
          </div>
          <div className="analysis-table-scroll">
            <section
              className="pattern-guidance"
              aria-label="What this comparison tells us"
            >
              <h3>{result.interpretation.title}</h3>
              <p>{result.interpretation.evidence}</p>
              {matched.largest_increase &&
                matched.largest_increase.share_of_positive_extra_wall >=
                  0.4 && (
                  <p>
                    <b>One interval dominates this average: </b>#
                    {matched.largest_increase.id} at{' '}
                    {ms(matched.largest_increase.start_ms)} contributes{' '}
                    {Math.round(
                      matched.largest_increase.share_of_positive_extra_wall *
                        100,
                    )}
                    % of positive extra wall time. Inspect it separately. If
                    this is startup or a menu transition, select the later
                    stable range before drawing conclusions about idle costs.
                  </p>
                )}
              <p>
                <b>Next step: </b>
                {result.interpretation.next}
              </p>
              <button className="small-button" onClick={openPresentation}>
                Check presentation timings
              </button>
              <details>
                <summary>What the reference means</summary>
                <p>
                  We compare each slow interval with up to five nearby typical
                  intervals with the same thread and update activity, and
                  similar room context when available. “Extra” is slow minus
                  reference, not the total cost of a mod. This comparison can
                  find spikes but cannot explain a cost shared by both groups.
                </p>
                <p>{result.interpretation.limit}</p>
                <p>
                  {matched.context_matched_intervals} of{' '}
                  {matched.matched_intervals} comparisons include matched room
                  context. Remaining comparisons provide weaker evidence.
                </p>
              </details>
            </section>
            {result.pacing.available && (
              <section className="pattern-guidance" aria-label="Frame pacing">
                <h3>
                  {result.pacing.alternating_update_pattern
                    ? 'Long and short intervals alternate with update activity'
                    : 'Update activity changes the comparison'}
                </h3>
                <p>
                  With update: {ms(result.pacing.with_update_mean_ms!)} mean (
                  {count(result.pacing.with_update_count)} intervals). Without:{' '}
                  {ms(result.pacing.without_update_mean_ms!)} (
                  {count(result.pacing.without_update_count)} intervals).
                  {result.pacing.mean_pair_ms !== null && (
                    <>
                      {' '}
                      Adjacent pairs average {ms(result.pacing.mean_pair_ms)}.
                    </>
                  )}
                </p>
                <p>
                  {result.pacing.alternating_update_pattern
                    ? 'Low FPS percentiles can reflect this repeated uneven pacing even when the average rate stays near its target. Matched references intentionally compare the same phase, so a recurring update cost can disappear from the increase table.'
                    : 'A slow interval with an update is not directly comparable to one without it. The references control for this difference.'}
                </p>
                <p>
                  Use Presentation to check whether the pacing also reaches
                  SwapBuffers. To test instrumentation cost, keep all mods
                  enabled and repeat with callback timings and timeline off,
                  keeping frame intervals and Presentation on. This is still an
                  attached-profiler comparison, not a profiler-free baseline.
                </p>
              </section>
            )}
            <div className="frame-note">
              <b>Recurring callback leads</b> — higher call count suggests more
              invocations; higher cost per call suggests more work within each
              invocation. Inspect an example before changing a mod.
            </div>
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
                  if (sort === key) {
                    setDescending(!descending);
                  } else {
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
                      <span className="source-inline">
                        {row.mean_calls_when_present.toFixed(1)} calls vs{' '}
                        {row.reference_mean_calls_when_present.toFixed(1)} in
                        references.
                      </span>
                      {(() => {
                        const example = matched.slowest_intervals.find((f) =>
                          f.comparison?.callback_increases.some(
                            (c) => c.metric_id === row.metric_id,
                          ),
                        );
                        return example ? (
                          <span className="pattern-actions">
                            <button
                              className="small-button"
                              onClick={() => inspect(frameRow(example))}
                            >
                              Inspect evidence #{example.id}
                            </button>
                            <button
                              className="small-button"
                              onClick={() =>
                                inspectCallback(
                                  frameRow(example),
                                  row.metric_id,
                                )
                              }
                            >
                              Open callback / source
                            </button>
                          </span>
                        ) : (
                          <span className="source-inline">
                            No example in the displayed slowest intervals.
                          </span>
                        );
                      })()}
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
                No callback increase meets the recurrence threshold in this
                range. This does not establish that callbacks are cheap or that
                engine work is the cause.
              </div>
            )}
            <div className="frame-note">
              Slowest intervals — inspect an interval to see the matching
              quality, reference population and individual differences.
            </div>
            <table>
              <ResizableTableHeader
                labels={[
                  'Interval',
                  'Wall',
                  'Extra self',
                  'Extra unattributed wall',
                  'Reference',
                ]}
              />
              <tbody>
                {matched.slowest_intervals.map((f) => (
                  <tr key={`${f.thread}:${f.id}`}>
                    <td>
                      <button
                        className="row-button"
                        onClick={() => inspect(frameRow(f))}
                      >
                        #{f.id} · {ms(f.start_ms)}
                      </button>
                    </td>
                    <td>{ms(f.duration_ms)}</td>
                    <td>
                      {f.comparison
                        ? ms(f.comparison.extra_callback_self_ms)
                        : 'Unavailable'}
                    </td>
                    <td>
                      {f.comparison
                        ? ms(f.comparison.extra_unattributed_wall_ms)
                        : 'Unavailable'}
                    </td>
                    <td title={f.reference.reason}>
                      {f.reference.quality} · {f.reference.intervals.length}{' '}
                      intervals
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
            References average up to 5 nearby typical intervals. CPU, GPU and GC
            are not separately attributed.
          </div>
        </>
      )}
    </div>
  );
}
