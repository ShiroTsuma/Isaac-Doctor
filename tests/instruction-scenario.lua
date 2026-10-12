dofile('tests/presentation-scenario.lua')
TestNativeBusyMs = 20
local tick = TestTick
function TestTick()
    tick()
    TestBeforeSwapDelayMs = 20
end
