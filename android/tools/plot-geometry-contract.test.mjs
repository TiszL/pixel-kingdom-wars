import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { plotGeometryContract } from './plot-geometry-contract.mjs';
test('immutable supported plot resource remains exact source-versioned geometry', async()=>{
  const current=JSON.parse(await readFile(new URL('../network/src/main/resources/plot-geometry.json', import.meta.url)));
  assert.deepEqual(current,{legacyVersion:1,currentVersion:2,boundsByVersion:{1:{min:0,max:30},2:{min:-10,max:40}}});
  assert.equal(plotGeometryContract(current), await readFile(new URL('../network/src/main/resources/plot-geometry.json', import.meta.url),'utf8'));
  assert.throws(()=>plotGeometryContract({...current,currentVersion:3}));
});
