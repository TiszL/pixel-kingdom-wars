import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const PHASE_E_STARTER_FLEET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/phase-e/fleet');
export const PHASE_E_STARTER_FLEET_COUNTS = { sourcePngs: 11, clips: 11, frames: 42 } as const;
const MANIFEST_SHA = 'c2de5bfaf3c6d9e5700c613ae6aea0eeb9a57f9a8f055dde08db38402c80a329';
const TRACKS_SHA = '33576b7a8c0d6c62658b3c88ef3accb204babe1e21207dc5a2c62234da327b4d';
const FX_SHA = 'db6a01d7d55646b2e23f5fbe5d1cd976fc97e3386f91502f76a4253ffece4f34';
const INDEX_SHA = '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181';
const PROVENANCE_SHA = '25007de42cdbe3b9f3440e8999e05da3e4a5b275968a44834e84e96ba43f4840';
const FX_PROVENANCE_SHA = 'e5e5c2dc8151d358b34579b76f20a174b46544d8fc32b1bd5546143d7eeba910';
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(`phase-e starter fleet preflight: ${message}`); };
interface SourceClip {
  path: string; cell: [number, number]; frameCount: number; fps: number; loop: boolean; sha256: string;
  providerIndices?: number[]; reducedMotionFrame?: number;
}
interface FleetGeometry {
  cell: [number, number]; horizontalPivot: number; sourceCellBottom: number; drawScale: number;
  footprint?: [number, number]; groundContact?: [number, number]; attachment?: [number, number];
  tidalGate?: [number, number]; contactPx?: [number, number]; dockOffsetPx?: [number, number]; berthRef?: string;
}
export interface StarterFleetClip {
  sourcePath: string; sourceSha256: string; cellW: number; cellH: number;
  anchorPx: [number, number]; anchorKind: 'cellBottomPivotX' | 'attachment' | 'centre';
  geometry?: FleetGeometry; fps: number; loop: boolean; providerIndices?: number[];
  reducedMotionFrame?: number; reducedMotionClip?: string;
  /** sha256 hashes the full untrimmed RGBA8 cell, not a re-encoded PNG. */
  frames: Array<{ sourceIndex: number; key: string; sha256: string }>;
}
interface StarterTrack {
  mode: string; departure: Array<{ frame: number; offsetPx: [number, number]; opacity: number }>;
  return: StarterTrack['departure']; berthPersists: boolean; footprint: [number, number];
  sharedFxRef: string; effectAttachmentPx: [number, number]; contactRemainsOnWater: boolean;
  travelScene: string; reducedMotion: string;
}
export interface PhaseEStarterFleetMetadata {
  schemaVersion: 1; atlas: 'pe_fleet_starter'; sourceScale: 1; sourceIndexBase: 0; keyIndexBase: 1;
  sourceManifestSha256: string; sourceTracksSha256: string; sourceFxManifestSha256: string;
  sourceIndexSha256: string; provenanceSha256: string; fxProvenanceSha256: string;
  clips: Record<string, StarterFleetClip>;
  tracks: { schemaVersion: number; timingUnit: string; fps: number; generatedMotionRequired: boolean;
    families: { starter: StarterTrack } };
  geometry: { starter: FleetGeometry; berth: FleetGeometry };
  awayComposition: string;
}
export interface PhaseEStarterFleetPack {
  frames: Array<{ key: string; png: Buffer }>;
  metadata: PhaseEStarterFleetMetadata;
  bindingSha256: string;
}

/** Validates the finite immutable source subset before any generated output is
 * cleared. No provider path, precomposed presentation or unrelated family opens. */
