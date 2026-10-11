import type {StreamCapture} from './stream.ts';
import type {FrameInterval} from './types.ts';
export type GraphKind='render-ms'|'render-percentiles'|'fps'|'update-ms'|'update-percentiles'|'ups'|'self'|'calls'|'cpu'|'heap'|'entities'|'projectiles'|'effects';
export interface GraphPoint {time:number;value:number;frame?:FrameInterval;count?:number;maximum?:number}
export interface GraphSeries {key:string;label:string;color:string;points:GraphPoint[]}
export interface GraphResult {points:GraphPoint[];series?:GraphSeries[];unit:string;label:string;aggregation:string;slow?:number;count?:number;budget?:number}
// Fenwick order statistics keeps exact rolling percentiles in O(log N) per
// insertion/removal/query rather than sorting a window for every chart pixel.
export function rollingSeries(frames:FrameInterval[],times:number[],windowMs:number,rate:boolean):GraphSeries[]{
  const sorted=frames.slice().sort((a,b)=>a.start+a.duration-b.start-b.duration),values=[...new Set(frames.map(f=>f.duration))].sort((a,b)=>a-b),indices=new Map(values.map((v,i)=>[v,i+1])),tree=new Uint32Array(values.length+1);
  const rateName=frames[0]?.kind===1?'UPS':'FPS';
  const series:GraphSeries[]=[{key:'mean',label:rate?'Mean cadence':'Mean interval',color:'#8ab4f8',points:[]},...[50,90,95,99].map(p=>({key:String(p),label:rate?`p${p} interval → ${rateName} p${100-p}`:`Interval p${p}`,color:({50:'#81c995',90:'#fdd663',95:'#ffad66',99:'#f28b82'} as Record<number,string>)[p],points:[]}))];
  const active=new Map<number,Set<FrameInterval>>();
  const change=(frame:FrameInterval,delta:number)=>{const value=frame.duration;for(let i=indices.get(value)!;i<tree.length;i+=i&-i)tree[i]+=delta;let matches=active.get(value);if(delta>0){if(!matches){matches=new Set();active.set(value,matches);}matches.add(frame);}else{matches?.delete(frame);if(!matches?.size)active.delete(value);}};
  const kth=(target:number)=>{let index=0;for(let step=2**Math.floor(Math.log2(Math.max(1,values.length)));step;step>>=1){const next=index+step;if(next<tree.length && tree[next]<target){target-=tree[next];index=next;}}return values[index];};
  let a=0,b=0,total=0;
  for(const time of times){while(b<sorted.length && sorted[b].start+sorted[b].duration<=time){change(sorted[b],1);total+=sorted[b].duration;b++;}while(a<b && sorted[a].start+sorted[a].duration<=time-windowMs){change(sorted[a],-1);total-=sorted[a].duration;a++;}const count=b-a;if(!count)continue;
    series[0].points.push({time,value:rate?count*1000/total:total/count,count});
    for(let i=1;i<series.length;i++){const value=kth(Math.ceil(count*Number(series[i].key)/100)),frame=active.get(value)?.values().next().value;series[i].points.push({time,value:rate?1000/value:value,count,frame});}
  }return series;
}
export async function graphCapture(stream:StreamCapture,kind:GraphKind,start:number,end:number,columns=1000,windowMs=1000):Promise<GraphResult>{
  if(!Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || end>stream.duration+.001)throw Error('Invalid graph range.');
  columns=Math.max(100,Math.min(2000,Math.round(columns)));const span=end-start,bucket=(time:number)=>Math.max(0,Math.min(columns-1,Math.floor((time-start)/span*columns)));
  const buckets=new Map<number,{time:number;total:number;count:number;maximum:number;frame?:FrameInterval}>();
  if(['render-ms','render-percentiles','fps','update-ms','update-percentiles','ups'].includes(kind)){
    if(!Number.isSafeInteger(windowMs) || windowMs<250 || windowMs>10000)throw Error('Rolling window must be 250..10,000 ms.');
    const clock=kind.startsWith('render') || kind==='fps'?2:1,budget=clock===2?1000/60:1000/30,rolling=kind==='fps' || kind==='ups' || kind.endsWith('percentiles'),frames:FrameInterval[]=[];let slow=0,count=0;
    for await(const frame of stream.intervals(Math.max(0,start-(rolling?windowMs:0)),end)){if(frame.kind!==clock || frame.start+frame.duration>end)continue;
      if(rolling){frames.push(frame);if(frames.length>200000)throw Error('Graph exceeds 200,000 intervals; select a smaller range.');}
      if(frame.start<start)continue;
      count++;if(frame.duration>budget)slow++;const key=bucket(frame.start),old=buckets.get(key);
      if(!old)buckets.set(key,{time:frame.start,total:frame.duration,count:1,maximum:frame.duration,frame});
      else {old.total+=frame.duration;old.count++;if(frame.duration>old.maximum){old.maximum=frame.duration;old.time=frame.start;old.frame=frame;}}
    }
    const rate=kind==='fps' || kind==='ups';return {points:[...buckets.values()].sort((a,b)=>a.time-b.time).map(p=>({time:p.time,value:rate?p.count*1000/p.total:p.maximum,frame:p.frame,count:p.count,maximum:p.maximum})),series:rolling?rollingSeries(frames,Array.from({length:columns},(_,i)=>start+(i+1)*span/columns),windowMs,rate):undefined,unit:rate?(clock===2?'FPS':'UPS'):'ms',label:clock===2?'Render cadence':'Update cadence',aggregation:rolling?`Exact rolling ${windowMs} ms window by interval completion; p99 is noisy with few intervals. Red marks retain slowest intervals.`:'Maximum interval per bucket; short stalls remain visible',slow,count,budget:rate?undefined:budget};
  }
  if(kind==='self' || kind==='calls'){
    await stream.visitEvents(start,end,(_event,_metric,ticks,_duration,self)=>{const time=ticks/stream.frequency*1000;if(time<start || time>=end)return;const key=bucket(time);let p=buckets.get(key);if(!p){p={time:start+(key+.5)*span/columns,total:0,count:0,maximum:0};buckets.set(key,p);}p.total+=self/stream.frequency*1000;p.count++;});
    return {points:[...buckets.values()].sort((a,b)=>a.time-b.time).map(p=>({time:p.time,value:(kind==='self'?p.total:p.count)*1000/(span/columns)})),unit:kind==='self'?'ms/s':'calls/s',label:kind==='self'?'Retained callback self':'Retained callback frequency',aggregation:'Sum per bucket / bucket duration; filtered and dropped calls are omitted'};
  }
  const telemetry=await stream.telemetry(start,end);const points:GraphPoint[]=[];
  if(kind==='cpu'){for(let i=1;i<telemetry.counters.length;i++){const a=telemetry.counters[i-1],b=telemetry.counters[i],elapsed=b.time-a.time,delta=b.threadUser+b.threadKernel-a.threadUser-a.threadKernel;if((a.valid&4) && (b.valid&4) && a.thread===b.thread && elapsed>0 && delta>=0)points.push({time:b.time,value:delta/10000/elapsed*100});}}
  else if(kind==='heap')for(const p of telemetry.heap)points.push({time:p.time,value:p.bytes/1048576});
  else for(const p of telemetry.context ?? [])points.push({time:p.time,value:p[kind as 'entities'|'projectiles'|'effects']});
  const selected=new Map<number,GraphPoint>();for(const p of points){if(p.time<start || p.time>end)continue;const key=bucket(p.time),old=selected.get(key);if(!old || old.value<p.value)selected.set(key,p);}
  return {points:[...selected.values()].sort((a,b)=>a.time-b.time),unit:kind==='cpu'?'% of one core':kind==='heap'?'MiB':'entities',label:kind==='cpu'?'Lua thread CPU':kind==='heap'?'Lua VM heap':kind[0].toUpperCase()+kind.slice(1),aggregation:'Maximum sampled value per bucket; samples every 250 ms'};
}
