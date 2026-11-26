// Requires a headless Edge/Chrome CDP endpoint on 127.0.0.1:9231.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const results=[];
async function main(){
 const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
  const name=path.resolve(root,'.'+pathname);
  if(!name.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  fs.readFile(name,(err,data)=>{if(err){res.writeHead(404);return res.end();}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html; charset=utf-8');res.end(data);});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const target=await (await fetch('http://127.0.0.1:9231/json/new?about:blank',{method:'PUT'})).json();
 const ws=new WebSocket(target.webSocketDebuggerUrl);let id=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+': '+(m.params.exceptionDetails.exception?.description||''));};
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const i=++id;const timer=setTimeout(()=>{pending.delete(i);reject(Error('CDP timeout '+method));},15000);pending.set(i,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result)});ws.send(JSON.stringify({id:i,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 const wait=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+expression);};
 const check=(name,ok,detail)=>{results.push({name,pass:!!ok,detail});console.log((ok?'PASS ':'FAIL ')+name);};
 const navigate=async url=>{errors.length=0;await send('Page.navigate',{url});await wait('document.readyState==="complete"');};
 try{
  await send('Page.enable');await send('Runtime.enable');
  for(const prefix of [pathToFileURL(root+path.sep).href,base+'/']){
   await navigate(prefix+'tests/race-core.test.html');await wait('!!window.APEX_TEST_RESULTS');
   const pure=await evaluate('window.APEX_TEST_RESULTS');check(prefix+' pure tests',pure.passed===pure.total,pure);
   await navigate(prefix+'car.html?selftest=1');await wait('!!window.APEX_SMOKE_RESULTS');
   const smoke=await evaluate('window.APEX_SMOKE_RESULTS');check(prefix+' integration',smoke.passed===smoke.total&&errors.length===0,{smoke,errors:[...errors]});
  }
  await navigate(pathToFileURL(path.join(root,'dist/car.html')).href);await wait('!!document.querySelector("canvas")');
  check('standalone file release boot',await evaluate('!document.getElementById("startupWarning").hidden===false && racePhase==="grid"'),[...errors]);
  // Actual DOM click and CDP keyboard events, with deterministic simulation stepping.
  await evaluate('document.getElementById("startBtn").click()');
  check('start button click enters countdown',await evaluate('racePhase==="countdown" && menuEl.style.display==="none"'));
  await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyW',key:'w',windowsVirtualKeyCode:87});
  check('keyboard before GO stays frozen',await evaluate('update(.05); car.speed===0 && aiList.every(a=>a.racer.elapsed===0)'));
  await evaluate('for(let i=0;i<110;i++)update(.05)');
  await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyW',key:'w',windowsVirtualKeyCode:87});
  check('keyboard after GO accelerates',await evaluate('update(.05); car.speed>0'));
  await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyW',key:'w',windowsVirtualKeyCode:87});
  await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyR',key:'r',windowsVirtualKeyCode:82});
  check('R key resets session',await evaluate('car.speed===0 && playerRacer.elapsed===0 && racePhase==="countdown"'));
  await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyR',key:'r',windowsVirtualKeyCode:82});
  await navigate(base+'/car.html');await wait('!!document.querySelector("canvas")');
  const ids=await evaluate('TRACKS.map(t=>t.id)');
  for(const track of ids){
   await navigate(base+'/car.html?track='+track);await wait('!!document.querySelector("canvas")');
   check('track boot '+track,await evaluate(`selectedTrack.id===${JSON.stringify(track)} && TRACK_LEN>0 && racePhase==='grid' && document.getElementById('startupWarning').hidden`) && errors.length===0,[...errors]);
  }
  for(const track of ['monaco','japan','belgium','lasvegas']){
    await navigate(base+'/car.html?track='+track+'&selftest=1');await wait('!!window.APEX_SMOKE_RESULTS');
    const m3=await evaluate('({smoke:window.APEX_SMOKE_RESULTS,times:window.APEX_M3_TIMES})');
    check('M3 multi-lap difficulty/frame/collision '+track,m3.smoke.passed===m3.smoke.total&&errors.length===0,m3);
   }
   await navigate(base+'/car.html?track=spa');await wait('!!document.querySelector("canvas")');
  check('Spa URL alias',await evaluate('selectedTrack.id==="belgium"'));
  await evaluate(`modeSelect.value='qualifying';startBtn.click()`);
   check('M4 Q1 button and 22 entries',await evaluate(`mode==='qualifying'&&qualifying.activeIds.length===22&&!document.getElementById('qualPanel').hidden`));
   await evaluate(`for(let n=0;n<1400&&racePhase!=='qualResults';n++)tickQualifying(1);document.getElementById('qualContinue').click();renderHUD()`);
   await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyW',key:'w',windowsVirtualKeyCode:87});
   await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyP',key:'p',windowsVirtualKeyCode:80});
   check('M4 eliminated player remains spectator',await evaluate(`qualPlayerDone&&!started&&hudPosition.textContent.includes('OUT')&&pitModal.hidden`));
   await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyW',key:'w',windowsVirtualKeyCode:87});
   await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyP',key:'p',windowsVirtualKeyCode:80});
   await evaluate(`for(let s=0;s<2;s++){for(let n=0;n<1400&&racePhase!=='qualResults';n++)tickQualifying(1);document.getElementById('qualContinue').click();}`);
   check('M4 no-time elimination and 22-grid applied',await evaluate(`mode==='race'&&gridOrder.length===22&&gridOrder.indexOf('player')===21&&playerRacer.gridIndex===21&&aiList.length===21`));
   await evaluate(`countdown=0;update(.05);for(let n=0;n<60;n++)updateAI(1/60,false)`);
   check('M4 22-car race starts',await evaluate(`aiList.every(a=>Number.isFinite(a.speed))&&racePhase==='race'`));
   await evaluate(`resetCar()`);
   check('M4 reset preserves grid',await evaluate(`playerRacer.gridIndex===21&&allRacers().every(r=>r.elapsed===0)`));
   const fieldRun=await evaluate(`(()=>{totalLaps=3;racePhase='race';started=true;const begin=performance.now();let n=0;for(;n<12000&&!aiList.every(a=>a.racer.finished);n++)updateAI(.05,false);return {allFinished:aiList.every(a=>a.racer.completedLaps===3&&a.racer.finished),steps:n,computeMs:performance.now()-begin};})()`);
   check('M4 22-field AI three-lap finish',fieldRun.allFinished,fieldRun);
   await navigate(base+'/car.html');await wait('!!document.querySelector("canvas")');
   await evaluate(`document.getElementById('startBtn').click()`);
   await evaluate(`for(let i=0;i<110;i++)update(.05)`);
   await send('Input.dispatchKeyEvent',{type:'keyDown',code:'KeyP',key:'p',windowsVirtualKeyCode:80});
   check('M5 P requests a pit stop',await evaluate(`pitRequested&&hudPit.textContent.includes('REQUEST')`));
   await send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyP',key:'p',windowsVirtualKeyCode:80});
   await evaluate(`(()=>{const p=trackCurve.getPointAt(PIT_BOUNDS.start+.01),d=trackCurve.getTangentAt(PIT_BOUNDS.start+.01);car.pos.set(p.x-d.z*(PIT_BOUNDS.inner+2),0,p.z+d.x*(PIT_BOUNDS.inner+2));car.angle=Math.atan2(d.x,d.z);car.speed=25;})()`);
   await evaluate(`update(.05)`);
   check('M5 pit entry speeding gives one penalty',await evaluate(`penaltyTime===5&&Math.abs(car.speed)<=PIT_BOUNDS.limit+.1&&!pitModal.hidden`));
   await evaluate(`document.querySelector('input[name="tyre"][value="S"]').checked=true;document.getElementById('pitConfirm').click()`);
   check('M5 tyre selection from real DOM click',await evaluate(`pitChoice==='S'&&pitModal.hidden&&pitRequested`));
   await evaluate(`(()=>{const p=trackCurve.getPointAt(PIT_BOUNDS.boxT),d=trackCurve.getTangentAt(PIT_BOUNDS.boxT);car.pos.set(p.x-d.z*PIT_BOUNDS.boxOffset,0,p.z+d.x*PIT_BOUNDS.boxOffset);car.angle=Math.atan2(d.x,d.z);car.speed=0;})()`);
   await evaluate(`for(let i=0;i<35;i++)update(.1)`);
   check('M5 stationary box service fits tyres',await evaluate(`tyre==='S'&&tyreWear===0&&pitState.completed===1&&!pitRequested&&hudPit.textContent.includes('罚时')`));
   const m6=await evaluate(`(()=>{
     mode='race';totalLaps=5;resetCar();racePhase='race';started=true;countdown=0;
     weatherClock=totalLaps*Math.max(35,TRACK_LEN/50)*.5;update(0);applyWeatherVisuals();
     const p=trackCurve.getPointAt(.1),d=trackCurve.getTangentAt(.1);
     car.pos.set(p.x,0,p.z);car.angle=Math.atan2(d.x,d.z);car.speed=50;
     tyre='S';update(0);const slick=gripFactor,risk=aquaRisk,warn=hudGrip.textContent;
     tyre='W';update(0);const wets=gripFactor;
     return {wet:weather,phase:weatherState.phase,rain:rain.visible,opacity:rain.material.opacity,
       hud:hudWeather.textContent,tyreHud:hudTyre.textContent,slick,wets,risk,warn,
       road:roadMat.color.getHex(),sun:sun.intensity,line:dryLineMat.opacity};
   })()`);
   check('M6 weather HUD, rain and wet-weather visuals',m6.wet>.7&&m6.phase==='wet'&&m6.rain&&m6.opacity>0&&m6.hud.includes('WET')&&m6.tyreHud.includes('°C')&&m6.sun<2&&m6.line>0.05,m6);
   check('M6 wet tyres grip and aquaplaning warning',m6.wets>m6.slick+.2&&m6.risk>.25&&m6.warn.includes('AQUA'),m6);
   await send('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage disabled for regression');}});`});
  await navigate(base+'/car.html');await wait('!!document.querySelector("canvas")');
  check('storage denied still boots',await evaluate('racePhase==="grid" && !Number.isFinite(bestLap) && document.getElementById("startupWarning").hidden'),[...errors]);
 }finally{
  const report={browser:(await (await fetch('http://127.0.0.1:9231/json/version')).json()).Browser,results,passed:results.filter(r=>r.pass).length,total:results.length};
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});fs.writeFileSync(path.join(root,'test-results/browser.json'),JSON.stringify(report,null,2));
  await send('Page.close').catch(()=>{});ws.close();await new Promise(r=>server.close(r));
 }
 if(results.some(r=>!r.pass))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1});
