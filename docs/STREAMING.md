# Binary streaming format v3

Little-endian, uncompressed. Header: magic ISAACPRF (8 bytes), u32 version=3, u32 header length=40, u32 PID, u32 flags (bit 1 timeline), u64 QPC frequency, u64 absolute capture start QPC. Raw times are integer ticks relative to that start.

Each chunk has a 48-byte header: u32 CHNK magic=0x4b4e4843, u16 type, u16 version=1, u32 payload bytes, u32 record count, u64 sequence, u64 minimum start ticks, u64 maximum end ticks, u32 payload CRC32, u32 flags=0.

| Type | Payload |
|---|---|
| 1 metadata | Embedded complete v2 representation with zero events/images; the latest snapshot replaces preceding aggregate totals |
| 2 callbacks | u64 sum of self ticks, then count × 64-byte records |
| 3 screenshot | f64 time_ns, u16 width/height, u32 encoding=1, u32 PNG length, PNG bytes |
| 4 loss | u64 lost record delta, u64 first lost start, u64 last lost end; bounds enclose losses and do not imply a continuous gap |
| 5 index | count × 40-byte entries |
| 6 preview | Same record shape as type 2; at most 16 duration representatives per thread/depth per batch; raw records remain authoritative |
| 7 observation intervals | count × 32 bytes: u64 interval ID, u64 start ticks, u64 duration ticks, u32 kind (1 update, 2 render), u32 thread |

Callback record: u32 metric ID, u32 thread, u16 depth, u16 flags (bit 0 error), u32 parent metric, u64 span ID, u64 parent span ID, u64 start ticks, u64 duration ticks, u64 self ticks, u64 reserved frame ID=0. Interval identity is (kind, thread, ID). Filtered / lost parents need not be present.

Index entry: u64 chunk offset, u64 minimum, u64 maximum, u32 count, u16 type/version, u32 payload bytes, u32 CRC. Footer: ASCII IPEND003 (8), u64 index chunk offset, u32 index payload length, u32 reserved=0, u64 next sequence (32 total bytes). Completeness requires both the latest metadata's complete flag and a valid final footer/index.

Unknown optional chunk types can be skipped. Known chunks require supported versions, bounds and CRC validation. A truncated tail can be discarded, preserving complete preceding chunks. The collector flushes the stream every second; this is not a guarantee against power-loss storage caches. Periodic metadata is a full aggregate snapshot, not incremental string dictionaries.

The DLL publishes without waiting for disk to a bounded shared-memory ring. The x64 collector drains that ring into append-only chunks. The pending ring limit is not a total recording limit. A failed collector stops capture; a busy/full producer ring reports losses instead of blocking game callbacks. Index growth is proportional to the number of chunks.

Viewer: File.slice() in separate timeline and analysis Workers, a 64 MiB LRU payload cache per Worker (at most 2 MiB per entry), index/chunk validation limit 64 MiB, previews for wide timeline ranges, exact retained raw calls for rankings. Frame summaries use 32,768 histogram bins, return at most 500 slowest intervals and cap breakdowns at 200,000 metric entries. Their percentile upper bounds have at most 0.1% relative error for representable positive QPC intervals.

See [embedded metadata layout](FORMAT.md) and [architecture](ARCHITECTURE.md).

## Prepared analysis appendix, versions 1 and 2

New recordings also carry optional raw channels (all chunk versions=1):

| Type | Layout |
|---|---|
| 8 OS counters | count × 72 bytes: u64 ticks, working set bytes, private commit bytes, page fault count, process user/kernel CPU ticks, Lua-thread user/kernel CPU ticks; u32 thread ID, validity mask (1 memory, 2 process CPU, 4 thread CPU) |
| 9 Lua heap | count × 16 bytes: u64 ticks, bytes used by Lua VM |
| 10 lifecycle | count × 48 bytes: u64 ticks/run ordinal/room transition ordinal/level transition ordinal; u32 kind/flags; u64 reserved=0 |
| 11 environment | u32 interval_ms=250; length-prefixed UTF-8 game file version, window title, Lua module path; u32 source count (max 300); each row: UTF-8 mod/source/resolved path/SHA-256, u32 hash status |

CPU counters retain cumulative OS values in 100 ns units, not percentages. CPU 100% in the viewer means one logical core. Invalid counters are indicated by the validity mask; counter resets and thread identity changes break delta calculations. The control worker samples OS counters every 250 ms. Lua heap is read on the Lua thread at most every 250 ms via LUA_GCCOUNT/GCCOUNTB, without forcing GC. Missing main-thread observations leave sample gaps. Heap is VM-wide, not attributed to mods.

