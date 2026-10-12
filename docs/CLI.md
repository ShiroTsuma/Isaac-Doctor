# Headless analysis for developers and automation

`isaacprof-cli.cmd` reads the same binary captures and uses the same TypeScript analysis implementation as the browser Worker. It needs Node with native TypeScript stripping; tested with **Node 26.4.0 x64**. Neither Vite nor Python nor an open browser is needed. The original `build/Release/isaacprof-analyze.exe` remains an aggregate-only compatibility tool; it is not this headless interface.

From the repository root:

```powershell
.\isaacprof-cli.cmd --help
.\isaacprof-cli.cmd --describe
.\isaacprof-cli.cmd list build/Release/captures
.\isaacprof-cli.cmd report "build/Release/captures/recording.isaacprof" --top 5
```

Alternatively use `node viewer/scripts/analyze.mts ...`, or `pnpm --dir viewer analyze ...`. Paths with spaces must be quoted. Streaming v3 captures are supported; the viewer and old native analyzer continue to support legacy v1/v2.

## Working flow

1. **Discover:** `list FOLDER` returns paths, sizes and modification times; it does not decode or validate files. `info FILE` describes channels, metric/event counts, capture losses/filtering and cached analysis. It reads the index and requested metadata, not every event payload.
2. **Get a diagnostic snapshot:** `report FILE --top 5` includes FPS/UPS and percentiles, process/VM memory and CPU sample summaries, bounded environment/source identities, mod/hook/function rankings, callback errors, run markers and the slowest render intervals with retained callback attribution. It returns recommended range queries. No messages/stacks are inferred from error flags.
3. **Inspect a stall:** use `frames FILE --top 5` or a range query. Follow with `rank FILE --start-ms A --end-ms B --group mods`, then exact `--mod NAME`, `--hook NAME_OR_ID`, and `--group callbacks`. Session rankings without time flags use unfiltered native aggregates; explicit time flags use retained calls, including an explicitly selected full-duration range. Do not compare these populations without checking capture filtering/losses.
4. **Inspect individual calls:** `events FILE --start-ms A --end-ms B --sort duration --top 20`, optionally `--minimum-us 1000`, `--errors-only`, `--mod`, `--hook` or `--metric`. Sort fields are start/duration/self/depth/activity. The first 500 or fewer requested entries are selected from the complete matching population, not an arbitrary first page. Default order is chronological ascending; specifying a sort defaults to descending unless `--ascending` is supplied.
5. **Inspect ancestry:** `tree FILE --start-ms A --end-ms B --top 100 --depth 4`. Large traces require a selected range. Ancestors may have zero own cost when only their descendants match; tree costs describe own retained calls, not rolled-up descendant totals. Missing filtered/lost parents cannot be reconstructed.
6. **Inspect source:** `metrics FILE --mod Diepio --top 5` discovers IDs. `source FILE --metric 440 --mods "path\to\mods"` returns numbered Lua context, the function definition line and disk/capture SHA-256 comparison. A repository, one mod or the game directory can be used. Ambiguous suffix matches return candidates; explicitly choose one with `--source-file`. Source is read, never executed. The captured hash is a disk snapshot, not proof of identical already-loaded Lua code.
7. **See the game:** `screenshots FILE --start-ms A --end-ms B --top 100` lists image indices/times/dimensions. `screenshot FILE --index 136 --output build/cli-qa/frame-136.png` exports the original recorded PNG locally, for image inspection by a tool or a developer. Export never overwrites an existing file.
8. **Check integrity:** `verify FILE` checks every indexed native chunk header against the index and every native payload CRC. This deliberately reads the whole recording. It does not claim semantic validation of every event field or trust a damaged optional derived section.

The numbers above are illustrative examples. Discover paths, metric IDs and time ranges instead of assuming they survive future captures.

## Output and limits

JSON stdout is the default. Each successful query has `schema: isaacprof-cli/v1`, `ok`, `command`, a capture identity where applicable, `range_ms`, units, `result`, and `diagnostics`. Absent frame markers produce `available:false` and null rate/timings rather than a measured 0 FPS. Failure is structured JSON on stderr with a nonzero exit code. `--format table` prints bounded tabular rows, or formatted JSON for non-tabular results. JSON output is an interchange format for commands; **the recording stays binary**.

