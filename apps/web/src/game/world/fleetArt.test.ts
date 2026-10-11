/**
 * Starter fleet art table + presence selection against the REAL generated
 * manifest (apps/web/testFixtures/pe_fleet_starter.manifest.json, the packer's
 * pe_fleet_starter output). Presentation only: every refusal below keeps the
 * ordinary berth path and the shared 2×2 footprint usable.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BERTH_AMBIENT_CLIP, BERTH_INTACT_CLIP, EMPTY_STARTER_FLEET_ART, STARTER_FLEET_ATLAS_GROUP, STARTER_FLEET_FRAME_KEY,
  VEHICLE_DOCKED_CLIP, berthRestFrameKey, dockedVehicleOffset, parseStarterFleetMetadata, selectStarterBerths,
  starterFleetArtAvailable, starterFleetSeat,
} from './fleetArt';

const manifest = JSON.parse(readFileSync(
  new URL('../../../testFixtures/pe_fleet_starter.manifest.json', import.meta.url), 'utf8',
)) as Record<string, unknown> & { clips: Record<string, unknown>; tracks: unknown };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The sidecar shape: identity/geometry under peStarterFleet, clips and tracks beside it. */
function sidecar(mutate: (s: { identity: Record<string, unknown>; clips: Record<string, unknown>; tracks: unknown }) => void = () => {}) {
  const { clips, tracks, ...identity } = clone(manifest);
  const s = { identity: identity as Record<string, unknown>, clips: clips as Record<string, unknown>, tracks };
  mutate(s);
  return parseStarterFleetMetadata(s.identity, s.clips, s.tracks);
}
const art = sidecar();
const BERTH = { id: 'berth-1', type: 'berth', underConstruction: false };
const BERTH_2 = { id: 'berth-2', type: 'berth', underConstruction: false };
const KEEP = { id: 'keep', type: 'keep', underConstruction: false };
const facts = (berths: unknown[]) => ({ version: 1, berths });

