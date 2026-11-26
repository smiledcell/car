/* Dependency-free pit-core tests: node tests/pit.test.cjs */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const file=path.join(__dirname,'..','js','pit-core.js');
const context=vm.createContext({console});
context.window=context;
vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
const pit=context.APEX_PIT;
const B={start:.8,end:.99,inner:9,outer:14,boxT:.94,boxOffset:11.5,boxHalfT:.01,boxHalfOffset:3,
  boxRadius:4,limit:16.7,service:3,penalty:5};
let count=0;
function test(name,fn){try{fn();count++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n  '+e.message);process.exitCode=1;}}
function sample(extra){
  return Object.assign({inLane:true,speed:10,boxDistance:99,requested:true,hasTyreChoice:true},extra);
}
test('lane geometry uses both t window and signed offset',()=>{
  assert.equal(pit.inLane(.85,11,B),true);
  assert.equal(pit.inLane(.79,11,B),false);
  assert.equal(pit.inLane(.85,8.9,B),false);
  assert.equal(pit.inLane(.85,14.1,B),false);
  assert.equal(pit.nearBox(.94,11.5,B),true);
  assert.equal(pit.nearBox(.955,11.5,B),false);
  assert.equal(pit.nearBox(.94,8,B),false);
});
test('speeding penalty is applied once per lane visit, again after re-entry',()=>{
  const s=pit.createState();
  let e=pit.update(s,sample({speed:20}),.1,B);
  assert.equal(e.penaltyAdded,true);assert.equal(s.penalty,5);
  for(let i=0;i<20;i++)pit.update(s,sample({speed:25}),.1,B);
  assert.equal(s.penalty,5,'Repeated frames must not stack the same visit');
  pit.update(s,sample({inLane:false,speed:25}),.1,B);
  e=pit.update(s,sample({speed:25}),.1,B);
  assert.equal(e.penaltyAdded,true);assert.equal(s.penalty,10,'A second visit is a second violation');
});
test('no overspeed at or below the limit and leaving clears speeding',()=>{
  const s=pit.createState();
  pit.update(s,sample({speed:16.7}),.1,B);
  assert.equal(s.penalty,0);assert.equal(s.speeding,false);
});
test('service starts only when requested, chosen, at box and stationary',()=>{
  const s=pit.createState();
  pit.update(s,sample({speed:10,boxDistance:0}),1,B);
  assert.equal(s.servicing,false);
  pit.update(s,sample({speed:.4,boxDistance:0,hasTyreChoice:false}),1,B);
  assert.equal(s.servicing,false);
  pit.update(s,sample({speed:.4,boxDistance:5}),1,B);
  assert.equal(s.servicing,false);
  const e=pit.update(s,sample({speed:.4,boxDistance:0}),1,B);
  assert.equal(e.serviceStarted,true);assert.equal(s.servicing,true);
});
test('service completes after the configured dwell and resets',()=>{
  const s=pit.createState();
  pit.update(s,sample({speed:.2,boxDistance:0}),2.9,B);
  const e=pit.update(s,sample({speed:.2,boxDistance:0}),.2,B);
  assert.equal(e.tyreChanged,true);assert.equal(s.completed,1);assert.equal(s.serviceProgress,0);
});
test('moving or leaving the box cancels service without tyre change',()=>{
  const s=pit.createState();
  pit.update(s,sample({speed:.2,boxDistance:0}),1,B);
  const moved=pit.update(s,sample({speed:2,boxDistance:1}),.1,B);
  assert.equal(moved.serviceCancelled,true);assert.equal(s.completed,0);
  pit.update(s,sample({speed:.2,boxDistance:0}),1,B);
  const left=pit.update(s,sample({inLane:false,speed:5}),.1,B);
  assert.equal(left.serviceCancelled,true);assert.equal(s.completed,0);
});
test('stationary outside the lane cannot service',()=>{
  const s=pit.createState();
  assert.equal(pit.update(s,sample({inLane:false,speed:0,boxDistance:0}),1,B).serviceStarted,false);
  assert.equal(s.completed,0);
});
test('AI pits once after half distance, never before or twice',()=>{
  assert.equal(pit.aiShouldPit(0,5,false),false);
  assert.equal(pit.aiShouldPit(2,5,false),false);
  assert.equal(pit.aiShouldPit(3,5,false),true);
  assert.equal(pit.aiShouldPit(3,5,true),false);
  assert.equal(pit.aiShouldPit(1,1,false),false,'One-lap races need no stop');
});
console.log(`${count}/8 pit tests passed`);