Timing fields are milliseconds; native cumulative CPU fields are 100 ns; memory fields are bytes; `--minimum-us 1000` means 1 ms. `rate` in render/update summaries means FPS/UPS respectively. FPS is cadence between native callback boundary observations, not GPU presentation timing.

`--top` limits root rows (1–500). Group/tree expansion defaults to depth 2 and five children per node; `children_count` and `truncated` expose omitted descendants. `--depth` and `--children` control expansion, with a total output ceiling of 1,000 ranking/tree nodes. Report rankings are collapsed and source identities are limited to `--top`. Query a particular mod/hook for more detail. Telemetry returns at most `--samples` rows (1–1000), while its summary uses all recorded samples in the selection plus one preceding baseline. Memory peaks are sample maxima; CPU 100% means one logical core. Observed run/room/level values are transition ordinals, not actual game IDs.

Frames selects the requested number of **slowest** intervals (up to 500), then sorts and filters that set. `--sort start` sorts that selected slow set, not every frame chronologically. Statistics still cover every matching clock interval in the time range, independent of the minimum/list/search. Attribution charges full retained self time to the interval in which a callback starts; a boundary-crossing call can therefore make charged time exceed interval duration. `--summary-only` skips attribution; unavailable costs are null. Frame callback identities contain no session totals; `metric_self_ms` is the selected interval cost.

Analysis queries open captures read-only. No game attach/record/start/stop occurs and no network requests are made. `screenshot --output` creates a new PNG; explicit `prepare FILE --write` updates only the optional analysis appendix in that recording. `--max-read-mib N` imposes an optional byte-read budget, including initial load. Fast `info` does not establish whole-file integrity; use `verify`. If the capture changes while being read, the command fails rather than presenting a mixed snapshot. Incomplete capture recovery is available but can require scanning/validating complete preceding blocks.

## Persistent stdio session

```powershell
.\isaacprof-cli.cmd serve "build/Release/captures/recording.isaacprof"
```

The first stdout line is a `type: ready` response. Send one JSON object per input line:

```json
{"id":1,"command":"rank","args":["--start-ms","69000","--end-ms","70500","--group","mods","--top","5"]}
{"id":2,"command":"rank","args":["--start-ms","69000","--end-ms","70500","--group","hooks","--top","5"]}
{"id":3,"command":"events","args":["--start-ms","69000","--end-ms","70500","--errors-only"]}
```

Responses are JSONL, echo `id`, and include the same capture identity and diagnostics. A malformed request returns `ok:false` without killing the session. The session keeps its parsed index, 64 MiB payload LRU, telemetry, and the most recently aggregated range in memory. It does not persist a database or change the capture. It processes requests sequentially to avoid cache/analysis races. EOF closes the file. Nested serve, list, prepare and screenshot writes are excluded; configure the session I/O budget when starting serve, not in a query. Request lines are limited to 64 KiB.

## Preparing a recording and processing progress

```powershell
.\isaacprof-cli.cmd prepare "build/Release/captures/recording.isaacprof" --write
# Automation: one result or structured error, without progress text
.\isaacprof-cli.cmd prepare "build/Release/captures/recording.isaacprof" --write --non-interactive
.\isaacprof-cli.cmd report "build/Release/captures/recording.isaacprof" --non-interactive --top 5
```

`prepare --write` requires a completed v3 recording. It stores session/half/quarter statistics and a contiguous binary full-session timeline preview in the **same file**. It upgrades v1 analysis without rescanning every raw event: existing statistics are retained, and native LOD candidates supply the preview. A recording without analysis needs one raw analysis pass; overview candidates and bins are built during that pass. Repeated preparation of a current appendix does not write again. Native recording bytes, footer and index are preserved. Writes check size/mtime and use the original file descriptor; a failed write attempts rollback of the old appendix. This is not an atomic rename or protection against concurrent external writers: stop recording before preparation.

The preview keeps the longest representative per thread/depth bucket across 4,096 columns (at most 200,000 entries). It is visual LOD, not a complete call list. The whole-session viewport uses it without callback block reads; zoomed ranges continue to use indexed native blocks. Exact event queries, ranking, call ancestry and frame attribution do not use this preview. New browser-saved analysis includes it automatically; existing v1 files remain readable and can be upgraded using this command.

