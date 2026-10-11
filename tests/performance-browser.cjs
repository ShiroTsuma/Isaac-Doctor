/* Real Chrome folder-input test. Build viewer and start viewer-server.py first. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/performance-browser-qa');
const fixtureDir=path.join(root,'build/stream-dev/Release/captures');
const filesList=fs.readdirSync(fixtureDir).map(n=>path.join(fixtureDir,n));
const {readFileSync}=fs;
const small=filesList.find(p=>{try{const {execFileSync}=require('node:child_process');return execFileSync('python',['-c',`import sys;sys.path.insert(0,'tools');from capture import read_capture;d=read_capture(sys.argv[1]);print(len(d['screenshots']['images']))`,p],{cwd:root,encoding:'utf8'}).trim()!=='0';}catch{return false;}});
assert(small,'Run stream-smoke.py first');
const large=readFileSync(path.join(root,'build/stream-dev/Release/large-capture-path.txt'),'utf8').trim();
const frameFile=readFileSync(path.join(root,'build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim();
const sourceDir=path.join(out,'sources'),nestedSource=path.join(sourceDir,'tests');fs.mkdirSync(nestedSource,{recursive:true});fs.copyFileSync(path.join(root,'tests/recording-scenario.lua'),path.join(nestedSource,'scenario.lua'));
const chrome=spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new','--remote-debugging-port=9331',`--user-data-dir=${path.join(out,'profile-'+process.pid)}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,session,sequence=0;const pending=new Map(),events=[];
async function until(fn){for(let i=0;i<600;i++){const value=await fn();if(value)return value;await delay(50);}throw Error('UI test timeout');}
function send(method,params={},sid){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method} ${(params.expression || '').slice(0,160)}`));},20000);pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function mouse(type,p){await send('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...p},session);}
async function click(selector){const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await mouse('mousePressed',p);await mouse('mouseReleased',p);}
async function files(selector,paths){const doc=await send('DOM.getDocument',{},session),input=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector},session);await send('DOM.setFileInputFiles',{nodeId:input.nodeId,files:paths},session);}
(async()=>{try{
 const version=await until(async()=>{try{return await(await fetch('http://127.0.0.1:9331/json/version')).json()}catch{return false}});
 ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise(ok=>ws.addEventListener('open',ok,{once:true}));ws.addEventListener('message',message=>{const data=JSON.parse(message.data);if(data.id){const p=pending.get(data.id);if(p){pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(Error(data.error.message)):p.resolve(data.result);}}else events.push(data)});
 const target=await send('Target.createTarget',{url:'about:blank'});session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;await send('Runtime.enable',{},session);await send('Page.enable',{},session);await send('Network.enable',{},session);
 await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.NativeWorker=Worker;window.Worker=class extends Worker{constructor(url,...args){super(url,...args);window.qaWorkerURL=url;}};window.fetch=(url)=>Promise.resolve(new Response(JSON.stringify(String(url)==='/api/session'?{token:'test'}:{ok:true,state:'ready',message:'QA'}),{headers:{'Content-Type':'application/json'}}));`},session);
 await send('Page.navigate',{url:process.env.ISAACPROF_TEST_URL || 'http://127.0.0.1:8765/'},session);await until(()=>evaluate('!!document.querySelector("#file")'));
 const recording=process.env.ISAACPROF_CAPTURE || large;await files('#file',[recording]);await until(()=>evaluate(`document.querySelector('#filename').textContent.includes(${JSON.stringify(path.basename(recording))})`));
 const results=await evaluate(`(async()=>{const worker=new NativeWorker(qaWorkerURL,{type:'module',name:'isaacprof-timeline'});let id=0;const requests=new Map();worker.onmessage=e=>{const p=requests.get(e.data.id);if(p){requests.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.result)}};const call=(type,payload)=>new Promise((resolve,reject)=>{const at=++id;requests.set(at,{resolve,reject});worker.postMessage({id:at,type,payload})});const rows=[];async function measure(label,type,payload){const start=performance.now(),value=await call(type,payload);rows.push({label,ms:Math.round(performance.now()-start),visible:value.visibleCount});return value}try{const loaded=await measure('load','load',{file:document.querySelector('#file').files[0]}),middle=loaded.duration*.55;await measure('full','viewport',{start:0,end:loaded.duration,width:1400});for(const span of [10000,1000,100,100])await measure(span+'ms','viewport',{start:middle,end:middle+span,width:1400});const start=performance.now();const outcomes=await Promise.all(Array.from({length:20},(_,i)=>call('viewport',{start:middle+i,end:middle+i+1000,width:1400}).then(()=>true,()=>false)));rows.push({label:'rapid 20 views',ms:Math.round(performance.now()-start),completed:outcomes.filter(Boolean).length});return rows}finally{worker.terminate()}})()`);
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(results);
 assert(results.at(-1).completed<20,'Superseded views must be cancelled');assert(!events.some(e=>e.method==='Network.requestWillBeSent' && e.params.request.method==='POST'),'No file upload');
}finally{if(ws)ws.close();chrome.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
