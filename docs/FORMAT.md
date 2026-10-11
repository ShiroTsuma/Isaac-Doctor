# Binary .isaacprof v1 / v2

Current captures use [streaming v3](STREAMING.md). This layout remains the embedded metadata payload of v3 and the layout of older captures.

Primary captures use binary serialization, not JSON. No compression. All numbers are little-endian; `f64` is IEEE-754 binary64. Time values are nanoseconds relative to capture start, derived from QPC. Strings are a `u32` byte length followed by UTF-8 bytes, without a terminator. No compiler struct padding is written.

## Header, in order

| Field | Type |
|---|---|
| Magic `ISAACPRF` | 8 ASCII bytes |
| Binary version = 1 or 2 | u32 |
| Flags: bit 0 complete, bit 1 timeline enabled | u32 |
| PID, Lua version (504) | 2 × u32 |
| Duration in ns | f64 |
| QPC frequency | u64 |
| Registered metrics, metric record count, event record count, event capacity | 4 × u32 |
| Dropped calls, skipped coroutine calls, host Lua entries, dropped timeline events, duration-filtered timeline events | 5 × u64 |
| Minimum event duration in ns | f64 |
| Profiler version, EXE path, Lua module path | 3 × string |

The fixed header is 104 bytes. Version 1 represents Windows x86 native callback wall time. Unknown versions are rejected. Readers bound record/string sizes and reject truncated blocks. There is no checksum in v1.

## Metric records

`metric count` records, in order:

| Field | Type |
|---|---|
| Metric ID | u32 |
| Original function source line | i32 |
| Call count, error count | 2 × u64 |
| Inclusive, exclusive, mean inclusive, max inclusive time in ns | 4 × f64 |
| Mod, callback ID, callback name, source path, original function identity | 5 × string |

Fixed numeric portion: 56 bytes. Names and paths are stored once per metric, never repeated in each event. IDs need not be contiguous in the file; inactive metrics have no record.

## Event records

`event count` records, sorted by start time and then depth. Each is **36 bytes**:

| Field | Type |
|---|---|
| Metric ID | u32 |
| Nesting depth | u16 |
| Flags: bit 0 callback error | u16 |
| Windows thread ID | u32 |
| Start, inclusive duration, exclusive duration in ns | 3 × f64 |

Version 1 ends after the event block. Version 2 appends the screenshot block below. Timeline can be disabled, capped or duration-filtered while aggregate metrics still include all measured calls. Filtered/capped events may have missing parents; depth remains original. Incomplete callbacks crossing capture stop are omitted. Coroutine execution is omitted.

## Screenshot block (v2 only)

The event block is followed by `u32 image count`, `u32 requested interval in ms` (0 disables screenshots), `u32 omitted images`, and `u64 measured screenshot-hook CPU time in ns`. At most 240 images are retained.

Each image has `f64 timestamp in ns`, `u16 width`, `u16 height`, `u32 encoding` (1 = PNG), `u32 byte length`, then the PNG bytes. Images are 320 × 180; readers bound dimensions, timestamps, payload sizes (1 MiB per image), and validate the PNG signature. Trailing bytes are rejected.

The native SwapBuffers hook downsizes the game framebuffer on the GPU, uses two pixel-pack buffers with nonblocking fence polling, and preserves the affected GL state. PNG encoding runs in the native worker. No desktop or browser image is captured. Unsupported contexts produce no images; screenshot omission counters and requested interval remain visible. Requested intervals range from 250 to 10000 ms. Screenshot-hook overhead does not represent all profiler overhead or GPU work.

## Implementations

- DLL writer: `src/profiler.cpp`, primitive I/O in `src/binary.hpp`.
- Native aggregate reader: `src/analyze.cpp`.
- Browser decoder and validation: `viewer/src/core.ts`.
- Test decoder: `tools/capture.py`.

Periodic snapshots copy completed records under the metric mutex, then sort and serialize on the worker thread outside that mutex. A temporary binary file is replaced atomically. Event storage is allocated once at capture start; no per-event heap allocation is added in callback execution.

Chrome Trace JSON is a separate, optional export generated in the viewer; timestamps/durations are converted to microseconds and emitted as `X` events. It is not the native capture format.
