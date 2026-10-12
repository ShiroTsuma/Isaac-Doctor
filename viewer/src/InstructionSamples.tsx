import { useState } from 'react';
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
  id,
}: {
  rows: InstructionGroup[];
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
            </tr>
          ))}
      </tbody>
    </table>
  );
}

export default function InstructionSamples({ result }: { result: Result }) {
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
          <h4>Modules</h4>
          <SampleTable
            rows={result.modules}
            waitCoverage={result.waitCoverage}
            id="sample-modules-table"
          />
          <h4>Instruction locations · 64-byte buckets</h4>
          <SampleTable
            rows={result.hotspots}
            waitCoverage={result.waitCoverage}
            id="sample-hotspots-table"
          />
          <details>
            <summary>
              Frame-pointer return candidates · partial, not a full call stack
            </summary>
            <SampleTable
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
