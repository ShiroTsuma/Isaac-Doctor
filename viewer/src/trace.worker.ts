import { diagnoseCapture } from './diagnosis.ts';
import Core from './core.ts';
import { StreamCapture } from './stream.ts';
import {
  rankCapture,
  rankModel,
  eventsCapture,
  framesCapture,
  summaryCapture,
  treeCapture,
} from './analysis.ts';
import { Superseded } from './task-yield.ts';
import { frameDetail } from './frame-detail.ts';
import { presentationCapture } from './presentation.ts';
import { compareCaptures } from './comparison.ts';
import { graphCapture } from './graphs.ts';
import type { Model, WorkerOperations } from './types.ts';
type Request = {
  [K in keyof WorkerOperations]: {
    id: number;
    type: K;
    payload: WorkerOperations[K]['payload'];
  };
}[keyof WorkerOperations];
const scope = self as unknown as DedicatedWorkerGlobalScope;

let model: Model;
let stream: StreamCapture | null = null;
let queue = Promise.resolve();
const latest = new Map<string, number>();
const coalesced = new Set([
  'diagnose',
  'viewport',
  'rank',
  'tree',
  'events',
  'frames',
  'telemetry',
  'frameDetail',
  'presentation',
  'compare',
  'graph',
]);

async function handle({ data: { id, type, payload } }: MessageEvent<Request>) {
  const requestKey = type === 'graph' ? `graph:${payload.slot}` : type;
  try {
    if (coalesced.has(type)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    if (coalesced.has(type) && latest.get(requestKey) !== id) {
      throw new Superseded();
    }
    if (stream) {
      stream.cancelled = () =>
        coalesced.has(type) && latest.get(requestKey) !== id;
    }
    const progress = (progress: import('./stream.ts').ProcessingProgress) => {
      if (
        scope.name === 'isaacprof-analysis' &&
        (type === 'load' || type === 'analysis')
      ) {
        scope.postMessage({ id, progress });
      }
    };
    if (stream) {
      stream.onProgress = progress;
    }
    let result: unknown;
    let transfer: Transferable[] = [];
    if (type === 'source') {
      if (payload.file.size > 4 * 1024 * 1024) {
        throw Error('Source file exceeds the 4 MiB preview limit.');
      }
      const bytes = await payload.file.arrayBuffer();
      const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
      const line = Math.max(1, Math.min(lines.length, payload.line));
      const start = Math.max(1, line - 3);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      result = {
        start,
        lines: lines.slice(start - 1, line + 20),
        total: lines.length,
        sha256,
      };
    } else if (type === 'load') {
      const header = new DataView(
        await payload.file.slice(0, 12).arrayBuffer(),
      );
      if (header.byteLength < 12) {
        throw Error('Truncated capture header.');
      }
      stream = null;
      if (header.getUint32(8, true) === 3) {
        stream = new StreamCapture(payload.file);
        stream.onProgress = progress;
        const loaded = await stream.load();
        if (scope.name !== 'isaacprof-timeline') {
          await stream.prepare();
        }
        result = {
          ...loaded,
          bins: stream.bins,
          markers: await stream.lifecycleMarkers(),
          analysis: stream.analysisInfo(),
        };
        scope.postMessage({ id, result });
        return;
      }
      if (payload.file.size > 300 * 1024 * 1024) {
        throw Error(
          'Legacy recording exceeds the 300 MiB limit; use streaming captures for larger recordings.',
        );
      }
      const document = Core.decode(await payload.file.arrayBuffer());
      model = Core.parse(document);
      const packed = new Float64Array(model.events.length * 7);
      for (let i = 0; i < model.events.length; i++) {
        const e = model.events[i];
        packed.set(
          [e.metric, e.start, e.duration, e.self, e.depth, e.thread, +e.error],
          i * 7,
        );
      }
      const laneIndices = new Map<string, number[]>();
      for (let i = 0; i < model.events.length; i++) {
        const e = model.events[i];
        const key = `${e.thread}:${e.depth}`;
        if (!laneIndices.has(key)) {
          laneIndices.set(key, []);
        }
        laneIndices.get(key)!.push(i);
      }
      const lanes = model.lanes.map((l) => ({
        ...l,
        events: undefined,
        indices: Uint32Array.from(laneIndices.get(l.key)!),
      }));
      const bins = new Float64Array(400);
      for (const e of model.events) {
        bins[
          Math.min(
            399,
            Math.floor((e.start / Math.max(model.duration, 0.001)) * 400),
          )
        ] += e.self;
      }
      const metrics = [...model.metrics.values()];
      const stats = metrics.reduce(
        (s, m) => ({
          self: s.self + m.exclusive_ns / 1e6,
          calls: s.calls + m.calls,
          errors: s.errors + m.errors,
        }),
        { self: 0, calls: 0, errors: 0 },
      );
      result = {
        document: {
          ...document,
          metrics: undefined,
          timeline: { ...document.timeline, events: undefined },
        },
        duration: model.duration,
        metrics,
        packed,
        lanes,
        bins,
        stats,
        count: model.events.length,
      };
      transfer = [
        packed.buffer,
        bins.buffer,
        ...lanes.map((l) => l.indices.buffer),
        ...(document.screenshots?.images.map((image) => image.png.buffer) ??
          []),
      ];
      // Keep only the normalized event model, not both tuple and object copies.
      document.timeline.events = [];
    } else if (type === 'viewport') {
      if (!stream) {
        throw Error('Viewport reads require a streaming capture.');
      }
      const view = await stream.viewport(
        payload.start,
        payload.end,
        payload.width,
        payload.minimumUs,
      );
      result = view;
      transfer = [
        view.packed.buffer,
        ...view.lanes.map((l) => l.indices.buffer),
      ];
    } else if (type === 'inventory') {
      result = stream
        ? ((await stream.telemetry(0, stream.duration)).inventory ?? null)
        : null;
    } else if (type === 'telemetry') {
      result = stream
        ? await stream.telemetry(payload.start, payload.end)
        : { counters: [], heap: [], markers: [] };
    } else if (type === 'analysisTarget') {
      const target = new StreamCapture(payload.file);
      await target.load();
      if (!target.document.complete || target.captureKey !== payload.key) {
        throw Error(
          'Choose the original recording currently open in the viewer.',
        );
      }
      result = null;
    } else if (type === 'analysis') {
      if (!stream || stream.captureKey !== payload.key) {
        throw Error('Recording changed before analysis was saved.');
      }
      const section = await stream.appendix();
      result = section;
      transfer = [section.appendix.buffer];
    } else if (type === 'frameSummary') {
      if (!stream) {
        throw Error('Recording has no frame intervals.');
      }
      result = await summaryCapture(stream);
    } else if (type === 'graph') {
      if (!stream) {
        throw Error('Graphs require a streaming capture.');
      }
      result = await graphCapture(
        stream,
        payload.kind,
        payload.start,
        payload.end,
        payload.columns,
        payload.windowMs,
      );
    } else if (type === 'presentation') {
      if (!stream) {
        throw Error('Presentation measurements require a streaming capture.');
      }
      result = await presentationCapture(stream, payload);
    } else if (type === 'frameDetail') {
      if (!stream) {
        throw Error('Frame details require native intervals.');
      }
      result = await frameDetail(stream, payload);
    } else if (type === 'compare') {
      if (!stream) {
        throw Error('Comparison requires streaming captures.');
      }
      const reference = new StreamCapture(payload.file);
      reference.cancelled = () => latest.get(type) !== id;
      await reference.load({ screenshots: false, overview: false });
      result = await compareCaptures(
        stream,
        reference,
        payload.start,
        payload.end,
      );
    } else if (type === 'diagnose') {
      if (!stream) {
        throw Error('Slow-frame comparisons require native intervals.');
      }
      result = await diagnoseCapture(stream, payload);
    } else if (type === 'frames') {
      if (!stream) {
        throw Error('Frame statistics require native frame markers.');
      }
      result = await framesCapture(stream, payload);
    } else if (type === 'rank') {
      result = stream
        ? await rankCapture(stream, payload)
        : rankModel(model, payload);
    } else if (type === 'events') {
      if (stream) {
        result = await eventsCapture(stream, payload);
      } else {
        const candidates = model.events.filter(
          (e) =>
            (!payload.range ||
              (e.start >= payload.start && e.start < payload.end)) &&
            (!payload.errorsOnly || e.error) &&
            Core.matches(model.metrics.get(e.metric)!, payload.search),
        );
        const rows = candidates.filter(
          (e) => e.duration * 1000 >= (payload.minimumUs ?? 0),
        );
        const omitted = candidates
          .filter((e) => e.duration * 1000 < (payload.minimumUs ?? 0))
          .reduce(
            (s, e) => ({
              calls: s.calls + 1,
              self: s.self + e.self,
              total: s.total + e.duration,
            }),
            { calls: 0, self: 0, total: 0 },
          );
        rows.sort(
          (a, b) =>
            (payload.descending ? -1 : 1) *
              (payload.sort === 'activity'
                ? model.metrics
                    .get(a.metric)!
                    .mod.localeCompare(model.metrics.get(b.metric)!.mod)
                : a[payload.sort] - b[payload.sort]) || a.start - b.start,
        );
        result = { rows: rows.slice(0, 500), count: rows.length, omitted };
      }
    } else if (type === 'tree') {
      result = await treeCapture(stream ?? model, payload);
    } else if (type === 'export') {
      if (stream) {
        const parts: BlobPart[] = ['{"traceEvents":['];
        let comma = false;
        let batch: string[] = [];
        for await (const e of stream.events()) {
          const m = stream.metrics.get(e.metric)!;
          batch.push(
            (comma ? ',' : '') +
              JSON.stringify({
                ph: 'X',
                cat: m.mod,
                name: m.callback_name || m.callback_id,
                pid: stream.document.pid,
                tid: e.thread,
                ts: e.start * 1000,
                dur: e.duration * 1000,
                args: {
                  mod: m.mod,
                  source: m.source,
                  line: m.line,
                  self_us: e.self * 1000,
                  error: e.error,
                  span: e.span,
                  parent: e.parent,
                },
              }),
          );
          comma = true;
          if (batch.length === 4096) {
            parts.push(new Blob([batch.join('')]));
            batch = [];
          }
        }
        parts.push(batch.join(''), '],"displayTimeUnit":"ms"}');
        result = new Blob(parts, { type: 'application/json' });
        scope.postMessage({ id, result });
        return;
      }
      const bytes = new TextEncoder().encode(
        JSON.stringify(Core.chromeTrace(model)),
      );
      result = bytes;
      transfer = [bytes.buffer];
    } else {
      throw Error('Unknown worker operation');
    }
    scope.postMessage({ id, result }, transfer);
  } catch (error) {
    scope.postMessage({
      id,
      error: error instanceof Error ? error.message : 'Worker failed',
    });
  }
}

scope.onmessage = (event) => {
  const message = event.data as Request;
  if (coalesced.has(message.type)) {
    latest.set(
      message.type === 'graph' ? `graph:${message.payload.slot}` : message.type,
      message.id,
    );
  }
  queue = queue
    .then(() => handle(event as MessageEvent<Request>))
    .catch(() => undefined);
};
