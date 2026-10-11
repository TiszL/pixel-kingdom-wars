import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT_DIR as BORDER_DIR, OUT_FILE as BORDER_FILE } from './world-ground-border.mjs';
import { OUT_DIR as GROUND_DIR } from './world-ground-golden.mjs';
import { BASES_GOLDEN_DIR, DECOR_TABLES_OUT, LIFE_GOLDEN_DIR, LIFE_TABLES_OUT } from './world-lifebases.mjs';

// Why: N3's parity rests on golden vectors computed by the PINNED web engine (GLOBE-NATIVE-PLAN §7: classify and
// groundcost from tools/world-ground-golden.mjs, scatter and decor from tools/world-lifebases.mjs; TRUE picking is
// tools/world-golden.mjs pick.json, checked by its own test). Their regeneration against the pin is a local gate step
// (`node tools/<tool>.mjs --source <SHARDKEEP-globe> --check`: the pin is on no remote), so these tests run anywhere, CI
// included, and prove each committed file is its generator's output at the locked pin, from the pinned modules and the
// pinned pack manifest, with no suite missing or left over. A golden from another pin, another module or an edited
// generator would teach the native port a different engine than the one its shaders come from.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'world-shaders.lock.json'), 'utf8'));
const sha = rel => createHash('sha256').update(fs.readFileSync(path.resolve(ROOT, rel))).digest('hex');
const read = rel => JSON.parse(fs.readFileSync(path.resolve(ROOT, rel), 'utf8'));
/** The realms of the pinned pack manifest (pm1-cb8faa56909faa31): every realm with a pack gets its classify vectors. */
const REALMS = ['cinderfall', 'crownlands', 'elderwood', 'frostveil', 'seeker-reach', 'stormcairn', 'sunscar', 'thornwake'];

/** Every file is the generator's output at the locked pin, from the modules the lock pins, and from the pinned pack. */
function assertPinned(files, generator, minModules = 5) {
  const want = sha(generator);
  for (const rel of files) {
    const g = read(rel);
    assert.equal(g.pin, lock.source.commit, `${rel}: a golden from another pin is not what the renderer draws`);
    assert.equal(g.generator, want, `${rel}: ${generator} changed since this file was written: re-run it with --source`);
    let pinned = 0;
    for (const [module, s] of Object.entries(g.sources ?? {})) if (lock.sources[module] !== undefined) { assert.equal(s, lock.sources[module], `${rel}: ${module} is not the pinned module`); pinned++; }
    assert.ok(pinned >= minModules, `${rel}: computed from ${pinned} pinned engine modules`);
    if (g.pack) assert.equal(g.pack.manifestSha256, lock.contentManifest.sha256, `${rel}: pack bytes from the pinned manifest`);
  }
}
const listed = dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.json')).sort();

test('GROUND: the classify and groundcost vectors are world-ground-golden.mjs output at the locked pin, for every realm of the pinned pack', () => {
  const want = ['classify-common.json', ...REALMS.map(r => `classify-${r}.json`), 'groundcost.json', 'math.json'].sort();
  assert.deepEqual(listed(GROUND_DIR), want, 'one classify suite per packed realm, and no stale suite');
  assertPinned(want.map(f => `${GROUND_DIR}/${f}`), 'tools/world-ground-golden.mjs');
  for (const r of REALMS) {
    const g = read(`${GROUND_DIR}/classify-${r}.json`);
    assert.equal(g.suite, `classify-${r}`);
    assert.ok(g.count > 8000, `${r}: ${g.count} classify vectors`);
    assert.ok(g.pack, `${r}: classify ran over the pinned pack bytes`);
  }
  // the cost model's budgets are the ones the plan's ceilings name (§1.2): a golden with other budgets tests other rules
  const c = read(`${GROUND_DIR}/groundcost.json`);
  assert.deepEqual([c.constants.DISPLAY_BUDGET, c.constants.FRAME_BUDGET, c.constants.FRAME_ITER_BUDGET], [64, 96, 256]);
});

