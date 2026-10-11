/**
 * Phase E advanced fleet art (P6a): the twenty OPTIONAL 1x groups the asset
 * packer emits for the four accepted vehicle families — one berth group per
 * family (`pe_berth_<family>`: intact/damaged/destroyed stills + the ambient
 * loop) and one vehicle group per family and authored tier
 * (`pe_veh_<family>_t1..t4`: idle/docked/travel/exhausted) — read from the
 * generated `meta.peAdvancedFleet` sidecar table. Unlike the starter's three
 * tables, geometry rides on every clip and bindings are keyed by group.
 *
 * Presentation only, and the SAME law as the starter seam (fleetArt.ts): the
 * berth's footprint, hit area, depth and HP keep coming from the shared
 * constants; the server's facts alone (`advancedServicePresentation` for the
 * current base, the frozen raid sibling for a battle) decide which berth shows
 * which family at which tier and in which presence. This module turns those
 * facts plus the packed table into groups, frame keys, seats and the ONE
 * authored dock translation per family/tier, applied exactly once.
 *
 * Tracks are validated and carried as DATA only: no departure/return/travel
 * playback, gate effect or Wake attachment is selected here (owner holds).
 *
 * Legacy sidecars (a rolling deploy, a stale asset checkout) parse to the EMPTY
 * table: consumers then request no advanced art and never fail to boot.
 */
import { PHASE_E_VEHICLES, STRUCTURES } from '@shardkeep/shared';
import { PHASE_E_VEHICLE_FAMILY_IDS } from '@shardkeep/shared/phaseEVehicles';
import type { PhaseEVehicleFamily, PhaseEVehicleTier } from '@shardkeep/shared/phaseEVehicles';
import {
  STARTER_FLEET_ATLAS_GROUP, STARTER_FLEET_FRAME_KEY, parseBerthGeometry, parseClip, parseSteps, parseVehicleGeometry,
  type BerthGeometry, type FleetClip, type StarterPresence, type TrackStep, type VehicleGeometry,
} from './fleetArt';

export const ADVANCED_FLEET_ART_REGISTRY_KEY = 'advancedFleetArt';
export type AdvancedFleetFamily = PhaseEVehicleFamily;
export type AdvancedFleetTier = PhaseEVehicleTier;
export const ADVANCED_FLEET_FAMILIES: readonly AdvancedFleetFamily[] = PHASE_E_VEHICLE_FAMILY_IDS;
export const ADVANCED_FLEET_TIERS: readonly AdvancedFleetTier[] = PHASE_E_VEHICLES.tiers;
export const ADVANCED_BERTH_STATES = ['intact', 'damaged', 'destroyed', 'ambient'] as const;
export const ADVANCED_VEHICLE_STATES = ['idle', 'docked', 'travel', 'exhausted'] as const;
export type AdvancedBerthState = (typeof ADVANCED_BERTH_STATES)[number];
export type AdvancedVehicleState = (typeof ADVANCED_VEHICLE_STATES)[number];

const FAMILY_ALT = ADVANCED_FLEET_FAMILIES.join('|');
const TIER_ALT = ADVANCED_FLEET_TIERS.join('|');
/** Every packed key of the twenty groups: `<clip>_f<N>` with N one-based. */
export const ADVANCED_FLEET_FRAME_KEY = new RegExp(
  `^(pe_(?:berth_(?:${FAMILY_ALT})_(?:intact|damaged|destroyed|ambient)|veh_(?:${FAMILY_ALT})_t(?:${TIER_ALT})_(?:idle|docked|travel|exhausted)))_f\\d+$`,
);
const BERTH_CLIP_ID = new RegExp(`^pe_berth_(${FAMILY_ALT})_(intact|damaged|destroyed|ambient)$`);
const VEHICLE_CLIP_ID = new RegExp(`^pe_veh_(${FAMILY_ALT})_t(${TIER_ALT})_(idle|docked|travel|exhausted)$`);
const HEX64 = /^[0-9a-f]{64}$/;

