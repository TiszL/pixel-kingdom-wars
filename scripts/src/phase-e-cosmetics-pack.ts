import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const PHASE_E_COSMETICS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/phase-e/cosmetics');
export const PHASE_E_COSMETICS_COUNTS = { sourcePngs: 30, clips: 30, frames: 132 } as const;
const SOURCE_MANIFEST_SHA = 'b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394';
const INDEX_SHA = '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181';
const PROVENANCE_SHA = '52ea93251eb6aa600af8c15cc9b884a9e55be4941180604956941d5956f27beb';
const STATES = ['idle', 'working', 'damaged', 'ready', 'destroyed', 'construction', 'collapse'] as const;
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(`phase-e cosmetics preflight: ${message}`); };
interface SourceClip {
  path: string; cell: [number, number]; frameCount: number; fps: number; loop?: boolean; sha256?: string;
  sourceFrameIndices?: number[]; reducedMotionFrame?: number;
  sourceEndpoints?: { start: string; end: string };
  overlay?: { path: string; cell: [number, number]; frameCount: number; fps: number; offset: [number, number] };
}
export interface CosmeticClip {
  sourcePath: string; sourceSha256: string; cellW: number; cellH: number;
  anchorPx: [number, number]; anchorKind: 'cellBottomPivotX' | 'centre';
  sourcePivot?: [number, number]; footprint?: [number, number];
  fps: number; loop: boolean; reducedMotionFrame: number; sourceFrameIndices?: number[];
  frames: Array<{ sourceIndex: number; key: string; rgbaSha256: string }>;
  alias?: string; overlay?: { clip: string; offset: [number, number] };
}
export interface CosmeticBinding {
  version: 1; outputId: string; sourceId: string; sourceManifestSha256: string; sourceIndexSha256: string;
  sourceScale: 1; clips: Array<{ id: string } & CosmeticClip>;
}
export interface PhaseECosmeticsMetadata {
  schemaVersion: 1; atlas: 'pe_cosmetics'; sourceScale: 1; sourceIndexBase: 0; keyIndexBase: 1;
  sourceManifestSha256: string; indexSha256: string; provenanceSha256: string;
  clips: Record<string, CosmeticClip>;
  bindings: Record<string, { sha256: string; value: CosmeticBinding }>;
}
export interface PhaseECosmeticsPack {
  frames: Array<{ key: string; png: Buffer }>;
  metadata: PhaseECosmeticsMetadata;
}

/** Immutable source admission before generated output is cleared. Only the
 * explicitly indexed subset is opened; original profile/NFT records are inert. */
