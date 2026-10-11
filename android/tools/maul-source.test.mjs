import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileMaulController,captureMaulPlan,assertTargetlessMaulEvents} from './combat-catalog.mjs';

// This is a canonical-controller probe, with a strict scene capture surface rather
// than a reimplementation of Maul. CI supplies its pinned source and generated art.
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const typed=relative=>tsImport(pathToFileURL(path.join(source,relative)).href,import.meta.url);
const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
const helpers=await typed('apps/web/src/game/v2/clips.ts');
const shared=await typed('packages/shared/src/index.ts');
const depth=await typed('apps/web/src/game/world/depth.ts');
const [troopText,projectileText,simText,metaText]=await Promise.all([
  readFile(path.join(source,'apps/web/src/game/v2/troop.ts'),'utf8'),
  readFile(path.join(source,'apps/web/src/game/v2/projectiles.ts'),'utf8'),
  readFile(path.join(source,'packages/sim/src/sim.ts'),'utf8'),
  readFile(path.join(source,'apps/web/public/atlas/meta.json'),'utf8')]);
const clips=JSON.parse(metaText).v2Clips;
const ast=ts.createSourceFile('projectiles.ts',projectileText,ts.ScriptTarget.Latest,true);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='playV2Fx');
assert.ok(fn,'canonical FX controller must exist');
const depthNode=ast.statements.flatMap(n=>ts.isVariableStatement(n)?[...n.declarationList.declarations]:[]).find(n=>n.name.getText(ast)==='DEPTH_IMPACT');
assert.ok(depthNode,'canonical impact depth must exist');
const impactDepth=new Function(...Object.keys(depth),`return (${depthNode.initializer.getText(ast)});`)(...Object.values(depth));
const fxBindings={frameName:helpers.frameName,atlasGroupFor:shared.atlasGroupFor,V2_DRAW_SCALE:helpers.V2_DRAW_SCALE,
  DEPTH_IMPACT:impactDepth,combatEffectPool:scene=>scene.pool};
const playV2Fx=new Function(...Object.keys(fxBindings),ts.transpile(`${fn.getText(ast).replace(/^export\s+/,'')};return playV2Fx;`,{target:ts.ScriptTarget.ES2022}))(...Object.values(fxBindings));
const bindings={parseFxAt:helpers.parseFxAt,toWorldPx:helpers.toWorldPx,v2DirewyvernFxBaseKey:shared.v2DirewyvernFxBaseKey,playV2Fx};
const controller=compileMaulController(ts,troopText,bindings);
const options=(tier=1,fit=.25)=>({body:clips[`v2_trp_direwyvern_t${tier}_maul`],fx:clips[`v2_fx_impact_slam_t${tier}`],tier,fit,drawScale:helpers.V2_DRAW_SCALE});
const troopAst=ts.createSourceFile('troop.ts',troopText,ts.ScriptTarget.Latest,true);
const maulMethod=troopAst.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx')?.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(troopAst)==='playMaul')?.getText(troopAst);
assert.ok(maulMethod);
const replaceSource=(before,after)=>{assert.ok(maulMethod.includes(before),`expected canonical Maul expression ${before}`);
  return compileMaulController(ts,troopText.replace(maulMethod,maulMethod.replace(before,after)),bindings);};

test('canonical Maul derives two finite fitted impacts for every tier and moves only the second X/depth',()=>{
  for(const tier of [1,2,3,4])for(const fit of [.125,.2409,.5,1]) {
    const opt=options(tier,fit),p=captureMaulPlan(controller,opt);
    assert.equal(p.bodyState,'maul');assert.equal(p.target,'currentActorXAtReleaseCapturedGroundY');
    assert.equal(p.releaseFrame,helpers.parseFxAt(opt.body.fxAt).find(cue=>cue.fx==='impact_slam').frames[0]);
    assert.equal(p.secondDelayMs,1000/opt.body.fps);
    assert.ok(Math.abs(p.leftOffsetX+helpers.toWorldPx(opt.body.cellW*.13)*fit)<1e-8);
    assert.ok(Math.abs(p.rightOffsetX-helpers.toWorldPx(opt.body.cellW*.13)*fit)<1e-8);
    assert.ok(Math.abs(p.groundOffsetY-helpers.toWorldPx(8)*fit)<1e-8);assert.equal(p.depthOffset,1);
    assert.equal(p.fps,opt.fx.fps);assert.equal(p.scale,opt.drawScale*fit);
    assert.deepEqual(p.anchor,opt.fx.anchorPx.map((n,i)=>n/[opt.fx.cellW,opt.fx.cellH][i]));
  }
});