export function advancedBerthGroup(family: AdvancedFleetFamily): string { return `pe_berth_${family}`; }
export function advancedVehicleGroup(family: AdvancedFleetFamily, tier: AdvancedFleetTier): string { return `pe_veh_${family}_t${tier}`; }
/** The source pack names families with dashes and each berth `<family>-berth`. */
const sourceFamily = (family: AdvancedFleetFamily): string => family.replaceAll('_', '-');

export interface AdvancedBerthArt {
  family: AdvancedFleetFamily;
  group: string;
  geometry: BerthGeometry;
}

export interface AdvancedVehicleArt {
  family: AdvancedFleetFamily;
  tier: AdvancedFleetTier;
  group: string;
  geometry: VehicleGeometry;
  /** The ONE authored dock translation (vehicle cell top-left − berth cell
   *  top-left) = berth attachment − vehicle contact; equals `dockOffsetPx`. */
  dockTranslation: readonly [number, number];
}

/** Authored family tracks, carried as DATA only (no playback in this package). */
export interface AdvancedTrack {
  mode: string;
  /** Steps per second shared by every family track (the table's fps). */
  fps: number;
  departure: readonly TrackStep[];
  return: readonly TrackStep[];
  /** Named shared gate effect family (tidal-gate berths), or null (vertical lift-off). */
  sharedFxRef: string | null;
  /** Where that effect sits, in berth cell pixels. */
  effectAttachmentPx: readonly [number, number];
  reducedMotion: string;
}

export interface AdvancedFleetArtTable {
  clips: Readonly<Record<string, FleetClip>>;
  berths: ReadonlyMap<AdvancedFleetFamily, AdvancedBerthArt>;
  /** `${family}:${tier}` → vehicle art. */
  vehicles: ReadonlyMap<string, AdvancedVehicleArt>;
  tracks: ReadonlyMap<AdvancedFleetFamily, AdvancedTrack>;
  sourceManifestSha256: string;
  sourceTracksSha256: string;
  sourceIndexSha256: string;
}

