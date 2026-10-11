const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {StreamCapture}=require('../viewer/src/stream.ts'),{matchSources}=require('../viewer/src/source-files.ts'),{axisTime}=require('../viewer/src/trace.ts');
const dir=path.resolve(__dirname,'../build/stream-dev/Release');
const large=fs.readFileSync(path.join(dir,'large-capture-path.txt'),'utf8').trim();
function diskFile(name){const size=fs.statSync(name).size,reads=[];return {size,reads,arrayBuffer(){throw Error('Whole-file read forbidden');},slice(start,end){reads.push([start,end]);return {async arrayBuffer(){const h=await fs.promises.open(name,'r');try{const b=Buffer.alloc(end-start);const result=await h.read(b,0,b.length,start);assert.equal(result.bytesRead,b.length);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}finally{await h.close();}}};}};}
test('large trace loads metadata/index, then reads a small viewport with bounded cache',async()=>{
  const file=diskFile(large),capture=new StreamCapture(file),data=await capture.load();
  assert(data.streaming && data.count>250000 && data.packed.length===0);
  const loadedBytes=file.reads.reduce((n,[a,b])=>n+b-a,0);assert(loadedBytes<file.size*.1,`Metadata read ${loadedBytes}/${file.size}`);
  const block=capture.blocks.filter(b=>b.type===2)[Math.floor(capture.blocks.filter(b=>b.type===2).length/2)],at=block.minimum/capture.frequency*1000;
  file.reads.length=0;const view=await capture.viewport(at,at+.02,1400);
  assert(view.visibleCount>0 && view.visibleCount<5000);assert(capture.cacheBytes<=capture.cacheLimit);assert(view.packed.length===view.visibleCount*10);
  const rangeBytes=file.reads.reduce((n,[a,b])=>n+b-a,0);assert(rangeBytes<file.size*.1);
  const start=performance.now();const overview=await capture.viewport(0,data.duration,1200);assert(overview.visibleCount<=1201);assert(capture.cacheBytes<=capture.cacheLimit);
  console.log(`Whole trace: ${data.count.toLocaleString()} events; UI: ${overview.visibleCount}; full view ${(performance.now()-start).toFixed(0)} ms; metadata ${(loadedBytes/1024).toFixed(0)} KiB; zoom read ${(rangeBytes/1024).toFixed(0)} KiB`);
});
test('source matching handles Windows paths, single mods, duplicate names and ambiguity',()=>{
  const files=['Isaac/mods/a/main.lua','Isaac/mods/a/lib/util.lua','Isaac/mods/b/main.lua'].map(path=>({path,file:new File(['-- code'],path.split('/').at(-1))}));
  assert.equal(matchSources('@G:\\SteamLibrary\\Isaac\\mods\\a\\main.lua',files)[0].path,files[0].path);
  assert.equal(matchSources('@lib/util.lua',files)[0].path,files[1].path);
  assert.equal(matchSources('@main.lua',files).length,2);
  assert.equal(matchSources('=[C]',files).length,0);assert.equal(matchSources('@../main.lua',files).length,0);
});
test('new telemetry records decode, retain range baselines and reuse bounded in-memory samples',async()=>{
  const frame=fs.readFileSync(path.join(dir,'frame-capture-path.txt'),'utf8').trim(),file=diskFile(frame),capture=new StreamCapture(file);await capture.load();
  const all=await capture.telemetry(0,capture.duration);assert(all.counters.length>=6 && all.heap.length>=6 && all.markers.some(m=>m.kind===3));assert(all.inventory.sources.some(s=>s.mod==='Render stall test'));
  assert(all.counters.every(s=>s.valid===7 && s.thread>0 && s.workingSet>0));assert(all.heap.every(s=>s.bytes>0));
  file.reads.length=0;const range=await capture.telemetry(800,1400);assert.equal(file.reads.length,0);assert(range.counters[0].time<=800);assert(range.counters.every(s=>s.time<=1400));assert(range.markers.every(m=>m.time>=800 && m.time<=1400));
  assert.equal((await capture.telemetry(0,capture.duration)).counters.length,all.counters.length);
});
test('zoomed ruler labels retain distinct microsecond timestamps',()=>{
  const labels=Array.from({length:9},(_,i)=>axisTime(1027.400+i*.00125,.01));assert.equal(new Set(labels).size,labels.length);assert(labels.every(l=>l.includes('µs')));
});

test('direct block aggregation equals raw event aggregation and warm views avoid disk I/O',async()=>{
 const file=diskFile(large),capture=new StreamCapture(file);await capture.load();const block=capture.blocks.find(b=>b.type===2),start=block.minimum/capture.frequency*1000,end=start+10;
 const {rangeMetrics}=require('../viewer/src/analysis-cache.ts');const expected=await rangeMetrics(null,capture.metrics,(a,b)=>capture.events(a,b),start,end),actual=await capture.rankMetrics(start,end);const byID=new Map(actual.map(m=>[m.id,m]));
 for(const m of expected){const result=byID.get(m.id);assert.equal(result.calls,m.calls);assert.equal(result.errors,m.errors);for(const key of ['inclusive_ns','exclusive_ns','max_ns'])assert(Math.abs(result[key]-m[key])<=Math.max(1e-4,m[key]*1e-10));}
 await capture.viewport(start,end,1400);file.reads.length=0;await capture.viewport(start,end,1400);assert.equal(file.reads.length,0);
 capture.cancelled=()=>true;await assert.rejects(capture.viewport(start,end,1400),/superseded/);
});
