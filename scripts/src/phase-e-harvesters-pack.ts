import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const PHASE_E_HARVESTERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/phase-e/harvesters');
export const PHASE_E_HARVESTERS_COUNTS = { sourcePngs: 256, clips: 224, frames: 992, groups: 32 } as const;
const MANIFEST_SHA = '0a977cffac8af0f1cb34515b0782d39f9a7b21afe07606d9b3113737024b5320';
const INDEX_SHA = '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181';
const PROVENANCE_SHA = 'bfeeec915d023bf720a56d183f714855edd2574b6558c0133ffc346437960385';
const REALMS = ['frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach', 'stormcairn', 'thornwake', 'cinderfall'] as const;
const STATES = ['idle', 'working', 'damaged', 'ready', 'destroyed', 'construction', 'collapse'] as const;
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fail = (reason: string): never => { throw new Error(`phase-e harvesters preflight: ${reason}`); };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Rect = { x: number; y: number; w: number; h: number };
type Identity = { id: string; sourceId: string; displayName: string; tier: number };
interface Static extends Identity { state: string; active: boolean; localPath: string; sha256: string }
interface Animation extends Identity {
  state: string; active: boolean; key: string; atlasPath: string; atlasMetadataPath: string;
  cell: [number, number]; frameCount: number; fps: number; loop: boolean; playbackFrameIndices: number[];
  sourcePath?: string; sourcePaths?: [string, string];
}
export interface HarvesterClip {
  sourcePath: string; sourceSha256: string; sourceMetadataPath?: string; sourceMetadataSha256?: string;
  cellW: 112; cellH: 112; anchorPx: [56, 112]; anchorKind: 'cellBottomPivotX'; sourcePivot: [56, 104]; footprint: [2, 2];
  fps: number; loop: boolean; holdLastFrame: boolean; playbackFrameIndices: number[];
  frames: Array<{ sourceIndex: number; key: string; rgbaSha256: string; sourceRect: Rect }>;
}
export interface PhaseEHarvestersMetadata {
  schemaVersion: 1; family: 'harvester'; sourceScale: 1; sourceIndexBase: 0; keyIndexBase: 1;
  sourceManifestSha256: string; indexSha256: string; provenanceSha256: string;
  runtimeReady: true; runtimeApproval: 'D153.302-tester'; sourceStatus: string; atlases: string[]; clips: Record<string, HarvesterClip>;
  bindings: Record<string, { sha256: string; value: Identity & {
    version: 1; family: 'harvester'; atlas: string; sourceScale: 1; sourceManifestSha256: string;
    sourceIndexSha256: string; sourceProvenanceSha256: string;
    aliases: { rubble: string }; scaffold: { sourcePath: string; sourceSha256: string; rgbaSha256: string };
    readyComposition: { alreadyComposed: true; fxId: 'craft-success'; sourceOffsetPx: [24, -12] };
    clips: Array<{ id: string } & HarvesterClip>;
  } }>;
}
export interface PhaseEHarvestersPack { frames: Array<{ key: string; png: Buffer }>; metadata: PhaseEHarvestersMetadata }

/** The complete authored manifest is retained verbatim, but only its pinned
 * active statics and grids are read. Masters/rejected alternatives stay inert.
 * Ready already contains the star; it is not an overlay or a gameplay event. */