export const EMPTY_ADVANCED_FLEET_ART: AdvancedFleetArtTable = Object.freeze({
  clips: Object.freeze({}), berths: new Map(), vehicles: new Map(), tracks: new Map(),
  sourceManifestSha256: '', sourceTracksSha256: '', sourceIndexSha256: '',
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isHex64 = (value: unknown): value is string => typeof value === 'string' && HEX64.test(value);
const vehicleKey = (family: AdvancedFleetFamily, tier: AdvancedFleetTier): string => `${family}:${tier}`;
const sameGeometry = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const isIntPair = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => Number.isInteger(n));

function parseTrack(raw: unknown, fps: number): AdvancedTrack | null {
  if (!isRecord(raw) || typeof raw['mode'] !== 'string' || !raw['mode']) return null;
  const departure = parseSteps(raw['departure']);
  const back = parseSteps(raw['return']);
  if (!departure || !back || !isIntPair(raw['effectAttachmentPx'])) return null;
  if (typeof raw['reducedMotion'] !== 'string' || !raw['reducedMotion']) return null;
  const sharedFxRef = raw['sharedFxRef'];
  if (sharedFxRef !== undefined && sharedFxRef !== null && (typeof sharedFxRef !== 'string' || !sharedFxRef)) return null;
  return {
    mode: raw['mode'], fps, departure, return: back, sharedFxRef: typeof sharedFxRef === 'string' ? sharedFxRef : null,
    effectAttachmentPx: [raw['effectAttachmentPx'][0], raw['effectAttachmentPx'][1]], reducedMotion: raw['reducedMotion'],
  };
}

/**
 * meta.json `peAdvancedFleet` → one typed table, or EMPTY. ALL-OR-NOTHING
 * (starter/service precedent): a half table would let one family's berth
 * animate while its docked vehicle stayed hidden, or draw a tier whose
 * sibling tier refuses. Never throws (BootScene registration).
 */
export function parseAdvancedFleetMetadata(raw: unknown): AdvancedFleetArtTable {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1 || raw['sourceScale'] !== 1
    || raw['sourceIndexBase'] !== 0 || raw['keyIndexBase'] !== 1) return EMPTY_ADVANCED_FLEET_ART;
  for (const key of ['sourceManifestSha256', 'sourceTracksSha256', 'sourceIndexSha256', 'provenanceSha256']) {
    if (!isHex64(raw[key])) return EMPTY_ADVANCED_FLEET_ART;
  }
  // Exactly the twenty optional groups, each once.
  const expectedGroups = new Set<string>();
  for (const family of ADVANCED_FLEET_FAMILIES) {
    expectedGroups.add(advancedBerthGroup(family));
    for (const tier of ADVANCED_FLEET_TIERS) expectedGroups.add(advancedVehicleGroup(family, tier));
  }
  const atlases = raw['atlases'];
  if (!Array.isArray(atlases) || atlases.length !== expectedGroups.size || new Set(atlases).size !== atlases.length
    || !atlases.every((g) => typeof g === 'string' && expectedGroups.has(g))) return EMPTY_ADVANCED_FLEET_ART;

  if (!isRecord(raw['clips'])) return EMPTY_ADVANCED_FLEET_ART;
  const clips: Record<string, FleetClip> = {};
  const berths = new Map<AdvancedFleetFamily, AdvancedBerthArt>();
  const vehicles = new Map<string, AdvancedVehicleArt>();
  const berthGeometryRaw = new Map<AdvancedFleetFamily, unknown>();
  const vehicleGeometryRaw = new Map<string, unknown>();
  for (const [id, clipRaw] of Object.entries(raw['clips'])) {
    if (!isRecord(clipRaw)) return EMPTY_ADVANCED_FLEET_ART;
    const berthMatch = BERTH_CLIP_ID.exec(id);
    const vehicleMatch = VEHICLE_CLIP_ID.exec(id);
    if (!berthMatch && !vehicleMatch) return EMPTY_ADVANCED_FLEET_ART;
    const family = (berthMatch?.[1] ?? vehicleMatch?.[1]) as AdvancedFleetFamily;
    const group = berthMatch ? advancedBerthGroup(family) : advancedVehicleGroup(family, Number(vehicleMatch![2]) as AdvancedFleetTier);
    // The table states each clip's group explicitly; it must be the id's own.
    if (clipRaw['atlas'] !== group) return EMPTY_ADVANCED_FLEET_ART;
    const clip = parseClip(id, clipRaw, group, 1, 'rgbaSha256');
    if (!clip) return EMPTY_ADVANCED_FLEET_ART;
    if (berthMatch) {
      // Berth rules: full-cell bottom pivot at the berth cell; one geometry per family.
      const geometry = parseBerthGeometry(clipRaw['geometry']);
      if (!geometry || clip.anchorKind !== 'cellBottomPivotX' || clip.cellW !== geometry.cell[0] || clip.cellH !== geometry.cell[1]
        || clip.anchorPx[0] !== geometry.horizontalPivot || clip.anchorPx[1] !== geometry.sourceCellBottom) return EMPTY_ADVANCED_FLEET_ART;
      const prior = berthGeometryRaw.get(family);
      if (prior === undefined) {
        berthGeometryRaw.set(family, clipRaw['geometry']);
        berths.set(family, { family, group, geometry });
      } else if (!sameGeometry(prior, clipRaw['geometry'])) return EMPTY_ADVANCED_FLEET_ART;
    } else {
      // Vehicle rules: anchored on its own contact at the vehicle cell, authored
      // against its family berth; one geometry per family/tier.
      const tier = Number(vehicleMatch![2]) as AdvancedFleetTier;
      const geometry = parseVehicleGeometry(clipRaw['geometry'], `${sourceFamily(family)}-berth`);
      if (!geometry || clip.anchorKind !== 'attachment' || clip.cellW !== geometry.cell[0] || clip.cellH !== geometry.cell[1]
        || clip.anchorPx[0] !== geometry.contactPx[0] || clip.anchorPx[1] !== geometry.contactPx[1]) return EMPTY_ADVANCED_FLEET_ART;
      const key = vehicleKey(family, tier);
      const prior = vehicleGeometryRaw.get(key);
      if (prior === undefined) {
        vehicleGeometryRaw.set(key, clipRaw['geometry']);
        vehicles.set(key, { family, tier, group, geometry, dockTranslation: geometry.dockOffsetPx });
      } else if (!sameGeometry(prior, clipRaw['geometry'])) return EMPTY_ADVANCED_FLEET_ART;
    }
    clips[id] = clip;
  }
  // Completeness: every family's four berth states, every family/tier's four
  // vehicle states, and the authored dock translation stated twice and agreeing.
  for (const family of ADVANCED_FLEET_FAMILIES) {
    const berth = berths.get(family);
    if (!berth) return EMPTY_ADVANCED_FLEET_ART;
    for (const state of ADVANCED_BERTH_STATES) if (!clips[`pe_berth_${family}_${state}`]) return EMPTY_ADVANCED_FLEET_ART;
    for (const tier of ADVANCED_FLEET_TIERS) {
      const vehicle = vehicles.get(vehicleKey(family, tier));
      if (!vehicle) return EMPTY_ADVANCED_FLEET_ART;
      for (const state of ADVANCED_VEHICLE_STATES) if (!clips[`pe_veh_${family}_t${tier}_${state}`]) return EMPTY_ADVANCED_FLEET_ART;
      const stated = vehicle.geometry.dockOffsetPx;
      const derived: readonly [number, number] = [
        berth.geometry.attachment[0] - vehicle.geometry.contactPx[0], berth.geometry.attachment[1] - vehicle.geometry.contactPx[1],
      ];
      if (stated[0] !== derived[0] || stated[1] !== derived[1]) return EMPTY_ADVANCED_FLEET_ART;
    }
  }
  for (const clip of Object.values(clips)) {
    if (clip.reducedMotionClip && clips[clip.reducedMotionClip]?.frames.length !== 1) return EMPTY_ADVANCED_FLEET_ART;
  }
  // Bindings: exactly the twenty groups, each pinned to this table's sources and
  // naming only clips packed under that group.
  const bindings = raw['bindings'];
  if (!isRecord(bindings) || Object.keys(bindings).length !== expectedGroups.size) return EMPTY_ADVANCED_FLEET_ART;
  for (const [group, entry] of Object.entries(bindings)) {
    if (!expectedGroups.has(group) || !isRecord(entry) || !isHex64(entry['sha256'])) return EMPTY_ADVANCED_FLEET_ART;
    const value = entry['value'];
    if (!isRecord(value) || value['version'] !== 1 || value['atlas'] !== group
      || value['sourceManifestSha256'] !== raw['sourceManifestSha256'] || value['sourceTracksSha256'] !== raw['sourceTracksSha256']
      || value['sourceIndexSha256'] !== raw['sourceIndexSha256']) return EMPTY_ADVANCED_FLEET_ART;
    const berth = group.startsWith('pe_berth_');
    if (value['kind'] !== (berth ? 'berth' : 'vehicle')) return EMPTY_ADVANCED_FLEET_ART;
    if (!Array.isArray(value['clips']) || value['clips'].length === 0) return EMPTY_ADVANCED_FLEET_ART;
    for (const clip of value['clips']) {
      const id = isRecord(clip) ? clip['id'] : clip;
      if (typeof id !== 'string' || clips[id]?.atlas !== group) return EMPTY_ADVANCED_FLEET_ART;
    }
  }
  // Tracks: one authored track per family (dash-named in the source), data only.
  const tracksRaw = raw['tracks'];
  if (!isRecord(tracksRaw) || tracksRaw['schemaVersion'] !== 1 || !isRecord(tracksRaw['families'])) return EMPTY_ADVANCED_FLEET_ART;
  const fps = tracksRaw['fps'];
  if (typeof fps !== 'number' || !Number.isInteger(fps) || fps <= 0) return EMPTY_ADVANCED_FLEET_ART;
  const tracks = new Map<AdvancedFleetFamily, AdvancedTrack>();
  for (const family of ADVANCED_FLEET_FAMILIES) {
    const track = parseTrack(tracksRaw['families'][sourceFamily(family)], fps);
    if (!track) return EMPTY_ADVANCED_FLEET_ART;
    tracks.set(family, track);
  }
  return Object.freeze({
    clips: Object.freeze(clips), berths, vehicles, tracks,
    sourceManifestSha256: raw['sourceManifestSha256'] as string,
    sourceTracksSha256: raw['sourceTracksSha256'] as string,
    sourceIndexSha256: raw['sourceIndexSha256'] as string,
  });
}

