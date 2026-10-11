import {useCallback,useEffect,useRef,useState} from 'react';
import {readRecordingConfig,triggerOptions,validRecordingConfig,effectiveRecordingConfig,readCaptureScope,channelOptions} from './recording-config.ts';
import type {CaptureTrigger,RecordingConfig} from './recording-config.ts';

export interface RecordingStatus {ok:boolean;state:string;message:string;report:string;elapsedMs?:number;durationMs?:number;updatedAt?:number;availableTriggers?:string[];captureScope?:boolean}
type Status=RecordingStatus;
function parseStatus(value:unknown):Status{
  if(!value || typeof value!=='object' || !('ok' in value) || typeof value.ok!=='boolean' || !('state' in value) || typeof value.state!=='string' || !('message' in value) || typeof value.message!=='string' || !('report' in value) || typeof value.report!=='string')throw Error('Invalid controller response');
  return {ok:value.ok,state:value.state,message:value.message,report:value.report,elapsedMs:'elapsedMs' in value && typeof value.elapsedMs==='number'?value.elapsedMs:0,durationMs:'durationMs' in value && typeof value.durationMs==='number'?value.durationMs:0,updatedAt:performance.now(),captureScope:'captureScope' in value && value.captureScope===true,availableTriggers:'availableTriggers' in value && Array.isArray(value.availableTriggers) && value.availableTriggers.every((item:unknown)=>typeof item==='string')?value.availableTriggers:undefined};
}
async function controllerJson(response:Response):Promise<unknown>{
  if(!response.headers.get('Content-Type')?.includes('application/json'))throw Error('The local server is unavailable. Start Isaac Doctor and reload this page.');
  const value:unknown=await response.json();
  if(!response.ok)throw Error(value && typeof value==='object' && 'message' in value && typeof value.message==='string'?value.message:'Controller request failed');
  return value;
}
export default function RecordingControls({onStatus}:{onStatus:(status:Status)=>void}){
  const [status,setStatus]=useState<Status>({ok:false,state:'disconnected',message:'',report:''});
  const [seconds,setSeconds]=useState(25),[screenshots,setScreenshots]=useState(true),[screenshotMs,setScreenshotMs]=useState(500),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [config,setConfig]=useState(readRecordingConfig);
  const [scope,setScope]=useState(readCaptureScope),[catalog,setCatalog]=useState<{mods:string[];hooks:string[]}>({mods:[],hooks:[]});
  const [scopeError,setScopeError]=useState('');
  const [catalogState,setCatalogState]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const catalogRequest=useRef<AbortController|null>(null);
  const [drafts,setDrafts]=useState(()=>({selectedMods:scope.selectedMods.join('\n'),selectedHooks:scope.selectedHooks.join('\n')}));
  function selectScope(next:typeof scope){setDrafts({selectedMods:next.selectedMods.join('\n'),selectedHooks:next.selectedHooks.join('\n')});setScope(next);localStorage.setItem('isaacprof.capture-scope',JSON.stringify(next));}
  const loadCatalog=useCallback(async()=>{
    catalogRequest.current?.abort();
    const abort=new AbortController();catalogRequest.current=abort;
    setScopeError('');setCatalogState('loading');
    try{
      const value=await controllerJson(await fetch('/api/catalog',{signal:abort.signal}));
      if(!value || typeof value!=='object' || !('mods' in value) || !Array.isArray(value.mods) || !value.mods.every((v:unknown)=>typeof v==='string') || !('hooks' in value) || !Array.isArray(value.hooks) || !value.hooks.every((v:unknown)=>typeof v==='string'))throw Error('Invalid callback catalog');
      if(!abort.signal.aborted){setCatalog({mods:value.mods,hooks:value.hooks});setCatalogState('ready');}
    }catch(error){
      if(!abort.signal.aborted){setCatalog({mods:[],hooks:[]});setCatalogState('error');setScopeError(error instanceof Error?error.message:'Could not read callback catalog');}
    }
  },[]);
  useEffect(()=>{
    if(status.ok && status.state==='ready')void loadCatalog();
    return()=>catalogRequest.current?.abort();
  },[status.ok,status.state,loadCatalog]);

  function configure<K extends keyof RecordingConfig>(key:K,value:RecordingConfig[K]){setConfig(previous=>{const next={...previous,[key]:value};if(validRecordingConfig(next))localStorage.setItem('isaacprof.recording-triggers',JSON.stringify(effectiveRecordingConfig(next)));return next;});}
  const inFlight=useRef(false),sequence=useRef(0);
  const serverClosed=status.state==='server-stopped' || status.state==='server-unavailable';
  const [minimumUs,setMinimumUs]=useState(()=>{const saved=Number(localStorage.getItem('isaacprof.minimum-us'));return Number.isInteger(saved) && saved>=0 && saved<=1000000?saved:0;});
  useEffect(()=>{
    if(serverClosed)return;
    const abort=new AbortController();
    const update=async()=>{if(inFlight.current)return;const id=sequence.current;try{const response=await fetch('/api/status',{signal:abort.signal});const next=parseStatus(await controllerJson(response));if(!abort.signal.aborted && id===sequence.current){setStatus(next);onStatus(next);}}catch{if(!abort.signal.aborted && id===sequence.current){const unavailable={ok:false,state:'server-unavailable',message:'Local server unavailable. Start Isaac Doctor, then reload this page.',report:''};setStatus(unavailable);onStatus(unavailable);}}};
    void update();const timer=setInterval(()=>void update(),1500);return()=>{abort.abort();clearInterval(timer);};
  },[onStatus,serverClosed]);
  async function command(command:'attach'|'record'|'stop'|'shutdown'){
    if(inFlight.current)return;inFlight.current=true;sequence.current++;setBusy(true);setError('');
    if(command==='stop')onStatus({...status,state:'saving'});
    try{
      const sessionResponse=await fetch('/api/session');
      const session=await controllerJson(sessionResponse);if(!session || typeof session!=='object' || !('token' in session) || typeof session.token!=='string')throw Error('Invalid controller session');
      if(command==='record' && (!Number.isInteger(minimumUs) || minimumUs<0 || minimumUs>1000000))throw Error('Minimum duration must be an integer from 0 to 1,000,000 µs.');
      const effective=effectiveRecordingConfig(config);
      if(command==='record' && !validRecordingConfig(config))throw Error('Delays must be 0..3,600,000 ms; enabled maximum duration must be 1..3,600 whole seconds. Empty delays mean 0.');
      if(command==='record' && config.stopOn==='duration' && (!Number.isInteger(seconds) || seconds<1 || seconds>3600))throw Error('Recording duration must be 1..3,600 whole seconds.');
      if(command==='record' && !status.availableTriggers && (config.startDelayMs || config.stopDelayMs || !['immediate','run-load'].includes(config.startOn) || config.stopOn!=='duration'))throw Error('Restart Isaac Doctor and reload this page to enable configurable triggers.');
      if(command==='record' && !status.captureScope && (scope.channels!==2047 || drafts.selectedMods || drafts.selectedHooks))throw Error('Restart the local controller to enable capture scope configuration.');
      const response=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:session.token,command,seconds:config.stopOn==='duration'?seconds:25,afterLoad:config.startOn==='run-load',...effective,...scope,selectedMods:drafts.selectedMods.split('\n').filter(Boolean),selectedHooks:drafts.selectedHooks.split('\n').filter(Boolean),screenshots,screenshotMs,minimumUs,stopRecording:command==='shutdown'})});
      const next=parseStatus(await controllerJson(response));setStatus(next);onStatus({...next,durationMs:next.durationMs || (config.stopOn==='duration'?seconds*1000+effective.stopDelayMs:effective.maxDurationMs)});if(!next.ok)setError(next.message);
    }catch(cause){setError(cause instanceof Error?cause.message:'Controller failed');onStatus(status);}finally{inFlight.current=false;setBusy(false);}
  }
  const recording=status.state==='recording' || status.state==='armed';
  const canReadCatalog=status.ok && status.state==='ready';
  const catalogLoading=canReadCatalog && catalogState==='loading';
  const catalogMessage=recording?'Filters are locked while recording. Stop recording to change them.':!canReadCatalog?'Connect game to load available mods and hooks automatically.':catalogLoading?'Loading mods and hooks from the game...':catalogState==='error'?'Could not load the lists. Retry using Refresh lists, or enter exact names below.':catalogState==='ready'?catalog.mods.length || catalog.hooks.length?`${catalog.mods.length} mods and ${catalog.hooks.length} hooks available.`:'No registered callbacks found. Let the game finish loading mods, then refresh the lists.':'Preparing available mods and hooks...';
  const available=(id:CaptureTrigger)=>status.availableTriggers?status.availableTriggers.includes(id):['immediate','run-load','duration'].includes(id);
  const stopLabel=triggerOptions.find(([id])=>id===config.stopOn)?.[1] ?? config.stopOn;
  const effective=effectiveRecordingConfig(config);
  const stopDescription=config.stopOn==='manual'?'Stops when you click Stop.':config.stopOn==='duration'?`Stops after ${Number.isNaN(seconds)?'the specified':seconds} seconds${effective.stopDelayMs?` + ${effective.stopDelayMs} ms stop delay`:''}.`:`${stopLabel}${effective.stopDelayMs?` + ${effective.stopDelayMs} ms stop delay`:''} ends the recording.`;
  return <><div className="recording-controls" role="group" aria-label="Game recording">
    <button id="attach-game" disabled={busy || recording || serverClosed} onClick={()=>void command('attach')} title="Attach profiler to the already running game">Connect game</button>
    <button id="record-game" className="record-button" disabled={busy || recording || status.state!=='ready'} onClick={()=>void command('record')}><span className="record-dot"/>Record</button>
    <button id="stop-game" disabled={busy || !recording} onClick={()=>void command('stop')}>{status.state==='armed'?'Cancel':'Stop'}</button>
    <button id="stop-server" disabled={busy || serverClosed} title="Stop recording and close the local server. Loaded analysis stays available; refresh requires restarting Isaac Doctor." onClick={()=>void command('shutdown')}>Stop local server</button>
    {config.stopOn==='duration' && <label>Record for <input id="record-seconds" type="number" min={1} max={3600} value={Number.isNaN(seconds)?'':seconds} disabled={recording} onChange={e=>setSeconds(e.target.valueAsNumber)}/> s</label>}
    <label title="Shorter calls are omitted from the timeline; aggregate totals remain complete. 1000 µs = 1 ms.">Minimum <input id="record-min-us" type="number" min={0} max={1000000} step={1} value={Number.isNaN(minimumUs)?'':minimumUs} disabled={recording} onChange={e=>{const value=e.target.valueAsNumber;setMinimumUs(value);if(Number.isInteger(value) && value>=0 && value<=1000000)localStorage.setItem('isaacprof.minimum-us',String(value));}}/> µs</label>
    <label><input id="record-screenshots" type="checkbox" checked={screenshots} disabled={recording} onChange={e=>setScreenshots(e.target.checked)}/>Screenshots</label>
    <select id="screenshot-interval" aria-label="Screenshot interval" value={screenshotMs} disabled={recording || !screenshots} onChange={e=>setScreenshotMs(Number(e.target.value))}><option value={250}>250 ms</option><option value={500}>500 ms</option><option value={1000}>1 s</option><option value={2000}>2 s</option></select>
    <output id="record-status" title={error || `${status.message}\n${status.report}`}>{busy?'Contacting game…':error || (status.state==='armed'?status.message || 'Waiting for trigger…':status.state==='recording'?'Recording…':status.state==='ready' && status.report?`Saved: ${status.report}`:status.message || status.state)}</output>
  </div>{serverClosed && <div className="server-closed-notice" role="status"><span><strong>Local server {status.state==='server-stopped'?'stopped':'unavailable'}.</strong> Loaded analysis stays available. Start Isaac Doctor again, then reload this page to reconnect.</span><button className="scope-action" onClick={()=>window.location.reload()}>Reload page</button></div>}<div className="recording-controls record-trigger-controls" role="group" aria-label="Recording triggers">
    <label>Start <select id="record-start-on" value={config.startOn} disabled={recording} onChange={e=>configure('startOn',e.target.value as CaptureTrigger)}>{triggerOptions.filter(([id])=>id!=='duration' && id!=='manual').map(([id,label])=><option key={id} value={id} disabled={!available(id)}>{label}</option>)}</select></label>
    <label>Start delay <input id="record-start-delay" type="number" min={0} max={3600000} step={1} placeholder="0" value={Number.isNaN(config.startDelayMs)?'':config.startDelayMs} disabled={recording || !status.availableTriggers} onChange={e=>configure('startDelayMs',e.target.valueAsNumber)}/> ms</label>
    <label>Stop when <select id="record-stop-on" value={config.stopOn} disabled={recording} onChange={e=>configure('stopOn',e.target.value as CaptureTrigger)}>{triggerOptions.filter(([id])=>id!=='immediate').map(([id,label])=><option key={id} value={id} disabled={!available(id)}>{label}</option>)}</select></label>
    {config.stopOn!=='manual' && <label>Stop delay <input id="record-stop-delay" type="number" min={0} max={3600000} step={1} placeholder="0" value={Number.isNaN(config.stopDelayMs)?'':config.stopDelayMs} disabled={recording || !status.availableTriggers} onChange={e=>configure('stopDelayMs',e.target.valueAsNumber)}/> ms</label>}
    {config.stopOn!=='duration' && <><label className="toolbar-checkbox"><input id="record-limit-enabled" type="checkbox" checked={config.maxDurationMs!==0} disabled={recording} onChange={e=>configure('maxDurationMs',e.target.checked?25000:0)}/>Maximum duration</label>{config.maxDurationMs!==0 && <label><input id="record-max-seconds" aria-label="Maximum recording duration in seconds" type="number" min={1} max={3600} step={1} value={Number.isNaN(config.maxDurationMs)?'':config.maxDurationMs/1000} disabled={recording} onChange={e=>configure('maxDurationMs',e.target.valueAsNumber*1000)}/> s</label>}</>}
    {status.state==='ready' && !status.availableTriggers && <span>Restart the local controller to enable trigger configuration.</span>}
    <span id="record-stop-description" className="record-stop-description" role="status">{stopDescription} {config.stopOn!=='duration' && (effective.maxDurationMs>0?`Maximum duration: ${effective.maxDurationMs/1000} seconds; whichever happens first. The maximum ignores stop delay.`:'No time limit is enabled.')} Times start when collection begins, after the start trigger and its delay. Empty delay fields mean 0 ms.</span>
  </div><details className="record-scope"><summary>Capture scope · {channelOptions.filter(([bit])=>scope.channels & bit).length}/{channelOptions.length} channels · {scope.selectedMods.length?`${scope.selectedMods.length} mods`:'all mods'} · {scope.selectedHooks.length?`${scope.selectedHooks.length} hooks`:'all hooks'}</summary>
    <fieldset disabled={recording || busy}><legend>Data channels</legend><div className="scope-channels">{channelOptions.map(([bit,label])=><label key={bit}><input type="checkbox" checked={!!(scope.channels & bit)} onChange={e=>selectScope({...scope,channels:e.target.checked?scope.channels | bit:scope.channels & ~bit})}/>{label}</label>)}</div></fieldset>
    <p>Timeline and Lua errors require callback timings. FPS/UPS and start/stop triggers work independently. Screenshots use their separate switch above.</p>
    <section className="scope-selection" aria-labelledby="scope-selection-title">
      <div className="scope-catalog-bar">
        <div><h2 id="scope-selection-title">Which callbacks to record</h2><p>Leave both filters empty to record all mods and hooks. Selecting names narrows the recording.</p></div>
        <button id="refresh-capture-catalog" className="scope-action" disabled={recording || busy || !canReadCatalog || catalogLoading} onClick={()=>void loadCatalog()} aria-describedby="scope-catalog-status">{catalogLoading?'Loading lists...':catalogState==='error'?'Retry loading lists':'Refresh lists'}</button>
      </div>
      <p id="scope-catalog-status" className="scope-catalog-status" role="status" aria-live="polite" aria-busy={catalogLoading}>{catalogLoading && <span className="scope-loading-dot" aria-hidden="true"/>}{catalogMessage}</p>
      {scopeError && canReadCatalog && <p className="scope-catalog-error" role="alert">{scopeError}</p>}
      <div className="scope-filters">{(['selectedMods','selectedHooks'] as const).map(key=>{
        const label=key==='selectedMods'?'Mods':'Hooks',names=key==='selectedMods'?catalog.mods:catalog.hooks;
        const placeholder=recording?'Stop recording to choose':!canReadCatalog?'Connect game to choose':catalogLoading?'Loading available names...':catalogState==='error'?'Lists unavailable - retry above':!names.length?'No registered names found':`Add a ${key==='selectedMods'?'mod':'hook'} (${names.length} available)`;
        return <section className="scope-filter" key={key} aria-labelledby={`scope-${key}-title`}>
          <div className="scope-filter-heading"><h3 id={`scope-${key}-title`}>{label}</h3><span>{scope[key].length?`${scope[key].length} selected`:`All ${label.toLowerCase()}`}</span></div>
          <label htmlFor={`scope-${key}-picker`}>Add from connected game</label>
          <select id={`scope-${key}-picker`} aria-label={key==='selectedMods'?'Add mod to capture scope':'Add hook to capture scope'} aria-describedby="scope-catalog-status" disabled={recording || busy || !canReadCatalog || catalogLoading || !names.length} value="" onChange={e=>{if(e.target.value)selectScope({...scope,[key]:[...new Set([...scope[key],e.target.value])]});}}><option value="">{placeholder}</option>{names.map(name=><option key={name} value={name}>{name}</option>)}</select>
          <label htmlFor={`scope-${key}-names`}>Selected names <span>(one exact name per line; editable)</span></label>
          <textarea id={`scope-${key}-names`} aria-describedby={`scope-${key}-help`} rows={3} placeholder={`All ${label.toLowerCase()} - no filter`} disabled={recording || busy} value={drafts[key]} onChange={e=>setDrafts(previous=>({...previous,[key]:e.target.value}))} onBlur={()=>selectScope({...scope,[key]:drafts[key].split('\n').filter(Boolean)})}/>
          <div className="scope-filter-footer"><span id={`scope-${key}-help`}>Empty means all {label.toLowerCase()}.</span><button className="scope-action" disabled={recording || busy || !drafts[key]} onClick={()=>selectScope({...scope,[key]:[]})}>Clear {label.toLowerCase()} filter</button></div>
        </section>;
      })}</div>
    </section>
    <p>Mod and hook filters intersect. Unmeasured child calls remain in the self time of a measured parent. Capture settings are stored in the recording.</p>
  </details></>;
}
