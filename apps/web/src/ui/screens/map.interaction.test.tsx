/** @vitest-environment happy-dom */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapCam } from './map';

let host: HTMLDivElement, root: Root, frame: FrameRequestCallback | undefined;
const draw = vi.fn<(camera: { x: number; y: number; z: number }) => void>();
const onEmptyTap = vi.fn();
const pointer = (kind: string, id: number, x: number): PointerEvent => new PointerEvent(kind, {
  bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: 350,
});
function Board() {
  const camera = useMapCam({ minC: 0, maxC: 100, minR: 0, maxR: 100 }, draw, onEmptyTap);
  useEffect(() => { if (camera.vp.w) camera.centerOn(50, 50); }, [camera.vp.w, camera.centerOn]);
  return <div ref={camera.wrapRef} {...camera.panProps}><div ref={camera.layerRef} /></div>;
}
async function paint() {
  await act(async () => { const next = frame; frame = undefined; next?.(performance.now()); });
}
async function mountCamera() {
  await act(async () => root.render(<Board />));
  await paint();
  return host.firstElementChild as HTMLDivElement;
}
const view = () => ({ ...draw.mock.calls.at(-1)![0] });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  draw.mockClear(); onEmptyTap.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); frame = undefined;
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('campaign map contact recovery', () => {
  it.each([['hidden', 1], ['hidden', 2], ['blur', 1], ['blur', 2]] as const)('forgets %s with %i stationary contacts so the next finger pans at unchanged zoom', async (kind, count) => {
    let hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const surface = await mountCamera();
    act(() => { surface.dispatchEvent(pointer('pointerdown', 1, 100)); if (count === 2) surface.dispatchEvent(pointer('pointerdown', 2, 200)); });
    act(() => {
      if (kind === 'hidden') {
        hidden = true; document.dispatchEvent(new Event('visibilitychange'));
        hidden = false; document.dispatchEvent(new Event('visibilitychange'));
      } else window.dispatchEvent(new Event('blur'));
    });
    const before = view();
    act(() => { surface.dispatchEvent(pointer('pointerdown', 9, 300)); surface.dispatchEvent(pointer('pointermove', 9, 360)); }); await paint();
    const panned = view(); expect(panned.z).toBe(before.z); expect(panned.x).not.toBe(before.x);
    act(() => { surface.dispatchEvent(pointer('pointerup', 1, 100)); surface.dispatchEvent(pointer('pointercancel', 2, 200)); surface.dispatchEvent(pointer('pointermove', 9, 390)); }); await paint();
    expect(view().z).toBe(before.z); expect(view().x).not.toBe(panned.x);
    act(() => surface.dispatchEvent(pointer('pointerup', 9, 390))); expect(onEmptyTap).not.toHaveBeenCalled();
  });

  it('ignores a late abandoned release instead of selecting terrain', async () => {
    const surface = await mountCamera();
    act(() => { surface.dispatchEvent(pointer('pointerdown', 1, 100)); window.dispatchEvent(new Event('blur')); surface.dispatchEvent(pointer('pointerup', 1, 100)); });
    expect(onEmptyTap).not.toHaveBeenCalled();
  });

  it.each([['pointerup', 1], ['pointerup', 3], ['pointercancel', 1], ['pointercancel', 3], ['lostpointercapture', 1], ['lostpointercapture', 3]] as const)('keeps the remaining pair responsive after %s of contact %i without changing zoom until movement', async (kind, id) => {
    const surface = await mountCamera();
    act(() => {
      surface.dispatchEvent(pointer('pointerdown', 1, 100)); surface.dispatchEvent(pointer('pointerdown', 2, 200));
      surface.dispatchEvent(pointer('pointermove', 2, 250)); surface.dispatchEvent(pointer('pointerdown', 3, 350));
    }); await paint();
    const zoom = view().z;
    const moving = id === 1 ? 3 : 2, x = id === 1 ? 350 : 250;
    act(() => { surface.dispatchEvent(pointer(kind, id, id === 1 ? 100 : 350)); surface.dispatchEvent(pointer('pointermove', moving, x)); }); await paint();
    expect(view().z).toBe(zoom);
    act(() => surface.dispatchEvent(pointer('pointermove', moving, x - 10))); await paint();
    expect(view().z).toBeLessThan(zoom); expect(onEmptyTap).not.toHaveBeenCalled();
  });
});
