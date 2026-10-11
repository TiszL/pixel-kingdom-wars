/**
 * Phase E starter fleet art (P4): the single optional 1x group `pe_fleet_starter`
 * read from the generated meta.json sidecar tables the asset packer emits —
 * `peStarterFleet` (identity, geometry, provenance, binding hash), `peClips`
 * (the eleven fleet clips) and `peTracks` (authored departure/return tracks).
 *
 * Presentation only. Nothing here decides gameplay: the berth's footprint, hit
 * area, depth and HP keep coming from the shared constants, and the server's
 * `servicePresentation` facts alone decide whether a starter is present on a
 * berth. This module turns those facts, plus the packed tables, into atlas
 * groups, frame keys, a seat and the ONE authored dock translation.
 *
 * The tracks are validated and carried as data only: no departure/return
 * playback, travel loop, gate effect or Wake attachment is selected here.
 *
 * Legacy sidecars (a rolling deploy, a stale asset checkout) parse to the EMPTY
 * table: consumers then request no fleet art and never fail to boot.
 */
import { STRUCTURES } from '@shardkeep/shared';

export const STARTER_FLEET_ART_REGISTRY_KEY = 'starterFleetArt';
export const STARTER_FLEET_ATLAS_GROUP = 'pe_fleet_starter';
export const BERTH_INTACT_CLIP = 'pe_berth_starter_intact';
export const BERTH_AMBIENT_CLIP = 'pe_berth_starter_ambient';
export const VEHICLE_DOCKED_CLIP = 'pe_veh_starter_docked';
/** Shared gate effects (authored once, referenced by every tidal-gate family's track). */
export const FX_DEPARTURE_CLIP = 'pe_fx_departure';
export const FX_RETURN_CLIP = 'pe_fx_return';

/** Every packed key of the group: `<clip>_f<N>` with N one-based. */
export const STARTER_FLEET_FRAME_KEY =
  /^(pe_(?:veh_starter_(?:idle|docked|travel)|berth_starter_(?:intact|damaged|destroyed|ambient)|fx_(?:departure|return)(?:_still)?))_f\d+$/;
const CLIP_ID = /^pe_(?:veh_starter_(?:idle|docked|travel)|berth_starter_(?:intact|damaged|destroyed|ambient)|fx_(?:departure|return)(?:_still)?)$/;
/** Clips the occupied/away composition needs; the family is refused without them. */
const REQUIRED_CLIPS = [
  'pe_berth_starter_intact', 'pe_berth_starter_damaged', 'pe_berth_starter_destroyed', 'pe_berth_starter_ambient',
  'pe_veh_starter_idle', 'pe_veh_starter_docked',
] as const;

export type FleetAnchorKind = 'cellBottomPivotX' | 'attachment' | 'centre';

export interface FleetClip {
  atlas: string;
  cellW: number;
  cellH: number;
  /** Cell-pixel origin: berth full-cell bottom pivot, vehicle contact, effect centre. */
  anchorPx: readonly [number, number];
  anchorKind: FleetAnchorKind;
  fps: number;
  loop: boolean;
  /** Zero-based frame shown when motion is reduced. */
  reducedMotionFrame: number;
  /** Separate authored reduced-motion still (effects only), or null. */
  reducedMotionClip: string | null;
  /** Ordered packed frame keys (`<clip>_f<N>`, N one-based). */
  frames: readonly string[];
}

export interface BerthGeometry {
  cell: readonly [number, number];
  footprint: readonly [number, number];
  horizontalPivot: number;
  sourceCellBottom: number;
  groundContact: readonly [number, number];
  attachment: readonly [number, number];
  tidalGate: readonly [number, number] | null;
}

export interface VehicleGeometry {
  cell: readonly [number, number];
  horizontalPivot: number;
  sourceCellBottom: number;
  contactPx: readonly [number, number];
  dockOffsetPx: readonly [number, number];
  berthRef: string;
}

export interface TrackStep { frame: number; offsetPx: readonly [number, number]; opacity: number }

/** Authored starter tracks, carried as DATA only (no playback in this package). */
export interface StarterTracks {
  timingUnit: string;
  fps: number;
  mode: string;
  departure: readonly TrackStep[];
  return: readonly TrackStep[];
  effectAttachmentPx: readonly [number, number];
  /** Named shared gate effect family, or null when the track departs without one. */
  sharedFxRef: string | null;
  reducedMotion: string;
}

