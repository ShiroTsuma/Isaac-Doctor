const test=require('node:test'),assert=require('node:assert/strict');
const {frameResults}=require('../viewer/src/frames.ts');
const {frameDetail}=require('../viewer/src/frame-detail.ts');
const {rollingSeries,graphCapture}=require('../viewer/src/graphs.ts');
const {compareMetrics}=require('../viewer/src/comparison.ts');
const {overheadEstimate}=require('../viewer/src/overhead.ts');
const iterable=async function*(rows){yield* rows;};
const metric=(id,line=1)=>({id,line,calls:1,errors:0,inclusive_ns:1000,exclusive_ns:1000,max_ns:1000,mean_ns:1000,mod:'M',callback_id:'1',callback_name:'UPDATE',source:'@G:/game/mods/m/main.lua',function:'pointer'});
test('500-frame high-cardinality breakdown releases batches instead of exceeding the old 200k limit',async()=>{
  const metrics=new Map(Array.from({length:501},(_,i)=>[i+1,metric(i+1)])),intervals=Array.from({length:500},(_,i)=>({id:i+1,start:i*10,duration:10,kind:2,thread:1}));let scans=0;
  const visit=async(start,end,consume,ranges)=>{scans++;for(const [a] of ranges)for(const id of metrics.keys())consume({metric:id,start:a+1,duration:.001,self:.001,thread:1});};
  const result=await frameResults(iterable(intervals),()=>iterable([]),metrics,{kind:2,start:0,end:5000,minimumUs:0,search:''},false,undefined,visit);
  assert.equal(result.rows.length,500);assert(scans>1);for(const row of result.rows){assert.equal(row.calls,501);assert(Math.abs(row.self-.501)<1e-9);assert.equal(row.worstMod,'M');}
});
test('rolling exact percentiles show a short stall and expire it, FPS uses inverse duration direction',()=>{
  const frames=Array.from({length:100},(_,i)=>({id:i,start:i*10,duration:i===50?50:10,kind:2,thread:1}));
  const series=rollingSeries(frames,[500,600,900],250,false),p99=series.find(s=>s.key==='99');assert.deepEqual(p99.points.map(p=>p.value),[10,50,10]);
  const fps=rollingSeries(frames,[600],250,true);assert.equal(fps.find(s=>s.key==='99').points[0].value,20);assert.equal(fps.find(s=>s.key==='50').points[0].value,100);assert.match(fps.find(s=>s.key==='99').label,/FPS p1/);
  for(const s of series)for(const p of s.points)assert(p.count>0);
});
test('rolling order statistics match a naive oracle for many window sizes and tied durations',()=>{
  const frames=Array.from({length:300},(_,i)=>({id:i,start:i*20,duration:5+(i*17)%55,kind:2,thread:1})),times=Array.from({length:70},(_,i)=>i*100);
  for(const windowMs of [250,1000,5000])for(const rate of [false,true]){const series=rollingSeries(frames,times,windowMs,rate);for(const s of series)for(const p of s.points){const values=frames.filter(f=>f.start+f.duration<=p.time && f.start+f.duration>p.time-windowMs).map(f=>f.duration).sort((a,b)=>a-b);assert.equal(p.count,values.length);const value=s.key==='mean'?(rate?values.length*1000/values.reduce((a,b)=>a+b):values.reduce((a,b)=>a+b)/values.length):values[Math.ceil(values.length*Number(s.key)/100)-1];const expected=s.key!=='mean' && rate?1000/value:value;assert(Math.abs(p.value-expected)<1e-8);}}
});
test('frame graph preserves max duration rather than smoothing the spike away',async()=>{
  const intervals=[{id:1,start:0,duration:10,kind:2,thread:1},{id:2,start:10,duration:100,kind:2,thread:1}];
  const stream={duration:100000,async *intervals(){yield* intervals;}};const graph=await graphCapture(stream,'render-ms',0,100000,100);assert.equal(graph.points[0].value,100);assert.equal(graph.points[0].frame.id,2);assert.equal(graph.slow,1);
});
test('frame detail compares same-update intervals and keeps thread attribution separate',async()=>{
  const frames=[{id:1,start:0,duration:10,kind:2,thread:1},{id:2,start:10,duration:30,kind:2,thread:1},{id:3,start:40,duration:10,kind:2,thread:1},{id:1,start:0,duration:5,kind:1,thread:1},{id:2,start:5,duration:10,kind:1,thread:1}],events=[{metric:1,start:1,self:1,thread:1},{metric:1,start:11,self:8,thread:1},{metric:1,start:12,self:100,thread:2}];
  const stream={duration:50,metrics:new Map([[1,metric(1)]]),document:{complete:true,timeline:{}},async *intervals(){yield* frames;},async telemetry(){return {counters:[],heap:[],markers:[]};},async visitRanges(ranges,visit){for(const e of events)if(ranges.some(([a,b])=>e.start>=a && e.start<b))visit(e);}};
  const detail=await frameDetail(stream,frames[1]);assert.equal(detail.hasUpdate,true);assert.equal(detail.baseline.id,1);assert.equal(detail.baselinePopulation,1);assert.equal(detail.self,8);assert.equal(detail.baselineSelf,1);assert.equal(detail.costs[0].children[0].children[0].metric,1);
});
test('comparison detects changed hashes and labels shifted lines as tentative ordinal matches',()=>{
  const a=metric(1,10),b=metric(8,20),inventory=(m,hash)=>({sources:[{mod:m.mod,source:m.source,sha256:hash}]});const rows=compareMetrics([a],[b],inventory(a,'a'),inventory(b,'b'));assert.equal(rows[0].code,'changed');assert.equal(rows[0].identity,'ordinal');assert.equal(rows[0].meanA,1);
  const unmatched=compareMetrics([a],[b,metric(9,30)]);assert(unmatched.every(r=>r.identity==='unmatched'));
});
test('overhead estimate uses deltas, preserves unknown sampling and rejects resets',()=>{
  const a={time:100,calls:100,samples:1,wrapperMs:1,observerMs:2,auxiliaryDropped:0,contextFailures:0,errorsOmitted:0},b={...a,time:1100,calls:2148,samples:3,wrapperMs:1.2,observerMs:3};const value=overheadEstimate([a,b]);assert(Math.abs(value.wrapperMs-204.8)<1e-8);assert.equal(value.observerMs,1);assert.equal(overheadEstimate([a]),null);assert.equal(overheadEstimate([a,{...b,samples:0}]),null);
});


test('rolling percentile points identify the contributing interval inside each window, including ties and expiry',()=>{
  for(const kind of [1,2])for(const rate of [false,true]){
    let end=0;const frames=Array.from({length:180},(_,i)=>{const duration=i===20?120:i%3===0?20:10,start=end;end+=duration;return {id:i,start,duration,kind,thread:1};});
    const series=rollingSeries(frames,[200,500,750,1000,1500,2000],500,rate);
    for(const s of series.filter(s=>s.key!=='mean'))for(const point of s.points){assert(point.frame);assert(point.frame.start+point.frame.duration<=point.time);assert(point.frame.start+point.frame.duration>point.time-500);assert.equal(point.value,rate?1000/point.frame.duration:point.frame.duration);}
    const p99=series.find(s=>s.key==='99');assert.equal(p99.points.find(p=>p.time===500).frame.id,20);assert.notEqual(p99.points.find(p=>p.time===1000).frame.id,20);
  }
});
