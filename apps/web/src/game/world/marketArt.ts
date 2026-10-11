/**
 * Phase E Market art (C3): the ordinary `pe_market_t<T>` groups and the bound
 * Artisan Awning `pe_cosmetics` group, read from the generated meta.json
 * sidecar tables (`peMarket`, `peCosmetics`) that the asset packer emits.
 *
 * P5 widens the same table to the two ordinary service families of the
 * accepted Workshop/Lodge pack (`peServiceBuildings`: `pe_workshop_t<T>`,
 * `pe_lodge_t<T>`), validated on their own so a defective family never
 * touches the accepted Market/Awning art. Two consumer policies apply ONLY
 * inside validated Workshop/Lodge metadata: an absent `reducedMotionFrame`
 * is read as frame 0 (this consumer's static accessibility policy, not an
 * authored fact; an explicit invalid value still refuses), and a clip's
 * authored `playbackFrameIndices` select the frames actually played (the
 * Workshop working grid excludes its duplicate endpoint). Working/ready
 * are never selected at home by any consumer of this table (D5).
 *
 * Presentation only. Nothing here decides gameplay: the Market's footprint,
 * hit area, depth and HP keep coming from the shared constants, and the
 * server's `boundCosmetics` / `boundCosmeticVisual` projection alone decides
 * whether an Awning applies. This module only turns that decision, plus the
 * packed clip tables, into atlas groups, frame keys and a seat.
 *
 * Legacy sidecars (a rolling deploy, a stale asset checkout) parse to the EMPTY
 * table: consumers then request no Market art and never fail to boot.
 */
import { STRUCTURES, atlasGroupFor } from '@shardkeep/shared';
import type { RealmId } from '@shardkeep/shared/baseVisual';
import { HARVESTER_FRAME_KEY, HARVESTER_UNPRESENTED_KEY, parseHarvesterArtMetadata } from './harvesterArt';
import {
  boundCosmeticAwningForCompletedLevel, matchBoundCosmeticBaseRead,
  type BoundCosmeticAwningId, type BoundCosmeticBaseRead, type BoundCosmeticVisualBuilding,
} from '@shardkeep/shared/boundCosmeticVisual';

export const MARKET_ART_REGISTRY_KEY = 'marketArt';
export const AWNING_ATLAS_GROUP = 'pe_cosmetics';

/** Families that share the Market clip contract and seat. Awnings are Market-only. */
export type MarketArtFamily = 'market' | 'workshop' | 'lodge' | 'harvester';
export const SERVICE_ART_FAMILIES = ['workshop', 'lodge'] as const;
export const SERVICE_ART_STATES = ['idle', 'working', 'ready', 'damaged', 'construction', 'collapse', 'destroyed'] as const;
const SERVICE_CLIP_ID = /^pe_(workshop|lodge)_t([1-4])_(idle|working|ready|damaged|construction|collapse|destroyed|ready_fx)$/;

/** The service type of a building row, or null for every other building. */
export function marketArtFamilyOf(type: string): MarketArtFamily | null {
  return type === 'market' || type === 'workshop' || type === 'lodge' || type === 'harvester' ? type : null;
}

/** Authored Market states. Home consumers select idle/construction only;
 *  combat adds damaged/collapse/destroyed from real HP/state events. */
export type MarketArtState =
  | 'idle' | 'construction' | 'working' | 'ready' | 'damaged' | 'collapse' | 'destroyed';

export interface MarketClip {
  /** On-demand atlas group that packs every frame of this clip. */
  atlas: string;
  cellW: number;
  cellH: number;
  /** Full-cell anchor in cell pixels ([56,112] = bottom-centre of a 112 cell). */
  anchorPx: readonly [number, number];
  /** Authored contact pivot, preserved separately from the seat (never applied). */
  sourcePivot: readonly [number, number] | null;
  fps: number;
  loop: boolean;
  /** Zero-based frame shown when motion is reduced. */
  reducedMotionFrame: number;
  /** Ordered packed frame keys (`<clip>_f<N>`, N one-based). */
  frames: readonly string[];
  /** Authored zero-based indices into `frames` that playback uses (P5), or
   *  null when every packed frame plays in order. */
  playbackFrameIndices: readonly number[] | null;
  /** Ready-state craft-success overlay (clip id + offset in cell pixels). */
  overlay: { clip: string; offset: readonly [number, number] } | null;
  /** Clip whose packed frames this state reuses (ready aliases idle). */
  alias: string | null;
}

