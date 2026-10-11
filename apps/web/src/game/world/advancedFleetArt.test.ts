import { readFileSync } from 'node:fs';
import { PHASE_E_VEHICLES, STRUCTURES } from '@shardkeep/shared';
import { PHASE_E_VEHICLE_FAMILY_IDS } from '@shardkeep/shared/phaseEVehicles';
import { describe, expect, it } from 'vitest';
import {
  ADVANCED_FLEET_FRAME_KEY, EMPTY_ADVANCED_FLEET_ART, advancedBerthFrameKey, advancedDockedVehicleOffset, advancedFleetArtAvailable,
  advancedFleetFootprint, advancedFleetGroupOf, advancedFleetSeat, advancedVehicleArt, parseAdvancedFleetMetadata,
  selectCurrentBerths, selectFrozenBerths,
} from './advancedFleetArt';
import { dockedVehicleOffset, parseStarterFleetMetadata } from './fleetArt';

/** Literal exporter bytes of the accepted D237 table (= meta.peAdvancedFleet). */
const fixture = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_advanced_fleet.manifest.json', import.meta.url), 'utf8')) as Record<string, unknown> & {
  clips: Record<string, Record<string, unknown>>; bindings: Record<string, { sha256: string; value: Record<string, unknown> }>; tracks: { families: Record<string, Record<string, unknown>> };
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const parse = (mutate: (t: typeof fixture) => void = () => {}) => { const t = clone(fixture); mutate(t); return parseAdvancedFleetMetadata(t); };
const art = parse();
const FAMILIES = PHASE_E_VEHICLE_FAMILY_IDS;

