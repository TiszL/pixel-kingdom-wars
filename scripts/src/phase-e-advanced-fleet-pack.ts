import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const PHASE_E_ADVANCED_FLEET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/phase-e/fleet');
export const PHASE_E_ADVANCED_FLEET_COUNTS = { sourcePngs: 80, clips: 80, frames: 268, groups: 20 } as const;
const FAMILIES = ['survey-balloon', 'cargo-cutter', 'courier-airship', 'expedition-barge'] as const;
type Family = typeof FAMILIES[number];
const MANIFEST_SHA = 'c2de5bfaf3c6d9e5700c613ae6aea0eeb9a57f9a8f055dde08db38402c80a329';
const TRACKS_SHA = '33576b7a8c0d6c62658b3c88ef3accb204babe1e21207dc5a2c62234da327b4d';
const INDEX_SHA = '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181';
const PROVENANCE_SHA = '0b7b4c679734c0e42244676e6df95ef4087871804c143db2627e516ffb20d5bf';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw new Error(`phase-e advanced fleet preflight: ${reason}`); };
interface Geometry {
  cell: [number, number]; horizontalPivot: number; sourceCellBottom: number; drawScale: number;
  footprint?: [number, number]; groundContact?: [number, number]; attachment?: [number, number];
  tidalGate?: [number, number] | null; contactPx?: [number, number]; dockOffsetPx?: [number, number]; berthRef?: string;
}
interface SourceClip {
  path: string; cell: [number, number]; frameCount: number; fps: number; loop: boolean; sha256: string;
  providerIndices?: number[]; reducedMotionFrame?: number;
}
interface Asset {
  id: string; kind: 'vehicle' | 'berth'; family: Family; tier: number | null; geometry: Geometry;
  states: Record<string, SourceClip> & { away?: { composition: string } };
}
interface Track {
  mode: string; departure: Array<{ frame: number; offsetPx: [number, number]; opacity: number }>;
  return: Track['departure']; berthPersists: boolean; footprint: [number, number];
  sharedFxRef: string | null; effectAttachmentPx: [number, number]; contactRemainsOnWater: boolean;
  travelScene: string; reducedMotion: string;
}
export interface AdvancedFleetClip {
  sourceAssetId: string; sourcePath: string; sourceSha256: string; atlas: string;
  cellW: number; cellH: number; anchorPx: [number, number]; anchorKind: 'cellBottomPivotX' | 'attachment';
  geometry: Geometry; fps: number; loop: boolean; providerIndices?: number[]; reducedMotionFrame?: number;
  frames: Array<{ sourceIndex: number; providerIndex?: number; key: string; rgbaSha256: string }>;
}
export interface PhaseEAdvancedFleetMetadata {
  schemaVersion: 1; sourceScale: 1; sourceIndexBase: 0; keyIndexBase: 1; atlases: string[];
  sourceManifestSha256: string; sourceTracksSha256: string; sourceIndexSha256: string; provenanceSha256: string;
  clips: Record<string, AdvancedFleetClip>;
  tracks: { schemaVersion: number; timingUnit: string; fps: number; generatedMotionRequired: boolean; families: Record<string, Track> };
  bindings: Record<string, { sha256: string; value: { version: 1; sourceAssetId: string; sourceFamily: Family;
    kind: Asset['kind']; tier: number | null; atlas: string; sourceManifestSha256: string; sourceTracksSha256: string;
    sourceIndexSha256: string; geometry: Geometry; track: Track; awayComposition?: string;
    clips: Array<{ id: string } & AdvancedFleetClip> } }>;
}
export interface PhaseEAdvancedFleetPack { frames: Array<{ key: string; png: Buffer }>; metadata: PhaseEAdvancedFleetMetadata }

/** Finite, hash-admitted horizontal strips only. Inert provider/precomposed paths
 * in the unchanged source manifest never become import or runtime authority. */