Additional diagnostic chunks use the same v3 container:

| Type | Layout |
|---|---|
| 12 room context | 72 bytes: u64 ticks; i32 room ID/stage/stage type/room type; u32 width/height/grid slots/grids/entities/enemies/tears/projectiles/effects/pickups/valid/reserved |
| 13 instrumentation counters | 64 bytes: u64 ticks/entered calls/sampled wrappers/wrapper overhead ticks/observer ticks/auxiliary dropped/context failures/errors omitted |
| 14 Lua error | u64 ticks; u32 metric/thread; u64 span; length-prefixed UTF-8 message and traceback |

Context is observed on the Lua thread at most every 250 ms. Static room description is refreshed at capture/room/stage transitions; entity/grid counts are refreshed each sample. Valid context currently has mask 7. Failed protected API reads increment context failures instead of fabricating a zero population.

One in 1024 entered wrappers measures entry and exit observation work around the mod call; sampled ticks exclude the mod body. The viewer estimates total wrapper cost from sample/call deltas and separately reports measured observer work. This does not measure total collector/I/O/screenshot overhead and does not replace an external A/B benchmark. Lua errors preserve the original error object and retain message/traceback with bounded lengths (4096/16384 bytes), at most 1000 per capture; truncation and queue loss are counted. Old recordings cannot reconstruct missing context or error messages from callback flags.

Lifecycle kinds: 1 initial observed capture context, 2 run started/continued, 3 new room, 4 new level, 5 run ended, 6 exit run. Flags: bit 0 continued run, bit 1 currently in run, bit 2 observed run-start identity. State is tracked while attached even outside recording. Ordinals count events observed since attachment; they are not seed, room ID or stage number. Attaching midway leaves initial identity unknown. An after-load capture may start after the run-start event, so its initial context carries the observed state instead.

Environment snapshots list instrumented mod/source pairs, including callbacks that do not run in the selected capture. Source hashes are bounded disk snapshots at capture start (4 MiB per file, 64 MiB total), not proof that an already loaded Lua function has identical source. Relative sources resolve against the game executable directory; unresolved/dynamic paths are explicit. Hash status: 0 unresolved, 1 success, 2 size budget, 3 read/hash failure. The window title preserves game/REPENTOGON build information where the game exposes it. This is not a complete list of mods with no registered callbacks. Telemetry arrays are capped at 100,000 records and cached once outside game memory; later range views retain one preceding counter baseline.

Completed captures may carry derived binary data after their native IPEND003 footer. Raw chunks and their index remain unchanged; native readers ignore the appendix. The viewer computes it once in a Worker, then reuses it on reopening. Invalid, incomplete or outdated derived data is discarded and rebuilt from raw records.

Header (32 bytes): ASCII IPAC0001, u32 schema=1, u32 algorithm=1 or 2, u64 native capture size (including native footer), u32 native index CRC, u32 payload size. Trailer (32 bytes): ASCII IPACEND1, u64 native capture size, u32 payload size, u32 payload CRC32, u32 algorithm=1 or 2, u32 schema=1. Maximum payload: 32 MiB.

Payload: f64 duration_ms, u32 quarter count=4, u32 overview bin count=400, u32 summary count=14, u32 reserved=0; then 400 f64 overview values. Four quarter leaves retain per-metric calls/errors/inclusive/self/maximum and separate render/update interval count, total, maximum and sparse histograms. Fourteen ready summaries cover session, halves and quarters for each clock. Summary records are 72 bytes: u32 left/right quarter boundary, u32 clock, u32 reserved, u64 count, six f64 values (mean_ms, rate, maximum_ms, p50_ms, p95_ms, p99_ms). Each quarter starts with u32 metric count, then 48-byte records (u32 ID/reserved, u64 calls/errors, f64 inclusive/self/maximum_ms), then two interval leaves (u64 count, f64 total/maximum_ms, u32 populated bins; each populated bin is u32 index + u64 count). Histogram algorithm matches the frame statistics described above.

Quarter membership follows record start time; boundary-crossing calls retain their full duration. Range rankings combine fully covered quarter leaves and scan only edge ranges. Arbitrary ranges, raw timeline, event details and call tree remain available. Session callback totals still use native unfiltered aggregates; cached quarter rankings represent retained events. Rates use merged count/total and percentiles use merged histograms, never averages of subgroup rates or percentiles.

