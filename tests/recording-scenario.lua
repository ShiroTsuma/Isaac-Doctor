-- Controlled run lifecycle: no update until the test creates a trigger file.
Isaac, ModCallbacks = {}, {MC_POST_UPDATE=1,MC_POST_RENDER=2,MC_POST_GAME_STARTED=3,MC_POST_NEW_ROOM=4,MC_POST_NEW_LEVEL=5,MC_POST_GAME_END=6,MC_PRE_GAME_EXIT=7}
function RegisterMod(name) return {Name=name} end
local Callbacks = {}
function Isaac.GetCallbacks(id, create)
    assert(type(id)=='number' or type(id)=='string')
    if create and not Callbacks[id] then Callbacks[id]={} end
    return Callbacks[id] or {}
end
function Isaac.AddPriorityCallback(mod,id,priority,fn,param)
    local list=Isaac.GetCallbacks(id,true)
    list[#list+1]={Mod=mod,Function=fn,Priority=priority,Param=param}
    table.sort(list,function(a,b)return a.Priority<b.Priority end)
end
Isaac.AddPriorityCallback({Name='Loaded run test'},1,0,function()
    local n=0;for i=1,10000 do n=n+math.sqrt(i) end;return n
end)
local ticks=0
local room={GetType=function() return 1 end,GetGridWidth=function() return 5 end,GetGridHeight=function() return 4 end,GetGridSize=function() return 20 end,GetGridEntity=function(_,index) return index<3 and {} or nil end}
local level={GetStage=function() return 1 end,GetStageType=function() return 0 end,GetCurrentRoomDesc=function() return {ListIndex=math.floor(ticks/20)} end}
function Game() return {GetRoom=function() return room end,GetLevel=function() return level end} end
function Isaac.GetRoomEntities()
    local result={};for _,type in ipairs({10,2,9,1000,5}) do result[#result+1]={Type=type,IsActiveEnemy=function() return type==10 end} end;return result
end
local errorObject={sentinel=true}
Isaac.AddPriorityCallback({Name='Structured error test'},2,0,function() if ticks==7 then error(errorObject) end end)
Isaac.AddPriorityCallback({Name='Render stall test'},2,0,function()
    if ticks%15==0 then local start=os.clock();while os.clock()-start<.035 do end end
end)
function TestTick()
    local trigger=io.open('isaacprof-test-run-'..TestPid..'.trigger','rb')
    if not trigger then return end
    trigger:close()
    ticks=ticks+1
    if ticks==1 then for _,entry in ipairs(Callbacks[3] or {}) do entry.Function(entry.Mod,false) end end
    if ticks%20==0 then for _,entry in ipairs(Callbacks[4] or {}) do entry.Function(entry.Mod) end end
    if ticks==40 then for _,entry in ipairs(Callbacks[5] or {}) do entry.Function(entry.Mod) end end
    if ticks==80 then for _,entry in ipairs(Callbacks[6] or {}) do entry.Function(entry.Mod,true) end end
    if ticks==90 then for _,entry in ipairs(Callbacks[7] or {}) do entry.Function(entry.Mod,true) end end
    if ticks%2==0 then for _,entry in ipairs(Callbacks[1] or {}) do entry.Function(entry.Mod) end end
    for _,entry in ipairs(Callbacks[2] or {}) do
        if entry.Mod.Name=='Structured error test' then local ok,err=pcall(entry.Function,entry.Mod);if not ok then assert(err==errorObject,'error identity changed') end
        else entry.Function(entry.Mod) end
    end
end
