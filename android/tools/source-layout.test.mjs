import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {sourcePaths} from './source-layout.mjs';
const source=path.resolve(process.env.PKW_NATIVE_SOURCE??'.source');

test('every dirty-source gate pathspec names a live path in the pinned source checkout',()=>{
  // `git status --porcelain -- <pathspec>` reports nothing for a path that does not exist, so a
  // retired or moved root silently drops out of the gate: the exporter would then accept uncommitted
  // edits to that root and pin a pack whose provenance no longer matches its sourceCommit. This
  // happened when source PR #83 consolidated the owner art roots under art/source/; the gate kept
  // listing the old names for a release. A move must fail here, not pass quietly.
  const missing=sourcePaths.filter(relative=>!existsSync(path.join(source,relative)));
  assert.deepEqual(missing,[],`sourcePaths entries missing from ${source}; re-point tools/source-layout.mjs at the current roots (source docs/ASSET_PIPELINE.md "Current source roots")`);
  assert.equal(new Set(sourcePaths).size,sourcePaths.length,'duplicate sourcePaths entry');
});
