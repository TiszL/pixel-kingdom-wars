import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const PHASE_E_SERVICE_BUILDINGS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/phase-e');
export const PHASE_E_SERVICE_BUILDINGS_COUNTS = { sourcePngs: 57, clips: 64, frames: 304, groups: 8 } as const;
const WORKSHOP_SHA = '8347839aa85fafde6309eab0f8f0575e5fb6678453369fd759862f6dd6aef807';
const SERVICES_SHA = 'f7cbf1bf9646d31baf5d7fcd0706e85348f24c199022dde22292adb3e19f1885';
const INDEX_SHA = '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181';
const WORKSHOP_PROVENANCE_SHA = 'd81bfd6135d192a61209bf713eac75299e5f35d8d4f0be3d39d160d625fc3aa0';
const LODGE_PROVENANCE_SHA = '69d5f8d2599202b7b0f1510c7e172ddefae4530f6bb7e9b69fcae11f54d3e4aa';
const STATES = ['idle', 'working', 'damaged', 'ready', 'destroyed', 'construction', 'collapse'] as const;
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fail = (reason: string): never => { throw new Error(`phase-e service buildings preflight: ${reason}`); };
type Rect = { x: number; y: number; w: number; h: number };
interface SourceClip {
  path: string; cell: [number, number]; frameCount: number; fps: number; loop?: boolean; sha256?: string;
  frameHashes?: string[]; overlay?: { path: string; cell: [number, number]; frameCount: number; fps: number; offset: [number, number] };
}
interface WorkshopStatic { tier: number; state: string; localPath: string; sha256: string; active?: boolean; aliasOf?: string }
interface WorkshopAnimation {
  tier: number; state: string; active?: boolean; atlasPath: string; atlasMetadataPath: string;
  frameCount: number; fps: number; loop: boolean; cell: [number, number]; playbackFrameIndices: number[];
  sourcePath?: string; sourcePaths?: [string, string]; frames: Array<{ index: number; path: string; sha256: string }>;
}
export interface ServiceBuildingClip {
  sourcePath: string; sourceSha256: string; sourceMetadataPath?: string; sourceMetadataSha256?: string;
  cellW: number; cellH: number; anchorPx: [number, number]; anchorKind: 'cellBottomPivotX' | 'centre';
  sourcePivot?: [number, number]; footprint?: [number, number]; fps: number; loop: boolean;
  playbackFrameIndices?: number[]; sourceAliasOf?: string;
  frames: Array<{ sourceIndex: number; key: string; rgbaSha256: string; sourceRect: Rect }>;
  alias?: string; overlay?: { clip: string; offset: [number, number] };
}
export interface PhaseEServiceBuildingsMetadata {
  schemaVersion: 1; families: ['workshop', 'lodge']; atlases: string[];
  sourceScale: 1; sourceIndexBase: 0; keyIndexBase: 1;
  sourceManifestSha256: { workshop: string; services: string }; indexSha256: string;
  provenanceSha256: { workshop: string; lodge: string };
  clips: Record<string, ServiceBuildingClip>;
  bindings: Record<string, { sha256: string; value: { version: 1; family: 'workshop' | 'lodge'; tier: number;
    atlas: string; sourceScale: 1; sourceManifestSha256: string; sourceIndexSha256: string;
    clips: Array<{ id: string } & ServiceBuildingClip> } }>;
}
export interface PhaseEServiceBuildingsPack { frames: Array<{ key: string; png: Buffer }>; metadata: PhaseEServiceBuildingsMetadata }

/** Only fixed active Workshop and Lodge records are admitted. Original provider
 * paths and inactive historical records remain inert, even inside pinned JSON. */
