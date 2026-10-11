import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {captureArchivePresentation} from './archive-presentation.mjs';
const reference=JSON.parse(await readFile(new URL('../renderer/src/test/resources/archive/source-reference.json',import.meta.url),'utf8'));
test('archive admission keeps the actual historical melee ownership modes and source controller contract',async()=>{
  assert.deepEqual(await captureArchivePresentation(path.resolve(process.env.PKW_NATIVE_SOURCE??'.source'),reference.policy.maximumSimVersion),reference);
  const current=reference.cases.find(c=>c.simVersion===reference.policy.maximumSimVersion);
  for(const item of reference.cases.filter(c=>c.simVersion>=reference.legacy.selfDescribingSimVersion))assert.deepEqual(item.driven,current.driven);
  assert.ok(reference.cases.some(c=>c.simVersion<reference.legacy.selfDescribingSimVersion&&JSON.stringify(c.driven)!==JSON.stringify(current.driven)),
    'Old logs need their verified automatic controller mode, not current event-only rendering');
  assert.ok(reference.policy.minimumSimVersion<reference.legacy.targetAwareSimVersion);
  assert.deepEqual(reference.policy.legacyMelee.mode,'sourceIdleAttack');
});
test('archive ranges cannot change the advertised live simulation contract',async()=>{
  const live=JSON.parse(await readFile(new URL('../native-compatibility.json',import.meta.url),'utf8'));
  assert.deepEqual(live.simVersions,[reference.policy.maximumSimVersion]);
});
