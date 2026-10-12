dofile('tests/presentation-scenario.lua')
TestNativeBusyMs = 20
local tick = TestTick
function TestTick()
    tick()
    TestBeforeSwapDelayMs = 20
end

local sampleMod = {Name = 'Lua sample owner'}
Isaac.AddPriorityCallback(sampleMod, ModCallbacks.MC_POST_RENDER, 0, function()
    local deadline = os.clock() + 0.018
    local value = 0
    repeat
        for i = 1, 1000 do value = value + math.sqrt(i) end
    until os.clock() >= deadline
    assert(value > 0)
end)
