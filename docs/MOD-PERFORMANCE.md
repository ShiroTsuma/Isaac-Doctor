# Finding and fixing slow mod callbacks

[Isaac Doctor](../README.md) records callback timings and frame cadence while you play. Use this guide to turn those measurements into a change you can test in your mod. The examples use small, illustrative Lua functions; they do not require a particular mod pack or a downloadable recording.

## Start with a reproducible scene

1. Start Isaac through REPENTOGONLauncher and **Connect game**.
2. Record the slowdown with **Callback timings**, **Timeline**, render/update frames and room context enabled. Start after the run loads, or use a room-entry trigger and a delay to skip the transition. Leave the capture duration threshold at **0 µs** for the first investigation.
3. Add an **FPS** or **UPS** graph with **+**. Add **Effects**, **Room entities** or **Lua heap** when those measurements help explain the scene. Select the same time range across the graphs and analysis drawer.
4. Open **Frames**, choose **Render** or **Update**, and sort by wall time. Select a slow interval and inspect its callback breakdown. If you selected only a short callback, use **Show enclosing frame**.
5. In **Bottom-up**, group by **Mods**, expand the mod, then its hook and function. Sort by **Self time** for accumulated work. Check **Calls** and mean duration too: many cheap calls can cost more than one long call.
6. Select a function and expand **Summary → Source context**. Connect your `mods` folder or a narrower source folder. Check the recorded source hash before treating the displayed code as the captured version.

Use the top search bar, or **Ctrl+K**, to find a view, mod, hook or source. Search `SwapBuffers` to open **Frames → Presentation**. Use `>` for commands, `@` for mods/hooks, and `/` for recordings/sources.

![Callback timeline and per-hook costs](images/callback-detail.png)

For recurring drops, open **Frames → Slow-frame patterns**. **Inspect evidence** opens a slow interval and its nearby references; **Open callback / source** follows the measured function. Compare intervals with similar room context and update activity. A callback that stays expensive in both slow and reference frames can still deserve a fix; its cost will not appear as an increase.

## Common patterns

| What you see | What to inspect | First change to consider |
| --- | --- | --- |
| Render callback stays costly while the player is idle | `Font()`, `Sprite()`, `Load`, fixed resource lookups | Keep reusable resources outside the render loop |
| Tiny callbacks have a large total cost | Call count, input hook and entity variants | Filter registrations and reject unrelated calls before doing work |
| Cost grows in large rooms | Grid loops and full-room entity snapshots | Reduce repeated scans and query only after eligibility checks |
| Health or menu work runs without a consumer | Subscribers, feature state, dirty flags | Skip unused work while preserving refresh rules |
| Spikes move between unrelated callbacks | Temporary tables, copied state, heap trend | Reduce avoidable allocations; investigate shared runtime work |
| A library owns most of the time | Inclusive versus self time, nested dispatch | Follow its children to the mod code it invokes |
| FPS drops with little extra callback work | Presentation, waits, update pacing | Measure the remaining wall time before changing Lua |

### Load fonts and sprites once

A HUD can render the same text hundreds of times while loading its font on each call. File loading and resource construction cost time even when the text itself is small.

```lua
-- Before: create and load a font on each draw.
local function drawLabel(text, x, y)
    local font = Font()
    font:Load("font/my-hud.fnt")
    font:DrawString(text, x, y, KColor(1, 1, 1, 1), 0, true)
end
```

Keep one font for that asset. Lazy initialization avoids loading it until the HUD needs it.

```lua
-- After: use your own font asset at this path.
local hudFont

local function getHudFont()
    if hudFont == nil then
        hudFont = Font()
        hudFont:Load("font/my-hud.fnt")
    end

    return hudFont
end

local function drawLabel(text, x, y)
    getHudFont():DrawString(text, x, y, KColor(1, 1, 1, 1), 0, true)
end
```

Use the same approach for sprites and fixed item/variant identifiers. Retain the original draw conditions and animation updates. Two independently animated objects need separate sprite state; sharing one mutable sprite can change what you draw.

