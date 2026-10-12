const test=require('node:test'),assert=require('node:assert/strict');
const {FrameReferenceIndex}=require('../viewer/src/frame-reference.ts');
const {slowFrameComparisons}=require('../viewer/src/slow-frames.ts');
const {frameDetail}=require('../viewer/src/frame-detail.ts');
const context=(time,extra={})=>({time,valid:7,room:9,stage:1,stageType:0,roomType:1,width:15,height:9,gridSlots:135,grids:54,entities:20,enemies:0,effects:6,projectiles:0,tears:0,pickups:0,...extra});
const frame=(id,start,duration=10,extra={})=>({id,start,duration,kind:2,thread:1,...extra});
const telemetry=(contexts=[],markers=[])=>({context:contexts,markers,counters:[],heap:[]});

test('matched references control update observations, entity counts, threads and transitions',()=>{
 const selected=frame(1,200,30),same=frame(2,100),update=frame(3,150),wrongRoom=frame(4,300),changedEntities=frame(5,400),otherThread=frame(6,110,10,{thread:2});
 const rows=[selected,same,update,wrongRoom,changedEntities,otherThread,{id:7,start:151,duration:1,kind:1,thread:1}];
 const index=new FrameReferenceIndex(rows,telemetry([context(0),context(300,{room:10}),context(400,{entities:40,effects:26})]));
 const match=index.match(selected);assert.equal(match.quality,'context-matched');assert.deepEqual(match.frames,[same]);assert.equal(match.population,1);
 const crossing=new FrameReferenceIndex([same,selected],telemetry([context(0)],[{time:215,kind:3}]));assert.equal(crossing.match(selected).quality,'unavailable');
 const revisited=new FrameReferenceIndex([same,selected],telemetry([context(0),context(190)],[{time:180,kind:3}]));assert.equal(revisited.match(selected).frames.length,0);
});
test('stale or invalid recorded context never silently falls back to clock-only comparison',()=>{
 const rows=[frame(1,600),frame(2,700,30)];
 for(const contexts of [[context(0)],[context(600,{valid:0})]])assert.equal(new FrameReferenceIndex(rows,telemetry(contexts)).match(rows[1]).quality,'unavailable');
 const missing=new FrameReferenceIndex(rows,telemetry()).match(rows[1]);assert.equal(missing.quality,'clock-only');assert.equal(missing.frames.length,1);
});
test('five typical references exclude a tail stall and average callback costs',async()=>{
 const rows=Array.from({length:11},(_,i)=>frame(i+1,i*20,i===10?30:i===9?100:10));
 const events=rows.map(f=>({metric:1,start:f.start+1,duration:1,self:f.id===11?8:f.id===10?50:1,thread:1}));
 const stream={duration:300,metrics:new Map([[1,{id:1,mod:'M',callback_id:'1',callback_name:'R',source:'main.lua',line:1}]]),document:{complete:true,timeline:{}},async *intervals(){yield* rows;},async telemetry(){return telemetry([context(0)]);},async visitRanges(ranges,visit){for(const e of events)if(ranges.some(([a,b])=>e.start>=a && e.start<b))visit(e);}};
 const result=await frameDetail(stream,rows[10]);assert.equal(result.reference.frames.length,5);assert.equal(result.baselineWall,10);assert.equal(result.baselineSelf,1);assert.equal(result.self,8);assert.equal(result.boundaryCrossingCalls,0);
});
test('recurring rank requires three repeated increases and preserves an isolated slow frame separately',()=>{
 const metric=(id)=>({id,mod:'M'+id,callback_id:'1',callback_name:'R',source:'main.lua',line:id});
 const rows=Array.from({length:30},(_,i)=>{const slow=i>=27,m=new Map([[1,{self:slow?4:1,calls:1}],[2,{self:i===29?10:0,calls:1}]]);return {...frame(i+1,i*50,slow?20:10),metrics:m,self:[...m.values()].reduce((n,c)=>n+c.self,0),calls:2,boundaryCrossingCalls:0};});
 const d=slowFrameComparisons(rows,[],telemetry([0,400,800,1200].map(t=>context(t))),new Map([[1,metric(1)],[2,metric(2)]]),20,10);
 assert.equal(d.matched_intervals,3);assert.equal(d.context_matched_intervals,3);assert.deepEqual(d.recurring_callback_increases.map(r=>r.metric_id),[1]);assert.equal(d.recurring_callback_increases[0].affected_intervals,3);assert.equal(d.recurring_callback_increases[0].mean_extra_self_ms_when_present,3);
 assert(d.slowest_intervals.some(f=>f.comparison.callback_increases.some(c=>c.metric_id===2)));assert(Math.abs(d.mean_extra_callback_self_ms-(3+10/3))<1e-12);
});
