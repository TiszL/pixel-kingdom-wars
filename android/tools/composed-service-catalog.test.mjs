// Synthetic hashes exercise metadata wiring, NOT generated-art/pixel/provenance acceptance.
// Fixture shapes: r3 a1197d0a rasterize.ts and phase-e-*-pack.ts snapshots; consumer: native 6416be26.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { composeServiceMetadata } from './service-catalog.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const seq = count => Array.from({ length: count }, (_, i) => i);
const realms = ['frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach', 'stormcairn', 'thornwake', 'cinderfall'];
const fleets = ['starter', 'survey-balloon', 'cargo-cutter', 'courier-airship', 'expedition-barge'];
const states = ['idle', 'working', 'damaged', 'ready', 'destroyed', 'construction', 'collapse'];
const rm = { path: 'production-assets/shared-fx/craft-success/frames/frame-00.png', sha256: hash('synthetic encoded RM PNG'), bytes: 1723 };
const identity = { schemaVersion: 1, sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1 };
const pins = { sourceManifestSha256: hash('manifest'), indexSha256: hash('index'), provenanceSha256: hash('provenance') };
const berthGeometry = family => ({ cell: [112, 112], horizontalPivot: 56, sourceCellBottom: 112, drawScale: 1,
  footprint: [2, 2], groundContact: [56, 93], attachment: ['survey-balloon', 'courier-airship'].includes(family) ? [56, 56] : [56, 78],
  tidalGate: ['survey-balloon', 'courier-airship'].includes(family) ? null : [56, 28] });