**In the UI:** expand the mod's render hooks in **Bottom-up**, open their source, and look for construction or loading inside the function. Compare mean cost per call after the change, with the same HUD visible.

In a Diepio HUD investigation, caching three fonts and a reusable sprite reduced the sum of three render callbacks' mean self times from about **0.48 ms to 0.03 ms**. This is an observed callback-level result from different runs, rather than a controlled whole-game FPS result. The [README example](../README.md#a-real-fix-diepios-hud) shows the measured functions and source view.

### Reject unrelated calls before native queries

Input and entity callbacks can run far more often than their feature needs. Moving a guard ahead of `ToPlayer`, `GetSprite`, `GetData` or room enumeration can remove most of that work.

```lua
-- An input callback interested only in a triggered DROP action.
local function onInput(_, entity, hook, action)
    if hook ~= InputHook.IS_ACTION_TRIGGERED
        or action ~= ButtonAction.ACTION_DROP then
        return
    end

    if entity == nil then
        return
    end

    local player = entity:ToPlayer()
    if player == nil then
        return
    end

    -- Keep the original DROP handling and return value here.
end
```

Use a callback's registration filter when the API supports the parameter you need. For example, an effect-update registration can select a specific effect variant. For a shared handler with several variants, place the variant check before fetching sprites, spawners or room descriptors. Check the [callback API](https://wofsauge.github.io/IsaacDocs/rep/enums/ModCallbacks.html) for the filter's meaning; different callbacks filter different fields.

Preserve return semantics. An ignored input callback should return `nil`; returning `false` or `0` can override the game's input. Keep callback priority and side-effect order intact.

**In the UI:** group **Bottom-up** by **Hooks** and inspect `MC_INPUT_ACTION`, effect, NPC or render hooks. A high call count with a small mean can explain a large total. Compare call rate as well as cost per call after filtering: faster captures can contain more frames.

### Avoid full-room scans for inactive features

An item callback might call `Isaac.GetRoomEntities()` before checking whether anyone owns the item. A grid library might dispatch a custom hook for each cell even when nobody registered that hook. Both costs grow with room size.

Check whether the feature applies before enumerating entities or grids. Reuse a query within one invocation if intervening actions cannot change the result. A handler that kills an entity, gives an item or calls another mod can invalidate the value you just read.

