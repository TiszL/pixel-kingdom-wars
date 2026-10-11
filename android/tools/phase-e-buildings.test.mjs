import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nonServicesBuildingKinds, phaseEFlagDefault } from './phase-e-buildings.mjs';

// Source stubs shaped like the backend after Phase E M41 (#125): the five dark types have STRUCTURES rows but no
// bld_<type>_l<n> sprites, and apps/api/src/config.ts declares the placement flag with a zod default.
const DARK = ['workshop', 'lodge', 'market', 'harvester', 'berth'];
const constants = { STRUCTURES: Object.fromEntries(['keep', 'mine', ...DARK].map(type => [type, {}])), DEFENSES: { cannon: {} },
  PHASE_E_BUILDINGS: { types: DARK } };
const config = (value) => `const schema = z.object({\n  /** placement of the five dark types */\n  PHASE_E_BUILDINGS_ENABLED: z.enum(['true', 'false']).default('${value}'),\n  OTHER: z.string(),\n});\n`;

test('a pack without Phase E services never carries a dark Phase E building', () => {
  // The owner's D-153.48 keeps the Phase E native client out of code 26 while every Phase E flag ships dark. A dark
  // type in the building catalogue would make the exporter demand bld_ sprites the release source does not carry (the
  // approved Phase E art is on the Phase E lane's phase-e-preserved-20260924, not wired here), and a device must
  // never be handed a building the server cannot place.
  const { kinds, omitted } = nonServicesBuildingKinds(constants, () => config('false'));
  assert.deepEqual(Object.keys(kinds), ['keep', 'mine', 'cannon']);
  assert.deepEqual(omitted, DARK, 'the omitted list is recorded in the pack manifest and lock');
  assert.equal(DARK.some(type => type in kinds), false);
});

test('the omission refuses a source whose Phase E default is not dark or cannot be read', () => {
  // Omitting buildings a source ships ENABLED would hide real player buildings on device; the exporter must stop and
  // name the flag instead of guessing.
  assert.throws(() => nonServicesBuildingKinds(constants, () => config('true')), /PHASE_E_BUILDINGS_ENABLED defaults to 'true'/);
  assert.throws(() => nonServicesBuildingKinds(constants, () => 'const schema = z.object({});\n'), /Cannot determine the PHASE_E_BUILDINGS_ENABLED default/);
  assert.throws(() => phaseEFlagDefault(config('false') + config('false')), /2 schema declarations/);
  assert.throws(() => nonServicesBuildingKinds({ ...constants, PHASE_E_BUILDINGS: { types: [] } }, () => config('false')), /must list/);
});

test('a source without Phase E buildings exports every type and never reads its config', () => {
  // Older sources (before #125) must keep byte-identical packs: no omission, no manifest field.
  const legacy = { STRUCTURES: { keep: {}, mine: {} }, DEFENSES: { cannon: {} } };
  const result = nonServicesBuildingKinds(legacy, () => { throw new Error('must not run'); });
  assert.deepEqual(Object.keys(result.kinds), ['keep', 'mine', 'cannon']);
  assert.equal(result.omitted, undefined);
});

test('the bundled pack records its omission and its building catalogue carries none of the omitted types', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundled = path.join(root, 'app/src/main/assets/native');
  const manifest = JSON.parse(await readFile(path.join(bundled, 'manifest.json'), 'utf8'));
  const render = JSON.parse(await readFile(path.join(bundled, 'render-catalog.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8'));
  if (manifest.phaseEBuildings !== undefined) {
    assert.equal(manifest.phaseEBuildings, 'omitted');
    assert.ok(Array.isArray(manifest.phaseEOmittedTypes) && manifest.phaseEOmittedTypes.length > 0);
  }
  assert.deepEqual([lock.phaseEBuildings, lock.phaseEOmittedTypes], [manifest.phaseEBuildings, manifest.phaseEOmittedTypes],
    'the reviewed lock states the same omission as the bundled manifest');
  const omitted = new Set(manifest.phaseEOmittedTypes ?? []);
  assert.deepEqual(render.entries.filter(entry => omitted.has(entry.type)).map(entry => entry.type), []);
});