function sourceClip(id, count, { fx = false, loop = false, grid = false, starter = false } = {}) {
  const size = fx ? 64 : 112;
  return { sourcePath: `synthetic-source/${id}.png`, sourceSha256: hash(`encoded:${id}`), cellW: size, cellH: size,
    anchorPx: [size / 2, size], anchorKind: 'cellBottomPivotX', ...(fx ? { anchorPx: [32, 32], anchorKind: 'centre' } : { sourcePivot: [56, 104], footprint: [2, 2] }),
    fps: count === 1 ? 0 : 8, loop,
    ...(grid ? { sourceMetadataPath: `synthetic-source/${id}.json`, sourceMetadataSha256: hash(`grid:${id}`), playbackFrameIndices: seq(loop ? 8 : count) } : {}),
    frames: seq(count).map(i => ({ sourceIndex: i, key: `${id}_f${i + 1}`, [starter ? 'sha256' : 'rgbaSha256']: hash(`rgba:${id}:${i}`),
      ...(!starter ? { sourceRect: { x: grid ? 2 + i % 3 * 114 : i * size, y: grid ? 2 + Math.floor(i / 3) * 114 : 0, w: size, h: size } } : {}) })) };
}
function serviceFamily(section, prefix, family, tier, realm) {
  const clips = section.clips, grid = family === 'workshop' || family === 'harvester';
  section.atlases.push(prefix);
  for (const state of states) {
    const moving = ['working', 'construction', 'collapse'].includes(state);
    const count = moving ? (state === 'working' && !grid ? 8 : 9) : 1;
    const clip = sourceClip(`${prefix}_${state}`, count, { grid: moving && grid, loop: state === 'working' });
    if (family === 'market') { clip.reducedMotionFrame = 0; for (const f of clip.frames) delete f.sourceRect; }
    if (family === 'harvester') { clip.holdLastFrame = !clip.loop; clip.playbackFrameIndices = seq(clip.loop ? 8 : count); }
    clips[`${prefix}_${state}`] = clip;
  }
  const idle = clips[`${prefix}_idle`].frames[0].rgbaSha256;
  if (grid) {
    const workingStill = family === 'workshop' ? hash(`${prefix}:working-static`) : idle;
    for (const i of [0, 8]) clips[`${prefix}_working`].frames[i].rgbaSha256 = workingStill;
  }
  clips[`${prefix}_construction`].frames[8].rgbaSha256 = idle;
  clips[`${prefix}_collapse`].frames[0].rgbaSha256 = clips[`${prefix}_damaged`].frames[0].rgbaSha256;
  const destroyed = family === 'harvester' ? hash(`destroyed:${realm}:${tier}`) : hash(`shared-rubble:${tier}`);
  clips[`${prefix}_destroyed`].frames[0].rgbaSha256 = destroyed;
  clips[`${prefix}_collapse`].frames[8].rgbaSha256 = destroyed;
  if (family !== 'harvester') {
    const fx = sourceClip(`${prefix}_ready_fx`, 8, { fx: true });
    fx.frames.forEach((frame, i) => { frame.rgbaSha256 = hash(`shared-craft-success:${i}`); });
    if (family === 'market') { fx.reducedMotionFrame = 0; for (const frame of fx.frames) delete frame.sourceRect; }
    clips[`${prefix}_ready_fx`] = fx;
  }
  if (family === 'lodge' || family === 'market') clips[`${prefix}_ready`] = {
    ...structuredClone(clips[`${prefix}_idle`]), alias: `${prefix}_idle`, overlay: { clip: `${prefix}_ready_fx`, offset: [24, 0] } };
  if (section.bindings) {
    const value = { version: 1, family, tier, atlas: prefix, sourceScale: 1, sourceManifestSha256: hash('manifest'), sourceIndexSha256: hash('index'),
      ...(realm ? { id: `${realm}-t${tier}`, sourceId: realm, displayName: realm, sourceProvenanceSha256: hash('provenance'),
        aliases: { rubble: `${prefix}_destroyed` }, scaffold: { sourcePath: 'synthetic-source/scaffold.png', sourceSha256: hash('scaffold-file'), rgbaSha256: clips[`${prefix}_construction`].frames[0].rgbaSha256 },
        readyComposition: { alreadyComposed: true, fxId: 'craft-success', sourceOffsetPx: [24, -12] } } : {}),
      clips: Object.entries(clips).filter(([id]) => id.startsWith(`${prefix}_`)).map(([id, clip]) => ({ id, ...clip })) };
    section.bindings[prefix] = { sha256: hash(JSON.stringify(value)), value };
  }
}
function fixture() {
  const meta = {
    peServiceBuildings: { ...identity, families: ['workshop', 'lodge'], atlases: [], ...pins,
      sourceManifestSha256: { workshop: hash('workshop-manifest'), services: hash('services-manifest') }, provenanceSha256: { workshop: hash('workshop-provenance'), lodge: hash('lodge-provenance') }, clips: {}, bindings: {} },
    peMarket: { ...identity, family: 'market', ...pins, atlases: [], clips: {} },
    peHarvesters: { ...identity, family: 'harvester', ...pins, runtimeReady: true, runtimeApproval: 'D153.302-tester', sourceStatus: 'synthetic fixture', atlases: [], clips: {}, bindings: {} },
    peClips: {}, peTracks: { schemaVersion: 1, timingUnit: 'milliseconds', fps: 8, generatedMotionRequired: true, families: { starter: syntheticTrack() } },
    peStarterFleet: { ...identity, atlas: 'pe_fleet_starter', sourceManifestSha256: hash('starter-manifest'), sourceTracksSha256: hash('starter-tracks'), sourceFxManifestSha256: hash('fx-manifest'),
      sourceIndexSha256: hash('starter-index'), provenanceSha256: hash('starter-provenance'), fxProvenanceSha256: hash('fx-provenance'), bindingSha256: '', geometry: {
        starter: { cell: [112, 112], horizontalPivot: 56, sourceCellBottom: 112, contactPx: [56, 105], dockOffsetPx: [0, -27], berthRef: 'starter-berth', drawScale: 1 },
        berth: berthGeometry('starter') }, awayComposition: 'intact + ambient; no vehicle' },
    peAdvancedFleet: { ...identity, atlases: [], sourceManifestSha256: hash('advanced-manifest'), sourceTracksSha256: hash('advanced-tracks'), sourceIndexSha256: hash('advanced-index'), provenanceSha256: hash('advanced-provenance'), clips: {}, bindings: {} },
  };
  for (let tier = 1; tier <= 4; tier++) {
    for (const family of ['workshop', 'lodge', 'market']) serviceFamily(family === 'market' ? meta.peMarket : meta.peServiceBuildings, `pe_${family}_t${tier}`, family, tier);
    for (const realm of realms) serviceFamily(meta.peHarvesters, `pe_harvester_${realm.replaceAll('-', '_')}_t${tier}`, 'harvester', tier, realm);
  }
  for (const family of fleets) {
    const starter = family === 'starter', atlas = starter ? 'pe_fleet_starter' : `pe_berth_${family.replaceAll('-', '_')}`;
    const prefix = `pe_berth_${family.replaceAll('-', '_')}`, clips = starter ? meta.peClips : meta.peAdvancedFleet.clips, geometry = berthGeometry(family);
    for (const state of ['intact', 'damaged', 'destroyed', 'ambient']) {
      const clip = sourceClip(`${prefix}_${state}`, state === 'ambient' ? 8 : 1, { starter, loop: state === 'ambient' });
      delete clip.sourcePivot; delete clip.footprint;
      if (!starter) { clip.sourceAssetId = `${family}-berth`; clip.atlas = atlas; for (const frame of clip.frames) delete frame.sourceRect; }
      clip.geometry = geometry;
      if (state === 'ambient') { clip.providerIndices = seq(8).map(i => i + 1); clip.reducedMotionFrame = 0;
        if (!starter) clip.frames.forEach((frame, i) => { frame.providerIndex = i + 1; }); }
      clips[`${prefix}_${state}`] = clip;
    }
    if (!starter) {
      meta.peAdvancedFleet.atlases.push(atlas);
      const value = { version: 1, sourceAssetId: `${family}-berth`, sourceFamily: family, kind: 'berth', tier: null, atlas, geometry,
        sourceManifestSha256: hash('advanced-manifest'), sourceTracksSha256: hash('advanced-tracks'), sourceIndexSha256: hash('advanced-index'),
        clips: Object.entries(clips).filter(([id]) => id.startsWith(`${prefix}_`)).map(([id, clip]) => ({ id, ...clip })) };
      meta.peAdvancedFleet.bindings[atlas] = { sha256: hash(JSON.stringify(value)), value };
    }
  }
  meta.peAdvancedFleet.tracks = { schemaVersion: 1, timingUnit: 'milliseconds', fps: 8, generatedMotionRequired: true,
    families: Object.fromEntries(fleets.slice(1).map(family => [family, syntheticTrack()])) };
  return rebind(meta);
}
// Tracks are shape-only, synthetic samples: this adapter test does not admit vehicle/journey behavior.
function syntheticTrack() { return { mode: 'tidal-gate', departure: [{ frame: 0, offsetPx: [0, 0], opacity: 1 }], return: [{ frame: 0, offsetPx: [0, 0], opacity: 1 }],
  berthPersists: true, footprint: [2, 2], sharedFxRef: 'departure', effectAttachmentPx: [56, 28], contactRemainsOnWater: true, travelScene: 'synthetic fixture', reducedMotion: 'synthetic fixture' }; }
