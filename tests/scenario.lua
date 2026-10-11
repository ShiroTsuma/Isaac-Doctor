-- Controlled counterpart of the local game's callback API.
Isaac, ModCallbacks, CallbackPriority = {}, {UPDATE = 1, CHILD = 2, FAIL = 3, REMOVE = 4}, {DEFAULT = 0}
local Callbacks = {}
function Isaac.GetCallbacks(id, create)
    assert(type(id)=='number' or type(id)=='string', 'Callback ID expected')
    if create and not Callbacks[id] then Callbacks[id] = {} end
    return Callbacks[id] or {}
end
function Isaac.AddPriorityCallback(mod, id, priority, fn, param)
    assert(type(fn) == 'function')
    local list = Isaac.GetCallbacks(id, true)
    local position = #list + 1
    for i = #list, 1, -1 do
        if list[i].Priority <= priority then break end
        position = i
    end
    table.insert(list, position, {Mod=mod, Function=fn, Priority=priority, Param=param})
end
function Isaac.AddCallback(mod, id, fn, param) return Isaac.AddPriorityCallback(mod, id, 0, fn, param) end
function Isaac.RemoveCallback(mod, id, fn)
    local list = Isaac.GetCallbacks(id)
    for i = #list, 1, -1 do if list[i].Function == fn then table.remove(list, i) end end
end
function Isaac.RunCallbackWithParam(id, param, ...)
    for _, entry in ipairs(Callbacks[id] or {}) do
        if entry.Param == nil or entry.Param == param then
            local result = table.pack(entry.Function(entry.Mod, ...))
            if result[1] ~= nil then return table.unpack(result, 1, result.n) end
        end
    end
end
function Isaac.RunCallback(id, ...) return Isaac.RunCallbackWithParam(id, nil, ...) end
local slow, child, bad = {Name='Slow test mod'}, {Name='Nested test mod'}, {Name='Error test mod'}
local errorObject = {sentinel = true}
local function busy(n) local x=0; for i=1,n do x=x+math.sqrt(i) end return x end
Isaac.AddCallback(child, 2, function() return busy(10000), nil, 42 end)
Isaac.AddCallback(slow, 1, function()
    busy(30000)
    local a,b,c = Isaac.RunCallback(2)
    assert(type(a)=='number' and b==nil and c==42, 'multiple returns changed')
    return true, nil, 'preserved'
end)
Isaac.AddCallback(bad, 3, function() error(errorObject) end)
Isaac.AddCallback(slow, 'PREEXISTING', function() return 'existing' end)
local oldRun = Isaac.RunCallback
local oldGet = Isaac.GetCallbacks
local initialized = false
function TestTick()
    if _IsaacProfInstalled and not initialized then
        assert(Isaac.RunCallback==oldRun and Isaac.GetCallbacks==oldGet, 'dispatcher/lookup was replaced')
        assert(debug.getinfo(Isaac.GetCallbacks(1)[1].Function, 'S').what=='C', 'callback wrapper is not native')
        -- Callback registration/removal after attachment, duplicates and custom IDs.
        local count = 0
        local fn = function() count=count+1 end
        Isaac.AddCallback(slow, 4, fn)
        Isaac.AddCallback(slow, 4, fn)
        Isaac.RemoveCallback(slow, 4, fn)
        Isaac.RunCallback(4)
        assert(count==0, 'callback removal changed')
        Isaac.AddCallback(slow, 'CUSTOM', function() return 99 end)
        assert(debug.getinfo(Isaac.GetCallbacks('CUSTOM')[1].Function, 'S').what=='C')
        assert(Isaac.RunCallback('CUSTOM') == 99)
        Isaac.AddCallback(slow, 'YIELD', function()
            coroutine.yield('paused')
            return 'resumed', nil, 123
        end)
        local order = {}
        Isaac.AddPriorityCallback(slow, 'ORDER', 5, function() order[#order+1]=5 end, 9)
        Isaac.AddPriorityCallback(slow, 'ORDER', -5, function() order[#order+1]=-5 end, 9)
        Isaac.RunCallbackWithParam('ORDER', 8)
        assert(#order==0, 'parameter filtering changed')
        Isaac.RunCallbackWithParam('ORDER', 9)
        assert(order[1]==-5 and order[2]==5, 'priority ordering changed')
        -- Deliberately unavailable global debug matches the local game's sandbox.
        debug = nil
        initialized = true
    end
    local a,b,c = Isaac.RunCallback(1)
    assert(a==true and b==nil and c=='preserved')
    local ok,err = pcall(Isaac.RunCallback, 3)
    assert(not ok and err==errorObject, 'error object changed')
    if initialized then assert(Isaac.RunCallback('CUSTOM')==99) end
    assert(oldRun('PREEXISTING')=='existing')
    -- CuerLib's exit callback may dispatch nil. The runtime treats this as an
    -- empty callback set, although public GetCallbacks(nil) rejects the ID.
    assert(Isaac.RunCallback(nil)==nil, 'nil callback dispatch changed')
    if initialized then
        local co = coroutine.create(function() return Isaac.RunCallback('YIELD') end)
        local ok, value = coroutine.resume(co)
        assert(ok and value=='paused', 'native wrapper broke yield')
        local resumed, a,b,c = coroutine.resume(co)
        assert(resumed and a=='resumed' and b==nil and c==123, 'native continuation broke return values')
    end
end
