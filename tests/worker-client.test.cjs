const test=require('node:test'),assert=require('node:assert/strict');
const {createWorker}=require('../viewer/src/trace.ts');
test('closing workers rejects in-flight and future requests, suppresses stale progress',async()=>{
 const original=global.Worker,workers=[];
 global.Worker=class{constructor(){workers.push(this);}postMessage(message){this.message=message;}terminate(){this.terminated=true;}};
 try{
  const progress=[],client=createWorker(value=>progress.push(value)),load=client.request('load',{file:new File(['trace'],'test.isaacprof')});
  client.close();await assert.rejects(load,/Worker closed/);assert(workers.every(w=>w.terminated));
  workers[0].onmessage({data:{id:workers[0].message.id,progress:{percent:99}}});assert.deepEqual(progress,[]);
  await assert.rejects(client.request('rank',{}),/Worker closed/);
 }finally{global.Worker=original;}
});
