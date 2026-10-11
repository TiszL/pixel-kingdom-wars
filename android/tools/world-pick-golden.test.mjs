import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE, DS, GOLDEN, KEEPS, MAP_PICK, OUT_DIR, VIEWPORTS, realmOf } from './world-pick-golden.mjs';

// Why: the composed TRUE pick golden (defect 7 of the N3 fix pass) is what ComposedPickGoldenTest holds the native tap to.
// Its regeneration against the pin is a local gate step (`node tools/world-pick-golden.mjs --source <SHARDKEEP-globe>
// --check`: the pin is on no remote), so these checks run anywhere, CI included, and prove the committed golden is this
// generator's output at the locked pin, over the pinned keeps atlas that sits beside it, with the tap order map.js has at
// the pin. A golden from another pin, an edited generator, or a keeps atlas other than the pinned one would hold the native
// tap to an engine the renderer does not draw.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'world-shaders.lock.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const dir = path.join(ROOT, OUT_DIR);
const g = JSON.parse(fs.readFileSync(path.join(dir, GOLDEN), 'utf8'));

test('the pick golden is world-pick-golden.mjs output at the locked pin, over the pinned keeps atlas beside it', () => {
  assert.equal(g.pin, lock.source.commit, 'a golden from another pin is not what the renderer draws');
  assert.equal(g.generator, sha(fs.readFileSync(path.join(ROOT, 'tools/world-pick-golden.mjs'))), 'the generator changed since the golden was written: re-run it with --source');
  for (const [module, s] of Object.entries(g.sources)) assert.equal(s, lock.sources[module], `${module} is not the pinned module`);
  assert.deepEqual(Object.keys(g.sources).map(k => k.split('/').pop()).sort(), ['bases.js', 'camera.js', 'contracts.js', 'decor.js', 'loader.js', 'map.js']);
  assert.equal(g.pack.manifestSha256, lock.contentManifest.sha256, 'the keeps atlas comes from the pinned pack manifest');
  assert.deepEqual(fs.readdirSync(dir).sort(), [...KEEPS, GOLDEN].sort(), 'the golden and the two pack files it was computed over, nothing stale');
  for (const f of KEEPS) assert.equal(sha(fs.readFileSync(path.join(dir, f))), g.files[f], `${f} beside the golden is the file it was computed over`);
});

test('the golden covers the tap the owner makes: MAP icons to the TRUE snap, both Seeker viewports, keeps, domes and deeds', () => {
  assert.equal(g.mapPick, MAP_PICK, 'the tap order is the transcription the generator checked against map.js');
  assert.ok(MAP_PICK.indexOf('basesMod?.pick?.') < MAP_PICK.indexOf('R.byCell.get'), 'BASES is asked before the deed cell');
  const crown = g.views.filter(v => v.realm === 'crownlands');
  for (const [vp] of VIEWPORTS) for (const d of DS) assert.ok(crown.some(v => v.viewport === vp && v.d === d), `crownlands ${vp} d ${d}`);
  let count = 0;
  for (const v of g.views) {
    assert.equal(v.codes.length, v.grid.nx * v.grid.ny + v.probes.length / 2, 'one code per grid point and probe');
    for (let k = 0; k < v.probes.length; k += 2) assert.ok(v.probes[k] >= 0 && v.probes[k] <= v.W && v.probes[k + 1] >= 0 && v.probes[k + 1] <= v.H, 'a probe is a tap on the screen');
    count += v.codes.length;
  }
  assert.equal(g.count, count);
  const all = g.views.flatMap(v => v.codes), n = g.realm.bases.length;
  const lane = all.filter(c => c >= CODE.lane && c < n).length, cell = all.filter(c => c >= CODE.cell && c < CODE.open).length, open = all.filter(c => c >= CODE.open).length;
  assert.ok(lane >= 1000 && cell >= 1000 && open >= 1000, `keeps/domes ${lane}, deed cells ${cell}, open deeds ${open}`);
  // TRUE views where a tap reaches a keep or a dome, on both viewports (the defect: TRUE d 1400 and d 3136)
  for (const d of [1400, 3136]) for (const [vp] of VIEWPORTS) assert.ok(crown.some(v => v.d === d && v.viewport === vp && v.laneHits > 0), `TRUE d ${d} ${vp} hits kingdoms`);
  // a realm with no kit dressing at the pin draws no BASES: its taps fall to the deed cell, on web and native alike
  if (g.undressed) { assert.equal(g.ready[g.undressed], false); assert.ok(g.views.filter(v => v.realm === g.undressed).every(v => v.laneHits === 0)); }
  assert.equal(g.ready.crownlands, true);
});

test('the synthetic realm is reproducible: the golden lists exactly what realmOf builds', () => {
  const r = realmOf(0x9e3779b9);
  assert.deepEqual(g.realm.mask, r.mask);
  assert.deepEqual(g.realm.bases, r.bases.map(b => [b.id, b.x, b.y, b.level, b.mine ? 1 : 0, b.shield ? 1 : 0]));
  assert.ok(r.bases.filter(b => b.shield).length >= 20 && r.bases.filter(b => b.mine).length === 1, 'shield domes and one kingdom of yours');
  // a base id is its catalog tile id (native RealmGrid.tileId): the lane seeds its look from it, so the web must too
  for (const b of r.bases) assert.equal(b.id, (r.y0 + b.y) * 720 + r.x0 + b.x);
});
