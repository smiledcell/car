/* Pure deterministic weather and tyre model. Classic script: window.APEX_WEATHER.
 * Weather is a function of race fraction, so the same race distance always
 * produces the same dry -> damp -> wet -> drying sequence. No randomness.
 */
(function(root){
  'use strict';
  var COMPOUNDS={
    S:{dryGrip:1.07,wetGrip:.50,wearRate:1.55,optTemp:95},
    M:{dryGrip:1.00,wetGrip:.62,wearRate:1.00,optTemp:90},
    H:{dryGrip:.95,wetGrip:.70,wearRate:.64,optTemp:82},
    I:{dryGrip:.78,wetGrip:.95,wearRate:1.12,optTemp:70},
    W:{dryGrip:.68,wetGrip:1.05,wearRate:1.25,optTemp:62}
  };
  function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}
  function smooth(a,b,x){
    var t=clamp((x-a)/(b-a),0,1);
    return t*t*(3-2*t);
  }
  function wetnessAt(fraction){
    var f=clamp(Number.isFinite(fraction)?fraction:0,0,1);
    if(f<=.12)return 0;
    if(f<=.24)return smooth(.12,.24,f)*.50;
    if(f<=.58)return .50+smooth(.24,.58,f)*.45;
    if(f<=.74)return .95-smooth(.58,.74,f)*.55;
    if(f<=.90)return .40-smooth(.74,.90,f)*.40;
    return 0;
  }
  function phaseAt(wetness){
    if(wetness>=.70)return 'wet';
    if(wetness>=.25)return 'damp';
    return 'dry';
  }
  function createState(){
    return {fraction:0,wetness:wetnessAt(0),phase:'dry',rain:0,tyreTemp:70,wear:0,
      racingLine:'dry',aquaplaning:0};
  }
  function update(state,fraction){
    state.fraction=clamp(Number.isFinite(fraction)?fraction:0,0,1);
    state.wetness=wetnessAt(state.fraction);
    state.phase=phaseAt(state.wetness);
    state.rain=clamp((state.wetness-.22)/.62,0,1);
    state.racingLine=state.wetness>.35?'drying':'dry';
    return state;
  }
  function lineWetness(wetness,onLine){
    var w=clamp(wetness,0,1);
    if(!onLine)return clamp(w+.03*(1-w),0,1);
    if(w<=.18)return w;
    var dry=Math.min(.12,w*.16);
    return clamp(w-dry,0,1);
  }
  function grip(compound,wetness,temp,wear){
    var c=COMPOUNDS[compound]||COMPOUNDS.M;
    var w=clamp(wetness,0,1);
    var base=c.dryGrip*(1-w)+c.wetGrip*w;
    var t=Number.isFinite(temp)?temp:c.optTemp;
    var tempFactor=1;
    if(t>c.optTemp+12)tempFactor=Math.max(.62,1-(t-(c.optTemp+12))*.014);
    if(t<c.optTemp-15)tempFactor=Math.max(.74,1-((c.optTemp-15)-t)*.006);
    var wearFactor=1-clamp(wear,0,1)*.2;
    return Math.max(.45,base*tempFactor*wearFactor);
  }
  function tempStep(temp,speed,wetness,compound,dt,braking){
    if(!Number.isFinite(dt)||dt<0)throw new RangeError('dt must be nonnegative');
    var c=COMPOUNDS[compound]||COMPOUNDS.M;
    var target=48+clamp(speed,0,120)*.60-clamp(wetness,0,1)*6+(braking?12:0);
    if(compound==='W')target-=5;else if(compound==='I')target-=2;else if(compound==='H')target-=4;
    var rate=temp>target?.06:.11;
    return temp+(target-temp)*rate*dt;
  }
  function wearStep(wear,speed,wetness,compound,temp,dt){
    if(!Number.isFinite(dt)||dt<0)throw new RangeError('dt must be nonnegative');
    var c=COMPOUNDS[compound]||COMPOUNDS.M;
    var w=clamp(wetness,0,1),t=Number.isFinite(temp)?temp:c.optTemp;
    var thermal=1+Math.max(0,t-c.optTemp)*.018;
    var wetFactor=(compound==='I'||compound==='W')?(1-w*.35):(1-w*.25);
    var next=wear+clamp(speed,0,120)*.00003*c.wearRate*thermal*wetFactor*dt;
    return clamp(next,0,1);
  }
  function aquaplaning(wetness,compound,speed,wear){
    var w=clamp(wetness,0,1);
    if(w<.65)return 0;
    var dryType=compound==='S'||compound==='M'||compound==='H';
    var factor=dryType?1.4:compound==='I'?.55:.26;
    var risk=((w-.65)/.35)*(clamp(speed,0,120)/90)*factor*(1+clamp(wear,0,1)*.6);
    return clamp(risk,0,1);
  }
  function pace(wetness){return 1-clamp(wetness,0,1)*.22;}
  function recommended(wetness){
    var w=clamp(wetness,0,1);
    if(w>=.82)return 'W';
    if(w>=.40)return 'I';
    return 'M';
  }
  root.APEX_WEATHER={COMPOUNDS:COMPOUNDS,wetnessAt,phaseAt,createState,update,
    lineWetness,grip,tempStep,wearStep,aquaplaning,pace,recommended};
})(typeof window!=='undefined'?window:globalThis);