Open-file and captures-directory handles request read/write permission so the browser can save this appendix locally using an atomic writable stream. File-input snapshots initially have no writable handle: Save prepared analysis in recording asks the user to select the original file and grant write access, validates recording identity, then updates that file. Browsers without writable handles retain the download fallback. Saving may copy the underlying file through the browser's temporary-file mechanism; it is not a zero-copy disk update. Sources continue to require read access only.

### Large recording navigation

A balanced interval index uses sorted starts and subtree maximum ends to locate intersecting callback/frame blocks, including long calls crossing the left boundary. Neighboring payload reads coalesce across gaps up to 8 KiB, into ranges at most 2 MiB, with six reads in flight. Each extracted payload still receives CRC validation. Numeric QPC decoding avoids per-field BigInt allocations; viewport and range ranking process records synchronously within blocks, yielding between batches. New view queries supersede older queued/running view queries; loading another recording invalidates pending queries. Timeline work has an independent Worker and therefore does not queue behind frame attribution/export.


### Shared headless analysis

The Worker and CLI import viewer/src/analysis.ts for rank/grouping, events, tree, frames and cadence summary. CLI runs in Node x64 with one read-only positioned file descriptor; it can skip image decoding and overview reads during load. Full capture validation is an explicit verify operation. JSONL serve sessions keep the 64 MiB payload cache and most recent range aggregates, with sequential requests and no network server. CLI.md specifies limits and units. Selected-frame attribution uses the union of chosen interval ranges, a deduplicated interval-index block set, and synchronous decoding; it no longer scans the entire time envelope spanning sparse slow frames.

### Version 2 contiguous overview and progress

The envelope schema and magic stay unchanged; algorithm version is 2. The payload retains the v1 statistics layout, then adds u32 overview columns (0 or 4096), u32 representative count (maximum 200000), followed by ten little-endian f64 fields per 80-byte record: metric ID, start ms, duration ms, self ms, depth, thread ID, error flag, call/span ID, parent span ID, parent metric ID. IDs must be safe integers, timing fields finite/nonnegative, metric IDs known, self <= duration, depth <= 1024, and event end within capture duration. Columns 0/count 0 means no overview. Payload CRC, native index CRC and original native size remain authoritative envelope checks. Readers accept both versions; malformed derived data is discarded without invalidating the sealed native recording.

The overview is a bounded visual LOD with the longest candidate per thread/depth/4096-column bucket, not an exact event channel. Whole-session viewports at up to 4096 columns use it; narrower windows always query native indexed blocks. Rebinning a cached grid can change representatives compared with the older direct per-width selection. All analysis/ranking/event/ancestry/frame computations use retained raw data or validated aggregate tiles, never this preview.

CLI `prepare FILE --write` builds or upgrades the appendix in place. CLI queries and JSONL serve stay read-only; prepare is excluded from serve. New preparation builds bins and overview in the same raw analysis pass; v1 upgrade reuses its statistics and reads native LOD candidates. Repeated prepare skips a current appendix. Changed files are rejected and write failures attempt appendix rollback. Browser writable streams retain their existing atomic close behavior. Do not prepare a recording still being written by another process.

The tested 1.19 GB QA copy has 11,270 representatives, a 1,631,412-byte appendix and a 7 ms first full-session viewport in Chrome (previous cold scattered preview ~4.1 s). Source native prefix was verified identical by SHA-256. Progress messages carry stage/completed/total/percent, are throttled to about 250 ms, and have request IDs so stale messages cannot update a newer browser request. CLI prints one terminal stderr line; `--non-interactive` suppresses it, and serve/non-TTY output is quiet.

## Capture configuration (type 15, chunk version 1)

One mandatory configuration packet records the requested measurement scope and trigger rules. Layout version 2 is u32 layout_version=2, u32 channel_mask, u32 start_trigger, u32 stop_trigger, u32 start_delay_ms, u32 stop_delay_ms, u32 max_duration_ms, followed by two lists (mods, hooks). Maximum duration 0 disables the independent limit; a positive value caps collection time, excluding start delay and ignoring stop delay. Manual mode stores stop delay 0. Readers also accept layout version 1, which omits max_duration_ms and implies no independent limit. Each list is u32 count followed by count length-prefixed UTF-8 strings. Each scope has at most 128 exact names and occupies fewer than 4096 UTF-8 bytes in the control channel. Empty lists mean all; nonempty mod and hook lists intersect. Hook matches accept registered names or numeric IDs.