export async function loadPhaseECosmeticsPack(root = PHASE_E_COSMETICS_DIR): Promise<PhaseECosmeticsPack> {
  const source = await fs.readFile(path.join(root, 'manifest.json'));
  const provenance = await fs.readFile(path.join(root, 'provenance.json'));
  if (digest(source) !== SOURCE_MANIFEST_SHA || digest(provenance) !== PROVENANCE_SHA) fail('admitted manifest/provenance changed');
  const manifest = JSON.parse(source.toString('utf8')) as {
    marketSkins: Array<{ id: string; tier: number; cell: [number, number]; pivot: [number, number];
      footprint: [number, number]; states: Record<typeof STATES[number], SourceClip> }>;
    auroraWake: SourceClip;
  };
  const admitted = JSON.parse(provenance.toString('utf8')) as {
    files: Array<{ path: string; bytes: number; sha256: string; size?: [number, number] }>;
  };
  const files = new Map<string, { bytes: Buffer; rgba: Buffer; width: number; height: number }>();
  for (const file of admitted.files) {
    const bytes = await fs.readFile(path.resolve(root, '..', file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail(`source hash changed: ${file.path}`);
    if (!file.size) continue;
    const image = sharp(bytes), meta = await image.metadata();
    if (meta.format !== 'png' || !meta.hasAlpha || meta.width !== file.size[0] || meta.height !== file.size[1]) fail(`PNG geometry changed: ${file.path}`);
    const rgba = await image.ensureAlpha().raw().toBuffer();
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0 && rgba[i] !== 255) fail(`non-binary alpha: ${file.path}`);
    files.set(file.path, { bytes, rgba, width: file.size[0], height: file.size[1] });
  }
  if (files.size !== PHASE_E_COSMETICS_COUNTS.sourcePngs) fail('source PNG count changed');
  const sourcePath = (relative: string): string => path.posix.normalize(`cosmetics/${relative}`);
  const frames: PhaseECosmeticsPack['frames'] = [], clips: Record<string, CosmeticClip> = {};
  async function clip(id: string, item: SourceClip, building?: { pivot: [number, number]; footprint: [number, number] }): Promise<void> {
    const name = sourcePath(item.path), file = files.get(name);
    if (!file) fail(`unadmitted source: ${name}`);
    const [cellW, cellH] = item.cell;
    if (file!.width !== cellW * item.frameCount || file!.height !== cellH
      || (item.sha256 && digest(file!.bytes) !== item.sha256)) fail(`strip contract changed: ${id}`);
    const frameRefs: CosmeticClip['frames'] = [];
    for (let sourceIndex = 0; sourceIndex < item.frameCount; sourceIndex++) {
      const rgba = await sharp(file!.rgba, { raw: { width: file!.width, height: file!.height, channels: 4 } })
        .extract({ left: sourceIndex * cellW, top: 0, width: cellW, height: cellH }).raw().toBuffer();
      if (item.sourceEndpoints && (sourceIndex === 0 || sourceIndex === item.frameCount - 1)) {
        const endpoint = sourceIndex === 0 ? item.sourceEndpoints.start : item.sourceEndpoints.end;
        if (!rgba.equals(files.get(sourcePath(endpoint))!.rgba)) fail(`transition endpoint changed: ${id}/${sourceIndex}`);
      }
      const key = `${id}_f${sourceIndex + 1}`;
      frames.push({ key, png: await sharp(rgba, { raw: { width: cellW, height: cellH, channels: 4 } }).png().toBuffer() });
      frameRefs.push({ sourceIndex, key, rgbaSha256: digest(rgba) });
    }
    clips[id] = {
      sourcePath: name, sourceSha256: digest(file!.bytes), cellW, cellH,
      anchorPx: building ? [building.pivot[0], cellH] : [cellW / 2, cellH / 2],
      anchorKind: building ? 'cellBottomPivotX' : 'centre',
      ...(building ? { sourcePivot: building.pivot, footprint: building.footprint } : {}),
      fps: item.fps, loop: item.loop ?? false, reducedMotionFrame: item.reducedMotionFrame ?? 0,
      ...(item.sourceFrameIndices ? { sourceFrameIndices: item.sourceFrameIndices } : {}), frames: frameRefs,
    };
  }
  for (const skin of manifest.marketSkins) {
    const base = `pe_cos_market_t${skin.tier}`;
    for (const state of STATES) {
      const item = skin.states[state], id = `${base}_${state}`;
      if (state === 'ready') {
        if (item.path !== skin.states.idle.path || item.sha256 !== skin.states.idle.sha256) fail(`ready alias changed: ${id}`);
        clips[id] = { ...clips[`${base}_idle`]!, alias: `${base}_idle`, overlay: { clip: 'pe_cos_ready_fx', offset: item.overlay!.offset } };
      } else await clip(id, item, skin);
    }
  }
  await clip('pe_cos_wake', manifest.auroraWake);
  await clip('pe_cos_ready_fx', { ...manifest.marketSkins[0]!.states.ready.overlay!, loop: false });
  const bindings: PhaseECosmeticsMetadata['bindings'] = {};
  for (const skin of manifest.marketSkins) {
    bind(`artisan_market_awning_t${skin.tier}`, skin.id, [...STATES.map(state => `pe_cos_market_t${skin.tier}_${state}`), 'pe_cos_ready_fx']);
  }
  bind('aurora_wake', 'auroraWake', ['pe_cos_wake']);
  function bind(outputId: string, sourceId: string, clipIds: string[]): void {
    // Canonical UTF-8 JSON: this exact field order, clip order and frame order,
    // JSON.stringify without whitespace. No runtime-state/readiness assertion.
    const value: CosmeticBinding = { version: 1, outputId, sourceId, sourceManifestSha256: SOURCE_MANIFEST_SHA,
      sourceIndexSha256: INDEX_SHA, sourceScale: 1, clips: clipIds.map(id => ({ id, ...clips[id]! })) };
    bindings[outputId] = { sha256: digest(JSON.stringify(value)), value };
  }
  const pack: PhaseECosmeticsPack = { frames, metadata: {
    schemaVersion: 1, atlas: 'pe_cosmetics', sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1,
    sourceManifestSha256: SOURCE_MANIFEST_SHA, indexSha256: INDEX_SHA, provenanceSha256: PROVENANCE_SHA, clips, bindings,
  } };
  assertPhaseECosmeticsKeys(pack, new Set());
  return pack;
}

/** Includes aliases' referenced keys; no root may silently shadow this pack. */
export function assertPhaseECosmeticsKeys(pack: PhaseECosmeticsPack, existing: ReadonlySet<string>): void {
  const keys = new Set<string>();
  for (const { key } of pack.frames) {
    if (!key.startsWith('pe_cos_') || keys.has(key) || existing.has(key)) fail(`key collision: ${key}`);
    keys.add(key);
  }
  if (keys.size !== PHASE_E_COSMETICS_COUNTS.frames || Object.keys(pack.metadata.clips).length !== PHASE_E_COSMETICS_COUNTS.clips) fail('clip/frame count changed');
  for (const clip of Object.values(pack.metadata.clips)) for (const { key } of clip.frames) if (!keys.has(key)) fail(`missing alias frame: ${key}`);
}

export async function emitPhaseECosmeticsManifest(pack: PhaseECosmeticsPack, output: string): Promise<void> {
  await fs.writeFile(path.join(output, 'pe_cosmetics.manifest.json'), JSON.stringify(pack.metadata, null, 2) + '\n');
}