In a terminal, processing updates one **stderr** line with stage, percentage and processed/total blocks, at most about four updates per second plus stage completion. Percentage is per stage, not a fabricated estimate of total remaining time. Stdout remains the command result. `--non-interactive` suppresses all progress even on a TTY, keeping stdout and error output suitable for automation. Redirected/non-TTY stderr and `serve` are quiet by default. No command asks interactive questions. The browser displays the same Worker stage/progress while loading or preparing analysis.

## Diagnosing uneven cadence

`diagnose FILE --non-interactive --top 5` attributes retained callback self to **every complete interval** in one raw pass, rather than only the slowest 500. `--clock render|update`, time range flags and `--window-ms 100..60000` select the analysis. Windows default to 5 seconds and automatically widen to at most 300 windows. Maximum: 200,000 intervals/update observations and 500,000 callback/cohort/window entries. This is a deliberate full raw read unless a narrower range is selected; read budgets still apply.

Output includes exact interval-duration percentiles in ms, reciprocal instantaneous FPS/UPS percentiles with explicit units, baseline/typical/p95+ cohorts, self/count correlations, callback increases normalised per interval, callback call counts and cost per call, and window summaries with markers/heap extrema. Render comparisons additionally separate intervals with and without a native update observation. `update_controlled_callback_increases` compares slow render intervals with update against baseline render intervals also with update. It is observational; room complexity, entity count and other confounders remain. Boundary-crossing calls are charged by start time, and correlations do not prove causation. Slow update intervals can contain many renders during paused updates; increasing render cost within such a window does not identify the cause of the pause.

Mean cadence is count / summed intervals, not the arithmetic mean of instantaneous rates. Lower p95/p99 **duration** is better; lower p5/p1 **FPS** is worse. Exact percentiles in diagnose can differ slightly from cached histogram percentiles (up to 0.1% relative histogram error). Complete intervals crossing a selected range edge are excluded, so diagnosis population can differ from a start-membership frames query.

Diagnosis uses retained data, not the visual LOD, and is available in read-only JSONL serve sessions.

## Capture scope and context cohorts

`info`, `report` and `diagnose.coverage` expose the binary configuration block when present: channel mask, exact mod/hook filters and trigger delays. `selected_scope` marks partial callback attribution. Excluded child costs remain in measured parent self time. A missing configuration block means scope provenance was not recorded; it does not imply selected filtering.

`diagnose.context_cohorts` compares grid slots <=135 versus >135 and effects <20, 20..49 and >=50. Render cohorts require a native update observation and use a preceding valid context sample no more than 500 ms old. Intervals >=100 ms, intervals crossing a run/room/level/end/exit transition and samples preceding the most recent transition are excluded. `context_coverage` reports the population and sample-age limit. These are overlapping observational cohorts, not matched A/B groups.

`diagnose.matched_slow_frames` compares the worst 500 p95+ intervals with up to five nearby typical intervals. Matching controls clock, thread, update activity and the recorded transition segment. When context exists, the room, stage, layout and enemy count must match; entity/effect/projectile/tear/pickup counts may differ by at most two or 10%. Samples must be valid and no older than 500 ms. Missing context permits a weaker `clock-only` comparison; stale or invalid recorded context does not. Reference costs are averaged, and selected intervals never reference themselves.

`recurring_callback_increases` includes increases of at least 50 µs observed in at least three matched slow intervals. It ranks additional self time rather than total recording cost. `slowest_intervals` preserves isolated spikes and reports extra wall, callback self and unattributed wall separately, along with reference quality. These are observed differences, not proof of causation. Detailed callback maps are retained only for compared intervals and their references; the raw pass and 500,000-entry budget remain bounded.

Use `frame FILE --id N --clock render --top 10 --non-interactive` to inspect an interval returned by `frames` or `diagnose`. The result shares the viewer's reference matching, mod → hook → function breakdown, boundary-crossing count and attribution coverage. `--clock update` selects update intervals. `--id` is required; ambiguous IDs across threads are rejected. Each group is limited by `--top`, with a maximum of 500 output nodes.

