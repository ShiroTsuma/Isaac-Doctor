dofile('tests/trigger-scenario.lua')
local tick=TestTick
local count=0
function TestTick()
    count=count+1
    tick()
    TestBeforeSwapDelayMs=count%12==0 and 35 or 1
end
