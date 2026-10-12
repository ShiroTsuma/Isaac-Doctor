-- Native timing integration with StageAPI's separate callback registry.
dofile('tests/trigger-scenario.lua')
ModCallbacks.MC_POST_MODS_LOADED=13
local function registry()
 local api={Callbacks={}}
 function api.AddCallback(mod,id,priority,fn,...)
  api.Callbacks[id]=api.Callbacks[id] or {}
  table.insert(api.Callbacks[id],{ModID=mod,CallbackID=id,Priority=priority,Function=fn,Params={...}})
  table.sort(api.Callbacks[id],function(a,b)return a.Priority<b.Priority end)
 end
 function api.UnregisterCallbacks(mod)
  for _,list in pairs(api.Callbacks)do for i=#list,1,-1 do if list[i].ModID==mod then table.remove(list,i)end end end
 end
 function api.CallCallbacks(id,...)
  local value
  for _,entry in ipairs(api.Callbacks[id] or {})do local ok,result=pcall(entry.Function,...);if ok and result~=nil then value=result end end
  return value
 end
 return api
end
StageAPI=registry()
local total,added,removed=0,false,false
local original=function(value)assert(value==7);local sum=0;for i=1,1000 do sum=sum+math.sqrt(i)end;total=total+1;return sum end
StageAPI.AddCallback('Stage test owner','POST_HUD_RENDER',0,original,42)
StageAPI.AddCallback('Stage error owner','POST_HUD_RENDER',1,function()error('Controlled StageAPI error')end)
StageAPI.AddCallback('Stage multi owner','MULTI',0,function()return nil,'second',false,7 end)
Isaac.AddPriorityCallback({Name='Stage dispatch'},2,0,function()
 assert(StageAPI.Callbacks.POST_HUD_RENDER[1].Params[1]==42)
 StageAPI.CallCallbacks('POST_HUD_RENDER',7)
 local a,b,c,d=StageAPI.Callbacks.MULTI[1].Function()
 assert(a==nil and b=='second' and c==false and d==7)
 if _IsaacProfInstalled and not added then
  StageAPI.AddCallback('Stage dynamic owner','POST_HUD_RENDER',2,function(value)assert(value==7);return 81 end)
  added=true
 end
 if added and total>30 and not removed then StageAPI.UnregisterCallbacks('Stage dynamic owner');removed=true end
end)
local tick=TestTick
function TestTick()
 tick()
 if _IsaacProfInstalled and total>60 and not StageAPI.Replaced then
  local previous=StageAPI
  StageAPI=registry();StageAPI.Replaced=true
  StageAPI.AddCallback('Stage test owner','POST_HUD_RENDER',0,original,42)
  StageAPI.AddCallback('Stage multi owner','MULTI',0,function()return nil,'second',false,7 end)
  -- A mods-loaded notification also permits attachment before StageAPI loaded.
  for _,entry in ipairs(Isaac.GetCallbacks(13))do entry.Function(entry.Mod) end
  assert(StageAPI.AddCallback~=previous.AddCallback)
  assert(debug.getinfo(StageAPI.Callbacks.POST_HUD_RENDER[1].Function,'S').what=='C')
 end
 if _IsaacProfInstalled and total>100 and not StageAPI.InPlaceReload then
  local fresh=registry()
  fresh.AddCallback('Stage in-place owner','POST_HUD_RENDER',1,function()return 17 end)
  fresh.AddCallback('Stage test owner','POST_HUD_RENDER',0,original,42)
  fresh.AddCallback('Stage multi owner','MULTI',0,function()return nil,'second',false,7 end)
  StageAPI.Callbacks=fresh.Callbacks;StageAPI.AddCallback=fresh.AddCallback
  StageAPI.InPlaceReload=true
  for _,entry in ipairs(Isaac.GetCallbacks(13))do entry.Function(entry.Mod) end
  assert(debug.getinfo(StageAPI.Callbacks.POST_HUD_RENDER[1].Function,'S').what=='C')
 end
end
