import Core from './core.ts';
import type {
  CaptureDocument,
  FrameInterval,
  Lane,
  LoadedTrace,
  Metric,
  TraceEvent,
  Telemetry,
  CaptureInventory,
  RunMarker,
  PresentationSample,
  NativeWait,
  RenderState,
} from './types.ts';
import {
  rangePlan,
  cachedFrames,
  decodeAnalysis,
  encodeAnalysis,
  prepareAnalysis,
  overviewColumns,
  overviewLimit,
} from './analysis-cache.ts';
import type { AnalysisCache } from './analysis-cache.ts';
import {
  cacheLocation,
  encodeSection,
  sectionPayload,
} from './analysis-section.ts';
import { TimeIndex } from './time-index.ts';
import { Superseded, yieldTask } from './task-yield.ts';

export interface BinarySource {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
export interface ProcessingProgress {
  stage: string;
  completed: number;
  total: number;
  percent: number;
}
interface Block {
  offset: number;
  minimum: number;
  maximum: number;
  count: number;
  type: number;
  version: number;
  bytes: number;
  crc: number;
  base: number;
  preview?: Block;
}
const table = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return c;
});

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = table[(c ^ b) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function integer(view: DataView, offset: number) {
  const high = view.getUint32(offset + 4, true);
  if (high > 0x1fffff) {
    throw Error('Capture integer exceeds browser precision.');
  }
  return high * 4294967296 + view.getUint32(offset, true);
}

function text(bytes: ArrayBuffer) {
  return new TextDecoder().decode(bytes);
}

export class StreamCapture {
  readonly file: BinarySource;
  blocks: Block[] = [];
  document!: CaptureDocument;
  metrics = new Map<number, Metric>();
  count = 0;
  frequency = 0;
  duration = 0;
  bins = new Float64Array(400);
  cache = new Map<number, ArrayBuffer>();
  cacheBytes = 0;
  readonly cacheLimit = 64 * 1024 * 1024;
  eventIndex = new TimeIndex<Block>([]);
  intervalIndex = new TimeIndex<Block>([]);
  presentationIndex = new TimeIndex<Block>([]);
  waitIndex = new TimeIndex<Block>([]);
  cancelled = () => false;
  onProgress: (progress: ProcessingProgress) => void = () => {};
  private progress(stage: string, total: number) {
    let last = -Infinity;
    return (completed: number) => {
      const now = performance.now();
      if (completed === 0 || completed === total || now - last >= 250) {
        last = now;
        this.onProgress({
          stage,
          completed,
          total,
          percent: total ? Math.floor((completed / total) * 100) : 100,
        });
      }
    };
  }

  analysis: AnalysisCache | null = null;
  analysisStored = false;
  sourceSize = 0;
  indexCRC = 0;
  telemetryCache: Telemetry | null = null;
  captureKey = '';
  private rankCache: {
    start: number;
    end: number;
    minimumUs: number;
    metrics: Metric[];
    omittedMetrics: Metric[];
  } | null = null;

  constructor(file: BinarySource) {
    this.file = file;
  }

  remember(block: Block, bytes: ArrayBuffer) {
    if (bytes.byteLength > 2 * 1024 * 1024) {
      return;
    }
    const old = this.cache.get(block.offset);
    if (old) {
      this.cacheBytes -= old.byteLength;
    }
    this.cache.delete(block.offset);
    this.cache.set(block.offset, bytes);
    this.cacheBytes += bytes.byteLength;
    while (this.cacheBytes > this.cacheLimit || this.cache.size > 65536) {
      const key = this.cache.keys().next().value!;
      const old = this.cache.get(key)!;
      this.cacheBytes -= old.byteLength;
      this.cache.delete(key);
    }
  }

  async read(offset: number, size: number) {
    if (offset < 0 || size < 0 || offset + size > this.file.size) {
      throw Error('Truncated capture block.');
    }
    return this.file.slice(offset, offset + size).arrayBuffer();
  }

  async payload(block: Block) {
    const cached = this.cache.get(block.offset);
    if (cached) {
      this.cache.delete(block.offset);
      this.cache.set(block.offset, cached);
      return cached;
    }
    const bytes = await this.read(block.offset + 48, block.bytes);
    if (crc32(new Uint8Array(bytes)) !== block.crc) {
      throw Error(`Capture checksum failed at byte ${block.offset}.`);
    }
    this.remember(block, bytes);
    return bytes;
  }

  async *payloads(blocks: Block[]) {
    const groups: Block[][] = [];
    const cached: Block[] = [];
    for (const b of blocks.slice().sort((a, b) => a.offset - b.offset)) {
      if (this.cache.has(b.offset)) {
        cached.push(b);
        continue;
      }
      const group = groups.at(-1);
      const last = group?.at(-1);
      if (
        group &&
        last &&
        b.offset + 48 + b.bytes - (group[0].offset + 48) <= 2 * 1024 * 1024 &&
        b.offset - last.offset - 48 - last.bytes <= 8192
      ) {
        group.push(b);
      } else {
        groups.push([b]);
      }
    }
    for (const b of cached) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      yield { block: b, bytes: await this.payload(b) };
    }
    for (let at = 0; at < groups.length; at += 6) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      const loaded = await Promise.all(
        groups.slice(at, at + 6).map(async (group) => {
          const start = group[0].offset + 48;
          const last = group.at(-1)!;
          const bytes = await this.read(
            start,
            last.offset + 48 + last.bytes - start,
          );
          return group.map((block) => {
            const payload = bytes.slice(
              block.offset + 48 - start,
              block.offset + 48 - start + block.bytes,
            );
            if (crc32(new Uint8Array(payload)) !== block.crc) {
              throw Error(`Capture checksum failed at byte ${block.offset}.`);
            }
            this.remember(block, payload);
            return { block, bytes: payload };
          });
        }),
      );
      if (this.cancelled()) {
        throw new Superseded();
      }
      for (const group of loaded) {
        for (const item of group) {
          yield item;
        }
      }
    }
  }

  async visitEvents(
    start: number,
    end: number,
    visit: (
      event: () => TraceEvent,
      metric: number,
      ticks: number,
      duration: number,
      self: number,
      thread: number,
      depth: number,
      error: boolean,
    ) => void,
    pixelTicks = 0,
    selectedBlocks?: Block[],
  ) {
    const a = (start * this.frequency) / 1000;
    const b = (end * this.frequency) / 1000;
    const blocks = (selectedBlocks ?? this.eventIndex.query(a, b)).map(
      (block) =>
        pixelTicks > 0 &&
        block.preview &&
        (block.maximum - block.minimum) / 16 <= pixelTicks
          ? block.preview
          : block,
    );
    let yielded = performance.now();
    const progress = this.progress(
      pixelTicks ? 'Timeline overview' : 'Callback analysis',
      blocks.length,
    );
    let completed = 0;
    progress(0);
    for await (const { block, bytes } of this.payloads(blocks)) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      const v = new DataView(bytes);
      for (let i = 0; i < block.count; i++) {
        const p = 8 + i * 64;
        const t = integer(v, p + 32);
        const duration = integer(v, p + 40);
        const self = integer(v, p + 48);
        if (t > b || t + duration < a) {
          continue;
        }
        const metric = v.getUint32(p, true);
        const depth = v.getUint16(p + 8, true);
        const flags = v.getUint16(p + 10, true);
        const thread = v.getUint32(p + 4, true);
        if (!this.metrics.has(metric)) {
          if (!this.document.complete) {
            continue;
          }
          throw Error('Event references an unknown callback.');
        }
        if (self > duration || depth > 1024 || flags > 1) {
          throw Error('Invalid event timing or flags.');
        }
        visit(
          () => {
            const id = integer(v, p + 16);
            return {
              index: id,
              span: id,
              parent: integer(v, p + 24),
              parentMetric: v.getUint32(p + 12, true),
              metric,
              start: (t / this.frequency) * 1000,
              duration: (duration / this.frequency) * 1000,
              self: (self / this.frequency) * 1000,
              depth,
              thread,
              error: !!flags,
            };
          },
          metric,
          t,
          duration,
          self,
          thread,
          depth,
          !!flags,
        );
      }
      progress(++completed);
      if (performance.now() - yielded > 8) {
        await yieldTask();
        yielded = performance.now();
      }
    }
  }

  async visitRanges(
    ranges: [number, number][],
    visit: (event: TraceEvent) => void,
  ) {
    const merged: [number, number][] = [];
    for (const [start, end] of ranges.slice().sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) {
        previous[1] = Math.max(previous[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    if (!merged.length) {
      return;
    }
    const blocks = new Set<Block>();
    for (const [start, end] of merged) {
      for (const block of this.eventIndex.query(
        (start * this.frequency) / 1000,
        (end * this.frequency) / 1000,
      )) {
        blocks.add(block);
      }
    }
    await this.visitEvents(
      merged[0][0],
      merged.at(-1)![1],
      (event, _id, ticks) => {
        const start = (ticks / this.frequency) * 1000;
        let low = 0;
        let high = merged.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (merged[middle][0] <= start) {
            low = middle + 1;
          } else {
            high = middle;
          }
        }
        if (low && start < merged[low - 1][1]) {
          visit(event());
        }
      },
      0,
      [...blocks],
    );
  }

  async rankMetrics(start: number, end: number, minimumUs = 0) {
    return (await this.rankSelection(start, end, minimumUs)).metrics;
  }

  async rankSelection(start: number, end: number, minimumUs = 0) {
    if (
      this.rankCache?.start === start &&
      this.rankCache.end === end &&
      this.rankCache.minimumUs === minimumUs
    ) {
      return this.rankCache;
    }
    const { totals, edges } = rangePlan(
      minimumUs ? null : this.analysis,
      this.metrics,
      start,
      end,
    );
    const omitted = new Map<number, Metric>();
    const scale = 1e9 / this.frequency;
    for (const [a, b] of edges) {
      await this.visitEvents(
        a,
        b,
        (_event, id, ticks, duration, self, _thread, _depth, error) => {
          const at = (ticks / this.frequency) * 1000;
          if (at < a || at >= b) {
            return;
          }
          const target =
            (duration / this.frequency) * 1e6 < minimumUs ? omitted : totals;
          let m = target.get(id);
          if (!m) {
            m = {
              ...this.metrics.get(id)!,
              calls: 0,
              errors: 0,
              inclusive_ns: 0,
              exclusive_ns: 0,
              max_ns: 0,
            };
            target.set(id, m);
          }
          m.calls++;
          m.errors += +error;
          m.inclusive_ns += duration * scale;
          m.exclusive_ns += self * scale;
          m.max_ns = Math.max(m.max_ns, duration * scale);
        },
      );
    }
    const metrics = [...totals.values()].map((m) => ({
      ...m,
      mean_ns: m.calls ? m.inclusive_ns / m.calls : 0,
    }));
    this.rankCache = {
      start,
      end,
      minimumUs,
      metrics,
      omittedMetrics: [...omitted.values()],
    };
    return this.rankCache;
  }

  async load(
    options: { screenshots?: boolean; overview?: boolean } = {},
  ): Promise<LoadedTrace> {
    const progress = this.progress('Reading capture index', 1);
    progress(0);
    const header = new DataView(await this.read(0, 40));
    if (header.getUint32(8, true) !== 3 || header.getUint32(12, true) !== 40) {
      throw Error('Unsupported streaming capture header.');
    }
    this.frequency = integer(header, 24);
    if (!this.frequency) {
      throw Error('Invalid QPC frequency.');
    }
    let footer =
      this.file.size >= 72 ? await this.read(this.file.size - 32, 32) : null;
    const location = footer ? cacheLocation(footer, this.file.size) : null;
    this.sourceSize = location?.sourceSize ?? this.file.size;
    if (location) {
      footer = await this.read(this.sourceSize - 32, 32);
    }
    let finalized = false;
    if (footer && text(footer.slice(0, 8)) === 'IPEND003') {
      const v = new DataView(footer);
      const offset = integer(v, 8);
      const bytes = v.getUint32(16, true);
      if (
        offset < 40 ||
        offset + 48 + bytes !== this.sourceSize - 32 ||
        bytes % 40 ||
        bytes > 64 * 1024 * 1024
      ) {
        throw Error('Invalid capture index.');
      }
      const h = new DataView(await this.read(offset, 48));
      if (
        h.getUint32(0, true) !== 0x4b4e4843 ||
        h.getUint16(4, true) !== 5 ||
        h.getUint16(6, true) !== 1 ||
        h.getUint32(8, true) !== bytes ||
        h.getUint32(12, true) !== bytes / 40
      ) {
        throw Error('Invalid index chunk.');
      }
      const raw = await this.read(offset + 48, bytes);
      if (crc32(new Uint8Array(raw)) !== h.getUint32(40, true)) {
        throw Error('Capture index checksum failed.');
      }
      this.indexCRC = h.getUint32(40, true);
      const entries = new DataView(raw);
      let previous = 40;
      for (let p = 0; p < bytes; p += 40) {
        const b: Block = {
          offset: integer(entries, p),
          minimum: integer(entries, p + 8),
          maximum: integer(entries, p + 16),
          count: entries.getUint32(p + 24, true),
          type: entries.getUint16(p + 28, true),
          version: entries.getUint16(p + 30, true),
          bytes: entries.getUint32(p + 32, true),
          crc: entries.getUint32(p + 36, true),
          base: 0,
        };
        if (
          b.offset !== previous ||
          b.offset + 48 + b.bytes > offset ||
          b.minimum > b.maximum
        ) {
          throw Error('Invalid indexed block bounds.');
        }
        previous = b.offset + 48 + b.bytes;
        this.blocks.push(b);
      }
      if (previous !== offset) {
        throw Error('Capture index omits bytes.');
      }
      finalized = true;
    } else {
      // Crash recovery scans headers only, then verifies every complete block before accepting it.
      let offset = 40;
      let sequence = 0;
      while (offset + 48 <= this.file.size) {
        const h = new DataView(await this.read(offset, 48));
        if (text(h.buffer.slice(0, 8)) === 'IPEND003') {
          break;
        }
        if (h.getUint32(0, true) !== 0x4b4e4843) {
          break;
        }
        const bytes = h.getUint32(8, true);
        if (bytes > 64 * 1024 * 1024 || offset + 48 + bytes > this.file.size) {
          break;
        }
        if (integer(h, 16) !== sequence++) {
          throw Error('Invalid capture block sequence.');
        }
        const b: Block = {
          offset,
          minimum: integer(h, 24),
          maximum: integer(h, 32),
          count: h.getUint32(12, true),
          type: h.getUint16(4, true),
          version: h.getUint16(6, true),
          bytes,
          crc: h.getUint32(40, true),
          base: 0,
        };
        await this.payload(b);
        this.blocks.push(b);
        offset += 48 + bytes;
      }
      // A failed appendix write must not make the already sealed recording incomplete.
      if (
        offset + 32 <= this.file.size &&
        text(await this.read(offset, 8)) === 'IPEND003'
      ) {
        const tail = new DataView(await this.read(offset, 32));
        const indexOffset = integer(tail, 8);
        const indexBytes = tail.getUint32(16, true);
        const index = this.blocks.at(-1);
        if (
          index?.type !== 5 ||
          index.offset !== indexOffset ||
          index.bytes !== indexBytes ||
          indexOffset + 48 + indexBytes !== offset
        ) {
          throw Error('Invalid recovered index footer.');
        }
        this.indexCRC = index.crc;
        this.blocks.pop();
        this.sourceSize = offset + 32;
        finalized = true;
      }
    }
    const metadata = this.blocks.filter((b) => b.type === 1).at(-1);
    if (!metadata) {
      throw Error('Capture has no recoverable metadata yet.');
    }
    this.document = Core.decode(await this.payload(metadata));
    this.document.complete = this.document.complete && finalized;
    this.document.binary_version = 3;
    this.document.losses = [];
    this.document.screenshots ??= {
      interval_ms: 0,
      omitted: 0,
      overhead_ns: 0,
      images: [],
    };
    this.metrics = new Map(this.document.metrics!.map((m) => [m.id, m]));
    let maximum = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.type <= 19 && b.version !== 1) {
        throw Error('Unsupported required block version.');
      }
      if (
        b.type === 16 &&
        (b.bytes !== b.count * 80 || !b.count || b.count > 2048)
      ) {
        throw Error('Invalid presentation chunk.');
      }
      if (
        b.type === 17 &&
        (b.bytes !== b.count * 40 || !b.count || b.count > 4096)
      ) {
        throw Error('Invalid native wait chunk.');
      }
      if (b.type === 18 && (b.count !== 1 || b.bytes < 60 || b.bytes > 3200)) {
        throw Error('Invalid render state chunk.');
      }
      if (b.type === 19 && (b.count !== 1 || b.bytes < 20 || b.bytes > 32788)) {
        throw Error('Invalid native module chunk.');
      }
      if (
        (b.type === 12 || b.type === 13) &&
        (b.bytes !== b.count * (b.type === 12 ? 72 : 64) ||
          !b.count ||
          b.count > 4096)
      ) {
        throw Error('Invalid diagnostics chunk.');
      }
      if (b.type === 14 && (b.count !== 1 || b.bytes < 32 || b.bytes > 20600)) {
        throw Error('Invalid error chunk.');
      }
      if (
        b.type >= 8 &&
        b.type <= 10 &&
        (b.bytes !==
          b.count *
            ({ 8: 72, 9: 16, 10: 48 } as Record<number, number>)[b.type] ||
          !b.count ||
          b.count > 4096)
      ) {
        throw Error('Invalid telemetry chunk.');
      }
      if (
        b.type === 7 &&
        (b.bytes !== b.count * 32 || b.count > 4096 || !b.count)
      ) {
        throw Error('Invalid frame interval chunk.');
      }
      if (b.type === 2 || b.type === 6) {
        if (b.bytes !== 8 + b.count * 64 || b.count > 4096 || !b.count) {
          throw Error('Invalid event chunk.');
        }
      }
      if (b.type === 2) {
        b.base = this.count;
        this.count += b.count;
        maximum = Math.max(maximum, b.maximum);
        const preview = this.blocks[i + 1];
        if (
          preview?.type === 6 &&
          preview.minimum === b.minimum &&
          preview.maximum === b.maximum
        ) {
          b.preview = preview;
        }
      }
      if (b.type === 15) {
        const v = new DataView(await this.payload(b));
        let p = 0;
        const u32 = () => {
          if (p + 4 > v.byteLength) {
            throw Error('Truncated capture configuration.');
          }
          const n = v.getUint32(p, true);
          p += 4;
          return n;
        };
        const names = () => {
          const count = u32();
          if (count > 128) {
            throw Error('Invalid capture scope.');
          }
          const result: string[] = [];
          for (let i = 0; i < count; i++) {
            const length = u32();
            if (!length || length > 4095 || p + length > v.byteLength) {
              throw Error('Invalid scope name.');
            }
            result.push(
              new TextDecoder('utf-8', { fatal: true }).decode(
                new Uint8Array(v.buffer, p, length),
              ),
            );
            p += length;
          }
          return result;
        };
        const version = u32();
        if (version !== 1 && version !== 2) {
          throw Error('Unsupported capture configuration version.');
        }
        const config = {
          version,
          channels: u32(),
          startOn: u32(),
          stopOn: u32(),
          startDelayMs: u32(),
          stopDelayMs: u32(),
          maxDurationMs: version === 2 ? u32() : 0,
          selectedMods: names(),
          selectedHooks: names(),
        };
        if (
          config.channels > 8191 ||
          config.startOn > 10 ||
          config.stopOn < 1 ||
          config.stopOn > 12 ||
          config.startDelayMs > 3600000 ||
          config.stopDelayMs > 3600000 ||
          config.maxDurationMs > 3600000 ||
          p !== v.byteLength
        ) {
          throw Error('Invalid capture configuration.');
        }
        this.document.configuration = config;
      }
      if (b.type === 4) {
        if (b.bytes !== 24) {
          throw Error('Invalid loss block.');
        }
        const v = new DataView(await this.payload(b));
        const count = integer(v, 0);
        const start = integer(v, 8);
        const end = integer(v, 16);
        if (start > end) {
          throw Error('Invalid loss interval.');
        }
        this.document.losses.push({
          count,
          start_ns: (start / this.frequency) * 1e9,
          end_ns: (end / this.frequency) * 1e9,
        });
      }
      if (b.type === 3 && options.screenshots !== false) {
        const raw = await this.payload(b);
        const v = new DataView(raw);
        const size = v.getUint32(16, true);
        const time_ns = v.getFloat64(0, true);
        const width = v.getUint16(8, true);
        const height = v.getUint16(10, true);
        if (
          b.bytes !== 20 + size ||
          size < 8 ||
          size > 1048576 ||
          v.getUint32(12, true) !== 1 ||
          !Number.isFinite(time_ns) ||
          time_ns < 0 ||
          !width ||
          width > 320 ||
          !height ||
          height > 240 ||
          this.document.screenshots.images.length >= 240
        ) {
          throw Error('Invalid screenshot block.');
        }
        const png = new Uint8Array(raw.slice(20));
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => png[i] === x)) {
          throw Error('Invalid screenshot PNG.');
        }
        this.document.screenshots.images.push({ time_ns, width, height, png });
        maximum = Math.max(maximum, (time_ns * this.frequency) / 1e9);
      }
    }
    this.duration = Math.max(
      this.document.duration_ns / 1e6,
      (maximum / this.frequency) * 1000,
    );
    this.eventIndex = new TimeIndex(this.blocks.filter((b) => b.type === 2));
    this.intervalIndex = new TimeIndex(this.blocks.filter((b) => b.type === 7));
    this.presentationIndex = new TimeIndex(
      this.blocks.filter((b) => b.type === 16),
    );
    this.waitIndex = new TimeIndex(this.blocks.filter((b) => b.type === 17));
    this.document.duration_ns = this.duration * 1e6;
    this.captureKey = `${header.getUint32(16, true)}:${header.getBigUint64(32, true)}:${this.sourceSize}:${this.indexCRC}`;
    if (location && finalized) {
      try {
        const payload = sectionPayload(
          await this.read(location.sourceSize, 32 + location.payloadSize),
          location,
          this.indexCRC,
        );
        if (payload) {
          this.analysis = decodeAnalysis(
            payload,
            this.metrics,
            this.duration,
            location.version,
          );
          this.analysisStored = true;
          this.bins = this.analysis.bins.slice();
        }
      } catch {
        /* Derived data can be rebuilt; raw capture validation remains authoritative. */
      }
    }
    if (!this.analysis && options.overview !== false) {
      const blocks = this.blocks.filter((b) => b.type === 2);
      const totalsProgress = this.progress(
        'Reading timeline totals',
        blocks.length,
      );
      let completed = 0;
      totalsProgress(0);
      for (const b of blocks) {
        const self =
          (integer(new DataView(await this.read(b.offset + 48, 8)), 0) /
            this.frequency) *
          1000;
        this.bins[
          Math.min(
            399,
            Math.floor(
              (((b.minimum / this.frequency) * 1000) /
                Math.max(this.duration, 0.001)) *
                400,
            ),
          )
        ] += self;
        totalsProgress(++completed);
      }
    }
    const metrics = [...this.metrics.values()];
    const stats = metrics.reduce(
      (s, m) => ({
        self: s.self + m.exclusive_ns / 1e6,
        calls: s.calls + m.calls,
        errors: s.errors + m.errors,
      }),
      { self: 0, calls: 0, errors: 0 },
    );
    progress(1);
    return {
      document: {
        ...this.document,
        metrics: undefined,
        timeline: { ...this.document.timeline, events: undefined },
      },
      duration: this.duration,
      metrics,
      packed: new Float64Array(),
      lanes: [],
      bins: this.bins,
      stats,
      count: this.count,
      streaming: true,
      analysis: this.analysisInfo(),
    };
  }

  analysisInfo() {
    return this.analysis
      ? {
          key: this.captureKey,
          state: this.analysisStored
            ? ('stored' as const)
            : ('computed' as const),
          render: cachedFrames(this.analysis, [0, 4], 2),
          update: cachedFrames(this.analysis, [0, 4], 1),
        }
      : undefined;
  }

  async prepare() {
    if (this.analysis || !this.document.complete) {
      return;
    }
    const empty = async function* () {};
    const analysis = await prepareAnalysis(
      this.duration,
      empty(),
      this.intervals(0, this.duration),
      new Float64Array(400),
    );
    const overview = new Map<string, TraceEvent>();
    let entries = 0;
    let overflow = false;
    await this.visitEvents(
      0,
      this.duration,
      (event, id, ticks, duration, self, thread, depth, error) => {
        const start = (ticks / this.frequency) * 1000;
        const at = start / Math.max(this.duration, 1e-9);
        const q =
          analysis.quarters[Math.min(3, Math.max(0, Math.floor(at * 4)))];
        let m = q.metrics.get(id);
        if (!m) {
          if (++entries > 400000) {
            throw Error('Analysis cache exceeds the callback limit.');
          }
          m = {
            id,
            calls: 0,
            errors: 0,
            inclusive: 0,
            exclusive: 0,
            maximum: 0,
          };
          q.metrics.set(id, m);
        }
        m.calls++;
        m.errors += +error;
        m.inclusive += (duration / this.frequency) * 1000;
        m.exclusive += (self / this.frequency) * 1000;
        m.maximum = Math.max(m.maximum, (duration / this.frequency) * 1000);
        analysis.bins[Math.min(399, Math.floor(at * 400))] +=
          (self / this.frequency) * 1000;
        if (!overflow) {
          const key = `${thread}:${depth}:${Math.min(overviewColumns - 1, Math.floor(at * overviewColumns))}`;
          const old = overview.get(key);
          if (!old || (duration / this.frequency) * 1000 > old.duration) {
            overview.set(key, event());
          }
          if (overview.size > overviewLimit) {
            overview.clear();
            overflow = true;
          }
        }
      },
    );
    if (!overflow) {
      analysis.overview = {
        columns: overviewColumns,
        events: [...overview.values()].sort(
          (a, b) => a.start - b.start || a.depth - b.depth,
        ),
      };
    }
    this.analysis = analysis;
    this.bins = analysis.bins.slice();
  }

  async prepareOverview() {
    await this.prepare();
    if (!this.analysis) {
      throw Error('Only a completed streaming capture can store analysis.');
    }
    if (this.analysis.overview) {
      return;
    }
    // Build once from the same native LOD selection used by the viewport. Never affects exact queries.
    const events = await this.viewportEvents(0, this.duration, overviewColumns);
    this.analysis.overview = { columns: overviewColumns, events };
    this.analysisStored = false;
  }

  async appendix() {
    await this.prepareOverview();
    return {
      sourceSize: this.sourceSize,
      appendix: encodeSection(
        encodeAnalysis(this.analysis!),
        this.sourceSize,
        this.indexCRC,
      ),
    };
  }

  async *events(
    start = 0,
    end = this.duration,
    pixelTicks = 0,
    blocks?: Block[],
  ): AsyncGenerator<TraceEvent> {
    const a = (start * this.frequency) / 1000;
    const b = (end * this.frequency) / 1000;
    let yielded = performance.now();
    let completed = 0;
    const selectedBlocks = (blocks ?? this.eventIndex.query(a, b)).filter(
      (block) => block.type === 2 && block.maximum >= a && block.minimum <= b,
    );
    const progress = this.progress('Callback analysis', selectedBlocks.length);
    progress(0);
    for (const block of selectedBlocks) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      if (performance.now() - yielded > 8) {
        await yieldTask();
        yielded = performance.now();
      }
      const selected =
        pixelTicks > 0 &&
        block.preview &&
        (block.maximum - block.minimum) / 16 <= pixelTicks
          ? block.preview
          : block;
      const v = new DataView(await this.payload(selected));
      for (let i = 0; i < selected.count; i++) {
        const p = 8 + i * 64;
        const t = integer(v, p + 32);
        const duration = integer(v, p + 40);
        const self = integer(v, p + 48);
        if (t > b || t + duration < a) {
          continue;
        }
        const metric = v.getUint32(p, true);
        const depth = v.getUint16(p + 8, true);
        const flags = v.getUint16(p + 10, true);
        if (!this.metrics.has(metric)) {
          if (!this.document.complete) {
            continue;
          }
          throw Error('Event references an unknown callback.');
        }
        if (self > duration || depth > 1024 || flags > 1) {
          throw Error('Invalid event timing or flags.');
        }
        const id = integer(v, p + 16);
        yield {
          index: id,
          span: id,
          parent: integer(v, p + 24),
          parentMetric: v.getUint32(p + 12, true),
          metric,
          start: (t / this.frequency) * 1000,
          duration: (duration / this.frequency) * 1000,
          self: (self / this.frequency) * 1000,
          depth,
          thread: v.getUint32(p + 4, true),
          error: !!flags,
        };
      }
      progress(++completed);
    }
  }

  async *intervals(start: number, end: number): AsyncGenerator<FrameInterval> {
    let yielded = performance.now();
    let completed = 0;
    const blocks = this.intervalIndex.query(
      (start * this.frequency) / 1000,
      (end * this.frequency) / 1000,
    );
    const progress = this.progress('Frame statistics', blocks.length);
    progress(0);
    for (const b of blocks) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      const v = new DataView(await this.payload(b));
      for (let p = 0; p < b.bytes; p += 32) {
        const id = integer(v, p);
        const ticks = integer(v, p + 8);
        const duration = integer(v, p + 16);
        const kind = v.getUint32(p + 24, true);
        const thread = v.getUint32(p + 28, true);
        if (
          !id ||
          (kind !== 1 && kind !== 2) ||
          !duration ||
          ticks < b.minimum ||
          ticks + duration > b.maximum
        ) {
          throw Error('Invalid frame interval timing.');
        }
        yield {
          id,
          start: (ticks / this.frequency) * 1000,
          duration: (duration / this.frequency) * 1000,
          kind,
          thread,
        };
        if (performance.now() - yielded > 8) {
          await yieldTask();
          yielded = performance.now();
          if (this.cancelled()) {
            throw new Superseded();
          }
        }
      }
      progress(++completed);
    }
  }

  async nativeModules() {
    const modules: { base: bigint; size: bigint; path: string }[] = [];
    for (const block of this.blocks.filter((b) => b.type === 19)) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      const v = new DataView(await this.payload(block));
      const base = v.getBigUint64(0, true);
      const size = v.getBigUint64(8, true);
      const length = v.getUint32(16, true);
      if (
        !base ||
        !size ||
        base + size > 0x100000000n ||
        length > 32768 ||
        20 + length !== v.byteLength
      ) {
        throw Error('Invalid native module payload.');
      }
      modules.push({
        base,
        size,
        path: new TextDecoder().decode(
          new Uint8Array(v.buffer, v.byteOffset + 20, length),
        ),
      });
      if (modules.length > 2000) {
        throw Error('Too many native modules.');
      }
    }
    return modules;
  }

  async renderStates(end = this.duration): Promise<RenderState[]> {
    const result: RenderState[] = [];
    for (const block of this.blocks.filter((b) => b.type === 18)) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      const v = new DataView(await this.payload(block));
      const time = (integer(v, 0) / this.frequency) * 1000;
      const flags = v.getUint32(40, true);
      const hooks = v.getUint32(44, true);
      if (!v.getUint32(8, true) || flags > 3 || hooks > 63) {
        throw Error('Invalid render state flags.');
      }
      let p = 48;
      const text = () => {
        if (p + 4 > v.byteLength) {
          throw Error('Truncated render state.');
        }
        const n = v.getUint32(p, true);
        p += 4;
        if (n > 1024 || p + n > v.byteLength) {
          throw Error('Invalid GL string.');
        }
        const value = new TextDecoder().decode(
          new Uint8Array(v.buffer, v.byteOffset + p, n),
        );
        p += n;
        return value;
      };
      const state: RenderState = {
        time,
        thread: v.getUint32(8, true),
        width: v.getUint32(12, true),
        height: v.getUint32(16, true),
        viewport: [20, 24, 28, 32].map((at) => v.getInt32(at, true)),
        swapInterval: flags & 2 ? v.getInt32(36, true) : null,
        waitHooks: hooks,
        vendor: text(),
        renderer: text(),
        version: text(),
      };
      if (p !== v.byteLength || time < 0 || time > this.duration + 0.001) {
        throw Error('Invalid render state payload.');
      }
      if (time <= end) {
        result.push(state);
      }
      if (result.length > 10000) {
        throw Error('Too many render state changes.');
      }
    }
    return result.sort((a, b) => a.time - b.time);
  }

  async *waits(start: number, end: number): AsyncGenerator<NativeWait> {
    const blocks = this.waitIndex.query(
      (start * this.frequency) / 1000,
      (end * this.frequency) / 1000,
    );
    let yielded = performance.now();
    for (const block of blocks) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      const v = new DataView(await this.payload(block));
      for (let p = 0; p < block.bytes; p += 40) {
        const ticks = integer(v, p);
        const duration = integer(v, p + 8);
        const thread = v.getUint32(p + 28, true);
        const kind = v.getUint32(p + 32, true);
        if (
          !thread ||
          !duration ||
          kind < 1 ||
          kind > 6 ||
          ticks < block.minimum ||
          ticks + duration > block.maximum
        ) {
          throw Error('Invalid native wait record.');
        }
        const time = (ticks / this.frequency) * 1000;
        const ms = (duration / this.frequency) * 1000;
        if (time < end && time + ms > start) {
          yield {
            start: time,
            duration: ms,
            caller: '0x' + v.getBigUint64(p + 16, true).toString(16),
            requestedMs: v.getUint32(p + 24, true),
            thread,
            kind,
            result: v.getUint32(p + 36, true),
          };
        }
        if (performance.now() - yielded > 8) {
          await yieldTask();
          yielded = performance.now();
          if (this.cancelled()) {
            throw new Superseded();
          }
        }
      }
    }
  }

  async *presentations(
    start: number,
    end: number,
  ): AsyncGenerator<PresentationSample> {
    const blocks = this.presentationIndex.query(
      (start * this.frequency) / 1000,
      (end * this.frequency) / 1000,
    );
    let yielded = performance.now();
    for (const block of blocks) {
      if (this.cancelled()) {
        throw new Superseded();
      }
      const view = new DataView(await this.payload(block));
      for (let p = 0; p < block.bytes; p += 80) {
        const ticks = integer(view, p);
        const duration = integer(view, p + 8);
        const id = integer(view, p + 16);
        const swapStart = integer(view, p + 24);
        const swap = integer(view, p + 32);
        const readbackStart = integer(view, p + 40);
        const readback = integer(view, p + 48);
        const cycles = integer(view, p + 56);
        const swapCycles = integer(view, p + 64);
        const thread = view.getUint32(p + 72, true);
        const flags = view.getUint32(p + 76, true);
        if (
          !id ||
          !thread ||
          !duration ||
          flags > 7 ||
          ticks < block.minimum ||
          ticks + duration > block.maximum ||
          readbackStart < ticks ||
          readbackStart + readback > swapStart ||
          swapStart + swap > ticks + duration ||
          ((flags & 3) === 3 && swapCycles > cycles)
        ) {
          throw Error('Invalid presentation timing.');
        }
        const ms = (value: number) => (value / this.frequency) * 1000;
        const time = ms(ticks);
        if (time < end && time + ms(duration) > start) {
          yield {
            id,
            thread,
            start: time,
            duration: ms(duration),
            swapStart: ms(swapStart),
            swap: ms(swap),
            readbackStart: ms(readbackStart),
            readback: ms(readback),
            cycles: flags & 1 ? cycles : null,
            swapCycles: flags & 2 ? swapCycles : null,
            success: Boolean(flags & 4),
          };
        }
        if (performance.now() - yielded > 8) {
          await yieldTask();
          yielded = performance.now();
          if (this.cancelled()) {
            throw new Superseded();
          }
        }
      }
    }
  }

  markerRecord(v: DataView, p: number): RunMarker {
    const kind = v.getUint32(p + 32, true);
    const flags = v.getUint32(p + 36, true);
    if (kind < 1 || kind > 6 || flags > 7) {
      throw Error('Invalid lifecycle marker.');
    }
    return {
      time: (integer(v, p) / this.frequency) * 1000,
      run: integer(v, p + 8),
      room: integer(v, p + 16),
      level: integer(v, p + 24),
      kind,
      flags,
    };
  }

  async lifecycleMarkers() {
    const markers: RunMarker[] = [];
    for (const block of this.blocks) {
      if (block.type === 10) {
        const v = new DataView(await this.payload(block));
        for (let p = 0; p < v.byteLength; p += 48) {
          markers.push(this.markerRecord(v, p));
          if (markers.length > 100000) {
            throw Error('Lifecycle marker limit exceeded.');
          }
        }
      }
    }
    return markers.sort((a, b) => a.time - b.time);
  }

  async telemetry(start: number, end: number): Promise<Telemetry> {
    const result: Telemetry = this.telemetryCache ?? {
      counters: [],
      heap: [],
      markers: [],
    };
    if (!this.telemetryCache) {
      for (const block of this.blocks) {
        if (block.type < 8 || block.type > 14) {
          continue;
        }
        const v = new DataView(await this.payload(block));
        if (block.type === 12 || block.type === 13) {
          if (
            (result.context?.length ?? 0) +
              (result.overhead?.length ?? 0) +
              block.count >
            50000
          ) {
            throw Error('Diagnostic sample limit exceeded.');
          }
          const stride = block.type === 12 ? 72 : 64;
          for (let p = 0; p < v.byteLength; p += stride) {
            const time = (integer(v, p) / this.frequency) * 1000;
            if (block.type === 12) {
              const valid = v.getUint32(p + 64, true);
              if (valid !== 7) {
                throw Error('Invalid room context validity.');
              }
              (result.context ??= []).push({
                time,
                room: v.getInt32(p + 8, true),
                stage: v.getInt32(p + 12, true),
                stageType: v.getInt32(p + 16, true),
                roomType: v.getInt32(p + 20, true),
                width: v.getUint32(p + 24, true),
                height: v.getUint32(p + 28, true),
                gridSlots: v.getUint32(p + 32, true),
                grids: v.getUint32(p + 36, true),
                entities: v.getUint32(p + 40, true),
                enemies: v.getUint32(p + 44, true),
                tears: v.getUint32(p + 48, true),
                projectiles: v.getUint32(p + 52, true),
                effects: v.getUint32(p + 56, true),
                pickups: v.getUint32(p + 60, true),
                valid,
              });
            } else {
              (result.overhead ??= []).push({
                time,
                calls: integer(v, p + 8),
                samples: integer(v, p + 16),
                wrapperMs: (integer(v, p + 24) / this.frequency) * 1000,
                observerMs: (integer(v, p + 32) / this.frequency) * 1000,
                auxiliaryDropped: integer(v, p + 40),
                contextFailures: integer(v, p + 48),
                errorsOmitted: integer(v, p + 56),
              });
            }
          }
          continue;
        }
        if (block.type === 14) {
          let p = 24;
          const string = () => {
            const n = v.getUint32(p, true);
            p += 4;
            if (n > 16384 || p + n > v.byteLength) {
              throw Error('Invalid Lua error string.');
            }
            const s = new TextDecoder().decode(new Uint8Array(v.buffer, p, n));
            p += n;
            return s;
          };
          const message = string();
          const stack = string();
          if (p !== v.byteLength) {
            throw Error('Unexpected Lua error bytes.');
          }
          (result.errors ??= []).push({
            time: (integer(v, 0) / this.frequency) * 1000,
            metric: v.getUint32(8, true),
            thread: v.getUint32(12, true),
            span: integer(v, 16),
            message,
            stack,
          });
          if (result.errors.length > 1000) {
            throw Error('Lua error limit exceeded.');
          }
          continue;
        }
        if (block.type === 11) {
          let p = 0;
          const u32 = () => {
            if (p + 4 > v.byteLength) {
              throw Error('Truncated inventory.');
            }
            const n = v.getUint32(p, true);
            p += 4;
            return n;
          };
          const string = () => {
            const n = u32();
            if (n > 1048576 || p + n > v.byteLength) {
              throw Error('Invalid inventory string.');
            }
            const s = new TextDecoder('utf-8', { fatal: true }).decode(
              new Uint8Array(v.buffer, p, n),
            );
            p += n;
            return s;
          };
          const info: CaptureInventory = {
            intervalMs: u32(),
            gameVersion: string(),
            windowTitle: string(),
            luaModule: string(),
            sources: [],
          };
          const count = u32();
          if (info.intervalMs !== 250 || count > 300) {
            throw Error('Invalid inventory layout.');
          }
          for (let i = 0; i < count; i++) {
            const entry = {
              mod: string(),
              source: string(),
              path: string(),
              sha256: string(),
              status: u32(),
            };
            if (
              entry.status > 3 ||
              (entry.sha256 && !/^[a-f0-9]{64}$/.test(entry.sha256))
            ) {
              throw Error('Invalid source identity.');
            }
            info.sources.push(entry);
          }
          if (p !== v.byteLength) {
            throw Error('Unexpected inventory bytes.');
          }
          if (!result.inventory) {
            result.inventory = info;
          } else {
            result.inventory.sources.push(...info.sources);
          }
          if (result.inventory.sources.length > 100000) {
            throw Error('Inventory limit exceeded.');
          }
          continue;
        }
        const stride = block.type === 8 ? 72 : block.type === 9 ? 16 : 48;
        for (let p = 0; p < v.byteLength; p += stride) {
          const time = (integer(v, p) / this.frequency) * 1000;
          if (block.type === 8) {
            const valid = v.getUint32(p + 68, true);
            if (valid > 7) {
              throw Error('Invalid counter validity mask.');
            }
            result.counters.push({
              time,
              workingSet: integer(v, p + 8),
              privateBytes: integer(v, p + 16),
              pageFaults: integer(v, p + 24),
              processUser: integer(v, p + 32),
              processKernel: integer(v, p + 40),
              threadUser: integer(v, p + 48),
              threadKernel: integer(v, p + 56),
              thread: v.getUint32(p + 64, true),
              valid,
            });
          }
          if (block.type === 9) {
            result.heap.push({ time, bytes: integer(v, p + 8) });
          }
          if (block.type === 10) {
            result.markers.push(this.markerRecord(v, p));
          }
          if (
            result.counters.length +
              result.heap.length +
              result.markers.length >
            100000
          ) {
            throw Error('Telemetry limit exceeded.');
          }
        }
      }
    }
    result.counters.sort((a, b) => a.time - b.time);
    result.heap.sort((a, b) => a.time - b.time);
    result.markers.sort((a, b) => a.time - b.time);
    result.context?.sort((a, b) => a.time - b.time);
    result.overhead?.sort((a, b) => a.time - b.time);
    if (
      (result.context?.length ?? 0) + (result.overhead?.length ?? 0) >
      50000
    ) {
      throw Error('Diagnostic sample limit exceeded.');
    }
    this.telemetryCache = result;
    const selectedResult = { ...result };
    // Preserve one preceding sample as the baseline for deltas and step charts.
    for (const key of ['counters', 'heap'] as const) {
      const values = result[key];
      let first = values.findIndex((x) => x.time >= start);
      if (first < 0) {
        first = values.length;
      }
      const selected = values
        .slice(Math.max(0, first - 1))
        .filter((x) => x.time <= end);
      if (key === 'counters') {
        selectedResult.counters = selected as Telemetry['counters'];
      } else {
        selectedResult.heap = selected as Telemetry['heap'];
      }
    }
    for (const key of ['context', 'overhead'] as const) {
      const values = result[key] ?? [];
      let first = values.findIndex((x) => x.time >= start);
      if (first < 0) {
        first = values.length;
      }
      const selected = values
        .slice(Math.max(0, first - 1))
        .filter((x) => x.time <= end);
      if (key === 'context') {
        selectedResult.context = selected as Telemetry['context'];
      } else {
        selectedResult.overhead = selected as Telemetry['overhead'];
      }
    }
    selectedResult.errors = result.errors?.filter(
      (e) => e.time >= start && e.time < end,
    );
    selectedResult.markers = result.markers.filter(
      (m) => m.time >= start && m.time <= end,
    );
    return selectedResult;
  }

  async earliest(limit = 500) {
    const rows: TraceEvent[] = [];
    for (const block of this.blocks
      .filter((b) => b.type === 2)
      .sort((a, b) => a.minimum - b.minimum)) {
      if (
        rows.length >= limit &&
        (block.minimum / this.frequency) * 1000 > rows.at(-1)!.start
      ) {
        break;
      }
      for await (const e of this.events(0, this.duration, 0, [block])) {
        rows.push(e);
      }
      rows.sort((a, b) => a.start - b.start || a.depth - b.depth);
      if (rows.length > limit) {
        rows.length = limit;
      }
    }
    return rows;
  }

  async viewportEvents(
    start: number,
    end: number,
    width: number,
    minimumUs = 0,
  ) {
    const columns = Math.max(100, Math.min(4096, Math.round(width)));
    const span = Math.max(0.000001, end - start);
    const buckets = new Map<string, TraceEvent>();
    const consider = (
      event: () => TraceEvent,
      _metric: number,
      ticks: number,
      duration: number,
      _self: number,
      thread: number,
      depth: number,
    ) => {
      if ((duration / this.frequency) * 1e6 < minimumUs) {
        return;
      }
      const pixel = Math.max(
        0,
        Math.min(
          columns - 1,
          Math.floor(
            (((ticks / this.frequency) * 1000 - start) / span) * columns,
          ),
        ),
      );
      const key = `${thread}:${depth}:${pixel}`;
      const old = buckets.get(key);
      if (!old || (duration / this.frequency) * 1000 > old.duration) {
        buckets.set(key, event());
      }
      if (buckets.size > overviewLimit) {
        throw Error('Visible range has too many thread/depth tracks. Zoom in.');
      }
    };
    const overview = this.analysis?.overview;
    if (
      overview &&
      start === 0 &&
      end === this.duration &&
      columns === overview.columns
    ) {
      return overview.events.filter((e) => e.duration * 1000 >= minimumUs);
    }
    // Use cached LOD only for the whole session. Zoomed ranges retain native resolution.
    if (
      overview &&
      start === 0 &&
      end === this.duration &&
      columns < overview.columns
    ) {
      for (const e of overview.events) {
        consider(
          () => e,
          e.metric,
          (e.start * this.frequency) / 1000,
          (e.duration * this.frequency) / 1000,
          (e.self * this.frequency) / 1000,
          e.thread,
          e.depth,
        );
      }
    } else {
      await this.visitEvents(
        start,
        end,
        consider,
        Math.max(
          ((span / columns) * this.frequency) / 1000,
          (minimumUs / 1e6) * this.frequency,
        ),
      );
    }
    return [...buckets.values()].sort(
      (a, b) => a.start - b.start || a.depth - b.depth,
    );
  }

  async viewport(start: number, end: number, width: number, minimumUs = 0) {
    const events = await this.viewportEvents(start, end, width, minimumUs);
    const packed = new Float64Array(events.length * 10);
    const indices = new Map<string, number[]>();
    const laneInfo = new Map<string, { thread: number; depth: number }>();
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      packed.set(
        [
          e.metric,
          e.start,
          e.duration,
          e.self,
          e.depth,
          e.thread,
          +e.error,
          e.index!,
          e.span!,
          e.parent!,
        ],
        i * 10,
      );
      const key = `${e.thread}:${e.depth}`;
      if (!indices.has(key)) {
        indices.set(key, []);
        laneInfo.set(key, { thread: e.thread, depth: e.depth });
      }
      indices.get(key)!.push(i);
    }
    const lanes: Lane[] = [...indices]
      .map(([key, ids]) => ({
        key,
        ...laneInfo.get(key)!,
        indices: Uint32Array.from(ids),
      }))
      .sort((a, b) => a.thread - b.thread || a.depth - b.depth);
    return { packed, lanes, stride: 10, visibleCount: events.length };
  }
}