export async function loadPhaseEHarvestersPack(root = PHASE_E_HARVESTERS_DIR): Promise<PhaseEHarvestersPack> {
  async function pinned<T>(relative: string, sha: string): Promise<T> {
    const bytes = await fs.readFile(path.join(root, relative));
    if (digest(bytes) !== sha) fail(`admitted manifest/provenance changed: ${relative}`);
    return JSON.parse(bytes.toString()) as T;
  }
  const manifest = await pinned<{ status: string; runtimeReady: boolean; outputs: Static[]; animationOutputs: Animation[];
    realmNames: Record<string, { sourceId: string; displayName: string }>;
    stateCompositions: Array<Identity & { states: Record<string, { localPath?: string; key?: string; aliasOf?: string }> }>;
  }>('manifest.json', MANIFEST_SHA);
  const provenance = await pinned<{ indexSha256: string; manifestSha256: string;
    files: Array<{ path: string; bytes: number; sha256: string; indexPath: string | null; size?: [number, number] }> }>('provenance.json', PROVENANCE_SHA);
  if (manifest.runtimeReady !== false || provenance.indexSha256 !== INDEX_SHA || provenance.manifestSha256 !== MANIFEST_SHA) fail('source identity changed');
  const bytes = new Map<string, Buffer>(), images = new Map<string, { rgba: Buffer; width: number; height: number }>();
  for (const file of provenance.files) {
    if (path.posix.normalize(file.path) !== file.path || file.path.startsWith('../') || path.isAbsolute(file.path) || bytes.has(file.path)) fail('unsafe/duplicate admitted path');
    if (file.indexPath !== (['PLAN.md', 'QA.md'].includes(file.path) ? null : `production-assets/harvesters/${file.path}`)) fail('runtime index binding changed');
    const contents = await fs.readFile(path.join(root, file.path));
    if (contents.length !== file.bytes || digest(contents) !== file.sha256) fail(`source hash changed: ${file.path}`);
    bytes.set(file.path, contents);
    if (!file.size) continue;
    const image = sharp(contents), meta = await image.metadata();
    if (meta.format !== 'png' || !meta.hasAlpha || meta.width !== file.size[0] || meta.height !== file.size[1]) fail(`PNG geometry changed: ${file.path}`);
    images.set(file.path, { rgba: await image.ensureAlpha().raw().toBuffer(), width: file.size[0], height: file.size[1] });
  }
  if (images.size !== 256 || bytes.size !== 355 || manifest.outputs.filter(a => a.active).length !== 160
    || manifest.animationOutputs.filter(a => a.active).length !== 96 || manifest.stateCompositions.length !== 32) fail('source inventory changed');
  const frames: PhaseEHarvestersPack['frames'] = [], clips: PhaseEHarvestersMetadata['clips'] = {};
  const atlases: string[] = [], bindings: PhaseEHarvestersMetadata['bindings'] = {};
  for (const sourceId of REALMS) for (const tier of [1, 2, 3, 4]) {
    const id = `${sourceId}-t${tier}`, atlas = `pe_harvester_${sourceId.replaceAll('-', '_')}_t${tier}`;
    const identity = { id, sourceId, displayName: manifest.realmNames[sourceId]!.displayName, tier };
    const appearance = manifest.stateCompositions.filter(a => a.id === id);
    if (appearance.length !== 1 || !equal({ id: appearance[0]!.id, sourceId: appearance[0]!.sourceId, displayName: appearance[0]!.displayName, tier: appearance[0]!.tier }, identity)) fail(`appearance identity changed: ${id}`);
    const composition = appearance[0]!.states;
    function staticSource(state: string): string {
      const records = manifest.outputs.filter(a => a.active && a.id === id && a.state === state);
      if (records.length !== 1) fail(`ambiguous active static: ${id}/${state}`);
      const record = records[0]!, source = record.localPath;
      if (record.sourceId !== sourceId || record.tier !== tier || record.displayName !== identity.displayName
        || composition[state]?.localPath !== source || !bytes.has(source) || digest(bytes.get(source)!) !== record.sha256) fail(`static binding changed: ${id}/${state}`);
      const image = images.get(source);
      if (!image || image.width !== 112 || image.height !== 112) fail(`static geometry changed: ${id}/${state}`);
      return source;
    }
    const statics = Object.fromEntries(['idle', 'damaged', 'ready', 'construction', 'destroyed'].map(state => [state, staticSource(state)]));
    if (composition.rubble?.aliasOf !== 'destroyed' || composition.rubble.localPath !== statics.destroyed) fail('rubble alias changed');
    for (const state of STATES) {
      const clipId = `${atlas}_${state}`;
      let source: string, metadataPath: string | undefined, playback = [0], loop = false, fps = 0;
      let endpoints: [string, string] | undefined;
      let rectangles: Rect[] = [{ x: 0, y: 0, w: 112, h: 112 }];
      if (['working', 'construction', 'collapse'].includes(state)) {
        const records = manifest.animationOutputs.filter(a => a.active && a.id === id && a.state === state);
        if (records.length !== 1) fail(`ambiguous active animation: ${clipId}`);
        const a = records[0]!; source = a.atlasPath; metadataPath = a.atlasMetadataPath;
        playback = Array.from({ length: state === 'working' ? 8 : 9 }, (_, i) => i); loop = state === 'working'; fps = 8;
        endpoints = state === 'working' ? [statics.idle!, statics.idle!]
          : state === 'construction' ? [statics.construction!, statics.idle!] : [statics.damaged!, statics.destroyed!];
        if (a.sourceId !== sourceId || a.displayName !== identity.displayName || a.tier !== tier || a.key !== composition[state]?.key
          || a.frameCount !== 9 || a.fps !== fps || a.loop !== loop || !equal(a.cell, [112, 112]) || !equal(a.playbackFrameIndices, playback)
          || !equal(a.sourcePaths ?? [a.sourcePath, a.sourcePath], endpoints)) fail(`animation binding changed: ${clipId}`);
        const layoutBytes = bytes.get(metadataPath); if (!layoutBytes) fail('unadmitted grid metadata');
        const layout = JSON.parse(layoutBytes!.toString()) as { image: string; padding: number; losslessPixelCopyVerified: boolean;
          frames: Array<{ index: number; frame: Rect; sourceSize: { w: number; h: number }; rotated: boolean; trimmed: boolean }> };
        if (layout.image !== path.posix.basename(source) || layout.padding !== 2 || layout.losslessPixelCopyVerified !== true || layout.frames.length !== 9) fail(`grid contract changed: ${clipId}`);
        rectangles = layout.frames.map((frame, i) => {
          const expected = { x: 2 + i % 3 * 114, y: 2 + Math.floor(i / 3) * 114, w: 112, h: 112 };
          if (frame.index !== i || !equal(frame.frame, expected) || !equal(frame.sourceSize, { w: 112, h: 112 }) || frame.rotated !== false || frame.trimmed !== false) fail(`grid cell changed: ${clipId}/${i}`);
          return expected;
        });
      } else source = statics[state]!;
      const image = images.get(source);
      if (!image || image.width !== (metadataPath ? 344 : 112) || image.height !== (metadataPath ? 344 : 112)) fail(`unadmitted source/geometry: ${source}`);
      const refs: HarvesterClip['frames'] = [];
      for (const [sourceIndex, r] of rectangles.entries()) {
        const rgba = await sharp(image!.rgba, { raw: { width: image!.width, height: image!.height, channels: 4 } })
          .extract({ left: r.x, top: r.y, width: r.w, height: r.h }).raw().toBuffer();
        if (endpoints && (sourceIndex === 0 || sourceIndex === 8) && !rgba.equals(images.get(endpoints[sourceIndex === 0 ? 0 : 1])!.rgba)) fail(`transition endpoint changed: ${clipId}/${sourceIndex}`);
        const key = `${clipId}_f${sourceIndex + 1}`;
        frames.push({ key, png: await sharp(rgba, { raw: { width: 112, height: 112, channels: 4 } }).png().toBuffer() });
        refs.push({ sourceIndex, key, rgbaSha256: digest(rgba), sourceRect: r });
      }
      clips[clipId] = { sourcePath: source, sourceSha256: digest(bytes.get(source)!),
        ...(metadataPath ? { sourceMetadataPath: metadataPath, sourceMetadataSha256: digest(bytes.get(metadataPath)!) } : {}),
        cellW: 112, cellH: 112, anchorPx: [56, 112], anchorKind: 'cellBottomPivotX', sourcePivot: [56, 104], footprint: [2, 2],
        fps, loop, holdLastFrame: !loop, playbackFrameIndices: playback, frames: refs };
    }
    atlases.push(atlas);
    const scaffold = statics.construction!;
    const value: PhaseEHarvestersMetadata['bindings'][string]['value'] = { ...identity, version: 1, family: 'harvester', atlas,
      sourceScale: 1, sourceManifestSha256: MANIFEST_SHA, sourceIndexSha256: INDEX_SHA, sourceProvenanceSha256: PROVENANCE_SHA,
      aliases: { rubble: `${atlas}_destroyed` }, scaffold: { sourcePath: scaffold, sourceSha256: digest(bytes.get(scaffold)!), rgbaSha256: digest(images.get(scaffold)!.rgba) },
      readyComposition: { alreadyComposed: true, fxId: 'craft-success', sourceOffsetPx: [24, -12] },
      clips: STATES.map(state => ({ id: `${atlas}_${state}`, ...clips[`${atlas}_${state}`]! })) };
    bindings[atlas] = { sha256: digest(JSON.stringify(value)), value };
  }
  const pack: PhaseEHarvestersPack = { frames, metadata: { schemaVersion: 1, family: 'harvester', sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1,
    sourceManifestSha256: MANIFEST_SHA, indexSha256: INDEX_SHA, provenanceSha256: PROVENANCE_SHA,
    // D153.302 (review 5623b84a): owner approved prepared art for the tester build.
    // Keep the pinned original manifest/provenance and all pixels byte-identical.
    runtimeReady: true, runtimeApproval: 'D153.302-tester',
    sourceStatus: manifest.status, atlases, clips, bindings } };
  assertPhaseEHarvestersKeys(pack, new Set()); return pack;
}