export async function loadPhaseEServiceBuildingsPack(root = PHASE_E_SERVICE_BUILDINGS_DIR): Promise<PhaseEServiceBuildingsPack> {
  async function pinned<T>(relative: string, sha: string): Promise<T> {
    const bytes = await fs.readFile(path.join(root, relative));
    if (digest(bytes) !== sha) fail(`admitted manifest/provenance changed: ${relative}`);
    return JSON.parse(bytes.toString()) as T;
  }
  const workshop = await pinned<{ geometry: { sourceCell: [number, number]; pivotPx: [number, number]; footprintTiles: [number, number] };
    outputs: WorkshopStatic[]; animationOutputs: WorkshopAnimation[] }>('workshop/manifest.json', WORKSHOP_SHA);
  const services = await pinned<{ assets: Array<{ family: string; tier: number; pivot: [number, number]; footprint: [number, number];
    states: Record<typeof STATES[number], SourceClip> }> }>('services/manifest.json', SERVICES_SHA);
  type Provenance = { files: Array<{ path: string; bytes: number; sha256: string; size?: [number, number] }> };
  const w = await pinned<Provenance>('workshop/provenance.json', WORKSHOP_PROVENANCE_SHA);
  const l = await pinned<Provenance>('services/lodge-provenance.json', LODGE_PROVENANCE_SHA);
  const bytes = new Map<string, Buffer>(), images = new Map<string, { rgba: Buffer; width: number; height: number }>();
  for (const file of [...w.files, ...l.files]) {
    if (bytes.has(file.path)) continue;
    const contents = await fs.readFile(path.join(root, file.path));
    if (contents.length !== file.bytes || digest(contents) !== file.sha256) fail(`source hash changed: ${file.path}`);
    bytes.set(file.path, contents);
    if (!file.size) continue;
    const image = sharp(contents), meta = await image.metadata();
    if (meta.format !== 'png' || !meta.hasAlpha || meta.width !== file.size[0] || meta.height !== file.size[1]) fail(`PNG geometry changed: ${file.path}`);
    const rgba = await image.ensureAlpha().raw().toBuffer();
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0 && rgba[i] !== 255) fail(`non-binary alpha: ${file.path}`);
    images.set(file.path, { rgba, width: file.size[0], height: file.size[1] });
  }
  if (images.size !== PHASE_E_SERVICE_BUILDINGS_COUNTS.sourcePngs) fail('source PNG count changed');
  const clips: Record<string, ServiceBuildingClip> = {}, frames: PhaseEServiceBuildingsPack['frames'] = [];
  async function clip(id: string, source: string, item: Omit<SourceClip, 'path'>,
    building?: { pivot: [number, number]; footprint: [number, number] }, grid?: WorkshopAnimation, endpoints?: [string, string]): Promise<void> {
    const image = images.get(source); if (!image) fail(`unadmitted source: ${source}`);
    if (item.sha256 && digest(bytes.get(source)!) !== item.sha256) fail(`manifest source hash changed: ${id}`);
    const [cellW, cellH] = item.cell;
    let rectangles: Rect[];
    let sourceMetadataPath: string | undefined;
    if (grid) {
      sourceMetadataPath = `workshop/${grid.atlasMetadataPath}`;
      const layoutBytes = bytes.get(sourceMetadataPath); if (!layoutBytes) fail('unadmitted grid metadata');
      const layout = JSON.parse(layoutBytes!.toString()) as { image: string; padding: number; losslessPixelCopyVerified: boolean;
        frames: Array<{ index: number; frame: Rect; sourceSize: { w: number; h: number }; rotated: boolean; trimmed: boolean }> };
      if (layout.image !== path.posix.basename(source) || layout.padding !== 2 || layout.losslessPixelCopyVerified !== true
        || layout.frames.length !== grid.frameCount || grid.frames.length !== grid.frameCount) fail(`grid contract changed: ${id}`);
      rectangles = layout.frames.map((frame, index) => {
        const r = frame.frame;
        if (frame.index !== index || grid.frames[index]?.index !== index || frame.rotated !== false || frame.trimmed !== false
          || frame.sourceSize.w !== cellW || frame.sourceSize.h !== cellH || r.w !== cellW || r.h !== cellH
          || ![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.x < 0 || r.y < 0
          || r.x + r.w > image!.width || r.y + r.h > image!.height) fail(`grid cell changed: ${id}/${index}`);
        return r;
      });
      if (new Set(grid.playbackFrameIndices).size !== grid.playbackFrameIndices.length
        || grid.playbackFrameIndices.some(index => !Number.isInteger(index) || index < 0 || index >= grid.frameCount)) fail(`playback indices changed: ${id}`);
      for (let i = 0; i < rectangles.length; i++) for (let j = 0; j < i; j++) {
        const a = rectangles[i]!, b = rectangles[j]!;
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) fail(`grid cells overlap: ${id}`);
      }
    } else {
      if (image!.width !== cellW * item.frameCount || image!.height !== cellH) fail(`strip geometry changed: ${id}`);
      rectangles = Array.from({ length: item.frameCount }, (_, index) => ({ x: index * cellW, y: 0, w: cellW, h: cellH }));
    }
    const refs: ServiceBuildingClip['frames'] = [];
    for (const [sourceIndex, rect] of rectangles.entries()) {
      const rgba = await sharp(image!.rgba, { raw: { width: image!.width, height: image!.height, channels: 4 } })
        .extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h }).raw().toBuffer();
      if (item.frameHashes && digest(rgba) !== item.frameHashes[sourceIndex]) fail(`authored frame hash changed: ${id}/${sourceIndex}`);
      if (endpoints && (sourceIndex === 0 || sourceIndex === rectangles.length - 1)) {
        const expected = images.get(endpoints[sourceIndex === 0 ? 0 : 1]);
        if (!expected || !rgba.equals(expected.rgba)) fail(`transition endpoint changed: ${id}/${sourceIndex}`);
      }
      const key = `${id}_f${sourceIndex + 1}`;
      frames.push({ key, png: await sharp(rgba, { raw: { width: cellW, height: cellH, channels: 4 } }).png().toBuffer() });
      refs.push({ sourceIndex, key, rgbaSha256: digest(rgba), sourceRect: rect });
    }
    clips[id] = { sourcePath: source, sourceSha256: digest(bytes.get(source)!),
      ...(sourceMetadataPath ? { sourceMetadataPath, sourceMetadataSha256: digest(bytes.get(sourceMetadataPath)!) } : {}),
      cellW, cellH, anchorPx: building ? [building.pivot[0], cellH] : [cellW / 2, cellH / 2],
      anchorKind: building ? 'cellBottomPivotX' : 'centre', ...(building ? { sourcePivot: building.pivot, footprint: building.footprint } : {}),
      fps: item.fps, loop: item.loop ?? false, ...(grid ? { playbackFrameIndices: grid.playbackFrameIndices } : {}), frames: refs };
  }
  const atlases: string[] = [], bindings: PhaseEServiceBuildingsMetadata['bindings'] = {};
  for (const tier of [1, 2, 3, 4]) {
    const base = `pe_workshop_t${tier}`; atlases.push(base);
    const building = { pivot: workshop.geometry.pivotPx, footprint: workshop.geometry.footprintTiles };
    for (const state of STATES) {
      const id = `${base}_${state}`;
      if (['working', 'construction', 'collapse'].includes(state)) {
        const active = workshop.animationOutputs.filter(a => a.active && a.tier === tier && a.state === state);
        if (active.length !== 1) fail(`ambiguous active animation: ${id}`);
        const a = active[0]!, endpoints: [string, string] = a.sourcePaths
          ? [`workshop/${a.sourcePaths[0]}`, `workshop/${a.sourcePaths[1]}`]
          : [`workshop/${a.sourcePath}`, `workshop/${a.sourcePath}`];
        await clip(id, `workshop/${a.atlasPath}`, { cell: a.cell, frameCount: a.frameCount, fps: a.fps, loop: a.loop }, building, a, endpoints);
      } else {
        const active = workshop.outputs.filter(a => a.active && a.tier === tier && a.state === state);
        if (active.length !== 1) fail(`ambiguous active static: ${id}`);
        const a = active[0]!;
        await clip(id, `workshop/${a.localPath}`, { cell: workshop.geometry.sourceCell, frameCount: 1, fps: 0, loop: false, sha256: a.sha256 }, building);
        if (a.aliasOf) clips[id]!.sourceAliasOf = a.aliasOf;
      }
    }
    // The source declares shared ready FX but supplies no Workshop attachment.
    // Bank the exact clip independently; do not fabricate an overlay or event.
    await clip(`${base}_ready_fx`, 'shared-fx/craft-success/atlas.png', { cell: [64, 64], frameCount: 8, fps: 8, loop: false });
    bind('workshop', tier, base, WORKSHOP_SHA);
  }
  for (const asset of services.assets.filter(a => a.family === 'lodge')) {
    const base = `pe_lodge_t${asset.tier}`; atlases.push(base);
    for (const state of STATES) {
      const item = asset.states[state], id = `${base}_${state}`;
      if (state === 'ready') {
        if (item.path !== asset.states.idle.path || item.sha256 !== asset.states.idle.sha256) fail(`ready alias changed: ${id}`);
        clips[id] = { ...clips[`${base}_idle`]!, alias: `${base}_idle`, overlay: { clip: `${base}_ready_fx`, offset: item.overlay!.offset } };
      } else {
        const endpoints: [string, string] | undefined = state === 'construction'
          ? [`workshop/derived/static/t${asset.tier}-construction.png`, `services/${asset.states.idle.path}`]
          : state === 'collapse' ? [`services/${asset.states.damaged.path}`, path.posix.normalize(`services/${asset.states.destroyed.path}`)] : undefined;
        await clip(id, path.posix.normalize(`services/${item.path}`), item, asset, undefined, endpoints);
      }
    }
    const fx = asset.states.ready.overlay!;
    await clip(`${base}_ready_fx`, path.posix.normalize(`services/${fx.path}`), { ...fx, loop: false });
    bind('lodge', asset.tier, base, SERVICES_SHA);
  }
  function bind(family: 'workshop' | 'lodge', tier: number, atlas: string, sourceManifestSha256: string): void {
    const value: PhaseEServiceBuildingsMetadata['bindings'][string]['value'] = {
      version: 1, family, tier, atlas, sourceScale: 1, sourceManifestSha256, sourceIndexSha256: INDEX_SHA,
      clips: [...STATES.map(state => `${atlas}_${state}`), `${atlas}_ready_fx`].map(id => ({ id, ...clips[id]! })) };
    bindings[atlas] = { sha256: digest(JSON.stringify(value)), value };
  }
  const pack: PhaseEServiceBuildingsPack = { frames, metadata: { schemaVersion: 1, families: ['workshop', 'lodge'], atlases,
    sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1, sourceManifestSha256: { workshop: WORKSHOP_SHA, services: SERVICES_SHA },
    indexSha256: INDEX_SHA, provenanceSha256: { workshop: WORKSHOP_PROVENANCE_SHA, lodge: LODGE_PROVENANCE_SHA }, clips, bindings } };
  assertPhaseEServiceBuildingsKeys(pack, new Set()); return pack;
}

