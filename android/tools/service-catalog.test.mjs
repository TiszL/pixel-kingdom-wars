import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildServiceCatalogue, buildCosmeticCatalogue, cosmeticAwningOutputs, serviceBuildingEntry, assertServiceOptionalFiles } from './service-catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const types = ['workshop', 'lodge', 'market', 'harvester', 'berth'];
const constants = { PHASE_E_BUILDINGS: { types, visualTiers: 4 }, STRUCTURES: Object.fromEntries(types.map(type => [type, { maxLevel: 20, footprint: [2, 2] }])) };
const atlas = 'atlas/pe_workshop_t1@1x.json', image = 'atlas/pe_workshop_t1@1x.png';
// This small parsed-graph double isolates the export file/geometry boundary.
// The injected canonical parser owns the complete 49/138/1403 semantic graph;
// tests never substitute this double in the actual exporter or claim art proof.
function fixture() {
  const clip = { frames: [{ sourceIndex: 0, key: 'pe_workshop_t1_working_f1', sha256: 'a'.repeat(64), hashDomain: 'rgba-cell' }],
    playbackIndices: [0], fps: 8, loop: true, cellW: 112, cellH: 112, anchorPx: [56, 112], anchorKind: 'cellBottomPivotX' };
  const metadata = { peClips: { pe_workshop_t1_working: clip }, peAppearances: {
    'workshop-t1': { geometry: { cell: [112, 112] }, states: { idle: { kind: 'static', key: 'pe_workshop_t1_idle_f1' },
      working: { kind: 'clip', clip: 'pe_workshop_t1_working' }, destroyed: { kind: 'alias', target: { appearance: 'workshop-t1', state: 'idle' } } } } }, peEffects: {} };
  const texture = { image: 'pe_workshop_t1@1x.png', format: 'RGBA8888', size: { w: 224, h: 112 }, scale: 1,
    frames: ['working', 'idle'].map((state, i) => ({ filename: `pe_workshop_t1_${state}_f1`, rotated: false, trimmed: false,
      sourceSize: { w: 112, h: 112 }, spriteSourceSize: { x: 0, y: 0, w: 112, h: 112 }, frame: { x: i * 112, y: 0, w: 112, h: 112 } })) };
  const assets = new Map([[atlas, Buffer.from(JSON.stringify({ textures: [texture] }))], [image, Buffer.from('synthetic-owned-PNG')]]);
  return { meta: { ...metadata, unrelatedLegacy: true }, parsePhaseEArt: value => { assert.deepEqual(value, metadata); return structuredClone(metadata); },
    atlasGroupFor: () => 'pe_workshop_t1', isPhaseEServiceAtlasGroup: id => id === 'pe_workshop_t1', assets,
    inspectPng: async () => ({ format: 'png', width: 224, height: 112, depth: 'uchar', hasAlpha: true }), texture, metadata };
}
function editTexture(input, edit) {
  const json = JSON.parse(input.assets.get(atlas)); edit(json.textures[0], json);
  input.assets.set(atlas, Buffer.from(JSON.stringify(json))); return input;
}

test('candidate metadata preserves graph facts and pins two optional files with exact RGBA residency', async () => {
  const input = fixture(), result = await buildServiceCatalogue(input);
  assert.equal(result.version, 1); assert.deepEqual(result.metadata, input.metadata);
  assert.deepEqual(result.groups, [{ id: 'pe_workshop_t1', atlasPath: atlas, imagePath: image, decodedBytes: 224 * 112 * 4,
    files: [atlas, image].map(path => ({ path, sha256: sha(input.assets.get(path)), size: input.assets.get(path).length })) }]);
  assert.equal(result.metadata.peClips.pe_workshop_t1_working.reducedMotion, undefined, 'export cannot invent an unauthored still');
});

test('malformed/future graph refuses through the canonical parser before reading or inspecting files', async () => {
  const input = fixture(); let inspected = false;
  input.parsePhaseEArt = () => { throw new Error('canonical graph refusal'); };
  input.inspectPng = async () => { inspected = true; throw new Error('should not decode'); };
  await assert.rejects(buildServiceCatalogue(input), /canonical graph refusal/); assert.equal(inspected, false);
});

