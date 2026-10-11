import type {LoadedTrace,Lane,TraceEvent,WorkerClient,WorkerOperations} from './types.ts';
import type {ProcessingProgress} from './stream.ts';
export const ms=(n:number)=>`${n.toLocaleString('en-US',{maximumFractionDigits:2})} ms`;
export function axisTime(n:number,span:number){if(span<1)return `${(n*1000).toLocaleString('en-US',{maximumFractionDigits:Math.min(3,Math.max(0,Math.ceil(-Math.log10(span))))})} µs`;return `${n.toLocaleString('en-US',{maximumFractionDigits:Math.min(6,Math.max(0,Math.ceil(-Math.log10(span/10))))})} ms`;}
export const count=(n:number)=>n.toLocaleString('en-US');
const palette=['#d6b65a','#a886c4','#7cac78','#7f9dd0','#c78f69','#b590b9','#80aaa6','#ba9c63'];
export function color(name:string){let hash=0;for(const c of name)hash=(hash*31+c.charCodeAt(0))|0;return palette[Math.abs(hash)%palette.length];}
export function eventAt(data:LoadedTrace,index:number):TraceEvent{const a=data.packed,i=index*(data.stride ?? 7);return {index:data.stride===10?a[i+7]:index,span:data.stride===10?a[i+8]:undefined,parent:data.stride===10?a[i+9]:undefined,metric:a[i],start:a[i+1],duration:a[i+2],self:a[i+3],depth:a[i+4],thread:a[i+5],error:!!a[i+6]};}
export function visibleIndices(data:LoadedTrace,lane:Lane,start:number,end:number){const a=data.packed,ids=lane.indices;let lo=0,hi=ids.length;while(lo<hi){const mid=(lo+hi)>>1,i=ids[mid]*(data.stride ?? 7);if(a[i+1]+a[i+2]<start)lo=mid+1;else hi=mid;}const found:number[]=[];for(let i=lo;i<ids.length && a[ids[i]*(data.stride ?? 7)+1]<=end;i++)found.push(ids[i]);return found;}
export function createWorker(onProgress?:(progress:ProcessingProgress)=>void):WorkerClient{
  const analysis=new Worker(new URL('./trace.worker.ts',import.meta.url),{type:'module',name:'isaacprof-analysis'});
  const timeline=new Worker(new URL('./trace.worker.ts',import.meta.url),{type:'module',name:'isaacprof-timeline'});
  let sequence=0,generation=0,loading=false,closed=false;
  const pending=new Map<number,{resolve:(result:unknown)=>void;reject:(error:Error)=>void}>();
  analysis.onmessage=timeline.onmessage=(event:MessageEvent<{id:number;result:unknown;error?:string;progress?:ProcessingProgress}>)=>{
    const data=event.data,request=pending.get(data.id);if(!request)return;if(data.progress){onProgress?.(data.progress);return;}pending.delete(data.id);
    if(data.error)request.reject(Error(data.error));else request.resolve(data.result);
  };
  analysis.onerror=timeline.onerror=event=>{loading=false;for(const request of pending.values())request.reject(Error(event.message || 'Worker failed'));pending.clear();};
  function send<K extends keyof WorkerOperations>(worker:Worker,type:K,payload:WorkerOperations[K]['payload']):Promise<WorkerOperations[K]['result']>{
    const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve:result=>resolve(result as WorkerOperations[K]['result']),reject});worker.postMessage({id,type,payload});});
  }
  return {
    async request<K extends keyof WorkerOperations>(type:K,payload:WorkerOperations[K]['payload']):Promise<WorkerOperations[K]['result']>{
      if(closed)throw Error('Worker closed');
      if(type==='load'){
        const epoch=++generation;loading=true;
        for(const request of pending.values())request.reject(Error('Recording changed.'));pending.clear();
        try{const [result]=await Promise.all([send(analysis,type,payload),send(timeline,type,payload)]);return result;}
        finally{if(generation===epoch)loading=false;}
      }
      if(loading)throw Error('Recording is loading.');
      return send(type==='viewport'?timeline:analysis,type,payload);
    },
    close(){closed=true;generation++;loading=false;analysis.terminate();timeline.terminate();for(const request of pending.values())request.reject(Error('Worker closed'));pending.clear();},
  };
}
