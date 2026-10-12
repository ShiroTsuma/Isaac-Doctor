import { channelOptions, triggerOptions } from './recording-config.ts';
import { useEffect, useState } from 'react';
import type {
  CounterSample,
  LoadedTrace,
  Telemetry as TelemetryData,
  WorkerClient,
} from './types.ts';
import { ms } from './trace.ts';
import './telemetry.css';
import { overheadEstimate } from './overhead.ts';
const mib = (value: number) => `${(value / 1048576).toFixed(1)} MiB`;
const markerNames = [
  '',
  'Capture context',
  'Run started / continued',
  'Room transition',
  'Level transition',
  'Run ended',
  'Exit run',
];
export function cpuPoints(samples: CounterSample[], thread = false): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i],
      mask = thread ? 4 : 2;
    if (!(a.valid & mask) || !(b.valid & mask) || (thread && a.thread !== b.thread)) continue;
    const elapsed = b.time - a.time,
      delta = thread
        ? b.threadUser + b.threadKernel - a.threadUser - a.threadKernel
        : b.processUser + b.processKernel - a.processUser - a.processKernel;
    if (elapsed > 0 && delta >= 0) result.push([b.time, (delta / 10000 / elapsed) * 100]);
  }
  return result;
}
function Chart({
  label,
  points,
  range,
  unit,
  color,
}: {
  label: string;
  points: [number, number][];
  range: [number, number];
  unit: (n: number) => string;
  color: string;
}) {
  const max = Math.max(1, ...points.map((p) => p[1])),
    span = Math.max(0.001, range[1] - range[0]);
  const buckets = new Map<number, [number, number]>();
  for (const p of points) {
    const x = Math.max(0, Math.min(599, Math.floor(((p[0] - range[0]) / span) * 600))),
      old = buckets.get(x);
    if (!old || old[1] < p[1]) buckets.set(x, p);
  }
  const line = [...buckets.values()]
    .map(
      ([time, value]) =>
        `${Math.max(0, Math.min(1000, ((time - range[0]) / span) * 1000))},${65 - (value / max) * 60}`,
    )
    .join(' ');
  return (
    <div className="counter-chart">
      <div>
        <b>{label}</b>
        <span>
          {points.length
            ? `Latest ${unit(points.at(-1)![1])} · Peak ${unit(max)}`
            : 'No samples in this recording / range'}
        </span>
      </div>
      <svg viewBox="0 0 1000 70" preserveAspectRatio="none" role="img" aria-label={label}>
        <path d="M0 65H1000" stroke="#3c4043" />
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
export default function Telemetry({
  data,
  range,
  request,
  setRange,
}: {
  data: LoadedTrace;
  range: [number, number];
  request: WorkerClient['request'];
  setRange: (range: [number, number]) => void;
}) {
  const [state, setState] = useState<{
    owner: LoadedTrace;
    start: number;
    end: number;
    result?: TelemetryData;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void request('telemetry', { start: range[0], end: range[1] })
        .then((result) => {
          if (active) setState({ owner: data, start: range[0], end: range[1], result });
        })
        .catch((error: unknown) => {
          if (active)
            setState({
              owner: data,
              start: range[0],
              end: range[1],
              error: error instanceof Error ? error.message : 'Cannot read counters',
            });
        });
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, range, request]);
  const resolved = state?.owner === data && state.start === range[0] && state.end === range[1],
    result = resolved ? state.result : undefined;
  if (!resolved)
    return (
      <div className="telemetry-panel" role="status">
        Reading recorded counters…
      </div>
    );
  if (!result)
    return (
      <div className="telemetry-panel" role="alert">
        {state?.error}
      </div>
    );
  const info = result.inventory;
  const overhead = overheadEstimate(result.overhead ?? []);
  return (
    <div className="telemetry-panel">
      {data.document.configuration && (
        <details className="telemetry-inventory">
          <summary>Capture settings · measured scope</summary>
          <p>
            Channels:{' '}
            {channelOptions
              .filter(([bit]) => data.document.configuration!.channels & bit)
              .map(([, name]) => name)
              .join(', ') || 'none'}
            <br />
            Mods: {data.document.configuration.selectedMods.join(', ') || 'all'}
            <br />
            Hooks: {data.document.configuration.selectedHooks.join(', ') || 'all'}
            <br />
            Start: {triggerOptions[data.document.configuration.startOn]?.[1]} +{' '}
            {data.document.configuration.startDelayMs} ms
            <br />
            Stop: {triggerOptions[data.document.configuration.stopOn]?.[1]} +{' '}
            {data.document.configuration.stopDelayMs} ms
            <br />
            Maximum duration:{' '}
            {data.document.configuration.maxDurationMs
              ? `${data.document.configuration.maxDurationMs / 1000} s (without additional stop delay)`
              : 'none'}
          </p>
          <p>
            Costs from excluded child calls remain in measured parent self time. Disabled channels
            are absent by choice.
          </p>
        </details>
      )}

      <div className="telemetry-note">
        Samples every 250 ms · CPU 100% = one logical core · Lua heap covers the whole VM
      </div>
      <Chart
        label="Working set"
        points={result.counters.filter((s) => s.valid & 1).map((s) => [s.time, s.workingSet])}
        range={range}
        unit={mib}
        color="#8ab4f8"
      />
      <Chart
        label="Private commit"
        points={result.counters.filter((s) => s.valid & 1).map((s) => [s.time, s.privateBytes])}
        range={range}
        unit={mib}
        color="#c58af9"
      />
      <Chart
        label="Lua heap"
        points={result.heap.map((s) => [s.time, s.bytes])}
        range={range}
        unit={mib}
        color="#81c995"
      />
      <Chart
        label="Process CPU"
        points={cpuPoints(result.counters)}
        range={range}
        unit={(n) => `${n.toFixed(1)}%`}
        color="#fdd663"
      />
      <Chart
        label="Lua thread CPU"
        points={cpuPoints(result.counters, true)}
        range={range}
        unit={(n) => `${n.toFixed(1)}%`}
        color="#f28b82"
      />
      <Chart
        label="Room entities"
        points={(result.context ?? []).map((s) => [s.time, s.entities])}
        range={range}
        unit={(n) => String(n)}
        color="#8ab4f8"
      />
      <Chart
        label="Enemy projectiles / effects"
        points={(result.context ?? []).map((s) => [s.time, s.projectiles + s.effects])}
        range={range}
        unit={(n) => String(n)}
        color="#f28b82"
      />
      <details className="telemetry-inventory" open>
        <summary>Profiler overhead · sampled estimate</summary>
        {overhead ? (
          <p>
            Wrapper estimate:{' '}
            {overhead.wrapperMs === null ? 'not enough samples' : ms(overhead.wrapperMs)} over{' '}
            {ms(overhead.spanMs)} · {overhead.samples.toLocaleString()} sampled entries /{' '}
            {overhead.calls.toLocaleString()} calls.
            <br />
            Native observers, context and heap: {ms(overhead.observerMs)}.<br />
            Auxiliary packets omitted: {overhead.auxiliaryDropped} · context sample failures:{' '}
            {overhead.contextFailures} · error records omitted: {overhead.errorsOmitted}.
          </p>
        ) : (
          <p>No overhead estimate is available for this selection.</p>
        )}
        <p>
          One wrapper sampled per 1,024 entries. Extra timing probes, pcall boundaries and reporting
          affect the estimate. This excludes collector CPU, async screenshot encoding, cache/GC
          effects and scheduling. Use independent A/B measurements for total impact.
        </p>
      </details>
      <table className="marker-table">
        <thead>
          <tr>
            <th>Context sample</th>
            <th>Room / stage</th>
            <th>Grid</th>
            <th>Entities / enemies</th>
            <th>Tears / projectiles / effects</th>
          </tr>
        </thead>
        <tbody>
          {(result.context ?? []).slice(0, 500).map((c) => (
            <tr key={c.time}>
              <td>
                <button
                  className="row-button"
                  onClick={() =>
                    setRange([Math.max(0, c.time - 125), Math.min(data.duration, c.time + 250)])
                  }
                >
                  {ms(c.time)}
                </button>
              </td>
              <td>
                {c.room} / {c.stage}:{c.stageType} · type {c.roomType}
              </td>
              <td>
                {c.width}×{c.height} · {c.grids}/{c.gridSlots}
              </td>
              <td>
                {c.entities} / {c.enemies}
              </td>
              <td>
                {c.tears} / {c.projectiles} / {c.effects}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="telemetry-inventory">
        <summary>Lua errors · {result.errors?.length ?? 0} in range</summary>
        {result.errors?.length ? (
          result.errors.map((e, i) => (
            <details className="lua-error" key={`${e.span}:${i}`}>
              <summary>
                <button
                  className="row-button"
                  onClick={(event) => {
                    event.preventDefault();
                    setRange([Math.max(0, e.time - 10), Math.min(data.duration, e.time + 10)]);
                  }}
                >
                  {ms(e.time)}
                </button>{' '}
                · {data.metrics.find((m) => m.id === e.metric)?.mod} · {e.message}
              </summary>
              <pre>{e.stack}</pre>
            </details>
          ))
        ) : (
          <p>{'No structured errors recorded in this range.'}</p>
        )}
      </details>
      <details className="telemetry-inventory">
        <summary>
          Capture environment ·{' '}
          {info
            ? `${new Set(info.sources.map((s) => s.mod)).size} instrumented mods · ${info.sources.filter((s) => s.sha256).length} source hashes`
            : 'not recorded'}
        </summary>
        {info && (
          <>
            <p>
              Game file version: {info.gameVersion}
              <br />
              Window: {info.windowTitle || 'unavailable'}
              <br />
              Lua: {info.luaModule}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Mod</th>
                  <th>Source</th>
                  <th>SHA-256 at capture</th>
                </tr>
              </thead>
              <tbody>
                {info.sources.slice(0, 1000).map((s, i) => (
                  <tr key={i}>
                    <td>{s.mod}</td>
                    <td>{s.source}</td>
                    <td>{s.sha256 || ['unresolved', '', 'size limit', 'read failed'][s.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </details>
      <table className="marker-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Marker</th>
            <th>Observed state</th>
          </tr>
        </thead>
        <tbody>
          {result.markers.slice(0, 500).map((m, i) => (
            <tr key={i}>
              <td>
                <button
                  className="row-button"
                  onClick={() =>
                    setRange([Math.max(0, m.time - 500), Math.min(data.duration, m.time + 1000)])
                  }
                >
                  {ms(m.time)}
                </button>
              </td>
              <td>
                {markerNames[m.kind]}
                {m.kind === 2 && m.flags & 1 ? ' (continued)' : ''}
              </td>
              <td>
                Run {m.run || 'unknown'} · room transition #{m.room} · level transition #{m.level}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!result.markers.length && (
        <p className="quiet">
          No lifecycle markers in this range. Room/level counters are transitions observed since
          attachment, not game IDs.
        </p>
      )}
    </div>
  );
}