function rebind(meta) {
  for (const section of [meta.peServiceBuildings, meta.peHarvesters, meta.peAdvancedFleet].filter(Boolean)) for (const [atlas, binding] of Object.entries(section.bindings)) {
    const value = binding.value;
    value.clips = Object.entries(section.clips).filter(([id]) => id.startsWith(`${atlas}_`)).map(([id, clip]) => ({ id, ...clip }));
    value.sourceManifestSha256 = typeof section.sourceManifestSha256 === 'object' ? section.sourceManifestSha256[value.family === 'workshop' ? 'workshop' : 'services'] : section.sourceManifestSha256;
    if (section === meta.peAdvancedFleet) { value.track = section.tracks.families[value.sourceFamily]; value.awayComposition = 'intact + ambient; no vehicle'; }
    binding.sha256 = hash(JSON.stringify(value));
  }
  if (meta.peStarterFleet) {
    const s = meta.peStarterFleet;
    s.bindingSha256 = hash(JSON.stringify({ schemaVersion: s.schemaVersion, atlas: s.atlas, sourceScale: s.sourceScale, sourceIndexBase: s.sourceIndexBase, keyIndexBase: s.keyIndexBase,
      sourceManifestSha256: s.sourceManifestSha256, sourceTracksSha256: s.sourceTracksSha256, sourceFxManifestSha256: s.sourceFxManifestSha256,
      sourceIndexSha256: s.sourceIndexSha256, provenanceSha256: s.provenanceSha256, fxProvenanceSha256: s.fxProvenanceSha256,
      clips: meta.peClips, tracks: meta.peTracks, geometry: s.geometry, awayComposition: s.awayComposition }));
  }
  return meta;
}
function sourceFrames(meta) {
  const out = new Map();
  const add = (atlas, clip) => clip.frames.forEach(frame => out.set(`atlas/${atlas}@1x.json|${frame.key}`, {
    hash: frame.rgbaSha256 ?? frame.sha256, width: clip.cellW, height: clip.cellH }));
  for (const section of [meta.peServiceBuildings, meta.peMarket, meta.peHarvesters])
    for (const [id, clip] of Object.entries(section.clips)) add(section.atlases.find(atlas => id.startsWith(`${atlas}_`)), clip);
  for (const clip of Object.values(meta.peClips)) add(meta.peStarterFleet.atlas, clip);
  for (const clip of Object.values(meta.peAdvancedFleet.clips)) add(clip.atlas, clip);
  return out;
}

