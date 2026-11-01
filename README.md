<p align="center">
  <img src="viewer/public/isaac-doctor.png" width="128" height="128" alt="Isaac Doctor pixel art mascot">
</p>

<h1 align="center">Isaac Doctor</h1>

<p align="center">
  <strong>Find the mod callbacks behind slow frames.</strong><br>
  A local performance profiler for The Binding of Isaac: Repentance+ with REPENTOGON.
</p>

<p align="center">
  <a href="https://github.com/ShiroTsuma/Isaac-Doctor/releases/latest"><img src="https://img.shields.io/badge/Download-Windows_x64-8ab4f8?style=flat-square" alt="Download for Windows x64"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-98c379?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/Status-Under_development-e5c07b?style=flat-square" alt="Under development">
</p>

<p align="center">
  <a href="https://github.com/ShiroTsuma/Isaac-Doctor/releases/latest"><strong>Download ZIP</strong></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#explore-a-recording">Screenshots</a> ·
  <a href="#configure-your-capture">Capture scope</a> ·
  <a href="#a-real-fix-diepios-hud">A real fix</a> ·
  <a href="docs/MOD-PERFORMANCE.md">Mod performance guide</a> ·
  <a href="docs/README.md">Documentation</a>
</p>

![Real game recording with FPS percentiles, callback timeline, screenshot filmstrip and per-mod rankings](docs/images/performance-overview.png)

*A real 90-second recording. Add graphs with **+**, choose their channels, and inspect the same time range across the timeline and analysis views.*

Select a slow frame, expand **mod → hook → function**, and read the Lua source beside its timings. Isaac Doctor gives mod authors a Chrome DevTools-style performance workflow: a zoomable timeline, independent graphs, screenshot filmstrip and resizable analysis drawer.

| Find | Investigate |
| --- | --- |
| Expensive callbacks | Calls, self/inclusive time, mean/max duration and nested callback trees |
| Frame spikes | Render/update intervals, FPS/UPS, rolling percentiles and sortable slow-frame breakdowns |
| Room-dependent costs | Entity, effect and projectile counts, room context, run markers and screenshots |
| The code responsible | Local Lua fragments, line numbers and recorded file-hash comparison |
| Changes after a fix | Compare recordings by mod, hook or callback, including cost per call and call rate |
| Large traces | Binary streaming, indexed range reads, Web Workers and reusable analysis in the original file |

**Writing a mod?** Read [Finding and fixing slow mod callbacks](docs/MOD-PERFORMANCE.md) for common mistakes, Lua examples and a step-by-step UI investigation.

StageAPI's custom callbacks are measured under their owning mod and `StageAPI:HOOK_NAME`. Expanding the parent callback reveals these nested calls, so a costly StageAPI dispatch can be traced to the mod function it invokes. Existing callbacks and later registrations are covered; the mods-loaded notification also handles StageAPI loading after attachment.

## Quick start

