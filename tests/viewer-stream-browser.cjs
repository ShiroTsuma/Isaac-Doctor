/* Real Chrome folder-input test. Build viewer and start viewer-server.py first. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/stream-browser-qa');
const fixtureDir=path.join(root,'build/stream-dev/Release/captures');
const filesList=fs.readdirSync(fixtureDir).map(n=>path.join(fixtureDir,n));
const {readFileSync}=fs;
const small=filesList.find(p=>{try{const {execFileSync}=require('node:child_process');return execFileSync('python',['-c',`import sys;sys.path.insert(0,'tools');from capture import read_capture;d=read_capture(sys.argv[1]);print(len(d['screenshots']['images']))`,p],{cwd:root,encoding:'utf8'}).trim()!=='0';}catch{return false;}});
assert(small,'Run stream-smoke.py first');
const large=readFileSync(path.join(root,'build/stream-dev/Release/large-capture-path.txt'),'utf8').trim();
const frameFile=readFileSync(path.join(root,'build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim();
const sourceDir=path.join(out,'sources'),nestedSource=path.join(sourceDir,'tests');fs.mkdirSync(nestedSource,{recursive:true});fs.copyFileSync(path.join(root,'tests/recording-scenario.lua'),path.join(nestedSource,'scenario.lua'));
const chrome=spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new','--remote-debugging-port=9330',`--user-data-dir=${path.join(out,'profile-'+process.pid)}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,session,sequence=0;const pending=new Map(),events=[];
async function until(fn){for(let i=0;i<600;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('UI test timeout: '+await evaluate('JSON.stringify({status:document.querySelector(".status-bar")?.textContent,filmstrip:!!document.querySelector("#filmstrip"),filename:document.querySelector("#filename")?.textContent})')); }
function send(method,params={},sid){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method} ${(params.expression || '').slice(0,160)}`));},20000);pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function mouse(type,p){await send('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...p},session);}
async function click(selector){const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await mouse('mousePressed',p);await mouse('mouseReleased',p);}
async function files(selector,paths){const doc=await send('DOM.getDocument',{},session),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector},session);await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:paths},session);}
(async()=>{try{
  const version=await until(async()=>{try{return await (await fetch('http://127.0.0.1:9330/json/version')).json();}catch{return false;}});
  ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  ws.addEventListener('message',message=>{const data=JSON.parse(message.data);if(data.id){const p=pending.get(data.id);if(p){pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(Error(p.method+': '+data.error.message)):p.resolve(data.result);}}else events.push(data);});
  const target=await send('Target.createTarget',{url:'about:blank'});session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  await send('Runtime.enable',{},session);await send('Page.enable',{},session);await send('Network.enable',{},session);
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);this.requests=new Map();this.addEventListener('message',e=>{if(e.data.progress)(window.qaProcessingProgress ??= []).push(e.data.progress);const request=this.requests.get(e.data.id);if(request?.type==='viewport' && e.data.result)window.qaViewport={...e.data.result,...request.payload};if(request?.type==='load' && e.data.result)window.qaMetrics=e.data.result.metrics;});}postMessage(message,...args){this.requests.set(message.id,message);if(message.type==='source')setTimeout(()=>super.postMessage(message,...args),300);else super.postMessage(message,...args);}};})();`},session);
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const original=window.fetch;window.testStatus={ok:true,state:'ready',message:'Controlled browser test',report:''};window.fetch=(url,options)=>{if(String(url).startsWith('/api/')){const result=String(url)==='/api/session'?{token:'test'}:String(url)==='/api/control'?{...window.testStatus,state:JSON.parse(options.body).command==='record'?'recording':'ready'}:window.testStatus;return Promise.resolve(new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}}));}return original(url,options);};window.showDirectoryPicker=async()=>{const root=await navigator.storage.getDirectory();return root.getDirectoryHandle('captures',{create:true});};})();`},session);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false},session);
  await send('Page.navigate',{url:'http://127.0.0.1:8765/'},session);await until(()=>evaluate('!!document.querySelector("#folder-input")'));
  await files('#file',[small]);await until(()=>evaluate('document.querySelector("#filename").textContent!=="No recording" && !document.querySelector("#export").disabled'));
  assert(await evaluate('qaProcessingProgress.length>0 && qaProcessingProgress.some(p=>p.percent===100) && qaProcessingProgress.every(p=>p.completed<=p.total && p.percent>=0 && p.percent<=100)'), 'Worker progress must not resolve requests or break subsequent loading');
  const painted=()=>evaluate('(()=>{const c=document.querySelector("#filmstrip");if(!c || c.width<100)return false;return c.getContext("2d").getImageData(64,20,1,1).data[3]>0})()');await until(painted);
  const filmPoint=await evaluate('(()=>{const r=document.querySelector("#filmstrip").getBoundingClientRect();return {x:r.x+66,y:r.y+20}})()');await mouse('mouseMoved',filmPoint);await until(()=>evaluate('!!document.querySelector(".screenshot-preview canvas")'));
  // Switching recordings closes stale ImageBitmaps and exercises the real cleanup path.
  for(let i=0;i<3;i++){await files('#file',[large]);await until(()=>evaluate('!document.querySelector("#filmstrip")'));await files('#file',[small]);await until(painted);}
  await click('#tab-bottom-up');await until(()=>evaluate('document.querySelectorAll("#rows .row-button").length>0'));await click('#rows .row-button');await click('#tab-summary');
  assert(await evaluate('!document.querySelector(".source-context").open'));
  assert(await evaluate('document.querySelector(".source-context").getBoundingClientRect().top>=document.querySelector(".donut").getBoundingClientRect().bottom'));
  await evaluate('document.querySelector("#source-context-toggle").click()');
  await files('#source-folder-input',[sourceDir]);await until(()=>evaluate('document.querySelectorAll(".source-line").length>0'));assert(await evaluate('!!document.querySelector(".source-line.definition")'));
  assert(await evaluate('document.querySelector(".source-context").textContent.includes("function definition")'));
  // Switch callbacks while scrolled into code. Slow source replies expose intermediate frames.
  await click('#zoom-in');await click('#zoom-in');await until(()=>evaluate('!document.querySelector(".trace-load-status")'));
  const callbackPoint=await evaluate(`(()=>{const current=document.querySelector('#source-location').textContent,view=window.qaViewport,c=document.querySelector('#timeline'),r=c.getBoundingClientRect();for(let i=0;i<view.packed.length;i+=10){const p=view.packed,m=window.qaMetrics.find(m=>m.id===p[i]);if(!current.endsWith(':'+m.line) && p[i+1]>=view.start && p[i+1]<view.end)return {x:r.x+(p[i+1]-view.start)/(view.end-view.start)*r.width+Math.min(.25,p[i+2]/(view.end-view.start)*r.width/2),y:r.y+76+p[i+4]*18+8,line:m.line};}return null;})()`);assert(callbackPoint,'Second callback visible');
  const scroll=await evaluate('(()=>{const el=document.querySelector("#analysis-content");el.scrollTop=el.scrollHeight;return {top:el.scrollTop,height:el.scrollHeight}})()');
  await mouse('mousePressed',callbackPoint);await mouse('mouseReleased',callbackPoint);await until(()=>evaluate('document.querySelector(".source-code")?.getAttribute("aria-busy")==="true"'));
  assert(await evaluate(`Math.abs(document.querySelector('#analysis-content').scrollTop-${scroll.top})<=1 && document.querySelector('#analysis-content').scrollHeight===${scroll.height}`),'Source loading must preserve scroll and height');
  await until(()=>evaluate('document.querySelector(".source-code")?.getAttribute("aria-busy")==="false"'));assert(await evaluate(`Math.abs(document.querySelector('#analysis-content').scrollTop-${scroll.top})<=1`));
  const sourceShot=await send('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(out,'source.png'),Buffer.from(sourceShot.data,'base64'));
  // File-input snapshots can grant write access to their original instead of downloading a copy.
  const manualBase64=fs.readFileSync(small).toString('base64');
  await evaluate(`(async()=>{const root=await navigator.storage.getDirectory();for(const name of ['manual-original.isaacprof','wrong-recording.isaacprof']){const bytes=Uint8Array.from(atob(${JSON.stringify(manualBase64)}),c=>c.charCodeAt(0));if(name.startsWith('wrong'))bytes[16]^=1;const h=await root.getFileHandle(name,{create:true}),w=await h.createWritable();await w.write(bytes);await w.close();}window.qaSaveTarget='wrong-recording.isaacprof';window.showOpenFilePicker=async()=>[await root.getFileHandle(window.qaSaveTarget)];})()`);
  await click('#save-analysis-cache');await until(()=>evaluate('document.querySelector(".status-bar").textContent.includes("Choose the original recording")'));
  await evaluate('window.qaSaveTarget="manual-original.isaacprof"');await click('#save-analysis-cache');await until(()=>evaluate('document.querySelector("#analysis-cache-status")?.textContent.includes("loaded from recording")'));
  assert(await evaluate('(async()=>{const root=await navigator.storage.getDirectory(),f=await (await root.getFileHandle("manual-original.isaacprof")).getFile();return new TextDecoder().decode(await f.slice(f.size-32,f.size-24).arrayBuffer())==="IPACEND1"})()'));
  await send('Page.reload',{ignoreCache:true},session);await until(()=>evaluate('!!document.querySelector("#file")'));await files('#file',[small]);await until(()=>evaluate('document.querySelector(".source-context")?.textContent.includes("Restored local Lua snapshot")'));assert(await evaluate('!document.querySelector(".source-context").open'));
  await files('#file',[large]);await until(()=>evaluate('document.querySelector(".status-bar").textContent.includes("retained events")'));
  await until(()=>evaluate('!document.querySelector(".trace-load-status")'));
  const p=await evaluate('(()=>{const c=document.querySelector("#timeline"),r=c.getBoundingClientRect();return {x:r.x+r.width*.4,y:r.y+82}})()');await mouse('mouseMoved',p);await delay(50);
  await click('#zoom-in');await until(()=>evaluate('!document.querySelector(".trace-load-status")'));
  const empty=await evaluate('(()=>{const c=document.querySelector("#timeline"),r=c.getBoundingClientRect(),f=document.querySelector(".flame-scroll").getBoundingClientRect();return {x:r.x+r.width*.65,y:f.bottom-20,covered:r.bottom>=f.bottom-1}})()');assert(empty.covered,'Timeline must cover empty panel');
  const before=await evaluate('document.querySelector("#range").textContent');await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:empty.x,y:empty.y,deltaX:0,deltaY:-100},session);await until(()=>evaluate('document.querySelector("#range").textContent!=='+JSON.stringify(before)));
  await mouse('mousePressed',empty);await mouse('mouseMoved',{x:empty.x-80,y:empty.y});await mouse('mouseReleased',{x:empty.x-80,y:empty.y});
  await click('#tab-bottom-up');
  await click('#mods');await until(()=>evaluate('!!document.querySelector("#rows .tree-toggle")'));const parents=await evaluate('document.querySelectorAll("#rows tr").length');await click('#rows .tree-toggle');assert(await evaluate(`document.querySelectorAll('#rows tr').length>${parents}`));const hooks=await evaluate('document.querySelectorAll("#rows tr").length');await click('#rows tr:nth-child(2) .tree-toggle');assert(await evaluate(`document.querySelectorAll('#rows tr').length>${hooks}`));await click('#hooks');await until(()=>evaluate('document.querySelector("#hooks").getAttribute("aria-pressed")==="true"'));await click('#callbacks');
  await click('#tab-event-log');await until(()=>evaluate('document.querySelectorAll("#rows tr").length>0'));
  await click('#analysis-content th:nth-child(2) button');await until(()=>evaluate('document.querySelector("#analysis-content th:nth-child(2)").getAttribute("aria-sort")==='+'"descending"'));

  await files('#file',[frameFile]);await until(()=>evaluate('document.querySelector("#filename").textContent.includes('+JSON.stringify(path.basename(frameFile))+')'));
  await click('#tab-telemetry');await until(()=>evaluate('document.querySelectorAll(".counter-chart polyline").length>=5'));
  assert(await evaluate('[...document.querySelectorAll(".counter-chart polyline")].every(p=>p.getAttribute("points").length>0)'));
  assert(await evaluate('document.querySelector(".marker-table").textContent.includes("Room transition")'));
  const telemetryShot=await send('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(out,'telemetry.png'),Buffer.from(telemetryShot.data,'base64'));
  await click('#tab-frames');await until(()=>evaluate('document.querySelectorAll("#frame-rows tr").length>5'));
  assert(await evaluate('document.querySelector(".frame-stats").textContent.includes("Interval p95") && document.querySelector(".frame-stats").textContent.includes("FPS p50") && document.querySelector(".frame-stats").textContent.includes("FPS p5")'));
  assert(await evaluate('document.querySelectorAll(".slow-frame").length>0'));
  const framesShot=await send('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(out,'frames.png'),Buffer.from(framesShot.data,'base64'));
  await click('#analysis-content th:nth-child(2) button');assert(await evaluate('document.querySelector("#analysis-content th:nth-child(2)").getAttribute("aria-sort")==='+ '"ascending"'));
  await click('#frame-rows .row-button');await until(()=>evaluate('!!document.querySelector(".frame-inspector")'));await click('.frame-inspector .small-button');await click('#frame-rows tr td:last-child .row-button');await until(()=>evaluate('document.querySelector("#tab-summary").getAttribute("aria-selected")==="true"'));
  assert(await evaluate('!document.querySelector("#range").textContent.includes("2,000")'));
  // Real OPFS handle, permissions, IndexedDB structured clone, fresh getFile; no game is attached.
  const autoName='capture-999-automatic.isaacprof',base64=fs.readFileSync(frameFile).toString('base64');
  await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('captures',{create:true}),handle=await dir.getFileHandle(${JSON.stringify(autoName)},{create:true}),writer=await handle.createWritable();await writer.write(Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0)));await writer.close();})()`);
  await click('#connect-captures');await until(()=>evaluate('document.querySelector("#capture-folder-status").textContent.includes("automatic local reads enabled")'));
  await until(()=>evaluate('!document.querySelector("#record-game").disabled'));
  await click('#record-game');await until(()=>evaluate('!document.querySelector("#stop-game").disabled'));
  assert(await evaluate('document.querySelector(".recording-stage").textContent.includes("Collecting")'));
  await evaluate(`window.testStatus={ok:true,state:'ready',message:'Saved test',report:'C:/captures/${autoName}'};`);
  await until(()=>evaluate('document.querySelector("#filename").textContent==='+JSON.stringify(autoName)));
  await until(()=>evaluate('document.querySelector("#analysis-cache-status")?.textContent.includes("loaded from recording")'));
  assert(await evaluate('(async()=>{const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle("captures"),h=await dir.getFileHandle("capture-999-automatic.isaacprof"),f=await h.getFile();return new TextDecoder().decode(await f.slice(f.size-32,f.size-24).arrayBuffer())==="IPACEND1"})()'));
  await send('Page.reload',{ignoreCache:true},session);await until(()=>evaluate('document.querySelector("#capture-folder-status")?.textContent.includes("automatic local reads enabled")'));
  // Game API responses are substituted; the user's running game is untouched.
  const state=await evaluate('document.querySelector(".status-bar").textContent');assert(!state.includes('checksum') && !state.includes('Unsupported'),state);
  const shot=await send('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(out,'desktop.png'),Buffer.from(shot.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:540,height:900,deviceScaleFactor:1,mobile:false},session);await delay(100);assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Page overflow');
  const requests=events.filter(e=>e.method==='Network.requestWillBeSent').map(e=>e.params.request);assert(requests.every(r=>r.method==='GET' && !r.url.includes('/api/capture') && !r.url.includes('.isaacprof')),'Recording network transfer');
  assert.equal(events.filter(e=>e.method==='Runtime.exceptionThrown').length,0,JSON.stringify(events.filter(e=>e.method==='Runtime.exceptionThrown')));
  console.log('PASS: streamed large trace, FPS/quantiles/stalls/drilldown, automatic recording open through real OPFS handle and restored permission, collecting overlay, screenshot switching, Lua fragments/cache, mobile, no capture/source network transfer.');
}finally{if(ws){try{await send('Browser.close');}catch{}ws.close();}chrome.kill();}})().catch(error=>{console.error(error);console.error(JSON.stringify(events.filter(e=>e.method==='Runtime.exceptionThrown')));process.exitCode=1;});