test('r3 sections compose the exact complete v1 service graph without mutating source provenance', () => {
  const input = fixture(), before = structuredClone(input), { metadata, frames } = composeServiceMetadata(input, rm);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(metadata).sort(), ['peAppearances', 'peClips', 'peEffects']);
  assert.equal(Object.keys(metadata.peAppearances).length, 49); assert.equal(Object.keys(metadata.peClips).length, 138);
  assert.equal(frames.length, 1403); assert.equal(new Set(frames.map(f => f.key)).size, 1403); assert.equal(new Set(frames.map(f => f.group)).size, 46);
  const ordinary = seq(4).flatMap(i => ['workshop', 'lodge', 'market'].map(f => `${f}-t${i + 1}`).concat(realms.map(r => `harvester-${r}-t${i + 1}`)));
  assert.deepEqual(Object.keys(metadata.peAppearances).sort(), [...ordinary, ...fleets.map(f => `${f}-berth`)].sort());
  const prefixes = seq(4).flatMap(i => ['workshop', 'lodge', 'market'].map(f => `pe_${f}_t${i + 1}`).concat(realms.map(r => `pe_harv_${r}_t${i + 1}`)));
  assert.deepEqual(Object.keys(metadata.peClips).sort(), [...prefixes.flatMap(p => ['working', 'construction', 'collapse'].map(s => `${p}_${s}`)), ...fleets.map(f => `pe_berth_${f}_ambient`), 'pe_fx_craft-success'].sort());
  assert.deepEqual([...new Set(frames.map(f => f.group))].sort(), [...prefixes, 'pe_fleet_berths', 'pe_fx'].sort());
  const sources = sourceFrames(input);
  for (const frame of frames) {
    assert.deepEqual(Object.keys(frame).sort(), ['group', 'height', 'key', 'rgbaSha256', 'sourceAtlasPath', 'sourceKey', 'width']);
    const source = sources.get(`${frame.sourceAtlasPath}|${frame.sourceKey}`); assert.ok(source, `missing source: ${frame.key}`);
    assert.equal(frame.rgbaSha256, source.hash); assert.equal(frame.width, source.width); assert.equal(frame.height, source.height);
  }
  const mapped = key => frames.find(frame => frame.key === key);
  assert.equal(mapped('pe_workshop_t1_rubble_f1').sourceKey, 'pe_workshop_t1_destroyed_f1');
  assert.equal(mapped('pe_harv_seeker-reach_t2_working_f1').sourceAtlasPath, 'atlas/pe_harvester_seeker_reach_t2@1x.json');
  assert.equal(mapped('pe_harv_seeker-reach_t2_working_f1').sourceKey, 'pe_harvester_seeker_reach_t2_working_f1');
  for (const family of fleets) assert.equal(mapped(`pe_berth_${family}_intact_f1`).group, 'pe_fleet_berths');
  assert.equal(mapped('pe_berth_starter_intact_f1').sourceAtlasPath, 'atlas/pe_fleet_starter@1x.json');
  assert.equal(mapped('pe_berth_cargo-cutter_intact_f1').sourceAtlasPath, 'atlas/pe_berth_cargo_cutter@1x.json');
  assert.deepEqual(metadata.peEffects, { 'craft-success': { clip: 'pe_fx_craft-success', anchor: [0.5, 0.5] } });
  assert.deepEqual(metadata.peClips['pe_fx_craft-success'].reducedMotion, { image: rm });
  assert.equal(input.peMarket.clips.pe_market_t1_working.reducedMotionFrame, 0);
  assert.ok(!('reducedMotion' in metadata.peClips.pe_market_t1_working));
});