export async function loadPhaseEAdvancedFleetPack(root = PHASE_E_ADVANCED_FLEET_DIR): Promise<PhaseEAdvancedFleetPack> {
  async function pinned<T>(relative: string, sha: string): Promise<T> {
    const bytes = await fs.readFile(path.join(root, relative));
    if (digest(bytes) !== sha) fail(`admitted manifest/provenance changed: ${relative}`);
    return JSON.parse(bytes.toString()) as T;
  }
  const manifest = await pinned<{ assets: Asset[] }>('manifest.json', MANIFEST_SHA);
  const tracks = await pinned<PhaseEAdvancedFleetMetadata['tracks']>('composition-tracks.json', TRACKS_SHA);
  const provenance = await pinned<{ files: Array<{ path: string; sha256: string; bytes: number; size: [number, number] }> }>('advanced-provenance.json', PROVENANCE_SHA);
  const images = new Map<string, { bytes: Buffer; rgba: Buffer; width: number; height: number }>();
  for (const file of provenance.files) {
    const bytes = await fs.readFile(path.join(root, '..', file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail(`source hash changed: ${file.path}`);
    const image = sharp(bytes), meta = await image.metadata();
    if (meta.format !== 'png' || !meta.hasAlpha || meta.width !== file.size[0] || meta.height !== file.size[1]) fail(`PNG geometry changed: ${file.path}`);
    const rgba = await image.ensureAlpha().raw().toBuffer();
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0 && rgba[i] !== 255) fail(`non-binary alpha: ${file.path}`);
    if (images.has(file.path)) fail(`duplicate source: ${file.path}`);
    images.set(file.path, { bytes, rgba, width: file.size[0], height: file.size[1] });
  }
  if (images.size !== PHASE_E_ADVANCED_FLEET_COUNTS.sourcePngs) fail('source PNG count changed');
  const frames: PhaseEAdvancedFleetPack['frames'] = [], clips: PhaseEAdvancedFleetMetadata['clips'] = {};
  const atlases: string[] = [], bindings: PhaseEAdvancedFleetMetadata['bindings'] = {}, used = new Set<string>();
  for (const family of FAMILIES) {
    const berth = manifest.assets.find(a => a.id === `${family}-berth`)!;
    for (const assetId of [berth.id, ...[1, 2, 3, 4].map(tier => `${family}-t${tier}`)]) {
      const matches = manifest.assets.filter(a => a.id === assetId);
      if (matches.length !== 1) fail(`ambiguous source asset: ${assetId}`);
      const asset = matches[0]!, g = asset.geometry;
      if (asset.family !== family || g.drawScale !== 1 || g.cell[0] !== 112 || g.cell[1] !== 112) fail(`source registration changed: ${assetId}`);
      if (asset.kind === 'vehicle' && (g.berthRef !== berth.id || !g.contactPx || !g.dockOffsetPx ||
        g.dockOffsetPx.some((offset, i) => offset !== berth.geometry.attachment![i]! - g.contactPx![i]!))) fail(`dock offset differs from single attachment alignment: ${assetId}`);
      const atlas = `pe_${asset.kind === 'berth' ? 'berth' : 'veh'}_${family.replaceAll('-', '_')}${asset.kind === 'vehicle' ? `_t${asset.tier}` : ''}`;
      atlases.push(atlas);
      for (const state of asset.kind === 'berth' ? ['intact', 'damaged', 'destroyed', 'ambient'] : ['idle', 'docked', 'travel', 'exhausted']) {
        const item = asset.states[state]!, sourcePath = `fleet/${item.path}`, image = images.get(sourcePath);
        if (!image || digest(image.bytes) !== item.sha256) fail(`unadmitted clip source: ${assetId}/${state}`);
        used.add(sourcePath);
        const [cellW, cellH] = item.cell, id = `${atlas}_${state}`;
        if (image!.width !== cellW * item.frameCount || image!.height !== cellH || cellW !== g.cell[0] || cellH !== g.cell[1]
          || (item.providerIndices && item.providerIndices.length !== item.frameCount)
          || (item.reducedMotionFrame !== undefined && (!Number.isInteger(item.reducedMotionFrame) || item.reducedMotionFrame < 0 || item.reducedMotionFrame >= item.frameCount))) fail(`strip/index geometry changed: ${id}`);
        const refs: AdvancedFleetClip['frames'] = [];
        for (let sourceIndex = 0; sourceIndex < item.frameCount; sourceIndex++) {
          const rgba = await sharp(image!.rgba, { raw: { width: image!.width, height: image!.height, channels: 4 } })
            .extract({ left: sourceIndex * cellW, top: 0, width: cellW, height: cellH }).raw().toBuffer();
          const key = `${id}_f${sourceIndex + 1}`;
          frames.push({ key, png: await sharp(rgba, { raw: { width: cellW, height: cellH, channels: 4 } }).png().toBuffer() });
          refs.push({ sourceIndex, ...(item.providerIndices ? { providerIndex: item.providerIndices[sourceIndex]! } : {}), key, rgbaSha256: digest(rgba) });
        }
        clips[id] = { sourceAssetId: asset.id, sourcePath, sourceSha256: digest(image!.bytes), atlas, cellW, cellH,
          anchorKind: asset.kind === 'berth' ? 'cellBottomPivotX' : 'attachment',
          anchorPx: asset.kind === 'berth' ? [g.horizontalPivot, g.sourceCellBottom] : g.contactPx!, geometry: g,
          fps: item.fps, loop: item.loop, ...(item.providerIndices ? { providerIndices: item.providerIndices } : {}),
          ...(item.reducedMotionFrame !== undefined ? { reducedMotionFrame: item.reducedMotionFrame } : {}), frames: refs };
      }
      const value: PhaseEAdvancedFleetMetadata['bindings'][string]['value'] = { version: 1, sourceAssetId: asset.id, sourceFamily: family,
        kind: asset.kind, tier: asset.tier, atlas, sourceManifestSha256: MANIFEST_SHA, sourceTracksSha256: TRACKS_SHA,
        sourceIndexSha256: INDEX_SHA, geometry: g, track: tracks.families[family]!,
        ...(asset.kind === 'berth' ? { awayComposition: asset.states.away!.composition } : {}),
        clips: Object.entries(clips).filter(([, clip]) => clip.atlas === atlas).map(([id, clip]) => ({ id, ...clip })) };
      bindings[atlas] = { sha256: digest(JSON.stringify(value)), value };
    }
  }
  if (used.size !== images.size) fail('unused admitted source');
  const metadata: PhaseEAdvancedFleetMetadata = { schemaVersion: 1, sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1,
    sourceManifestSha256: MANIFEST_SHA, sourceTracksSha256: TRACKS_SHA, sourceIndexSha256: INDEX_SHA, provenanceSha256: PROVENANCE_SHA,
    atlases, clips, bindings, tracks: { schemaVersion: tracks.schemaVersion, timingUnit: tracks.timingUnit, fps: tracks.fps,
      generatedMotionRequired: tracks.generatedMotionRequired, families: Object.fromEntries(FAMILIES.map(f => [f, tracks.families[f]!])) } };
  const pack = { frames, metadata }; assertPhaseEAdvancedFleetKeys(pack, new Set()); return pack;
}

export function assertPhaseEAdvancedFleetKeys(pack: PhaseEAdvancedFleetPack, existing: ReadonlySet<string>): void {
  const keys = new Set<string>();
  for (const { key } of pack.frames) {
    if (!/^pe_(?:veh_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_t[1-4]_(?:idle|docked|travel|exhausted)|berth_(?:survey_balloon|cargo_cutter|courier_airship|expedition_barge)_(?:intact|damaged|destroyed|ambient))_f[1-9]\d*$/.test(key)
      || keys.has(key) || existing.has(key)) fail(`key collision/unadmitted key: ${key}`);
    keys.add(key);
  }
  if (keys.size !== PHASE_E_ADVANCED_FLEET_COUNTS.frames || Object.keys(pack.metadata.clips).length !== PHASE_E_ADVANCED_FLEET_COUNTS.clips
    || new Set(pack.metadata.atlases).size !== PHASE_E_ADVANCED_FLEET_COUNTS.groups) fail('group/clip/frame count changed');
  const bound = new Set<string>();
  for (const [atlas, binding] of Object.entries(pack.metadata.bindings)) {
    if (!pack.metadata.atlases.includes(atlas) || binding.value.atlas !== atlas || binding.sha256 !== digest(JSON.stringify(binding.value))) fail('group binding changed');
    for (const clip of binding.value.clips) {
      const { id, ...value } = clip;
      if (value.atlas !== atlas || JSON.stringify(value) !== JSON.stringify(pack.metadata.clips[id])) fail('cross-group clip binding changed');
      for (const frame of value.frames) {
        if (!keys.has(frame.key) || bound.has(frame.key)) fail('missing or duplicated bound frame');
        bound.add(frame.key);
      }
    }
  }
  if (bound.size !== keys.size) fail('unbound frame');
}

export async function emitPhaseEAdvancedFleetManifest(pack: PhaseEAdvancedFleetPack, output: string): Promise<void> {
  await fs.writeFile(path.join(output, 'pe_advanced_fleet.manifest.json'), JSON.stringify(pack.metadata, null, 2) + '\n');
}

/** Advanced groups alone preserve hidden source RGB after the house packer.
 * Validate the exact group, all source hashes/layouts and visible RGBA first;
 * other groups, gutters/extrusion and original master pixels remain untouched. */
export async function restoreAdvancedFleetPixels(group: string, png: Buffer, json: Buffer,
  images: { name: string; contents: Buffer }[]): Promise<Buffer> {
  const fail = (reason: string): never => { throw new Error(`advanced fleet packed RGBA: ${reason}`); };
  const source = await loadPhaseEAdvancedFleetPack(); // Recheck current source hashes before restoring bytes.
  const expected = new Map(Object.values(source.metadata.clips).filter(clip => clip.atlas === group).flatMap(clip => clip.frames.map(frame =>
    [frame.key, { width: clip.cellW, height: clip.cellH, sha256: frame.rgbaSha256 }] as const)));
  if (!source.metadata.atlases.includes(group) || expected.size === 0) fail('unadmitted group');
  const input = new Map(images.map(image => [image.name, image.contents]));
  if (images.length !== expected.size || input.size !== expected.size || images.some(image => !expected.has(image.name))) fail('input set changed');
  type Rect = { x: number; y: number; w: number; h: number };
  const atlas = JSON.parse(json.toString('utf8')) as { textures: Array<{ size: { w: number; h: number };
    frames: Array<{ filename: string; rotated: boolean; trimmed: boolean; frame: Rect;
      sourceSize: { w: number; h: number }; spriteSourceSize: Rect }> }> };
  if (atlas.textures.length !== 1) fail('one texture required');
  const texture = atlas.textures[0]!;
  const { data: pixels, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (texture.size.w !== info.width || texture.size.h !== info.height || texture.frames.length !== expected.size) fail('texture geometry changed');
  const seen = new Set<string>(), rectangles: Rect[] = [];
  const restored: Array<{ rect: Rect; rgba: Buffer }> = [];
  for (const frame of texture.frames) {
    const canonical = expected.get(frame.filename), rect = frame.frame;
    if (!canonical || seen.has(frame.filename)) fail('duplicate or unknown frame');
    seen.add(frame.filename);
    if (frame.rotated !== false || frame.trimmed !== false
      || ![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) || rect.x < 0 || rect.y < 0
      || rect.w !== canonical!.width || rect.h !== canonical!.height
      || rect.x + rect.w > info.width || rect.y + rect.h > info.height
      || frame.sourceSize.w !== rect.w || frame.sourceSize.h !== rect.h
      || frame.spriteSourceSize.x !== 0 || frame.spriteSourceSize.y !== 0
      || frame.spriteSourceSize.w !== rect.w || frame.spriteSourceSize.h !== rect.h) fail('untrimmed in-bounds source rectangle required');
    if (rectangles.some(other => rect.x < other.x + other.w && rect.x + rect.w > other.x
      && rect.y < other.y + other.h && rect.y + rect.h > other.y)) fail('overlapping rectangles');
    rectangles.push(rect);
    const original = await sharp(input.get(frame.filename)!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (original.info.width !== rect.w || original.info.height !== rect.h
      || digest(original.data) !== canonical!.sha256) fail('source cell changed');
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const from = (y * rect.w + x) * 4, to = ((rect.y + y) * info.width + rect.x + x) * 4;
      if (pixels[to + 3] !== original.data[from + 3]
        || (original.data[from + 3] !== 0 && !pixels.subarray(to, to + 3).equals(original.data.subarray(from, from + 3)))) fail('visible pixel or alpha changed');
    }
    restored.push({ rect, rgba: original.data });
  }
  // Mutate only after every source and rectangle has passed. No resampling or blending.
  for (const { rect, rgba } of restored) for (let y = 0; y < rect.h; y++)
    rgba.copy(pixels, ((rect.y + y) * info.width + rect.x) * 4, y * rect.w * 4, (y + 1) * rect.w * 4);
  return sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}
