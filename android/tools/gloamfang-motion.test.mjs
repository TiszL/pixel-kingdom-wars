import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileGloamfangMotion,captureGloamfangMotion} from './gloamfang-motion.mjs';
import {CARRIED_LEAP_CANCELLATION} from './carried-motion-metadata.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const load=relative=>import(pathToFileURL(path.join(source,relative)).href);
const {tsImport}=await load('scripts/node_modules/tsx/dist/esm/api/index.mjs');
const typed=relative=>tsImport(pathToFileURL(path.join(source,relative)).href,import.meta.url);
const ts=(await load('scripts/node_modules/typescript/lib/typescript.js')).default;
const clips=await typed('apps/web/src/game/v2/clips.ts');
const shared=await typed('packages/shared/src/index.ts');
const depth=await typed('apps/web/src/game/world/depth.ts');
const mainText=await readFile(path.join(source,'apps/web/src/game/v2/troop.ts'),'utf8');
const meta=JSON.parse(await readFile(path.join(source,'apps/web/public/atlas/meta.json'),'utf8')).v2Clips;
const bindings={TROOP_ABILITIES:shared.TROOP_ABILITIES,actorDepth:depth.actorDepth,facing8Stable:clips.facing8Stable};
const capture=(sourceText,tier=1,values=bindings)=>captureGloamfangMotion(compileGloamfangMotion(ts,sourceText,values),
  {body:meta[`v2_trp_gloamfang_t${tier}_leap`],actorDepth:depth.actorDepth,facing8Stable:clips.facing8Stable});
const replaceIn=(sourceText,before,after)=>{assert.ok(sourceText.includes(before),`Canonical source anchor: ${before}`);return sourceText.replace(before,after);};
// Production main runs an unowned Leap counter. Web commit 7374477c added the
// owned counter, generation fences and cancelLeapMotion(); apply that exact diff
// to main's text so the source-owned path stays covered until it lands on main.
function withOwnedCancellation(sourceText) {
  let text=sourceText;
  if(text.includes('private cancelLeapMotion(): void {')) return text;
  text=replaceIn(text,'  private clearAbilityVisuals(): void {\n',
    '  private cancelLeapMotion(): void {\n    this.leapGeneration++;\n    const tween = this.leapTween;\n    this.leapTween = null;\n    tween?.remove();\n  }\n\n  private clearAbilityVisuals(): void {\n    this.cancelLeapMotion();\n');
  text=replaceIn(text,'  snapPosition(toX: number, toY: number): void {\n    if (!this.alive) return;\n',
    '  snapPosition(toX: number, toY: number): void {\n    if (!this.alive) return;\n    this.cancelLeapMotion();\n');
  text=replaceIn(text,'    const aimed = ix !== undefined && iy !== undefined;\n    this.scene.tweens.killTweensOf(this.sprite);',
    '    const aimed = ix !== undefined && iy !== undefined;\n    this.cancelLeapMotion();\n    this.scene.tweens.killTweensOf(this.sprite);');
  text=replaceIn(text,'    this.scene.tweens.addCounter({\n      from: 0,\n      to: 1,\n      duration,',
    '    const generation = this.leapGeneration;\n    this.leapTween = this.scene.tweens.addCounter({\n      from: 0,\n      to: 1,\n      duration,');
  text=replaceIn(text,'      onUpdate: (tw) => {\n        const p = tw.getValue() ?? 0;',
    '      onUpdate: (tw) => {\n        if (generation !== this.leapGeneration) return;\n        const p = tw.getValue() ?? 0;');
  text=replaceIn(text,'      onComplete: () => {\n        if (this.sprite.active) this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));',
    '      onComplete: () => {\n        if (generation !== this.leapGeneration) return;\n        this.leapTween = null;\n        if (this.sprite.active) this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));');
  return text;
}
const owned=withOwnedCancellation(mainText);
const mainOwns=mainText.includes('private cancelLeapMotion(): void {');

