import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {kegPrimeReference} from './keg-prime-reference.mjs';
const expected=JSON.parse(await readFile(new URL('../renderer/src/test/resources/keg/prime-source-reference.json',import.meta.url),'utf8'));
test('prime evidence executes exact canonical schedule and v2 controller with current authored clips',async()=>{
  assert.deepEqual(await kegPrimeReference(path.resolve(process.env.PKW_NATIVE_SOURCE??'.source')),expected);
});
test('source clamps prime to birth and playback boundary without a zero-length prime at detonation',()=>{
  for(const value of expected.cases)if(value.startTick!==null) {
    assert.ok(value.startTick>=value.deployTick&&value.startTick>=value.fromTick);
    assert.ok(value.startTick<value.detonateTick);
  }
  assert.equal(expected.cases.find(c=>c.name==='fresh-zero').startTick,0);
  assert.equal(expected.cases.find(c=>c.name==='born-at-blast').startTick,null);
  assert.equal(expected.cases.find(c=>c.name==='cold-at-blast').startTick,null);
});
test('source prime keeps its loop and facing across movement then replacement resumes locomotion',()=>{
  for(const body of expected.bodies) {
    assert.equal(body.first.state,'priming');assert.equal(body.continued.state,'priming');
    assert.equal(body.first.facing,body.continued.facing);assert.equal(body.continued.ease,'Linear');
    assert.equal(body.continued.clip,'prime');assert.equal(body.cancelled.clip,'run');
  }
  assert.deepEqual(expected.nearest.point,{x:11,y:4});
});
