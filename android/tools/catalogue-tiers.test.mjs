import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteCatalogueReferences } from './pack.mjs';
import { assertServiceOptionalFiles } from './service-catalog.mjs';

test('service group pins stay optional while existing scene ground still becomes core', () => {
  const pins = ['json', 'png'].map(ext => ({ path: `atlas/pe_workshop_t1@1x.${ext}`, sha256: 'a'.repeat(64), size: 100 }));
  const phaseE = { version: 1, groups: [{ id: 'pe_workshop_t1', atlasPath: pins[0].path, imagePath: pins[1].path, files: pins }] };
  const files = [...pins.map(pin => ({ ...pin, tier: 'optional' })), { path: 'atlas/fantasy/ground/a.png', tier: 'optional' }];
  const catalogue = { phaseE, ground: { path: files[2].path } };
  assert.deepEqual(promoteCatalogueReferences(files, catalogue, ['terrain', 'walls5', 'builder', 'ground']), [files[2].path]);
  assert.doesNotThrow(() => assertServiceOptionalFiles(phaseE, files));
  // Adding the whole section to generic promotion silently bundles every
  // realm/tier, bypassing selected-group installation. The final guard refuses.
  promoteCatalogueReferences(files, catalogue, ['phaseE']);
  assert.throws(() => assertServiceOptionalFiles(phaseE, files), /optional file pin/);
});

test('current ground revision and its manifest stay bundled beside historical terrain', () => {
  const files = ['crownlands.png', 'manifest.json'].map(name => ({path:`atlas/fantasy/ground-v3/${name}`,tier:'optional'}));
  const ground = {revisions:[{visual:{realmId:'crownlands',artVersion:2,groundRevision:1},art:{manifestPath:files[1].path,sources:{crownlands:{path:files[0].path}}}}]};
  assert.deepEqual(promoteCatalogueReferences(files,{ground},['ground']),files.map(file=>file.path).sort());
  assert.ok(files.every(file=>file.tier==='core'),'installing core must include the current clearing before a scene selects it');
});

// The content store installs core-tier files only (ContentStore.kt), and the renderer reads
// realm paintings straight from the catalogue's ground section. A referenced painting left
// optional is silently absent on device: the legacy terrain stays and no test fails, which is
// exactly what happened with the contract-13 ground section before this rule existed.
test('atlas paths referenced by scene sections of the render catalogue become core', () => {
  const files = [
    { path: 'atlas/fantasy/ground-v2/crownlands.png', tier: 'optional' },
    { path: 'atlas/fantasy/ground/crownlands.png', tier: 'optional' },
    { path: 'atlas/fantasy/ground-v2/manifest.json', tier: 'optional' },
    { path: 'atlas/fantasy/globe/earth.png', tier: 'optional' },
    { path: 'atlas/fantasy/ground-v2/thornwake.png', tier: 'optional' },
    { path: 'atlas/bld@1x.png', tier: 'core' },
  ];
  const catalogue = {
    terrain: { atlasPath: 'atlas/bld@1x.png' },
    ground: { realms: { crownlands: { v1: 'atlas/fantasy/ground/crownlands.png', v2: { painting: 'atlas/fantasy/ground-v2/crownlands.png', manifest: 'atlas/fantasy/ground-v2/manifest.json' } } } },
    fantasy: { globe: { texture: 'atlas/fantasy/globe/earth.png' } },
  };
  const promoted = promoteCatalogueReferences(files, catalogue, ['terrain', 'walls5', 'builder', 'ground']);
  assert.deepEqual(promoted, ['atlas/fantasy/ground-v2/crownlands.png', 'atlas/fantasy/ground-v2/manifest.json', 'atlas/fantasy/ground/crownlands.png']);
  const tier = Object.fromEntries(files.map((file) => [file.path, file.tier]));
  assert.equal(tier['atlas/fantasy/ground-v2/crownlands.png'], 'core');
  assert.equal(tier['atlas/fantasy/ground/crownlands.png'], 'core');
  assert.equal(tier['atlas/fantasy/ground-v2/manifest.json'], 'core');
  // The globe is the documented exception until it renders on device: still optional.
  assert.equal(tier['atlas/fantasy/globe/earth.png'], 'optional');
  // An unreferenced painting is not promoted; already-core files are not reported twice.
  assert.equal(tier['atlas/fantasy/ground-v2/thornwake.png'], 'optional');
  assert.equal(promoteCatalogueReferences(files, catalogue, ['terrain', 'ground']).length, 0);
});
