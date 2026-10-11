import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildFleetCatalogue, assertSidecarsAgree, fleetGroupIds, FLEET_STARTER_GROUP, GATE_EFFECTS } from './fleet-catalog.mjs';

// The AUTHENTIC generated sidecars (byte-exact copies of the primary web test fixtures)
// wrapped in SYNTHETIC atlas envelopes: every expected cell laid out in a grid with
// fake PNG bytes and an inspectPng double. The parser doubles below mirror the OUTPUT
// shape of the canonical web parsers (fleetArt.ts / advancedFleetArt.ts) from the real
// tables; they never stand in for the parsers in the actual exporter and claim no art.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const starterSidecarText = await readFile(new URL('../test-fixtures/fleet-journeys/pe_fleet_starter.manifest.json', import.meta.url), 'utf8');
const advancedSidecarText = await readFile(new URL('../test-fixtures/fleet-journeys/pe_advanced_fleet.manifest.json', import.meta.url), 'utf8');
assert.equal(sha(starterSidecarText), '14b400ca96c252619e251aaf2e596430179788a9371a0a6c30d58f84834fe510', 'tracked starter sidecar is the authored one');
assert.equal(sha(advancedSidecarText), 'fde4e84867e56b09bdfc10feff287ae76f01644546a061e99fd3af85a2c19299', 'tracked advanced sidecar is the authored one');

const FAMILIES = ['survey_balloon', 'cargo_cutter', 'courier_airship', 'expedition_barge'];
/** Mirror of the shared `atlasGroupFor` rule for fleet keys (packages/shared/src/atlas.ts). */
const atlasGroupFor = key => {
  const advanced = /^(pe_veh_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_t[1-4])_(?:idle|docked|travel|exhausted)_f[1-9]\d*$/.exec(key)
    ?? /^(pe_berth_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge))_(?:intact|damaged|destroyed|ambient)_f[1-9]\d*$/.exec(key);
  if (advanced) return advanced[1];
  if (/^(?:pe_veh_starter_(?:idle|docked|travel)|pe_berth_starter_(?:intact|damaged|destroyed|ambient)|pe_fx_(?:departure|return)(?:_still)?)_f[1-9]\d*$/.test(key)) return FLEET_STARTER_GROUP;
  return 'ui';
};
const clipShape = (c, atlas) => ({ atlas, cellW: c.cellW, cellH: c.cellH, frames: c.frames.map(f => f.key), reducedMotionClip: c.reducedMotionClip ?? null });
const parseStarterFleetMetadata = (header, clips, tracks) => ({
  atlas: header.atlas, clips: Object.fromEntries(Object.entries(clips).map(([id, c]) => [id, clipShape(c, FLEET_STARTER_GROUP)])),
  geometry: { starter: header.geometry.starter, berth: header.geometry.berth }, dockTranslation: header.geometry.starter.dockOffsetPx,
  tracks: { ...tracks.families.starter, fps: tracks.fps }, sourceManifestSha256: header.sourceManifestSha256, sourceIndexSha256: header.sourceIndexSha256,
});
const parseAdvancedFleetMetadata = raw => ({
  clips: Object.fromEntries(Object.entries(raw.clips).map(([id, c]) => [id, clipShape(c, c.atlas)])),
  berths: new Map(FAMILIES.map(f => [f, { group: `pe_berth_${f}` }])),
  vehicles: new Map(FAMILIES.flatMap(f => [1, 2, 3, 4].map(t => [`${f}:${t}`, { group: `pe_veh_${f}_t${t}` }]))),
  tracks: new Map(FAMILIES.map(f => [f, raw.tracks.families[f.replaceAll('_', '-')]])),
  sourceManifestSha256: raw.sourceManifestSha256, sourceTracksSha256: raw.sourceTracksSha256, sourceIndexSha256: raw.sourceIndexSha256,
});