test('v1 state compositions, geometry, timing and closure proof retain their exact meanings', () => {
  const { metadata: { peClips, peAppearances } } = composeServiceMetadata(fixture(), rm);
  for (const [id, clip] of Object.entries(peClips)) {
    const effect = id === 'pe_fx_craft-success', berth = id.startsWith('pe_berth_');
    const loop = id.endsWith('_working') || id.endsWith('_ambient');
    const count = /_(construction|collapse)$/.test(id) || (id.endsWith('_working') && /^(pe_workshop_|pe_harv_)/.test(id)) ? 9 : 8;
    assert.deepEqual(Object.keys(clip).sort(), ['frames', 'playbackIndices', 'fps', 'loop', 'cellW', 'cellH', 'anchorPx', 'anchorKind', ...(!effect ? ['footprint'] : []), ...(effect || berth ? ['providerIndices', 'reducedMotion'] : [])].sort());
    assert.equal(clip.fps, 8); assert.equal(clip.loop, loop); assert.equal(clip.frames.length, count);
    assert.deepEqual(clip.playbackIndices, seq(loop ? 8 : count));
    assert.deepEqual(clip.anchorPx, effect ? [32, 32] : [56, 112]); assert.equal(clip.cellW, effect ? 64 : 112); assert.equal(clip.cellH, clip.cellW);
    assert.equal(clip.anchorKind, effect ? 'centre' : 'cellBottomPivotX');
    if (loop && count === 9) assert.equal(clip.frames[0].sha256, clip.frames[8].sha256);
    clip.frames.forEach((f, i) => assert.deepEqual(f, { sourceIndex: i, key: `${id}_f${i + 1}`, sha256: f.sha256, hashDomain: 'rgba-cell' }));
    if (effect || berth) assert.deepEqual(clip.providerIndices, seq(8).map(i => i + 1));
    if (berth) assert.deepEqual(clip.reducedMotion, { frame: 0 });
  }
  for (const [id, appearance] of Object.entries(peAppearances)) {
    assert.deepEqual(Object.keys(appearance).sort(), ['id', 'facility', 'family', 'tier', 'geometry', 'states'].sort());
    assert.equal(appearance.id, id); assert.deepEqual(appearance.geometry.cell, [112, 112]); assert.deepEqual(appearance.geometry.footprint, [2, 2]);
    assert.equal(appearance.geometry.seat, 'full-cell-bottom'); assert.equal(appearance.geometry.deedScale, 0.5);
    assert.equal(appearance.geometry.horizontalPivot, 56); assert.equal(appearance.geometry.cellBottom, 112); assert.equal(appearance.geometry.drawScale, 1);
  }
  assert.deepEqual(peAppearances['workshop-t1'].states.destroyed, { kind: 'alias', target: { appearance: 'workshop-t1', state: 'rubble' } });
  assert.deepEqual(peAppearances['lodge-t2'].states.destroyed, { kind: 'alias', target: { appearance: 'workshop-t2', state: 'rubble' } });
  assert.deepEqual(peAppearances['market-t3'].states.ready, { kind: 'composition', parts: [{ appearance: 'market-t3', state: 'idle' }], overlay: { effect: 'craft-success', offset: [24, 0] } });
  assert.deepEqual(peAppearances['harvester-seeker-reach-t4'].states.rubble, { kind: 'alias', target: { appearance: 'harvester-seeker-reach-t4', state: 'destroyed' } });
  assert.deepEqual(peAppearances['starter-berth'].states.away, { kind: 'composition', parts: [{ appearance: 'starter-berth', state: 'intact' }, { appearance: 'starter-berth', state: 'ambient' }] });
  assert.deepEqual(peAppearances['survey-balloon-berth'].geometry.attachment, [56, 56]); assert.equal(peAppearances['survey-balloon-berth'].geometry.tidalGate, null);
  assert.deepEqual(peAppearances['cargo-cutter-berth'].geometry.tidalGate, [56, 28]); assert.deepEqual(peAppearances['market-t1'].geometry.providerCell, [80, 80]);
});

// Re-hash mutated synthetic bindings so each refusal exercises semantics, not a stale binding digest.
const refusals = {
  'missing required family': m => { delete m.peMarket; },
  'unknown service family': m => { m.peServiceBuildings.families.push('temple'); },
  'missing required state': m => { delete m.peHarvesters.clips.pe_harvester_frostveil_t1_collapse; },
  'unknown service state': m => { m.peMarket.clips.pe_market_t1_dance = sourceClip('pe_market_t1_dance', 1); },
  'missing berth family': m => { delete m.peAdvancedFleet.clips.pe_berth_cargo_cutter_intact; },
  'wrong rubble alias pixels': m => { m.peServiceBuildings.clips.pe_lodge_t1_destroyed.frames[0].rgbaSha256 = hash('different rubble'); },
  'wrong ready alias pixels': m => { m.peMarket.clips.pe_market_t1_ready.frames[0].rgbaSha256 = hash('different idle'); },
  'wrong shared effect pixels': m => { m.peMarket.clips.pe_market_t1_ready_fx.frames[3].rgbaSha256 = hash('different FX'); },
  'working loop endpoint mismatch': m => { m.peServiceBuildings.clips.pe_workshop_t1_working.frames[8].rgbaSha256 = hash('different last cell'); },
  'wrong source fps': m => { m.peMarket.clips.pe_market_t1_working.fps = 12; },
  'wrong source anchor': m => { m.peHarvesters.clips.pe_harvester_frostveil_t1_working.anchorPx = [56, 104]; },
  'wrong source provider indices': m => { m.peClips.pe_berth_starter_ambient.providerIndices = seq(8); },
  'wrong advanced provider indices': m => { m.peAdvancedFleet.clips.pe_berth_cargo_cutter_ambient.providerIndices[0] = 0; },
  'wrong source playback indices': m => { m.peServiceBuildings.clips.pe_workshop_t1_working.playbackFrameIndices = seq(9); },
  'wrong source hash domain': m => { const f = m.peClips.pe_berth_starter_ambient.frames[0]; f.rgbaSha256 = f.sha256; delete f.sha256; },
  'wrong ready overlay offset': m => { m.peMarket.clips.pe_market_t1_ready.overlay.offset = [24, -12]; },
};
for (const [reason, mutate] of Object.entries(refusals)) test(`refuses ${reason}`, () => {
  const meta = fixture(); mutate(meta); rebind(meta); assert.throws(() => composeServiceMetadata(meta, rm), Error);
});
test('Workshop working loops close on their authored working still independently of idle', () => {
  const meta = fixture();
  for (let tier = 1; tier <= 4; tier++) {
    const prefix = `pe_workshop_t${tier}`, clips = meta.peServiceBuildings.clips;
    const workingStill = hash(`${prefix}:working-static`);
    assert.notEqual(workingStill, clips[`${prefix}_idle`].frames[0].rgbaSha256);
    for (const i of [0, 8]) assert.equal(clips[`${prefix}_working`].frames[i].rgbaSha256, workingStill);
  }
  const { metadata } = composeServiceMetadata(meta, rm);
  for (let tier = 1; tier <= 4; tier++) {
    const prefix = `pe_workshop_t${tier}`, working = metadata.peClips[`${prefix}_working`];
    for (const i of [0, 8]) assert.equal(working.frames[i].sha256, hash(`${prefix}:working-static`));
  }
});
for (const field of ['peAppearances', 'peEffects']) test(`refuses a composed source mixed with legacy ${field}`, () => {
  const meta = fixture(); meta[field] = {};
  assert.throws(() => composeServiceMetadata(meta, rm), /composed source mixes legacy and composed graphs/);
});
test('requires a separately supplied canonical reduced-motion PNG descriptor', () => {
  for (const bad of [undefined, null, { ...rm, path: 'atlas/animated-cell-zero.png' }, { ...rm, sha256: 'invalid' }, { ...rm, bytes: 0 }, { ...rm, bytes: 1.5 }])
    assert.throws(() => composeServiceMetadata(fixture(), bad), Error);
});