export interface StarterFleetArtTable {
  atlas: string;
  clips: Readonly<Record<string, FleetClip>>;
  geometry: { starter: VehicleGeometry; berth: BerthGeometry } | null;
  /** The ONE authored dock translation (vehicle cell top-left − berth cell
   *  top-left), equal to berth attachment − vehicle contact. Applied once. */
  dockTranslation: readonly [number, number];
  tracks: StarterTracks | null;
  awayComposition: string;
  bindingSha256: string;
  sourceManifestSha256: string;
  sourceIndexSha256: string;
}

export const EMPTY_STARTER_FLEET_ART: StarterFleetArtTable = Object.freeze({
  atlas: '', clips: Object.freeze({}), geometry: null, dockTranslation: Object.freeze([0, 0] as const),
  tracks: null, awayComposition: '', bindingSha256: '', sourceManifestSha256: '', sourceIndexSha256: '',
});

const HEX64 = /^[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPair = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const isIntPair = (value: unknown): value is readonly [number, number] =>
  isPair(value) && Number.isInteger(value[0]) && Number.isInteger(value[1]);
const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const isHex64 = (value: unknown): value is string => typeof value === 'string' && HEX64.test(value);
const pair = (value: readonly [number, number]): readonly [number, number] => [value[0], value[1]];
const samePair = (a: readonly [number, number], b: readonly [number, number]): boolean => a[0] === b[0] && a[1] === b[1];

/** Exported for the advanced fleet table (P6a): the same berth rules, byte-exact. */
export function parseBerthGeometry(raw: unknown): BerthGeometry | null {
  if (!isRecord(raw)) return null;
  const { cell, footprint, horizontalPivot, sourceCellBottom, groundContact, attachment, tidalGate, drawScale } = raw;
  if (!isIntPair(cell) || cell[0] <= 0 || cell[1] <= 0 || !isIntPair(footprint)) return null;
  // The game footprint is the shared table's; art that disagrees is refused whole.
  const [fw, fh] = STRUCTURES.berth.footprint;
  if (footprint[0] !== fw || footprint[1] !== fh) return null;
  if (!isPositiveInt(horizontalPivot) || horizontalPivot > cell[0]) return null;
  // Full source-cell bottom seating: the pivot row IS the cell bottom.
  if (sourceCellBottom !== cell[1]) return null;
  if (!isIntPair(groundContact) || !isIntPair(attachment)) return null;
  if (attachment[0] < 0 || attachment[0] > cell[0] || attachment[1] < 0 || attachment[1] > cell[1]) return null;
  if (tidalGate !== null && !isIntPair(tidalGate)) return null;
  if (drawScale !== 1) return null;
  return {
    cell: pair(cell), footprint: pair(footprint), horizontalPivot, sourceCellBottom,
    groundContact: pair(groundContact), attachment: pair(attachment),
    tidalGate: tidalGate === null ? null : pair(tidalGate as readonly [number, number]),
  };
}

/** Exported for the advanced fleet table (P6a); `berthRef` names the berth the
 *  vehicle is authored against (`starter-berth` for the starter). */
export function parseVehicleGeometry(raw: unknown, berthRef = 'starter-berth'): VehicleGeometry | null {
  if (!isRecord(raw)) return null;
  const { cell, horizontalPivot, sourceCellBottom, contactPx, dockOffsetPx, drawScale } = raw;
  if (!isIntPair(cell) || cell[0] <= 0 || cell[1] <= 0) return null;
  if (!isPositiveInt(horizontalPivot) || horizontalPivot > cell[0]) return null;
  if (sourceCellBottom !== cell[1]) return null;
  if (!isIntPair(contactPx) || contactPx[0] < 0 || contactPx[0] > cell[0] || contactPx[1] < 0 || contactPx[1] > cell[1]) return null;
  if (!isIntPair(dockOffsetPx)) return null;
  if (raw['berthRef'] !== berthRef || drawScale !== 1) return null;
  return { cell: pair(cell), horizontalPivot, sourceCellBottom, contactPx: pair(contactPx), dockOffsetPx: pair(dockOffsetPx), berthRef };
}

/** Exported for the advanced fleet table (P6a). `frameDigestKey` names the
 *  per-frame RGBA digest field the generating exporter wrote (`sha256` for the
 *  starter tables, `rgbaSha256` for the advanced table); nothing else differs. */
export function parseClip(id: string, raw: unknown, atlas: string, keyIndexBase: number, frameDigestKey: 'sha256' | 'rgbaSha256' = 'sha256'): FleetClip | null {
  if (!isRecord(raw)) return null;
  const { cellW, cellH, anchorPx, anchorKind, fps, loop, reducedMotionFrame, reducedMotionClip, frames } = raw;
  if (!isPositiveInt(cellW) || !isPositiveInt(cellH) || !isIntPair(anchorPx)) return null;
  if (anchorKind !== 'cellBottomPivotX' && anchorKind !== 'attachment' && anchorKind !== 'centre') return null;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0) return null;
  if (typeof loop !== 'boolean') return null;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const reduced = reducedMotionFrame === undefined ? 0 : reducedMotionFrame;
  if (!Number.isInteger(reduced) || (reduced as number) < 0 || (reduced as number) >= frames.length) return null;
  if (reducedMotionClip !== undefined && (typeof reducedMotionClip !== 'string' || !reducedMotionClip)) return null;
  const keys: string[] = [];
  for (const [index, frame] of frames.entries()) {
    if (!isRecord(frame) || frame['key'] !== `${id}_f${index + keyIndexBase}`) return null;
    if (frame['sourceIndex'] !== index) return null;
    // The generated table hashes the full untrimmed RGBA cell.
    if (!isHex64(frame[frameDigestKey])) return null;
    keys.push(frame['key']);
  }
  return {
    atlas, cellW, cellH, anchorPx: pair(anchorPx), anchorKind, fps, loop,
    reducedMotionFrame: reduced as number,
    reducedMotionClip: typeof reducedMotionClip === 'string' ? reducedMotionClip : null,
    frames: keys,
  };
}

