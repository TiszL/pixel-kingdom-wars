import type { BoundCosmeticAppearance } from '@shardkeep/shared/boundCosmeticApi';
import { versionedPublicAsset } from '../version';

const MANIFEST_SHA = 'b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394';
const INDEX_SHA = '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181';
/** Artifact identities from the admitted source binding, never recipe/game tuning. */
const BINDINGS: Record<string, string> = {
  artisan_market_awning_t1: 'eb0f98c1eeb2dd4657fc2f2144c2f387e7fc763a9c9e95c6c77598e5458acea5',
  artisan_market_awning_t2: '805ddc70f1794a2625aeaefea705e71b5d92d73127c976b7d665c71f70c131e2',
  artisan_market_awning_t3: '0e2d687e929e2505170f039a5902229a1be22e6c7a8adaff1c90bfa0bf4bde88',
  artisan_market_awning_t4: '38a533ed017a858e5862d1c6e27e52f2e80787ccc52518bc5c51c46dc968537a',
  aurora_wake: 'f061211842f342a719bbf1ebe09ac2e085043c43f64f85bbc55582ec82d2a094',
};
const need = (value: unknown): void => { if (!value) throw Error('The appearance preview could not be verified.'); };
const object = (value: unknown): Record<string, unknown> => {
  need(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function admitted(appearance: BoundCosmeticAppearance): void {
  const a = object(appearance);
  need(Object.keys(a).sort().join(',') === 'bindingSha256,outputId,sourceId,sourceIndexSha256,sourceManifestSha256,version');
  need(a.version === 1 && typeof a.outputId === 'string' && Object.hasOwn(BINDINGS, a.outputId)
    && a.bindingSha256 === BINDINGS[a.outputId] && a.sourceManifestSha256 === MANIFEST_SHA && a.sourceIndexSha256 === INDEX_SHA);
  need(a.sourceId === (a.outputId === 'aurora_wake' ? 'auroraWake' : `artisan-market-t${String(a.outputId).slice(-1)}`));
}
export interface CosmeticPreviewFrames {
  width: number; height: number; fps: number; loop: boolean; reducedMotionFrame: number;
  atlasWidth: number; atlasHeight: number;
  frames: Array<{ key: string; x: number; y: number; w: number; h: number; rgbaSha256: string }>;
}
export interface LoadedCosmeticPreview extends CosmeticPreviewFrames { bitmap: ImageBitmap }

/** Validate the selected complete binding before trusting any frame geometry.
 * Only that binding's clips are used; the unbound top-level clip table is inert. */
export async function validateCosmeticPreview(manifest: unknown, atlas: unknown, appearance: BoundCosmeticAppearance): Promise<CosmeticPreviewFrames> {
  admitted(appearance);
  const m = object(manifest), binding = object(object(m.bindings)[appearance.outputId]);
  need(m.schemaVersion === 1 && m.atlas === 'pe_cosmetics' && m.sourceScale === 1 && m.sourceIndexBase === 0 && m.keyIndexBase === 1);
  need(m.sourceManifestSha256 === MANIFEST_SHA && m.indexSha256 === INDEX_SHA && binding.sha256 === appearance.bindingSha256);
  const value = object(binding.value);
  need(value.version === 1 && value.outputId === appearance.outputId && value.sourceId === appearance.sourceId
    && value.sourceManifestSha256 === MANIFEST_SHA && value.sourceIndexSha256 === INDEX_SHA && value.sourceScale === 1);
  need(await sha256(JSON.stringify(value)) === appearance.bindingSha256);
  need(Array.isArray(value.clips));
  const id = appearance.outputId === 'aurora_wake' ? 'pe_cos_wake' : `pe_cos_market_t${appearance.outputId.slice(-1)}_idle`;
  const clip = object((value.clips as unknown[]).find(item => object(item).id === id));
  const textures = object(atlas).textures;
  need(Array.isArray(textures) && textures.length === 1);
  const texture = object((textures as unknown[])[0]), size = object(texture.size);
  need(Number.isInteger(size.w) && Number.isInteger(size.h) && Number(size.w) > 0 && Number(size.h) > 0 && Number(size.w) <= 4096 && Number(size.h) <= 4096);
  need(Array.isArray(texture.frames));
  const index = new Map<string, Record<string, unknown>>();
  for (const raw of texture.frames as unknown[]) {
    const frame = object(raw); need(typeof frame.filename === 'string' && !index.has(frame.filename));
    index.set(String(frame.filename), frame);
  }
  const frames = (clip.frames as Array<{ key: string; rgbaSha256: string }>).map(({ key, rgbaSha256 }) => {
    const frame = object(index.get(key)), rect = object(frame.frame), original = object(frame.sourceSize), sprite = object(frame.spriteSourceSize);
    need(frame.rotated === false && frame.trimmed === false);
    need([rect.x, rect.y, rect.w, rect.h].every(Number.isInteger));
    need(Number(rect.x) >= 0 && Number(rect.y) >= 0 && rect.w === clip.cellW && rect.h === clip.cellH
      && Number(rect.x) + Number(rect.w) <= Number(size.w) && Number(rect.y) + Number(rect.h) <= Number(size.h));
    need(original.w === clip.cellW && original.h === clip.cellH && sprite.x === 0 && sprite.y === 0 && sprite.w === clip.cellW && sprite.h === clip.cellH);
    return { key, rgbaSha256, x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) };
  });
  return { width: Number(clip.cellW), height: Number(clip.cellH), fps: Number(clip.fps), loop: clip.loop === true,
    reducedMotionFrame: Number(clip.reducedMotionFrame), atlasWidth: Number(size.w), atlasHeight: Number(size.h), frames };
}

/** Fixed same-origin, build-versioned public art only. No cookie, caller URL,
 * source-master copy or read of a mutable equipment/reward DTO. */
export async function loadCosmeticPreview(appearance: BoundCosmeticAppearance, signal: AbortSignal): Promise<LoadedCosmeticPreview> {
  admitted(appearance); signal.throwIfAborted();
  async function get(name: 'manifest.json' | '@1x.json' | '@1x.png'): Promise<Response> {
    const file = name === 'manifest.json' ? 'pe_cosmetics.manifest.json' : `pe_cosmetics${name}`;
    const response = await fetch(versionedPublicAsset(`/atlas/${file}`), { signal, credentials: 'omit', mode: 'same-origin', redirect: 'error' });
    signal.throwIfAborted(); need(response.ok); return response;
  }
  const [manifest, atlas, png] = await Promise.all([
    get('manifest.json').then(r => r.json() as Promise<unknown>),
    get('@1x.json').then(r => r.json() as Promise<unknown>),
    get('@1x.png').then(r => r.blob()),
  ]);
  signal.throwIfAborted(); need(png.type === 'image/png');
  const plan = await validateCosmeticPreview(manifest, atlas, appearance);
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(png, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    signal.throwIfAborted(); need(bitmap.width === plan.atlasWidth && bitmap.height === plan.atlasHeight);
    const canvas = document.createElement('canvas'); canvas.width = plan.width; canvas.height = plan.height;
    const context = canvas.getContext('2d', { willReadFrequently: true }); need(context);
    for (const frame of plan.frames) {
      context!.clearRect(0, 0, plan.width, plan.height);
      context!.drawImage(bitmap, frame.x, frame.y, frame.w, frame.h, 0, 0, plan.width, plan.height);
      need(await sha256(new Uint8Array(context!.getImageData(0, 0, plan.width, plan.height).data)) === frame.rgbaSha256);
      signal.throwIfAborted();
    }
    return { ...plan, bitmap };
  } catch (error) { bitmap.close(); throw error; }
}
