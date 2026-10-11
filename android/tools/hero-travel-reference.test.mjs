import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {heroTravelReference} from './hero-travel-reference.mjs';

const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');
const expected=JSON.parse(await readFile(new URL('../renderer/src/test/resources/hero/travel-source-reference.json',import.meta.url),'utf8'));
test('hero transform reference executes current canonical methods and installed Phaser easing exactly',async()=>{
  assert.deepEqual(await heroTravelReference(source),expected,'Source controller changes require a reviewed reference refresh');
});
test('source travel starts at visible movement position instead of the event from coordinate',()=>{
  for(const value of expected.cases.filter(v=>v.name.endsWith('-queued'))) {
    const cast=value.events.find(e=>e.e==='heroSkill'),sample=value.samples.find(s=>s.tick===cast.t);
    assert.notEqual(sample.x,cast.fromX);assert.notEqual(sample.y,cast.fromY);
    assert.ok(sample.x>value.events[0].x,'the cast interrupts an already moving sprite');
    assert.ok(value.samples.every(s=>Math.abs(s.depth-s.y)<1e-8),'depth follows visible feet throughout eased travel and queued movement');
  }
});
test('death cancels transform and queued positions while an ordinary body interruption keeps travel alive',()=>{
  for(const value of expected.cases.filter(v=>v.name.endsWith('-death')||v.name.endsWith('-sameTickDeath'))) {
    const death=value.events.find(e=>e.e==='troopDeath');
    const samples=value.samples.filter(s=>s.tick>=death.t);
    assert.ok(samples.length>1);
    assert.ok(samples.every(s=>!s.alive&&s.x===samples[0].x&&s.y===samples[0].y));
  }
  for(const value of expected.cases.filter(v=>v.name.endsWith('-nonTravel'))) {
    const before=value.samples.find(s=>s.tick===4),after=value.samples.find(s=>s.tick===4.25);
    assert.notEqual(before.x,after.x,'a non-travel body replacement does not kill the sprite tween');
  }
});
test('cold prefix source restores from snapped historical state, not a newly inferred continuous origin',()=>{
  for(const hero of ['vex','theodor']) {
    const cold=expected.cases.find(v=>v.name===`${hero}-cold-4`),live=expected.cases.find(v=>v.name===`${hero}-queued`);
    assert.notEqual(cold.samples[0].x,live.samples.find(s=>s.tick===4).x);
    assert.equal(cold.samples[0].x,cold.events[0].x,'no historical pos endpoint precedes this cold boundary');
    assert.ok(cold.samples[1].x>cold.samples[0].x,'only the active remaining travel resumes');
  }
});
