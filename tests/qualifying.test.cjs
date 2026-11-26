/* Run: node tests/qualifying.test.cjs */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const context=vm.createContext({});context.window=context;
vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/qualifying-core.js'),'utf8'),context);
const Q=context.APEX_QUAL;
const entries=()=>Array.from({length:22},(_,i)=>({id:'d'+i,name:'Driver '+i,seed:i}));
const session=(options)=>Q.createSession(entries(),[10,10,10],options);
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function lap(s,id,time,valid=true){assert.equal(Q.startLap(s,id),true);assert.equal(Q.completeLap(s,id,time,valid),true);}
function finish(s){Q.tick(s,s.remaining);assert.equal(Q.finishStage(s),true);}
function ids(rows){return Array.from(rows,row=>row.id);}

test('valid fastest lap wins and slower lap cannot overwrite best',()=>{
 const s=session();lap(s,'d0',91);lap(s,'d0',93);lap(s,'d1',90);
 assert.equal(Q.standings(s)[0].id,'d1');assert.equal(s.drivers.d0.best,91);
 lap(s,'d0',89);assert.equal(Q.standings(s)[0].id,'d0');
});
test('invalid laps and invalid times are recorded but not classified',()=>{
 const s=session();lap(s,'d0',80,false);lap(s,'d1',NaN);lap(s,'d2',0);lap(s,'d3',-10);
 assert.equal(s.drivers.d0.best,null);assert.equal(s.drivers.d0.history[0].valid,false);
 assert.equal(s.drivers.d1.history[0].reason,'invalid-time');assert.equal(s.drivers.d2.best,null);
 assert.equal(Q.completeLap(s,'d4',88),false);assert.equal(Q.startLap(s,'unknown'),false);
});
test('ties and no-times use initial seed order, then previous classification',()=>{
 const s=session();lap(s,'d3',85);lap(s,'d2',85);lap(s,'d1',84);
 assert.deepEqual(ids(Q.standings(s)).slice(0,4),['d1','d2','d3','d0']);
 finish(s);assert.equal(Q.nextStage(s),true);assert.equal(s.activeIds.length,16);
 assert.deepEqual(ids(Q.standings(s)).slice(0,4),['d1','d2','d3','d0']);
 lap(s,'d3',90);lap(s,'d2',90);assert.deepEqual(ids(Q.standings(s)).slice(0,2),['d2','d3']);
 assert.equal(s.drivers.d1.best,null);assert.equal(s.drivers.d1.history.length,1);
});
test('late flying lap finishes during grace, no new laps after zero',()=>{
 const s=session();assert.equal(Q.startLap(s,'d0'),true);Q.tick(s,10);
 assert.equal(s.phase,'closing');assert.equal(Q.startLap(s,'d1'),false);
 assert.equal(Q.finishStage(s),false);Q.tick(s,119);
 assert.equal(Q.completeLap(s,'d0',89),true);assert.equal(Q.finishStage(s),true);
 assert.equal(Q.standings(s)[0].id,'d0');assert.equal(Q.completeLap(s,'d0',88),false);
});
test('grace timeout expires pending laps and cannot accept late result',()=>{
 const s=session({graceSeconds:2});Q.startLap(s,'d0');Q.tick(s,11);
 assert.equal(s.phase,'closing');assert.equal(s.closingElapsed,1);assert.equal(Q.finishStage(s),false);
 Q.tick(s,1);assert.equal(s.drivers.d0.activeLap,null);assert.equal(s.drivers.d0.history[0].reason,'grace-timeout');
 assert.equal(Q.completeLap(s,'d0',80),false);assert.equal(Q.finishStage(s),true);
});
test('stage transitions require finish and finished results/clocks are immutable snapshots',()=>{
 const s=session();assert.equal(Q.nextStage(s),false);assert.equal(Q.finishStage(s),false);
 lap(s,'d0',90);finish(s);const before=JSON.stringify(s);Q.tick(s,1000);assert.equal(JSON.stringify(s),before);
 const rows=Q.standings(s);rows[0].time=1;assert.equal(Q.standings(s)[0].time,90);
 assert.equal(Q.finishStage(s),false);assert.equal(Q.nextStage(s),true);
 assert.equal(s.stage,2);assert.equal(s.remaining,10);assert.equal(s.drivers.d0.best,null);
 assert.equal(s.drivers.d0.history[0].time,90);assert.equal(Q.startLap(s,'d21'),false);
});
test('22 -> 16 -> 10 and grid preserves eliminated tails with stage-specific times',()=>{
 const s=session();assert.deepEqual(ids(Q.grid(s)),[]);
 // Reverse Q1: d21..d0; eliminated d5..d0 become positions17..22.
 for(let i=0;i<22;i++)lap(s,'d'+i,100-i);
 finish(s);assert.equal(Q.nextStage(s),true);assert.equal(s.activeIds.length,16);
 // Q2 ascending numeric: d6..d21; eliminated d16..d21 positions11..16.
 for(const id of s.activeIds)lap(s,id,100+Number(id.slice(1)));
 finish(s);assert.equal(Q.nextStage(s),true);assert.equal(s.activeIds.length,10);
 // Q3 reverse numeric among d6..d15: d15..d6.
 for(const id of s.activeIds)lap(s,id,100-Number(id.slice(1)));
 finish(s);const grid=Q.grid(s);
 assert.equal(grid.length,22);assert.equal(new Set(ids(grid)).size,22);
 assert.deepEqual(ids(grid),[...Array.from({length:10},(_,i)=>'d'+(15-i)),...Array.from({length:6},(_,i)=>'d'+(16+i)),...Array.from({length:6},(_,i)=>'d'+(5-i))]);
 assert.equal(grid[0].position,1);assert.equal(grid[21].position,22);
 assert.equal(grid[10].qualifiedStage,2);assert.equal(grid[16].qualifiedStage,1);
 assert.equal(grid[10].time,116);assert.equal(grid[16].time,95);
 assert.equal(Q.nextStage(s),false);grid[0].name='changed';assert.notEqual(Q.grid(s)[0].name,'changed');
});
test('no-time sessions still produce deterministic complete grid',()=>{
 const s=session();for(let i=0;i<3;i++){finish(s);if(i<2)assert.equal(Q.nextStage(s),true);}
 assert.deepEqual(ids(Q.grid(s)),entries().map(d=>d.id));
});
test('validation and zero grace',()=>{
 assert.throws(()=>Q.createSession(entries().slice(1)),/22/);
 assert.throws(()=>Q.createSession(entries(),[1,0,2]),/positive/);
 const duplicate=entries();duplicate[1].id=duplicate[0].id;assert.throws(()=>Q.createSession(duplicate),/Duplicate/);
 assert.throws(()=>session({graceSeconds:-1}),/nonnegative/);
 const s=session({graceSeconds:0});Q.startLap(s,'d0');Q.tick(s,10);assert.equal(s.drivers.d0.activeLap,null);assert.equal(Q.finishStage(s),true);
 assert.throws(()=>Q.tick(s,-1),/nonnegative/);
});
console.log(`${passed}/${passed} qualifying tests passed`);
