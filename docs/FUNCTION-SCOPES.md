# Profiling functions inside a callback

Callback attribution tells you which mod took time. Optional function scopes
show which part of that callback took it: input handling, menu generation,
serialization, or another helper.

Ordinary callback profiling requires no changes to a mod. Internal function
scopes are currently cooperative and optional: the author registers selected
methods as shown below. Isaac Doctor does not automatically discover every
function or rewrite mod files. The portable release supports registrations;
it does not include modified Workshop mods.

A mod can register selected table methods before Isaac Doctor attaches:

```lua
_IsaacProfFunctionScopes = _IsaacProfFunctionScopes or {}
table.insert(_IsaacProfFunctionScopes, {
    mod = "My mod",
    prefix = "Menu",
    target = MyMenu,
    names = {"ReadInput", "BuildLayout", "SaveSettings"}
})
```

Isaac Doctor replaces those methods once with native timing closures. Nothing
runs per frame to discover functions. Without the profiler, this registration
only stores a table; the methods run normally. Registrations are also checked
at `MC_POST_MODS_LOADED`, so a library reload can replace its methods.

Results appear as `Function:Menu.ReadInput` and similar hooks in the timeline,
call tree, bottom-up view, and CLI. The function's original source location is
retained. Nested time is deducted from its parent's self time. Arguments,
multiple returns, nil returns, and raised Lua errors are preserved.

These scopes use the callback capture channel and the existing mod/hook
filters. Include their `Function:` hooks when using an explicit hook allowlist.
Each measured call adds timing overhead and potentially a trace event, so
register a few useful boundaries rather than every small function.

Only calls through `target[name]` are measured. Previously cached local
references keep calling the original function. Do not register callback entry
points, functions whose identity is used as a key, or methods whose callers
require their original identity. Register internal helpers instead.