// MRAW + deflated RGBA is a memory-bounded MOCK codec, not PNG/art/provider/renderer proof.
import { deflateSync, inflateSync } from 'node:zlib';
import { buildComposedServiceCatalogue, assertServiceOptionalFiles } from './service-catalog.mjs';

const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
function encodeMockRgba({ data, width, height }) {
  const header = Buffer.alloc(12); header.write('MRAW'); header.writeUInt32BE(width, 4); header.writeUInt32BE(height, 8);
  return Buffer.concat([header, deflateSync(data, { level: 1 })]);
}
function mockHeader(bytes) {
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'MRAW', 'this fixture accepts only its mock codec');
  return { width: bytes.readUInt32BE(4), height: bytes.readUInt32BE(8) };
}
function inspectMockRgba(bytes) {
  return { ...mockHeader(bytes), format: 'png', depth: 'uchar', hasAlpha: true, pages: 1 };
}
function decodeMockRgba(bytes) { return { ...mockHeader(bytes), data: inflateSync(bytes.subarray(12)) }; }
function syntheticRgbaFixture() {
  const meta = fixture(), patterns = new Map(), converted = new Map();
  // Real r3 manifest key order. Object semantics are order independent; binding hashes are not.
  for (const family of fleets) {
    const g = berthGeometry(family), ordered = { cell: g.cell, footprint: g.footprint, horizontalPivot: g.horizontalPivot,
      sourceCellBottom: g.sourceCellBottom, groundContact: g.groundContact, attachment: g.attachment, tidalGate: g.tidalGate, drawScale: g.drawScale };
    if (family === 'starter') meta.peStarterFleet.geometry.berth = ordered;
    else meta.peAdvancedFleet.bindings[`pe_berth_${family.replaceAll('-', '_')}`].value.geometry = ordered;
    const table = family === 'starter' ? meta.peClips : meta.peAdvancedFleet.clips;
    for (const state of ['intact', 'damaged', 'destroyed', 'ambient']) table[`pe_berth_${family.replaceAll('-', '_')}_${state}`].geometry = ordered;
  }
  // Equal synthetic labels become equal real cell buffers, preserving all alias and endpoint proofs.
  // Keep only 32-byte patterns, not a retained buffer for each of the ~1,500 source cells.
  for (const clips of [meta.peServiceBuildings.clips, meta.peMarket.clips, meta.peHarvesters.clips, meta.peClips, meta.peAdvancedFleet.clips]) {
    for (const clip of Object.values(clips)) for (const frame of clip.frames) {
      const field = 'rgbaSha256' in frame ? 'rgbaSha256' : 'sha256', old = frame[field], lookup = `${old}:${clip.cellW}:${clip.cellH}`;
      if (!converted.has(lookup)) {
        const pattern = Buffer.from(old, 'hex'); for (let i = 3; i < pattern.length; i += 4) pattern[i] = 255;
        const rgba = Buffer.alloc(clip.cellW * clip.cellH * 4); rgba.fill(pattern);
        const digest = bytesDigest(rgba); patterns.set(digest, pattern); converted.set(lookup, digest);
      }
      frame[field] = converted.get(lookup);
    }
  }
  for (const [atlas, binding] of Object.entries(meta.peHarvesters.bindings))
    binding.value.scaffold.rgbaSha256 = meta.peHarvesters.clips[`${atlas}_construction`].frames[0].rgbaSha256;
  rebind(meta);
  const byAtlas = new Map();
  for (const [reference, source] of sourceFrames(meta)) {
    const [atlasPath, key] = reference.split('|'), entries = byAtlas.get(atlasPath) ?? [];
    entries.push({ key, ...source }); byAtlas.set(atlasPath, entries);
  }
  const assets = new Map();
  for (const [atlasPath, entries] of byAtlas) {
    const group = atlasPath.slice('atlas/'.length, -'@1x.json'.length), columns = Math.min(8, entries.length);
    const slot = Math.max(...entries.map(e => Math.max(e.width, e.height))), width = columns * slot, height = Math.ceil(entries.length / columns) * slot;
    const data = Buffer.alloc(width * height * 4), packed = [];
    entries.forEach((entry, i) => {
      const x = i % columns * slot, y = Math.floor(i / columns) * slot;
      const rgba = Buffer.alloc(entry.width * entry.height * 4); rgba.fill(patterns.get(entry.hash));
      assert.equal(bytesDigest(rgba), entry.hash);
      for (let row = 0; row < entry.height; row++) rgba.copy(data, ((y + row) * width + x) * 4, row * entry.width * 4, (row + 1) * entry.width * 4);
      packed.push({ filename: entry.key, rotated: false, trimmed: false, frame: { x, y, w: entry.width, h: entry.height },
        sourceSize: { w: entry.width, h: entry.height }, spriteSourceSize: { x: 0, y: 0, w: entry.width, h: entry.height } });
    });
    assets.set(atlasPath, Buffer.from(JSON.stringify({ textures: [{ image: `${group}@1x.png`, format: 'RGBA8888', scale: 1, size: { w: width, h: height }, frames: packed }] })));
    assets.set(`atlas/${group}@1x.png`, encodeMockRgba({ data, width, height }));
  }
  return { meta, assets };
}

