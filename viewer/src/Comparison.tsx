import SortableHeader from './SortableHeader.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Comparison as ComparisonData,
  ComparisonRow,
} from './comparison.ts';
import type { LoadedTrace, WorkerClient } from './types.ts';
import { ms } from './trace.ts';
import './frames.css';

export default function Comparison({
  data,
  range,
  request,
}: {
  data: LoadedTrace;
  range: [number, number];
  request: WorkerClient['request'];
}) {
  type Sort =
    | 'activity'
    | 'selfA'
    | 'selfB'
    | 'meanA'
    | 'meanB'
    | 'callsA'
    | 'callsB'
    | 'delta'
    | 'code';
  const [sort, setSort] = useState<Sort>('selfA');
  const [descending, setDescending] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<'mods' | 'hooks' | 'functions'>('hooks');
  const [state, setState] = useState<{
    owner: LoadedTrace;
    file: File;
    key: string;
    result?: ComparisonData;
    error?: string;
  } | null>(null);
  const key = JSON.stringify(range);
  useEffect(() => {
    if (!file) {
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void request('compare', { file, start: range[0], end: range[1] })
        .then((result) => {
          if (active) {
            setState({ owner: data, file, key, result });
          }
        })
        .catch((e: unknown) => {
          if (active) {
            setState({
              owner: data,
              file,
              key,
              error: e instanceof Error ? e.message : 'Comparison failed',
            });
          }
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, file, key, range, request]);
  const resolved =
    state?.owner === data && state.file === file && state.key === key;
  const result = resolved ? state.result : undefined;
  const rows = useMemo(() => {
    const source =
      result?.rows.filter((r) =>
        `${r.mod} ${r.hook} ${r.source}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ) ?? [];
    if (group === 'functions') {
      return source;
    }
    const totals = new Map<string, ComparisonRow>();
    for (const row of source) {
      const key = JSON.stringify([
        row.mod,
        ...(group === 'hooks' ? [row.hook] : []),
      ]);
      let t = totals.get(key);
      if (!t) {
        t = {
          ...row,
          key,
          hook: group === 'hooks' ? row.hook : '',
          source: '',
          identity: 'group',
          selfA: 0,
          selfB: 0,
          callsA: 0,
          callsB: 0,
        };
        totals.set(key, t);
      }
      t.selfA += row.selfA;
      t.selfB += row.selfB;
      t.callsA += row.callsA;
      t.callsB += row.callsB;
      if (row.code === 'changed') {
        t.code = 'changed';
      } else if (row.code === 'unavailable' && t.code !== 'changed') {
        t.code = 'unavailable';
      }
    }
    for (const t of totals.values()) {
      t.meanA = t.callsA ? (t.selfA * 1000) / t.callsA : null;
      t.meanB = t.callsB ? (t.selfB * 1000) / t.callsB : null;
    }
    return [...totals.values()];
  }, [result, search, group]);
  const sorted = useMemo(() => {
    if (!result) {
      return [];
    }
    const value = (row: ComparisonRow): number | string | null => {
      switch (sort) {
        case 'activity':
          return `${row.mod} / ${row.hook} / ${row.source}`;
        case 'code':
          return row.code;
        case 'selfA':
        case 'callsA':
          return result.durationA
            ? (row[sort] * 1000) / result.durationA
            : null;
        case 'selfB':
        case 'callsB':
          return result.durationB
            ? (row[sort] * 1000) / result.durationB
            : null;
        case 'delta':
          return row.meanA === null || row.meanB === null
            ? null
            : row.meanA - row.meanB;
        default:
          return row[sort];
      }
    };
    return rows.slice().sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === null || y === null) {
        return x === y ? a.key.localeCompare(b.key) : x === null ? 1 : -1;
      }
      return (
        (descending ? -1 : 1) *
          (typeof x === 'string'
            ? x.localeCompare(String(y))
            : Number(x) - Number(y)) || a.key.localeCompare(b.key)
      );
    });
  }, [rows, result, sort, descending]);
  const rate = (self: number, duration: number) =>
    duration ? ms((self * 1000) / duration) : '—';
  return (
    <div className="frames-panel">
      <div className="analysis-toolbar">
        <button
          className="small-button"
          onClick={() => {
            if (input.current) {
              input.current.value = '';
              input.current.click();
            }
          }}
        >
          Choose reference recording
        </button>
        <span>{file?.name || 'Local file; no upload'}</span>
        <label>
          Group{' '}
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value as typeof group)}
          >
            <option value="mods">Mods</option>
            <option value="hooks">Hooks</option>
            <option value="functions">Functions</option>
          </select>
        </label>
        <input
          type="search"
          aria-label="Filter comparison"
          placeholder="Filter comparison"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <input
        id="compare-file"
        ref={input}
        type="file"
        accept=".isaacprof"
        hidden
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {file && !result ? (
        <div className="frame-note" role="status">
          {resolved ? state.error : 'Reading comparison…'}
        </div>
      ) : result ? (
        <>
          <div className="frame-stats">
            <span>
              Current FPS / p95{' '}
              <b>
                {result.renderA.count
                  ? `${result.renderA.rate.toFixed(2)} / ${ms(result.renderA.p95)}`
                  : '—'}
              </b>
            </span>
            <span>
              Reference FPS / p95{' '}
              <b>
                {result.renderB.count
                  ? `${result.renderB.rate.toFixed(2)} / ${ms(result.renderB.p95)}`
                  : '—'}
              </b>
            </span>
            <span>
              {result.incomplete
                ? 'Incomplete / filtered attribution'
                : 'Complete recordings'}
            </span>
          </div>
          <div className="frame-note">
            Current selected range ({ms(result.durationA)}) vs entire reference
            ({ms(result.durationB)}). Self/s normalizes session length; mean
            self/call separates call frequency from individual cost. Different
            rooms/runs are not a controlled FPS experiment.
          </div>
          <div className="analysis-table-scroll">
            <table className="comparison-table">
              <SortableHeader
                columns={(
                  [
                    ['activity', 'Activity'],
                    ['selfA', 'Current self/s'],
                    ['selfB', 'Reference self/s'],
                    ['meanA', 'Current \u00b5s/call'],
                    ['meanB', 'Reference \u00b5s/call'],
                    ['delta', 'Delta \u00b5s/call'],
                    ['callsA', 'Current calls/s'],
                    ['callsB', 'Reference calls/s'],
                    ['code', 'Recorded source'],
                  ] as [Sort, string][]
                ).map(([key, label]) => ({ key, label }))}
                sort={sort}
                descending={descending}
                onSort={(key) => {
                  if (sort === key) {
                    setDescending(!descending);
                  } else {
                    setSort(key);
                    setDescending(key !== 'activity' && key !== 'code');
                  }
                }}
              />
              <tbody>
                {sorted.slice(0, 1000).map((row) => (
                  <tr key={row.key}>
                    <td
                      title={`${row.mod} / ${row.hook} / ${row.source}:${row.lineA ?? row.lineB ?? 'unknown'}`}
                    >
                      {row.mod}
                      {row.hook && ` / ${row.hook}`}
                      {group === 'functions' && (
                        <span className="source-inline">
                          {row.source}:{row.lineA ?? '—'} → {row.lineB ?? '—'} ·{' '}
                          {row.identity === 'ordinal'
                            ? 'tentative ordinal match'
                            : row.identity}
                        </span>
                      )}
                    </td>
                    <td>{rate(row.selfA, result.durationA)}</td>
                    <td>{rate(row.selfB, result.durationB)}</td>
                    <td>{row.meanA?.toFixed(2) ?? '—'}</td>
                    <td>{row.meanB?.toFixed(2) ?? '—'}</td>
                    <td>
                      {row.meanA !== null && row.meanB !== null
                        ? (row.meanA - row.meanB).toFixed(2)
                        : '\u2014'}
                    </td>
                    <td>
                      {result.durationA
                        ? ((row.callsA * 1000) / result.durationA).toFixed(1)
                        : '\u2014'}
                    </td>
                    <td>
                      {result.durationB
                        ? ((row.callsB * 1000) / result.durationB).toFixed(1)
                        : '\u2014'}
                    </td>
                    <td>{row.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="frame-note">
            {rows.length.toLocaleString()} matches · first 1,000 displayed.
            Function matching uses source/hook and definition line, or a
            tentative ordinal when lines moved and group sizes match. A source
            hash describes disk contents at capture, not proof of loaded
            bytecode.
          </div>
        </>
      ) : (
        <div className="no-analysis">
          Choose a second recording to compare callback cost and source
          versions.
        </div>
      )}
    </div>
  );
}
