/* M3 deterministic AI helpers, classic script for offline launches. */
(function(root){
  'use strict';
  const profiles={easy:{max:53,lateral:12,accel:12,brake:26},medium:{max:63,lateral:17,accel:16,brake:32},hard:{max:73,lateral:23,accel:20,brake:38}};
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  function profile(name){return profiles[name]||profiles.medium;}
  function curvature(a,b,c){
    const ab=Math.hypot(b.x-a.x,b.z-a.z),bc=Math.hypot(c.x-b.x,c.z-b.z),ca=Math.hypot(a.x-c.x,a.z-c.z);
    return 2*Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))/Math.max(1e-9,ab*bc*ca);
  }
  function speedLimit(k,p){return Math.min(p.max,Math.sqrt(p.lateral/Math.max(k,.00001)));}
  function approach(speed,target,dt,p){return Math.max(0,speed+clamp(target-speed,-p.brake*dt,p.accel*dt));}
  function targetSpeed(samples,index,spacing,speed,p){
    let target=p.max;
    // Brake-envelope lookahead: a future corner constrains today's speed.
    const count=Math.min(samples.length,Math.ceil((speed*speed/(2*p.brake)+25)/spacing));
    for(let i=0;i<=count;i++){
      const corner=speedLimit(samples[(index+i)%samples.length],p);
      target=Math.min(target,Math.sqrt(corner*corner+2*p.brake*i*spacing));
    }
    return target;
  }
  function traffic(speed,target,gap,leadSpeed,dt,p){
    const desired=5+speed*.45;
    if(gap>0&&gap<desired)target=Math.min(target,Math.max(0,leadSpeed+(gap-desired)*1.8));
    return approach(speed,target,dt,p);
  }
  root.APEX_AI={profile,curvature,speedLimit,approach,targetSpeed,traffic};
})(window);