export function advancedFleetArtAvailable(art: AdvancedFleetArtTable): boolean {
  return art.berths.size === ADVANCED_FLEET_FAMILIES.length;
}

export function advancedVehicleArt(art: AdvancedFleetArtTable, family: AdvancedFleetFamily, tier: AdvancedFleetTier): AdvancedVehicleArt | null {
  return art.vehicles.get(vehicleKey(family, tier)) ?? null;
}

/** A berth's still for a presented family (`pe_berth_<family>_<state>_f1`), or null. */
export function advancedBerthFrameKey(
  art: AdvancedFleetArtTable, family: AdvancedFleetFamily, state: 'intact' | 'damaged' | 'destroyed' = 'intact',
): string | null {
  if (!art.berths.has(family)) return null;
  return art.clips[`pe_berth_${family}_${state}`]?.frames[0] ?? null;
}

/** The packed group an advanced fleet frame key lives in, null for every other key. */
export function advancedFleetGroupOf(frame: string): string | null {
  const base = ADVANCED_FLEET_FRAME_KEY.exec(frame)?.[1];
  if (!base) return null;
  const berth = BERTH_CLIP_ID.exec(base);
  if (berth) return advancedBerthGroup(berth[1] as AdvancedFleetFamily);
  const vehicle = VEHICLE_CLIP_ID.exec(base)!;
  return advancedVehicleGroup(vehicle[1] as AdvancedFleetFamily, Number(vehicle[2]) as AdvancedFleetTier);
}

