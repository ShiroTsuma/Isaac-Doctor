const test=require('node:test');
const assert=require('node:assert/strict');
const {searchNavigation,navigationViews,navigationCommands}=require('../viewer/src/navigation.ts');
const entries=[...navigationViews,...navigationCommands,
 {id:'file',label:'capture-2026-10-12.isaacprof',category:'Recording',keywords:'capture-2026-10-12',description:'Local recording'},
 {id:'source',label:'@mods/reverie/foo.lua:42',category:'Source',keywords:'reverie foo',description:'Reverie / update'},
 {id:'mod',label:'Reverie',category:'Mod',keywords:'reverie',description:'Bottom-up / Mods'}];
test('navigation matches compound aliases and ranks actual destinations before general commands',()=>{
 assert.equal(searchNavigation(entries,'swap buffers')[0].id,'swap');
 assert.equal(searchNavigation(entries,'SwapBuffers')[0].id,'swap');
 assert.equal(searchNavigation(entries,'native instruction')[0].id,'samples');
 assert.equal(searchNavigation(entries,'FPS')[0].id,'graph-fps');
 assert.equal(searchNavigation(entries,'reverie')[0].id,'mod');
 assert.equal(searchNavigation(entries,'not-a-destination').length,0);
});
test('prefixes separate commands, local files and symbols without running anything',()=>{
 assert.ok(searchNavigation(entries,'> record').every(x=>x.category==='Command'));
 assert.equal(searchNavigation(entries,'/ capture')[0].id,'file');
 assert.equal(searchNavigation(entries,'/ foo')[0].id,'source');
 assert.equal(searchNavigation(entries,'@ reverie')[0].id,'mod');
 assert.ok(searchNavigation(entries,'>',100).every(x=>x.category==='Command'));
 assert.equal(searchNavigation(entries,'',3).length,3);
});