function envelope(cells) {
  // A grid at the largest cell pitch; every frame keeps ITS OWN authored cell size (the starter group mixes 112 and 64 cells).
  const keys = [...cells.keys()], cols = Math.max(1, Math.ceil(Math.sqrt(keys.length)));
  const pitchW = Math.max(...keys.map(k => cells.get(k).width)), pitchH = Math.max(...keys.map(k => cells.get(k).height)), rows = Math.ceil(keys.length / cols);
  return { size: { w: cols * pitchW, h: rows * pitchH }, frames: keys.map((filename, i) => { const { width: w, height: h } = cells.get(filename); return { filename, rotated: false, trimmed: false,
    sourceSize: { w, h }, spriteSourceSize: { x: 0, y: 0, w, h }, frame: { x: (i % cols) * pitchW, y: Math.floor(i / cols) * pitchH, w, h } }; }) };
}
function fixture() {
  const starterSidecar = JSON.parse(starterSidecarText), advancedSidecar = JSON.parse(advancedSidecarText);
  const { clips, tracks, ...header } = structuredClone(starterSidecar);
  const meta = { peStarterFleet: header, peClips: structuredClone(clips), peTracks: structuredClone(tracks), peAdvancedFleet: structuredClone(advancedSidecar), unrelatedLegacy: true };
  const cells = new Map();
  for (const [id, c] of Object.entries(starterSidecar.clips)) for (const f of c.frames) (cells.get(FLEET_STARTER_GROUP) ?? cells.set(FLEET_STARTER_GROUP, new Map()).get(FLEET_STARTER_GROUP)).set(f.key, { width: c.cellW, height: c.cellH });
  for (const c of Object.values(advancedSidecar.clips)) for (const f of c.frames) (cells.get(c.atlas) ?? cells.set(c.atlas, new Map()).get(c.atlas)).set(f.key, { width: c.cellW, height: c.cellH });
  const assets = new Map(), sizes = new Map();
  for (const [id, groupCells] of cells) {
    const texture = envelope(groupCells); sizes.set(id, texture.size);
    assets.set(`atlas/${id}@1x.json`, Buffer.from(JSON.stringify({ textures: [{ image: `${id}@1x.png`, format: 'RGBA8888', scale: 1, ...texture }] })));
    assets.set(`atlas/${id}@1x.png`, Buffer.from(`synthetic-owned-PNG:${id}`));
  }
  const inspectPng = async png => { const id = png.toString('utf8').split(':')[1]; const s = sizes.get(id); return { format: 'png', width: s.w, height: s.h, depth: 'uchar', hasAlpha: true }; };
  return { starterSidecar, advancedSidecar, meta, parseStarterFleetMetadata, parseAdvancedFleetMetadata, atlasGroupFor, assets, inspectPng, cells };
}
function editTexture(input, id, edit) {
  const path = `atlas/${id}@1x.json`, json = JSON.parse(input.assets.get(path)); edit(json.textures[0], json);
  input.assets.set(path, Buffer.from(JSON.stringify(json))); return input;
}
/** Edit the starter table in BOTH the sidecar and the generated meta (they must agree). */
function editStarter(input, edit) {
  edit(input.starterSidecar); const { clips, tracks, ...header } = structuredClone(input.starterSidecar);
  input.meta.peStarterFleet = header; input.meta.peClips = clips; input.meta.peTracks = tracks; return input;
}
function editAdvanced(input, edit) { edit(input.advancedSidecar); input.meta.peAdvancedFleet = structuredClone(input.advancedSidecar); return input; }