export async function loadPhaseEStarterFleetPack(root = PHASE_E_STARTER_FLEET_DIR): Promise<PhaseEStarterFleetPack> {
  async function pinned<T>(relative: string, sha: string): Promise<T> {
    const bytes = await fs.readFile(path.resolve(root, relative));
    if (digest(bytes) !== sha) fail(`admitted manifest/provenance changed: ${relative}`);
    return JSON.parse(bytes.toString('utf8')) as T;
  }
  type Provenance = { files: Array<{ path: string; bytes: number; sha256: string; size?: [number, number] }> };
  const manifest = await pinned<{ assets: Array<{ id: string; geometry: FleetGeometry;
    states: Record<string, SourceClip> & { away?: { composition: string } } }> }>('manifest.json', MANIFEST_SHA);
  const sourceTracks = await pinned<PhaseEStarterFleetMetadata['tracks']>('composition-tracks.json', TRACKS_SHA);
  const fx = await pinned<{ exportFrameIndices: number[]; effects: Array<{ id: string; atlas: string;
    frameCount: number; frameWidth: number; frameHeight: number; fps: number; loop: boolean;
    reducedMotion: string; frameHashes: string[]; sourceAlphaBounds: number[][] }> }>('../shared-fx/manifest.json', FX_SHA);
  const admitted = await pinned<Provenance>('provenance.json', PROVENANCE_SHA);
  const fxAdmitted = await pinned<Provenance>('../shared-fx/starter-provenance.json', FX_PROVENANCE_SHA);
  const files = new Map<string, { bytes: Buffer; rgba: Buffer; width: number; height: number }>();
  for (const file of [...admitted.files, ...fxAdmitted.files]) {
    const bytes = await fs.readFile(path.resolve(root, '..', file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail(`source hash changed: ${file.path}`);
    if (!file.size) continue;
    const image = sharp(bytes), meta = await image.metadata();
    if (meta.format !== 'png' || !meta.hasAlpha || meta.width !== file.size[0] || meta.height !== file.size[1]) fail(`PNG geometry changed: ${file.path}`);
    const rgba = await image.ensureAlpha().raw().toBuffer();
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0 && rgba[i] !== 255) fail(`non-binary alpha: ${file.path}`);
    files.set(file.path, { bytes, rgba, width: file.size[0], height: file.size[1] });
  }
  if (files.size !== PHASE_E_STARTER_FLEET_COUNTS.sourcePngs) fail('source PNG count changed');
  const starter = manifest.assets.find(a => a.id === 'starter')!, berth = manifest.assets.find(a => a.id === 'starter-berth')!;
  const frames: PhaseEStarterFleetPack['frames'] = [], clips: Record<string, StarterFleetClip> = {};
  async function clip(id: string, sourcePath: string, item: Omit<SourceClip, 'path' | 'sha256'> & { sha256?: string },
    anchorKind: StarterFleetClip['anchorKind'], anchorPx: [number, number], geometry?: FleetGeometry, alphaBounds?: number[][]): Promise<void> {
    const file = files.get(sourcePath);
    if (!file) fail(`unadmitted source: ${sourcePath}`);
    const [cellW, cellH] = item.cell;
    if (file!.width !== cellW * item.frameCount || file!.height !== cellH || (item.sha256 && digest(file!.bytes) !== item.sha256)) fail(`strip contract changed: ${id}`);
    const refs: StarterFleetClip['frames'] = [];
    for (let sourceIndex = 0; sourceIndex < item.frameCount; sourceIndex++) {
      const rgba = await sharp(file!.rgba, { raw: { width: file!.width, height: file!.height, channels: 4 } })
        .extract({ left: sourceIndex * cellW, top: 0, width: cellW, height: cellH }).raw().toBuffer();
      if (alphaBounds) {
        let left = cellW, top = cellH, right = -1, bottom = -1;
        for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) if (rgba[(y * cellW + x) * 4 + 3]) {
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        if (JSON.stringify([left, top, right + 1, bottom + 1]) !== JSON.stringify(alphaBounds[sourceIndex])) fail(`opaque bounds changed: ${id}/${sourceIndex}`);
      }
      const key = `${id}_f${sourceIndex + 1}`;
      frames.push({ key, png: await sharp(rgba, { raw: { width: cellW, height: cellH, channels: 4 } }).png().toBuffer() });
      refs.push({ sourceIndex, key, sha256: digest(rgba) });
    }
    clips[id] = { sourcePath, sourceSha256: digest(file!.bytes), cellW, cellH, anchorKind, anchorPx,
      ...(geometry ? { geometry } : {}), fps: item.fps, loop: item.loop,
      ...(item.providerIndices ? { providerIndices: item.providerIndices } : {}),
      ...(item.reducedMotionFrame !== undefined ? { reducedMotionFrame: item.reducedMotionFrame } : {}), frames: refs };
  }
  for (const state of ['idle', 'docked', 'travel']) {
    const item = starter.states[state]!;
    await clip(`pe_veh_starter_${state}`, `fleet/${item.path}`, item, 'attachment', starter.geometry.contactPx!, starter.geometry);
  }
  for (const state of ['intact', 'damaged', 'destroyed', 'ambient']) {
    const item = berth.states[state]!;
    await clip(`pe_berth_starter_${state}`, `fleet/${item.path}`, item, 'cellBottomPivotX', [berth.geometry.horizontalPivot, berth.geometry.sourceCellBottom], berth.geometry);
  }
  for (const id of ['departure', 'return']) {
    const item = fx.effects.find(a => a.id === id)!, cell: [number, number] = [item.frameWidth, item.frameHeight];
    const name = `pe_fx_${id}`, still = `${name}_still`;
    await clip(name, `shared-fx/${item.atlas}`, { cell, frameCount: item.frameCount, fps: item.fps,
      loop: item.loop, providerIndices: fx.exportFrameIndices }, 'centre', [cell[0] / 2, cell[1] / 2], undefined, item.sourceAlphaBounds.slice(1));
    await clip(still, `shared-fx/${item.reducedMotion}`, { cell, frameCount: 1, fps: 0, loop: false,
      providerIndices: [0], reducedMotionFrame: 0, sha256: item.frameHashes[0]! }, 'centre', [cell[0] / 2, cell[1] / 2], undefined, item.sourceAlphaBounds.slice(0, 1));
    // Provider frame zero is a separate PNG. It is never animated atlas cell zero.
    clips[name]!.reducedMotionClip = still;
  }
  const metadata: PhaseEStarterFleetMetadata = {
    schemaVersion: 1, atlas: 'pe_fleet_starter', sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1,
    sourceManifestSha256: MANIFEST_SHA, sourceTracksSha256: TRACKS_SHA, sourceFxManifestSha256: FX_SHA,
    sourceIndexSha256: INDEX_SHA, provenanceSha256: PROVENANCE_SHA, fxProvenanceSha256: FX_PROVENANCE_SHA, clips,
    tracks: { schemaVersion: sourceTracks.schemaVersion, timingUnit: sourceTracks.timingUnit, fps: sourceTracks.fps,
      generatedMotionRequired: sourceTracks.generatedMotionRequired, families: { starter: sourceTracks.families.starter } },
    geometry: { starter: starter.geometry, berth: berth.geometry }, awayComposition: berth.states.away!.composition,
  };
  // Canonical JSON: exact constructed field, clip and frame order; no readiness or gameplay claim.
  const pack = { frames, metadata, bindingSha256: digest(JSON.stringify(metadata)) };
  assertPhaseEStarterFleetKeys(pack, new Set());
  return pack;
}

export function assertPhaseEStarterFleetKeys(pack: PhaseEStarterFleetPack, existing: ReadonlySet<string>): void {
  const keys = new Set<string>();
  for (const { key } of pack.frames) {
    if (!/^(?:pe_veh_starter_(?:idle|docked|travel)|pe_berth_starter_(?:intact|damaged|destroyed|ambient)|pe_fx_(?:departure|return)(?:_still)?)_f[1-9]\d*$/.test(key)
      || keys.has(key) || existing.has(key)) fail(`key collision/unadmitted key: ${key}`);
    keys.add(key);
  }
  if (keys.size !== PHASE_E_STARTER_FLEET_COUNTS.frames || Object.keys(pack.metadata.clips).length !== PHASE_E_STARTER_FLEET_COUNTS.clips) fail('clip/frame count changed');
  for (const clip of Object.values(pack.metadata.clips)) {
    for (const { key } of clip.frames) if (!keys.has(key)) fail(`missing clip frame: ${key}`);
    if (clip.reducedMotionClip && !pack.metadata.clips[clip.reducedMotionClip]) fail('missing reduced-motion clip');
  }
}

export async function emitPhaseEStarterFleetManifest(pack: PhaseEStarterFleetPack, output: string): Promise<void> {
  await fs.writeFile(path.join(output, 'pe_fleet_starter.manifest.json'), JSON.stringify({ ...pack.metadata, bindingSha256: pack.bindingSha256 }, null, 2) + '\n');
}