export interface AwningBinding {
  sha256: string;
  sourceManifestSha256: string;
  sourceIndexSha256: string;
  /** Clip ids the binding publishes; all must exist in `clips`. */
  clips: readonly string[];
}

export interface MarketArtTable {
  /** Both families share one namespace: `pe_market_t<T>_<state>`, `pe_cos_market_t<T>_<state>`. */
  clips: Readonly<Record<string, MarketClip>>;
  /** Awning outputId → exact generated binding (hash equality gates application). */
  bindings: Readonly<Record<string, AwningBinding>>;
}

export const EMPTY_MARKET_ART: MarketArtTable = Object.freeze({
  clips: Object.freeze({}), bindings: Object.freeze({}),
});

const HEX64 = /^[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPair = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Consumer policy for one family: `absentReducedMotionFrame` null = the packer
 *  must author it (Market/Awning, unchanged); a number = the frame this consumer
 *  shows when the field is absent (validated Workshop/Lodge only, D1). */
interface ClipPolicy { absentReducedMotionFrame: number | null }
const MARKET_POLICY: ClipPolicy = { absentReducedMotionFrame: null };
const SERVICE_POLICY: ClipPolicy = { absentReducedMotionFrame: 0 };

function parseClip(id: string, raw: unknown, allowedGroups: ReadonlySet<string>, keyIndexBase: number, policy: ClipPolicy = MARKET_POLICY): MarketClip | null {
  if (!isRecord(raw)) return null;
  const { cellW, cellH, anchorPx, sourcePivot, fps, loop, frames, overlay, alias, playbackFrameIndices } = raw;
  const reducedMotionFrame = raw['reducedMotionFrame'] === undefined && policy.absentReducedMotionFrame !== null
    ? policy.absentReducedMotionFrame : raw['reducedMotionFrame'];
  if (!isPositiveInt(cellW) || !isPositiveInt(cellH) || !isPair(anchorPx)) return null;
  if (alias !== undefined && (typeof alias !== 'string' || !alias || alias === id)) return null;
  // An alias state packs no cells of its own: its keys are the aliased clip's.
  const keyBase = typeof alias === 'string' ? alias : id;
  if (sourcePivot !== undefined && !isPair(sourcePivot)) return null;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0) return null;
  if (typeof loop !== 'boolean') return null;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  if (!Number.isInteger(reducedMotionFrame) || (reducedMotionFrame as number) < 0
    || (reducedMotionFrame as number) >= frames.length) return null;
  const keys: string[] = [];
  for (const [index, frame] of frames.entries()) {
    if (!isRecord(frame) || frame['key'] !== `${keyBase}_f${index + keyIndexBase}`) return null;
    if (frame['sourceIndex'] !== index) return null;
    if (typeof frame['rgbaSha256'] !== 'string' || !HEX64.test(frame['rgbaSha256'])) return null;
    keys.push(frame['key']);
  }
  const atlas = atlasGroupFor(keys[0]!);
  if (!allowedGroups.has(atlas)) return null;
  // Authored playback indices (P5): non-empty, integers, strictly increasing, in range.
  let playback: readonly number[] | null = null;
  if (playbackFrameIndices !== undefined) {
    if (!Array.isArray(playbackFrameIndices) || playbackFrameIndices.length === 0) return null;
    const indices: number[] = [];
    for (const [n, index] of playbackFrameIndices.entries()) {
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= keys.length) return null;
      if (n > 0 && (index as number) <= indices[n - 1]!) return null;
      indices.push(index as number);
    }
    playback = indices;
  }
  let overlayValue: MarketClip['overlay'] = null;
  if (overlay !== undefined) {
    if (!isRecord(overlay) || typeof overlay['clip'] !== 'string' || !overlay['clip']
      || !isPair(overlay['offset'])) return null;
    overlayValue = { clip: overlay['clip'], offset: [overlay['offset'][0], overlay['offset'][1]] };
  }
  return {
    atlas, cellW, cellH,
    anchorPx: [anchorPx[0], anchorPx[1]],
    sourcePivot: sourcePivot ? [sourcePivot[0], sourcePivot[1]] : null,
    fps, loop, reducedMotionFrame: reducedMotionFrame as number,
    frames: keys, overlay: overlayValue,
    alias: typeof alias === 'string' ? alias : null,
    playbackFrameIndices: playback,
  };
}