/** Exported for the advanced fleet table (P6a): authored track steps, data only. */
export function parseSteps(raw: unknown): readonly TrackStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: TrackStep[] = [];
  for (const [index, step] of raw.entries()) {
    if (!isRecord(step) || step['frame'] !== index || !isIntPair(step['offsetPx'])) return null;
    const opacity = step['opacity'];
    if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) return null;
    steps.push({ frame: index, offsetPx: pair(step['offsetPx']), opacity });
  }
  return steps;
}

function parseTracks(raw: unknown): StarterTracks | null {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1 || typeof raw['timingUnit'] !== 'string' || !raw['timingUnit']) return null;
  if (!isPositiveInt(raw['fps']) || !isRecord(raw['families'])) return null;
  const starter = raw['families']['starter'];
  if (!isRecord(starter) || typeof starter['mode'] !== 'string' || !starter['mode']) return null;
  const departure = parseSteps(starter['departure']);
  const back = parseSteps(starter['return']);
  if (!departure || !back || !isIntPair(starter['effectAttachmentPx'])) return null;
  if (typeof starter['reducedMotion'] !== 'string' || !starter['reducedMotion']) return null;
  const sharedFxRef = starter['sharedFxRef'];
  if (sharedFxRef !== undefined && sharedFxRef !== null && (typeof sharedFxRef !== 'string' || !sharedFxRef)) return null;
  return {
    timingUnit: raw['timingUnit'], fps: raw['fps'], mode: starter['mode'], departure, return: back,
    effectAttachmentPx: pair(starter['effectAttachmentPx']), sharedFxRef: typeof sharedFxRef === 'string' ? sharedFxRef : null,
    reducedMotion: starter['reducedMotion'],
  };
}

/**
 * meta.json `peStarterFleet` + `peClips` + `peTracks` → one typed table. Any
 * defect refuses the WHOLE family (a half table would let a berth animate while
 * its docked starter stays hidden). Never throws (BootScene registration).
 */
