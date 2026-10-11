Isaac,ModCallbacks={}, {MC_POST_UPDATE=1,MC_POST_RENDER=2,MC_POST_GAME_STARTED=3,MC_POST_NEW_ROOM=4,MC_POST_NEW_LEVEL=5,MC_POST_GAME_END=6,MC_PRE_GAME_EXIT=7,MC_POST_PROJECTILE_INIT=8,MC_POST_TEAR_INIT=9,MC_POST_EFFECT_INIT=10,MC_POST_NPC_INIT=11,MC_ENTITY_TAKE_DMG=12}
function RegisterMod(name) return {Name=name} end
local Callbacks={}
function Isaac.GetCallbacks(id,create)
    if create and not Callbacks[id] then Callbacks[id]={} end
    return Callbacks[id] or {}
end
function Isaac.AddPriorityCallback(mod,id,priority,fn,param)
    local list=Isaac.GetCallbacks(id,true)
    list[#list+1]={Mod=mod,Function=fn,Priority=priority,Param=param}
    table.sort(list,function(a,b)return a.Priority<b.Priority end)
end
for _,id in pairs(ModCallbacks) do
    Isaac.AddPriorityCallback({Name='Trigger payload'},id,0,function() local total=0;for i=1,100 do total=total+math.sqrt(i) end;return total end)
end
Isaac.AddPriorityCallback({Name='Unicode m\195\179d'},ModCallbacks.MC_POST_RENDER,0,function() return 42 end)
local events={['room-entry']=4,['level-entry']=5,['run-end']=6,['game-exit']=7,projectile=8,tear=9,effect=10,npc=11,damage=12}
local function dispatch(id)
    for _,entry in ipairs(Callbacks[id] or {}) do entry.Function(entry.Mod,{Type=9},1,0,{},0) end
end
function TestTick()
    local path='isaacprof-events-'..TestPid..'.trigger'
    local file=io.open(path,'rb')
    if file then
        local event=file:read('*a');file:close();dispatch(assert(events[event],event));os.remove(path)
    end
    dispatch(1);dispatch(2)
end
