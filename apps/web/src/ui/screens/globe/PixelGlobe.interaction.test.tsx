/** @vitest-environment happy-dom */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GLOBE } from '@shardkeep/shared';
import { EARTH_COARSE } from '@shardkeep/shared/earthMask';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../mapAtlas', () => ({ useMapAtlas: () => null }));

import { PixelGlobe, type GlobeControl } from './PixelGlobe';
import { globeBrowseZoomMax } from './globeView';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // Hold the opening tween before its first frame. The test interrupts that live
  // tween through the real canvas pointer handler, which is the production path
  // that previously stranded the invisible z4 opening camera.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pointer = (kind: string, id: number, x: number): PointerEvent => new PointerEvent(kind, {
  bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: 350,
});

async function mountCamera() {
  const controlRef = createRef<GlobeControl>();
  const layerRef = createRef<HTMLDivElement>();
  layerRef.current = document.createElement('div');
  const onEmptyTap = vi.fn();
  await act(async () => root.render(<PixelGlobe
    vw={390} vh={700} mask={EARTH_COARSE} pins={[]} selectedCell={null} reduceMotion
    controlRef={controlRef} layerRef={layerRef} onNav={vi.fn()} onPinTap={vi.fn()} onEmptyTap={onEmptyTap}
  />));
  act(() => controlRef.current!.set({ lam0: 0, phi0: 0, zoom: GLOBE.zoomMin }));
  return { control: controlRef.current!, canvas: host.querySelector('canvas')!, onEmptyTap };
}

describe('PixelGlobe contact recovery', () => {
  it.each([['hidden', 1], ['hidden', 2], ['blur', 1], ['blur', 2]] as const)('forgets %s with %i stationary contacts before a fresh single-finger pan', async (kind, count) => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const { canvas, control, onEmptyTap } = await mountCamera();
    act(() => { canvas.dispatchEvent(pointer('pointerdown', 1, 100)); if (count === 2) canvas.dispatchEvent(pointer('pointerdown', 2, 200)); });
    act(() => {
      if (kind === 'hidden') {
        hidden = true; document.dispatchEvent(new Event('visibilitychange'));
        hidden = false; document.dispatchEvent(new Event('visibilitychange'));
      } else window.dispatchEvent(new Event('blur'));
    });
    const before = control.nav();
    act(() => { canvas.dispatchEvent(pointer('pointerdown', 9, 300)); canvas.dispatchEvent(pointer('pointermove', 9, 360)); });
    const panned = control.nav();
    expect(panned.zoom).toBe(before.zoom); expect(panned.lam0).not.toBe(before.lam0);
    // Late events from the abandoned fingers cannot end or select through the
    // new gesture. It remains a pan until its own release.
    act(() => { canvas.dispatchEvent(pointer('pointerup', 1, 100)); canvas.dispatchEvent(pointer('pointercancel', 2, 200)); canvas.dispatchEvent(pointer('pointermove', 9, 390)); });
    expect(control.nav().zoom).toBe(before.zoom); expect(control.nav().lam0).not.toBe(panned.lam0);
    act(() => canvas.dispatchEvent(pointer('pointerup', 9, 390)));
    expect(onEmptyTap).not.toHaveBeenCalled();
  });

  it('ignores a late abandoned release instead of selecting land', async () => {
    const { canvas, onEmptyTap } = await mountCamera();
    act(() => { canvas.dispatchEvent(pointer('pointerdown', 1, 100)); window.dispatchEvent(new Event('blur')); canvas.dispatchEvent(pointer('pointerup', 1, 100)); });
    expect(onEmptyTap).not.toHaveBeenCalled();
  });

  it.each([['pointerup', 1], ['pointerup', 3], ['pointercancel', 1], ['pointercancel', 3], ['lostpointercapture', 1], ['lostpointercapture', 3]] as const)('rebases the remaining pair after %s of contact %i without a zoom jump or frozen pinch', async (kind, id) => {
    const { canvas, control, onEmptyTap } = await mountCamera();
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 1, 100)); canvas.dispatchEvent(pointer('pointerdown', 2, 200));
      canvas.dispatchEvent(pointer('pointermove', 2, 250)); canvas.dispatchEvent(pointer('pointerdown', 3, 350));
    });
    const zoom = control.nav().zoom;
    const moving = id === 1 ? 3 : 2, x = id === 1 ? 350 : 250;
    act(() => { canvas.dispatchEvent(pointer(kind, id, id === 1 ? 100 : 350)); canvas.dispatchEvent(pointer('pointermove', moving, x)); });
    expect(control.nav().zoom).toBe(zoom);
    act(() => canvas.dispatchEvent(pointer('pointermove', moving, x - 10)));
    expect(control.nav().zoom).toBeLessThan(zoom); expect(onEmptyTap).not.toHaveBeenCalled();
  });
});

describe('PixelGlobe opening interaction', () => {
  it('publishes a visible browse camera when the first touch interrupts the z4 pull-out', async () => {
    const controlRef = createRef<GlobeControl>();
    const layerRef = createRef<HTMLDivElement>();
    layerRef.current = document.createElement('div');
    const onNav = vi.fn();

    await act(async () => {
      root.render(<PixelGlobe
        vw={390}
        vh={700}
        mask={EARTH_COARSE}
        pins={[]}
        selectedCell={null}
        reduceMotion
        controlRef={controlRef}
        layerRef={layerRef}
        onNav={onNav}
        onPinTap={vi.fn()}
        onEmptyTap={vi.fn()}
      />);
    });

    expect(controlRef.current?.nav().zoom).toBe(GLOBE.localZoom);
    act(() => {
      controlRef.current?.tweenTo(42, 41, GLOBE.zoomMin);
      host.querySelector('canvas')?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'touch',
        clientX: 195,
        clientY: 350,
      }));
    });

    expect(controlRef.current?.nav().zoom).toBe(globeBrowseZoomMax());
    expect(onNav).toHaveBeenLastCalledWith(expect.objectContaining({
      zoom: globeBrowseZoomMax(),
    }));
  });

  it('keeps one tap as selection-only canvas input', async () => {
    const controlRef = createRef<GlobeControl>();
    const layerRef = createRef<HTMLDivElement>();
    layerRef.current = document.createElement('div');
    const onPinTap = vi.fn();
    const onEmptyTap = vi.fn();

    await act(async () => {
      root.render(<PixelGlobe
        vw={390}
        vh={700}
        mask={EARTH_COARSE}
        pins={[]}
        selectedCell={null}
        reduceMotion
        controlRef={controlRef}
        layerRef={layerRef}
        onNav={vi.fn()}
        onPinTap={onPinTap}
        onEmptyTap={onEmptyTap}
      />);
    });
    act(() => controlRef.current?.set({ lam0: 0, phi0: 0, zoom: GLOBE.zoomMin }));

    const canvas = host.querySelector('canvas')!;
    act(() => {
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 1, pointerType: 'touch', clientX: 195, clientY: 350,
      }));
      canvas.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 1, pointerType: 'touch', clientX: 195, clientY: 350,
      }));
    });

    // PixelGlobe has no combat side effect: one tap reports exactly one cell for
    // the owning layer to select and does not reinterpret it as a pin/action tap.
    expect(onEmptyTap).toHaveBeenCalledTimes(1);
    expect(onEmptyTap).toHaveBeenCalledWith(expect.objectContaining({
      cell: expect.any(Number), cols: EARTH_COARSE.cols, rows: EARTH_COARSE.rows,
    }));
    expect(onPinTap).not.toHaveBeenCalled();
  });
});