test('owned byte snapshot survives a caller mutation during asynchronous PNG inspection', async () => {
  const input = fixture(), expected = sha(input.assets.get(image));
  input.inspectPng = async () => { input.assets.get(image).fill(0); return { format: 'png', width: 224, height: 112, depth: 'uchar', hasAlpha: true }; };
  const result = await buildServiceCatalogue(input); assert.equal(result.groups[0].files[1].sha256, expected);
});

for (const [name, edit] of [
  ['missing pair', assets => assets.delete(image)],
  ['unselected group', assets => assets.set('atlas/pe_future@1x.png', Buffer.from('foreign'))],
  ['escaped path', assets => { assets.set('../pe_workshop_t1@1x.png', assets.get(image)); assets.delete(image); }],
]) test(`exact selected file closure refuses ${name}`, async () => {
  const input = fixture(); edit(input.assets); await assert.rejects(buildServiceCatalogue(input), /selected file closure/);
});

for (const [name, edit] of [
  ['multiple textures', (texture, json) => json.textures.push(texture)],
  ['escaped image', texture => { texture.image = '../pe_workshop_t1@1x.png'; }],
  ['future format', texture => { texture.format = 'RGB888'; }],
  ['scaled texture', texture => { texture.scale = 2; }],
  ['oversized texture', texture => { texture.size.w = 4097; }],
  ['fractional width', texture => { texture.size.w = 224.5; }],
  ['missing cell', texture => texture.frames.pop()],
  ['duplicate cell', texture => { texture.frames[1] = texture.frames[0]; }],
  ['foreign cell', texture => { texture.frames[0].filename = 'bld_workshop_l1'; }],
  ['rotation', texture => { texture.frames[0].rotated = true; }],
  ['trimming', texture => { texture.frames[0].trimmed = true; }],
  ['provider 80px fallback', texture => { texture.frames[0].sourceSize.w = 80; }],
  ['offset full cell', texture => { texture.frames[0].spriteSourceSize.y = 1; }],
  ['outside image', texture => { texture.frames[1].frame.x++; }],
  ['fractional crop', texture => { texture.frames[0].frame.x = .5; }],
]) test(`packed service geometry refuses ${name}`, async () => {
  await assert.rejects(buildServiceCatalogue(editTexture(fixture(), edit)), /Service catalogue/);
});

for (const [name, changes] of [['wrong dimensions', { width: 225 }], ['non-PNG', { format: 'webp' }],
  ['16bit source', { depth: 'ushort' }], ['missing alpha', { hasAlpha: false }], ['animated PNG', { pages: 2 }]]) {
  test(`PNG header admission refuses ${name}`, async () => {
    const input = fixture(); input.inspectPng = async () => ({ format: 'png', width: 224, height: 112, depth: 'uchar', hasAlpha: true, ...changes });
    await assert.rejects(buildServiceCatalogue(input), /PNG shape/);
  });
}

test('service entries carry canonical tier and footprint without default realm, family or legacy frame', () => {
  for (const type of types) for (let level = 1; level <= 20; level++) {
    const entry = serviceBuildingEntry(type, level, constants, level => Math.ceil(level / 5));
    assert.deepEqual(entry, { type, level, footprintWidth: 2, footprintHeight: 2, phaseE: { facility: type, tier: type === 'berth' ? null : Math.ceil(level / 5) } });
  }
  assert.equal(serviceBuildingEntry('keep', 1, constants, () => 1), null);
  for (const level of [0, 21, .5, NaN]) assert.throws(() => serviceBuildingEntry('workshop', level, constants, () => 1), /level\/footprint/);
  assert.throws(() => serviceBuildingEntry('workshop', 1, constants, () => 5), /tier/);
});

