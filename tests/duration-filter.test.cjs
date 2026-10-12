const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {StreamCapture}=require('../viewer/src/stream.ts');
const {rankCapture,rankModel,eventsCapture,treeCapture,summaryCapture}=require('../viewer/src/analysis.ts');
const query={mode:'callbacks',start:0,end:10,search:'',range:false,sort:'exclusive',descending:true,minimumUs:1000};
const metric={id:1,line:1,calls:3,errors:1,inclusive_ns:3500000,exclusive_ns:3500000,mean_ns:3500000/3,max_ns:2000000,mod:'Test',callback_id:'1',callback_name:'UPDATE',source:'main.lua',function:'pointer'};
test('duration is per call, equality is retained and small calls form an exact group',async()=>{
 const events=[.5,1,2].map((duration,i)=>({metric:1,start:i,duration,self:duration,depth:0,thread:1,error:i===0}));
 const model={document:{},metrics:new Map([[1,metric]]),events,duration:10,lanes:[],hasTimeline:true};
 const result=rankModel(model,query);
 assert.equal(result.stats.calls,2);assert.equal(result.rows[0].inclusive,3);
 assert.deepEqual(result.omitted,{calls:1,self:.5,total:.5});
 assert.equal(rankModel(model,{...query,minimumUs:0}).stats.calls,3);
 assert.equal(rankModel(model,{...query,minimumUs:5000}).rows.length,0);
 assert.equal(rankModel(model,{...query,search:'missing'}).omitted.calls,0);
 assert.equal((await treeCapture(model,query)).rows[0].calls,2);
});
test('stream filtering bypasses unfiltered summaries, caches by threshold and leaves FPS intact',async()=>{
 const fixture=fs.readFileSync(path.resolve(__dirname,'../build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim();
 const stream=new StreamCapture(new File([fs.readFileSync(fixture)],'test.isaacprof'));
 await stream.load({overview:false});await stream.prepare();
 const raw=[];for await(const e of stream.events())raw.push(e);
 const before=await summaryCapture(stream),allQuery={...query,end:stream.duration};
 for(const minimumUs of [1000,0,500,1000000,1000]){
  const q={...allQuery,minimumUs},expected=raw.filter(e=>e.duration*1000>=minimumUs),omitted=raw.filter(e=>e.duration*1000<minimumUs);
  const rank=await rankCapture(stream,q),log=await eventsCapture(stream,{...q,sort:'start',descending:false},100000);
  assert.equal(rank.stats.calls,minimumUs?expected.length:[...stream.metrics.values()].reduce((n,m)=>n+m.calls,0));
  assert.equal(log.count,expected.length);assert.equal(rank.omitted.calls,omitted.length);assert.equal(log.omitted?.calls ?? 0,omitted.length);
  assert(Math.abs(rank.omitted.self-omitted.reduce((n,e)=>n+e.self,0))<1e-5);
  const view=await stream.viewport(0,stream.duration,4096,minimumUs);
  for(let i=0;i<view.visibleCount;i++)assert(view.packed[i*10+2]*1000>=minimumUs);
 }
 const errors=await eventsCapture(stream,{...allQuery,sort:'start',descending:false,errorsOnly:true},100000);
 assert.equal(errors.count+errors.omitted.calls,raw.filter(e=>e.error).length);
 assert.deepEqual(await summaryCapture(stream),before);
});