export function assertPhaseEServiceBuildingsKeys(pack: PhaseEServiceBuildingsPack, existing: ReadonlySet<string>): void {
  const keys = new Set<string>();
  for (const { key } of pack.frames) {
    if (!/^pe_(?:workshop|lodge)_t[1-4]_(?:idle|working|damaged|ready|destroyed|construction|collapse|ready_fx)_f[1-9]\d*$/.test(key)
      || keys.has(key) || existing.has(key)) fail(`key collision/unadmitted key: ${key}`);
    keys.add(key);
  }
  if (keys.size !== PHASE_E_SERVICE_BUILDINGS_COUNTS.frames || Object.keys(pack.metadata.clips).length !== PHASE_E_SERVICE_BUILDINGS_COUNTS.clips
    || new Set(pack.metadata.atlases).size !== PHASE_E_SERVICE_BUILDINGS_COUNTS.groups) fail('clip/frame/group count changed');
  for (const [id, clip] of Object.entries(pack.metadata.clips)) {
    for (const frame of clip.frames) if (!keys.has(frame.key) || frame.key.split('_').slice(0, 3).join('_') !== id.split('_').slice(0, 3).join('_')) fail('missing/local alias frame');
    if (clip.overlay && !pack.metadata.clips[clip.overlay.clip]) fail('missing ready overlay');
  }
}

export async function emitPhaseEServiceBuildingsManifest(pack: PhaseEServiceBuildingsPack, output: string): Promise<void> {
  await fs.writeFile(path.join(output, 'pe_service_buildings.manifest.json'), JSON.stringify(pack.metadata, null, 2) + '\n');
}
