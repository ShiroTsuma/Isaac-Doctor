/* Real Chrome folder-input test. Build viewer and start viewer-server.py first. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/recording-browser-qa');
const frameFile=fs.readFileSync(path.join(root,'build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim();fs.mkdirSync(out,{recursive:true});
const chrome=spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new','--remote-debugging-port=9331',`--user-data-dir=${path.join(out,'profile-'+process.pid)}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,session,sequence=0;const pending=new Map(),events=[];
async function until(fn){for(let i=0;i<600;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('UI test timeout: '+await evaluate('JSON.stringify({status:document.querySelector(".status-bar")?.textContent,filmstrip:!!document.querySelector("#filmstrip"),filename:document.querySelector("#filename")?.textContent,panel:document.querySelector("#analysis-content")?.textContent})')); }
function send(method,params={},sid){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method} ${(params.expression || '').slice(0,160)}`));},20000);pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function mouse(type,p){await send('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...p},session);}
async function click(selector){const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await mouse('mousePressed',p);await mouse('mouseReleased',p);}
async function files(selector,paths){const doc=await send('DOM.getDocument',{},session),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector},session);await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:paths},session);}
(async()=>{try{
  const version=await until(async()=>{try{return await (await fetch('http://127.0.0.1:9331/json/version')).json();}catch{return false;}});
  ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  ws.addEventListener('message',message=>{const data=JSON.parse(message.data);if(data.id){const p=pending.get(data.id);if(p){pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(Error(p.method+': '+data.error.message)):p.resolve(data.result);}}else events.push(data);});
  const target=await send('Target.createTarget',{url:'about:blank'});session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  await send('Runtime.enable',{},session);await send('Page.enable',{},session);await send('Network.enable',{},session);
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const NativeWorker=window.Worker;window.qaWorkers=[];window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.qaWorkers.push(this);this.dead=false;this.requests=new Map();this.addEventListener('message',e=>{if(e.data.progress)(window.qaProcessingProgress ??= []).push(e.data.progress);const request=this.requests.get(e.data.id);if(request?.type==='viewport' && e.data.result)window.qaViewport={...e.data.result,...request.payload};if(request?.type==='load' && e.data.result)window.qaMetrics=e.data.result.metrics;});}terminate(){this.dead=true;super.terminate();}postMessage(message,...args){this.requests.set(message.id,message);if(message.type==='source')setTimeout(()=>super.postMessage(message,...args),300);else super.postMessage(message,...args);}};})();`},session);
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const original=window.fetch;window.testStatus={ok:true,state:'ready',message:'Controlled browser test',report:''};window.fetch=(url,options)=>{if(String(url).startsWith('/api/')){const result=String(url)==='/api/session'?{token:'test'}:String(url)==='/api/control'?(window.testStatus={...window.testStatus,state:JSON.parse(options.body).command==='record'?'recording':'ready',report:JSON.parse(options.body).command==='record'?(window.testNextReport || window.testStatus.report):''}):window.testStatus;return Promise.resolve(new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}}));}return original(url,options);};window.showDirectoryPicker=async()=>{const root=await navigator.storage.getDirectory();return root.getDirectoryHandle('captures',{create:true});};})();`},session);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false},session);
  await send('Page.navigate',{url:'http://127.0.0.1:8765/'},session);await until(()=>evaluate('!!document.querySelector("#folder-input")'));


  // Real 195 MiB trace: cancellation must terminate actual workers, not hide progress.
  const largeFile=fs.readFileSync(path.join(root,'build/stream-dev/Release/large-capture-path.txt'),'utf8').trim();
  await files('#file',[largeFile]);await until(()=>evaluate('!!document.querySelector(".recording-stage") && !document.querySelector(\'[aria-label="Clear recording"]\').disabled'));
  const loadingWorkers=await evaluate('window.qaWorkers.length');
  await click('[aria-label="Clear recording"]');
  assert(await evaluate('!document.querySelector(".recording-stage") && document.querySelector("#filename").textContent==="No recording"'));
  assert(await evaluate(`window.qaWorkers.slice(0,${loadingWorkers}).every(w=>w.dead)`),'All previous workers terminated');
  await delay(2000);assert.equal(await evaluate('document.querySelector("#filename").textContent'),'No recording','Canceled capture must not reopen');
  await files('#file',[frameFile]);await until(()=>evaluate('document.querySelector("#filename").textContent.includes('+JSON.stringify(path.basename(frameFile))+')'));
  const bytes=fs.readFileSync(frameFile).toString('base64');
  async function addCapture(name){await evaluate(`(async()=>{const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('captures',{create:true}),h=await dir.getFileHandle(${JSON.stringify(name)},{create:true}),w=await h.createWritable();await w.write(Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0)));await w.close();})()`);}
  await addCapture('capture-999-first.isaacprof');await addCapture('capture-999-second.isaacprof');
  await click('#connect-captures');await until(()=>evaluate('document.querySelector("#captures").options.length===3'));
  // Stop returns ready with no filename. A later poll publishes the finished capture.
  await evaluate("window.testNextReport='C:/captures/capture-999-manual.isaacprof'");await click('#record-game');await until(()=>evaluate('!document.querySelector("#stop-game").disabled'));await click('#stop-game');await delay(200);
  await addCapture('capture-999-manual.isaacprof');
  await evaluate("window.testStatus={ok:true,state:'ready',message:'Saved manual recording',report:'C:/captures/capture-999-manual.isaacprof'}");
  await until(()=>evaluate('document.querySelector("#filename").textContent==="capture-999-manual.isaacprof" && !document.querySelector(".recording-stage")'));
  await until(()=>evaluate('document.querySelector("#captures").options.length===4'));
  assert(await evaluate('document.querySelector("#captures").value==="capture-999-manual.isaacprof"'));
  // A new file outside the current recording is reflected without another picker.
  await addCapture('capture-999-external.isaacprof');await until(()=>evaluate('document.querySelector("#captures").options.length===5'));
  await send('Page.reload',{ignoreCache:true},session);
  await until(()=>evaluate('document.querySelector("#captures")?.options.length===5'));
  assert(await evaluate('document.querySelector("#folder-status").textContent.includes("live folder")'),'Restored handle enumerates actual files');
  // Selecting a refreshed entry reads through its handle, not an old cached blob.
  await evaluate('(()=>{const s=document.querySelector("#captures");s.value="capture-999-external.isaacprof";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
  await until(()=>evaluate('document.querySelector("#filename").textContent==="capture-999-external.isaacprof" && !document.querySelector(".recording-stage")'));
  // Timed completion and a stale report from the previous recording also work.
  await evaluate("window.testStatus={ok:true,state:'ready',message:'previous',report:'C:/captures/capture-999-manual.isaacprof'}");await delay(1700);
  await evaluate("window.testNextReport='C:/captures/capture-999-timed.isaacprof'");await click('#record-game');await until(()=>evaluate('!document.querySelector("#stop-game").disabled'));
  await evaluate("window.testStatus={ok:true,state:'ready',message:'finishing',report:'C:/captures/capture-999-manual.isaacprof'}");await delay(1700);
  assert.equal(await evaluate('document.querySelector("#filename").textContent'),'capture-999-external.isaacprof');
  await addCapture('capture-999-timed.isaacprof');await evaluate("window.testStatus={ok:true,state:'ready',message:'Saved timed recording',report:'C:/captures/capture-999-timed.isaacprof'}");
  await until(()=>evaluate('document.querySelector("#filename").textContent==="capture-999-timed.isaacprof" && !document.querySelector(".recording-stage")'));
  await click('[aria-label="Settings"]');await click('#forget-folder');await until(()=>evaluate('document.querySelector("#captures").disabled && document.querySelector("#connect-captures").textContent==="Connect captures folder"'));
  await send('Page.reload',{ignoreCache:true},session);await until(()=>evaluate('!!document.querySelector("#captures")'));await delay(1700);assert(await evaluate('document.querySelector("#captures").disabled && document.querySelector("#connect-captures").textContent==="Connect captures folder"'),'Forget removes handle and snapshot together');
  assert.equal(events.filter(e=>e.method==='Runtime.exceptionThrown').length,0,JSON.stringify(events.filter(e=>e.method==='Runtime.exceptionThrown')));
  const warnings=events.filter(e=>e.method==='Runtime.consoleAPICalled' && ['error','warning'].includes(e.params.type));assert.equal(warnings.length,0,JSON.stringify(warnings));
  assert(events.filter(e=>e.method==='Network.requestWillBeSent' && e.params.request.method==='POST').every(e=>new URL(e.params.request.url).pathname==='/api/control'),'Capture bytes never uploaded');
  console.log('PASS: actual worker termination during large capture processing, no stale reopen, next load, Stop with delayed report, fresh folder list, persisted handle after reload, live handle selection, timed completion with stale previous report, no console errors or uploads.');
}finally{if(ws){try{await send('Browser.close');}catch{}ws.close();}chrome.kill();}})().catch(error=>{console.error(error);console.error(JSON.stringify(events.filter(e=>e.method==='Runtime.exceptionThrown')));process.exitCode=1;});