test('final optional guard refuses accidental all-core promotion, missing pins and changed bytes', async () => {
  const result = await buildServiceCatalogue(fixture()), files = result.groups[0].files.map(pin => ({ ...pin, tier: 'optional' }));
  assert.doesNotThrow(() => assertServiceOptionalFiles(result, files));
  for (const changed of [[{ ...files[0], tier: 'core' }, files[1]], [files[0]], [...files, files[0]],
    [{ ...files[0], size: files[0].size + 1 }, files[1]], [{ ...files[0], sha256: '0'.repeat(64) }, files[1]]]) {
    assert.throws(() => assertServiceOptionalFiles(result, changed), /optional file pin/);
  }
  // A `--phase-e-core` export checks the same pins at the core tier, and an optional copy fails it.
  const core = files.map(pin => ({ ...pin, tier: 'core' }));
  assert.doesNotThrow(() => assertServiceOptionalFiles(result, core, 'core'));
  assert.throws(() => assertServiceOptionalFiles(result, files, 'core'), /optional file pin/);
});

test('exporter keeps released contract15 and isolates explicit service candidate from legacy static consumers', async () => {
  const exporter = await readFile(new URL('./export-client-pack.mjs', import.meta.url), 'utf8');
  assert.match(exporter, /phaseEServices = args\.includes\('--phase-e-services'\)/);
  // N1 union (root-approved): contract 15 is the released baseline for every pack; the services flag only adds the phaseE section.
  assert.match(exporter, /^const RENDERER_CONTRACT_VERSION = 15;$/m);
  assert.match(exporter, /entries: legacyEntries/); assert.match(exporter, /hitStaticHeights\(legacyEntries,/);
  // Rewritten 2026-10-10: since af718476 (owner 2026-10-06, production art in the test build) an explicit
  // `--phase-e-core` export ships the service atlases core-tier, so the final guard verifies the tier the export chose.
  // It must still run on every services export, and core must stay opt-in behind the services flag.
  assert.match(exporter, /assertServiceOptionalFiles\(phaseE, files, phaseECore \? 'core' : 'optional'\)/);
  assert.match(exporter, /const phaseECore = phaseEServices && args\.includes\('--phase-e-core'\);/);
  assert.match(exporter, /promoteCatalogueReferences\(files, renderCatalogue, \['terrain', 'walls5', 'builder', 'ground'\]\)/);
});

test('N1-R1: an explicit services candidate selects every STRUCTURES + DEFENSES kind and records no omission; without the flag the released guarded helper omits the dark kinds', async () => {
  // Found by independent review of the N1 union: the exporter called nonServicesBuildingKinds unconditionally, so a
  // --phase-e-services candidate emitted a phaseE catalogue with NO service-building entries while its manifest still
  // said phaseEBuildings: 'omitted'. This evaluates the exporter's ACTUAL selection ternary and manifest spread,
  // extracted from its source, against a Phase E constants stub — no pack is generated and no source is loaded.
  const exporter = await readFile(new URL('./export-client-pack.mjs', import.meta.url), 'utf8');
  const selection = exporter.match(/^const buildingKinds = (phaseEServices\n\s+\? \{ kinds: \{ \.\.\.constants\.STRUCTURES, \.\.\.constants\.DEFENSES \} \}\n\s+: nonServicesBuildingKinds\(constants,\n\s+\(\) => execFileSync\('git', \['-C', source, 'show', `\$\{sourceCommit\}:\$\{PHASE_E_FLAG_SCHEMA\}`\], \{ encoding: 'utf8' \}\)\));$/m);
  assert.ok(selection, 'the selection is the flag ternary: full set for services, the released guarded helper otherwise');
  const spread = exporter.match(/\.\.\.\((buildingKinds\.omitted \? \{ phaseEBuildings: 'omitted', phaseEOmittedTypes: buildingKinds\.omitted \} : \{\})\)/);
  assert.ok(spread, 'the manifest marker is emitted only from an omitted list');
  const { nonServicesBuildingKinds: released } = await import('./phase-e-buildings.mjs');
  const DARK = ['workshop', 'lodge', 'market', 'harvester', 'berth'];
  const constants = { STRUCTURES: Object.fromEntries(['keep', 'mine', ...DARK].map(type => [type, {}])), DEFENSES: { cannon: {} }, PHASE_E_BUILDINGS: { types: DARK } };
  const darkConfig = "const schema = z.object({\n  PHASE_E_BUILDINGS_ENABLED: z.enum(['true', 'false']).default('false'),\n});\n";
  const select = (phaseEServices) => new Function('phaseEServices', 'constants', 'nonServicesBuildingKinds', 'execFileSync', 'source', 'sourceCommit', 'PHASE_E_FLAG_SCHEMA',
    `return ${selection[1]};`)(phaseEServices, constants, released, () => darkConfig, '/src', 'deadbeef', 'apps/api/src/config.ts');
  const marker = (buildingKinds) => new Function('buildingKinds', `return ({ ${spread[0]} });`)(buildingKinds);
  const services = select(true);
  assert.deepEqual(Object.keys(services.kinds), ['keep', 'mine', ...DARK, 'cannon'], 'the services candidate keeps every Phase E kind for serviceBuildingEntry');
  assert.equal(services.omitted, undefined);
  assert.deepEqual(marker(services), {}, 'a services candidate manifest carries no omitted marker');
  const plain = select(false);
  assert.deepEqual(Object.keys(plain.kinds), ['keep', 'mine', 'cannon'], 'without the flag the released guarded helper omits the dark kinds');
  assert.deepEqual(plain.omitted, DARK);
  assert.deepEqual(marker(plain), { phaseEBuildings: 'omitted', phaseEOmittedTypes: DARK });
});


// ---- Contract 16 bound-cosmetics extension ----------------------------------
const cosmeticAtlas = 'atlas/pe_cosmetics@1x.json', cosmeticImage = 'atlas/pe_cosmetics@1x.png';
const hex = c => c.repeat(64);
/** A closed synthetic peCosmetics table: four tiers × seven states (ready aliases idle), the
 * craft-success overlay and the wake cells the packed group physically carries. */
function cosmeticFixture() {
  const clips = {};
  const frames = (base, count, sha) => Array.from({ length: count }, (_, i) => ({ sourceIndex: i, key: `${base}_f${i + 1}`, rgbaSha256: hex(sha) }));
  const cell = { cellW: 112, cellH: 112, anchorPx: [56, 112], anchorKind: 'cellBottomPivotX', sourcePivot: [56, 104], footprint: [2, 2] };
  for (const tier of [1, 2, 3, 4]) {
    const p = `pe_cos_market_t${tier}`;
    clips[`${p}_idle`] = { sourcePath: `c/${tier}-idle.png`, sourceSha256: hex('1'), ...cell, fps: 0, loop: false, reducedMotionFrame: 0, frames: frames(`${p}_idle`, 1, 'a') };
    clips[`${p}_damaged`] = { sourcePath: `c/${tier}-damaged.png`, sourceSha256: hex('2'), ...cell, fps: 0, loop: false, reducedMotionFrame: 0, frames: frames(`${p}_damaged`, 1, 'b') };
    clips[`${p}_destroyed`] = { sourcePath: `w/${tier}-rubble.png`, sourceSha256: hex('3'), ...cell, fps: 0, loop: false, reducedMotionFrame: 0, frames: frames(`${p}_destroyed`, 1, 'c') };
    clips[`${p}_working`] = { sourcePath: `c/${tier}-working.png`, sourceSha256: hex('4'), ...cell, fps: 8, loop: true, reducedMotionFrame: 0, frames: frames(`${p}_working`, 8, 'd') };
    clips[`${p}_construction`] = { sourcePath: `c/${tier}-construction.png`, sourceSha256: hex('5'), ...cell, fps: 8, loop: false, reducedMotionFrame: 0, frames: frames(`${p}_construction`, 9, 'e') };
    clips[`${p}_collapse`] = { sourcePath: `c/${tier}-collapse.png`, sourceSha256: hex('6'), ...cell, fps: 8, loop: false, reducedMotionFrame: 0, frames: frames(`${p}_collapse`, 9, 'f') };
    clips[`${p}_ready`] = { sourcePath: `c/${tier}-idle.png`, sourceSha256: hex('1'), ...cell, fps: 0, loop: false, reducedMotionFrame: 0, frames: frames(`${p}_idle`, 1, 'a'), alias: `${p}_idle`, overlay: { clip: 'pe_cos_ready_fx', offset: [24, 0] } };
  }
  clips.pe_cos_ready_fx = { sourcePath: 'fx/craft-success.png', sourceSha256: hex('7'), cellW: 64, cellH: 64, anchorPx: [32, 32], anchorKind: 'centre', fps: 8, loop: false, reducedMotionFrame: 0, frames: frames('pe_cos_ready_fx', 8, '0') };
  clips.pe_cos_wake = { sourcePath: 'c/aurora-wake.png', sourceSha256: hex('8'), cellW: 64, cellH: 64, anchorPx: [32, 32], anchorKind: 'centre', fps: 8, loop: true, reducedMotionFrame: 0, frames: frames('pe_cos_wake', 8, '9') };
  const manifest = hex('a'), index = hex('b');
  const bindings = Object.fromEntries([...cosmeticAwningOutputs, 'aurora_wake'].map((outputId, i) => [outputId, { sha256: hex(String(i + 1)), value: {
    version: 1, outputId, sourceId: outputId === 'aurora_wake' ? 'auroraWake' : `artisan-market-t${i + 1}`, sourceManifestSha256: manifest, sourceIndexSha256: index, sourceScale: 1,
    clips: outputId === 'aurora_wake' ? [{ id: 'pe_cos_wake' }] : ['idle', 'damaged', 'destroyed', 'working', 'construction', 'collapse', 'ready'].map(state => ({ id: `pe_cos_market_t${i + 1}_${state}` })) } }]));
  const table = { schemaVersion: 1, atlas: 'pe_cosmetics', sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1, sourceManifestSha256: manifest, indexSha256: index, provenanceSha256: hex('c'), clips, bindings };
  const cells = Object.values(clips).filter(clip => clip.alias === undefined).flatMap(clip => clip.frames.map(f => [f.key, clip.cellW, clip.cellH]));
  // 132 cells: 4 × (1+1+1+8+9+9) = 116 + 8 + 8, laid out on a 36-slot grid of 112 px cells (36 × 112 = 4032 ≤ 4096).
  const texture = { image: 'pe_cosmetics@1x.png', format: 'RGBA8888', size: { w: 4032, h: 448 }, scale: 1,
    frames: cells.map(([filename, w, h], i) => ({ filename, rotated: false, trimmed: false, sourceSize: { w, h }, spriteSourceSize: { x: 0, y: 0, w, h },
      frame: { x: (i % 36) * 112, y: Math.floor(i / 36) * 112, w, h } })) };
  const assets = new Map([[cosmeticAtlas, Buffer.from(JSON.stringify({ textures: [texture] }))], [cosmeticImage, Buffer.from('synthetic-owned-cosmetic-PNG')]]);
  return { meta: { peCosmetics: table, peMarket: { unrelated: true } }, atlasGroupFor: key => (key.startsWith('pe_cos_') ? 'pe_cosmetics' : 'other'), assets,
    inspectPng: async () => ({ format: 'png', width: 4032, height: 448, depth: 'uchar', hasAlpha: true }), table, texture };
}

test('cosmetics extension carries the generated table verbatim, pins the one packed group and names the four Awnings only', async () => {
  const input = cosmeticFixture(), result = await buildCosmeticCatalogue(input);
  assert.equal(result.version, 1); assert.deepEqual(result.metadata, { peCosmetics: input.table });
  assert.notEqual(result.metadata.peCosmetics, input.table, 'the exported table is an owned copy');
  assert.deepEqual(result.awnings, cosmeticAwningOutputs);
  assert.deepEqual(result.groups, [{ id: 'pe_cosmetics', atlasPath: cosmeticAtlas, imagePath: cosmeticImage, decodedBytes: 4032 * 448 * 4,
    files: [cosmeticAtlas, cosmeticImage].map(path => ({ path, sha256: sha(input.assets.get(path)), size: input.assets.get(path).length })) }]);
  assert.equal(Object.keys(result.metadata.peCosmetics.clips).length, 30);
  assert.equal(input.texture.frames.length, 132, 'every packed cell is claimed exactly once, aliases claim none');
});

for (const [name, edit] of [
  ['a foreign clip id', table => { table.clips.pe_market_t1_idle = table.clips.pe_cos_market_t1_idle; }],
  ['zero-based frame keys', table => { table.clips.pe_cos_market_t1_working.frames.forEach((f, i) => { f.key = `pe_cos_market_t1_working_f${i}`; }); }],
  ['an alias whose cells differ', table => { table.clips.pe_cos_market_t1_ready.alias = 'pe_cos_market_t1_damaged'; }],
  ['an overlay naming an unpacked clip', table => { table.clips.pe_cos_market_t1_ready.overlay.clip = 'pe_cos_missing'; }],
  ['a binding with a foreign source manifest hash', table => { table.bindings.artisan_market_awning_t2.value.sourceManifestSha256 = hex('f'); }],
  ['a binding digest that is not hex', table => { table.bindings.artisan_market_awning_t3.sha256 = 'nope'; }],
  ['a binding naming an unpacked clip', table => { table.bindings.artisan_market_awning_t4.value.clips.push({ id: 'pe_cos_market_t4_ghost' }); }],
  ['a missing Awning tier state', table => { delete table.clips.pe_cos_market_t2_collapse; }],
  ['an extra binding output', table => { table.bindings.extra = table.bindings.artisan_market_awning_t1; }],
  ['a reduced-motion frame past the clip', table => { table.clips.pe_cos_market_t1_working.reducedMotionFrame = 8; }],
  ['a non-digest cell hash', table => { table.clips.pe_cos_market_t1_idle.frames[0].rgbaSha256 = 'x'; }],
]) test(`cosmetics extension refuses ${name} before reading files`, async () => {
  const input = cosmeticFixture(); edit(input.meta.peCosmetics); let inspected = false;
  input.inspectPng = async () => { inspected = true; return { format: 'png', width: 4032, height: 448, depth: 'uchar', hasAlpha: true }; };
  await assert.rejects(buildCosmeticCatalogue(input), /Service catalogue/); assert.equal(inspected, false);
});

test('cosmetics extension binds the exact packed closure: a missing, extra, moved or resized cell refuses', async () => {
  const cases = [
    texture => texture.frames.pop(),
    texture => texture.frames.push({ ...texture.frames[0], filename: 'pe_cos_market_t9_idle_f1' }),
    texture => { texture.frames[0].frame.w = 111; },
    texture => { texture.frames[1].frame.x = texture.frames[0].frame.x; texture.frames[1].filename = texture.frames[0].filename; },
    texture => { texture.frames[0].trimmed = true; },
  ];
  for (const edit of cases) {
    const input = cosmeticFixture(); const json = JSON.parse(input.assets.get(cosmeticAtlas)); edit(json.textures[0]);
    input.assets.set(cosmeticAtlas, Buffer.from(JSON.stringify(json)));
    await assert.rejects(buildCosmeticCatalogue(input), /Service catalogue/);
  }
  const extra = cosmeticFixture(); extra.assets.set('atlas/pe_market_t1@1x.png', Buffer.from('foreign'));
  await assert.rejects(buildCosmeticCatalogue(extra), /selected file closure/);
});

test('cosmetics extension owns its byte snapshot across asynchronous PNG inspection', async () => {
  const input = cosmeticFixture(), expected = sha(input.assets.get(cosmeticImage));
  input.inspectPng = async () => { input.assets.get(cosmeticImage).fill(0); return { format: 'png', width: 4032, height: 448, depth: 'uchar', hasAlpha: true }; };
  const result = await buildCosmeticCatalogue(input); assert.equal(result.groups[0].files[1].sha256, expected);
});