test('composed graph and RGBA projection bind all 46 optional groups to exactly 92 output pins', async () => {
  const { meta, assets } = syntheticRgbaFixture(), beforeMeta = JSON.stringify(meta);
  const beforeAssets = new Map([...assets].map(([path, bytes]) => [path, bytesDigest(bytes)]));
  const { phaseE, assets: output } = await buildComposedServiceCatalogue({ meta, reducedMotionImage: rm, assets,
    inspectPng: inspectMockRgba, decodePng: decodeMockRgba, encodePng: encodeMockRgba });
  assert.equal(JSON.stringify(meta), beforeMeta); assert.deepEqual(new Map([...assets].map(([p, b]) => [p, bytesDigest(b)])), beforeAssets);
  assert.equal(phaseE.version, 1); assert.equal(Object.keys(phaseE.metadata.peClips).length, 138); assert.equal(Object.keys(phaseE.metadata.peAppearances).length, 49);
  assert.equal(phaseE.groups.length, 46); assert.equal(output.size, 92);
  assert.deepEqual(phaseE.groups.map(g => g.id), phaseE.groups.map(g => g.id).sort());
  const pins = phaseE.groups.flatMap(group => group.files); assert.equal(pins.length, 92);
  assert.deepEqual(pins.map(pin => pin.path).sort(), [...output.keys()].sort());
  for (const pin of pins) { assert.equal(pin.sha256, bytesDigest(output.get(pin.path))); assert.equal(pin.size, output.get(pin.path).length); }
  const wanted = new Map();
  const claim = (key, width, height, digest) => { assert.ok(!wanted.has(key)); wanted.set(key, { width, height, digest }); };
  for (const clip of Object.values(phaseE.metadata.peClips)) for (const frame of clip.frames) claim(frame.key, clip.cellW, clip.cellH, frame.sha256);
  for (const appearance of Object.values(phaseE.metadata.peAppearances)) for (const state of Object.values(appearance.states))
    if (state.kind === 'static') claim(state.key, ...appearance.geometry.cell);
  assert.equal(wanted.size, 1403); const seen = new Set();
  for (const group of phaseE.groups) {
    assert.equal(group.atlasPath, `atlas/${group.id}@1x.json`); assert.equal(group.imagePath, `atlas/${group.id}@1x.png`);
    assert.deepEqual(group.files.map(pin => pin.path), [group.atlasPath, group.imagePath]);
    const document = JSON.parse(output.get(group.atlasPath).toString()), image = decodeMockRgba(output.get(group.imagePath));
    assert.equal(document.textures.length, 1); const texture = document.textures[0];
    assert.deepEqual(texture.size, { w: image.width, h: image.height }); assert.equal(group.decodedBytes, image.data.length);
    assert.ok(image.width > 0 && image.width <= 4096 && image.height > 0 && image.height <= 4096);
    for (const frame of texture.frames) {
      const expected = wanted.get(frame.filename), rect = frame.frame; assert.ok(expected); assert.ok(!seen.has(frame.filename)); seen.add(frame.filename);
      assert.equal(rect.w, expected.width); assert.equal(rect.h, expected.height);
      if (expected.digest) {
        const rgba = Buffer.alloc(rect.w * rect.h * 4);
        for (let row = 0; row < rect.h; row++) image.data.copy(rgba, row * rect.w * 4, ((rect.y + row) * image.width + rect.x) * 4, ((rect.y + row) * image.width + rect.x + rect.w) * 4);
        assert.equal(bytesDigest(rgba), expected.digest);
      }
    }
  }
  assert.equal(seen.size, 1403);
  const files = pins.map(pin => ({ ...pin, tier: 'optional' }));
  assert.doesNotThrow(() => assertServiceOptionalFiles(phaseE, files));
  assert.throws(() => assertServiceOptionalFiles(phaseE, files.map((pin, i) => i ? pin : { ...pin, tier: 'core' })), /optional file pin changed/);
  assert.throws(() => assertServiceOptionalFiles(phaseE, files.map((pin, i) => i ? pin : { ...pin, sha256: '0'.repeat(64) })), /optional file pin changed/);
});

