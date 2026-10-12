import { useState } from 'react';
import SourceContext from './SourceContext.tsx';
import type { LoadedTrace, Metric, WorkerClient } from './types.ts';
import SortableHeader from './SortableHeader.tsx';
import { count, ms } from './trace.ts';
import type {
  instructionCapture,
  InstructionGroup,
} from './instruction-samples.ts';

type Result = Awaited<ReturnType<typeof instructionCapture>>;
type Sort = keyof InstructionGroup;

function SampleTable({
  rows,
  waitCoverage,
  presentationCoverage,
  id,
}: {
  rows: InstructionGroup[];
  presentationCoverage: boolean;
  waitCoverage: boolean;
  id: string;
}) {
  const [sort, setSort] = useState<Sort>('count');
  const [descending, setDescending] = useState(true);
  return (
    <table id={id}>
      <SortableHeader
        columns={(
          [
            ['location', 'Location'],
            ['thread', 'Thread'],
            ['count', 'Snapshots'],
            ['coveredWait', 'Inside covered waits'],
            ['insideSwap', 'Inside SwapBuffers'],
          ] as [Sort, string][]
        ).map(([key, label]) => ({ key, label }))}
        sort={sort}
        descending={descending}
        onSort={(next) => {
          setDescending(next === sort ? !descending : next !== 'location');
          setSort(next);
        }}
      />
      <tbody>
        {[...rows]
          .sort((a, b) => {
            const left = a[sort];
            const right = b[sort];
            const comparison =
              typeof left === 'string' && typeof right === 'string'
                ? left.localeCompare(right)
                : Number(left) - Number(right);
            return (
              (descending ? -comparison : comparison) ||
              a.location.localeCompare(b.location) ||
              a.thread - b.thread
            );
          })
          .map((row) => (
            <tr key={`${row.thread}:${row.location}`}>
              <td>{row.location}</td>
              <td>{row.thread}</td>
              <td>{count(row.count)}</td>
              <td>{waitCoverage ? count(row.coveredWait) : 'Not recorded'}</td>
              <td>
                {presentationCoverage ? count(row.insideSwap) : 'Not recorded'}
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

type LuaRow = Result['luaSources'][number];

function LuaTable({
  rows,
  id,
  select,
  waitCoverage,
}: {
  waitCoverage: boolean;
  rows: LuaRow[];
  id: string;
  select: (row: LuaRow) => void;
}) {
  const [sort, setSort] = useState<keyof LuaRow>('count');
  const [descending, setDescending] = useState(true);
  const columns: { key: keyof LuaRow; label: string }[] = [
    { key: 'mod', label: 'Mod / owner' },
    { key: 'hook', label: 'Hook' },
    { key: 'source', label: 'Function definition' },
    { key: 'line', label: 'Line' },
    { key: 'count', label: 'Snapshots' },
    { key: 'coveredWait', label: 'Inside covered waits' },
  ];
  return (
    <table id={id}>
      <SortableHeader
        columns={columns}
        sort={sort}
        descending={descending}
        onSort={(next) => {
          setDescending(
            next === sort
              ? !descending
              : next === 'count' || next === 'coveredWait',
          );
          setSort(next);
        }}
      />
      <tbody>
        {[...rows]
          .sort((a, b) => {
            const x = a[sort];
            const y = b[sort];
            const comparison =
              typeof x === 'string' && typeof y === 'string'
                ? x.localeCompare(y)
                : Number(x) - Number(y);
            return (
              (descending ? -comparison : comparison) ||
              a.source.localeCompare(b.source) ||
              a.thread - b.thread
            );
          })
          .map((row) => (
            <tr key={`${row.thread}:${row.metric}:${row.source}:${row.line}`}>
              <td>{row.mod}</td>
              <td>{row.hook}</td>
              <td>
                <button className="small-button" onClick={() => select(row)}>
                  {row.source || 'Unknown source'}
                </button>
              </td>
              <td>{row.line}</td>
              <td>{count(row.count)}</td>
              <td>{waitCoverage ? count(row.coveredWait) : 'Not recorded'}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

export default function InstructionSamples({
  result,
  data,
  request,
}: {
  result: Result;
  data: LoadedTrace;
  request: WorkerClient['request'];
}) {
  const [selected, setSelected] = useState<{
    data: LoadedTrace;
    metric: Metric;
  } | null>(null);
  const select = (row: LuaRow) => {
    const owner = data.metrics.find((metric) => metric.id === row.metric);
    const metric: Metric = {
      ...(owner ?? {
        id: 0,
        calls: 0,
        errors: 0,
        inclusive_ns: 0,
        exclusive_ns: 0,
        mean_ns: 0,
        max_ns: 0,
        callback_id: '',
        callback_name: row.hook,
        function: 'Sampled Lua function',
        mod: row.mod,
      }),
      source: row.source,
      line: row.line,
    };
    setSelected({ data, metric });
  };
  if (!result.available) {
    return null;
  }
  return (
    <section id="instruction-samples">
      <h3>Native instruction snapshots</h3>
      <div className="frame-note">{result.limitation}</div>
      <div className="frame-stats">
        {[
          ['Snapshots in range', count(result.count)],
          [
            'Inside covered waits',
            result.coveredWait === null
              ? 'Not recorded'
              : count(result.coveredWait),
          ],
          [
            'Outside covered waits',
            result.outsideCoveredWait === null
              ? 'Not recorded'
              : count(result.outsideCoveredWait),
          ],
          [
            'Inside SwapBuffers',
            result.insideSwap === null
              ? 'Not recorded'
              : count(result.insideSwap),
          ],
          [
            'Outside swap / covered waits',
            result.outsideSwapAndCoveredWait === null
              ? 'Not recorded'
              : count(result.outsideSwapAndCoveredWait),
          ],
          ['Readback / resume pause in range', ms(result.pauseTotal)],
          ['Maximum recorded pause', ms(result.pauseMaximum)],
        ].map(([label, value]) => (
          <span key={label}>
            <small>{label}</small>
            <b>{value}</b>
          </span>
        ))}
      </div>
      {result.sessionStats && (
        <p className="frame-note">
          Whole-session sampling: {count(result.sessionStats.attempts)}{' '}
          attempts, {count(result.sessionStats.failed)} failed,{' '}
          {count(result.sessionStats.skipped)} skipped,{' '}
          {count(result.sessionStats.omitted)} omitted. Total measured pause
          including unsuccessful attempts: {ms(result.sessionStats.pauseTotal)}.
        </p>
      )}
      {!result.count ? (
        <p>No instruction snapshots in this range. Expand the selection.</p>
      ) : (
        <>
          {result.luaAvailable && (
            <>
              <h4>Sampled Lua function definitions</h4>
              <p className="frame-note">
                {count(result.luaAttributed)} snapshots have a wrapper owner.
                Function definitions below come from the nearest Lua frame on
                the main state; they are not the currently executing line. Click
                a source to inspect it. Unverified contexts:{' '}
                {count(result.luaUnverified)}; context read failures:{' '}
                {count(result.luaReadFailures)}; partial contexts:{' '}
                {count(result.luaPartial)}; source read failures:{' '}
                {count(result.luaSourceFailures)}; missing metadata:{' '}
                {count(result.luaMissingMetrics + result.luaMissingSources)}.
              </p>
              {result.luaSources.length ? (
                <LuaTable
                  rows={result.luaSources}
                  waitCoverage={result.waitCoverage}
                  id="sample-lua-sources-table"
                  select={select}
                />
              ) : (
                <p>No Lua function definitions resolved in this range.</p>
              )}
              <details>
                <summary>Wrapper owners</summary>
                <LuaTable
                  rows={result.luaOwners}
                  waitCoverage={result.waitCoverage}
                  id="sample-lua-owners-table"
                  select={select}
                />
              </details>
              {selected?.data === data && (
                <SourceContext
                  idPrefix="sample-lua-"
                  metric={selected.metric}
                  request={request}
                  capture={data}
                />
              )}
            </>
          )}
          <h4>Modules</h4>
          <SampleTable
            presentationCoverage={result.presentationCoverage}
            rows={result.modules}
            waitCoverage={result.waitCoverage}
            id="sample-modules-table"
          />
          <h4>Instruction locations · 64-byte buckets</h4>
          <SampleTable
            presentationCoverage={result.presentationCoverage}
            rows={result.hotspots}
            waitCoverage={result.waitCoverage}
            id="sample-hotspots-table"
          />
          <details>
            <summary>
              Frame-pointer return candidates · partial, not a full call stack
            </summary>
            <SampleTable
              presentationCoverage={result.presentationCoverage}
              rows={result.returns}
              waitCoverage={result.waitCoverage}
              id="sample-returns-table"
            />
          </details>
        </>
      )}
    </section>
  );
}
