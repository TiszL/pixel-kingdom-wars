import assert from 'node:assert/strict';
import test from 'node:test';
import { captureBuildingRules,checkedClip,baseBuildingLoopSpeed,captureTrapRestStates } from './base-catalog.mjs';

test('base loop speed follows the canonical catalogue and missing or invalid tuning refuses export',()=>{
  assert.equal(baseBuildingLoopSpeed({AMBIENCE:{baseBuildingLoopSpeed:0.6}}),0.6);
  for(const speed of [undefined,0,-1,NaN]) assert.throws(()=>baseBuildingLoopSpeed({AMBIENCE:{baseBuildingLoopSpeed:speed}}),/canonical base building loop speed/);
});

function rest() {this.play(this.levelupPending?'flash':this.jobKind?'construction':this.working?'operate':'rest',0,!this.levelupPending&&!this.jobKind);}
function setJob(kind) {this.levelupPending=this.jobKind==='upgrade'&&kind===null;this.jobKind=kind;}

test('base rules are captured from canonical behavior, including operation yielding to active jobs',()=>{
  const rules=captureBuildingRules(rest,setJob,(b,job)=>b.type==='mine'&&job===null,['mine','keep']);
  assert.deepEqual(rules,{workingTypes:['mine'],idleState:'rest',workState:'operate',buildState:'construction',levelupState:'flash',buildLoop:false});
  assert.throws(()=>captureBuildingRules(rest,setJob,(b)=>b.type==='mine',['mine']),/yields/);
  assert.throws(()=>captureBuildingRules(function(){this.play('job',0,true);},setJob,()=>false,[]),/loop/);
  assert.throws(()=>captureBuildingRules(rest,()=>{},()=>false,[]),/completion/);
});

test('base clip requires actual complete equal-canvas frames and retains authored compact scale',()=>{
  const index=new Map([['a','atlas/core.json'],['b','atlas/core.json']]);
  const frames=new Map([['atlas/core.json',new Map([['a',{w:48,h:32}],['b',{w:48,h:32}]])]]);
  const spec={key:'builder',frames:[['a','b']],rowOrder:['e'],fps:13,loop:true,anchor:[0.5,0.75],scale:1.1};
  assert.deepEqual(checkedClip(index,frames,spec),{...spec,atlasPath:'atlas/core.json',cellWidth:48,cellHeight:32,static:false});
  for(const anchor of [[],[0.5],[0,0,0],[0,NaN]]) assert.throws(()=>checkedClip(index,frames,{...spec,anchor}),/geometry/);
  assert.throws(()=>checkedClip(index,frames,{...spec,frames:[['a','missing']]}),/missing/);
  frames.get('atlas/core.json').set('b',{w:24,h:32});
  assert.throws(()=>checkedClip(index,frames,spec),/canvas/);
});


test('trap rest capture admits only source-looped owner states and never loops spent traps',()=>{
  const art={balloon:'sway',spike:'armed'};
  const source=function(spent){this.play(spent?'spent':art[this.deps.unit],!spent&&this.deps.unit==='balloon');};
  assert.deepEqual(captureTrapRestStates(source,art),{balloon:'sway'});
  assert.throws(()=>captureTrapRestStates(function(){this.play('spent',true);},art),/Spent trap/);
  assert.throws(()=>captureTrapRestStates(function(){},art),/Unsupported/);
});
