/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandImage } from './BrandImage';
import { registerServiceWorker } from '../lib/sw';

vi.mock('../lib/sw', () => ({ registerServiceWorker: vi.fn() }));
const previousWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const previousOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
let root: Root;
let host: HTMLDivElement;
let worker: EventTarget;
const logo = '/brand/brand_logo_main.png?v=build-b';
const image = (): HTMLImageElement => host.querySelector('img')!;
const dispatch = async (target: EventTarget, name: string): Promise<void> => {
  await act(async () => { target.dispatchEvent(new Event(name)); });
};
const mount = async (src = logo, alt = 'Pixel Kingdom Wars'): Promise<void> => {
  await act(async () => root.render(<BrandImage src={src} alt={alt} width={422} height={294} style={{ width: 316, height: 'auto' }} />));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(registerServiceWorker).mockClear();
  worker = new EventTarget();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [key, descriptor] of [['serviceWorker', previousWorker], ['onLine', previousOnline]] as const) {
    if (descriptor) Object.defineProperty(navigator, key, descriptor);
    else Reflect.deleteProperty(navigator, key);
  }
});

describe('login artwork recovery', () => {
  it('keeps a readable, stable logo fallback while failed pixels retry with the same build', async () => {
    await mount();
    expect(host.textContent).toBe('Pixel Kingdom Wars');
    expect((host.firstChild as HTMLElement).style.aspectRatio).toBe('422 / 294');
    await dispatch(image(), 'error');
    expect(image().style.visibility).toBe('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(image().getAttribute('src')).toBe(`${logo}&imageRetry=1`);
    expect(registerServiceWorker).toHaveBeenCalledTimes(1);
    await dispatch(image(), 'load');
    expect(image().style.visibility).toBe('visible');
    expect(host.textContent).toBe('');
  });

  it('paints decorative art while it loads, but keeps a labelled image behind its readable fallback', async () => {
    // WHY: owner 2026-09-27 "flickering ... on loading box". The loading
    // wallpaper remounts over the same picture (pre-React boot -> React, and
    // LoadingScreen -> base cover); hiding it until React saw onLoad painted a
    // full-screen dark frame (1 frame to 220 ms in a SwiftShader capture).
    await mount('/brand/brand_loading_bg_portrait.png?v=build-b', '');
    expect(image().style.visibility).toBe('visible');
    await dispatch(image(), 'error');
    expect(image().style.visibility).toBe('hidden');
    await act(async () => root.render(null));
    await mount();
    expect(image().style.visibility).toBe('hidden');
    expect(host.textContent).toBe('Pixel Kingdom Wars');
  });

  it.each(['/brand/brand_title_bg_portrait.png', '/brand/brand_title_bg_landscape.png', '/brand/brand_logo_main.png'])(
    'recovers %s immediately when the new worker takes over', async (path) => {
      await mount(`${path}?v=build-b`);
      await dispatch(image(), 'error');
      await dispatch(worker, 'controllerchange');
      expect(image().getAttribute('src')).toBe(`${path}?v=build-b&imageRetry=1`);
      expect(vi.getTimerCount()).toBe(0);
      await dispatch(image(), 'load');
      await dispatch(worker, 'controllerchange');
      expect(image().getAttribute('src')).toBe(`${path}?v=build-b&imageRetry=1`);
    },
  );

  it('bounds automatic retries while retaining attempts for takeover and restored connectivity', async () => {
    await mount();
    for (const delay of [300, 1_000, 2_500, 5_000]) {
      await dispatch(image(), 'error');
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    }
    await dispatch(image(), 'error');
    expect(vi.getTimerCount()).toBe(0);
    await dispatch(worker, 'controllerchange');
    await dispatch(image(), 'error');
    await dispatch(window, 'online');
    expect(image().getAttribute('src')).toBe(`${logo}&imageRetry=6`);
    for (let i = 0; i < 3; i++) {
      await dispatch(image(), 'error');
      await dispatch(window, 'online');
      await dispatch(worker, 'controllerchange');
    }
    expect(image().getAttribute('src')).toBe(`${logo}&imageRetry=6`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not spend timed attempts offline and recovers when connectivity returns', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await mount();
    await dispatch(image(), 'error');
    expect(vi.getTimerCount()).toBe(0);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    await dispatch(window, 'online');
    expect(image().getAttribute('src')).toBe(`${logo}&imageRetry=1`);
  });

  it('cancels the old image lifetime on rotation and all recovery work on unmount', async () => {
    const remove = vi.spyOn(worker, 'removeEventListener');
    await mount('/brand/brand_title_bg_portrait.png?v=build-b', '');
    await dispatch(image(), 'error');
    await mount('/brand/brand_title_bg_landscape.png?v=build-b', '');
    expect(vi.getTimerCount()).toBe(0);
    expect(host.textContent).toBe('');
    await dispatch(image(), 'error');
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(2);
    await dispatch(window, 'online');
    await dispatch(worker, 'controllerchange');
    expect(registerServiceWorker).not.toHaveBeenCalled();
  });
});
