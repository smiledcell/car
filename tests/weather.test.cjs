/* Dependency-free weather/tyre tests: node tests/weather.test.cjs */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const file=path.join(__dirname,'..','js','weather-core.js');
const context=vm.createContext({console});
context.window=context;
vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
const W=context.APEX_WEATHER;
let count=0;
function test(name,fn){try{fn();count++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n  '+e.message);process.exitCode=1;}}
test('weather curve is deterministic and covers dry, damp and wet',()=>{
  assert.equal(W.wetnessAt(0),0);
  assert.equal(W.wetnessAt(.12),0);
  assert.ok(Math.abs(W.wetnessAt(.24)-.5)<1e-9,'Damp plateau');
  assert.ok(Math.abs(W.wetnessAt(.58)-.95)<1e-9,'Wet peak');
  assert.ok(Math.abs(W.wetnessAt(.9))<1e-9,'Drying end');
  const a=W.createState(),b=W.createState();
  W.update(a,.5);W.update(b,.5);
  assert.deepEqual(a,b,'Same fraction must produce identical weather');
  assert.equal(a.phase,'wet');
  assert.equal(W.phaseAt(.2),'dry');
  assert.equal(W.phaseAt(.4),'damp');
  assert.equal(W.phaseAt(.8),'wet');
});
test('compound grip crosses over between dry and wet',()=>{
  const dryS=W.grip('S',0,95,0), dryW=W.grip('W',0,95,0);
  assert.ok(dryS>dryW,'Slick must beat wet tyre in the dry');
  const wetS=W.grip('S',.95,95,0), wetW=W.grip('W',.95,62,0), wetI=W.grip('I',.95,70,0);
  assert.ok(wetW>wetI&&wetI>wetS,'W > I > dry tyre in heavy wet');
  assert.ok(wetW>W.grip('W',0,62,0),'Wet tyre must be faster in the wet');
  assert.ok(dryS>wetS,'Slick must lose grip in the wet');
});
test('temperature and wear reduce grip',()=>{
  const base=W.grip('M',0,90,0);
  assert.ok(W.grip('M',0,135,0)<base,'Overheat has no grip penalty');
  assert.ok(W.grip('M',0,40,0)<base,'Cold tyre has no grip penalty');
  assert.ok(W.grip('M',0,90,.8)<base,'Worn tyre has no grip penalty');
});
test('racing line dries faster than off-line surface',()=>{
  const wet=.55;
  assert.ok(W.lineWetness(wet,true)<W.lineWetness(wet,false),'Racing line is not drier');
  const onLine=W.grip('S',W.lineWetness(wet,true),95,0), offLine=W.grip('S',W.lineWetness(wet,false),95,0);
  assert.ok(onLine>offLine,'Racing line grip advantage missing');
  assert.ok(W.lineWetness(.95,true)>=.79,'Heavy rain should keep the line wet');
  assert.ok(W.lineWetness(0,true)===0);
});
test('tyre temperature heats under speed and cools when slow',()=>{
  let t=70;
  for(let i=0;i<400;i++)t=W.tempStep(t,74,0,'M',.05,false);
  assert.ok(t>85,'Tyre never heats up');
  for(let i=0;i<1200;i++)t=W.tempStep(t,0,0,'M',.05,false);
  assert.ok(t<60,'Tyre never cools down');
  const before=70; const braking=W.tempStep(before,74,0,'M',10,true);
  assert.ok(braking>W.tempStep(before,74,0,'M',10,false),'Braking should add heat');
});
test('wear increases, is bounded and wet reduces slick wear',()=>{
  let dry=0,wet=0;
  for(let i=0;i<200;i++){
    dry=W.wearStep(dry,70,0,'S',95,.05);
    wet=W.wearStep(wet,70,.9,'S',95,.05);
  }
  assert.ok(dry>0&&dry<=1,'Wear invalid');
  assert.ok(wet<dry,'Wet surface should reduce slick wear');
  assert.equal(W.wearStep(1,70,0,'M',90,.05),1,'Wear not capped');
});
test('aquaplaning rises with water and speed, and wet tyres resist',()=>{
  assert.equal(W.aquaplaning(.5,'S',80,0),0);
  const slick=W.aquaplaning(.9,'S',80,0), inter=W.aquaplaning(.9,'I',80,0), wets=W.aquaplaning(.9,'W',80,0);
  assert.ok(slick>inter&&inter>wets,'Wet tyres do not reduce aquaplaning');
  assert.ok(W.aquaplaning(.9,'S',100,.8)>W.aquaplaning(.9,'S',40,0),'Speed/wear must increase risk');
  assert.ok(slick<=1);
});
test('wet pace and recommendation follow the surface',()=>{
  assert.equal(W.pace(0),1);
  assert.ok(W.pace(.95)<.85);
  assert.equal(W.recommended(0),'M');
  assert.equal(W.recommended(.55),'I');
  assert.equal(W.recommended(.9),'W');
});
console.log(`${count}/8 weather tests passed`);