/** Seat for any packed advanced fleet frame, null for every other key. World
 *  scale is 1 (112 px cells authored at the web world's 64 px tile); the origin
 *  is the clip's own anchor (berth bottom pivot, vehicle contact). */
export function advancedFleetSeat(
  art: AdvancedFleetArtTable, frame: string,
): { origin: readonly [number, number]; scale: number; offsetGamePx: readonly [number, number] } | null {
  const base = ADVANCED_FLEET_FRAME_KEY.exec(frame)?.[1];
  const clip = base ? art.clips[base] : undefined;
  if (!clip) return null;
  return { origin: [clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH], scale: 1, offsetGamePx: [0, 0] };
}

/**
 * Scene-pixel translation from a seated berth sprite's origin (its bottom
 * pivot) to the docked vehicle sprite's origin (its contact point), applying
 * the family/tier's authored dock translation exactly ONCE (fleetArt.ts
 * #dockedVehicleOffset, same derivation). Null without that family/tier.
 */
export function advancedDockedVehicleOffset(
  art: AdvancedFleetArtTable, family: AdvancedFleetFamily, tier: AdvancedFleetTier,
): readonly [number, number] | null {
  const berth = art.berths.get(family);
  const vehicle = art.vehicles.get(vehicleKey(family, tier));
  if (!berth || !vehicle) return null;
  return [
    -berth.geometry.horizontalPivot + vehicle.dockTranslation[0] + vehicle.geometry.contactPx[0],
    -berth.geometry.sourceCellBottom + vehicle.dockTranslation[1] + vehicle.geometry.contactPx[1],
  ];
}

