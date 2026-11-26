/* Classic dependency-free race core. Call advance only while racing.
 * progress tracks signed physical position even when a lap is invalid, so
 * recovery stays aligned to actual start-line crossings. Valid laps require
 * quarter gates; off-road/jumps invalidate until the next forward start.
 * raceProgress uses the last validated/start epoch, not modulo alone: reversing
 * over the start after a completed lap must decrease rank, never add a lap.
 */
(function(root){
  'use strict';
  function mod(v){return ((v%1)+1)%1;}
  function raceLaps(track,length){
    if(length==='5'||length===5||length==null)return 5;
    var f={quarter:.25,half:.5,threequarter:.75,full:1}[length]||1;
    var km=Number(track&&track.lengthKm);
    if(!(km>0))throw new RangeError('track.lengthKm must be positive');
    return Math.ceil((track.id==='monaco'?260:305)/km*f);
  }
  function createRacer(id,name,gridIndex,initialProgress){
    var p=Number.isFinite(initialProgress)?initialProgress:0;
    return {id:id,name:name,gridIndex:gridIndex||0,progress:p,lastT:mod(p),
      completedLaps:0,lapTimes:[],elapsed:0,lapElapsed:0,finishTime:null,
      finished:false,invalidLaps:0,lapArmed:p<=0,
      lapStartProgress:0,nextGate:p<=0?.25:Math.floor(p)+1};
  }
  function raceProgress(r){
    if(!r.lapArmed && r.invalidRank!=null)return r.invalidRank;
    return r.completedLaps+r.progress-r.lapStartProgress;
  }
  function advance(r,t,onRoad,dt,maxStep,targetLaps){
    var e={accepted:false,delta:0,lapCompleted:false,finished:false,reason:null};
    if(r.finished){e.reason='finished';return e;}
    if(!Number.isFinite(t)||!Number.isFinite(dt)||dt<0){e.reason='invalid-input';return e;}
    t=mod(t);var d=t-r.lastT;
    if(d>.5)d-=1;if(d<-.5)d+=1;
    e.delta=d;var before=r.elapsed;r.elapsed+=dt;r.lapElapsed+=dt;
    var old=r.progress;r.progress+=d;r.lastT=t;
    var limit=Number.isFinite(maxStep)?Math.max(0,maxStep):.08;
    if(!onRoad||Math.abs(d)>limit+1e-9){
      if(r.lapArmed){r.invalidLaps++;r.invalidRank=raceProgress(r)-d;}
      r.lapArmed=false;r.nextGate=Math.floor(r.progress+1e-9)+1;
      e.reason=!onRoad?'off-road':'jump-rejected';return e;
    }
    e.accepted=true;
    if(d<=0){e.reason=d<0?'reverse':'stationary';return e;}
    while(old<r.nextGate-1e-9&&r.progress>=r.nextGate-1e-9){
      var gate=r.nextGate;
      if(Math.abs(gate-Math.round(gate))<1e-9){
        var fraction=Math.max(0,Math.min(1,(gate-old)/d));
        var remainder=dt*(1-fraction);
        if(r.lapArmed){
          r.completedLaps++;r.lapTimes.push(r.lapElapsed-remainder);e.lapCompleted=true;
          if(r.completedLaps>=(targetLaps==null?Infinity:targetLaps)){
            r.finished=true;r.finishTime=before+dt*fraction;r.elapsed=r.finishTime;
            r.progress=gate;e.finished=true;e.finishTime=r.finishTime;
          }
        }else{r.lapArmed=true;e.reason='rearmed';}
        r.lapStartProgress=gate;r.lapElapsed=remainder;
      }
      r.nextGate+=.25;if(r.finished)break;
    }
    e.reason=e.finished?'finish':e.lapCompleted?'lap':e.reason||'forward';return e;
  }
  function rankRacers(rows){return rows.slice().sort(function(a,b){
    if(a.finished!==b.finished)return a.finished?-1:1;
    if(a.finished&&a.finishTime!==b.finishTime)return a.finishTime-b.finishTime;
    var pa=raceProgress(a),pb=raceProgress(b);
    if(pa!==pb)return pb-pa;return a.gridIndex-b.gridIndex;
  });}
  root.APEX_RACE={raceLaps:raceLaps,createRacer:createRacer,advance:advance,
    raceProgress:raceProgress,rankRacers:rankRacers};
})(window);
