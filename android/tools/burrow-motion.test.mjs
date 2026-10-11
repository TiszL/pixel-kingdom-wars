import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileBurrowController,captureBurrowMotion} from './burrow-motion.mjs';
import {captureFacing8StablePlan} from './combat-catalog.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const typed=relative=>tsImport(pathToFileURL(path.join(source,relative)).href,import.meta.url);
const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
const helpers=await typed('apps/web/src/game/v2/clips.ts');
const shared=await typed('packages/shared/src/index.ts');
const depth=await typed('apps/web/src/game/world/depth.ts');
const read=relative=>readFile(path.join(source,relative),'utf8');
const text=await read('apps/web/src/game/v2/troop.ts'),ticker=await read('apps/web/src/game/v2/ticker.ts');
const meta=JSON.parse(await read('apps/web/public/atlas/meta.json')).v2Clips;
function extract(sourceText,name,bindings={},variable=false) {
  const ast=ts.createSourceFile('source.ts',sourceText,ts.ScriptTarget.Latest,true);
  const node=variable?ast.statements.flatMap(s=>ts.isVariableStatement(s)?[...s.declarationList.declarations]:[]).find(n=>n.name.getText(ast)===name):
    ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert.ok(node,`canonical ${name}`);
  return new Function(...Object.keys(bindings),ts.transpile(variable?`return (${node.initializer.getText(ast)});`:
    `${node.getText(ast).replace(/^export\s+/,'')};return ${name};`,{target:ts.ScriptTarget.ES2022}))(...Object.values(bindings));
}
const profiles=extract(text,'V2_TROOP_PROFILES',{},true);
const playV2Fx=extract(await read('apps/web/src/game/v2/projectiles.ts'),'playV2Fx',{
  ...helpers,...shared,DEPTH_IMPACT:0,combatEffectPool:scene=>scene.pool});
const v2TroopDrawScale=extract(text,'v2TroopDrawScale',{...shared,...helpers});
const fit=extract(text,'v2TroopArtFit',{...shared,...helpers,v2TroopDrawScale});
const bindings={...helpers,...depth,playV2Fx,MELEE_FX_EMITTER:extract(text,'MELEE_FX_EMITTER',{},true),
  FACING_ROTATION_DEG:extract(text,'FACING_ROTATION_DEG',{},true)};
const aim=captureFacing8StablePlan(ts,await read('apps/web/src/game/v2/clips.ts'),helpers.facing8Stable,helpers);
const options=(unit='tunneler',tier=1)=>({unit,tier,profile:profiles[unit],clips:meta,fit:fit(unit),drawScale:helpers.V2_DRAW_SCALE,aim,actorDepth:depth.actorDepth});
const capture=(troopText=text,tickerText=ticker,opts=options())=>captureBurrowMotion(compileBurrowController(ts,troopText,tickerText,bindings),opts);
const replace=(before,after,sourceText=text)=>{assert.ok(sourceText.includes(before),`canonical anchor ${before}`);return sourceText.replace(before,after);};

test('every authored burrowing tier exports visible controller policies and canonical clocks remain in clips',()=>{
  for(const unit of ['tunneler','bilgewraith'])for(const tier of [1,2,3,4]) {
    const plan=capture(text,ticker,options(unit,tier));
    assert.equal(plan.controller,'v2Burrow');assert.equal(plan.enterState,profiles[unit].burrow.enter);
    assert.equal(plan.soilOwnership,'scene');assert.deepEqual(plan.aim,aim);
    assert.equal(plan.durationMs,undefined);assert.equal(plan.travelMs,undefined);
  }
});
test('source-authored soil depth and axis threshold are derived rather than frozen in Kotlin',()=>{
  assert.equal(capture().soilDepthOffset,-1);
  assert.equal(capture(replace('this.sprite.x, this.sprite.y, { depth: this.sprite.depth - 1 }','this.sprite.x, this.sprite.y, { depth: this.sprite.depth - 3 }')).soilDepthOffset,-3);
  assert.equal(capture(replace('Math.abs(dx) < 1 && Math.abs(dy) < 1','Math.abs(dx) < 2 && Math.abs(dy) < 2')).positionSnapDistance,2);
});
test('movement, opaque body, retained flags and cancellation semantics cannot silently drift',()=>{
  for(const [before,after] of [
    ['onBurrow(): void {','onBurrow(): void { this.scene.tweens.killTweensOf(this.sprite);'],
    ["this.state = 'burrowing';","this.state = 'burrowing'; this.sprite.setVisible(false);"],
    ["this.state = 'emerging';","this.state = 'emerging'; this.moving = false;"],
    ['if (!preserveVerb) this.facing =','this.facing ='],
    ['if (generation !== this.moveGeneration) return;',''],
    ["if (this.state !== 'priming') return;",''],
    ["if (this.alive && this.state === 'acting') this.stand();",'this.deps.ticker.unregister(this.sprite);']])
    assert.throws(()=>capture(replace(before,after)),/Unsupported Burrow motion/);
});
test('actual ticker must preserve identical callbacks and row phase and keep keyed release convention',()=>{
  assert.throws(()=>capture(text,replace('return; // identical — keep playing exactly as-is','cur.onFrame=p.onFrame; return;',ticker)),/identical registration/);
  assert.throws(()=>capture(text,replace('cur.seq = p.seq;','cur.i=0; cur.acc=0; cur.seq = p.seq;',ticker)),/row registration/);
  assert.throws(()=>capture(text,replace('eligibleTick: this.tickGeneration + (this.ticking ? 1 : 0)',
    'eligibleTick: this.tickGeneration',ticker)),/chained body/);
  assert.throws(()=>capture(replace('if (!e.frames.includes(f)) continue;','if (!e.frames.includes(f + 1)) continue;')),/release timing/);
});
test('scene soil must outlive the actor and use a finite pooled expiry',()=>{
  assert.throws(()=>capture(replace('this.playEffect(\n            `v2_fx_soil_t${this.deps.tier}`,',
    'this.ownedAbilityFx.add(this.playEffect(\n            `v2_fx_soil_t${this.deps.tier}`,').replace(
      'this.sprite.x, this.sprite.y, { depth: this.sprite.depth - 1 },\n          );',
      'this.sprite.x, this.sprite.y, { depth: this.sprite.depth - 1 },\n          ));')),/scene soil ownership/);
  for(const change of [{frames:0},{fps:0},{loop:true}]) {
    const opts=options();opts.clips={...meta,v2_fx_soil_t1:{...meta.v2_fx_soil_t1,...change}};
    assert.throws(()=>capture(text,ticker,opts),/finite soil/);
  }
});