// ── Facts → per-berth installation ──────────────────────────────────────────

export type AdvancedPresence = 'occupied' | 'away' | 'exhausted';

/** What the server names for one berth: the starter (occupied/away) or one
 *  advanced family at its applied tier. Never derived from art or time. */
export type BerthInstallation =
  | { family: 'starter'; presence: StarterPresence }
  | { family: AdvancedFleetFamily; tier: AdvancedFleetTier; presence: AdvancedPresence };

export interface BerthFactsSelection {
  /** buildingId → the named installation. Absent = no presented installation. */
  berths: ReadonlyMap<string, BerthInstallation>;
  /** Some fact was explicitly unavailable, malformed, inconsistent with the
   *  base, or two positive installations conflicted: nothing may claim a
   *  verified absence; every berth stays on the unavailable-art path. */
  unavailable: boolean;
}

const NO_FACTS: BerthFactsSelection = Object.freeze({ berths: new Map(), unavailable: false });
const REFUSED: BerthFactsSelection = Object.freeze({ berths: new Map(), unavailable: true });

type BerthRow = { id: string; type: string; level: number; underConstruction: boolean };
type FactsResult = 'legacy' | 'refused' | Map<string, BerthInstallation>;

function parseInstallation(raw: unknown, sibling: 'starter' | 'advanced'): BerthInstallation | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  if (sibling === 'starter') {
    if (raw['family'] !== 'starter' || (raw['presence'] !== 'occupied' && raw['presence'] !== 'away')) return undefined;
    return { family: 'starter', presence: raw['presence'] };
  }
  const family = raw['family'];
  const tier = raw['tier'];
  const presence = raw['presence'];
  if (typeof family !== 'string' || !(ADVANCED_FLEET_FAMILIES as readonly string[]).includes(family)) return undefined;
  if (typeof tier !== 'number' || !(ADVANCED_FLEET_TIERS as readonly number[]).includes(tier)) return undefined;
  if (presence !== 'occupied' && presence !== 'away' && presence !== 'exhausted') return undefined;
  return { family: family as AdvancedFleetFamily, tier: tier as AdvancedFleetTier, presence };
}

/**
 * One sibling's facts against the base's berth rows. `mode` carries the two
 * accepted rules that differ between contexts and must never be shared:
 *  - current: every berth row participates; a row under construction (or at
 *    level 0) may carry only a null installation; the closure must name every
 *    current berth exactly once (D242: version 1 closes all current berths);
 *  - frozen: the closure must equal the snapshot's berth rows sorted by id; a
 *    berth under construction is refused outright (D235/D238 parsers).
 * A starter sibling admits at most one installation per base (D235).
 */
function readFacts(raw: unknown, sibling: 'starter' | 'advanced', mode: 'current' | 'frozen', rows: readonly BerthRow[]): FactsResult {
  if (raw === undefined) return 'legacy';
  if (!isRecord(raw) || raw['version'] !== 1 || !Array.isArray(raw['berths'])) return 'refused';
  const berthRows = rows.filter((b) => b.type === 'berth');
  if (new Set(berthRows.map((b) => b.id)).size !== berthRows.length) return 'refused';
  const byId = new Map(berthRows.map((b) => [b.id, b] as const));
  const entries = raw['berths'] as unknown[];
  if (entries.length !== berthRows.length) return 'refused';
  const seen = new Set<string>();
  const out = new Map<string, BerthInstallation>();
  let previous: string | null = null;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry['buildingId'] !== 'string') return 'refused';
    const id = entry['buildingId'];
    const row = byId.get(id);
    if (!row || seen.has(id)) return 'refused';
    seen.add(id);
    if (mode === 'frozen') {
      if (previous !== null && previous >= id) return 'refused';
      previous = id;
      if (row.underConstruction) return 'refused';
    }
    const installation = parseInstallation(entry['installation'], sibling);
    if (installation === undefined) return 'refused';
    if (installation === null) continue;
    if (row.underConstruction || row.level < 1) return 'refused';
    out.set(id, installation);
  }
  if (sibling === 'starter' && out.size > 1) return 'refused';
  return out;
}

