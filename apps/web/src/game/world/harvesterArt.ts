/** The generated owner-art Harvester table, admitted separately from existing
 * service art. An exported pack is not approval: runtimeReady must be true.
 * No metadata, pixel, realm or tier is invented when that admission is absent. */
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import type { MarketArtTable, MarketClip } from './marketArt';

export const HARVESTER_UNPRESENTED_KEY = '__harvester_unpresented__';
export const HARVESTER_FRAME_KEY = /^pe_harvester_(?:frostveil|elderwood|sunscar|crownlands|seeker_reach|stormcairn|thornwake|cinderfall)_t[1-4]_(?:idle|working|ready|damaged|construction|collapse|destroyed)_f[1-9]$/;
const STATES = ['idle', 'working', 'ready', 'damaged', 'construction', 'collapse', 'destroyed'] as const;
const GROUPS = new Set(REALM_IDS.flatMap(realm => [1, 2, 3, 4].map(tier => `pe_harvester_${realm.replace('-', '_')}_t${tier}`)));
const EMPTY: MarketArtTable = Object.freeze({ clips: Object.freeze({}), bindings: Object.freeze({}) });
const HEX = /^[0-9a-f]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === 'string' && HEX.test(value);
const pair = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2
  && value.every(n => typeof n === 'number' && Number.isFinite(n));
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function readClip(id: string, group: string, value: unknown): MarketClip | null {
  if (!record(value)) return null;
  const { cellW, cellH, anchorPx, sourcePivot, fps, loop, frames, playbackFrameIndices, sourceSha256 } = value;
  if (!integer(cellW) || !integer(cellH) || !pair(anchorPx) || !pair(sourcePivot) || !digest(sourceSha256)
    || typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0 || typeof loop !== 'boolean'
    || !Array.isArray(frames) || frames.length === 0) return null;
  // No Harvester alias or separate ready overlay exists: the authored ready
  // cell already contains its FX, and destruction has its own packed cell.
  if (value['alias'] !== undefined || value['overlay'] !== undefined) return null;
  const keys: string[] = [];
  for (const [index, frame] of frames.entries()) {
    if (!record(frame) || frame['sourceIndex'] !== index || frame['key'] !== `${id}_f${index + 1}`
      || typeof frame['key'] !== 'string' || !HARVESTER_FRAME_KEY.test(frame['key']) || !digest(frame['rgbaSha256'])) return null;
    keys.push(frame['key']);
  }
  if (!Array.isArray(playbackFrameIndices) || playbackFrameIndices.length === 0) return null;
  const playback: number[] = [];
  for (const index of playbackFrameIndices) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= keys.length
      || (playback.length > 0 && index <= playback[playback.length - 1]!)) return null;
    playback.push(index);
  }
  // This is the same accessibility policy as Workshop/Lodge. The source does
  // not publish reducedMotionFrame; an explicit malformed value still refuses.
  const reduced = value['reducedMotionFrame'] === undefined ? 0 : value['reducedMotionFrame'];
  if (typeof reduced !== 'number' || !Number.isInteger(reduced) || reduced < 0 || reduced >= keys.length) return null;
  return { atlas: group, cellW, cellH, anchorPx, sourcePivot, fps, loop,
    reducedMotionFrame: reduced, frames: keys, playbackFrameIndices: playback, overlay: null, alias: null };
}

/** Small first-paint reader only; all 32 bulk tables stay in generated meta.json.
 * One invalid group rejects this family, independently of Market/Workshop/Lodge.
 * Binding provenance and its embedded clips must agree with the top-level table. */
export function parseHarvesterArtMetadata(raw: unknown): MarketArtTable {
  if (!record(raw) || raw['runtimeReady'] !== true || raw['schemaVersion'] !== 1 || raw['family'] !== 'harvester'
    || raw['sourceScale'] !== 1 || raw['sourceIndexBase'] !== 0 || raw['keyIndexBase'] !== 1
    || !digest(raw['sourceManifestSha256']) || !digest(raw['indexSha256']) || !digest(raw['provenanceSha256'])) return EMPTY;
  const atlases = raw['atlases'], sourceClips = raw['clips'], bindings = raw['bindings'];
  if (!Array.isArray(atlases) || atlases.length !== GROUPS.size || new Set(atlases).size !== GROUPS.size
    || !atlases.every(group => typeof group === 'string' && GROUPS.has(group))
    || !record(sourceClips) || Object.keys(sourceClips).length !== GROUPS.size * STATES.length
    || !record(bindings) || Object.keys(bindings).length !== GROUPS.size) return EMPTY;
  const clips: Record<string, MarketClip> = {};
  for (const group of GROUPS) {
    for (const state of STATES) {
      const id = `${group}_${state}`, clip = readClip(id, group, sourceClips[id]);
      if (!clip) return EMPTY;
      clips[id] = clip;
    }
    const entry: unknown = bindings[group];
    if (!record(entry) || !digest(entry['sha256']) || !record(entry['value'])) return EMPTY;
    const binding: Record<string, unknown> = entry['value'];
    const [, realm, tier] = /^pe_harvester_(.+)_t([1-4])$/.exec(group)!;
    if (binding['version'] !== 1 || binding['family'] !== 'harvester' || binding['atlas'] !== group
      || binding['sourceId'] !== realm!.replace('_', '-') || binding['tier'] !== Number(tier) || binding['sourceScale'] !== 1
      || binding['sourceManifestSha256'] !== raw['sourceManifestSha256'] || binding['sourceIndexSha256'] !== raw['indexSha256']
      || binding['sourceProvenanceSha256'] !== raw['provenanceSha256']
      || !Array.isArray(binding['clips']) || binding['clips'].length !== STATES.length) return EMPTY;
    const published = new Set<string>(), embeddedClips: readonly unknown[] = binding['clips'];
    for (const embedded of embeddedClips) {
      if (!record(embedded) || typeof embedded['id'] !== 'string' || published.has(embedded['id'])) return EMPTY;
      const id = embedded['id'], clip = sourceClips[id];
      if (!record(clip) || clips[id]?.atlas !== group) return EMPTY;
      for (const [key, value] of Object.entries(clip)) {
        if (JSON.stringify(embedded[key]) !== JSON.stringify(value)) return EMPTY;
      }
      published.add(id);
    }
  }
  return Object.freeze({ clips: Object.freeze(clips), bindings: EMPTY.bindings });
}