describe('parseStarterFleetMetadata', () => {
  it('parses the generated family: eleven clips in one 1x group, authored geometry and the tracks as data', () => {
    expect(starterFleetArtAvailable(art)).toBe(true);
    expect(art.atlas).toBe(STARTER_FLEET_ATLAS_GROUP);
    expect(Object.keys(art.clips)).toHaveLength(11);
    expect(art.clips[BERTH_INTACT_CLIP]).toMatchObject({ atlas: 'pe_fleet_starter', cellW: 112, cellH: 112, anchorPx: [56, 112], anchorKind: 'cellBottomPivotX', fps: 0, loop: false, frames: ['pe_berth_starter_intact_f1'] });
    expect(art.clips[BERTH_AMBIENT_CLIP]).toMatchObject({ fps: 8, loop: true, reducedMotionFrame: 0 });
    expect(art.clips[BERTH_AMBIENT_CLIP]!.frames).toHaveLength(8);
    expect(art.clips[VEHICLE_DOCKED_CLIP]).toMatchObject({ anchorKind: 'attachment', anchorPx: [56, 105], fps: 8, loop: true });
    expect(art.clips[VEHICLE_DOCKED_CLIP]!.frames).toEqual(['pe_veh_starter_docked_f1', 'pe_veh_starter_docked_f2', 'pe_veh_starter_docked_f3', 'pe_veh_starter_docked_f4']);
    expect(art.clips['pe_fx_departure']).toMatchObject({ anchorKind: 'centre', anchorPx: [32, 32], loop: false, reducedMotionClip: 'pe_fx_departure_still' });
    expect(art.geometry!.berth).toMatchObject({ cell: [112, 112], footprint: [2, 2], horizontalPivot: 56, sourceCellBottom: 112, attachment: [56, 78], groundContact: [56, 93], tidalGate: [56, 28] });
    expect(art.geometry!.starter).toMatchObject({ contactPx: [56, 105], dockOffsetPx: [0, -27], berthRef: 'starter-berth' });
    // Tracks are validated and kept as data; nothing here plays them.
    expect(art.tracks).toMatchObject({ timingUnit: 'milliseconds', fps: 8, mode: 'tidal-gate', effectAttachmentPx: [56, 28], sharedFxRef: 'departure' });
    expect(art.tracks!.departure).toHaveLength(8);
    expect(art.tracks!.return[7]).toEqual({ frame: 7, offsetPx: [0, 0], opacity: 1 });
    expect(art.awayComposition).toBe('intact + ambient; no vehicle');
    expect(art.bindingSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(berthRestFrameKey(art)).toBe('pe_berth_starter_intact_f1');
  });

  it('states the authored dock translation ONCE: attachment − contact equals dockOffsetPx and the docked origin is [0, −34]', () => {
    expect(art.dockTranslation).toEqual([0, -27]);
    // berth origin (bottom pivot) → vehicle origin (contact): −[56,112] + [0,−27] + [56,105]
    expect(dockedVehicleOffset(art)).toEqual([0, -34]);
    // Disagreement between the two statements refuses the family rather than applying either.
    const disagree = sidecar((s) => { (s.identity['geometry'] as { starter: Record<string, unknown> }).starter['dockOffsetPx'] = [0, -54]; });
    expect(disagree).toBe(EMPTY_STARTER_FLEET_ART);
    expect(dockedVehicleOffset(EMPTY_STARTER_FLEET_ART)).toBeNull();
  });

  it('C5: carries the track\'s shared gate-effect reference as data (a name or null); anything else refuses the family', () => {
    const starterTrack = (s: { tracks: unknown }) => (s.tracks as { families: { starter: Record<string, unknown> } }).families.starter;
    expect(sidecar((s) => { starterTrack(s)['sharedFxRef'] = null; }).tracks).toMatchObject({ sharedFxRef: null, effectAttachmentPx: [56, 28] });
    expect(sidecar((s) => { delete starterTrack(s)['sharedFxRef']; }).tracks).toMatchObject({ sharedFxRef: null });
    for (const bad of [7, '', ['departure'], {}]) {
      expect(sidecar((s) => { starterTrack(s)['sharedFxRef'] = bad; }), JSON.stringify(bad)).toBe(EMPTY_STARTER_FLEET_ART);
    }
  });

  it('refuses a legacy, defective or partial sidecar into the empty table (never a boot failure)', () => {
    expect(parseStarterFleetMetadata(undefined, undefined, undefined)).toBe(EMPTY_STARTER_FLEET_ART);
    expect(parseStarterFleetMetadata({ schemaVersion: 2 }, {}, {})).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { s.identity['atlas'] = 'pe_fleet'; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { s.identity['bindingSha256'] = 'nope'; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { delete s.clips[VEHICLE_DOCKED_CLIP]; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { s.clips['pe_veh_advanced_idle'] = s.clips['pe_veh_starter_idle']; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { (s.clips[BERTH_AMBIENT_CLIP] as { frames: Array<{ key: string }> }).frames[3]!.key = 'pe_berth_starter_ambient_f5'; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { (s.clips[BERTH_INTACT_CLIP] as Record<string, unknown>)['anchorPx'] = [56, 104]; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { (s.clips[VEHICLE_DOCKED_CLIP] as Record<string, unknown>)['anchorKind'] = 'cellBottomPivotX'; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { (s.clips['pe_fx_departure'] as Record<string, unknown>)['reducedMotionClip'] = 'pe_fx_missing'; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { (s.identity['geometry'] as { berth: Record<string, unknown> }).berth['footprint'] = [3, 2]; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { (s.identity['geometry'] as { berth: Record<string, unknown> }).berth['drawScale'] = 2; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { s.tracks = undefined; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(sidecar((s) => { (s.tracks as { families: { starter: { departure: unknown[] } } }).families.starter.departure = []; })).toBe(EMPTY_STARTER_FLEET_ART);
    expect(berthRestFrameKey(EMPTY_STARTER_FLEET_ART)).toBeNull();
  });
});

describe('starterFleetSeat', () => {
  it('seats every packed frame on its own authored anchor at world scale 1 and no other key', () => {
    expect(starterFleetSeat(art, 'pe_berth_starter_intact_f1')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    expect(starterFleetSeat(art, 'pe_berth_starter_ambient_f8')).toEqual({ origin: [0.5, 1], scale: 1, offsetGamePx: [0, 0] });
    expect(starterFleetSeat(art, 'pe_veh_starter_docked_f2')).toEqual({ origin: [0.5, 105 / 112], scale: 1, offsetGamePx: [0, 0] });
    expect(starterFleetSeat(art, 'pe_fx_departure_f1')).toEqual({ origin: [0.5, 0.5], scale: 1, offsetGamePx: [0, 0] });
    expect(starterFleetSeat(art, 'bld_berth_l1')).toBeNull();
    expect(starterFleetSeat(art, 'pe_market_t1_idle_f1')).toBeNull();
    expect(starterFleetSeat(EMPTY_STARTER_FLEET_ART, 'pe_berth_starter_intact_f1')).toBeNull();
    for (const key of ['pe_berth_starter_intact_f1', 'pe_veh_starter_travel_f8', 'pe_fx_return_still_f1']) expect(STARTER_FLEET_FRAME_KEY.test(key)).toBe(true);
    for (const key of ['pe_berth_starter_intact', 'pe_veh_cutter_idle_f1', 'pe_cos_market_t1_idle_f1']) expect(STARTER_FLEET_FRAME_KEY.test(key)).toBe(false);
  });
});

describe('selectStarterBerths', () => {
  const buildings = [BERTH, BERTH_2, KEEP];

  it('maps the server facts to per-berth presence: occupied, away, and a null installation as no starter there', () => {
    const sel = selectStarterBerths(facts([
      { buildingId: 'berth-1', installation: { family: 'starter', presence: 'occupied' } },
      { buildingId: 'berth-2', installation: null },
    ]), buildings);
    expect(sel.unavailable).toBe(false);
    expect([...sel.berths]).toEqual([['berth-1', 'occupied']]);
    const away = selectStarterBerths(facts([
      { buildingId: 'berth-1', installation: null },
      { buildingId: 'berth-2', installation: { family: 'starter', presence: 'away' } },
    ]), buildings);
    expect([...away.berths]).toEqual([['berth-2', 'away']]);
  });

  it('keeps ordinary art quietly for legacy absence and flags unavailable for a null field or any malformed fact', () => {
    expect(selectStarterBerths(undefined, buildings)).toEqual({ berths: new Map(), unavailable: false });
    expect(selectStarterBerths(null, buildings)).toEqual({ berths: new Map(), unavailable: true });
    expect(selectStarterBerths({ version: 2, berths: [] }, buildings).unavailable).toBe(true);
    expect(selectStarterBerths('occupied', buildings).unavailable).toBe(true);
    // Another family cannot become an empty starter berth; an unknown presence is refused.
    expect(selectStarterBerths(facts([{ buildingId: 'berth-1', installation: { family: 'cargo-cutter', presence: 'occupied' } }, { buildingId: 'berth-2', installation: null }]), buildings).unavailable).toBe(true);
    expect(selectStarterBerths(facts([{ buildingId: 'berth-1', installation: { family: 'starter', presence: 'docked' } }, { buildingId: 'berth-2', installation: null }]), buildings).unavailable).toBe(true);
    // The closure must name every berth of the base exactly once, and only berths.
    expect(selectStarterBerths(facts([{ buildingId: 'berth-1', installation: null }]), buildings).unavailable).toBe(true);
    expect(selectStarterBerths(facts([{ buildingId: 'berth-1', installation: null }, { buildingId: 'berth-1', installation: null }, { buildingId: 'berth-2', installation: null }]), buildings).unavailable).toBe(true);
    expect(selectStarterBerths(facts([{ buildingId: 'keep', installation: null }, { buildingId: 'berth-1', installation: null }, { buildingId: 'berth-2', installation: null }]), buildings).unavailable).toBe(true);
    // A presence on an under-construction berth is impossible on the server; refuse rather than paint a starter on a scaffold.
    expect(selectStarterBerths(facts([{ buildingId: 'berth-1', installation: { family: 'starter', presence: 'occupied' } }, { buildingId: 'berth-2', installation: null }]),
      [{ ...BERTH, underConstruction: true }, BERTH_2, KEEP]).unavailable).toBe(true);
    // A base without berths matches an empty closure.
    expect(selectStarterBerths(facts([]), [KEEP])).toEqual({ berths: new Map(), unavailable: false });
  });
});
