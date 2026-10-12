const test = require('node:test');
const assert = require('node:assert/strict');
const { instructionCapture } = require('../viewer/src/instruction-samples.ts');
function capture(samples, channels = 12288) {
  return {
    duration: 600, document: {configuration: {channels}}, blocks: [],
    async nativeModules() { return [{base: 0x1000n, size: 0x100n, path: 'G:\\Game\\isaac-ng.exe'}]; },
    async samplingStats() { return {attempts: 4}; },
    async *instructionSamples(start, end) { yield* samples.filter(s => s.time >= start && s.time < end); },
    async *waits(start, end) { yield* [{thread: 7, start: 249, duration: 4}, {thread: 8, start: 400, duration: 3}].filter(w => w.start < end && w.start + w.duration > start); },
  };
}
const row = (time, address = '0x1010', thread = 7) => ({time, address, thread, pause: .01, flags: 7, cycles: 1000, returns: ['0x1040','0x1040']});
test('samples classify same-thread waits across query windows and retain exact return candidates', async () => {
  const result = await instructionCapture(capture([row(248),row(250),row(253,'0x1030'),row(400,'0x2000')]), 0, 600, 1);
  assert.equal(result.count, 4);
  assert.equal(result.coveredWait, 1);
  assert.equal(result.outsideCoveredWait, 3);
  assert.equal(result.hotspots[0].location, 'isaac-ng.exe+0x0–0x3f');
  assert.equal(result.hotspots[0].count, 3);
  assert.equal(result.returns[0].count, 4, 'Duplicate candidate in one snapshot should count once');
  assert.equal(result.returns[0].location, 'isaac-ng.exe+0x40');
  assert.equal(result.pauseTotal, .04);
  assert.match(result.limitation, /counts are not CPU time/);
});
test('missing wait coverage remains unknown and range is start-inclusive/end-exclusive', async () => {
  const result = await instructionCapture(capture([row(10),row(20),row(30)],8192),10,30);
  assert.equal(result.count, 2);
  assert.equal(result.coveredWait, null);
  assert.equal(result.outsideCoveredWait, null);
  assert.equal((await instructionCapture(capture([],0),0,600)).available,false);
  for (const [start,end,limit] of [[-1,10,1],[0,601,1],[5,5,1],[0,10,0],[0,10,501]]) await assert.rejects(instructionCapture(capture([]),start,end,limit),/Invalid/);
});

test('Lua source attribution joins matching thread/time and handles unresolved or failed contexts', async () => {
  const stream = capture([row(10), row(20), row(30), row(40), row(50)]);
  stream.blocks = [{type:22}, {type:23}];
  stream.metrics = new Map([[4,{id:4,mod:'Test mod',callback_name:'Render',source:'@wrapper.lua',line:8}]]);
  stream.luaInstructionSources = async () => new Map([[1,{source:'@actual.lua',line:42}]]);
  stream.luaInstructionContexts = async function* (start,end) {
    yield* [
      {time:10,thread:7,flags:1,metrics:[4],source:1},
      {time:20,thread:8,flags:1,metrics:[4],source:1},
      {time:30,thread:7,flags:1,metrics:[],source:1},
      {time:40,thread:7,flags:5,metrics:[],source:0},
      {time:50,thread:7,flags:9,metrics:[99],source:2},
    ].filter(x=>x.time>=start && x.time<end);
  };
  const result=await instructionCapture(stream,0,600);
  assert.equal(result.luaContexts,4);
  assert.equal(result.luaAttributed,1);
  assert.equal(result.luaReadFailures,1);
  assert.equal(result.luaSourceFailures,1);
  assert.equal(result.luaMissingMetrics,1);
  assert.equal(result.luaMissingSources,1);
  assert.equal(result.luaOwners[0].source,'@wrapper.lua');
  assert.equal(result.luaSources.length,2);
  assert.ok(result.luaSources.every(x=>x.source==='@actual.lua' && x.line===42 && x.count===1));
  assert.ok(result.luaSources.some(x=>x.mod==='Unwrapped Lua'));
});