/** One packed family table: schemaVersion 1, one-based keys, every clip inside
 *  the family's declared groups. Any defect rejects the WHOLE family — a half
 *  table would let one Market tier animate while its sibling stays hidden. */
function parseFamily(raw: unknown, groups: ReadonlySet<string>, policy: ClipPolicy = MARKET_POLICY): Record<string, MarketClip> | null {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1 || raw['keyIndexBase'] !== 1
    || raw['sourceIndexBase'] !== 0 || raw['sourceScale'] !== 1 || !isRecord(raw['clips'])) return null;
  const clips: Record<string, MarketClip> = {};
  for (const [id, clipRaw] of Object.entries(raw['clips'])) {
    if (!id) return null;
    const clip = parseClip(id, clipRaw, groups, 1, policy);
    if (!clip) return null;
    clips[id] = clip;
  }
  for (const clip of Object.values(clips)) {
    if (clip.overlay && !clips[clip.overlay.clip]) return null;
    if (clip.alias && clips[clip.alias]?.frames.join() !== clip.frames.join()) return null;
  }
  return clips;
}

function parseBindings(raw: unknown, clips: Readonly<Record<string, MarketClip>>): Record<string, AwningBinding> | null {
  if (!isRecord(raw)) return null;
  const bindings: Record<string, AwningBinding> = {};
  for (const [outputId, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || typeof entry['sha256'] !== 'string' || !HEX64.test(entry['sha256'])) return null;
    const value = entry['value'];
    if (!isRecord(value) || value['version'] !== 1 || value['outputId'] !== outputId) return null;
    const { sourceManifestSha256, sourceIndexSha256 } = value;
    if (typeof sourceManifestSha256 !== 'string' || !HEX64.test(sourceManifestSha256)) return null;
    if (typeof sourceIndexSha256 !== 'string' || !HEX64.test(sourceIndexSha256)) return null;
    // The generated binding embeds each clip record; only its id is bound here.
    if (!Array.isArray(value['clips'])) return null;
    const ids: string[] = [];
    for (const clip of value['clips']) {
      const id = typeof clip === 'string' ? clip : isRecord(clip) ? clip['id'] : undefined;
      if (typeof id !== 'string' || !clips[id]) return null;
      ids.push(id);
    }
    bindings[outputId] = { sha256: entry['sha256'], sourceManifestSha256, sourceIndexSha256, clips: ids };
  }
  return bindings;
}

const SERVICE_GROUPS: ReadonlySet<string> = new Set(SERVICE_ART_FAMILIES.flatMap((family) => [1, 2, 3, 4].map((tier) => `pe_${family}_t${tier}`)));

/**
 * The accepted Workshop/Lodge pack (`peServiceBuildings`): a closed table of
 * two families × four tiers × the seven Market states (+ each tier's
 * `ready_fx`), eight optional 1x groups, one integrity binding per group whose
 * provenance equals the table's. Any defect refuses BOTH service families and
 * nothing else. Playback indices and the absent-reduced-frame policy apply
 * only here (D1/D2).
 */
