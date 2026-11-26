/* Pure pit-lane rules. Classic script: window.APEX_PIT; no DOM/Three.js.
 * All positions are supplied by the page: t in [0,1), signed lateral offset
 * (positive = left of travel), and a boxDistance in metres.
 * A speeding violation costs the configured penalty once per lane visit.
 */
(function(root){
  'use strict';
  function createState(){
    return {inLane:false,speeding:false,penalty:0,servicing:false,serviceProgress:0,
      completed:0,cancelled:0,visits:0};
  }
  function inLane(t,offset,b){
    if(!Number.isFinite(t)||!Number.isFinite(offset))return false;
    return t>=b.start&&t<=b.end&&offset>=b.inner&&offset<=b.outer;
  }
  function nearBox(t,offset,b){
    if(!b.boxHalfT||!b.boxHalfOffset)return false;
    var dt=Math.abs(t-b.boxT);if(dt>.5)dt=1-dt;
    return dt<=b.boxHalfT&&Math.abs(offset-b.boxOffset)<=b.boxHalfOffset;
  }
  function update(state,sample,dt,b){
    var e={enter:false,leave:false,penaltyAdded:false,serviceStarted:false,
      serviceCancelled:false,tyreChanged:false,progress:0};
    if(!Number.isFinite(dt)||dt<0)throw new RangeError('dt must be nonnegative');
    if(sample.inLane&&!state.inLane){
      state.inLane=true;state.speeding=false;state.visits++;e.enter=true;
    }else if(!sample.inLane&&state.inLane){
      state.inLane=false;state.speeding=false;e.leave=true;
      if(state.servicing){state.servicing=false;state.serviceProgress=0;state.cancelled++;e.serviceCancelled=true;}
      return e;
    }
    if(!sample.inLane)return e;
    if(sample.speed>b.limit+.5&&!state.speeding){
      state.speeding=true;state.penalty+=b.penalty;e.penaltyAdded=true;
    }
    var atBox=!sample.boxDistance||sample.boxDistance<=b.boxRadius;
    var stationary=sample.speed<=.6;
    var canService=!!sample.requested&&!!sample.hasTyreChoice&&atBox&&stationary;
    if(!state.servicing&&canService){
      state.servicing=true;state.serviceProgress=0;e.serviceStarted=true;
    }
    if(state.servicing){
      if(!canService){
        state.servicing=false;state.serviceProgress=0;state.cancelled++;e.serviceCancelled=true;
      }else{
        state.serviceProgress+=dt;
        if(state.serviceProgress>=b.service){
          state.serviceProgress=0;state.servicing=false;state.completed++;
          e.tyreChanged=true;
        }
      }
    }
    e.progress=state.serviceProgress;
    return e;
  }
  function aiShouldPit(completedLaps,totalLaps,pitted){
    return !pitted&&totalLaps>=2&&completedLaps>=Math.ceil(totalLaps/2);
  }
  root.APEX_PIT={createState,inLane,nearBox,update,aiShouldPit};
})(typeof window!=='undefined'?window:globalThis);