export function assertPhaseEHarvestersKeys(pack: PhaseEHarvestersPack, existing: ReadonlySet<string>): void {
  const keys = new Set<string>(), expected = new Set<string>();
  const groups = REALMS.flatMap(realm => [1, 2, 3, 4].map(t => `pe_harvester_${realm.replaceAll('-', '_')}_t${t}`));
  if (!equal(pack.metadata.atlases, groups) || Object.keys(pack.metadata.bindings).length !== 32 || Object.keys(pack.metadata.clips).length !== 224) fail('closed group/clip set changed');
  for (const group of groups) {
    const b = pack.metadata.bindings[group];
    if (!b || b.sha256 !== digest(JSON.stringify(b.value)) || b.value.atlas !== group || b.value.clips.length !== 7) fail('source binding changed');
    for (const state of STATES) {
      const id = `${group}_${state}`, clip = pack.metadata.clips[id];
      const count = ['working', 'construction', 'collapse'].includes(state) ? 9 : 1;
      if (!clip || clip.frames.length !== count || !equal(b!.value.clips.find(c => c.id === id), { id, ...clip })) fail('source clip binding changed');
      for (let i = 0; i < count; i++) {
        const key = `${id}_f${i + 1}`;
        if (clip!.frames[i]?.key !== key || clip!.frames[i]?.sourceIndex !== i) fail('missing/local frame');
        expected.add(key);
      }
    }
  }
  for (const { key } of pack.frames) {
    if (!expected.has(key) || keys.has(key) || existing.has(key)) fail(`key collision/unadmitted key: ${key}`);
    keys.add(key);
  }
  if (keys.size !== PHASE_E_HARVESTERS_COUNTS.frames) fail('frame count changed');
}
export async function emitPhaseEHarvestersManifest(pack: PhaseEHarvestersPack, output: string): Promise<void> {
  await fs.writeFile(path.join(output, 'pe_harvesters.manifest.json'), JSON.stringify(pack.metadata, null, 2) + '\n');
}