Channel bits: 1 callback aggregates, 2 callback timeline, 4 render intervals, 8 update intervals, 16 process counters, 32 Lua heap, 64 room/entity context, 128 lifecycle markers, 256 overhead, 512 structured Lua errors, 1024 source/environment inventory, 2048 presentation, 4096 native waits, 8192 instruction snapshots. Default mask is 8191 (instruction sampling OFF); all-channel mask is 16383. Timeline/errors require callback timings. Screenshots retain their separate capture option and screenshot metadata. Frame observation and capture triggers do not depend on callback timing/timeline channels.

Excluded callbacks take the forwarding path without timing, protected measurement calls, metric stack entries or emitted events. They do not count as dropped or duration-filtered events. Work in an excluded child remains in a measured parent's self time. Capture settings describe the requested scope; actual availability and observed records are separate. Readers lacking this optional block can skip it. Current readers expose its settings through the loaded document and CLI info/report/diagnose.

Start/stop trigger IDs: 0 immediate, 1 run-load, 2 room-entry, 3 level-entry, 4 projectile, 5 tear, 6 effect, 7 NPC, 8 damage, 9 run-end, 10 game-exit, 11 duration, 12 manual. Start accepts 0..10; stop accepts 1..12. Delays are 0..3600000 ms, latched on the first matching event. A matching activation event cannot also request automatic stop; another occurrence is required. Control polling adds scheduling tolerance to delay boundaries. Manual stop ignores the automatic stop delay. Cancelling while armed creates no recording.

## Presentation intervals (type 16, chunk version 1)

An optional indexed batch contains 1..2048 records of 80 bytes each. In order: nine u64 fields (start, duration, interval ID, swap start, swap duration, screenshot-hook start, screenshot-hook duration, interval thread CPU cycles, swap thread CPU cycles), then u32 thread ID and u32 flags. All wall timestamps and durations use the recording's QPC ticks. Flags are 1 for valid interval cycles, 2 for valid swap cycles, and 4 for successful SwapBuffers. CPU cycles remain raw counts, never milliseconds.

Each interval runs from the previous SwapBuffers return to the current return on the same thread and GL context. The first swap establishes a baseline; session changes reset IDs and context changes reset that baseline. The channel works without callbacks, Lua frame markers or screenshots. The screenshot-hook span includes its checks and any readback. The remaining wall duration is not an exclusive CPU/GPU breakdown. Queries use the block time index, and statistics exclude intervals crossing the selected range boundaries.

## Native waits (type 17, chunk version 1)

An optional indexed batch contains 1..4096 records of 40 bytes: u64 recording-relative QPC start, duration and caller address, then u32 requested timeout in milliseconds, thread ID, API kind and return value. Kinds 1..6 are Sleep, SleepEx, WaitForSingleObject, WaitForSingleObjectEx, WaitForMultipleObjects and WaitForMultipleObjectsEx. Sleep has a synthetic return value of zero. Infinite timeout is DWORD 0xffffffff. The batch index covers the earliest start through latest end.

Only registered Lua/render threads are observed. Nested forwarding calls are suppressed. A fixed-size buffer uses a nonblocking producer lock; contention and overflow increment auxiliary dropped records. Capture-generation changes and stopping exclude unfinished calls. API results and last-error state are preserved; object handles and alertable flags are not recorded. These are API wall spans, including scheduling latency, not exclusive CPU time. They can overlap callback and presentation spans. Range queries include intersecting waits and clip aggregate wall durations, retaining full durations for longest-call rows and peaks.

## Rendering state (type 18, chunk version 1)

One variable-length record begins with u64 recording-relative QPC time, u32 thread ID, u32 client width/height, four i32 viewport coordinates/dimensions, i32 swap interval, u32 flags and u32 installed wait-hook mask. The fixed prefix is 48 bytes. Three u32-length-prefixed UTF-8 strings follow: GL_VENDOR, GL_RENDERER, GL_VERSION, each at most 1024 bytes. Flags: 1 valid client size, 2 swap interval available. Hook bits 1,2,4,8,16,32 correspond to kinds 1..6. This record belongs to the presentation channel. State is checked at most twice a second on the rendering thread and emitted initially or when changed. No GPU timer or screen-presentation timestamp is collected.

## Native caller modules (type 19, chunk version 1)

