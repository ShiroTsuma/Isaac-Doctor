const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {CaptureFile}=require('../viewer/scripts/capture-file.mts'),{StreamCapture}=require('../viewer/src/stream.ts');
const {rankCapture,eventsCapture,framesCapture,summaryCapture,treeCapture}=require('../viewer/src/analysis.ts');
const {frameResults}=require('../viewer/src/frames.ts');
const root=path.resolve(__dirname,'..'),fixture=fs.readFileSync(path.join(root,'build/stream-dev/Release/frame-capture-path.txt'),'utf8').trim();
fs.mkdirSync(path.join(root,'build/cli-qa'),{recursive:true});
const cli=path.join(root,'viewer/scripts/analyze.mts');
const query={mode:'mods',start:0,end:1,range:false,search:'',sort:'exclusive',descending:true};
function run(command,args=[],input){const result=spawnSync(process.execPath,[cli,command,fixture,...args],{cwd:root,encoding:'utf8',input,maxBuffer:8*1024*1024,timeout:30000});assert.ifError(result.error);return result;}
function json(command,args=[]){const result=run(command,args);assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);assert(output.ok);return output;}
async function capture(){const file=await CaptureFile.open(fixture),stream=new StreamCapture(file);await stream.load({screenshots:false,overview:false});return {file,stream};}

test('presentation sorts use their own fields and support recordings without this channel',()=>{
 for(const sort of ['start','duration','swap','readback','outside','cycles']){
  const result=json('presentation',['--sort',sort,'--top','3','--non-interactive']);
  assert.equal(result.result.available,false);
  assert.equal(result.result.count,0);
 }
 const invalid=run('presentation',['--sort','exclusive']);
 assert.equal(invalid.status,1);
 assert.match(JSON.parse(invalid.stderr).error,/presentation sort/);
});

test('machine-readable capabilities and recording discovery require no capture decoding',()=>{const manifest=spawnSync(process.execPath,[cli,'--describe'],{encoding:'utf8'});assert.equal(manifest.status,0);const capabilities=JSON.parse(manifest.stdout);assert(capabilities.commands.some(c=>c.command==='source'));assert(capabilities.network===false);const list=spawnSync(process.execPath,[cli,'list',path.dirname(fixture),'--top','3'],{encoding:'utf8'});assert.equal(list.status,0,list.stderr);const result=JSON.parse(list.stdout);assert(result.result.rows.length>0 && result.result.rows.length<=3);assert(result.result.rows.every(r=>r.path.endsWith('.isaacprof')));assert.equal(result.diagnostics.read_bytes,0);});