function selectBerthFacts(
  starterRaw: unknown, advancedRaw: unknown, mode: 'current' | 'frozen', rows: readonly BerthRow[],
): BerthFactsSelection {
  const starter = readFacts(starterRaw, 'starter', mode, rows);
  const advanced = readFacts(advancedRaw, 'advanced', mode, rows);
  if (starter === 'legacy' && advanced === 'legacy') return NO_FACTS;
  // A whole-null field or any malformed sibling keeps EVERY berth on the
  // unavailable-art path: a half-trusted pair could show one sibling's
  // installation while the other's facts are unknown.
  if (starter === 'refused' || advanced === 'refused' || starterRaw === null || advancedRaw === null) return REFUSED;
  const berths = new Map<string, BerthInstallation>();
  if (advanced !== 'legacy') for (const [id, installation] of advanced) berths.set(id, installation);
  if (starter !== 'legacy') {
    for (const [id, installation] of starter) {
      // Two positive installations on one berth (forbidden at admission) are a
      // source fault: refuse both and the whole presentation, never prefer one.
      if (berths.has(id)) return REFUSED;
      berths.set(id, installation);
    }
  }
  return { berths, unavailable: false };
}

/** CURRENT base: `servicePresentation` (starter v1) + `advancedServicePresentation`
 *  (advanced v1) against the current building rows. */
export function selectCurrentBerths(
  servicePresentation: unknown, advancedServicePresentation: unknown, buildings: readonly BerthRow[],
): BerthFactsSelection {
  return selectBerthFacts(servicePresentation, advancedServicePresentation, 'current', buildings);
}

/** FROZEN raid: both siblings from the raid payload against the snapshot's
 *  rows — never a current read, never a clock. */
export function selectFrozenBerths(
  servicePresentation: unknown, advancedServicePresentation: unknown,
  snapshotBuildings: readonly { id: string; type: string; level: number; underConstruction?: boolean | undefined }[],
): BerthFactsSelection {
  const rows = snapshotBuildings.map((b) => ({ id: b.id, type: b.type, level: b.level, underConstruction: b.underConstruction === true }));
  return selectBerthFacts(servicePresentation, advancedServicePresentation, 'frozen', rows);
}

/** `STRUCTURES.berth.footprint` for any advanced fleet frame key (the game
 *  footprint is the shared table's, never the art's). */
export function advancedFleetFootprint(frame: string): readonly [number, number] | null {
  return ADVANCED_FLEET_FRAME_KEY.test(frame) ? STRUCTURES.berth.footprint : null;
}

/**
 * The key of a berth with NO admitted appearance (D-c): explicit per-berth
 * null, legacy or unavailable facts, malformed facts, construction, or a named
 * family whose table is not admitted. The ordinary `bld` sheet has no berth
 * cell, so the scenes draw a hidden frameless 2×2 footprint with normal
 * selection geometry — an unavailable-art policy, never a vacancy claim.
 */
export const BERTH_UNPRESENTED_KEY = 'pe_berth_unpresented';

/** The texture a berth key is created on: the starter group, the advanced
 *  group, or the always-loaded ordinary sheet (frameless, hidden) for the
 *  unpresented key. Null for a key that is not a berth key at all. */
export function berthKeyGroup(key: string): string | null {
  if (key === BERTH_UNPRESENTED_KEY) return 'bld';
  if (STARTER_FLEET_FRAME_KEY.test(key)) return STARTER_FLEET_ATLAS_GROUP;
  return advancedFleetGroupOf(key);
}
