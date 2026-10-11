// R14 (plan §8): the web must draw the same shader stages native's goldens and release checks are locked to (D-176: the
// web follows native; D-168: one shader source). A realm-map GLSL module edited on the web alone would make the two
// platforms render a realm differently with nothing failing. This test recomputes each module's sha256 and holds it to
// glsl.lock.json, and glsl.lock.json to native's world-shaders.lock.json (the copy recorded in the lock, and the live
// file too when the native checkout is on disk: WV2_NATIVE_LOCK, or the android/ checkout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const here = new URL('./', import.meta.url), lock = JSON.parse(readFileSync(new URL('glsl.lock.json', here), 'utf8'));
const sha = buf => createHash('sha256').update(buf).digest('hex');
const nativeKey = f => `concepts/globe3d-2026-09-23/src/realm/glsl/${f.replace(/\.glsl\.mjs$/, '.glsl.js')}`;

test('every shipped realm GLSL module is byte-identical to the lock, and the lock lists exactly the shipped modules', () => {
  const files = readdirSync(new URL('glsl/', here)).filter(f => f.endsWith('.glsl.mjs')).sort();
  assert.equal(files.length, 12, 'the twelve realm-map shader modules');
  assert.deepEqual(Object.keys(lock.modules).sort(), files.map(f => `glsl/${f}`), 'lock entries = shipped modules');
  for (const f of files) assert.equal(sha(readFileSync(new URL(`glsl/${f}`, here))), lock.modules[`glsl/${f}`].sha256, `${f} drifted from the lock`);
});

test('the lock equals native world-shaders.lock.json at the world pin 02e9da84', () => {
  assert.equal(lock.pin, '02e9da8414156b9e0000df1653de6273b196cca6', 'the pin native locks its shaders and pack to');
  assert.equal(lock.native.packVersion, 'pm1-cb8faa56909faa31');
  for (const [k, m] of Object.entries(lock.modules)) {
    assert.equal(m.source, nativeKey(k.slice(5)), `${k} names its concept source`);
    assert.equal(lock.native.sources[m.source], m.sha256, `${k} = native's recorded sha256`);
  }
  // the live native lock, when this machine has the native checkout (CI does not: the recorded copy above then stands)
  const path = process.env.WV2_NATIVE_LOCK ?? join(homedir(), 'Desktop/pkw-android-globe/world-shaders.lock.json');
  if (!existsSync(path)) { console.log(`glsl.test: no native lock at ${path}; checked against the copy recorded in glsl.lock.json`); return; }
  const nl = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(nl.source.commit, lock.pin, 'native is still pinned where the web is');
  for (const m of Object.values(lock.modules)) assert.equal(nl.sources[m.source], m.sha256, `${m.source}: native's live lock`);
});

test('teeth: a one-byte edit of a module changes its sha256 (the check above can fail)', () => {
  const f = readFileSync(new URL('glsl/common.glsl.mjs', here));
  const edited = Buffer.concat([f, Buffer.from(' ')]);
  assert.notEqual(sha(edited), lock.modules['glsl/common.glsl.mjs'].sha256);
});