/** A non-empty record whose every value is a hex-64 digest, or null. */
function hexRecord(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length === 0 || !entries.every(([, v]) => typeof v === 'string' && HEX64.test(v))) return null;
  return raw as Record<string, string>;
}

function parseServiceFamilies(raw: unknown): Record<string, MarketClip> | null {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1) return null;
  const families = raw['families'];
  if (!Array.isArray(families) || families.length !== 2 || families[0] !== 'workshop' || families[1] !== 'lodge') return null;
  const atlases = raw['atlases'];
  if (!Array.isArray(atlases) || atlases.length !== SERVICE_GROUPS.size
    || !atlases.every((g) => typeof g === 'string' && SERVICE_GROUPS.has(g)) || new Set(atlases).size !== atlases.length) return null;
  // The accepted exporter records the two families' provenance per family and
  // their source manifests per SOURCE pack (the Lodge art ships in the shared
  // `services` source): both are records of hex digests, the index digest a string.
  if (typeof raw['indexSha256'] !== 'string' || !HEX64.test(raw['indexSha256'])) return null;
  const manifests = hexRecord(raw['sourceManifestSha256']);
  const provenance = hexRecord(raw['provenanceSha256']);
  if (!manifests || !provenance || !SERVICE_ART_FAMILIES.every((family) => provenance[family] !== undefined)) return null;
  const manifestDigests = new Set(Object.values(manifests));
  const clips = parseFamily(raw, SERVICE_GROUPS, SERVICE_POLICY);
  if (!clips) return null;
  for (const id of Object.keys(clips)) if (!SERVICE_CLIP_ID.test(id)) return null;
  for (const family of SERVICE_ART_FAMILIES) {
    for (const tier of [1, 2, 3, 4]) {
      for (const state of SERVICE_ART_STATES) if (!clips[`pe_${family}_t${tier}_${state}`]) return null;
    }
  }
  const bindings = raw['bindings'];
  if (!isRecord(bindings) || Object.keys(bindings).length !== SERVICE_GROUPS.size) return null;
  for (const [group, entry] of Object.entries(bindings)) {
    if (!SERVICE_GROUPS.has(group) || !isRecord(entry) || typeof entry['sha256'] !== 'string' || !HEX64.test(entry['sha256'])) return null;
    const value = entry['value'];
    const [, family, tier] = /^pe_(workshop|lodge)_t([1-4])$/.exec(group)!;
    if (!isRecord(value) || value['version'] !== 1 || value['family'] !== family || value['tier'] !== Number(tier)
      || value['atlas'] !== group || value['sourceScale'] !== 1
      || typeof value['sourceManifestSha256'] !== 'string' || !manifestDigests.has(value['sourceManifestSha256'])
      || value['sourceIndexSha256'] !== raw['indexSha256']) return null;
    if (!Array.isArray(value['clips']) || value['clips'].length === 0) return null;
    for (const clip of value['clips']) {
      const id = typeof clip === 'string' ? clip : isRecord(clip) ? clip['id'] : undefined;
      if (typeof id !== 'string' || !clips[id] || clips[id]!.atlas !== group) return null;
    }
  }
  return clips;
}

/**
 * meta.json `peMarket` + `peCosmetics` (+ `peServiceBuildings`, P5) → one typed
 * table. Each family is validated on its own: a legacy or defective
 * `peCosmetics` leaves the ordinary Market art usable, and vice versa; a
 * defective service table leaves both accepted Market families untouched.
 * Never throws (BootScene registration).
 */
