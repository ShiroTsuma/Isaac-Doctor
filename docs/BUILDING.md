# Building and testing Isaac Doctor

[Back to the project README](../README.md)

Run the commands below from the repository root. For a ready-to-run download, use the [portable release](https://github.com/ShiroTsuma/Isaac-Doctor/releases).

## Requirements

- **Windows 64-bit**, with **The Binding of Isaac: Repentance+** and **REPENTOGON**. The game-facing DLL and injector are x86; the collector runs as x64.
- **Visual Studio 2022 C++ tools**, including x86/x64 targets, Windows SDK and CMake.
- **Node.js 26 x64** and **pnpm**. The package manifest pins the package manager version.
- **Python 3** for the local recording controller. Offline CLI analysis does not need Python.
- **Chrome or Edge** for persistent folder access and saving prepared analysis into the original recording.

## Build

From the repository root:

```powershell
.\build.ps1
pnpm --dir viewer install --frozen-lockfile
pnpm --dir viewer build
```

The native build produces these files in `build/Release`:

| File | Purpose |
| --- | --- |
| `isaacprof.dll` | Native callback instrumentation inside the game |
| `isaacprof-injector.exe` | Attach, status, record, stop and callback catalog commands |
| `isaacprof-collector.exe` | x64 process that writes the binary recording |
| `isaacprof-analyze.exe` | Small native aggregate-report reader |

Keep the DLL and collector together in this output directory. The injector loads the DLL from there. CMake fetches pinned MinHook and REPENTOGON Lua dependencies on the first build.

## Open the built viewer

With Isaac already running through REPENTOGONLauncher:

```powershell
.\open-profiler.ps1
```

Connect the game and select `build/Release/captures` as the captures folder. The profiler attaches to the running game; it does not launch it.

## Development

```powershell
pnpm --dir viewer dev
```

This starts Vite with its managed local Python controller. Ending that Vite process stops/finalizes active recording and closes its controller. `.\open-profiler.ps1` starts a separate built viewer; use **Stop local server** to stop recording and close that controller. In development this leaves Vite serving the analysis UI; it does not close Vite.

`pnpm --dir viewer build` checks Prettier formatting for all TypeScript, TSX and MTS files, then runs strict TypeScript checks and ESLint with zero warnings before building. Run `pnpm --dir viewer format` to format the sources, or `pnpm --dir viewer format:check` to check without writing. Prettier has an exact pinned version so editor and CI formatting agree. Native targets use compiler warnings as errors.

Source formatting uses an 80-column target and two-space indentation. ESLint also requires braces around control flow, one variable per declaration, and blank lines between function declarations and class methods. These rules keep the code readable beyond the line wrapping that Prettier handles. Use `pnpm --dir viewer exec eslint . --fix` followed by `pnpm --dir viewer format` to apply both sets of rules.

Controlled capture tests use owned Lua host processes rather than launching Isaac:

```powershell
.\build.ps1 -BuildDirectory build/stream-dev
python tests/capture-triggers.py
python tests/stream-smoke.py
python tests/controller-server.py
node --experimental-strip-types --test tests/diagnosis.test.cjs tests/cli.test.cjs tests/debugging.test.cjs tests/frames.test.cjs tests/worker-client.test.cjs tests/recording-files.test.cjs
```

Browser regression scripts in `tests/` exercise graph navigation, sorting, folder refresh and recording lifecycle against the built local viewer. See [streaming format](STREAMING.md), [binary format](FORMAT.md) and [project roadmap](ROADMAP.md) for implementation details.

### Creating a release

```powershell
.\package-release.ps1
```

This builds the native targets and viewer, bundles a Python runtime into `IsaacDoctor.exe`, and writes `releases/IsaacDoctor-VERSION-windows-x64.zip` and its `.zip.sha256` checksum directly into `releases/`. Temporary packaging files are removed automatically. An existing version is never overwritten; bump the version before packaging another release. `-SkipBuild` packages existing outputs. Upload the ZIP and checksum as GitHub Release assets; do not commit release outputs. The package includes dependency notices and excludes test hosts, game binaries, mods and private captures. Test the extracted archive with `python tests/release-smoke.py PATH_TO_ZIP` after generating the controlled host in `build/stream-dev`. This checks startup without external runtimes, local UI serving, recording and shutdown against the owned host; game compatibility still needs a launcher-based real-game session.