test('LIFE + BASES: the scatter and decor vectors and the runtime tables are world-lifebases.mjs output at the locked pin', () => {
  // (stage B: golden-table.json is life.js load()'s species table over the real pack atlases, incl. the lens-glow texels)
  assert.deepEqual(listed(LIFE_GOLDEN_DIR), ['golden-compile.json', 'golden-pixels.json', 'golden-place.json', 'golden-plan.json', 'golden-table.json']);
  assert.deepEqual(listed(BASES_GOLDEN_DIR), ['golden-bases.json', 'golden-decor.json', 'golden-demo.json', 'golden-paths.json']);
  const files = [...listed(LIFE_GOLDEN_DIR).map(f => `${LIFE_GOLDEN_DIR}/${f}`), ...listed(BASES_GOLDEN_DIR).map(f => `${BASES_GOLDEN_DIR}/${f}`), LIFE_TABLES_OUT, DECOR_TABLES_OUT];
  assertPinned(files, 'tools/world-lifebases.mjs');
  for (const rel of files) if (!rel.endsWith('-tables.json')) assert.ok(read(rel).suite, `${rel} names its suite`);
  // the runtime tables ship in the APK (main resources): presentation only, never a game number (native CLAUDE.md)
  for (const rel of [LIFE_TABLES_OUT, DECOR_TABLES_OUT]) assert.match(rel, /^renderer\/src\/main\/resources\//);
});

test('GROUND border: border.json is world-ground-border.mjs output at the locked pin, over the pinned pack, one suite per packed realm', () => {
  // Why (NR ask #3, stage B): the border suite holds native's catalogue-mask far field and its handling of PACK's baked
  // fieldsA to the pinned web code. A border golden from another pin or pack pins a coast neither client draws (at
  // 4de21f1a it asserted an unbaked pack; the stage B pack bakes foreignSea + clipTarns).
  const rel = `${BORDER_DIR}/${BORDER_FILE}`, g = read(rel);
  assert.deepEqual(listed(BORDER_DIR), [BORDER_FILE], 'no stale border suite');
  assert.equal(g.suite, 'border');
  // classify.js, contracts.js, loader.js and minimap.js are the pinned modules it imports (fantasyWorld.ts is packages/shared)
  assertPinned([rel], 'tools/world-ground-border.mjs', 4);
  assert.equal(g.pack.packVersion, lock.contentManifest.packVersion);
  assert.deepEqual(g.realms.map(r => r.realm), REALMS);
  for (const r of g.realms) {
    // every packed realm bakes both passes, and the suite says the loader leaves the file alone (0 texels, computed)
    assert.deepEqual(r.fieldsA.baked, ['clipTarns', 'foreignSea'], `${r.realm}: baked passes`);
    assert.deepEqual([r.packVsCatalog.coastTexels, r.packVsCatalog.lakeTexels, r.packVsCatalog.vertices], [0, 0, 0], `${r.realm}: the loaded fields are the file`);
    assert.equal(r.reRun.packCoastTexels, 0, `${r.realm}: the cap is idempotent on its own output`);
    assert.equal(r.vertices.length, r.border.length, `${r.realm}: one vertex set per border deed`);
  }
  // teeth: the catalogue far field moves baked coast somewhere, so a loader that re-ran the cap would be caught
  assert.ok(g.realms.reduce((s, r) => s + r.reRun.vertices, 0) > 0, 'no border vertex moves on a re-run: the suite tests nothing');
  assert.ok(g.realms.reduce((s, r) => s + r.packVsCatalog.farDeeds, 0) > 1000, 'the pack mask moves too few far-field deeds');
  assert.equal(g.count, g.realms.reduce((s, r) => s + r.border.length * 14 * 14 * 2, 0));
});

test('the pin check has teeth: another pin, an edited generator or a foreign module are each refused', () => {
  const rel = `${GROUND_DIR}/groundcost.json`, g = read(rel), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-detail-golden-'));
  try {
    const module = Object.keys(g.sources).find(k => lock.sources[k] !== undefined);
    const cases = [[{ ...g, pin: 'f'.repeat(40) }, /another pin/], [{ ...g, generator: '0'.repeat(64) }, /changed since this file was written/],
      [{ ...g, sources: { ...g.sources, [module]: '0'.repeat(64) } }, /is not the pinned module/]];
    for (const [doc, error] of cases) {
      const p = path.join(tmp, 'g.json'); fs.writeFileSync(p, JSON.stringify(doc));
      assert.throws(() => assertPinned([p], 'tools/world-ground-golden.mjs'), error);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