export function parseMarketArtMetadata(peMarket: unknown, peCosmetics: unknown, peServiceBuildings?: unknown, peHarvesters?: unknown): MarketArtTable {
  const clips: Record<string, MarketClip> = {};
  let bindings: Record<string, AwningBinding> = {};
  if (isRecord(peMarket) && Array.isArray(peMarket['atlases'])
    && peMarket['atlases'].every((g) => typeof g === 'string' && /^pe_market_t[1-4]$/.test(g))) {
    const market = parseFamily(peMarket, new Set(peMarket['atlases'] as string[]));
    if (market && Object.keys(market).every((id) => id.startsWith('pe_market_t'))) Object.assign(clips, market);
  }
  if (isRecord(peCosmetics) && peCosmetics['atlas'] === AWNING_ATLAS_GROUP) {
    const cosmetics = parseFamily(peCosmetics, new Set([AWNING_ATLAS_GROUP]));
    if (cosmetics && Object.keys(cosmetics).every((id) => id.startsWith('pe_cos_'))) {
      const parsed = parseBindings(peCosmetics['bindings'], cosmetics);
      if (parsed) {
        Object.assign(clips, cosmetics);
        bindings = parsed;
      }
    }
  }
  if (peServiceBuildings !== undefined) {
    const services = parseServiceFamilies(peServiceBuildings);
    if (services) Object.assign(clips, services);
  }
  if (peHarvesters !== undefined) Object.assign(clips, parseHarvesterArtMetadata(peHarvesters).clips);
  if (Object.keys(clips).length === 0) return EMPTY_MARKET_ART;
  return Object.freeze({ clips: Object.freeze(clips), bindings: Object.freeze(bindings) });
}

/**
 * Market visual tier from its COMPLETED level, through the one shared boundary
 * rule (boundCosmeticAwningForCompletedLevel), clamped like every other
 * `Math.min(20, level)` key so a server level past the cap keeps the top tier.
 */
export function marketArtTierOfLevel(level: number, family: MarketArtFamily = 'market'): number {
  // The three families share the Market's four-tier rule (D3). The rule is defined
  // over Market levels, so a family's cap is honoured only up to the Market's; the
  // deed mirror (apps/api baseRender marketDeedTier) clamps identically.
  const clamped = Math.min(STRUCTURES[family].maxLevel, STRUCTURES.market.maxLevel, Math.max(1, Math.floor(level)));
  return awningTier(boundCosmeticAwningForCompletedLevel(clamped));
}

export function awningTier(outputId: BoundCosmeticAwningId): number {
  const tier = /_t([1-4])$/.exec(outputId)?.[1];
  if (!tier) throw new Error(`Awning ${outputId} names no Market tier`);
  return Number(tier);
}

export function marketAtlasGroup(tier: number, family: MarketArtFamily = 'market', realm?: RealmId): string {
  if (family === 'harvester') return realm ? `pe_harvester_${realm.replace('-', '_')}_t${tier}` : HARVESTER_UNPRESENTED_KEY;
  return `pe_${family}_t${tier}`;
}

export function marketClipId(tier: number, state: MarketArtState, family: MarketArtFamily = 'market', realm?: RealmId): string {
  return `${marketAtlasGroup(tier, family, realm)}_${state}`;
}

export function awningClipId(outputId: BoundCosmeticAwningId, state: MarketArtState): string {
  return `pe_cos_market_t${awningTier(outputId)}_${state}`;
}

/** Selected family for one service building: a Market's applied Awning, else
 *  the ordinary tier art of its family (`family` defaults to market so every
 *  accepted Market caller reads exactly as before). */
export interface MarketArtChoice {
  tier: number;
  awning: BoundCosmeticAwningId | null;
  family?: MarketArtFamily;
  /** Harvester variant from the current base or frozen defender context. */
  realm?: RealmId;
}

export function marketArtGroup(choice: MarketArtChoice): string {
  const family = choice.family ?? 'market';
  return choice.awning && family === 'market' ? AWNING_ATLAS_GROUP : marketAtlasGroup(choice.tier, family, choice.realm);
}

export function marketArtClipId(choice: MarketArtChoice, state: MarketArtState): string {
  const family = choice.family ?? 'market';
  return choice.awning && family === 'market' ? awningClipId(choice.awning, state) : marketClipId(choice.tier, state, family, choice.realm);
}

