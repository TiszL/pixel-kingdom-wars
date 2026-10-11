// GLSL drift (R14): the web globe compiles exactly the stages native ships. Each preprocessed stage's sha256 must equal
// native's world-shaders.lock.json (goldens/stages.lock.json, copied from globe-native 7b5075b), and the shader
// module itself must be the pinned concept file. Why: D-168/NR4 — one globe shader source on both platforms; a web-only
// edit would make the web draw a different globe than the owner approved on his phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { globeStages, PREAMBLE, COVER_FS, COVER_VS } from './glsl.mjs';
import { PIN } from './pin.mjs';

const LOCK = JSON.parse(readFileSync(new URL('./goldens/stages.lock.json', import.meta.url), 'utf8'));
const sha = s => createHash('sha256').update(s).digest('hex');

test('the lock is native\'s release lock at the world pin', () => {
  assert.equal(LOCK.commit, PIN);
  assert.deepEqual(Object.keys(LOCK.stages).sort(), ['globe-flat.fs.glsl', 'globe-flat.vs.glsl', 'globe-fx.fs.glsl', 'globe-fx.vs.glsl', 'globe-isles.fs.glsl', 'globe-isles.vs.glsl']);
});

test('flat.glsl.js is byte-identical to the pinned concept module', () => {
  assert.equal(sha(readFileSync(new URL('./flat.glsl.js', import.meta.url))), LOCK.flatModuleSha256);
});

test('the preamble and all six preprocessed globe stages equal native\'s locked sha256', () => {
  assert.equal(sha(PREAMBLE), LOCK.preambleSha256);
  const stages = globeStages();
  let n = 0;
  for (const [name, st] of Object.entries(stages)) for (const kind of ['vs', 'fs']) {
    assert.equal(sha(st[kind]), LOCK.stages[`${name}.${kind}.glsl`], `${name} ${kind}`); n++;
  }
  assert.equal(n, 6);
});

test('the dive cover keeps native\'s body and the pinned preamble (its only stages outside the lock)', () => {
  assert.ok(COVER_VS.startsWith(PREAMBLE) && COVER_FS.startsWith(PREAMBLE));
  assert.match(COVER_FS, /float th = mix\(1\.12, -0\.32, uCover\.x\);/);
  assert.match(COVER_FS, /uniform highp sampler2DArray uCloud;/);
});