test('authentic sidecars carry 1 + 20 groups, 42 + 268 cells, the separate gate stills, and pin every optional file pair', async () => {
  const input = fixture(), result = await buildFleetCatalogue(input);
  assert.equal(result.version, 1);
  assert.deepEqual(result.metadata.peStarterFleet, JSON.parse(starterSidecarText), 'starter sidecar carried verbatim');
  assert.deepEqual(result.metadata.peAdvancedFleet, JSON.parse(advancedSidecarText), 'advanced sidecar carried verbatim');
  assert.notEqual(result.metadata.peStarterFleet, input.starterSidecar, 'metadata is an owned copy');
  assert.deepEqual(result.groups.map(g => g.id), fleetGroupIds());
  assert.equal(result.groups.length, 21);
  assert.equal([...input.cells.values()].reduce((n, m) => n + m.size, 0), 42 + 268);
  for (const group of result.groups) {
    const size = JSON.parse(input.assets.get(group.atlasPath)).textures[0].size;
    assert.equal(group.decodedBytes, size.w * size.h * 4);
    assert.deepEqual(group.files, [group.atlasPath, group.imagePath].map(path => ({ path, sha256: sha(input.assets.get(path)), size: input.assets.get(path).length })));
  }
  const starter = result.groups.find(g => g.id === FLEET_STARTER_GROUP);
  assert.deepEqual([starter.atlasPath, starter.imagePath], ['atlas/pe_fleet_starter@1x.json', 'atlas/pe_fleet_starter@1x.png']);
  for (const id of GATE_EFFECTS) {
    const clip = result.metadata.peStarterFleet.clips[id], still = result.metadata.peStarterFleet.clips[clip.reducedMotionClip];
    assert.equal(clip.frames.length, 8); assert.equal(still.frames.length, 1);
    assert.ok(!clip.frames.some(f => f.key === still.frames[0].key), 'the still is its own packed frame');
    assert.ok(!clip.frames.some(f => f.sha256 === still.frames[0].sha256), 'the still shares no normal frame digest');
  }
  assert.equal(result.metadata.peStarterFleet.clips.pe_fx_departure_still.frames[0].sha256, '766b4d791003f3b4b6ad2e0df1b3a74750d54858645c15688c4c86a9c2e98591');
  assert.equal(result.metadata.peStarterFleet.clips.pe_fx_return_still.frames[0].sha256, '9f792b40a70ab128ef9818bb993c4d23613d12eb53f654a79998954118fc4913');
});

test('sidecar/generated-metadata agreement is exact for the header, the fleet clips, the tracks and the advanced table', () => {
  assert.doesNotThrow(() => assertSidecarsAgree(fixture()));
  for (const [name, edit, pattern] of [
    ['a header field', input => { input.meta.peStarterFleet.bindingSha256 = 'f'.repeat(64); }, /bindingSha256 differs/],
    ['an extra sidecar key', input => { input.starterSidecar.extra = 1; }, /keys differ/],
    ['a missing sidecar key', input => { delete input.starterSidecar.awayComposition; }, /keys differ/],
    ['a clip', input => { input.meta.peClips.pe_veh_starter_docked.fps = 9; }, /clips differ/],
    ['the tracks', input => { input.meta.peTracks.families.starter.departure[3].opacity = 0.9; }, /tracks differ/],
    ['the advanced table', input => { input.meta.peAdvancedFleet.atlases.reverse(); }, /advanced sidecar differs/],
    ['a missing header', input => { delete input.meta.peStarterFleet; }, /peStarterFleet is missing/],
  ]) { const input = fixture(); edit(input); assert.throws(() => assertSidecarsAgree(input), pattern, name); }
});

test('an EMPTY canonical parse (either table) refuses before any file is read or inspected', async () => {
  for (const [name, edit] of [
    ['starter', input => { input.parseStarterFleetMetadata = () => ({ atlas: '', clips: {}, geometry: null, dockTranslation: [0, 0], tracks: null }); }],
    ['advanced', input => { input.parseAdvancedFleetMetadata = () => ({ clips: {}, berths: new Map(), vehicles: new Map(), tracks: new Map() }); }],
  ]) {
    const input = fixture(); let inspected = false; edit(input);
    input.inspectPng = async () => { inspected = true; throw new Error('should not decode'); };
    await assert.rejects(buildFleetCatalogue(input), /did not parse/, name); assert.equal(inspected, false);
  }
});

