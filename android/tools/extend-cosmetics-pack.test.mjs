import assert from 'node:assert/strict';
import test from 'node:test';
import { extendCatalogue, cosmeticConstants, COSMETICS_CONTRACT_VERSION } from './extend-cosmetics-pack.mjs';

const base = () => ({
  baseManifest: { schemaVersion: 1, sourceCommit: 'a'.repeat(40), simVersion: 18, rendererContractVersion: 15, contentVersion: 'b'.repeat(64), files: [] },
  baseRenderCatalogue: { schemaVersion: 1, rendererContractVersion: 15, phaseE: { version: 1, metadata: {}, groups: [{ id: 'pe_market_t1' }] }, entries: [] },
  cosmetics: { version: 1, metadata: { peCosmetics: { schemaVersion: 1 } }, groups: [{ id: 'pe_cosmetics' }], awnings: ['artisan_market_awning_t1'] },
  cosmeticsSource: 'c'.repeat(40),
  constants: cosmeticConstants(sourceConstants()),
});
const sourceConstants = () => ({
  PHASE_E_BOUND_COSMETICS: { currentRecipeVersion: 1, v1: { recipeVersion: 1, recipes: Object.fromEntries([1, 2, 3, 4].map(t => [`craft_artisan_market_awning_t${t}_v1`, { facility: 'market', facilityLevel: 5 * t - 4 }]).concat([['craft_aurora_wake_v1', { facility: 'lodge' }]])) } },
  PHASE_E_ORDINARY_CRAFTING: { v1: { maxConcurrentPerBase: 1, maxBatch: 10 } },
});

test('extension keeps every base section, bumps only the contract and adds one additive block with its own provenance', () => {
  const input = base(), result = extendCatalogue(input);
  assert.equal(result.rendererContractVersion, COSMETICS_CONTRACT_VERSION);
  assert.equal(COSMETICS_CONTRACT_VERSION, 16);
  assert.deepEqual(result.phaseE, input.baseRenderCatalogue.phaseE, 'the renderer15 service graph is untouched');
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.boundCosmetics, { ...input.cosmetics, constants: input.constants, sourceCommit: input.cosmeticsSource,
    basePack: { sourceCommit: 'a'.repeat(40), contentVersion: 'b'.repeat(64) } });
  assert.deepEqual(result.boundCosmetics.constants.queue, { maxConcurrentPerBase: 1, source: 'PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase' });
  assert.equal(result.boundCosmetics.constants.PHASE_E_BOUND_COSMETICS.v1.recipes.craft_artisan_market_awning_t3_v1.facilityLevel, 11);
  assert.equal(input.baseRenderCatalogue.rendererContractVersion, 15, 'input is not mutated');
});

for (const [name, edit] of [
  ['a non-15 base pack', input => { input.baseManifest.rendererContractVersion = 14; }],
  ['a catalogue/manifest contract disagreement', input => { input.baseRenderCatalogue.rendererContractVersion = 14; }],
  ['a base pack without a service graph', input => { delete input.baseRenderCatalogue.phaseE; }],
  ['a base pack that already carries cosmetics', input => { input.baseRenderCatalogue.boundCosmetics = {}; }],
  ['a service graph that already names pe_cosmetics', input => { input.baseRenderCatalogue.phaseE.groups.push({ id: 'pe_cosmetics' }); }],
  ['a short source commit', input => { input.cosmeticsSource = 'abc'; }],
  ['a missing constants slice', input => { delete input.constants; }],
]) test(`extension refuses ${name}`, () => { const input = base(); edit(input); assert.throws(() => extendCatalogue(input)); });

test('the constants slice is carried verbatim and refuses a source without the table or the queue limit', () => {
  const slice = cosmeticConstants(sourceConstants());
  assert.equal(slice.queue.maxConcurrentPerBase, 1);
  assert.throws(() => cosmeticConstants({ PHASE_E_ORDINARY_CRAFTING: { v1: { maxConcurrentPerBase: 1 } } }), /PHASE_E_BOUND_COSMETICS/);
  assert.throws(() => cosmeticConstants({ PHASE_E_BOUND_COSMETICS: sourceConstants().PHASE_E_BOUND_COSMETICS }), /maxConcurrentPerBase/);
  const lodge = sourceConstants(); lodge.PHASE_E_BOUND_COSMETICS.v1.recipes.craft_artisan_market_awning_t2_v1.facility = 'lodge';
  assert.throws(() => cosmeticConstants(lodge), /Market recipe/);
});