test('CLI exposes channels, native coverage and actual rates using bounded reads',()=>{
  const list=run('list',['--top','3']);assert.equal(list.status,1,'list requires a folder, not the current fixture file');
  const info=json('info');assert.equal(info.schema,'isaacprof-cli/v1');assert(info.result.complete);assert(info.result.channels.some(c=>c.name==='frame_intervals' && c.records>50));assert(info.result.channels.some(c=>c.name==='screenshots' && c.records>0));
  const report=json('report',['--top','3']);assert(report.result.summary.render.rate>0);assert(report.result.hot_callbacks.length>0);assert(report.result.slow_render_intervals[0].calls>0);assert(report.result.slow_render_intervals[0].retained_callback_self_ms>0);assert(report.result.telemetry.counter_samples>0);assert(report.result.inventory.source_count>0);
  assert(report.result.inventory.sources.length<=3);assert(!report.result.mods[0].children);assert.equal(report.result.slow_render_intervals[0].costliest_metric.self_ms,undefined,'Frame identity must not masquerade as session timing');
});
test('shared CLI/viewer rank, event filters and frame attribution agree with raw interval analysis',async()=>{
  const {file,stream}=await capture();try{
    const q={...query,end:stream.duration},full=await rankCapture(stream,q),wire=json('rank',['--top','5']);assert.equal(wire.result.rows[0].self_ms,full.rows[0].exclusive);assert.equal(wire.result.rows[0].calls,full.rows[0].calls);assert.equal(wire.result.population,'native_unfiltered_aggregates');const retained=json('rank',['--start-ms','0','--end-ms',String(stream.duration)]);assert.equal(retained.result.population,'retained_calls_by_start');
    const group=full.rows.find(row=>row.children?.length);assert(group && group.children.some(row=>row.children?.length));
    const metric=[...stream.metrics.values()].find(m=>m.calls && !m.mod.startsWith('IsaacProf'));const events=await eventsCapture(stream,{...q,sort:'duration',metric:metric.id},10,1);
    assert(events.rows.every(e=>e.metric===metric.id && e.duration>=.001));assert(events.rows.every((e,i)=>!i || events.rows[i-1].duration>=e.duration));
    const framesQuery={kind:2,start:0,end:stream.duration,minimumUs:0,search:''};
    const expected=await frameResults(stream.intervals(0,stream.duration),(a,b)=>stream.events(a,b),stream.metrics,framesQuery,false,undefined,undefined,5),actual=await framesCapture(stream,framesQuery,true,5);
    for(let i=0;i<expected.rows.length;i++){assert.equal(actual.rows[i].calls,expected.rows[i].calls);assert(Math.abs(actual.rows[i].self-expected.rows[i].self)<1e-6);assert.equal(actual.rows[i].worstMetric,expected.rows[i].worstMetric);}
    const summary=await summaryCapture(stream);assert.equal(summary.render.count,actual.count);assert(Math.abs(summary.render.rate-actual.rate)<1e-8);
    const tree=await treeCapture(stream,q,2);assert(tree.count<=2);assert(tree.rows.length>0);
  }finally{await file.close();}
});
test('JSONL session keeps capture identity and cache; malformed requests do not terminate it',()=>{
  const input=[{id:'a',command:'rank',args:['--start-ms','0','--end-ms','100','--top','3']},{id:'b',command:'rank',args:['--start-ms','0','--end-ms','100','--group','hooks','--top','3']},{id:'bad',command:'rank',args:['--end-ms','-1']},{id:'c',command:'summary',args:[]}].map(x=>JSON.stringify(x)).join('\n')+'\n';
  const result=run('serve',[],input);assert.equal(result.status,0,result.stderr);const lines=result.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(lines.length,5);assert.equal(lines[0].type,'ready');assert(lines[1].ok && lines[2].ok && lines[4].ok);assert.equal(lines[3].ok,false);assert.equal(lines[3].id,'bad');assert.equal(lines[2].diagnostics.read_bytes,0);assert.equal(lines[1].capture_key,lines[4].capture_key);
});
test('empty cached cadence cannot hide recorded native frame intervals',async()=>{
  const {file,stream}=await capture();try{await stream.prepare();for(const quarter of stream.analysis.quarters)for(const frame of quarter.frames){frame.count=frame.total=frame.maximum=0;frame.histogram.fill(0);}stream.analysis.summaries.clear();
    const summary=await summaryCapture(stream),frames=await framesCapture(stream,{kind:2,start:0,end:stream.duration,minimumUs:0,search:''},false,5);
    assert(summary.render.count>0 && summary.render.rate>0);assert.equal(frames.count,summary.render.count);assert(frames.p50>0 && frames.rate>0);
  }finally{await file.close();}
});
test('CLI refuses invalid options, ranges, I/O budget overruns and screenshot overwrite',()=>{
  for(const args of [['--top','0'],['--end-ms','-1'],['--sort','missing'],['--top','501'],['--ascending','--descending']]){const result=run('rank',args);assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).ok,false);}
  assert.equal(run('info',['--mod','ignored']).status,1);assert.equal(run('info',['--max-read-mib','0']).status,1);
  const folder=fs.mkdtempSync(path.join(root,'build/cli-qa/export-')),target=path.join(folder,'shot.png');const result=json('screenshot',['--index','0','--output',target]);assert(result.result.width>0);const bytes=fs.readFileSync(target);assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(run('screenshot',['--index','0','--output',target]).status,1);assert.deepEqual(fs.readFileSync(target),bytes);
});
test('source context resolves local files and explicitly reports ambiguity and hash availability',()=>{
  const metrics=json('metrics',['--top','100']).result.rows,metric=metrics.find(m=>m.source.endsWith('tests/scenario.lua'));assert(metric);
  const folder=fs.mkdtempSync(path.join(root,'build/cli-qa/source-'));fs.mkdirSync(path.join(folder,'tests'));fs.copyFileSync(path.join(root,'tests/recording-scenario.lua'),path.join(folder,'tests/scenario.lua'));
  const result=json('source',['--metric',String(metric.id),'--mods',folder]);assert.equal(result.result.status,'found');assert(result.result.lines.some(line=>line.definition));assert(result.result.lines.length<=24);assert(result.result.sha256.length===64);
  for(const name of ['a','b']){fs.mkdirSync(path.join(folder,name,'tests'),{recursive:true});fs.copyFileSync(path.join(root,'tests/recording-scenario.lua'),path.join(folder,name,'tests/scenario.lua'));}const ambiguous=json('source',['--metric',String(metric.id),'--mods',folder]);assert.equal(ambiguous.result.status,'ambiguous');assert.equal(ambiguous.result.candidates.length,3);const explicit=json('source',['--metric',String(metric.id),'--mods',folder,'--source-file',path.join(folder,'a/tests/scenario.lua')]);assert.equal(explicit.result.status,'found');
});
test('verification checks every native header and payload CRC; range reads remain byte bounded',async()=>{
  const result=json('verify');assert(result.result.blocks>0 && result.result.payload_bytes>0);
  const {file,stream}=await capture();try{const b=stream.blocks.find(b=>b.type===2),copy=Buffer.from(fs.readFileSync(fixture));copy[b.offset+48+8]^=1;const folder=fs.mkdtempSync(path.join(root,'build/cli-qa/corrupt-')),target=path.join(folder,'corrupt.isaacprof');fs.writeFileSync(target,copy);
    const bad=spawnSync(process.execPath,[cli,'verify',target],{cwd:root,encoding:'utf8',timeout:30000});assert.equal(bad.status,1);assert.match(JSON.parse(bad.stderr).error,/checksum/);
  }finally{await file.close();}
});

