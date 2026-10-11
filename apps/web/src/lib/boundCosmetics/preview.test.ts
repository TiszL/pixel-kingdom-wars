// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { BoundCosmeticAppearance } from '@shardkeep/shared/boundCosmeticApi';
import { loadPhaseECosmeticsPack } from '../../../../../scripts/src/phase-e-cosmetics-pack';
import { loadCosmeticPreview, validateCosmeticPreview } from './preview';
vi.mock('../version', () => ({ versionedPublicAsset: (path: string) => `${path}?v=test-build` }));
let manifest: Awaited<ReturnType<typeof loadPhaseECosmeticsPack>>['metadata'];
let atlas: { textures: Array<{ size: { w: number; h: number }; frames: Array<{ filename: string; rotated: boolean; trimmed: boolean; sourceSize: { w: number; h: number }; spriteSourceSize: { x: number; y: number; w: number; h: number }; frame: { x: number; y: number; w: number; h: number } }> }> };
function appearance(outputId = 'aurora_wake'): BoundCosmeticAppearance {
  const { value, sha256 } = manifest.bindings[outputId]!;
  return { version: 1, outputId, sourceId: value.sourceId, sourceManifestSha256: value.sourceManifestSha256, sourceIndexSha256: value.sourceIndexSha256, bindingSha256: sha256 } as BoundCosmeticAppearance;
}
beforeAll(async () => {
  const pack = await loadPhaseECosmeticsPack(); manifest = pack.metadata;
  const refs = new Map(Object.values(manifest.clips).flatMap(c => c.frames.map(f => [f.key, { w: c.cellW, h: c.cellH }] as const)));
  // Synthetic atlas coordinates test the consumer contract; actual source
  // metadata/hashes come unchanged from the accepted loader. Browser pixels
  // are a separate root acceptance, not established by this unit fixture.
  atlas = { textures: [{ size: { w: 1344, h: 1232 }, frames: pack.frames.map(({ key }, i) => {
    const size = refs.get(key)!; return { filename: key, rotated: false, trimmed: false, sourceSize: size,
      spriteSourceSize: { x: 0, y: 0, ...size }, frame: { x: i % 12 * 112, y: Math.floor(i / 12) * 112, ...size } };
  }) }] };
});
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('accepts exactly the five admitted source bindings and chooses idle versus authored looping Wake', async () => {
  for (const id of Object.keys(manifest.bindings)) {
    const view = await validateCosmeticPreview(manifest, atlas, appearance(id));
    expect(view.frames).toHaveLength(id === 'aurora_wake' ? 8 : 1);
    expect(view.loop).toBe(id === 'aurora_wake');
    expect(view.width).toBe(id === 'aurora_wake' ? 64 : 112);
    expect(view.reducedMotionFrame).toBe(0);
  }
});
it('rejects unknown or mismatched appearance identities before making an art request', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const changed of [{ outputId: 'unknown' }, { sourceId: 'artisan-market-t1' }, { bindingSha256: '0'.repeat(64) }, { sourceManifestSha256: '0'.repeat(64) }]) {
    await expect(loadCosmeticPreview({ ...appearance(), ...changed } as BoundCosmeticAppearance, new AbortController().signal)).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('refuses changed timing or frame identity even when untrusted metadata repeats the admitted digest', async () => {
  const changed = structuredClone(manifest); changed.bindings.aurora_wake!.value.clips[0]!.fps = 99;
  await expect(validateCosmeticPreview(changed, atlas, appearance())).rejects.toThrow();
  const unchanged = structuredClone(manifest); unchanged.clips.pe_cos_wake!.fps = 99;
  expect((await validateCosmeticPreview(unchanged, atlas, appearance())).fps).toBe(8); // Only bound clips have authority.
});
it('refuses missing, rotated, cropped or out-of-bounds packed frame mappings', async () => {
  for (const kind of ['missing', 'rotated', 'trimmed', 'bounds', 'duplicate']) {
    const changed = structuredClone(atlas), frames = changed.textures[0]!.frames;
    const frame = frames.find(f => f.filename === 'pe_cos_wake_f1')!;
    if (kind === 'missing') frames.splice(frames.indexOf(frame), 1);
    if (kind === 'rotated') frame.rotated = true;
    if (kind === 'trimmed') frame.trimmed = true;
    if (kind === 'bounds') frame.frame.x = 4096;
    if (kind === 'duplicate') frames.push(frame);
    await expect(validateCosmeticPreview(manifest, changed, appearance())).rejects.toThrow();
  }
});
it('uses only versioned same-origin public paths and closes a wrong packed image after pixel verification fails', async () => {
  const bitmap = { width: 1344, height: 1232, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(64 * 64 * 4) }) } as never);
  const fetch = vi.fn<typeof globalThis.fetch>(async input => { const url = String(input); return url.includes('manifest.json') ? new Response(JSON.stringify(manifest))
    : url.includes('@1x.json') ? new Response(JSON.stringify(atlas)) : new Response(new Blob(['not real pixels'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }); });
  vi.stubGlobal('fetch', fetch);
  await expect(loadCosmeticPreview(appearance(), new AbortController().signal)).rejects.toThrow();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/atlas/pe_cosmetics.manifest.json?v=test-build', '/atlas/pe_cosmetics@1x.json?v=test-build', '/atlas/pe_cosmetics@1x.png?v=test-build']);
  expect(fetch.mock.calls.every(([, options]) => (options as RequestInit).credentials === 'omit' && (options as RequestInit).mode === 'same-origin' && (options as RequestInit).redirect === 'error')).toBe(true);
  expect(bitmap.close).toHaveBeenCalledOnce();
});
it('does not decode bytes arriving after cancellation or make requests for an already-aborted caller', async () => {
  const controller = new AbortController(); controller.abort();
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(loadCosmeticPreview(appearance(), controller.signal)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  const later = new AbortController(); let release!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  const pending = loadCosmeticPreview(appearance(), later.signal); later.abort(); release(new Response('{}'));
  await expect(pending).rejects.toThrow(); expect(decode).not.toHaveBeenCalled();
});