A narrower query can help, but verify its semantics. `Isaac.FindByType` has cache and exclusion options; replacing a room snapshot can change the entities you receive, including `FLAG_NO_QUERY` handling. Read the [query API](https://wofsauge.github.io/IsaacDocs/rep/Isaac.html#findbytype) and test the relevant flags.

For custom grid dispatch, retain bookkeeping and state updates even when there are no listeners. If registrations can change during a run, query the live registry or invalidate a cached answer when callbacks are added or removed.

**In the UI:** add **Room entities** and **Effects** graphs, inspect **Telemetry** for room/grid context, then compare the update callback in small and large rooms. Use the filmstrip to distinguish idle work from a transition or a room full of effects.

### Stop polling state nobody observes

A health-change library can read every health field and build a snapshot each update despite having no listeners for that player. A closed menu can rebuild layout and serialize settings while nothing changed.

Tie the work to a consumer or an explicit dirty flag. Initialize a subscriber's baseline when it subscribes. Refresh after the state changes, and preserve any events that callers expect on the first update. Keep save operations at the points where settings change, rather than in a render callback.

Cache stable resources and derived results with clear invalidation rules. Player health, inventory, entity lists and room state can change between callbacks, even within one frame. A frame number alone does not establish that a cached value remains valid.

**In the UI:** compare an idle range with the menu closed against one with it open. Inspect **Call tree** for layout, input and persistence work. For a library, compare its parent **Inclusive time**; a new helper scope can move time out of the parent's **Self time** without reducing the total.

### Reduce temporary allocations in hot paths

Small tables add up when a callback runs for many entities or input queries. Common sources include copying a public state table just to read one field, rebuilding a constant lookup table, and creating several empty arrays on each render.

```lua
-- Before: rebuild an invariant lookup for every call.
local function supportsKind(kind)
    local supported = { player = true, familiar = true }
    return supported[kind] == true
end

-- After: keep the lookup private and treat it as read-only.
local supportedKinds = { player = true, familiar = true }

local function supportsKind(kind)
    return supportedKinds[kind] == true
end
```

Give internal readers access to private state when the public API must return a defensive copy. Preserve that public copy contract. You can reuse private scratch arrays if callers do not retain them and the function cannot re-enter or yield while using them. Clear populated entries before reuse so entities and other objects do not stay referenced.

**In the UI:** compare long callbacks across several intervals and add a **Lua heap** graph. Heap samples show retained VM memory, not total allocations or collection duration. A spike charged to a small callback may include shared Lua garbage collection; the callback that triggers collection need not have created the garbage. Native samples can help investigate runtime work, but Isaac Doctor does not automatically identify allocation producers or label GC phases.

### Follow nested dispatch to its owner

A StageAPI or other library callback can spend most of its inclusive time invoking other mods. Changing the dispatcher would leave the expensive child function untouched.

**In the UI:** select the parent in **Call tree** and expand its children. **Inclusive time** includes nested measured calls; **Self time** subtracts them. StageAPI callbacks appear under the owning mod with a `StageAPI:` hook. Follow the child to **Summary → Source context**.

If a large callback contains several private helpers, you can register a few [optional function scopes](FUNCTION-SCOPES.md). Use boundaries such as input, layout or persistence. Keep the scope setup identical across before/after captures: adding scopes changes both attribution and profiler overhead. Ordinary callback profiling requires no mod edits.

### Investigate wall time outside measured callbacks

A frame interval includes work and waiting between observations. Small callback self time does not identify a GPU bottleneck, and a long `SwapBuffers` span does not measure GPU execution time.

**In the UI:** open **Frames → Presentation** and compare the interval, **SwapBuffers**, screenshot readback and observed native waits. Enable those channels before recording. Native instruction sampling is a separate opt-in channel; use it for a focused recording and check its pause/coverage statistics.

Instruction samples describe where a thread was observed. A Lua source entry identifies a function definition, not the exact executing line. A suspended or waiting thread can produce samples in one native module without consuming that proportion of CPU time. Observed waits cover selected APIs on the registered Lua/render threads, not all scheduling or driver waits.

Look at update pacing too. Alternating render intervals with and without an update can produce two timing populations near a 60 Hz limit. Compare matching update activity before attributing the difference to a mod. Do not add overlapping callback, swap and wait spans together.

## Verify the fix

Record a comparable scene after restarting the game through its launcher. Keep the same room, active items, visible HUD/menu, capture channels, filters and function scopes. Use several captures for an FPS claim; one before/after pair can expose a useful lead but cannot establish the result across runs or combat.

In **Compare**, select the reference recording and group by mod, hook or callback. Check:

- **Mean cost per call:** did this function become cheaper?
- **Call rate:** did you stop work on unrelated inputs/entities?
- **Self and inclusive totals:** did the work shrink or move to a child?
- **Frame intervals and their slow tail:** did the game become smoother in the matching scene?

Use **Min call** beside the range controls to hide short calls when reading a crowded timeline. Set it to **0** for a complete callback comparison. A UI filter does not change FPS or frame statistics. A capture duration threshold preserves selected aggregate timings but removes short calls from timeline detail, so it limits frame-by-frame attribution. Mod/hook exclusions also change what the profiler can measure.

Exercise the feature's active path as well as its idle path: item pickup/removal, room re-entry, co-op players, transitions, callback mutations and compatibility branches where they apply. Compare return values, action order, RNG calls and visible output. Avoid reducing update frequency until you have decided how the changed cadence should affect gameplay.

Keep a small record of the symptom, UI evidence, code change, behavior checks and measured result. If callback cost improves while frame timing stays the same, retain the local improvement and investigate the remaining work. Isaac Doctor provides measurements; it does not patch installed mods or guarantee a particular FPS increase.