One record contains u64 image base, u64 image size and a u32-length-prefixed UTF-8 path (up to 32768 bytes). The current x86 producer constrains image addresses to the 32-bit address space. Module discovery runs on the recorder worker for observed wait callers, sampled instruction addresses and frame-pointer return candidates, with a maximum of 2000 distinct image bases per capture. A zero time index denotes session metadata. Readers resolve addresses to module filename plus relative offset; these are not function symbols. Raw addresses are session-specific and offsets need the matching binary to interpret.

## Instruction snapshots (type 20, chunk version 1)

An optional indexed batch contains 1..1024 records of 64 bytes: four u64 values (recording-relative QPC timestamp, instruction address, cumulative thread CPU cycles, measured pause duration), four u32 values (thread ID, flags, return candidate count, reserved zero), then four u32 frame-pointer return candidates. Flags: 1 valid cycles, 2 observed Lua thread, 4 observed rendering thread. Candidate count is 0..4; unused slots are zero. The index ends one QPC tick after the final timestamp. Addresses are x86; module records resolve instruction and candidate addresses.

This channel is OFF by default and independent of callback/presentation/wait channels. The profiler worker briefly suspends only registered threads, reads their control context and bounded frame-pointer chain, then resumes them before allocating, locking, looking up modules or writing data. Already-suspended threads are skipped without changing their existing suspend count. Failure to resume disables sampling. Poll requests vary between 4, 7, 5, 9 and 6 ms; Windows scheduling and worker duties can make actual gaps considerably longer. No exact sampling frequency is promised.

Snapshots include sleeping threads and represent discrete wall-time occupancy, not exclusive CPU time, CPU utilization, GPU execution or full-stack unwinding. Frame-pointer candidates are partial and can be absent or inaccurate in frame-pointer-omitted code. The reader correlates sample times with same-thread covered wait spans in bounded 250 ms windows, without treating missing wait capture as evidence that a thread was running. Instruction locations are grouped into 64-byte RVA buckets. The reader also joins snapshots with same-thread SwapBuffers spans. Inside swap and covered-wait counts can overlap; outside both uses their union, never subtraction of overlapping totals. Missing presentation/wait channels remain unknown. None of these categories establishes GPU execution or that an unobserved thread was running. Narrow-range queries remain indexed.

## Sampling counters (type 21, chunk version 1)

One record is eight u64 values: recording-relative last successful snapshot timestamp, cumulative attempts, successes, failures, already-suspended skips, buffer omissions, total measured pause ticks and maximum measured pause ticks. These counters are session-wide; the viewer separately sums retained snapshot pauses in the selected range. Measured pause starts after SuspendThread returns and ends after ResumeThread returns. It excludes entering SuspendThread, module lookup, streaming, and all other profiler work; it is not a total overhead estimate. Counts and measured pause also include unsuccessful readbacks. Successes include omitted records. Both record types remain optional and do not alter existing chunk layouts.


## Lua instruction contexts (type 22, chunk version 1)

Each indexed 40-byte record contains u64 QPC timestamp, u32 thread, flags, wrapper depth, source ID, and four u32 wrapper metric IDs (innermost first). Flags: 1 validated internal main-state/CallInfo/CClosure layout, 2 bounded partial traversal or source dictionary budget reached, 4 context read failed, 8 source read failed. Unverified or failed contexts have zero depth and source ID. Depth is at most four; traversal is capped at 32 CallInfo nodes. Zero source ID means no resolved Lua source; it does not prove no Lua work. This optional channel accompanies instruction sampling and never enables callback timers.

Pinned internal layouts are cross-checked on the Lua thread against public API values, known wrapper closure/upvalues, and original function source/definition lines. If validation fails, the sampler retains native instruction snapshots without guessing a Lua owner. The worker reads POD snapshots with kernel memory APIs while the main-state thread is paused; no Lua API, allocation, logging or locking runs while it is paused. Serialization and dictionary lookup happen after resume. Only the main Lua state is traversed; unwrapped work and coroutine interiors may remain unattributed. Sampled owner metrics appear in the final metadata even when their timed call count is zero. Counts describe discrete occupancy, not CPU or GPU time.

## Lua sampled source dictionary (type 23, chunk version 1)

One record contains u32 source ID (1..5000), i32 nonnegative function definition line, u32 source byte length (1..1023), followed by UTF-8 source bytes. A zero time index denotes metadata. IDs are unique within the capture and reset on each recording. Sources identify the nearest readable main-state Lua function definition, not an instruction line; wrapper metadata can identify a different library file. Readers join context and instruction snapshots by exact thread/timestamp and do not infer ownership from neighboring samples. Missing source/owner metadata is explicitly counted for incomplete captures.
