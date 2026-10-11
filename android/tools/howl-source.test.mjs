import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileHowlController,captureHowlPlan,captureFacing8StablePlan} from './combat-catalog.mjs';

// This is a canonical-controller probe, with a strict scene capture surface rather
// than a reimplementation of Howl. CI supplies its pinned source and generated art.
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const typed=relative=>tsImport(pathToFileURL(path.join(source,relative)).href,import.meta.url);
const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
const helpers=await typed('apps/web/src/game/v2/clips.ts');
const shared=await typed('packages/shared/src/index.ts');
const depth=await typed('apps/web/src/game/world/depth.ts');
const [troopText,projectileText,metaText]=await Promise.all([
  readFile(path.join(source,'apps/web/src/game/v2/troop.ts'),'utf8'),
  readFile(path.join(source,'apps/web/src/game/v2/projectiles.ts'),'utf8'),
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
const bindings={parseFxAt:helpers.parseFxAt,facing8Stable:helpers.facing8Stable,actorDepth:depth.actorDepth,playV2Fx};
const controller=compileHowlController(ts,troopText,bindings);
const options=(tier=1,fit=.25)=>({body:clips[`v2_trp_gloamfang_t${tier}_howl`],fx:clips[`v2_fx_howl_t${tier}`],tier,fit,drawScale:helpers.V2_DRAW_SCALE});
const replaceSource=(before,after)=>{assert.ok(troopText.includes(before),`expected canonical Howl expression ${before}`);
  return compileHowlController(ts,troopText.replace(before,after),bindings);};

test('canonical Howl captures one stationary finite owned ring for all tiers/fits and aimed/retained facings',()=>{
  for(const tier of [1,2,3,4])for(const fit of [.125,.24,.5,1]) {
    const opt=options(tier,fit),p=captureHowlPlan(controller,opt);
    assert.equal(p.bodyState,'howl');assert.equal(p.target,'currentActorAtRelease');
    assert.equal(p.releaseFrame,helpers.parseFxAt(opt.body.fxAt).find(c=>c.fx==='howl').frames[0]);
    assert.equal(p.offsetX,0);assert.equal(p.offsetY,0);assert.equal(p.depthOffset,-1);
    assert.equal(p.facing,'retainUnlessAimed');assert.equal(p.ownedCancellation,true);
    assert.equal(p.fps,opt.fx.fps);assert.equal(p.scale,opt.drawScale*fit);
    assert.deepEqual(p.anchor,opt.fx.anchorPx.map((n,i)=>n/[opt.fx.cellW,opt.fx.cellH][i]));
  }
});

test('Howl rejects changed cast snap or targetless facing rather than silently exporting wrong identity pose',()=>{
  assert.throws(()=>captureHowlPlan(replaceSource('this.sprite.setPosition(x, y).setDepth(actorDepth(y));','this.sprite.setPosition(x + 1, y).setDepth(actorDepth(y));'),options()),/snap cast/);
  assert.throws(()=>captureHowlPlan(replaceSource('if (aimed) this.facing = facing8Stable(ix - x, iy - y, this.facing);',"this.facing = 's';"),options()),/retain|aim/);
});

test('Howl rejects loss of ownership and released-ring cancellation on death or replay replacement',()=>{
  for(const method of ['onDeath','cancelReplayAction','clearAbilityVisuals']) {
    const changed=Object.create(controller);changed[method]=()=>{};
    assert.throws(()=>captureHowlPlan(changed,options()),/cancellation/);
  }
  const unowned=Object.create(controller);unowned.ownAbilityImage=()=>{};
  assert.throws(()=>captureHowlPlan(unowned,options()),/source-owned/);
});

test('Howl refuses repeated or absent keyed release and malformed finite clip/anchor metadata',()=>{
  const repeated=replaceSource('if (fired || !keyed.includes(frame1)) return;','if (!keyed.includes(frame1)) return;');
  assert.throws(()=>captureHowlPlan(repeated,{...options(),body:{...options().body,fxAt:'howl@2,3'}}),/repeats/);
  assert.throws(()=>captureHowlPlan(controller,{...options(),body:{...options().body,fxAt:'howl@99'}}),/source-owned/);
  for(const fps of [0,NaN,Infinity])assert.throws(()=>captureHowlPlan(controller,{...options(),fx:{...options().fx,fps}}),/Invalid/);
  for(const anchorPx of [[],[1]]) {
    assert.throws(()=>captureHowlPlan(controller,{...options(),fx:{...options().fx,anchorPx}}),/art|lifetime/);
  }
});

test('Howl export fails when canonical ownership or dispatch methods disappear',()=>{
  assert.throws(()=>compileHowlController(ts,troopText.replace('  onAbility(','  missingAbility('),bindings),/Missing canonical/);
});

const clipText=await readFile(path.join(source,'apps/web/src/game/v2/clips.ts'),'utf8');
test('Howl aim captures squared world-pixel minimum and total retained angular half-window',()=>{
  assert.deepEqual(captureFacing8StablePlan(ts,clipText,helpers.facing8Stable,helpers),{minimumDeltaSquared:.25,retainWithinDegrees:22.5+helpers.FACING8_HYSTERESIS_DEG});
});
test('Howl aim refuses helper behavior changes not represented by captured thresholds',()=>{
  assert.throws(()=>captureFacing8StablePlan(ts,clipText,helpers.facing8,helpers),/cannot be represented/);
  assert.throws(()=>captureFacing8StablePlan(ts,clipText,(x,y,c)=>x*x+y*y<1?c:helpers.facing8Stable(x,y,c),helpers),/cannot be represented/);
  for(const [before,after] of [['< 0.25','<= 0.25'],['diff <=','diff <']])
    assert.throws(()=>captureFacing8StablePlan(ts,clipText.replace(before,after),helpers.facing8Stable,helpers),/Unsupported/);
});
test('Howl aim exports deliberate canonical threshold changes rather than preserving old copied values',()=>{
  const changed=clipText.replace('< 0.25','< 1').replace('FACING8_HYSTERESIS_DEG = 10','FACING8_HYSTERESIS_DEG = 15');
  const ast=ts.createSourceFile('clips.ts',changed,ts.ScriptTarget.Latest,true);
  const selected=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&['facing8','facing8Stable'].includes(n.name?.text)||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['FACING8_HYSTERESIS_DEG','FACING_ANGLE'].includes(d.name.getText(ast))));
  const code=selected.map(n=>n.getText(ast).replace(/^export\s+/,'')).join('\n');
  const changedHelper=new Function(ts.transpile(code+';return facing8Stable;',{target:ts.ScriptTarget.ES2022}))();
  assert.deepEqual(captureFacing8StablePlan(ts,changed,changedHelper,{FACING8_HYSTERESIS_DEG:15}),{minimumDeltaSquared:1,retainWithinDegrees:37.5});
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
    const previous=compileHowlController(ts,legacy,bindings);
    assert.deepEqual(captureHowlPlan(previous,options()),captureHowlPlan(controller,options()));
  }else{
    assert.equal(controller.cancelLeapMotion,undefined);
    assert.ok(!troopText.includes('this.cancelLeapMotion()'));
    assert.ok(captureHowlPlan(controller,options()).releaseFrame>0);
  }
});
