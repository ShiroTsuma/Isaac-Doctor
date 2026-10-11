const test=require('node:test'),assert=require('node:assert/strict');
const {TimeIndex}=require('../viewer/src/time-index.ts');
test('interval search retains long overlapping spans with unordered ends',()=>{
 let seed=1234;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
 const rows=Array.from({length:10000},(_,id)=>{const minimum=random()*1000;return {id,minimum,maximum:minimum+random()*200}});rows.push({id:10000,minimum:0,maximum:10000});const index=new TimeIndex(rows);
 for(let i=0;i<200;i++){const start=random()*1200,end=start+random()*20;assert.deepEqual(index.query(start,end).map(x=>x.id).sort((a,b)=>a-b),rows.filter(x=>x.maximum>=start && x.minimum<=end).map(x=>x.id).sort((a,b)=>a-b));}
});