export function parseStarterFleetMetadata(peStarterFleet: unknown, peClips: unknown, peTracks: unknown): StarterFleetArtTable {
  if (!isRecord(peStarterFleet) || peStarterFleet['schemaVersion'] !== 1 || peStarterFleet['atlas'] !== STARTER_FLEET_ATLAS_GROUP
    || peStarterFleet['sourceScale'] !== 1 || peStarterFleet['sourceIndexBase'] !== 0 || peStarterFleet['keyIndexBase'] !== 1) {
    return EMPTY_STARTER_FLEET_ART;
  }
  for (const key of ['sourceManifestSha256', 'sourceTracksSha256', 'sourceFxManifestSha256', 'sourceIndexSha256',
    'provenanceSha256', 'fxProvenanceSha256', 'bindingSha256']) {
    if (!isHex64(peStarterFleet[key])) return EMPTY_STARTER_FLEET_ART;
  }
  if (typeof peStarterFleet['awayComposition'] !== 'string' || !peStarterFleet['awayComposition']) return EMPTY_STARTER_FLEET_ART;
  const geometryRaw = peStarterFleet['geometry'];
  if (!isRecord(geometryRaw)) return EMPTY_STARTER_FLEET_ART;
  const berth = parseBerthGeometry(geometryRaw['berth']);
  const starter = parseVehicleGeometry(geometryRaw['starter']);
  if (!berth || !starter) return EMPTY_STARTER_FLEET_ART;
  // The authored dock translation is stated twice (attachment/contact and
  // dockOffsetPx); they must agree, and it is applied ONCE by consumers.
  const dockTranslation: readonly [number, number] = [
    berth.attachment[0] - starter.contactPx[0], berth.attachment[1] - starter.contactPx[1],
  ];
  if (!samePair(dockTranslation, starter.dockOffsetPx)) return EMPTY_STARTER_FLEET_ART;

  if (!isRecord(peClips)) return EMPTY_STARTER_FLEET_ART;
  const clips: Record<string, FleetClip> = {};
  for (const [id, raw] of Object.entries(peClips)) {
    if (!CLIP_ID.test(id)) return EMPTY_STARTER_FLEET_ART;
    const clip = parseClip(id, raw, STARTER_FLEET_ATLAS_GROUP, 1);
    if (!clip) return EMPTY_STARTER_FLEET_ART;
    // Family rules: berth clips sit on the berth pivot at the berth cell,
    // vehicle clips on the vehicle contact at the vehicle cell, effects centred.
    if (id.startsWith('pe_berth_')) {
      if (clip.anchorKind !== 'cellBottomPivotX' || clip.cellW !== berth.cell[0] || clip.cellH !== berth.cell[1]
        || !samePair(clip.anchorPx, [berth.horizontalPivot, berth.sourceCellBottom])) return EMPTY_STARTER_FLEET_ART;
    } else if (id.startsWith('pe_veh_')) {
      if (clip.anchorKind !== 'attachment' || clip.cellW !== starter.cell[0] || clip.cellH !== starter.cell[1]
        || !samePair(clip.anchorPx, starter.contactPx)) return EMPTY_STARTER_FLEET_ART;
    } else if (clip.anchorKind !== 'centre' || !samePair(clip.anchorPx, [clip.cellW / 2, clip.cellH / 2])) {
      return EMPTY_STARTER_FLEET_ART;
    }
    clips[id] = clip;
  }
  for (const id of REQUIRED_CLIPS) if (!clips[id]) return EMPTY_STARTER_FLEET_ART;
  for (const clip of Object.values(clips)) {
    if (clip.reducedMotionClip && clips[clip.reducedMotionClip]?.frames.length !== 1) return EMPTY_STARTER_FLEET_ART;
  }
  const tracks = parseTracks(peTracks);
  if (!tracks) return EMPTY_STARTER_FLEET_ART;
  return Object.freeze({
    atlas: STARTER_FLEET_ATLAS_GROUP, clips: Object.freeze(clips), geometry: { starter, berth },
    dockTranslation: Object.freeze(dockTranslation), tracks, awayComposition: peStarterFleet['awayComposition'],
    bindingSha256: peStarterFleet['bindingSha256'] as string,
    sourceManifestSha256: peStarterFleet['sourceManifestSha256'] as string,
    sourceIndexSha256: peStarterFleet['sourceIndexSha256'] as string,
  });
}

