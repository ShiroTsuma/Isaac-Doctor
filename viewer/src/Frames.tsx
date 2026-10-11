import SortableHeader from './SortableHeader.tsx';
import {useEffect,useMemo,useState} from 'react';
import {count,ms} from './trace.ts';
import type {FrameResults,FrameRow,LoadedTrace,WorkerClient} from './types.ts';
import './frames.css';
import FrameInspector from './FrameInspector.tsx';

export default function Frames({data,range,request,inspect,setRange}:{data:LoadedTrace;range:[number,number];request:WorkerClient['request'];inspect:(frame:FrameRow,metric?:number)=>void;setRange:(range:[number,number])=>void}){
  type Sort='id'|'start'|'duration'|'self'|'calls'|'worstMod'|'metricSelf';
  const [sort,setSort]=useState<Sort>('duration'),[descending,setDescending]=useState(true);
  const [kind,setKind]=useState<1|2>(2),[minimumUs,setMinimumUs]=useState('0'),[search,setSearch]=useState('');
  const [budgetUs,setBudgetUs]=useState(()=>localStorage.getItem('isaacprof.frame-budget-us') || '16667');
  const [state,setState]=useState<{data:LoadedTrace;result?:FrameResults;error?:string}|null>(null);
  const queryKey=JSON.stringify([kind,range,minimumUs,search]);
  const [resolvedKey,setResolvedKey]=useState('');
  const [selection,setSelection]=useState<{data:LoadedTrace;frame:FrameRow}|null>(null);
  useEffect(()=>{
    let active=true;const minimum=Number(minimumUs);
    if(!Number.isSafeInteger(minimum) || minimum<0 || minimum>10000000)return;
    const timer=setTimeout(()=>{void request('frames',{kind,start:range[0],end:range[1],minimumUs:minimum,search}).then(result=>{
      if(active){setState({data,result});setResolvedKey(queryKey);}
    }).catch((error:unknown)=>{if(active){setState({data,error:error instanceof Error?error.message:'Frame analysis failed'});setResolvedKey(queryKey);}});},200);
    return()=>{active=false;clearTimeout(timer);};
  },[data,kind,range,minimumUs,search,request,queryKey]);
  const result=state?.data===data?state.result:undefined,error=state?.data===data?state.error:undefined;
  const rows=useMemo(()=>[...(result?.rows ?? [])].sort((a,b)=>{const x=a[sort],y=b[sort],value=typeof x==='string'?x.localeCompare(String(y)):Number(x)-Number(y);return (descending?-1:1)*value || a.start-b.start;}),[result,sort,descending]);
  const pending=resolvedKey!==queryKey || state?.data!==data;
  const validMinimum=Number.isSafeInteger(Number(minimumUs)) && Number(minimumUs)>=0 && Number(minimumUs)<=10000000;
  const budget=Number(budgetUs),validBudget=Number.isSafeInteger(budget) && budget>0 && budget<=10000000;
  function changeKind(value:1|2){setKind(value);setBudgetUs(value===2?'16667':'33333');}
  if(selection?.data===data)return <FrameInspector data={data} frame={selection.frame} request={request} close={()=>setSelection(null)} inspect={id=>inspect(selection.frame,id)}/>;
  return <div className="frames-panel">
    <div className="analysis-toolbar">
      <label>Clock <select id="frame-clock" value={kind} onChange={e=>changeKind(Number(e.target.value) as 1|2)}><option value="2">Render</option><option value="1">Update</option></select></label>
      <label>Min interval (µs) <input id="frame-minimum" type="number" min="0" max="10000000" step="1" value={minimumUs} aria-invalid={!validMinimum} onChange={e=>setMinimumUs(e.target.value)}/></label>
      <label>Warning (µs) <input id="frame-budget" type="number" min="1" max="10000000" step="1" value={budgetUs} aria-invalid={!validBudget} onChange={e=>{setBudgetUs(e.target.value);if(Number.isSafeInteger(Number(e.target.value)) && Number(e.target.value)>0)localStorage.setItem('isaacprof.frame-budget-us',e.target.value);}}/></label>
      <input type="search" aria-label="Filter slowest frame activities" placeholder="Filter slowest 500" value={search} onChange={e=>setSearch(e.target.value)}/>
    </div>
    <div className="frame-stats" aria-live="polite">
      {result && <>{[[kind===2?'FPS':'UPS',result.count?result.rate.toFixed(1):'\u2014'],['Interval p50',result.count?ms(result.p50):'\u2014'],['Interval p95',result.count?ms(result.p95):'\u2014'],['Interval p99',result.count?ms(result.p99):'\u2014'],['Mean',result.count?ms(result.mean):'\u2014'],['Max',result.count?ms(result.maximum):'\u2014'],['Intervals',count(result.count)]].map(([label,value])=><span key={label}><small>{label}</small><b>{value}</b></span>)}<span title="Approximate median cadence: 1000 / interval p50"><small>{kind===2?'FPS':'UPS'} p50</small><b>{result.p50?(1000/result.p50).toFixed(1):'\u2014'}</b></span><span title="Approximate lower cadence percentile: 1000 / interval p95. This is a percentile, not the average of the slowest 5%."><small>{kind===2?'FPS':'UPS'} p5</small><b>{result.p95?(1000/result.p95).toFixed(1):'\u2014'}</b></span></>}
      <output>{!validMinimum?'Enter a whole number from 0 to 10,000,000 µs.':pending?'Analyzing frame intervals…':error || (result?.incomplete?'Incomplete recording / buffer losses':'')}</output>
    </div>
    {result && !pending && !error && <><div className="analysis-table-scroll"><table><SortableHeader columns={([['id','Interval'],['start','Start'],['duration','Wall time'],['self','Callback self'],['calls','Calls'],['worstMod','Costliest mod'],['metricSelf','Costliest callback (self)']] as [Sort,string][]).map(([key,label])=>({key,label}))} sort={sort} descending={descending} onSort={key=>{if(sort===key)setDescending(!descending);else{setSort(key);setDescending(key!=='worstMod' && key!=='start' && key!=='id');}}}/><tbody id="frame-rows">
      {rows.map(f=>{const metric=data.metrics.find(m=>m.id===f.worstMetric);return <tr key={`${f.thread}:${f.id}`} className={validBudget && f.duration*1000>budget?'slow-frame':''}>
        <td><button className="row-button" onClick={()=>setSelection({data,frame:f})} aria-label={`Inspect ${kind===2?'render':'update'} interval ${f.id}`}>#{f.id}</button></td><td>{ms(f.start)}<span className="source-inline">{kind===2?(f.hasUpdate?'with update':'no update'):''}</span></td><td>{ms(f.duration)}</td><td>{ms(f.self)}</td><td>{count(f.calls)}</td><td>{f.worstMod || '—'} {f.worstMod && <span className="quiet">{ms(f.modSelf)}</span>}</td>
        <td>{metric?<button className="row-button" onClick={()=>inspect(f,metric.id)}>{metric.callback_name || metric.callback_id} <span className="quiet">{ms(f.metricSelf)}</span></button>:'—'}</td>
      </tr>;})}
    </tbody></table>{!result.count && <div className="no-analysis">{result.sessionCount?'No complete frame intervals fit inside this selection. Expand the range to include a whole frame.':data.document.configuration && !(data.document.configuration.channels & (kind===2?4:8))?'The selected frame channel was disabled for this recording.':'This recording has no frame intervals for the selected clock.'}{result.enclosingRange && <button id="show-enclosing-frame" className="small-button" onClick={()=>{if(result.enclosingRange)setRange(result.enclosingRange);}}>Show enclosing frame</button>}</div>}</div>
    <div className="table-status">Sorting slowest {count(result.rows.length)} of {count(result.slow)} matching intervals · percentile error ≤0.1% · rate = intervals / observed wall time</div></>}
    <div className="frame-note">Between consecutive MC_POST_{kind===2?'RENDER':'UPDATE'} markers; includes waiting. Callback breakdown uses retained calls starting in the interval, including their full self time. Update and render intervals overlap; do not add their totals. First and last partial intervals are omitted.</div>
  </div>;
}
