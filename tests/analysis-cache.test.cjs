const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {prepareAnalysis,cachedFrames,cachedMetrics,rangeMetrics,encodeAnalysis,decodeAnalysis}=require('../viewer/src/analysis-cache.ts');
const {StreamCapture}=require('../viewer/src/stream.ts');
const {saveAnalysis}=require('../viewer/src/save-analysis.ts');
test('cancelling prepared analysis aborts the pending write and never commits it',async()=>{
 const file=new File([new Uint8Array(100)],'capture-1-test.isaacprof'),abort=new AbortController();
 let entered,finish;const writing=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>finish=resolve);
 let aborted=0,closed=0;
 const handle={getFile:async()=>file,createWritable:async()=>({seek:async()=>{},write:async()=>{entered();await blocked;},truncate:async()=>{},close:async()=>{closed++;},abort:async()=>{aborted++;finish();}})};
 const saving=saveAnalysis(handle,file,100,new Uint8Array([1,2,3]),abort.signal);
 await writing;abort.abort();await assert.rejects(saving,{name:'AbortError'});assert(aborted>0);assert.equal(closed,0);
 await assert.rejects(saveAnalysis(handle,file,100,new Uint8Array([1]),abort.signal),{name:'AbortError'});
});
async function* list(values){yield* values;}
const metrics=new Map([[1,{id:1,mod:'A',calls:0,errors:0,inclusive_ns:0,exclusive_ns:0,max_ns:0,mean_ns:0}]]);
const events=[0,24.999,25,49.999,50,75,99].map((start,i)=>({metric:1,start,duration:i+1,self:(i+1)/2,error:i===2}));
const intervals=[10,10,10,50].map((duration,i)=>({id:i+1,start:i*25,duration,kind:2,thread:1}));
test('binary hierarchy preserves weighted FPS, quantiles and arbitrary range edges',async()=>{
 const cache=await prepareAnalysis(100,list(events),list(intervals),new Float64Array(400));
 assert.equal(cachedFrames(cache,[0,4],2).rate,50);assert.equal(cachedFrames(cache,[2,4],2).mean,30);
 assert(cachedFrames(cache,[0,4],2).p50>=10 && cachedFrames(cache,[0,4],2).p50<10.011);
 assert.equal(cachedFrames(cache,[0,4],2).p95,50);
 assert.equal(cachedMetrics(cache,[0,2],metrics)[0].calls,4);
 const round=decodeAnalysis(encodeAnalysis(cache).buffer,metrics,100);assert.deepEqual(cachedFrames(round,[0,4],2),cachedFrames(cache,[0,4],2));
 for(const [a,b] of [[0,100],[25,75],[13,87],[25.0000000001,75],[0,24.999],[0,50.0000000001]]){
  const reads=[];const query=(x,y)=>{reads.push([x,y]);return list(events);};
  const actual=await rangeMetrics(round,metrics,query,a,b),raw=await rangeMetrics(null,metrics,()=>list(events),a,b);assert.deepEqual(actual,raw);
  if(a===25 && b===75)assert.equal(reads.length,0);
 }
});
test('stored analysis reopens without scanning event blocks; broken appendix keeps sealed capture readable',async()=>{
 const root=path.resolve(__dirname,'../build/stream-dev/Release'),fixture=fs.readFileSync(path.join(root,'frame-capture-path.txt'),'utf8').trim(),bytes=fs.readFileSync(fixture);
 const capture=new StreamCapture(new File([bytes],'test.isaacprof'));await capture.load();await capture.prepare();const {appendix,sourceSize}=await capture.appendix();assert.equal(sourceSize,bytes.length);
 const combined=new Uint8Array(bytes.length+appendix.length);combined.set(bytes);combined.set(appendix,bytes.length);
 const file=new File([combined],'test.isaacprof'),reads=[],disk={size:file.size,slice(a,b){reads.push([a,b]);return file.slice(a,b);}};
 const stored=new StreamCapture(disk),loaded=await stored.load();assert(loaded.document.complete);assert.equal(loaded.analysis.state,'stored');assert.deepEqual(stored.analysisInfo().render,capture.analysisInfo().render);
 for(const block of stored.blocks.filter(b=>b.type===2))assert(!reads.some(([a,b])=>a<=block.offset+48 && b>=block.offset+48+block.bytes),'Raw event payload read');
 for(const data of [combined.slice(0,-10),combined.slice()]){if(data.length===combined.length)data[bytes.length+32]^=1;const broken=new StreamCapture(new File([data],'broken.isaacprof'));assert((await broken.load()).document.complete);assert.equal(broken.analysis,null);await broken.prepare();assert.deepEqual(broken.analysisInfo().render,capture.analysisInfo().render);}
 const out=path.resolve(__dirname,'../build/analysis-cache-qa');fs.mkdirSync(out,{recursive:true});const saved=path.join(out,'analyzed.isaacprof');fs.writeFileSync(saved,combined);
 const {execFileSync}=require('node:child_process');assert.equal(execFileSync('python',['-c','import sys;sys.path.insert(0,"tools");from capture import read_capture;print(read_capture(sys.argv[1])["complete"])',saved],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'}).trim(),'True');
});
test('saving rejects changed recordings and preserves original binary prefix',async()=>{
 let current=new File([new Uint8Array(100)],'test.isaacprof',{lastModified:1}),writes=0,buffer=Buffer.from(await current.arrayBuffer()),position=0;
 const handle={async getFile(){return current;},async createWritable(){writes++;return {async seek(p){position=p;},async write(b){buffer=Buffer.concat([buffer.subarray(0,position),Buffer.from(b)]);},async truncate(n){buffer=buffer.subarray(0,n);},async close(){current=new File([buffer],'test.isaacprof',{lastModified:2});},async abort(){}};}};
 const original=current,fresh=await saveAnalysis(handle,original,100,new Uint8Array([1,2,3]));assert.equal(fresh.size,103);assert.deepEqual(buffer.subarray(0,100),Buffer.alloc(100));
 await assert.rejects(saveAnalysis(handle,original,100,new Uint8Array([4])),/changed/);assert.equal(writes,1);
});

test('v2 overview persists identities, avoids full-session payload reads and keeps zoom exact',async()=>{
 const fixture=fs.readFileSync(path.resolve(__dirname,'../build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim(),bytes=fs.readFileSync(fixture);
 const capture=new StreamCapture(new File([bytes],'fixture')),progress=[];capture.onProgress=p=>progress.push(p);await capture.load({overview:false});await capture.prepare();
 assert(progress.some(p=>p.stage==='Callback analysis' && p.percent===0));assert(progress.some(p=>p.stage==='Callback analysis' && p.percent===100));assert(progress.every(p=>p.completed<=p.total && p.percent>=0 && p.percent<=100));
 assert(capture.bins.some(x=>x>0),'Headless preparation must populate bins without overview header reads');
 const before=await capture.viewport(0,capture.duration,4096),{appendix,sourceSize}=await capture.appendix(),combined=Buffer.concat([bytes.subarray(0,sourceSize),appendix]);
 let reads=0;const disk=new File([combined],'stored'),stored=new StreamCapture({size:disk.size,slice(a,b){reads++;return disk.slice(a,b);}});await stored.load({overview:false});const loadedReads=reads;
 assert(stored.analysis.overview.events.length>0);assert.deepEqual((await stored.viewport(0,stored.duration,4096)).packed,before.packed);await stored.viewport(0,stored.duration,1400);assert.equal(reads,loadedReads,'Whole-session LOD must perform zero event reads');
 const cached=await stored.viewport(0,stored.duration/2,1400);assert(reads>loadedReads,'Zoom must return to native indexed blocks');stored.analysis.overview=undefined;assert.deepEqual((await stored.viewport(0,stored.duration/2,1400)).packed,cached.packed);
 const base=capture.analysis,encoded=encodeAnalysis({...base,overview:undefined}),legacy=encoded.slice(0,-8);
 const v1=decodeAnalysis(legacy.buffer,capture.metrics,capture.duration,1);assert(!v1.overview);assert.deepEqual(v1.summaries,base.summaries);
 assert.throws(()=>decodeAnalysis(legacy.buffer,capture.metrics,capture.duration,2),/Truncated/);
 const malformed=encodeAnalysis(base),offset=malformed.length-base.overview.events.length*80;new DataView(malformed.buffer).setFloat64(offset+6*8,2,true);assert.throws(()=>decodeAnalysis(malformed.buffer,capture.metrics,capture.duration),/overview event/);
});
