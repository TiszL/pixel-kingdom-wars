import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extendFleetCatalogue, refuseExistingOutput, claimStage, withinStage, FLEET_CONTRACT_VERSION } from './extend-fleet-pack.mjs';
import { COSMETICS_CONTRACT_VERSION } from './extend-cosmetics-pack.mjs';
import { fleetGroupIds } from './fleet-catalog.mjs';

const provenance = { sourceManifestSha256: 'c'.repeat(64), sourceIndexSha256: 'd'.repeat(64), sourceTracksSha256: 'e'.repeat(64) };
const base = () => ({
  baseManifest: { schemaVersion: 1, sourceCommit: 'a'.repeat(40), simVersion: 18, rendererContractVersion: 16, contentVersion: 'b'.repeat(64), files: [] },
  baseRenderCatalogue: { schemaVersion: 1, rendererContractVersion: 16, entries: [],
    phaseE: { version: 1, metadata: {}, groups: [{ id: 'pe_market_t1' }, { id: 'pe_fleet_berths' }] },
    boundCosmetics: { version: 1, metadata: { peCosmetics: { schemaVersion: 1 } }, groups: [{ id: 'pe_cosmetics' }], awnings: ['artisan_market_awning_t1'], sourceCommit: 'f'.repeat(40) } },
  fleet: { version: 1, metadata: { peStarterFleet: { schemaVersion: 1, atlas: 'pe_fleet_starter', ...provenance }, peAdvancedFleet: { schemaVersion: 1, ...provenance } },
    groups: fleetGroupIds().map(id => ({ id, atlasPath: `atlas/${id}@1x.json`, imagePath: `atlas/${id}@1x.png`, decodedBytes: 4, files: [] })) },
  fleetSource: '1'.repeat(40),
});

test('extension keeps every renderer16 section (service graph AND bound cosmetics), bumps only the contract and adds ONE additive block with its own provenance', () => {
  const input = base(), result = extendFleetCatalogue(input);
  assert.equal(FLEET_CONTRACT_VERSION, 17); assert.equal(COSMETICS_CONTRACT_VERSION, 16);
  assert.equal(result.rendererContractVersion, FLEET_CONTRACT_VERSION);
  assert.deepEqual(result.phaseE, input.baseRenderCatalogue.phaseE, 'the renderer15 service graph is untouched');
  assert.deepEqual(result.boundCosmetics, input.baseRenderCatalogue.boundCosmetics, 'the renderer16 bound cosmetics are untouched');
  assert.deepEqual(result.entries, []); assert.equal(result.schemaVersion, 1);
  assert.deepEqual(Object.keys(result).sort(), ['boundCosmetics', 'entries', 'fleetJourneys', 'phaseE', 'rendererContractVersion', 'schemaVersion']);
  assert.deepEqual(result.fleetJourneys, { ...input.fleet, sourceCommit: input.fleetSource, basePack: { sourceCommit: 'a'.repeat(40), contentVersion: 'b'.repeat(64) } });
  assert.equal(result.fleetJourneys.groups.length, 21);
  assert.equal(input.baseRenderCatalogue.rendererContractVersion, 16, 'input is not mutated');
  assert.equal('fleetJourneys' in input.baseRenderCatalogue, false);
});

