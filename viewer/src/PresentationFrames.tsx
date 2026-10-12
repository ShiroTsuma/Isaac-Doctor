import { useEffect, useState } from 'react';
import InstructionSamples from './InstructionSamples.tsx';
import SortableHeader from './SortableHeader.tsx';
import { count, ms } from './trace.ts';
import type { LoadedTrace, WorkerClient } from './types.ts';
import type { PresentationResult, PresentationSort } from './presentation.ts';
import { waitNames } from './native-waits.ts';

type WaitSort = 'start' | 'kind' | 'duration' | 'requestedMs' | 'callSite';

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
  const [waitSort, setWaitSort] = useState<WaitSort>('duration');
  const [waitDescending, setWaitDescending] = useState(true);
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
            {!result.available &&
            !result.waits.available &&
            !result.samples.available ? (
              <div className="frame-note">
                Presentation measurements were not recorded in this file. Enable
                “Presentation / SwapBuffers” in capture scope for the next
                recording.
              </div>
            ) : (
              <>
                {!result.available && (
                  <div className="frame-note">
                    Presentation intervals were not recorded. Native waits below
                    remain available independently.
                  </div>
                )}
                <InstructionSamples
                  result={result.samples}
                  data={data}
                  request={request}
                />
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
                  <section
                    className="pattern-guidance"
                    aria-label="Rendering state"
                  >
                    <h3>Rendering state</h3>
                    {!result.renderStates.length ? (
                      <p>No rendering state was recorded.</p>
                    ) : (
                      result.renderStates.map((state) => (
                        <p key={`${state.time}:${state.thread}`}>
                          {ms(state.time)} · {state.renderer} / {state.vendor} ·
                          OpenGL {state.version}
                          <br />
                          Window {state.width} × {state.height} · Viewport{' '}
                          {state.viewport.join(', ')} · Swap interval{' '}
                          {state.swapInterval === null
                            ? 'unavailable'
                            : state.swapInterval}{' '}
                          · Wait hooks{' '}
                          {state.waitHooks.toString(2).split('1').length - 1}/6
                        </p>
                      ))
                    )}
                  </section>
                  <section
                    className="pattern-guidance"
                    aria-label="Native waits"
                  >
                    <h3>Native Sleep / wait calls</h3>
                    {!result.waits.available ? (
                      <p>
                        Enable Native Sleep / wait calls in Capture scope for
                        the next recording.
                      </p>
                    ) : (
                      <>
                        <p>
                          {count(result.waits.count)} observed calls ·{' '}
                          {ms(result.waits.wall)} clipped API wall time.{' '}
                          {result.waits.count === 0
                            ? 'No calls to the covered APIs were observed; this does not establish that the thread never waited.'
                            : ''}
                        </p>
                        <p>{result.waits.limitation}</p>
                        {result.waits.groups.map((group) => (
                          <p key={group.api}>
                            {group.api}: {count(group.count)} calls ·{' '}
                            {ms(group.wall)} wall · {ms(group.maximum)} longest
                          </p>
                        ))}
                        <details>
                          <summary>Call sites and longest waits</summary>
                          {result.waits.callers.map((caller) => (
                            <p
                              key={`${caller.thread}:${caller.api}:${caller.caller}`}
                            >
                              {caller.api} · {caller.callSite} · thread{' '}
                              {caller.thread}: {count(caller.count)} calls,{' '}
                              {ms(caller.wall)}
                            </p>
                          ))}
                          <p>
                            Longest {result.waits.rows.length} waits; sorting
                            applies to this retained list.
                          </p>
                          <table id="native-waits-table">
                            <SortableHeader
                              columns={(
                                [
                                  ['start', 'Start'],
                                  ['kind', 'API'],
                                  ['duration', 'Observed wall'],
                                  ['requestedMs', 'Requested timeout'],
                                  ['callSite', 'Result / caller'],
                                ] as [WaitSort, string][]
                              ).map(([key, label]) => ({ key, label }))}
                              sort={waitSort}
                              descending={waitDescending}
                              onSort={(value) => {
                                if (value === waitSort) {
                                  setWaitDescending(!waitDescending);
                                } else {
                                  setWaitSort(value);
                                  setWaitDescending(value === 'duration');
                                }
                              }}
                            />
                            <tbody>
                              {[...result.waits.rows]
                                .sort((a, b) => {
                                  const left =
                                    waitSort === 'kind'
                                      ? waitNames[a.kind]
                                      : a[waitSort];
                                  const right =
                                    waitSort === 'kind'
                                      ? waitNames[b.kind]
                                      : b[waitSort];
                                  const comparison =
                                    typeof left === 'string' &&
                                    typeof right === 'string'
                                      ? left.localeCompare(right)
                                      : Number(left) - Number(right);
                                  return (
                                    (waitDescending
                                      ? -comparison
                                      : comparison) || a.start - b.start
                                  );
                                })
                                .map((row, index) => (
                                  <tr
                                    key={`${row.thread}:${row.start}:${index}`}
                                  >
                                    <td>
                                      <button
                                        className="row-button"
                                        onClick={() =>
                                          setRange([
                                            row.start,
                                            row.start + row.duration,
                                          ])
                                        }
                                      >
                                        {ms(row.start)}
                                      </button>
                                    </td>
                                    <td>{waitNames[row.kind]}</td>
                                    <td>{ms(row.duration)}</td>
                                    <td>
                                      {row.requestedMs === 4294967295
                                        ? 'Infinite'
                                        : `${row.requestedMs} ms`}
                                    </td>
                                    <td>
                                      0x{row.result.toString(16)} ·{' '}
                                      {row.callSite}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </details>
                      </>
                    )}
                  </section>
                  <table id="presentation-table">
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
