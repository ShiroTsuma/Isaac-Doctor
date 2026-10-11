-- Controlled no-op callback benchmark. Never uses production game binaries.
Isaac, ModCallbacks = {}, {BENCHMARK = 1}
local Callbacks = {}
function Isaac.GetCallbacks(id) return Callbacks[id] or {} end
function Isaac.AddPriorityCallback(mod, id, priority, fn)
    Callbacks[id] = {{Mod=mod, Function=fn, Priority=priority}}
end
Isaac.AddPriorityCallback({Name='Benchmark'}, 1, 0, function() end)
function TestTick()
    local request = io.open('benchmark-request.txt', 'r')
    if not request then return end
    local stage = request:read('*a'); request:close()
    os.remove('benchmark-request.txt')
    local fn = Callbacks[1][1].Function
    for _=1,10000 do fn() end
    local samples = {}
    for batch=1,7 do
        local start = os.clock()
        for _=1,200000 do fn() end
        samples[batch] = (os.clock()-start)/200000*1e9
    end
    local out = assert(io.open('benchmark-result.tmp', 'w'))
    out:write(stage, '\n', table.concat(samples, '\n')); out:close()
    assert(os.rename('benchmark-result.tmp', 'benchmark-result.txt'))
end