// These mutations deliberately avoid rebind(meta), which repairs manifest pins.
// Only the affected binding's digest is recomputed.
const bindingCases = [
  ['services', 'peServiceBuildings', 'pe_workshop_t1'],
  ['harvesters', 'peHarvesters', 'pe_harvester_frostveil_t1'],
  ['advanced', 'peAdvancedFleet', 'pe_berth_survey_balloon'],
];
function mutateBoundValue(meta, section, atlas, edit) {
  const binding = meta[section].bindings[atlas];
  edit(binding.value);
  binding.sha256 = hash(JSON.stringify(binding.value));
}
for (const [name, section, atlas] of bindingCases) {
  test(`composed source refuses missing ${name} binding table`, () => {
    const meta = fixture(); delete meta[section].bindings;
    assert.throws(() => composeServiceMetadata(meta, rm), Error);
  });
  test(`composed source refuses missing ${name} binding atlas`, () => {
    const meta = fixture(); delete meta[section].bindings[atlas];
    assert.throws(() => composeServiceMetadata(meta, rm), Error);
  });
  test(`composed source refuses extra ${name} binding atlas`, () => {
    const meta = fixture(), extra = `${atlas}_foreign`;
    meta[section].bindings[extra] = structuredClone(meta[section].bindings[atlas]);
    mutateBoundValue(meta, section, extra, value => { value.atlas = extra; });
    assert.throws(() => composeServiceMetadata(meta, rm), Error);
  });
  for (const [label, field] of [['manifest', 'sourceManifestSha256'], ['index', 'sourceIndexSha256']]) {
    test(`composed source refuses rehashed ${name} binding with a foreign ${label} pin`, () => {
      const meta = fixture();
      mutateBoundValue(meta, section, atlas, value => { value[field] = hash(`foreign ${name} ${label}`); });
      assert.throws(() => composeServiceMetadata(meta, rm), Error);
    });
  }
}
for (const [name, section, atlas] of bindingCases.filter(([name]) => name !== 'advanced')) {
  test(`composed source refuses rehashed ${name} binding with a changed source scale`, () => {
    const meta = fixture(); mutateBoundValue(meta, section, atlas, value => { value.sourceScale = 2; });
    assert.throws(() => composeServiceMetadata(meta, rm), Error);
  });
  test(`composed source refuses rehashed ${name} binding with a foreign family`, () => {
    const meta = fixture(); mutateBoundValue(meta, section, atlas, value => { value.family = 'temple'; });
    assert.throws(() => composeServiceMetadata(meta, rm), Error);
  });
  test(`composed source refuses rehashed ${name} binding with a foreign tier`, () => {
    const meta = fixture(); mutateBoundValue(meta, section, atlas, value => { value.tier = 4; });
    assert.throws(() => composeServiceMetadata(meta, rm), Error);
  });
}
test('composed source refuses Workshop binding mislabeled as Lodge after rehashing', () => {
  const meta = fixture(); mutateBoundValue(meta, 'peServiceBuildings', 'pe_workshop_t1', value => { value.family = 'lodge'; });
  assert.throws(() => composeServiceMetadata(meta, rm), Error);
});
for (const [name, edit] of [
  ['source family', value => { value.sourceFamily = 'cargo-cutter'; }],
  ['berth tier', value => { value.tier = 1; }],
  ['source asset', value => { value.sourceAssetId = 'survey-balloon-t1'; }],
  ['kind', value => { value.kind = 'vehicle'; }],
  ['tracks pin', value => { value.sourceTracksSha256 = hash('foreign advanced tracks'); }],
]) test(`composed source refuses rehashed advanced berth binding with a changed ${name}`, () => {
  const meta = fixture(); mutateBoundValue(meta, 'peAdvancedFleet', 'pe_berth_survey_balloon', edit);
  assert.throws(() => composeServiceMetadata(meta, rm), Error);
});