**Requires:** Windows x64, Repentance+ with [REPENTOGON](https://github.com/TeamREPENTOGON/REPENTOGON), and Chrome or Edge. The portable package includes the runtime and native tools.

1. [**Download the Windows x64 ZIP**](https://github.com/ShiroTsuma/Isaac-Doctor/releases/latest). You can also browse [Releases](https://github.com/ShiroTsuma/Isaac-Doctor/releases/latest) for the checksum and release notes.
2. **Extract the entire ZIP** to a writable folder and double-click **IsaacDoctor.exe**. Keep its launcher window open; the profiler opens in your browser.
3. Start Isaac through **REPENTOGONLauncher**, using your usual Steam launch configuration, then click **Connect game**.
4. Choose **Connect captures folder** and select the extracted package's `bin/captures` folder. This lets the viewer refresh and open completed recordings automatically.
5. Choose your recording conditions, click **Record**, and reproduce the slowdown. The default collects 25 seconds after a loaded-run update.

Capture preferences are saved automatically to **`isaac-doctor.settings.json` beside `IsaacDoctor.exe`**: channels, mod/hook filters, start/stop conditions, delays, duration, screenshots and the capture duration threshold. They return on the next launch, independently of browser storage. Keep this file when replacing the portable application folder. Invalid files are reported and left unchanged. Browser directory permissions remain managed by the browser.

No Python, Node.js, Visual Studio or build step is needed for the portable release. To build the project yourself, follow [Building and testing](docs/BUILDING.md).

> [!IMPORTANT]
> Start the game through **REPENTOGONLauncher**. Keep your existing launcher configuration for save compatibility. The profiler attaches to the running game and does not launch Isaac.

You can also open or drag in a `.isaacprof` recording. **Connect captures folder** remembers a live handle; your browser may ask you to grant access again after restarting. File-input and folder-input selections provide a snapshot of the chosen files.

<details>
<summary><strong>Stopping, restarting and updating</strong></summary>

**Stop local server**, closing the launcher window, or pressing Ctrl+C stops an active recording and closes the controller. Loaded analysis remains available in the browser, with game controls disabled. Double-click **IsaacDoctor.exe** again and use the newly opened page, or reload the previous tab once the launcher is running.

Closing the browser tab alone leaves the controller running. The game stays open, and the injected DLL stays loaded until the game exits. Restart through the game launcher before switching profiler versions. Recordings can be large, so leave free disk space in the extracted folder.

</details>

## Explore a recording

Select a slow frame, follow its callback tree, and open the recorded Lua source. Compare the same time range across FPS/UPS, entity counts, screenshots and per-mod costs.

![Callback timeline and per-hook costs](docs/images/callback-detail.png)

Capture channels and mod/hook filters let you control the measurement scope. Optional native samples and wait-call measurements help investigate time outside instrumented callbacks; they are not GPU measurements.

See the [recording and analysis guide](docs/USER-GUIDE.md) for capture conditions, channel settings, presentation diagnostics and navigation.

## A real fix: Diepio's HUD

In our recordings, Diepio performed HUD work on each render. We expanded **Bottom-up → Mods → Diepio**, followed three expensive render callbacks, and opened their local Lua source in **Summary → Source context**.

![Diepio render callback with timing summary and its local Lua source](docs/images/diepio-source.png)

The HUD paths recreated fonts and repeated asset loading during renders. We cached three font instances and a reusable HUD sprite, preserving their drawing conditions. After restarting through the launcher, we recorded again and compared mean self time per call.

| Callback | Before | After |
| --- | ---: | ---: |
| `onRenderdrop` | 0.1888 ms | 0.0240 ms |
| `onRenderdropagain` | 0.0897 ms | 0.0003 ms |
| `RenderHeadcount` | 0.1985 ms | 0.0063 ms |
| **Combined mean self time per call** | **0.4770 ms** | **0.0306 ms** |

These callbacks used about **94% less measured self time**. The captures came from different runs, so this is an observed function-level improvement rather than a controlled FPS benchmark. Whole-session mean FPS remained near 58; other callbacks and engine work still matter.

Try the same workflow on your mod: connect its source folder, inspect the callback, then record again after the change. The [mod performance guide](docs/MOD-PERFORMANCE.md) covers resource caching, early guards, room scans, allocation pressure and how to verify a fix.

## Headless analysis

The CLI shares the viewer's TypeScript analysis code. Query recordings from disk without opening the browser or running the game. The full CLI requires the source checkout and Node.js; the portable package includes an aggregate-only native reader.

```powershell
.\isaacprof-cli.cmd --describe
.\isaacprof-cli.cmd list build/Release/captures --non-interactive
.\isaacprof-cli.cmd diagnose recording.isaacprof --top 10 --non-interactive
.\isaacprof-cli.cmd frames recording.isaacprof --clock render --top 10 --non-interactive
```

Use `serve` for persistent JSONL queries and shared caches. `prepare --write` stores reusable binary analysis in the original recording. `--non-interactive` suppresses progress output for automation. See the [CLI reference](docs/CLI.md) for commands, filters and source queries.

## Local by design

Your recordings and Lua sources stay on your machine. The browser reads files through local inputs or permissioned folder handles, and Web Workers process the capture bytes. A loopback controller handles game commands. The application does not upload recordings; a browser dialog labeled “Upload” still selects local files here.

The native DLL measures registered callbacks in C++ and streams events to an x64 collector. The collector writes indexed binary `.isaacprof` files. The viewer reads the blocks needed for a selected range and can save prepared analysis in the same file.

<details>
<summary><strong>Understand the measurements</strong></summary>

- **Inclusive time** includes nested instrumented callbacks; **self time** subtracts them. Both measure wall time, including native game APIs and waiting.
- **FPS/UPS** measure cadence between native render/update observations, rather than GPU time or display presentation. Duration p95/p99 describe slow intervals; FPS graphs use reciprocal rates and show the rolling sample population.
- **Scope affects attribution.** Excluded child work remains in the measured parent's self time. Coroutine callbacks are omitted because yield/resume wall time would misrepresent execution cost.
- **Context uses samples.** Room/entity counters need not match each frame exactly. Process memory and Lua-VM heap are not per-mod allocation measurements.
- **Coverage is explicit.** Duration-filtered calls stay in selected aggregates; timeline detail, dropped events, discarded calls and interrupted captures have separate coverage information.
- **Overhead measurements are partial.** Wrapper estimates and observer timings omit parts of collection, screenshots and timing-probe effects. Use independent cadence measurements and repeated matched A/B runs to estimate total impact.
- **Source hashes describe disk files at capture time.** A match does not prove the game loaded identical bytecode earlier.

If you share a recording, inspect its file paths, mod names, error stacks and screenshots first.

</details>

## Documentation and development

| Guide | Contents |
| --- | --- |
| [Recording and analysis](docs/USER-GUIDE.md) | Capture settings, timeline navigation and native diagnostics |
| [Mod performance guide](docs/MOD-PERFORMANCE.md) | Common slow paths, Lua examples, UI investigation and before/after checks |
| [Building and testing](docs/BUILDING.md) | Source setup, development server, checks and portable release packaging |
| [CLI reference](docs/CLI.md) | Commands, structured output, automation and investigation examples |
| [Function scopes](docs/FUNCTION-SCOPES.md) | Optional native measurements of helpers inside mod callbacks |
| [Architecture](docs/ARCHITECTURE.md) | Native instrumentation, collector, controller and viewer |
| [Streaming format](docs/STREAMING.md) | Binary blocks, index, integrity and prepared analysis |
| [Roadmap](docs/ROADMAP.md) | Planned work and measurement gaps |

Callback profiling works without modifying your mods. Authors can optionally
register [internal function scopes](docs/FUNCTION-SCOPES.md) to distinguish input,
layout, persistence and other work inside a callback. These deeper measurements
are opt-in; automatic discovery of internal functions is not currently available.

The project is under active development. Compatibility testing, matched A/B captures and deeper engine/GC attribution remain areas for improvement. When reporting a problem in [Issues](https://github.com/ShiroTsuma/Isaac-Doctor/issues), include the release version, game/REPENTOGON versions, selected capture scope and steps to reproduce it.

## Acknowledgements and license

Isaac Doctor targets [REPENTOGON](https://github.com/TeamREPENTOGON/REPENTOGON)'s game extension and Lua API and uses [MinHook](https://github.com/TsudaKageyu/minhook) for native hooking. The viewer workflow draws inspiration from Chrome DevTools Performance, [Perfetto](https://github.com/google/perfetto) and [speedscope](https://github.com/jlfwong/speedscope). [Mod Profiler](https://steamcommunity.com/sharedfiles/filedetails/?id=2505060515) provides an existing in-game workflow for Isaac modders and informed the feature baseline.

Project code uses the [MIT license](LICENSE); dependencies retain their licenses in [third-party notices](THIRD_PARTY_NOTICES.md). Game assets and third-party mods shown in examples belong to their authors. Isaac Doctor is an independent community project with no affiliation with the game's developers or the projects above.