test('Leap exports shared duration, source parabola and the owned cancellation contract for every authored tier',()=>{
  for(const text of [mainText,owned]) for(const tier of [1,2,3,4]) {
    const p=capture(text,tier);
    assert.equal(p.leap.durationMs,shared.TROOP_ABILITIES.gloamfang.leap.travelDeciSec*100);
    assert.equal(p.leap.heightRatio,.30);assert.equal(p.leap.ownedCancellation,true);
    assert.equal(p.leap.ordinaryPosition,'preserveBodyAndCounter');
    assert.equal(p.lunge.position,'nextDeliveredPositionSnap');
    assert.equal(p.lunge.durationMs,undefined,'No invented Lunge landing timer');
  }
});
test('production main without cancelLeapMotion carries the 7374477c cancellation contract and names its provenance',()=>{
  const p=capture(mainText);
  assert.equal(p.leap.cancellationSource,mainOwns?'source':`carried:${CARRIED_LEAP_CANCELLATION.sourceCommit.slice(0,8)}`);
  assert.equal(CARRIED_LEAP_CANCELLATION.sourceCommit,'7374477c3dbabd0e00e233301303f728986dd01e');
  assert.equal(capture(owned).leap.cancellationSource,'source');
  assert.throws(()=>captureGloamfangMotion(compileGloamfangMotion(ts,mainText,bindings),
    {body:meta.v2_trp_gloamfang_t1_leap,actorDepth:depth.actorDepth,facing8Stable:clips.facing8Stable,carried:{ownedCancellation:false}}),/missing carried cancellation contract/);
});
test('an unowned source that cancels its counter through an unknown mechanism fails closed instead of being carried',()=>{
  // Keep the handle without cancelLeapMotion and remove it from clearAbilityVisuals.
  let text=replaceIn(mainText,'    this.scene.tweens.addCounter({\n      from: 0,','    this.leapTween = this.scene.tweens.addCounter({\n      from: 0,');
  text=replaceIn(text,'  private clearAbilityVisuals(): void {\n','  private clearAbilityVisuals(): void {\n    this.leapTween?.remove();\n');
  assert.throws(()=>capture(text),/unknown mechanism/);
});
test('supported duration and parabolic height changes are captured from source rather than stale native constants',()=>{
  const abilities=structuredClone(shared.TROOP_ABILITIES);abilities.gloamfang.leap.travelDeciSec++;
  const p=capture(replaceIn(mainText,'range * 0.30 * 4 * p * (1 - p)','range * 0.42 * 4 * p * (1 - p)'),1,{...bindings,TROOP_ABILITIES:abilities});
  assert.equal(p.leap.durationMs,abilities.gloamfang.leap.travelDeciSec*100);assert.equal(p.leap.heightRatio,.42);
});
test('position snap distance is source-derived with strict independent axis boundaries',()=>{
  assert.equal(capture(mainText).leap.positionSnapDistance,1);
  assert.equal(capture(replaceIn(mainText,'Math.abs(dx) < 1 && Math.abs(dy) < 1','Math.abs(dx) < 2 && Math.abs(dy) < 2')).leap.positionSnapDistance,2);
  for(const changed of ['Math.abs(dx) <= 1 && Math.abs(dy) < 1','Math.abs(dx) < 1 || Math.abs(dy) < 1',
    'Math.abs(dx) < 1 && Math.abs(dy) < 2','Math.abs(dx) < 0 && Math.abs(dy) < 0'])
    assert.throws(()=>capture(replaceIn(mainText,'Math.abs(dx) < 1 && Math.abs(dy) < 1',changed)),/position snap distance/);
});
test('unsupported arc, easing, depth and cast/facing changes fail export',()=>{
  for(const [before,after] of [
    ["ease: 'Linear'","ease: 'Quad.easeIn'"],
    ['range * 0.30 * 4 * p * (1 - p)','range * 0.30 * p'],
    ['setDepth(actorDepth(groundY))','setDepth(actorDepth(y))'],
    ['this.sprite.setPosition(x, y).setDepth(actorDepth(y));','this.sprite.setPosition(x + 1, y).setDepth(actorDepth(y));'],
    ['if (aimed) this.facing = facing8Stable(ix - x, iy - y, this.facing);',"this.facing = 's';"]])
    assert.throws(()=>capture(before==="ease: 'Linear'"?mainText.replace(/(private playLeap[\s\S]*?)ease: 'Linear'/,"$1"+after):replaceIn(mainText,before,after)),/Unsupported Gloamfang motion/);
});
test('a source that owns the counter must remove it and fence BOTH stale callbacks, independently of sprite tween cancellation',()=>{
  assert.throws(()=>capture(replaceIn(owned,'tween?.remove();','')),/counter cancellation/);
  const guard='if (generation !== this.leapGeneration) return;';
  const start=owned.indexOf('  private playLeap('),end=owned.indexOf('  private playFirestorm(',start);
  const leap=owned.slice(start,end);assert.equal(leap.split(guard).length-1,2);
  for(const i of [leap.indexOf(guard),leap.lastIndexOf(guard)]) {
    const changed=leap.slice(0,i)+leap.slice(i+guard.length);
    assert.throws(()=>capture(owned.slice(0,start)+changed+owned.slice(end)),/stale callback cancellation/);
  }
  assert.throws(()=>capture(replaceIn(owned,'this.cancelLeapMotion();\n    for (const timer','for (const timer')),/counter cancellation/);
});
test('Lunge must consume delivered endpoint exactly and stand; event target is not a landing timer',()=>{
  for(const [before,after] of [
    ['this.snapNextPos = true;','this.snapNextPos = false;'],
    ['this.snapNextPos = false;\n      this.scene.tweens','this.snapNextPos = true;\n      this.scene.tweens'],
    ['this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));\n      this.stand();','this.sprite.setPosition(toX + 1, toY).setDepth(actorDepth(toY));\n      this.stand();']])
    assert.throws(()=>capture(replaceIn(mainText,before,after)),/Unsupported Gloamfang motion|Unexpected transform/);
});
test('ordinary delivered positions retain the active Leap body, heading and counter on both source shapes',()=>{
  assert.throws(()=>capture(replaceIn(owned,'onPos(toX: number, toY: number, durMs: number): void {',
    'onPos(toX: number, toY: number, durMs: number): void { this.cancelLeapMotion();')),/ordinary position/);
  for(const text of [mainText,owned]) assert.throws(()=>capture(replaceIn(text,'if (!preserveVerb) this.facing =','this.facing =')),/ordinary position/);
});
test('missing or nonfinite Leap art metadata cannot be admitted as a renderer controller',()=>{
  const controller=compileGloamfangMotion(ts,mainText,bindings);
  for(const body of [undefined,{}, {frames:Infinity,fps:10},{frames:1.5,fps:10},{frames:8,fps:Infinity},{frames:8,fps:0}])
    assert.throws(()=>captureGloamfangMotion(controller,{body,actorDepth:depth.actorDepth,facing8Stable:clips.facing8Stable}),/invalid Leap body/);
});