export function starterFleetArtAvailable(art: StarterFleetArtTable): boolean {
  return art.geometry !== null && art.clips[BERTH_INTACT_CLIP] !== undefined;
}

/** Resting frame of a presented berth (`pe_berth_starter_intact_f1`), or null. */
export function berthRestFrameKey(art: StarterFleetArtTable): string | null {
  return starterFleetArtAvailable(art) ? art.clips[BERTH_INTACT_CLIP]?.frames[0] ?? null : null;
}

/** Seat for any packed fleet frame, null for every other key. World scale is 1:
 *  the 112 px cell is authored at the web world's 64 px tile. The origin is the
 *  clip's own anchor (berth bottom pivot, vehicle contact, effect centre). */
export function starterFleetSeat(
  art: StarterFleetArtTable, frame: string,
): { origin: readonly [number, number]; scale: number; offsetGamePx: readonly [number, number] } | null {
  const base = STARTER_FLEET_FRAME_KEY.exec(frame)?.[1];
  const clip = base ? art.clips[base] : undefined;
  if (!clip) return null;
  return { origin: [clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH], scale: 1, offsetGamePx: [0, 0] };
}

/**
 * Scene-pixel translation from a seated berth sprite's origin (its bottom
 * pivot) to the docked starter sprite's origin (its contact point), applying
 * the authored dock translation exactly ONCE:
 *   vehicle top-left = berth top-left + dockTranslation
 *   ⇒ vehicle origin = berth origin − berthPivot + dockTranslation + contact.
 * Authored values give [0, −34]. Null without geometry.
 */
export function dockedVehicleOffset(art: StarterFleetArtTable): readonly [number, number] | null {
  if (!art.geometry) return null;
  const { berth, starter } = art.geometry;
  return [
    -berth.horizontalPivot + art.dockTranslation[0] + starter.contactPx[0],
    -berth.sourceCellBottom + art.dockTranslation[1] + starter.contactPx[1],
  ];
}

export type StarterPresence = 'occupied' | 'away';

export interface StarterBerthSelection {
  /** buildingId → the server's current starter presence. Absent = ordinary art. */
  berths: ReadonlyMap<string, StarterPresence>;
  /** The facts were explicitly unavailable, malformed or inconsistent with the
   *  base: ordinary art is drawn, but nothing may claim a verified absence. */
  unavailable: boolean;
}

const NO_BERTHS: StarterBerthSelection = Object.freeze({ berths: new Map(), unavailable: false });

/**
 * Turn the server's `servicePresentation` (starter-only v1) into per-berth
 * presence. Legacy absence (`undefined`) selects ordinary art quietly. A null
 * field, a malformed row, a non-starter family, a berth closure that does not
 * match the base's berths, or a presence on an under-construction berth is
 * REFUSED whole: ordinary art, flagged. A per-berth null installation means
 * only that no starter is installed there — never an empty or advanced berth.
 */
export function selectStarterBerths(
  raw: unknown,
  buildings: readonly { id: string; type: string; underConstruction: boolean }[],
): StarterBerthSelection {
  if (raw === undefined) return NO_BERTHS;
  const refused: StarterBerthSelection = { berths: new Map(), unavailable: true };
  if (!isRecord(raw) || raw['version'] !== 1 || !Array.isArray(raw['berths'])) return refused;
  const berthRows = new Map(buildings.filter((b) => b.type === 'berth').map((b) => [b.id, b] as const));
  const seen = new Set<string>();
  const berths = new Map<string, StarterPresence>();
  for (const entry of raw['berths']) {
    if (!isRecord(entry) || typeof entry['buildingId'] !== 'string') return refused;
    const id = entry['buildingId'];
    const row = berthRows.get(id);
    if (!row || seen.has(id)) return refused;
    seen.add(id);
    const installation = entry['installation'];
    if (installation === null) continue;
    if (!isRecord(installation) || installation['family'] !== 'starter') return refused;
    const presence = installation['presence'];
    if (presence !== 'occupied' && presence !== 'away') return refused;
    if (row.underConstruction) return refused;
    berths.set(id, presence);
  }
  // The server closes over every berth, construction included.
  if (seen.size !== berthRows.size) return refused;
  return { berths, unavailable: false };
}
