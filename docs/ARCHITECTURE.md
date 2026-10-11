# Architecture

Isaac Doctor has three runtime boundaries: native instrumentation inside the x86 game, an external x64 collector, and browser-based analysis. A loopback controller connects the UI to the injector.

## Recording

- `src/profiler.cpp` instruments Lua callback closures, tracks inclusive/self time and maintains aggregate counters. `src/bootstrap.lua` integrates callback registration and lifecycle observers; callback timers run natively.
- `src/injector.cpp` attaches to an already running game and sends commands through the shared control protocol in `src/control.hpp`. It does not start the game.
- `src/stream.hpp` defines the bounded transport. `src/collector.cpp`, built separately through `collector/CMakeLists.txt`, writes the binary chunks and final index outside the x86 process.
- `src/screenshots.cpp` captures and encodes filmstrip thumbnails. Process counters, room context, lifecycle markers and capture configuration use separate binary channels.

The DLL, injector and collector must stay together. The DLL remains loaded until the game exits; replacing files does not replace an already loaded version.

## Local controller

`tools/viewer-server.py` serves the built UI and accepts authenticated recording commands on loopback. The portable release bundles it with a Python runtime. `tools/release-launcher.py` provides the visible EXE window; its monitored controller stops recording and exits when that owner closes. Static UI responses bypass browser cache to avoid mixing assets between releases served at the same local URL. Source development uses `viewer/scripts/dev.mts` to manage Vite and controller lifetime. Game launch remains the user's responsibility through REPENTOGONLauncher.

## Analysis

The browser reads local files through file inputs or permissioned file handles. `viewer/src/stream.ts` performs indexed range reads; `trace.worker.ts` runs analysis outside the UI thread. Prepared analysis can be appended to the same recording, while raw events remain available for selected-range inspection.

`analysis.ts`, `frames.ts` and `diagnosis.ts` provide the shared analysis implementation. The headless CLI in `viewer/scripts/analyze.mts` uses that implementation with positioned disk reads from `capture-file.mts`. Recordings are binary; CLI JSON is query output.

The React UI is rooted in `App.tsx`. `Timeline.tsx` coordinates graph panes and their shared range. `useGraphNavigation.ts` handles common navigation; `SortableHeader.tsx` supplies shared table sorting. Source context reads local Lua files without executing or uploading them.

See [streaming format](STREAMING.md), [legacy metadata format](FORMAT.md) and [CLI reference](CLI.md). Controlled test hosts and fixtures live under `tests`; generated binaries and captures belong under the ignored `build` directory.
