/* Real Chrome folder-input test. Build viewer and start viewer-server.py first. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/scope-browser-qa');
const frameFile=fs.readFileSync(path.join(root,'build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim();fs.mkdirSync(out,{recursive:true});
const chrome=spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new','--remote-debugging-port=9333',`--user-data-dir=${path.join(out,'profile-'+process.pid)}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,session,sequence=0;const pending=new Map(),events=[];
async function until(fn){for(let i=0;i<600;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('UI test timeout: '+await evaluate('JSON.stringify({status:document.querySelector(".status-bar")?.textContent,filmstrip:!!document.querySelector("#filmstrip"),filename:document.querySelector("#filename")?.textContent,panel:document.querySelector("#analysis-content")?.textContent})')); }
function send(method,params={},sid){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method} ${(params.expression || '').slice(0,160)}`));},20000);pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function mouse(type,p){await send('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...p},session);}
async function click(selector){const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await mouse('mousePressed',p);await mouse('mouseReleased',p);}
async function files(selector,paths){const doc=await send('DOM.getDocument',{},session),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector},session);await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:paths},session);}
(async()=>{try{
 const version=await until(async()=>{try{return await (await fetch('http://127.0.0.1:9333/json/version')).json();}catch{return false;}});
 ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
 ws.addEventListener('message',message=>{const data=JSON.parse(message.data);if(data.id){const p=pending.get(data.id);if(p){pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(Error(p.method+': '+data.error.message)):p.resolve(data.result);}}else events.push(data);});
 const target=await send('Target.createTarget',{url:'about:blank'});session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
 await send('Runtime.enable',{},session);await send('Page.enable',{},session);
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const original=window.fetch;window.testStatus={ok:true,state:'disconnected',message:'Controlled browser test',report:'',captureScope:true,availableTriggers:['immediate','run-load','room-entry','projectile','duration','manual']};window.fetch=(url,options)=>{if(String(url).startsWith('/api/')){let result=window.testStatus;if(String(url)==='/api/session')result={token:'test'};if(String(url)==='/api/catalog'){window.catalogReads=(window.catalogReads || 0)+1;result=window.catalogMode==='error'?{ok:false,message:'Controlled catalog failure'}:window.catalogMode==='empty'?{ok:true,mods:[],hooks:[]}:{ok:true,mods:['Unicode m\u00f3d','Other'],hooks:['MC_POST_RENDER','MC_POST_UPDATE']};const response=()=>new Response(JSON.stringify(result),{status:window.catalogMode==='error'?400:200,headers:{'Content-Type':'application/json'}});if(window.holdCatalog)return new Promise(resolve=>{window.releaseCatalog=()=>resolve(response());});return Promise.resolve(response());}if(String(url)==='/api/control'){window.qaBody=JSON.parse(options.body);window.testStatus={...window.testStatus,state:window.qaBody.command==='record'?'recording':window.qaBody.command==='shutdown'?'server-stopped':'ready'};if(window.qaBody.command==='shutdown')window.testStatus.message='Local server stopped. Loaded analysis stays available.';result=window.testStatus;}return Promise.resolve(new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}}));}return original(url,options);};})();`},session);
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false},session);
 await send('Page.navigate',{url:process.env.ISAACPROF_TEST_URL || 'http://127.0.0.1:8765/'},session);await until(()=>evaluate('!!document.querySelector("#attach-game")'));
 const change=async(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 const input=async(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await click('.record-scope summary');
 assert(await evaluate(`document.querySelector('[aria-label="Add mod to capture scope"]').disabled && document.querySelector('#scope-catalog-status').textContent.includes('Connect game')`));
 await evaluate('window.holdCatalog=true');await click('#attach-game');
 await until(()=>evaluate(`document.querySelector('#scope-catalog-status').textContent.includes('Loading mods') && document.querySelector('#refresh-capture-catalog').disabled`));
 assert.equal(await evaluate('window.catalogReads'),1,'Connection loads catalog automatically, without a separate click');
 await evaluate('window.holdCatalog=false;window.releaseCatalog()');
 await until(()=>evaluate(`document.querySelector('[aria-label="Add mod to capture scope"]').options.length===3`));
 assert(await evaluate(`document.querySelector('#scope-catalog-status').textContent.includes('2 mods and 2 hooks')`));
 const buttonStyle=await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('#refresh-capture-catalog'));return {border:s.borderTopStyle,background:s.backgroundColor};})()`);assert.equal(buttonStyle.border,'solid');assert.notEqual(buttonStyle.background,'rgba(0, 0, 0, 0)');
 await evaluate("window.catalogMode='error'");await click('#refresh-capture-catalog');
 await until(()=>evaluate(`document.querySelector('.scope-catalog-error')?.textContent.includes('Controlled catalog failure')`));
 assert(await evaluate(`document.querySelector('[aria-label="Add mod to capture scope"]').disabled && document.querySelector('#refresh-capture-catalog').textContent.includes('Retry')`));
 await evaluate("window.catalogMode='empty'");await click('#refresh-capture-catalog');
 await until(()=>evaluate(`document.querySelector('#scope-catalog-status').textContent.includes('No registered callbacks')`));
 assert(await evaluate(`document.querySelector('[aria-label="Add hook to capture scope"]').disabled`));
 await evaluate("window.catalogMode='ok'");await click('#refresh-capture-catalog');
 await until(()=>evaluate(`!document.querySelector('[aria-label="Add mod to capture scope"]').disabled`));
 await change('[aria-label="Add mod to capture scope"]','Unicode m\u00f3d');
 await change('[aria-label="Add hook to capture scope"]','MC_POST_RENDER');
 await click('.scope-channels label:nth-child(7) input');
 await change('#record-start-on','room-entry');await input('#record-start-delay','250');await input('#record-seconds','');await change('#record-stop-on','projectile');await input('#record-stop-delay','');await change('#record-stop-on','manual');
 assert(await evaluate(`!document.querySelector('#record-stop-delay') && !document.querySelector('#record-seconds') && document.querySelector('#record-stop-description').textContent.includes('No time limit')`));
 await click('#record-game');await until(()=>evaluate("window.qaBody?.command==='record'"));
 const body=await evaluate('window.qaBody');assert.equal(body.channels,8191 & ~64);assert.deepEqual(body.selectedMods,['Unicode m\u00f3d']);assert.deepEqual(body.selectedHooks,['MC_POST_RENDER']);assert.equal(body.startOn,'room-entry');assert.equal(body.startDelayMs,250);assert.equal(body.stopOn,'manual');assert.equal(body.stopDelayMs,0);assert.equal(body.seconds,25);assert.equal(body.maxDurationMs,0);
 assert(await evaluate('document.querySelector(".record-scope fieldset").disabled'));
 await click('#stop-game');await until(()=>evaluate('!document.querySelector("#record-game").disabled'));
 await click('#record-limit-enabled');await input('#record-max-seconds','');await evaluate('window.qaBody=null');await click('#record-game');await until(()=>evaluate(`document.querySelector('#record-status').textContent.includes('enabled maximum duration')`));assert.equal(await evaluate('window.qaBody'),null);
 await input('#record-max-seconds','2');await click('#record-game');await until(()=>evaluate("window.qaBody?.command==='record'"));assert.equal(await evaluate('window.qaBody.maxDurationMs'),2000);await click('#stop-game');await until(()=>evaluate('!document.querySelector("#record-game").disabled'));
 await change('#record-stop-on','projectile');await input('#record-stop-delay','500');assert(await evaluate(`document.querySelector('#record-stop-description').textContent.includes('whichever happens first')`));
 await click('#record-game');await until(()=>evaluate("window.qaBody?.command==='record'"));assert.equal(await evaluate('window.qaBody.stopDelayMs'),500);assert.equal(await evaluate('window.qaBody.maxDurationMs'),2000);await click('#stop-game');await until(()=>evaluate('!document.querySelector("#record-game").disabled'));
 await change('#record-stop-on','duration');await input('#record-seconds','25');assert(await evaluate(`!document.querySelector('#record-limit-enabled') && !document.querySelector('#record-stop-delay') && document.querySelector('#record-seconds').closest('label').previousElementSibling.contains(document.querySelector('#record-stop-on')) && !!document.querySelector('#record-seconds').closest('.record-trigger-controls')`));
 await click('#record-game');await until(()=>evaluate("window.qaBody?.command==='record'"));assert.equal(await evaluate('window.qaBody.seconds'),25);assert.equal(await evaluate('window.qaBody.stopDelayMs'),0);assert.equal(await evaluate('window.qaBody.maxDurationMs'),0);await click('#stop-game');await until(()=>evaluate('!document.querySelector("#record-game").disabled'));
 await send('Page.reload',{ignoreCache:true},session);await until(()=>evaluate('!!document.querySelector(".record-scope summary")'));
 assert(await evaluate(`document.querySelector('.record-scope summary').textContent.includes('10/11 channels') && document.querySelector('.record-scope summary').textContent.includes('1 mods')`));
 await click('#attach-game');await until(()=>evaluate(`!document.querySelector('[aria-label="Add mod to capture scope"]').disabled`));
 await click('#stop-server');await until(()=>evaluate("window.qaBody?.command==='shutdown'"));assert.equal(await evaluate('window.qaBody.stopRecording'),true);await until(()=>evaluate("document.querySelector('#record-status').textContent.includes('Local server stopped')"));assert(await evaluate('!!document.querySelector(".record-scope")'),'Loaded UI survives controller shutdown');
 assert(await evaluate('document.querySelector("#attach-game").disabled && document.querySelector("#stop-server").disabled && !!document.querySelector(".server-closed-notice")'),'Server shutdown disables game controls and explains how to restart');
 assert.equal(events.filter(e=>e.method==='Runtime.exceptionThrown').length,0);
 console.log('PASS: live catalog selection, exact Unicode mod/hook payloads, channel mask, trigger/delay fields, recording locks and persisted settings; automatic catalogs, loading/error/empty states, retry and visible buttons.');
}finally{if(ws){try{await send('Browser.close');}catch{}ws.close();}chrome.kill();}})().catch(error=>{console.error(error);process.exitCode=1;});