for (const [name, edit, pattern] of [
  ['a renderer15 base pack', input => { input.baseManifest.rendererContractVersion = 15; }, /renderer16/],
  ['a renderer17 base pack', input => { input.baseManifest.rendererContractVersion = 17; input.baseRenderCatalogue.rendererContractVersion = 17; }, /renderer16/],
  ['a catalogue/manifest contract disagreement', input => { input.baseRenderCatalogue.rendererContractVersion = 15; }, /renderer16/],
  ['a base pack without a service graph', input => { delete input.baseRenderCatalogue.phaseE; }, /service graph/],
  ['a base pack without bound cosmetics', input => { delete input.baseRenderCatalogue.boundCosmetics; }, /bound cosmetics/],
  ['a base pack that already carries fleet journeys', input => { input.baseRenderCatalogue.fleetJourneys = {}; }, /already carries fleet journeys/],
  ['a service graph that already names a fleet group', input => { input.baseRenderCatalogue.phaseE.groups.push({ id: 'pe_fleet_starter' }); }, /already names group pe_fleet_starter/],
  ['a cosmetics block that already names a fleet group', input => { input.baseRenderCatalogue.boundCosmetics.groups.push({ id: 'pe_veh_cargo_cutter_t2' }); }, /already names group pe_veh_cargo_cutter_t2/],
  ['a missing fleet group', input => { input.fleet.groups.pop(); }, /exactly the 1 \+ 20/],
  ['an extra fleet group', input => { input.fleet.groups.push({ id: 'pe_fx' }); }, /exactly the 1 \+ 20/],
  ['a duplicated fleet group', input => { input.fleet.groups[0] = input.fleet.groups[1]; }, /exactly the 1 \+ 20/],
  ['a fleet catalogue of another version', input => { input.fleet.version = 2; }, /Fleet catalogue is required/],
  ['a fleet catalogue without the advanced sidecar', input => { delete input.fleet.metadata.peAdvancedFleet; }, /Fleet catalogue is required/],
  ['starter/advanced tables from different sources', input => { input.fleet.metadata.peAdvancedFleet.sourceManifestSha256 = '9'.repeat(64); }, /different sources/],
  ['a short source commit', input => { input.fleetSource = 'abc'; }, /full SHA/],
]) test(`extension refuses ${name}`, () => { const input = base(); edit(input); assert.throws(() => extendFleetCatalogue(input), pattern); });

// ---- Staging/output guards against TEMPORARY fixtures (the pack CLI itself is not run) ----
async function sandbox(run) { const root = await mkdtemp(path.join(os.tmpdir(), 'pkw-fleet-guard-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }

test('the output guard refuses ANY existing entry — an empty directory, a file, a symlink, a dangling symlink — and leaves it untouched', () => sandbox(async root => {
  await refuseExistingOutput(path.join(root, 'absent'));
  const empty = path.join(root, 'empty'); await mkdir(empty);
  await assert.rejects(refuseExistingOutput(empty), /already exists/); assert.deepEqual(await readdir(empty), []);
  const file = path.join(root, 'file'); await writeFile(file, 'keep');
  await assert.rejects(refuseExistingOutput(file), /already exists/); assert.equal(await readFile(file, 'utf8'), 'keep');
  const link = path.join(root, 'link'); await symlink(empty, link);
  await assert.rejects(refuseExistingOutput(link), /already exists/); assert.ok((await lstat(link)).isSymbolicLink());
  const dangling = path.join(root, 'dangling'); await symlink(path.join(root, 'nowhere'), dangling);
  await assert.rejects(refuseExistingOutput(dangling), /already exists/); assert.ok((await lstat(dangling)).isSymbolicLink());
}));

test('staging is a FRESH exclusively owned sibling: a pre-existing stage directory or stage symlink is never reused, entered or touched', () => sandbox(async root => {
  const output = path.join(root, 'packs', 'candidate-x');
  const stale = `${output}.stage-stale`; await mkdir(stale, { recursive: true }); await writeFile(path.join(stale, 'unrelated.txt'), 'theirs');
  const elsewhere = path.join(root, 'elsewhere'); await mkdir(elsewhere); await writeFile(path.join(elsewhere, 'pack.txt'), 'other pack');
  const aliased = `${output}.stage-link`; await symlink(elsewhere, aliased);
  const first = await claimStage(output), second = await claimStage(output);
  assert.notEqual(first, second); assert.notEqual(first, stale); assert.notEqual(first, aliased);
  assert.ok(first.startsWith(`${output}.stage-`)); assert.ok((await lstat(first)).isDirectory()); assert.ok(!(await lstat(first)).isSymbolicLink());
  assert.deepEqual(await readdir(first), [], 'freshly created, empty');
  assert.equal(await readFile(path.join(stale, 'unrelated.txt'), 'utf8'), 'theirs', 'the stale stage is untouched');
  assert.equal(await readFile(path.join(elsewhere, 'pack.txt'), 'utf8'), 'other pack', 'the aliased directory is untouched');
  assert.ok((await lstat(aliased)).isSymbolicLink());
}));

test('staged paths stay confined to the owned stage', () => sandbox(async root => {
  const stage = await claimStage(path.join(root, 'out'));
  assert.equal(withinStage(stage, 'atlas/pe_fleet_starter@1x.json'), path.join(stage, 'atlas', 'pe_fleet_starter@1x.json'));
  for (const bad of ['../escape.json', 'atlas/../../escape.json', '/etc/passwd', '', undefined]) assert.throws(() => withinStage(stage, bad), /escapes the staging directory/);
}));
