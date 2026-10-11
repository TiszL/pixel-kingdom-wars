// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollPage, scrollPageFrameStyle } from './primitives';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class FakeVisualViewport extends EventTarget {
  height = 812;
  offsetTop = 0;
}

describe('ScrollPage mobile visual-viewport containment', () => {
  let host: HTMLDivElement;
  let root: Root;
  let viewport: FakeVisualViewport;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    viewport = new FakeVisualViewport();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 812 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  });

  it('adds notch/gesture safe areas and rises above an Android IME resize', async () => {
    await act(async () => root.render(
      <ScrollPage viewportSafe title="SECURITY" onClose={() => undefined}>
        <input aria-label="Recovery code" />
      </ScrollPage>,
    ));
    const page = host.querySelector<HTMLElement>('[data-viewport-safe="true"]')!;
    expect(scrollPageFrameStyle(true, { top: 0, bottom: 0 })).toMatchObject({
      left: 'env(safe-area-inset-left)',
      right: 'env(safe-area-inset-right)',
      top: 'calc(0px + env(safe-area-inset-top))',
      bottom: 'calc(0px + env(safe-area-inset-bottom))',
    });
    expect(page.dataset['viewportBottom']).toBe('0');

    viewport.height = 492;
    await act(async () => viewport.dispatchEvent(new Event('resize')));
    expect(page.dataset['viewportBottom']).toBe('320');

    viewport.offsetTop = 23;
    viewport.height = 469;
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    expect(page.dataset['viewportTop']).toBe('23');
    expect(page.dataset['viewportBottom']).toBe('320');
  });

  it('does not hide the form twice after the shared game frame already shrank', async () => {
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 492, height: 492 } as DOMRect);
    viewport.height = 492;
    await act(async () => root.render(<ScrollPage viewportSafe title="SECURITY" onClose={() => undefined}><input /></ScrollPage>));
    const page = host.querySelector<HTMLElement>('[data-viewport-safe="true"]')!;
    expect(page.dataset['viewportBottom']).toBe('0');
    viewport.offsetTop = 23; viewport.height = 469;
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    expect(page.dataset['viewportTop']).toBe('23');
    expect(page.dataset['viewportBottom']).toBe('0');
  });

  it('keeps all page controls clear of cutouts without opting into keyboard viewport tracking', async () => {
    await act(async () => root.render(
      <ScrollPage title="PROFILE" onClose={() => undefined}>BODY</ScrollPage>,
    ));
    const page = host.firstElementChild as HTMLElement;
    expect(page.dataset['viewportSafe']).toBeUndefined();
    expect(scrollPageFrameStyle(false, { top: 0, bottom: 0 })).toMatchObject({
      top: 'env(safe-area-inset-top)', right: 'env(safe-area-inset-right)',
      bottom: 'env(safe-area-inset-bottom)', left: 'env(safe-area-inset-left)',
    });

    viewport.height = 400;
    await act(async () => viewport.dispatchEvent(new Event('resize')));
    expect(page.dataset['viewportBottom']).toBeUndefined();
  });

  it('keeps the close action keyboard-native and at the shared 48px touch minimum', async () => {
    const close = vi.fn();
    await act(async () => root.render(
      <ScrollPage viewportSafe title="SECURITY" onClose={close}>BODY</ScrollPage>,
    ));
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    expect(button.type).toBe('button');
    expect(button.style.width).toBe('48px');
    expect(button.style.height).toBe('48px');
    button.focus();
    await act(async () => button.click());
    expect(close).toHaveBeenCalledOnce();
  });
});