test('explicit prepare writes only an appendix, is idempotent and non-interactive output stays clean',()=>{
 const folder=fs.mkdtempSync(path.join(root,'build/cli-qa/prepare-')),target=path.join(folder,'owned.isaacprof');fs.copyFileSync(fixture,target);const original=fs.readFileSync(target);
 function prepare(args){return spawnSync(process.execPath,[cli,'prepare',target,...args],{encoding:'utf8',timeout:30000});}
 const rejected=prepare(['--non-interactive']);assert.equal(rejected.status,1);assert.deepEqual(fs.readFileSync(target),original);
 const result=prepare(['--write','--non-interactive']);assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');const data=JSON.parse(result.stdout).result;assert(data.updated && data.overview_events>0 && data.overview_columns===4096);
 const prepared=fs.readFileSync(target);assert.deepEqual(prepared.subarray(0,original.length),original);const repeated=prepare(['--write','--non-interactive']);assert.equal(repeated.status,0,repeated.stderr);assert.equal(JSON.parse(repeated.stdout).result.updated,false);assert.deepEqual(fs.readFileSync(target),prepared);
 const session=run('serve',['--non-interactive'],JSON.stringify({id:1,command:'prepare',args:['--write']})+'\n');assert.equal(session.stderr,'');assert(!JSON.parse(session.stdout.trim().split('\n')[0]).commands.includes('prepare'));assert.equal(JSON.parse(session.stdout.trim().split('\n')[1]).ok,false);
 const info=run('info',['--non-interactive']);assert.equal(info.status,0);assert.equal(info.stderr,'');assert(JSON.parse(info.stdout).ok);
});

