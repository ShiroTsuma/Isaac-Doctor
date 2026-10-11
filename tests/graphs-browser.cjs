/* Real Chrome folder-input test. Build viewer and start viewer-server.py first. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/graph-browser-qa');
const frameFile=fs.readFileSync(path.join(root,'build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim();fs.mkdirSync(out,{recursive:true});
const chrome=spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new','--remote-debugging-port=9330',`--user-data-dir=${path.join(out,'profile-'+process.pid)}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,session,sequence=0;const pending=new Map(),events=[];
async function until(fn){for(let i=0;i<600;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('UI test timeout: '+await evaluate('JSON.stringify({status:document.querySelector(".status-bar")?.textContent,filmstrip:!!document.querySelector("#filmstrip"),filename:document.querySelector("#filename")?.textContent,panel:document.querySelector("#analysis-content")?.textContent})')); }
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
   await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const draw=CanvasRenderingContext2D.prototype.fillText;window.qaCanvasLabels=[];CanvasRenderingContext2D.prototype.fillText=function(...args){if(this.canvas.id==='timeline'){qaCanvasLabels.push(args[0]);if(qaCanvasLabels.length>2000)qaCanvasLabels.shift();}return draw.apply(this,args);};})();`},session);
 await send('Page.navigate',{url:process.env.ISAACPROF_TEST_URL || 'http://127.0.0.1:8765/'},session);await until(()=>evaluate('!!document.querySelector("#folder-input")'));

  await files('#file',[frameFile]);await until(()=>evaluate('document.querySelector("#filename").textContent.includes('+JSON.stringify(path.basename(frameFile))+')'));
  await click('#zoom-in');await click('#zoom-in');await until(()=>evaluate('!document.querySelector(".trace-load-status")'));
  const change=async(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const readRange=()=>evaluate('document.querySelector("#range").textContent');
  const bounds=selector=>evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width*.55,y:r.y+r.height*.5}})()`);
  await change('#graph-kind','fps');await until(()=>evaluate('document.querySelector("#performance-graph polyline")?.getAttribute("points").length>0'));
  assert(await evaluate('document.querySelector("#overview").getAttribute("aria-label").includes("FPS")'),'Overview follows primary channel');
  assert(await evaluate('document.querySelector(".graph-sample-count").textContent.includes("n=")'),'Visible sample count');
  assert.equal(await evaluate('document.querySelectorAll("#performance-graph polyline").length'),4);
  await click('.graph-series button:last-of-type');assert.equal(await evaluate('document.querySelectorAll("#performance-graph polyline").length'),3);
  await click('.graph-series button:last-of-type');

  await until(()=>evaluate('!!document.querySelector("#performance-graph .percentile-point")'));
  const contributing=await evaluate('(()=>{const p=document.querySelector("#performance-graph .percentile-point"),r=p.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,start:Number(p.dataset.frameStart),duration:Number(p.dataset.frameDuration)}})()');
  await mouse('mouseMoved',contributing);await mouse('mousePressed',contributing);await mouse('mouseReleased',contributing);
  await until(()=>evaluate(`(()=>{const t=document.querySelector('#range').textContent;return t.includes(${JSON.stringify(new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(contributing.start))}) && t.includes(${JSON.stringify(new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(contributing.start+contributing.duration))})})()`));
  await evaluate('document.querySelector("#performance-graph").focus()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home'},session);await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home'},session);
  await click('#zoom-in');await click('#zoom-in');await until(()=>evaluate('document.querySelector("#performance-graph polyline")?.getAttribute("points").length>0'));
  // Metric navigation uses real trusted input. Drag must not also focus a frame.
  let before=await readRange(),p=await bounds('#performance-graph');
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:-100},session);await until(async()=>await readRange()!==before);
  before=await readRange();await send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:100,modifiers:8},session);await until(async()=>await readRange()!==before);
  before=await readRange();await mouse('mousePressed',p);await mouse('mouseMoved',{x:p.x-80,y:p.y});await mouse('mouseReleased',{x:p.x-80,y:p.y});await until(async()=>await readRange()!==before);
  const dragged=await readRange();await delay(100);assert.equal(await readRange(),dragged,'Drag release must not focus a frame');
  before=await readRange();await mouse('mousePressed',{...p,modifiers:8});await mouse('mouseMoved',{x:p.x+90,y:p.y,modifiers:8});await mouse('mouseReleased',{x:p.x+90,y:p.y,modifiers:8});await until(async()=>await readRange()!==before);
  before=await readRange();await send('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS'},session);await send('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS'},session);await until(async()=>await readRange()!==before);
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home'},session);await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home'},session);
  await click('[aria-label="Add graph"]');await until(()=>evaluate('document.querySelectorAll(".graph-pane").length===2'));
  await change('#graph-kind-1','render-ms');await until(()=>evaluate('document.querySelector("#performance-graph-1 polyline")?.getAttribute("points").length>0'));
  p=await bounds('#performance-graph-1');before=await readRange();await send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:-100},session);await until(async()=>await readRange()!==before);
  await change('#graph-kind','callbacks');await until(()=>evaluate('!!document.querySelector("#timeline") && !document.querySelector(".trace-load-status")'));
  assert(await evaluate('document.querySelector("#overview").getAttribute("aria-label").includes("Callbacks")'));
  before=await readRange();p=await bounds('#timeline');await send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:-100},session);await until(async()=>await readRange()!==before);
  assert(await evaluate(`!document.body.textContent.includes('\u00e2\u20ac') && !document.body.textContent.includes('\u00c2\u00b7')`),'No broken encoding in text');
  assert(await evaluate(`window.qaCanvasLabels.some(label=>label.includes('Lua callbacks')) && !window.qaCanvasLabels.some(label=>label.includes('Timings'))`),'Callback chart retains thread headers without a fake expandable Timings label');
  await click('#tab-event-log');await until(()=>evaluate('!!document.querySelector("#event-errors-only")'));
  const checkbox=await evaluate(`(()=>{const el=document.querySelector('#event-errors-only'),r=el.getBoundingClientRect(),s=getComputedStyle(el.parentElement);return {width:r.width,height:r.height,display:s.display,text:el.parentElement.textContent.trim()};})()`);
  assert(checkbox.width<=18 && checkbox.height<=18 && ['inline-flex','flex'].includes(checkbox.display) && checkbox.text==='Errors only',JSON.stringify(checkbox));
  await click('#event-errors-only');assert(await evaluate('document.querySelector("#event-errors-only").checked'));
  // Compare sorting works for every group, including independent call rate columns.
  await click('#tab-compare');await files('#compare-file',[frameFile]);await until(()=>evaluate('document.querySelectorAll(".comparison-table tbody tr").length>0'));
  for(const group of ['mods','hooks','functions']){
    await change('.frames-panel select',group);
    for(const [column,ascending] of [[1,true],[2,false],[3,false],[4,false],[5,false],[6,false],[7,false],[8,false],[9,true]]){
      await click(`.comparison-table th:nth-child(${column}) button`);
      if(await evaluate(`document.querySelector('.comparison-table th:nth-child(${column})').getAttribute('aria-sort')`)!==(ascending?'ascending':'descending'))await click(`.comparison-table th:nth-child(${column}) button`);
      const values=await evaluate(`[...document.querySelectorAll('.comparison-table tbody tr')].map(row=>row.children[${column-1}].textContent.trim())`);
      const nums=values.map(v=>parseFloat(v.replaceAll(',',''))).filter(Number.isFinite);
      if(column>1 && column<9)for(let i=1;i<nums.length;i++)assert(ascending?nums[i]>=nums[i-1]:nums[i]<=nums[i-1],`${group} column ${column}: ${nums}`);
      await click(`.comparison-table th:nth-child(${column}) button`);
      assert.equal(await evaluate(`document.querySelector('.comparison-table th:nth-child(${column})').getAttribute('aria-sort')`),ascending?'descending':'ascending');
    }
  }
  const shot=await send('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(out,'compare.png'),Buffer.from(shot.data,'base64'));
  await change('#graph-kind','fps');await until(()=>evaluate('document.querySelector("#performance-graph polyline")?.getAttribute("points").length>0'));
  const graphShot=await send('Page.captureScreenshot',{format:'png'},session);fs.writeFileSync(path.join(out,'graphs.png'),Buffer.from(graphShot.data,'base64'));
  await click('#tab-bottom-up');await click('#callbacks');await until(()=>evaluate('!!document.querySelector("#rows .row-button")'));await click('#rows .row-button');await click('#tab-summary');
  assert(await evaluate('document.querySelector(".legend").textContent.includes("Nested callbacks") && !document.querySelector(".legend").textContent.includes("Not instrumented")'),'Selected callback row must label inclusive minus self as nested callback time');
  assert.equal(events.filter(e=>e.method==='Runtime.exceptionThrown').length,0,JSON.stringify(events.filter(e=>e.method==='Runtime.exceptionThrown')));
  const warnings=events.filter(e=>e.method==='Runtime.consoleAPICalled' && ['error','warning'].includes(e.params.type));assert.equal(warnings.length,0,JSON.stringify(warnings));
  assert(events.filter(e=>e.method==='Network.requestWillBeSent').every(e=>e.params.request.method==='GET'),'No upload');
  console.log('PASS: shared navigation on metric/callback panes, wheel/pan/drag/selection/keyboard, primary overview, independent panes, percentile sample count/colors/contributing interval selection, all Compare columns/groups sort, no console errors or upload.');
}finally{if(ws){try{await send('Browser.close');}catch{}ws.close();}chrome.kill();}})().catch(error=>{console.error(error);console.error(JSON.stringify(events.filter(e=>e.method==='Runtime.exceptionThrown')));process.exitCode=1;});
