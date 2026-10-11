-- Installed by the native DLL on the host's Lua thread. No Workshop mod required.
local native = _IsaacProfNative
if type(Isaac) ~= 'table' or type(Isaac.GetCallbacks) ~= 'function'
    or type(Isaac.AddPriorityCallback) ~= 'function' then
    return false
end
if _IsaacProfInstalled then return true end

local pack, unpack, protected, raise = table.pack, table.unpack, pcall, error
local oldGet = Isaac.GetCallbacks
local oldAdd = Isaac.AddPriorityCallback
local oldRemove = Isaac.RemoveCallback
local originals = setmetatable({}, {__mode = 'k'})
local cache = setmetatable({}, {__mode = 'k'})
local callbackNames = {}
for name, id in pairs(ModCallbacks or {}) do callbackNames[id] = name end

local function wrap(fn, mod, callbackId)
    if originals[fn] then return fn end
    local byMod = cache[fn]
    if not byMod then byMod = {}; cache[fn] = byMod end
    local modName = type(mod) == 'table' and tostring(mod.Name or 'unknown') or 'unknown'
    local key = modName .. '\0' .. tostring(callbackId)
    if byMod[key] then return byMod[key] end
    local measured = native.wrap(modName, tostring(callbackId), callbackNames[callbackId] or '', fn)
    originals[measured] = fn
    byMod[key] = measured
    return measured
end

local function instrument(list, callbackId)
    for _, entry in ipairs(list) do
        if type(entry.Function) == 'function' then
            entry.Function = wrap(entry.Function, entry.Mod, callbackId)
        end
    end
    return list
end

Isaac.AddPriorityCallback = function(mod, id, priority, fn, param)
    -- Validate/register the original function first, preserving the game's
    -- source metadata and registration semantics. Instrument only at registration.
    local result = pack(oldAdd(mod, id, priority, fn, param))
    instrument(oldGet(id), id)
    return unpack(result, 1, result.n)
end
if type(oldRemove) == 'function' then
    Isaac.RemoveCallback = function(mod, id, fn)
        -- Temporarily restore original identities so the game's removal implementation
        -- retains its exact semantics, including duplicate registrations.
        local list = oldGet(id)
        for _, entry in ipairs(list) do
            entry.Function = originals[entry.Function] or entry.Function
        end
        local result = pack(protected(oldRemove, mod, id, originals[fn] or fn))
        instrument(oldGet(id), id)
        if not result[1] then raise(result[2], 0) end
        return unpack(result, 2, result.n)
    end
end

-- REPENTOGON's GetCallbacks exposes Callbacks as an upvalue. The native bridge
-- enumerates keys, including custom callbacks registered before attachment.
for _, id in ipairs(native.callback_ids(oldGet)) do instrument(oldGet(id), id) end
for id in pairs(callbackNames) do instrument(oldGet(id), id) end
-- Native observer only. Runs after a loaded run's first update; no Lua timing,
-- polling, allocations or screenshot work in this callback.
if type(RegisterMod) == 'function' and type((ModCallbacks or {}).MC_POST_UPDATE) == 'number' then
    local owner = RegisterMod('IsaacProf lifecycle', 1)
    originals[native.run_update] = native.run_update
    oldAdd(owner, ModCallbacks.MC_POST_UPDATE, -100000, native.run_update)
    if type(ModCallbacks.MC_POST_RENDER) == 'number' then
        originals[native.run_render] = native.run_render
        oldAdd(owner, ModCallbacks.MC_POST_RENDER, -100000, native.run_render)
    end
    native.lifecycle_available()
    for name, kind in pairs({MC_POST_GAME_STARTED=2, MC_POST_NEW_ROOM=3, MC_POST_NEW_LEVEL=4, MC_POST_GAME_END=5, MC_PRE_GAME_EXIT=6}) do
        local id = ModCallbacks[name]
        if type(id) == 'number' then
            local callback = native.marker(kind)
            originals[callback] = callback
            oldAdd(owner, id, -100000, callback)
        end
    end
    for name, kind in pairs({MC_POST_PROJECTILE_INIT=4, MC_POST_TEAR_INIT=5, MC_POST_EFFECT_INIT=6, MC_POST_NPC_INIT=7, MC_ENTITY_TAKE_DMG=8}) do
        local id = ModCallbacks[name]
        if type(id) == 'number' then
            local callback = native.trigger(kind)
            originals[callback] = callback
            oldAdd(owner, id, -100000, callback)
        end
    end
end
-- Dispatch and lookup functions remain untouched. There is no profiler Lua
-- code, pcall/table.pack or callback-list scan in the per-invocation hot path.
_IsaacProfInstalled = true
return true