test('starter and advanced tables must share one authored source and state the dock translation twice in agreement', async () => {
  await assert.rejects(buildFleetCatalogue(editAdvanced(fixture(), a => { a.sourceManifestSha256 = '1'.repeat(64); })), /sourceManifestSha256 disagree/);
  await assert.rejects(buildFleetCatalogue(editAdvanced(fixture(), a => { a.sourceIndexSha256 = '2'.repeat(64); })), /sourceIndexSha256 disagree/);
  await assert.rejects(buildFleetCatalogue(editStarter(fixture(), s => { s.sourceTracksSha256 = '3'.repeat(64); })), /sourceTracksSha256 disagree/);
  await assert.rejects(buildFleetCatalogue(editStarter(fixture(), s => { s.geometry.starter.dockOffsetPx = [0, -26]; })), /dock translation/);
});

test('frame routing, duplicate cells and the 1 + 20 group closure are exact', async () => {
  const foreign = fixture(); foreign.atlasGroupFor = key => key === 'pe_veh_starter_docked_f2' ? 'pe_cosmetics' : atlasGroupFor(key);
  await assert.rejects(buildFleetCatalogue(foreign), /routes to another group/);
  const duplicate = fixture(); const inner = duplicate.parseStarterFleetMetadata;
  duplicate.parseStarterFleetMetadata = (...a) => { const t = inner(...a); t.clips.pe_veh_starter_travel.frames[7] = 'pe_veh_starter_travel_f1'; return t; };
  await assert.rejects(buildFleetCatalogue(duplicate), /duplicate cell/);
  const missing = fixture(); const innerA = missing.parseAdvancedFleetMetadata;
  missing.parseAdvancedFleetMetadata = raw => { const t = innerA(raw); for (const id of Object.keys(t.clips)) if (t.clips[id].atlas === 'pe_veh_cargo_cutter_t3') delete t.clips[id]; return t; };
  await assert.rejects(buildFleetCatalogue(missing), /group closure changed/);
  const mispacked = fixture(); const innerB = mispacked.parseAdvancedFleetMetadata;
  mispacked.parseAdvancedFleetMetadata = raw => { const t = innerB(raw); t.clips.pe_berth_cargo_cutter_intact.atlas = FLEET_STARTER_GROUP; return t; };
  await assert.rejects(buildFleetCatalogue(mispacked), /packed in the starter group/);
});

test('each gate effect needs its SEPARATE one-frame still: no still, a still that is a normal frame, or a duplicated digest refuse', async () => {
  await assert.rejects(buildFleetCatalogue(editStarter(fixture(), s => { delete s.clips.pe_fx_return.reducedMotionClip; })), /lacks its separate still/);
  // A still named after a normal frame can only ever be a second claim of that cell: the closure refuses it first.
  const member = fixture(); const inner = member.parseStarterFleetMetadata;
  member.parseStarterFleetMetadata = (...a) => { const t = inner(...a); t.clips.pe_fx_departure_still.frames = ['pe_fx_departure_f1']; return t; };
  await assert.rejects(buildFleetCatalogue(member), /duplicate cell/);
  await assert.rejects(buildFleetCatalogue(editStarter(fixture(), s => { s.clips.pe_fx_departure_still.frames[0].sha256 = s.clips.pe_fx_departure.frames[0].sha256; })), /duplicates a normal frame digest/);
});

for (const [name, edit] of [
  ['a missing pair', assets => assets.delete('atlas/pe_veh_survey_balloon_t2@1x.png')],
  ['an unselected group', assets => assets.set('atlas/pe_future@1x.png', Buffer.from('foreign'))],
  ['an escaped path', assets => { assets.set('../pe_fleet_starter@1x.png', assets.get('atlas/pe_fleet_starter@1x.png')); assets.delete('atlas/pe_fleet_starter@1x.png'); }],
]) test(`exact selected file closure refuses ${name}`, async () => {
  const input = fixture(); edit(input.assets); await assert.rejects(buildFleetCatalogue(input), /selected file closure/);
});