test('appendix writes reject file changes and roll back a failed partial write',async()=>{
 const folder=fs.mkdtempSync(path.join(root,'build/cli-qa/rollback-')),target=path.join(folder,'owned.isaacprof');fs.copyFileSync(fixture,target);const original=fs.readFileSync(target),file=await CaptureFile.open(target,Infinity,true);
 try{const stream=new StreamCapture(file);await stream.load({overview:false,screenshots:false});const section=await stream.appendix(),write=file.handle.write.bind(file.handle);let fail=true;
  file.handle.write=async(...args)=>{if(fail){fail=false;await write(...args);throw Error('Injected write failure');}return write(...args);};await assert.rejects(file.writeAppendix(section.sourceSize,section.appendix),/Injected/);assert.deepEqual(fs.readFileSync(target),original);
  fs.appendFileSync(target,Buffer.from([1]));await assert.rejects(file.writeAppendix(section.sourceSize,section.appendix),/changed/);assert.equal(fs.statSync(target).size,original.length+1);
 }finally{await file.close();}
});

test('TTY progress reuses stderr and --non-interactive suppresses it even in a terminal',()=>{
 const {pathToFileURL}=require('node:url');
 function terminal(args){return spawnSync(process.execPath,['--input-type=module','-e',`process.stderr.isTTY=true;process.argv=['node',${JSON.stringify(cli)},'info',${JSON.stringify(fixture)},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(cli).href)});`],{encoding:'utf8',timeout:30000});}
 const normal=terminal([]);assert.equal(normal.status,0,normal.stderr);assert.match(normal.stderr,/\rReading capture index:/);assert(JSON.parse(normal.stdout).ok);assert.equal(normal.stderr.split('\n').length,2,'Only one completed progress line');
 const ai=terminal(['--non-interactive']);assert.equal(ai.status,0,ai.stderr);assert.equal(ai.stderr,'');assert(JSON.parse(ai.stdout).ok);
});

test('diagnose exposes all-interval cohort attribution with bounded windows and rejects invalid window sizes',()=>{
 const result=json('diagnose',['--top','3','--window-ms','100','--non-interactive']);assert(result.result.summary.count>0);assert(result.result.cohorts.some(c=>c.name==='slow_with_update'));assert(result.result.windows.length<=300);assert(result.result.windows.every(w=>w.callbacks.length<=3));assert(result.result.coverage.attributed_calls>0);assert.equal(result.result.summary.instantaneous_rate_percentiles.unit,'FPS');assert.equal(run('diagnose',['--window-ms','0']).status,1);
});

test('frame CLI shares matched reference details with the viewer and rejects missing IDs',()=>{
 const diagnosis=json('diagnose',['--top','3','--non-interactive']).result.matched_slow_frames;
 assert(diagnosis.slowest_intervals.length>0);
 const id=diagnosis.slowest_intervals[0].id,result=json('frame',['--id',String(id),'--top','3','--non-interactive']).result;
 assert.equal(result.frame.id,id);assert(result.reference.frames.length<=5);assert.equal(result.node_limit,500);
 if(result.baseline){assert.equal(result.extra_callback_self_ms,result.self-result.baselineSelf);assert(Math.abs(result.extra_wall_ms-result.extra_callback_self_ms-result.extra_unattributed_wall_ms)<1e-9);}
 else{assert.equal(result.extra_callback_self_ms,null);assert.equal(result.extra_wall_ms,null);assert.equal(result.extra_unattributed_wall_ms,null);}
 assert.equal(run('frame').status,1);assert.equal(run('frame',['--id','4294967295']).status,1);
});