test('canonical Maul admission requires targetless simulator events',()=>{
  assert.doesNotThrow(()=>assertTargetlessMaulEvents(ts,simText));
  const needle="ability: 'maul', x: tr.x, y: tr.y";
  assert.ok(simText.includes(needle));
  assert.throws(()=>assertTargetlessMaulEvents(ts,simText.replace(needle,needle+', ix: tr.x, iy: tr.y')),/targetless/);
  assert.throws(()=>assertTargetlessMaulEvents(ts,''),/Missing/);
});

test('Maul export rejects changed second origin, recaptured ground, depth and body-frame delay',()=>{
  for(const [before,after] of [
    ['this.sprite.x + wing, ground','this.sprite.x - wing, ground'],
    ['this.sprite.x + wing, ground','this.sprite.x + wing, this.sprite.y'],
    ['this.sprite.x + wing, ground, {\n            depth: this.sprite.depth + 1','this.sprite.x + wing, ground, {\n            depth: this.sprite.depth + 2'],
    ['this.delayedAbilityCall(1000 / (clip.fps ?? 12)','this.delayedAbilityCall(2000 / (clip.fps ?? 12)'],
  ])assert.throws(()=>captureMaulPlan(replaceSource(before,after),options()),/geometry|delay/);
});

test('Maul admission refuses released impacts or second timers surviving death or replay replacement',()=>{
  for(const method of ['onDeath','cancelReplayAction','clearAbilityVisuals']) {
    const changed=Object.create(controller);changed[method]=()=>{};
    assert.throws(()=>captureMaulPlan(changed,options()),/cancellation/);
  }
  const unowned=Object.create(controller);unowned.ownAbilityImage=()=>{};
  assert.throws(()=>captureMaulPlan(unowned,options()),/source-owned/);
});

test('Maul export rejects missing releases and invalid finite art timing',()=>{
  const missing=Object.create(controller);missing.playMaul=function(){this.playAbilityOnce('maul',()=>{});};
  assert.throws(()=>captureMaulPlan(missing,options()),/source-owned/);
  const repeated=replaceSource('if (fired || !keyed.includes(frame1)) return;','if (!keyed.includes(frame1)) return;');
  assert.throws(()=>captureMaulPlan(repeated,{...options(),body:{...options().body,fxAt:'impact_slam@2,3'}}),/repeats|source-owned/);
  for(const fps of [0,NaN,Infinity])assert.throws(()=>captureMaulPlan(controller,{...options(),fx:{...options().fx,fps}}),/Invalid/);
  assert.throws(()=>compileMaulController(ts,troopText.replace('private playMaul()','private missingMaul()'),bindings),/Missing canonical/);
});

test('canonical optional Leap cleanup remains real while older controller packs stay exportable',()=>{
  const tree=ts.createSourceFile('troop.ts',troopText,ts.ScriptTarget.Latest,true);
  const owner=tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='V2TroopFx');
  const method=owner.members.find(n=>ts.isMethodDeclaration(n)&&n.name.getText(tree)==='cancelLeapMotion');
  if(method){
    let removed=0;const context={leapGeneration:4,leapTween:{remove(){removed++;}}};
    controller.cancelLeapMotion.call(context);
    assert.equal(removed,1);assert.equal(context.leapGeneration,5);assert.equal(context.leapTween,null);
    // Before the owned-motion correction there was no helper or call. Both
    // supported source shapes must still execute the actual effect probe.
    const legacy=troopText.replace(method.getText(tree),'').replaceAll('this.cancelLeapMotion();','');
    const previous=compileMaulController(ts,legacy,bindings);
    assert.deepEqual(captureMaulPlan(previous,options()),captureMaulPlan(controller,options()));
  }else{
    assert.equal(controller.cancelLeapMotion,undefined);
    assert.ok(!troopText.includes('this.cancelLeapMotion()'));
    assert.ok(captureMaulPlan(controller,options()).releaseFrame>0);
  }
});
