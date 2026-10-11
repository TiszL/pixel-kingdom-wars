import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const PHASE_E_MARKET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/phase-e/services');
export const PHASE_E_MARKET_COUNTS = { sourcePngs: 29, clips: 32, frames: 148, groups: 4 } as const;
const SOURCE_MANIFEST_SHA = 'f7cbf1bf9646d31baf5d7fcd0706e85348f24c199022dde22292adb3e19f1885';
const INDEX_SHA = '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181';
const PROVENANCE_SHA = '9ac9bd97c5bdd9add6f607c2c073f230022cd668b2dcb0978566ef0d8ac841ea';
const STATES = ['idle', 'working', 'damaged', 'ready', 'destroyed', 'construction', 'collapse'] as const;
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new Error(`phase-e Market preflight: ${message}`); };
interface SourceClip {
  path: string; cell: [number, number]; frameCount: number; fps: number; loop?: boolean;
  sha256?: string; frameHashes?: string[]; reducedMotionFrame?: number;
  overlay?: { path: string; cell: [number, number]; frameCount: number; fps: number; offset: [number, number] };
}
export interface MarketClip {
  sourcePath: string; sourceSha256: string; cellW: number; cellH: number;
  anchorPx: [number, number]; anchorKind: 'cellBottomPivotX' | 'centre';
  sourcePivot?: [number, number]; footprint?: [number, number];
  fps: number; loop: boolean; reducedMotionFrame: number;
  frames: Array<{ sourceIndex: number; key: string; rgbaSha256: string }>;
  alias?: string; overlay?: { clip: string; offset: [number, number] };
}
export interface PhaseEMarketMetadata {
  schemaVersion: 1; family: 'market'; atlases: string[]; sourceScale: 1; sourceIndexBase: 0; keyIndexBase: 1;
  sourceManifestSha256: string; indexSha256: string; provenanceSha256: string;
  clips: Record<string, MarketClip>;
}
export interface PhaseEMarketPack {
  frames: Array<{ key: string; png: Buffer }>;
  metadata: PhaseEMarketMetadata;
}

/** Validates only the frozen Market subset before any generated output is cleared. */
export async function loadPhaseEMarketPack(root = PHASE_E_MARKET_DIR): Promise<PhaseEMarketPack> {
  const source = await fs.readFile(path.join(root, 'manifest.json'));
  const provenance = await fs.readFile(path.join(root, 'provenance.json'));
  if (digest(source) !== SOURCE_MANIFEST_SHA || digest(provenance) !== PROVENANCE_SHA) fail('admitted manifest/provenance changed');
  const manifest = JSON.parse(source.toString('utf8')) as {
    assets: Array<{ id: string; family: string; tier: number; pivot: [number, number];
      footprint: [number, number]; states: Record<typeof STATES[number], SourceClip> }>;
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
  if (files.size !== PHASE_E_MARKET_COUNTS.sourcePngs) fail('source PNG count changed');
  const sourcePath = (relative: string): string => path.posix.normalize(`services/${relative}`);
  const frames: PhaseEMarketPack['frames'] = [], clips: Record<string, MarketClip> = {};
  async function clip(
    id: string, item: SourceClip, building?: { pivot: [number, number]; footprint: [number, number] },
    endpoints?: [string, string],
  ): Promise<void> {
    const name = sourcePath(item.path), file = files.get(name);
    if (!file) fail(`unadmitted source: ${name}`);
    const [cellW, cellH] = item.cell;
    if (file!.width !== cellW * item.frameCount || file!.height !== cellH
      || (item.sha256 && digest(file!.bytes) !== item.sha256)) fail(`strip contract changed: ${id}`);
    const frameRefs: MarketClip['frames'] = [];
    for (let sourceIndex = 0; sourceIndex < item.frameCount; sourceIndex++) {
      const rgba = await sharp(file!.rgba, { raw: { width: file!.width, height: file!.height, channels: 4 } })
        .extract({ left: sourceIndex * cellW, top: 0, width: cellW, height: cellH }).raw().toBuffer();
      if (item.frameHashes && item.frameHashes[sourceIndex] !== digest(rgba)) fail(`authored frame hash changed: ${id}/${sourceIndex}`);
      if (endpoints && (sourceIndex === 0 || sourceIndex === item.frameCount - 1)) {
        const expected = files.get(sourcePath(endpoints[sourceIndex === 0 ? 0 : 1]));
        if (!expected || !rgba.equals(expected.rgba)) fail(`transition endpoint changed: ${id}/${sourceIndex}`);
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
      fps: item.fps, loop: item.loop ?? false, reducedMotionFrame: item.reducedMotionFrame ?? 0, frames: frameRefs,
    };
  }
  const atlases: string[] = [];
  for (const asset of manifest.assets.filter((item) => item.family === 'market')) {
    const base = `pe_market_t${asset.tier}`;
    atlases.push(base);
    for (const state of STATES) {
      const item = asset.states[state], id = `${base}_${state}`;
      if (state === 'ready') {
        if (item.path !== asset.states.idle.path || item.sha256 !== asset.states.idle.sha256) fail(`ready alias changed: ${id}`);
        clips[id] = { ...clips[`${base}_idle`]!, alias: `${base}_idle`, overlay: { clip: `${base}_ready_fx`, offset: item.overlay!.offset } };
      } else {
        const endpoints: [string, string] | undefined = state === 'construction'
          ? [`../workshop/derived/static/t${asset.tier}-construction.png`, asset.states.idle.path]
          : state === 'collapse' ? [asset.states.damaged.path, asset.states.destroyed.path] : undefined;
        await clip(id, item, asset, endpoints);
      }
    }
    // Each ordinary tier is self-contained: no cosmetic or foreign tier residency dependency.
    await clip(`${base}_ready_fx`, { ...asset.states.ready.overlay!, loop: false });
  }
  const pack: PhaseEMarketPack = { frames, metadata: {
    schemaVersion: 1, family: 'market', atlases, sourceScale: 1, sourceIndexBase: 0, keyIndexBase: 1,
    sourceManifestSha256: SOURCE_MANIFEST_SHA, indexSha256: INDEX_SHA, provenanceSha256: PROVENANCE_SHA, clips,
  } };
  assertPhaseEMarketKeys(pack, new Set());
  return pack;
}

export function assertPhaseEMarketKeys(pack: PhaseEMarketPack, existing: ReadonlySet<string>): void {
  const keys = new Set<string>();
  for (const { key } of pack.frames) {
    if (!/^pe_market_t[1-4]_/.test(key) || keys.has(key) || existing.has(key)) fail(`key collision: ${key}`);
    keys.add(key);
  }
  if (keys.size !== PHASE_E_MARKET_COUNTS.frames || Object.keys(pack.metadata.clips).length !== PHASE_E_MARKET_COUNTS.clips
    || new Set(pack.metadata.atlases).size !== PHASE_E_MARKET_COUNTS.groups) fail('clip/frame/group count changed');
  for (const [id, clip] of Object.entries(pack.metadata.clips)) {
    for (const { key } of clip.frames) if (!keys.has(key) || key.split('_').slice(0, 3).join('_') !== id.split('_').slice(0, 3).join('_')) fail(`missing/local alias frame: ${key}`);
    if (clip.overlay && !pack.metadata.clips[clip.overlay.clip]) fail(`missing overlay: ${id}`);
  }
}

export async function emitPhaseEMarketManifest(pack: PhaseEMarketPack, output: string): Promise<void> {
  await fs.writeFile(path.join(output, 'pe_market.manifest.json'), JSON.stringify(pack.metadata, null, 2) + '\n');
}
