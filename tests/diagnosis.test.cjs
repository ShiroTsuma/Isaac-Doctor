const test=require('node:test'),assert=require('node:assert/strict');
const {diagnoseCapture}=require('../viewer/src/diagnosis.ts');
const {rankModel}=require('../viewer/src/analysis.ts');
const metric=(id,hook)=>({id,mod:'M',callback_id:String(hook),callback_name:String(hook),source:'test.lua',line:1,function:'f',calls:1,errors:0,inclusive_ns:1000,exclusive_ns:1000,max_ns:1000,mean_ns:1000});
test('expanded hook/callback IDs never collide in the flattened React sibling list',()=>{
 const metrics=new Map([[1,metric(1,68)],[68,metric(68,1)]]),model={metrics,events:[],duration:60};const all=new Set();
 for(const mode of ['mods','hooks','callbacks']){const result=rankModel(model,{mode,start:0,end:60,range:false,search:'',sort:'exclusive',descending:true}),keys=[];const visit=rows=>{for(const row of rows){keys.push(row.key);if(row.children)visit(row.children);}};visit(result.rows);assert.equal(new Set(keys).size,keys.length);for(const key of keys){assert(!all.has(key),'Switching grouping must use distinct row identities');all.add(key);}}
});
test('diagnosis scans once, preserves nested self, controls update activity and exposes rate percentile units',async()=>{
 const intervals=[...[[0,10],[10,10],[20,30],[50,10]].map(([start,duration],i)=>({id:i+1,start,duration,kind:2,thread:1})),{id:1,start:10,duration:5,kind:1,thread:1},{id:2,start:20,duration:5,kind:1,thread:1}];
 const events=[[1,1,1],[11,2,1],[21,8,1],[22,3,1],[51,1,1],[22,100,2]],metrics=new Map([[1,metric(1,1)]]);let scans=0;
 const stream={duration:60,frequency:1000,metrics,document:{timeline:{filtered_events:0,dropped_events:0}},async *intervals(){yield* intervals;},async visitEvents(a,b,consume){scans++;for(const [at,self,thread] of events)consume(()=>{throw Error('No event object allocation required');},1,at,self,self,thread,0,false);},async telemetry(){return {heap:[],markers:[]};}};
 const d=await diagnoseCapture(stream,{windowMs:20});assert.equal(scans,1);assert.equal(d.summary.count,4);assert.equal(d.summary.p50_ms,10);assert.equal(d.summary.p95_ms,30);assert.equal(d.summary.callback_self_ms,15);assert.equal(d.coverage.attributed_calls,5);assert.equal(d.coverage.unattributed_calls,1);assert.equal(d.summary.instantaneous_rate_percentiles.unit,'FPS');assert.equal(d.summary.instantaneous_rate_percentiles.p50,100);
 assert.equal(d.cohorts.find(c=>c.name==='baseline_with_update').mean_callback_self_ms,2);assert.equal(d.cohorts.find(c=>c.name==='slow_with_update').mean_callback_self_ms,11);assert.equal(d.update_controlled_callback_increases[0].increase_ms_per_interval,9);assert.equal(d.windows.reduce((s,w)=>s+w.count,0),4);
});

test('context cohorts reject transition crossings, stale samples and render intervals without update',async()=>{
 const rows=[[0,10],[10,10],[20,10],[30,10],[40,10],[600,10]].map(([start,duration],i)=>({id:i+1,start,duration,kind:2,thread:1}));
 const intervals=[...rows,...[15,25,35,605].map((end,i)=>({id:i+1,start:end-1,duration:1,kind:1,thread:1}))];
 const contexts=[{time:0,valid:7,gridSlots:100,effects:10},{time:30,valid:7,gridSlots:200,effects:60}];
 const stream={duration:610,frequency:1000,metrics:new Map([[1,metric(1,1)]]),document:{complete:true,timeline:{filtered_events:0,dropped_events:0},configuration:{channels:3,selectedMods:['M'],selectedHooks:[]}},async *intervals(){yield* intervals;},async visitEvents(a,b,consume){for(const row of rows)consume(()=>{},1,row.start+1,2,2,1,0,false);},async telemetry(){return {heap:[],markers:[{time:25,kind:3}],context:contexts};}};
 const d=await diagnoseCapture(stream),small=d.context_cohorts.find(c=>c.name==='grid_135_or_less'),large=d.context_cohorts.find(c=>c.name==='grid_over_135');
 assert.equal(d.context_coverage.attributed_intervals,2);assert.equal(small.count,1);assert.equal(large.count,1);
 assert.equal(small.mean_callback_self_ms,2);assert.equal(large.mean_callback_self_ms,2);
 assert.equal(d.context_cohorts.find(c=>c.name==='effects_50_plus').count,1);assert.equal(d.coverage.selected_scope,true);
});