/** Resting frame key of a choice (`<idle clip>_f1`), or null when the table
 *  lacks that clip. Consumers key a Market sprite by this before its controller
 *  takes the texture over. */
export function marketRestFrameKey(art: MarketArtTable, choice: MarketArtChoice): string | null {
  return art.clips[marketArtClipId(choice, 'idle')]?.frames[0] ?? null;
}

/** Seat for a Market/Awning frame key, null for every other key. World scale
 *  is 1: the 112 px cell is authored at the web world's 64 px tile (a 2×2
 *  footprint is 128 world px), so the deed draws the same cell at 0.5. */
export function marketSeat(
  art: MarketArtTable, frame: string,
): { origin: readonly [number, number]; scale: number; offsetGamePx: readonly [number, number] } | null {
  const base = MARKET_FRAME_KEY.test(frame) ? frame.replace(/_f\d+$/, '') : undefined;
  const clip = base ? art.clips[base] : undefined;
  if (!clip) return null;
  return {
    origin: [clip.anchorPx[0] / clip.cellW, clip.anchorPx[1] / clip.cellH],
    scale: 1,
    offsetGamePx: [0, 0],
  };
}

export const MARKET_FRAME_KEY = /^pe_(?:cos_market|market|workshop|lodge|harvester_(?:frostveil|elderwood|sunscar|crownlands|seeker_reach|stormcairn|thornwake|cinderfall))_t[1-4]_[a-z]+_f\d+$/;

/** The family a packed frame key belongs to (Awning frames are Market), or null. */
export function marketFrameFamily(frame: string): MarketArtFamily | null {
  if (frame === HARVESTER_UNPRESENTED_KEY || HARVESTER_FRAME_KEY.test(frame)) return 'harvester';
  const family = /^pe_(cos_market|market|workshop|lodge)_t[1-4]_[a-z]+_f\d+$/.exec(frame)?.[1];
  return family === undefined ? null : family === 'cos_market' ? 'market' : family as MarketArtFamily;
}

export interface MarketAwningSelection {
  /** buildingId → applied Awning. Absent = ordinary Market art. */
  awnings: ReadonlyMap<string, BoundCosmeticAwningId>;
  /** The projection was explicitly unavailable or refused: ordinary art is
   *  drawn, but nothing may claim this is a verified "off". */
  unavailable: boolean;
}

const NO_AWNINGS: MarketAwningSelection = Object.freeze({ awnings: new Map(), unavailable: false });

/**
 * Turn the server's projection into per-Market Awning choices. Legacy absence
 * (`undefined`) and a verified empty visual both select ordinary art. A read
 * that fails the shared matcher, names an unknown binding, or carries hashes
 * other than the generated binding's is REFUSED whole: ordinary art, flagged.
 */
export function selectMarketAwnings(
  art: MarketArtTable,
  raw: unknown,
  buildings: readonly BoundCosmeticVisualBuilding[],
): MarketAwningSelection {
  if (raw === undefined) return NO_AWNINGS;
  let read: BoundCosmeticBaseRead | undefined;
  try {
    read = matchBoundCosmeticBaseRead(raw, buildings);
  } catch {
    return { awnings: new Map(), unavailable: true };
  }
  if (!read || read.state !== 'available') return { awnings: new Map(), unavailable: true };
  const awnings = new Map<string, BoundCosmeticAwningId>();
  for (const entry of read.visual.marketAwnings) {
    const { appearance } = entry;
    const binding = art.bindings[appearance.outputId];
    if (!binding
      || binding.sha256 !== appearance.bindingSha256
      || binding.sourceManifestSha256 !== appearance.sourceManifestSha256
      || binding.sourceIndexSha256 !== appearance.sourceIndexSha256
      || binding.clips.some((id) => !art.clips[id])) {
      return { awnings: new Map(), unavailable: true };
    }
    awnings.set(entry.buildingId, appearance.outputId as BoundCosmeticAwningId);
  }
  return { awnings, unavailable: false };
}
