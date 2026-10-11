const test=require('node:test'),assert=require('node:assert/strict');
const {recordingTimestamp,recordingOrder,recordingLabel}=require('../viewer/src/recording-files.ts');
const {readRecordingConfig,validDelay,readCaptureScope,effectiveRecordingConfig,validRecordingConfig}=require('../viewer/src/recording-config.ts');
test('UTC capture names retain chronological order after prepared analysis changes mtime',()=>{
 const old={key:'old',file:{name:'capture-2026-10-11_19-00-00-123Z-pid7-10.isaacprof',lastModified:Date.parse('2026-10-12T20:00:00Z')}},fresh={key:'new',file:{name:'capture-2026-10-11_20-00-00-456Z-pid8-11.isaacprof',lastModified:Date.parse('2026-10-11T20:00:01Z')}};
 assert.equal(recordingTimestamp(old.file.name),Date.parse('2026-10-11T19:00:00.123Z'));assert.deepEqual([old,fresh].sort(recordingOrder),[fresh,old]);
 assert.equal(recordingTimestamp('capture-7-100.isaacprof'),null);assert.equal(recordingTimestamp('capture-2026-02-30_19-00-00-123Z-pid7-10.isaacprof'),null);
 assert.match(recordingLabel({name:'capture-7-100.isaacprof',lastModified:0}),/^Modified /);assert(!recordingLabel(fresh.file).startsWith('Modified'));
});
test('recording trigger preferences reject invalid restored values and millisecond delays',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{value:undefined,writable:true,configurable:true});
 try{
  global.localStorage={getItem:()=>JSON.stringify({startOn:'room-entry',stopOn:'projectile',startDelayMs:250,stopDelayMs:1000,maxDurationMs:25000})};assert.deepEqual(readRecordingConfig(),{startOn:'room-entry',stopOn:'projectile',startDelayMs:250,stopDelayMs:1000,maxDurationMs:25000});
  global.localStorage={getItem:()=>JSON.stringify({startOn:'manual',stopOn:'immediate',startDelayMs:-1,stopDelayMs:1.5})};assert.deepEqual(readRecordingConfig(),{startOn:'run-load',stopOn:'duration',startDelayMs:0,stopDelayMs:0,maxDurationMs:0});
  for(const invalid of [NaN,Infinity,-1,1.5,3600001])assert(!validDelay(invalid));assert(validDelay(0) && validDelay(3600000));
 }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;}
});

test('empty delays mean zero; manual stop ignores its unused delay and duration ignores its unused maximum',()=>{
 const base={startOn:'immediate',stopOn:'manual',startDelayMs:NaN,stopDelayMs:NaN,maxDurationMs:0};
 assert(validRecordingConfig(base));assert.deepEqual(effectiveRecordingConfig(base),{...base,startDelayMs:0,stopDelayMs:0});
 assert(validRecordingConfig({...base,stopDelayMs:-1}));
 assert(validRecordingConfig({...base,stopOn:'duration',maxDurationMs:NaN}));
 assert.equal(effectiveRecordingConfig({...base,stopOn:'duration',stopDelayMs:500}).stopDelayMs,0);
 assert(validRecordingConfig({...base,stopOn:'projectile',maxDurationMs:25000}));
 for(const maxDurationMs of [NaN,-1,500,1001,3600001])assert(!validRecordingConfig({...base,maxDurationMs}));
 for(const startDelayMs of [-1,1.5,Infinity])assert(!validRecordingConfig({...base,startDelayMs}));
 assert(!validRecordingConfig({...base,stopOn:'projectile',stopDelayMs:-1}));
});

test('capture scope preferences preserve exact Unicode names and reject corrupt masks / scope',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{value:undefined,writable:true,configurable:true});
 try{
  global.localStorage={getItem:()=>JSON.stringify({channels:12,selectedMods:['Mód'],selectedHooks:['MC_POST_RENDER']})};assert.deepEqual(readCaptureScope(),{channels:12,selectedMods:['Mód'],selectedHooks:['MC_POST_RENDER']});
  global.localStorage={getItem:()=>JSON.stringify({channels:2048,selectedMods:['bad\nname'],selectedHooks:'bad'})};assert.deepEqual(readCaptureScope(),{channels:2047,selectedMods:[],selectedHooks:[]});
 }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;}
});
