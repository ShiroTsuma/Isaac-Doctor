const test=require('node:test'),assert=require('node:assert/strict');
const {frameResults}=require('../viewer/src/frames.ts');
const {captureFileName,completedCapture,captureEntries}=require('../viewer/src/capture-folder.ts');
test('directory enumeration reads new captures and subfolders on every refresh',async()=>{
 const entries=[];
 const directory={kind:'directory',name:'captures',queryPermission:async()=> 'granted',values:()=>iterable(entries)};
 const file=(name,time)=>({kind:'file',name,getFile:async()=>new File(['trace'],name,{lastModified:time})});
 entries.push(file('capture-1-old.isaacprof',10),file('notes.txt',50));
 assert.deepEqual((await captureEntries(directory)).map(x=>x.key),['capture-1-old.isaacprof']);
 entries.push({kind:'directory',name:'nested',values:()=>iterable([file('capture-2-new.isaacprof',20)])});
 const fresh=await captureEntries(directory);assert.deepEqual(fresh.map(x=>x.key),['nested/capture-2-new.isaacprof','capture-1-old.isaacprof']);assert.equal(fresh[1].handle,entries[0]);
 await assert.rejects(captureEntries({...directory,queryPermission:async()=> 'prompt'}),/Reconnect/);
});
async function* iterable(items){yield* items;}
const metrics=new Map([[1,{id:1,mod:'A',callback_name:'update'}],[2,{id:2,mod:'B',callback_name:'child'}],[3,{id:3,mod:'B',callback_name:'other'}]]);
test('render FPS and quantiles use measured intervals; nested self costs select mod and callback separately',async()=>{
  const intervals=[10,10,10,50].map((duration,i,a)=>({id:i+1,start:a.slice(0,i).reduce((x,y)=>x+y,0),duration,kind:2,thread:7}));
  intervals.push({id:1,start:0,duration:80,kind:1,thread:7});
  const events=[{metric:1,start:31,duration:15,self:5,depth:0,thread:7},{metric:2,start:32,duration:7,self:4,depth:1,thread:7},{metric:3,start:40,duration:4,self:4,depth:0,thread:7}, {metric:1,start:80,duration:99,self:99,thread:7}];
  const r=await frameResults(iterable(intervals),()=>iterable(events),metrics,{kind:2,start:0,end:80,minimumUs:0,search:''},false);
  assert.equal(r.count,4);assert.equal(r.rate,50);assert.equal(r.mean,20);assert.equal(r.maximum,50);
  assert(r.p50>=10 && r.p50<=10.01);assert.equal(r.p95,50);assert.equal(r.p99,50);
  assert.equal(r.rows[0].calls,3);assert.equal(r.rows[0].self,13);assert.equal(r.rows[0].worstMod,'B');assert.equal(r.rows[0].modSelf,8);assert.equal(r.rows[0].worstMetric,1);assert.equal(r.rows[0].metricSelf,5);
  const filtered=await frameResults(iterable(intervals),()=>iterable(events),metrics,{kind:2,start:0,end:80,minimumUs:10001,search:''},true);
  assert.equal(filtered.rows.length,1);assert.equal(filtered.count,4);assert.equal(filtered.rate,50);assert(filtered.incomplete);
});
test('frame analysis keeps only 500 slowest intervals and cannot invent FPS without markers',async()=>{
  const rows=Array.from({length:5000},(_,i)=>({id:i+1,start:i*20,duration:10+i/1000,kind:2,thread:7}));
  const r=await frameResults(iterable(rows),()=>iterable([]),metrics,{kind:2,start:0,end:100000,minimumUs:0,search:''},false);
  assert.equal(r.count,5000);assert.equal(r.rows.length,500);assert.equal(r.rows[0].id,5000);assert.equal(r.rows.at(-1).id,4501);
  const empty=await frameResults(iterable([]),()=>iterable([]),metrics,{kind:2,start:0,end:100,minimumUs:0,search:''},false);assert.equal(empty.rate,0);
});
test('completed recordings use the selected directory handle and fresh File, never the controller path',async()=>{
  assert.equal(captureFileName('G:\\Isaac\\captures\\capture-42-123.isaacprof'),'capture-42-123.isaacprof');
  assert.throws(()=>captureFileName('../../main.lua'));
  let seen;const file=new File(['trace'],'capture-42-123.isaacprof');
  const directory={name:'captures',queryPermission:async()=> 'granted',getFileHandle:async name=>{seen=name;return {getFile:async()=>file};}};
  assert.equal(await completedCapture(directory,'G:\\Isaac\\captures\\capture-42-123.isaacprof'),file);assert.equal(seen,file.name);
  await assert.rejects(()=>completedCapture({...directory,queryPermission:async()=> 'prompt'},file.name),/Reconnect/);
});

test('a sub-frame callback selection identifies an enclosing frame instead of claiming the recording lacks markers',async()=>{
 const {framesCapture}=require('../viewer/src/analysis.ts'),{StreamCapture}=require('../viewer/src/stream.ts');
 const stream=Object.create(StreamCapture.prototype);stream.duration=40;stream.metrics=metrics;stream.document={complete:true,timeline:{dropped_events:0}};stream.analysis=null;
 stream.intervals=async function*(){yield {id:1,start:0,duration:20,kind:2,thread:7};yield {id:2,start:20,duration:20,kind:2,thread:7};};
 stream.events=async function*(){};
 const result=await framesCapture(stream,{kind:2,start:5,end:5.1,minimumUs:0,search:''},false);
 assert.equal(result.count,0);assert.equal(result.sessionCount,2);assert.deepEqual(result.enclosingRange,[0,20]);
});
