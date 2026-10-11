// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoundCosmeticAppearance } from '@shardkeep/shared/boundCosmeticApi';
import { BoundCosmeticPreview } from './BoundCosmeticPreview';
import { loadCosmeticPreview, type LoadedCosmeticPreview } from '../../lib/boundCosmetics/preview';
vi.mock('../../lib/boundCosmetics/preview', () => ({ loadCosmeticPreview: vi.fn() }));
const wake = { version: 1, outputId: 'aurora_wake', sourceId: 'auroraWake', sourceManifestSha256: 'a'.repeat(64), sourceIndexSha256: 'b'.repeat(64), bindingSha256: 'c'.repeat(64) } as BoundCosmeticAppearance;
const awning = { ...wake, outputId: 'artisan_market_awning_t1', sourceId: 'artisan-market-t1' } as BoundCosmeticAppearance;
const fixture = (animated = true): LoadedCosmeticPreview => ({ width: 64, height: 64, atlasWidth: 512, atlasHeight: 64, fps: 8, loop: animated, reducedMotionFrame: 0,
  frames: Array.from({ length: animated ? 8 : 1 }, (_, i) => ({ key: `frame${i}`, x: i * 64, y: 0, w: 64, h: 64, rgbaSha256: '' })),
  bitmap: { width: 512, height: 64, close: vi.fn() } as unknown as ImageBitmap });
let root: Root, host: HTMLDivElement, reduced: boolean, mediaChanged: (() => void) | undefined;
let raf: ReturnType<typeof vi.fn>, cancel: ReturnType<typeof vi.fn>;
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); check(); });
const button = () => host.querySelector('button')!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); reduced = false; mediaChanged = undefined;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; }, addEventListener: (_: string, listener: () => void) => { mediaChanged = listener; }, removeEventListener: vi.fn() }));
  raf = vi.fn(() => 7); cancel = vi.fn(); vi.stubGlobal('requestAnimationFrame', raf); vi.stubGlobal('cancelAnimationFrame', cancel);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, drawImage() {} } as never);
  vi.mocked(loadCosmeticPreview).mockResolvedValue(fixture());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(loadCosmeticPreview).mockReset(); });
it('renders usable preview controls without implying an equip, grant or purchase', async () => {
  await act(async () => root.render(<BoundCosmeticPreview appearance={wake} label="Aurora Wake" />));
  await until(() => expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Aurora Wake appearance'));
  expect(button().textContent).toBe('PAUSE ANIMATION'); expect(host.textContent).not.toMatch(/BUY|CRAFT|EQUIP/);
  await act(async () => button().click()); expect(button().textContent).toBe('PLAY ANIMATION'); expect(cancel).toHaveBeenCalled();
});
it('uses a still frame for system reduced motion and responds to preference changes', async () => {
  reduced = true;
  await act(async () => root.render(<BoundCosmeticPreview appearance={wake} label="Aurora Wake" />));
  await until(() => expect(host.querySelector('canvas')).not.toBeNull());
  expect(raf).not.toHaveBeenCalled(); expect(host.textContent).toContain('Still preview'); expect(host.querySelector('button')).toBeNull();
  await act(async () => { reduced = false; mediaChanged!(); }); expect(raf).toHaveBeenCalledOnce();
  await act(async () => { reduced = true; mediaChanged!(); }); expect(host.querySelector('button')).toBeNull(); expect(cancel).toHaveBeenCalled();
});
it('honors a caller paused preference and suspends loops while the document is hidden', async () => {
  await act(async () => root.render(<BoundCosmeticPreview appearance={wake} label="Aurora Wake" animation="paused" />));
  await until(() => expect(host.querySelector('canvas')).not.toBeNull()); expect(raf).not.toHaveBeenCalled();
  await act(async () => root.render(<BoundCosmeticPreview appearance={wake} label="Aurora Wake" />)); expect(raf).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => document.dispatchEvent(new Event('visibilitychange'))); expect(raf).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalled();
});
it('discards a late prior selection, aborts its request and closes the stale bitmap', async () => {
  let resolve!: (value: LoadedCosmeticPreview) => void;
  vi.mocked(loadCosmeticPreview).mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValueOnce(fixture(false));
  await act(async () => root.render(<BoundCosmeticPreview appearance={wake} label="Aurora Wake" />));
  const firstSignal = vi.mocked(loadCosmeticPreview).mock.calls[0]![1];
  await act(async () => root.render(<BoundCosmeticPreview appearance={awning} label="Artisan Awning" />));
  await until(() => expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('Artisan Awning appearance'));
  const late = fixture(); await act(async () => resolve(late));
  expect(firstSignal.aborted).toBe(true); expect(late.bitmap.close).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('Aurora Wake');
});
it('shows truthful unavailable and retry states, and releases loaded resources on dismissal', async () => {
  vi.mocked(loadCosmeticPreview).mockRejectedValueOnce(Error('Source mismatch'));
  await act(async () => root.render(<BoundCosmeticPreview appearance={wake} label="Aurora Wake" />));
  await until(() => expect(host.textContent).toContain('Preview unavailable'));
  expect(host.querySelector('canvas')).toBeNull(); expect(button().textContent).toBe('TRY AGAIN');
  const loaded = fixture(); vi.mocked(loadCosmeticPreview).mockResolvedValueOnce(loaded);
  await act(async () => button().click()); await until(() => expect(host.querySelector('canvas')).not.toBeNull());
  await act(async () => root.render(null)); expect(loaded.bitmap.close).toHaveBeenCalledOnce();
});

it('aborts both pending sibling assets when one real loader request fails before its deadline', async () => {
  const real = await vi.importActual<typeof import('../../lib/boundCosmetics/preview')>('../../lib/boundCosmetics/preview');
  vi.mocked(loadCosmeticPreview).mockImplementationOnce(real.loadCosmeticPreview);
  const cancellations: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, options) => {
    const url = String(input);
    if (url.includes('manifest.json')) return Promise.reject(Error('Manifest unavailable'));
    return new Promise<Response>((_, reject) => options!.signal!.addEventListener('abort', () => {
      cancellations.push(url); reject(new DOMException('Cancelled', 'AbortError'));
    }, { once: true }));
  });
  vi.stubGlobal('fetch', fetch);
  const admitted: BoundCosmeticAppearance = { ...wake,
    sourceManifestSha256: 'b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394',
    sourceIndexSha256: '04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181',
    bindingSha256: 'f061211842f342a719bbf1ebe09ac2e085043c43f64f85bbc55582ec82d2a094' };
  await act(async () => root.render(<BoundCosmeticPreview appearance={admitted} label="Aurora Wake" />));
  await until(() => expect(host.textContent).toContain('Preview unavailable'));
  expect(fetch).toHaveBeenCalledTimes(3); expect(cancellations).toHaveLength(2);
  expect(cancellations.some(url => url.includes('@1x.png'))).toBe(true);
  expect(cancellations.some(url => url.includes('@1x.json'))).toBe(true);
  expect(host.querySelector('canvas')).toBeNull();
});
