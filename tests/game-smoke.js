/* Opt-in full page smoke tests: car.html?selftest=1. Synchronous and destructive:
 * tests restore a clean menu, do not write best-lap records or simulate inputs.
 * This checks integration, not GPU appearance or real browser key events.
 */
(() => {
  if (new URLSearchParams(location.search).get('selftest') !== '1') return;
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const test = (name, fn) => {
    try { fn(); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: error.message }); }
  };
  const originalMode = modeSelect.value;
  const originalLength = lengthSelect.value;
  const core = window.APEX_RACE;
  test('24 track definitions and THREE/canvas boot', () => {
    assert(TRACKS.length === 24, 'Expected 24 tracks');
    assert(window.THREE && renderer.domElement.parentElement, 'Renderer missing');
    TRACKS.forEach(track => {
      assert(controlPoints(track).length >= 6, track.id + ' points');
      assert(core.raceLaps(track, 'full') > 5, track.id + ' full distance');
    });
    assert(trackById('spa').id === 'belgium', 'Spa alias');
  });
  test('countdown freezes physics, AI, clocks and energy', () => {
    modeSelect.value = 'race'; lengthSelect.value = '5'; beginSession();
    keys.up = keys.boost = true;
    const before = JSON.stringify({ x: car.pos.x, z: car.pos.z, speed: car.speed, ers,
      racers: allRacers(), t: aiList.map(ai => ai.t) });
    for (let i = 0; i < 60; i++) update(.05);
    const after = JSON.stringify({ x: car.pos.x, z: car.pos.z, speed: car.speed, ers,
      racers: allRacers(), t: aiList.map(ai => ai.t) });
    assert(before === after, 'Race state advanced before GO');
    assert(racePhase === 'countdown', 'Countdown exited too soon');
  });
  test('reset clears strategy, keys, all racers and UI', () => {
    tyre='S'; tyreWear=.8; ers=.2; weather=.8; pitRequested=pitLimiter=true;
    pitModal.hidden=false; keys.up=true; aiList[0].racer.completedLaps=3;
    resetCar();
    assert(tyre==='M' && tyreWear===0 && ers===1 && weather===0, 'Strategy not reset');
    assert(!pitRequested && !pitLimiter && pitModal.hidden, 'Pit not reset');
    assert(!Object.values(keys).some(Boolean), 'Keys not reset');
    assert(allRacers().every(r => r.completedLaps===0 && !r.finished && r.elapsed===0), 'Racers not reset');
    assert(car.speed===0 && lapTime===0 && lapCount===1 && resultModal.hidden, 'Player/UI not reset');
    assert(aiList.every(ai => ai.racer.progress<0), 'AI received positive head start');
  });
  test('AI completes a genuine lap and stops; ranking is not fixed', () => {
    resetCar(); totalLaps=1; racePhase='race'; started=true;
    for(let i=0; i<3000 && !aiList.every(ai=>ai.racer.finished); i++) updateAI(.05,false);
    assert(aiList.every(ai=>ai.racer.finished && ai.racer.completedLaps===1), 'AI did not finish');
    assert(aiList.every(ai=>ai.racer.finishTime>0 && ai.racer.completedLaps===1), 'AI finished too early or without a lap');
    const medium=window.APEX_AI.profile('medium');
    assert(window.APEX_AI.speedLimit(0.08,medium)<window.APEX_AI.speedLimit(0.001,medium), 'Curvature does not reduce speed');
    assert(window.APEX_AI.profile('hard').max>window.APEX_AI.profile('easy').max, 'Difficulty profiles not ordered');
    renderHUD(); assert(hudPosition.textContent==='4/4','Stationary player should be fourth');
    const frozen=JSON.stringify(aiList.map(ai=>ai.racer)); updateAI(.05,false);
    assert(frozen===JSON.stringify(aiList.map(ai=>ai.racer)), 'Finished AI changed');
  });
  test('player result uses real rank/time and remaining AI continue', () => {
    resetCar(); totalLaps=1; racePhase='race'; started=true;
    const first=aiList[0].racer; first.finished=true;first.finishTime=1;first.completedLaps=1;
    for(let i=1;i<=51;i++) core.advance(playerRacer,(i*.02)%1,true,.1,.08,1);
    assert(playerRacer.finished && playerRacer.finishTime>0,'Player did not finish');
    raceFinished=true;racePhase='finish';started=false;resultModal.hidden=false;
    renderHUD(); assert(resultText.textContent.startsWith('P2'),'Expected second place');
    const playerFrozen=JSON.stringify(playerRacer), before=aiList[1].racer.progress;
    update(.05); assert(aiList[1].racer.progress>before,'Remaining AI stopped');
    assert(playerFrozen===JSON.stringify(playerRacer),'Finished player changed');
    assert(document.getElementById('classification').children.length===4,'Classification incomplete');
  });
  test('M3 difficulty lap times and three-lap stability', () => {
    const previous=difficultySelect.value, times=[];
    for(const difficulty of ['easy','medium','hard']){
      difficultySelect.value=difficulty;resetCar();totalLaps=3;racePhase='race';started=true;
      let minSpeed=Infinity,maxSpeed=0;
      for(let i=0;i<12000&&!aiList.every(a=>a.racer.finished);i++){
        updateAI(.05,false);
        const a=aiList[0]; if(a.racer.elapsed>5&&!a.racer.finished){minSpeed=Math.min(minSpeed,a.speed);maxSpeed=Math.max(maxSpeed,a.speed);}
        assert(aiList.every(a=>Number.isFinite(a.speed)&&a.speed>=0&&(a.pitActive?Math.abs(a.lane)<PIT_BOUNDS.outer:Math.abs(a.lane)<TRACK_HALF-1)), 'AI offroad/invalid');
      }
      assert(aiList.every(a=>a.racer.finished&&a.racer.completedLaps===3),'AI stuck or did not complete three laps');
      assert(maxSpeed-minSpeed>2,'AI did not adapt speed');
      times.push(aiList[0].racer.finishTime);
    }
    difficultySelect.value=previous;
    assert(times[0]>times[1]&&times[1]>times[2], 'Difficulty does not change race time: '+times.join(','));
    window.APEX_M3_TIMES=times;
  });
  test('M3 30/60/120 FPS consistency', () => {
    const snapshots=[];
    for(const fps of [30,60,120]){
      resetCar();totalLaps=10;racePhase='race';started=true;
      for(let i=0;i<fps*20;i++)updateAI(1/fps,false);
      snapshots.push(aiList.map(a=>({p:a.racer.progress,s:a.speed})));
    }
    for(let n=1;n<snapshots.length;n++)snapshots[0].forEach((a,i)=>{
      assert(Math.abs(a.p-snapshots[n][i].p)<.003,'Frame rate progress drift');
      assert(Math.abs(a.s-snapshots[n][i].s)<.2,'Frame rate speed drift');
    });
  });
  test('M3 exact overlap has bounded response without energy gain', () => {
    resetCar();totalLaps=3;racePhase='race';started=true;
    const a=aiList[0];car.pos.copy(a.mesh.position);car.speed=30;a.speed=10;
    const before=car.pos.clone();updateAI(1/120,true);
    assert(Number.isFinite(car.pos.x)&&Number.isFinite(car.pos.z),'Invalid collision');
    assert(car.pos.distanceTo(before)<=.36,'Collision teleported player');
    assert(car.speed<=30 && a.speed<=11,'Collision added energy');
  });
  test('M4 Q1/Q2/Q3 elimination, valid laps and 22-car grid', () => {
    beginQualifying([2,2,2]);
    assert(qualifying.activeIds.length===22&&aiList.length===21,'Expected 22 entries');
    // Invalid lap must not seed a time; a subsequent valid lap can.
    qualClock=1;handleQualifyingLap({accepted:true,delta:.03,lapCompleted:false},.99,.02);
    assert(qualifying.drivers.player.best===null,'Shortcut produced qualifying time');
    qualClock=1.5;handleQualifyingLap({accepted:true,delta:.03,lapCompleted:true},.99,.02);
    assert(qualifying.drivers.player.best>0,'Valid lap not accepted');
    for(let stage=1;stage<=3;stage++){
      if(stage>1){qualClock=1;handleQualifyingLap({accepted:true,delta:.03,lapCompleted:true},.99,.02);}
      // Let every simulated AI complete an eligible attempt and clock/grace expire.
      for(let n=0;n<2500&&racePhase!=='qualResults';n++)tickQualifying(.1);
      assert(qualifying.phase==='finished','Stage failed to finish');
      assert(window.APEX_QUAL.standings(qualifying).length===[22,16,10][stage-1],'Incorrect elimination count');
      assert(!document.getElementById('qualContinue').hidden,'Missing continue button');
      continueQualifying();
    }
    assert(mode==='race'&&racePhase==='countdown'&&gridOrder.length===22,'No race transition');
    assert(allRacers().length===22&&new Set(gridOrder).size===22,'Missing/duplicate entrants');
    assert(allRacers().every(r=>r.gridIndex===gridOrder.indexOf(r.id)),'Grid positions not applied');
    assert(totalLaps===window.APEX_RACE.raceLaps(selectedTrack,lengthSelect.value),'Selected race distance lost');
    gridOrder=null;qualifying=null;mode='race';document.getElementById('qualPanel').hidden=true;
  });
  test('M4 late flying lap accepted, no new lap after clock zero', () => {
    beginQualifying([1,1,1]);tickQualifying(1);
    assert(qualifying.phase==='closing','No chequered flag');
    assert(!window.APEX_QUAL.startLap(qualifying,'player'),'New lap started after zero');
    qualClock=2;handleQualifyingLap({accepted:true,delta:.03,lapCompleted:true},.99,.02);
    assert(qualifying.drivers.player.best===2&&qualPlayerDone,'Late lap rejected');
    gridOrder=null;qualifying=null;mode='race';document.getElementById('qualPanel').hidden=true;
  });
  test('M4 actual physics valid lap and invalid-lap recovery', () => {
    beginQualifying([480,360,300]);
    const driveTo=t=>{const p=trackCurve.getPointAt(t);car.pos.set(p.x,0,p.z);car.speed=0;update(.01);};
    for(let i=1;i<=500;i++)driveTo((i/500)%1);
    assert(qualifying.drivers.player.best>0,'Actual ordered lap not recorded');
    const best=qualifying.drivers.player.best;
    const p=trackCurve.getPointAt(.02);car.pos.set(p.x+TRACK_HALF*5,0,p.z);update(.01);
    for(let i=1;i<=500;i++)driveTo((i/500)%1);
    assert(qualifying.drivers.player.best===best,'Invalid lap overwrote result');
    assert(qualifying.drivers.player.history.some(l=>!l.valid),'Invalid lap not recorded');
    gridOrder=null;qualifying=null;mode='race';document.getElementById('qualPanel').hidden=true;
  });
  test('M4 physical crossing before timer/grace boundary is retained', () => {
    const nearLine=()=>{
      playerRacer=core.createRacer('player','You',0);
      for(let i=1;i<=499;i++)core.advance(playerRacer,i/500,true,.01,.006);
      core.advance(playerRacer,.9999,true,.01,.006);
      const p=trackCurve.getPointAt(.9999),tan=trackCurve.getTangentAt(.9999);
      car.pos.set(p.x,0,p.z);car.angle=Math.atan2(tan.x,tan.z);car.speed=74;keys.up=true;
    };
    beginQualifying([1,1,1]);qualifying.remaining=.01;nearLine();update(.05);
    assert(qualifying.drivers.player.best>0,'Pre-zero physical crossing lost');
    assert(qualifying.drivers.player.activeLap,'Pre-zero crossing did not start eligible final lap');
    beginQualifying([1,1,1]);tickQualifying(1);qualifying.closingElapsed=119.99;nearLine();update(.05);
    assert(qualifying.drivers.player.best>0,'Pre-grace physical crossing lost');
    gridOrder=null;qualifying=null;mode='race';document.getElementById('qualPanel').hidden=true;
  });
  test('M5 player pit lane: limit, box service and tyre change', () => {
    mode='race';totalLaps=3;resetCar();racePhase='race';started=true;countdown=0;
    const place=(t,offset,speed)=>{const p=trackCurve.getPointAt(t),d=trackCurve.getTangentAt(t);
      car.pos.set(p.x-d.z*offset,0,p.z+d.x*offset);car.angle=Math.atan2(d.x,d.z);car.speed=speed;};
    pitRequested=true;pitChoice='S';pitModal.hidden=true;
    place(PIT_BOUNDS.boxT,PIT_BOUNDS.boxOffset,0);
    for(let i=0;i<40;i++)update(.1);
    assert(tyre==='S','Selected tyre was not fitted at the box');
    assert(tyreWear===0,'Tyre wear not reset by pit stop');
    assert(pitState.completed===1&&!pitRequested&&pitChoice===null,'Pit stop state not cleared');
    assert(penaltyTime===0,'Clean pit stop incurred a penalty');
    // Stationary outside the box must not fit tyres.
    resetCar();racePhase='race';started=true;pitRequested=true;pitChoice='H';pitModal.hidden=true;
    place(PIT_BOUNDS.start+.01,PIT_BOUNDS.inner+2,0);
    for(let i=0;i<40;i++)update(.1);
    assert(pitState.completed===0&&tyre==='M','Service worked outside the pit box');
    // Leaving the box while servicing cancels without a free tyre.
    place(PIT_BOUNDS.boxT,PIT_BOUNDS.boxOffset,0);update(.1);update(.1);
    car.speed=2;update(.1);
    assert(pitState.completed===0&&pitState.cancelled>0,'Moving car did not cancel service');
    resetCar();
  });
  test('M5 pit wall blocks a cut, entry gap allows the lane', () => {
    mode='race';totalLaps=3;resetCar();racePhase='race';started=true;countdown=0;
    const place=(t,offset,angleSpeed)=>{const p=trackCurve.getPointAt(t),d=trackCurve.getTangentAt(t);
      car.pos.set(p.x-d.z*offset,0,p.z+d.x*offset);car.angle=angleSpeed;car.speed=30;};
    // Heading outward across the wall at a mid-lane t must be pushed back.
    const midT=(PIT_BOUNDS.start+PIT_BOUNDS.end)/2;
    const md=trackCurve.getTangentAt(midT);
    place(midT,PIT_BOUNDS.inner-1,Math.atan2(-md.z,md.x));
    update(.3);
    const info=closestTrack(car.pos.x,car.pos.z,playerRacer.lastT);
    assert(info.t>PIT_BOUNDS.start&&info.t<PIT_BOUNDS.end,'Wall test left the pit zone');
    assert(info.offset<=PIT_BOUNDS.inner-.45,'Car cut through the pit wall');
    // Before the wall opening the car can merge into the lane normally.
    const entryT=PIT_BOUNDS.start+.003,ed=trackCurve.getTangentAt(entryT);
    place(entryT,PIT_BOUNDS.inner-1,Math.atan2(-ed.z,ed.x));
    update(.2);
    const merged=closestTrack(car.pos.x,car.pos.z,playerRacer.lastT);
    assert(merged.offset>PIT_BOUNDS.inner&&APEX_PIT.inLane(merged.t,merged.offset,PIT_BOUNDS),'Pit entry opening is blocked');
    resetCar();
  });
  test('M5 pit speed limit and one penalty per visit', () => {
    mode='race';totalLaps=3;resetCar();racePhase='race';started=true;countdown=0;
    const p=trackCurve.getPointAt(PIT_BOUNDS.start+.01),d=trackCurve.getTangentAt(PIT_BOUNDS.start+.01);
    car.pos.set(p.x-d.z*(PIT_BOUNDS.inner+2),0,p.z+d.x*(PIT_BOUNDS.inner+2));
    car.angle=Math.atan2(d.x,d.z);car.speed=74;
    update(.01);
    assert(penaltyTime===5&&pitState.speeding,'Pit entry speeding was not penalised');
    for(let i=0;i<20;i++){car.pos.set(p.x-d.z*(PIT_BOUNDS.inner+2),0,p.z+d.x*(PIT_BOUNDS.inner+2));car.speed=74;update(.05);}
    assert(penaltyTime===5,'Penalty stacked on every frame of one visit');
    assert(Math.abs(car.speed)<=PIT_BOUNDS.limit+.5,'Pit lane speed was not limited');
    // Clean re-entry after leaving adds a second penalty once.
    const out=trackCurve.getPointAt(PIT_BOUNDS.end-.02),od=trackCurve.getTangentAt(PIT_BOUNDS.end-.02);
    car.pos.set(out.x-od.z*(TRACK_HALF-3),0,out.z+od.x*(TRACK_HALF-3));update(.05);
    const back=trackCurve.getPointAt(PIT_BOUNDS.start+.01),bd=trackCurve.getTangentAt(PIT_BOUNDS.start+.01);
    car.pos.set(back.x-bd.z*(PIT_BOUNDS.inner+2),0,back.z+bd.x*(PIT_BOUNDS.inner+2));car.speed=74;
    update(.01);
    assert(penaltyTime===10,'A second lane visit was not penalised separately');
    resetCar();
  });
  test('M5 AI completes a real pit stop without stalling', () => {
    mode='race';totalLaps=3;resetCar();racePhase='race';started=true;countdown=0;
    for(let n=0;n<12000&&!aiList.every(a=>a.racer.finished);n++)updateAI(.05,false);
    assert(aiList.every(a=>a.racer.finished&&a.racer.completedLaps===3),'AI did not finish after pitting');
    assert(aiList.every(a=>a.pitted&&a.pitDone&&!a.pitActive),'AI did not complete its pit stop');
    assert(aiList.every(a=>Number.isFinite(a.speed)&&Number.isFinite(a.t)),'AI state invalid after pit');
    resetCar();
  });
  test('M5 penalty changes a real finishing time end to end', () => {
    const drive=(penalty)=>{
      mode='race';totalLaps=1;resetCar();racePhase='race';started=true;countdown=0;penaltyTime=penalty;
      for(let i=1;i<=520&&!playerRacer.finished;i++){
        const t=(i/500)%1,pos=trackCurve.getPointAt(t),tan=trackCurve.getTangentAt(t);
        car.pos.set(pos.x,0,pos.z);car.angle=Math.atan2(tan.x,tan.z);car.speed=74;
        update(.01);
      }
      return playerRacer.finished?playerRacer.finishTime:Infinity;
    };
    const clean=drive(0), penalised=drive(5);
    assert(Number.isFinite(clean)&&Number.isFinite(penalised),'Real lap did not finish');
    assert(Math.abs((penalised-clean)-5)<.001,'Penalty did not change the official finish time');
    assert(penaltyTime===0,'Penalty not consumed at the finish');
    resetCar();
  });
  test('M5 penalty is added to the frozen finish time', () => {
    const r=core.createRacer('penalty-probe','Penalty Probe',0);r.finished=true;r.finishTime=100;r.elapsed=100;
    assert(applyFinishPenalty(r,5)===0,'Penalty was not consumed');
    assert(r.finishTime===105&&r.elapsed===105,'Penalty not included in official race time');
    assert(applyFinishPenalty(r,0)===0&&r.finishTime===105,'Zero penalty mutated the time');
  });
  test('M6 deterministic wet weather, HUD and rain feedback', () => {
    mode='race';totalLaps=5;resetCar();racePhase='race';started=true;countdown=0;
    const duration=totalLaps*Math.max(35,TRACK_LEN/50);
    const at=f=>{weatherClock=duration*f;update(0);applyWeatherVisuals();};
    at(.05);
    assert(weather<.25&&window.APEX_WEATHER.phaseAt(weather)==='dry','Weather did not start dry');
    at(.5);
    assert(weather>.7&&weatherState.phase==='wet','Race did not reach wet weather');
    assert(rain.visible&&rain.material.opacity>0,'Rain is not visible in wet weather');
    assert(hudWeather.textContent.includes('WET')&&hudGrip.textContent.length>0,'Wet HUD missing');
    const wetA=weather;
    at(.5);
    assert(Math.abs(weather-wetA)<1e-9,'Same race fraction produced different weather');
    at(.95);
    assert(weather<.2&&!rain.visible,'Weather did not dry out after the shower');
    resetCar();
  });
  test('M6 wet grip, compounds and aquaplaning in real physics', () => {
    mode='race';totalLaps=5;resetCar();racePhase='race';started=true;countdown=0;
    const duration=totalLaps*Math.max(35,TRACK_LEN/50);
    weatherClock=duration*.5;update(0);
    const p=trackCurve.getPointAt(.1),d=trackCurve.getTangentAt(.1);
    car.pos.set(p.x,0,p.z);car.angle=Math.atan2(d.x,d.z);car.speed=50;
    tyre='S';update(0);const slickGrip=gripFactor,slickAqua=aquaRisk,slickWarn=hudGrip.textContent;
    tyre='W';update(0);const wetGrip=gripFactor,wetAqua=aquaRisk;
    assert(wetGrip>slickGrip+.2,'Wet tyres do not gain grip in rain');
    assert(slickAqua>.25&&wetAqua<slickAqua,'Aquaplaning is not compound-sensitive');
    assert(slickWarn.includes('AQUA'),'Aquaplaning warning missing');
    resetCar();
  });
  test('M6 tyre temperature heats and cools', () => {
    mode='race';totalLaps=5;resetCar();racePhase='race';started=true;countdown=0;
    tyre='M';tyreTemp=70;const p=trackCurve.getPointAt(.1),d=trackCurve.getTangentAt(.1);
    for(let i=0;i<300;i++){
      car.pos.set(p.x,0,p.z);car.angle=Math.atan2(d.x,d.z);car.speed=74;
      update(.05);
    }
    const hot=tyreTemp;
    assert(hot>80,'Tyre temperature did not heat up under load');
    car.speed=0;
    for(let i=0;i<400;i++)update(.05);
    assert(tyreTemp<hot,'Tyre temperature did not cool down at low speed');
    assert(tyreTemp>=20&&tyreTemp<=150,'Tyre temperature left its physical range');
    resetCar();
  });
  modeSelect.value=originalMode;lengthSelect.value=originalLength;mode='race';totalLaps=5;
  modeSelect.value=originalMode;lengthSelect.value=originalLength;mode='race';totalLaps=5;
  qStage=0;qTime=0;resetCar();racePhase='grid';started=false;menuEl.style.display='grid';
  centerEl.innerHTML='<b>🏁 3D 赛车</b>点击开始比赛 / Start Race';renderHUD();
  window.APEX_SMOKE_RESULTS={passed:results.filter(r=>r.pass).length,total:results.length,results};
  const output=document.createElement('pre');
  output.id='smokeResults';
  output.style.cssText='position:fixed;z-index:30;bottom:20px;right:20px;max-width:70vw;max-height:45vh;overflow:auto;background:#101820ee;color:#fff;padding:16px;white-space:pre-wrap;user-select:text';
  output.textContent=`M1–M2 integration: ${window.APEX_SMOKE_RESULTS.passed}/${results.length}\n`+
    results.map(r=>(r.pass?'PASS ':'FAIL ')+r.name+(r.error?' — '+r.error:'')).join('\n');
  document.body.appendChild(output);
  console.table(results);
})();
