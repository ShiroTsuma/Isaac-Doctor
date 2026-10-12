import { useEffect, useState } from 'react';
import SortableHeader from './SortableHeader.tsx';
import { count, ms } from './trace.ts';
import type { LoadedTrace, WorkerClient } from './types.ts';
import type { PresentationResult, PresentationSort } from './presentation.ts';

export default function PresentationFrames({
  data,
  range,
  request,
  close,
  setRange,
}: {
  data: LoadedTrace;
  range: [number, number];
  request: WorkerClient['request'];
  close: () => void;
  setRange: (range: [number, number]) => void;
}) {
  const [sort, setSort] = useState<PresentationSort>('duration');
  const [descending, setDescending] = useState(true);
  const [state, setState] = useState<{
    data: LoadedTrace;
    key: string;
    result?: PresentationResult;
    error?: string;
  } | null>(null);
  const key = JSON.stringify([range, sort, descending]);
  useEffect(() => {
    let active = true;
    void request('presentation', {
      start: range[0],
      end: range[1],
      sort,
      descending,
      limit: 200,
    })
      .then((result) => {
        if (active) {
          setState({ data, key, result });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            data,
            key,
            error:
              error instanceof Error
                ? error.message
                : 'Presentation analysis failed',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [data, range, sort, descending, request, key]);
  const current = state?.data === data && state.key === key ? state : null;
  const result = current?.result;
  return (
    <div className="frames-panel" id="presentation-panel">
      <div className="analysis-toolbar">
        <button className="small-button" onClick={close}>
          Back to frames
        </button>
        <b>Presentation · SwapBuffers</b>
      </div>
      <div className="frame-note">
        Intervals are measured between SwapBuffers returns, independently of Lua
        callbacks. Time in SwapBuffers can include driver work, synchronization
        and waiting. It is not GPU execution time or proof of actual screen
        presentation. Outside SwapBuffers includes engine, Lua, waiting and
        scheduling. Screenshot hook time is measured separately. Thread CPU
        cycles are raw counters, not milliseconds or CPU percentages.
      </div>
      {!current ? (
        <div role="status">Reading presentation intervals…</div>
      ) : current.error ? (
        <div role="alert">{current.error}</div>
      ) : (
        result && (
          <>
            {!result.available ? (
              <div className="frame-note">
                Presentation measurements were not recorded in this file. Enable
                “Presentation / SwapBuffers” in capture scope for the next
                recording.
              </div>
            ) : (
              <>
                <div className="frame-stats">
                  {[
                    ['Intervals', count(result.count)],
                    [
                      'Mean cadence',
                      result.rate === null
                        ? '—'
                        : `${result.rate.toFixed(2)} / s`,
                    ],
                    ['Interval p50', ms(result.interval.p50)],
                    ['Interval p95', ms(result.interval.p95)],
                    ['Interval p99', ms(result.interval.p99)],
                    ['Mean SwapBuffers', ms(result.swap.mean)],
                    ['Max SwapBuffers', ms(result.swap.maximum)],
                    ['Max screenshot hook', ms(result.readback.maximum)],
                    ['Failed swaps', count(result.failed)],
                    ['Missing IDs', count(result.gaps)],
                  ].map(([label, value]) => (
                    <span key={label}>
                      <small>{label}</small>
                      <b>{value}</b>
                    </span>
                  ))}
                </div>
                <div className="analysis-table-scroll">
                  <table>
                    <SortableHeader
                      columns={(
                        [
                          ['start', 'Start'],
                          ['duration', 'Interval'],
                          ['swap', 'SwapBuffers'],
                          ['readback', 'Screenshot hook'],
                          ['outside', 'Outside swap / screenshot'],
                          ['cycles', 'Thread CPU cycles'],
                        ] as [PresentationSort, string][]
                      ).map(([key, label]) => ({ key, label }))}
                      sort={sort}
                      descending={descending}
                      onSort={(value) => {
                        if (value === sort) {
                          setDescending(!descending);
                        } else {
                          setSort(value);
                          setDescending(value !== 'start');
                        }
                      }}
                    />
                    <tbody id="presentation-rows">
                      {result.rows.map((row) => (
                        <tr key={`${row.thread}:${row.id}`}>
                          <td>
                            <button
                              className="row-button"
                              title="Select this presentation interval in the timeline"
                              onClick={() =>
                                setRange([row.start, row.start + row.duration])
                              }
                            >
                              {ms(row.start)}
                            </button>
                          </td>
                          <td>{ms(row.duration)}</td>
                          <td>{ms(row.swap)}</td>
                          <td>{ms(row.readback)}</td>
                          <td>{ms(row.outside)}</td>
                          <td>
                            {row.cycles === null
                              ? 'Unavailable'
                              : count(row.cycles)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!result.count && (
                  <div className="frame-note">
                    No complete presentation intervals fit in this range. Expand
                    the selection.
                  </div>
                )}
                <div className="frame-note">
                  Up to 200 rows, ordered across all selected intervals.
                  Statistics use complete intervals in the selection;
                  percentiles have at most 0.1% relative histogram error.
                  {result.threads.length > 1 &&
                    ' Multiple presentation threads were recorded; aggregate cadence is not reported.'}
                </div>
              </>
            )}
          </>
        )
      )}
    </div>
  );
}