test('packed texture identity, geometry and PNG shape are checked for every group', async () => {
  await assert.rejects(buildFleetCatalogue(editTexture(fixture(), 'pe_fleet_starter', t => { t.frames.pop(); })), /texture header\/closure changed: pe_fleet_starter/);
  await assert.rejects(buildFleetCatalogue(editTexture(fixture(), 'pe_berth_expedition_barge', t => { t.frames[0].rotated = true; })), /cell identity\/geometry changed: pe_berth_expedition_barge/);
  await assert.rejects(buildFleetCatalogue(editTexture(fixture(), 'pe_veh_courier_airship_t4', t => { t.frames[1].frame.w = 64; })), /cell identity\/geometry changed/);
  await assert.rejects(buildFleetCatalogue(editTexture(fixture(), 'pe_fleet_starter', t => { t.frames[0].filename = 'pe_fx_departure_still_f2'; })), /cell identity\/geometry changed/);
  await assert.rejects(buildFleetCatalogue(editTexture(fixture(), 'pe_veh_cargo_cutter_t1', t => { t.format = 'RGB888'; })), /texture header\/closure changed/);
  await assert.rejects(buildFleetCatalogue(editTexture(fixture(), 'pe_veh_cargo_cutter_t1', (_, json) => { json.textures.push({}); })), /one texture required/);
  const png = fixture(); png.inspectPng = async () => ({ format: 'png', width: 1, height: 1, depth: 'uchar', hasAlpha: true });
  await assert.rejects(buildFleetCatalogue(png), /PNG shape changed/);
});

test('both sidecars and the generated tables are owned BEFORE validation: a caller mutating them during the first PNG inspection changes nothing validated or returned', async () => {
  const input = fixture(), inner = input.inspectPng; let first = true;
  input.inspectPng = async png => {
    if (first) { first = false;
      input.starterSidecar.tracks.families.starter.departure[3].opacity = 0.9; input.starterSidecar.clips.pe_fx_departure_still.frames[0].sha256 = 'f'.repeat(64);
      delete input.advancedSidecar.clips.pe_veh_cargo_cutter_t1_idle; input.advancedSidecar.atlases.length = 0;
      input.meta.peTracks.families.starter.departure[3].opacity = 0.9; input.meta.peAdvancedFleet.atlases.length = 0; }
    return inner(png);
  };
  const result = await buildFleetCatalogue(input);
  assert.deepEqual(result.metadata.peStarterFleet, JSON.parse(starterSidecarText), 'returned starter metadata is the validated original');
  assert.deepEqual(result.metadata.peAdvancedFleet, JSON.parse(advancedSidecarText), 'returned advanced metadata is the validated original');
  assert.equal(result.groups.length, 21);
  assert.notEqual(result.metadata.peStarterFleet, input.starterSidecar); assert.notEqual(result.metadata.peAdvancedFleet, input.advancedSidecar);
  // Mutating the returned metadata afterwards cannot reach the caller's objects either.
  result.metadata.peStarterFleet.atlas = 'x'; assert.equal(input.starterSidecar.atlas, 'pe_fleet_starter');
});

test('owned byte snapshots survive a caller mutation during asynchronous inspection', async () => {
  const input = fixture(), expected = sha(input.assets.get('atlas/pe_fleet_starter@1x.png')), inner = input.inspectPng;
  input.inspectPng = async png => { input.assets.get('atlas/pe_fleet_starter@1x.png').fill(0); return inner(png); };
  const result = await buildFleetCatalogue(input);
  assert.equal(result.groups.find(g => g.id === FLEET_STARTER_GROUP).files[1].sha256, expected);
});