describe('advanced fleet table (P6a)', () => {
  it('parses the accepted table: four families, sixteen tiers, eighty clips, data-only tracks, pinned sources', () => {
    expect(advancedFleetArtAvailable(art)).toBe(true);
    expect(Object.keys(art.clips)).toHaveLength(80);
    expect([...art.berths.keys()]).toEqual([...FAMILIES]);
    expect(art.vehicles.size).toBe(16);
    expect(art.tracks.size).toBe(4);
    expect(art.sourceTracksSha256).toBe('33576b7a8c0d6c62658b3c88ef3accb204babe1e21207dc5a2c62234da327b4d');
    // Aerial berths attach at [56,56], nautical at [56,78] with a tidal gate; every berth sits on its full cell bottom.
    expect(art.berths.get('survey_balloon')!.geometry).toMatchObject({ attachment: [56, 56], groundContact: [56, 93], tidalGate: null, footprint: STRUCTURES.berth.footprint });
    expect(art.berths.get('cargo_cutter')!.geometry).toMatchObject({ attachment: [56, 78], tidalGate: [56, 28] });
    expect(art.clips['pe_berth_expedition_barge_ambient']).toMatchObject({ atlas: 'pe_berth_expedition_barge', fps: 8, loop: true, reducedMotionFrame: 0, anchorKind: 'cellBottomPivotX', anchorPx: [56, 112] });
    expect(art.clips['pe_berth_expedition_barge_ambient']!.frames).toHaveLength(8);
    expect(art.clips['pe_veh_courier_airship_t4_docked']!.frames).toHaveLength(4);
    expect(art.clips['pe_veh_courier_airship_t4_exhausted']).toMatchObject({ fps: 0, frames: ['pe_veh_courier_airship_t4_exhausted_f1'] });
    // C5: each family's OWN track carries its fps, effect seat and shared gate-effect reference (null for lift-off).
    expect(art.tracks.get('cargo_cutter')).toMatchObject({ mode: 'tidal-gate', fps: 8, sharedFxRef: 'departure', effectAttachmentPx: [56, 28] });
    expect(art.tracks.get('expedition_barge')).toMatchObject({ mode: 'tidal-gate', sharedFxRef: 'departure', effectAttachmentPx: [56, 28] });
    expect(art.tracks.get('survey_balloon')).toMatchObject({ mode: 'vertical-liftoff', fps: 8, sharedFxRef: null, effectAttachmentPx: [56, 40] });
    expect(art.tracks.get('courier_airship')).toMatchObject({ mode: 'vertical-liftoff', sharedFxRef: null, effectAttachmentPx: [56, 40] });
    expect(art.tracks.get('survey_balloon')!.departure).toHaveLength(8);
    expect(art.tracks.get('survey_balloon')!.departure[7]).toEqual({ frame: 7, offsetPx: [0, -78], opacity: 0 });
  });

  it('carries every family/tier dock translation exactly once: stated dockOffsetPx == berth attachment − vehicle contact', () => {
    const expected: Record<string, Record<number, [number, number]>> = {
      survey_balloon: { 1: [0, -54], 2: [0, -52], 3: [0, -54], 4: [0, -52] },
      cargo_cutter: { 1: [0, -30], 2: [0, -30], 3: [0, -30], 4: [0, -30] },
      courier_airship: { 1: [0, -46], 2: [0, -46], 3: [0, -46], 4: [0, -50] },
      expedition_barge: { 1: [0, -27], 2: [0, -27], 3: [0, -27], 4: [0, -27] },
    };
    for (const family of FAMILIES) for (const tier of PHASE_E_VEHICLES.tiers) {
      const vehicle = advancedVehicleArt(art, family, tier)!;
      const berth = art.berths.get(family)!;
      expect(vehicle.dockTranslation, `${family} t${tier}`).toEqual(expected[family]![tier]);
      expect([berth.geometry.attachment[0] - vehicle.geometry.contactPx[0], berth.geometry.attachment[1] - vehicle.geometry.contactPx[1]]).toEqual(vehicle.dockTranslation);
      // Origin-to-origin offset = −berthPivot + dock + contact (fleetArt derivation).
      const offset = advancedDockedVehicleOffset(art, family, tier)!;
      expect(offset).toEqual([-56 + vehicle.dockTranslation[0] + vehicle.geometry.contactPx[0], -112 + vehicle.dockTranslation[1] + vehicle.geometry.contactPx[1]]);
    }
    // The starter's authored [0,−34] is the same derivation (the barge shares its nautical geometry: [56,78]−[56,105] = [0,−27]).
    expect(advancedDockedVehicleOffset(art, 'expedition_barge', 1)).toEqual([0, -34]);
    expect(advancedDockedVehicleOffset(art, 'survey_balloon', 1)).toEqual([0, -56 + 110 - 54 - 0].map((n, i) => (i === 0 ? 0 : -112 - 54 + 110)));
    expect(advancedDockedVehicleOffset(EMPTY_ADVANCED_FLEET_ART, 'survey_balloon', 1)).toBeNull();
  });

  it('refuses the WHOLE table on any defect (never a half-admitted family or tier)', () => {
    const cases: Array<[string, (t: typeof fixture) => void]> = [
      ['schema', (t) => { t['schemaVersion'] = 2; }],
      ['a missing group', (t) => { (t['atlases'] as string[]).pop(); }],
      ['a foreign group', (t) => { (t['atlases'] as string[])[0] = 'pe_fleet_starter'; }],
      ['a missing berth state', (t) => { delete t.clips['pe_berth_cargo_cutter_damaged']; }],
      ['a missing vehicle state', (t) => { delete t.clips['pe_veh_cargo_cutter_t2_exhausted']; }],
      ['a foreign clip id', (t) => { t.clips['pe_veh_cargo_cutter_t5_idle'] = t.clips['pe_veh_cargo_cutter_t4_idle']!; }],
      ['a clip naming another group', (t) => { t.clips['pe_veh_cargo_cutter_t1_idle']!['atlas'] = 'pe_veh_cargo_cutter_t2'; }],
      ['a vehicle anchored off its contact', (t) => { t.clips['pe_veh_cargo_cutter_t1_idle']!['anchorPx'] = [56, 100]; }],
      ['a dock offset that disagrees with attachment − contact', (t) => { (t.clips['pe_veh_cargo_cutter_t1_idle']!['geometry'] as Record<string, unknown>)['dockOffsetPx'] = [0, -31]; }],
      ['a vehicle authored against another berth', (t) => { (t.clips['pe_veh_cargo_cutter_t1_idle']!['geometry'] as Record<string, unknown>)['berthRef'] = 'starter-berth'; }],
      ['two geometries for one family/tier', (t) => { (t.clips['pe_veh_cargo_cutter_t1_docked']!['geometry'] as Record<string, unknown>)['contactPx'] = [56, 107]; }],
      ['a berth footprint that is not the game footprint', (t) => { (t.clips['pe_berth_cargo_cutter_intact']!['geometry'] as Record<string, unknown>)['footprint'] = [3, 2]; }],
      ['a frame digest that is not the full RGBA digest', (t) => { (t.clips['pe_berth_cargo_cutter_intact']!['frames'] as Array<Record<string, unknown>>)[0]!['rgbaSha256'] = 'nope'; }],
      ['a binding for a foreign source build', (t) => { t.bindings['pe_berth_cargo_cutter']!.value['sourceManifestSha256'] = '0'.repeat(64); }],
      ['a binding naming a clip of another group', (t) => { (t.bindings['pe_berth_cargo_cutter']!.value['clips'] as unknown[]).push({ id: 'pe_veh_cargo_cutter_t1_idle' }); }],
      ['a missing binding', (t) => { delete t.bindings['pe_veh_expedition_barge_t4']; }],
      ['a binding with the wrong kind', (t) => { t.bindings['pe_veh_expedition_barge_t4']!.value['kind'] = 'berth'; }],
      ['a missing family track', (t) => { delete t.tracks.families['courier-airship']; }],
      ['a track step out of order', (t) => { (t.tracks.families['courier-airship']!['departure'] as Array<{ frame: number }>)[1]!.frame = 5; }],
      ['a track without its effect seat', (t) => { delete t.tracks.families['cargo-cutter']!['effectAttachmentPx']; }],
      ['a track whose shared effect reference is not a name', (t) => { t.tracks.families['cargo-cutter']!['sharedFxRef'] = 3; }],
      ['a track table without a positive fps', (t) => { (t.tracks as unknown as Record<string, unknown>)['fps'] = 0; }],
      ['a bad provenance hash', (t) => { t['provenanceSha256'] = 'x'; }],
    ];
    for (const [label, mutate] of cases) expect(parse(mutate), label).toBe(EMPTY_ADVANCED_FLEET_ART);
    expect(parseAdvancedFleetMetadata(undefined)).toBe(EMPTY_ADVANCED_FLEET_ART);
    expect(parseAdvancedFleetMetadata({ schemaVersion: 1 })).toBe(EMPTY_ADVANCED_FLEET_ART);
    expect(advancedFleetArtAvailable(EMPTY_ADVANCED_FLEET_ART)).toBe(false);
  });

  it('keys, groups, seats and footprints only the twenty groups; the starter table stays its own module', () => {
    expect(advancedBerthFrameKey(art, 'survey_balloon')).toBe('pe_berth_survey_balloon_intact_f1');
    expect(advancedBerthFrameKey(art, 'survey_balloon', 'destroyed')).toBe('pe_berth_survey_balloon_destroyed_f1');
    expect(advancedBerthFrameKey(EMPTY_ADVANCED_FLEET_ART, 'survey_balloon')).toBeNull();
    expect(advancedFleetGroupOf('pe_berth_cargo_cutter_ambient_f8')).toBe('pe_berth_cargo_cutter');
    expect(advancedFleetGroupOf('pe_veh_courier_airship_t3_travel_f2')).toBe('pe_veh_courier_airship_t3');
    expect(advancedFleetGroupOf('pe_berth_starter_intact_f1')).toBeNull();
    expect(advancedFleetGroupOf('pe_veh_cargo_cutter_t5_idle_f1')).toBeNull();
    expect(advancedFleetSeat(art, 'pe_berth_cargo_cutter_intact_f1')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    expect(advancedFleetSeat(art, 'pe_veh_cargo_cutter_t1_docked_f3')).toEqual({ origin: [0.5, 108 / 112], scale: 1, offsetGamePx: [0, 0] });
    expect(advancedFleetSeat(art, 'bld_berth_l1')).toBeNull();
    expect(advancedFleetSeat(EMPTY_ADVANCED_FLEET_ART, 'pe_berth_cargo_cutter_intact_f1')).toBeNull();
    expect(advancedFleetFootprint('pe_berth_cargo_cutter_intact_f1')).toEqual(STRUCTURES.berth.footprint);
    expect(advancedFleetFootprint('bld_berth_l1')).toBeNull();
    for (const key of ['pe_veh_expedition_barge_t4_exhausted_f1', 'pe_berth_survey_balloon_damaged_f1']) expect(ADVANCED_FLEET_FRAME_KEY.test(key), key).toBe(true);
    for (const key of ['pe_veh_starter_docked_f1', 'pe_fx_departure_f1', 'pe_berth_cargo_cutter_intact', 'pe_veh_cargo_cutter_t1_docked_f0x']) expect(ADVANCED_FLEET_FRAME_KEY.test(key), key).toBe(false);
    // The starter module parses nothing of this table and vice versa.
    expect(parseStarterFleetMetadata(fixture, fixture.clips, fixture.tracks).atlas).toBe('');
    expect(dockedVehicleOffset(parseStarterFleetMetadata(undefined, undefined, undefined))).toBeNull();
  });
});

describe('berth facts selection (P6a): current and frozen rules stay distinct', () => {
  const BERTH = { id: 'b-1', type: 'berth', level: 1, underConstruction: false };
  const BERTH2 = { id: 'b-2', type: 'berth', level: 3, underConstruction: false };
  const SCAFFOLD = { id: 'b-0', type: 'berth', level: 0, underConstruction: true };
  const KEEP = { id: 'k', type: 'keep', level: 5, underConstruction: false };
  const balloon = { family: 'survey_balloon', tier: 2, presence: 'occupied' };
  const advanced = (...berths: Array<{ buildingId: string; installation: unknown }>) => ({ version: 1, berths });
  const starter = (...berths: Array<{ buildingId: string; installation: unknown }>) => ({ version: 1, berths });

  it('current: every berth closes once, construction and level 0 carry only null, legacy stays quiet, null is unavailable', () => {
    const rows = [KEEP, BERTH, SCAFFOLD, BERTH2];
    const sel = selectCurrentBerths(undefined, advanced({ buildingId: 'b-2', installation: null }, { buildingId: 'b-0', installation: null }, { buildingId: 'b-1', installation: balloon }), rows);
    expect(sel.unavailable).toBe(false);
    expect([...sel.berths.entries()]).toEqual([['b-1', { family: 'survey_balloon', tier: 2, presence: 'occupied' }]]);
    expect(selectCurrentBerths(undefined, undefined, rows)).toEqual({ berths: new Map(), unavailable: false });
    for (const [label, raw] of [
      ['whole null', null], ['a foreign version', { version: 2, berths: [] }], ['a missing berth in the closure', advanced({ buildingId: 'b-1', installation: null })],
      ['an unknown berth', advanced({ buildingId: 'b-1', installation: null }, { buildingId: 'b-0', installation: null }, { buildingId: 'b-2', installation: null }, { buildingId: 'ghost', installation: null })],
      ['a duplicate berth', advanced({ buildingId: 'b-1', installation: null }, { buildingId: 'b-1', installation: null }, { buildingId: 'b-0', installation: null }, { buildingId: 'b-2', installation: null })],
      ['an installation on a scaffold', advanced({ buildingId: 'b-1', installation: null }, { buildingId: 'b-0', installation: balloon }, { buildingId: 'b-2', installation: null })],
      ['a foreign family', advanced({ buildingId: 'b-1', installation: { ...balloon, family: 'starter' } }, { buildingId: 'b-0', installation: null }, { buildingId: 'b-2', installation: null })],
      ['tier 5', advanced({ buildingId: 'b-1', installation: { ...balloon, tier: 5 } }, { buildingId: 'b-0', installation: null }, { buildingId: 'b-2', installation: null })],
      ['a foreign presence', advanced({ buildingId: 'b-1', installation: { ...balloon, presence: 'docked' } }, { buildingId: 'b-0', installation: null }, { buildingId: 'b-2', installation: null })],
    ] as const) {
      expect(selectCurrentBerths(undefined, raw, rows), label).toEqual({ berths: new Map(), unavailable: true });
    }
    // Unsorted current closures are accepted (the current producer sorts, the rule is the frozen sibling's).
    expect(selectCurrentBerths(undefined, advanced({ buildingId: 'b-2', installation: null }, { buildingId: 'b-1', installation: null }, { buildingId: 'b-0', installation: null }), rows).unavailable).toBe(false);
  });

  it('frozen: the closure equals the snapshot berths sorted by id, construction is refused outright, both siblings from the payload only', () => {
    const snapshot = [KEEP, BERTH2, BERTH];
    const ok = selectFrozenBerths(starter({ buildingId: 'b-1', installation: null }, { buildingId: 'b-2', installation: { family: 'starter', presence: 'away' } }),
      advanced({ buildingId: 'b-1', installation: balloon }, { buildingId: 'b-2', installation: null }), snapshot);
    expect(ok.unavailable).toBe(false);
    expect(ok.berths.get('b-1')).toEqual({ family: 'survey_balloon', tier: 2, presence: 'occupied' });
    expect(ok.berths.get('b-2')).toEqual({ family: 'starter', presence: 'away' });
    expect(selectFrozenBerths(undefined, advanced({ buildingId: 'b-2', installation: null }, { buildingId: 'b-1', installation: balloon }), snapshot), 'unsorted').toEqual({ berths: new Map(), unavailable: true });
    expect(selectFrozenBerths(undefined, advanced({ buildingId: 'b-0', installation: null }, { buildingId: 'b-1', installation: null }, { buildingId: 'b-2', installation: null }), [...snapshot, SCAFFOLD]), 'construction in a frozen closure').toEqual({ berths: new Map(), unavailable: true });
    expect(selectFrozenBerths(undefined, undefined, snapshot)).toEqual({ berths: new Map(), unavailable: false });
    expect(selectFrozenBerths(null, undefined, snapshot), 'null starter sibling').toEqual({ berths: new Map(), unavailable: true });
    expect(selectFrozenBerths(starter({ buildingId: 'b-1', installation: { family: 'starter', presence: 'occupied' } }, { buildingId: 'b-2', installation: { family: 'starter', presence: 'occupied' } }), undefined, snapshot), 'two starters').toEqual({ berths: new Map(), unavailable: true });
    // Snapshot rows without the flag count as completed (old bundles).
    expect(selectFrozenBerths(undefined, advanced({ buildingId: 'b-1', installation: balloon }, { buildingId: 'b-2', installation: null }), [{ id: 'b-1', type: 'berth', level: 1 }, { id: 'b-2', type: 'berth', level: 1 }]).berths.size).toBe(1);
  });

  it('conflicting positive installations on one berth refuse both and the whole presentation — never a silent preference', () => {
    const rows = [BERTH, BERTH2];
    const conflict = selectCurrentBerths(starter({ buildingId: 'b-1', installation: { family: 'starter', presence: 'occupied' } }, { buildingId: 'b-2', installation: null }),
      advanced({ buildingId: 'b-1', installation: balloon }, { buildingId: 'b-2', installation: { ...balloon, family: 'cargo_cutter' } }), rows);
    expect(conflict).toEqual({ berths: new Map(), unavailable: true });
    // The same facts without the conflict present both siblings side by side.
    const fine = selectCurrentBerths(starter({ buildingId: 'b-1', installation: { family: 'starter', presence: 'occupied' } }, { buildingId: 'b-2', installation: null }),
      advanced({ buildingId: 'b-1', installation: null }, { buildingId: 'b-2', installation: { ...balloon, family: 'cargo_cutter' } }), rows);
    expect(fine.unavailable).toBe(false);
    expect(fine.berths.get('b-1')).toEqual({ family: 'starter', presence: 'occupied' });
    expect(fine.berths.get('b-2')).toEqual({ family: 'cargo_cutter', tier: 2, presence: 'occupied' });
    // A malformed sibling makes EVERY berth unavailable, even those the other sibling named.
    expect(selectCurrentBerths({ version: 1, berths: 'nope' }, advanced({ buildingId: 'b-1', installation: balloon }, { buildingId: 'b-2', installation: null }), rows)).toEqual({ berths: new Map(), unavailable: true });
  });
});
