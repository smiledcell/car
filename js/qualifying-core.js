/* Pure Q1/Q2/Q3 core. Classic script: window.APEX_QUAL; no DOM/Three.js.
 * 22 entries -> Q1 top16 -> Q2 top10 -> Q3. Lower seed wins an initial
 * tie; subsequent ties/no-times retain the previous stage classification.
 * tick closes the clock, but finishStage explicitly locks classification.
 */
(function(root){
  'use strict';
  const DEFAULT_DURATIONS=[480,360,300];
  const clone=value=>JSON.parse(JSON.stringify(value));
  function createSession(entries,durations=DEFAULT_DURATIONS,options={}){
    if(!Array.isArray(entries)||entries.length!==22)throw new RangeError('Qualifying requires exactly 22 entries');
    if(!Array.isArray(durations)||durations.length!==3||durations.some(t=>!Number.isFinite(t)||t<=0))throw new RangeError('Three positive stage durations required');
    const graceSeconds=options.graceSeconds==null?120:options.graceSeconds;
    if(!Number.isFinite(graceSeconds)||graceSeconds<0)throw new RangeError('graceSeconds must be nonnegative');
    const ids=new Set(),drivers=Object.create(null);
    const ordered=entries.map((entry,index)=>{
      if(!entry||entry.id==null)throw new TypeError('Each entry needs an id');
      const id=String(entry.id);
      if(ids.has(id))throw new Error('Duplicate qualifying entry: '+id);
      ids.add(id);
      const driver={id,name:entry.name==null?id:String(entry.name),seed:Number.isFinite(entry.seed)?entry.seed:index,
        initialIndex:index,best:null,activeLap:null,history:[],eliminatedStage:null};
      drivers[id]=driver;return driver;
    }).sort((a,b)=>a.seed-b.seed||a.initialIndex-b.initialIndex);
    return {stage:1,phase:'running',remaining:durations[0],closingElapsed:0,
      durations:durations.slice(),graceSeconds,activeIds:ordered.map(d=>d.id),drivers,
      stageResults:{},lapSerial:0};
  }
  function startLap(session,id){
    const d=session.drivers[String(id)];
    if(session.phase!=='running'||session.remaining<=0||!session.activeIds.includes(String(id))||!d||d.activeLap)return false;
    d.activeLap={stage:session.stage,serial:++session.lapSerial};return true;
  }
  function completeLap(session,id,time,valid=true){
    const d=session.drivers[String(id)];
    if(!d||!d.activeLap||d.activeLap.stage!==session.stage||!['running','closing'].includes(session.phase))return false;
    const numeric=Number.isFinite(time)&&time>0;
    const accepted=!!valid&&numeric;
    d.history.push({stage:session.stage,serial:d.activeLap.serial,time:numeric?time:null,valid:accepted,
      reason:accepted?'valid':numeric?'invalid-lap':'invalid-time'});
    d.activeLap=null;
    if(accepted&&(d.best==null||time<d.best))d.best=time;
    return true;
  }
  function expirePending(session){
    for(const id of session.activeIds){
      const d=session.drivers[id];
      if(d.activeLap){d.history.push({stage:session.stage,serial:d.activeLap.serial,time:null,valid:false,reason:'grace-timeout'});d.activeLap=null;}
    }
  }
  function tick(session,dt){
    if(!Number.isFinite(dt)||dt<0)throw new RangeError('dt must be nonnegative');
    if(session.phase==='finished')return session.phase;
    let extra=dt;
    if(session.phase==='running'){
      const used=Math.min(dt,session.remaining);
      session.remaining=Math.max(0,session.remaining-used);extra=dt-used;
      if(session.remaining===0)session.phase='closing';
    }
    if(session.phase==='closing'){
      session.closingElapsed=Math.min(session.graceSeconds,session.closingElapsed+extra);
      if(session.closingElapsed>=session.graceSeconds)expirePending(session);
    }
    return session.phase;
  }
  function standings(session){
    if(session.phase==='finished')return clone(session.stageResults[session.stage]);
    const prior=new Map(session.activeIds.map((id,i)=>[id,i]));
    return session.activeIds.map(id=>session.drivers[id]).sort((a,b)=>{
      if(a.best==null&&b.best!=null)return 1;
      if(a.best!=null&&b.best==null)return -1;
      return (a.best==null?0:a.best-b.best)||prior.get(a.id)-prior.get(b.id);
    }).map((d,index)=>({id:d.id,name:d.name,seed:d.seed,rank:index+1,stage:session.stage,
      time:d.best,best:d.best,activeLap:!!d.activeLap,history:clone(d.history)}));
  }
  function finishStage(session){
    if(session.phase==='finished')return false;
    if(session.phase!=='closing')return false;
    const pending=session.activeIds.some(id=>session.drivers[id].activeLap);
    if(pending&&session.closingElapsed<session.graceSeconds)return false;
    if(pending)expirePending(session);
    const rows=standings(session);
    session.stageResults[session.stage]=clone(rows);
    const cutoff=session.stage===1?16:session.stage===2?10:10;
    if(session.stage<3)rows.slice(cutoff).forEach(row=>{session.drivers[row.id].eliminatedStage=session.stage;});
    session.phase='finished';return true;
  }
  function nextStage(session){
    if(session.phase!=='finished'||session.stage>=3)return false;
    const cutoff=session.stage===1?16:10;
    session.activeIds=session.stageResults[session.stage].slice(0,cutoff).map(row=>row.id);
    session.stage++;session.phase='running';session.remaining=session.durations[session.stage-1];session.closingElapsed=0;
    for(const id of session.activeIds){session.drivers[id].best=null;session.drivers[id].activeLap=null;}
    return true;
  }
  function grid(session){
    if(session.stage!==3||session.phase!=='finished')return [];
    return clone(session.stageResults[3].concat(session.stageResults[2].slice(10),session.stageResults[1].slice(16)))
      .map((row,index)=>Object.assign(row,{position:index+1,qualifiedStage:row.stage}));
  }
  root.APEX_QUAL={createSession,startLap,completeLap,tick,finishStage,nextStage,standings,grid};
})(typeof window!=='undefined'?window:globalThis);
