/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConstructionLayer, { type ConstructionActions, type ConstructionLayerUi, type ConstructionSiteUi } from './ConstructionSite';

let host: HTMLDivElement;
let root: Root;
let ui: ConstructionLayerUi;
let on: ConstructionActions;
const site = (buildingId = 'workshop'): ConstructionSiteUi => ({
  buildingId, builderIcon: 'builder', timeLeft: 'server duration', secondsLeft: null, progress: 0.4,
  anchor: { left: 40, right: 120, top: 70, bottom: 150 }, description: `${buildingId}: being built, server duration`,
});
const render = () => act(async () => root.render(<ConstructionLayer ui={ui} on={on} />));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  ui = { visible: true, sites: [site()] };
  on = { onSelect: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ConstructionLayer', () => {
  it('draws nothing when hidden or when no sites were admitted', async () => {
    ui = { ...ui, visible: false };
    await render();
    expect(host.childElementCount).toBe(0);
    ui = { visible: true, sites: [] };
    await render();
    expect(host.childElementCount).toBe(0);
  });

  it('preserves the global mapper ordering and defensively applies the shared three-marker cap', async () => {
    const candidates = [site('second'), site('first'), site('third'), site('overflow')];
    ui = { ...ui, sites: candidates };
    await render();
    expect([...host.querySelectorAll('button')].map(item => item.getAttribute('aria-label')))
      .toEqual(['second: being built, server duration', 'first: being built, server duration', 'third: being built, server duration']);
    expect(candidates.map(item => item.buildingId)).toEqual(['second', 'first', 'third', 'overflow']);
  });

  it('selects only the supplied building on a plate tap without sending an order on render', async () => {
    await render();
    expect(on.onSelect).not.toHaveBeenCalled();
    await act(async () => host.querySelector('button')!.click());
    expect(on.onSelect).toHaveBeenCalledExactlyOnceWith('workshop');
  });

  it('anchors the local plate and a decorative still builder without rendering a second world sprite', async () => {
    await render();
    const plate = host.querySelector<HTMLButtonElement>('button')!;
    const builder = host.querySelector<HTMLElement>('.pk-construction-builder')!;
    expect(plate.style.left).toBe('80px');
    expect(plate.style.top).toBe('70px');
    expect(builder.style.left).toBe('120px');
    expect(builder.style.top).toBe('150px');
    expect(builder.getAttribute('aria-hidden')).toBe('true');
    expect(builder.querySelector('button')).toBeNull();
    expect(host.querySelector('[data-building-art]')).toBeNull();
  });

  it.each([0, 9, 10])('uses solid green and seconds text at the native finishing boundary %s', async secondsLeft => {
    ui = { ...ui, sites: [{ ...site(), secondsLeft }] };
    await render();
    expect(host.textContent).toBe(`${secondsLeft}s`);
    expect(host.querySelector('.pk-construction-plate')?.getAttribute('data-tone')).toBe('SOLID');
    expect(host.querySelector('.pk-meter8__fill--stripe')).toBeNull();
  });

  it.each([-1, 11, null, NaN, Infinity, 0.5])('keeps the server-formatted time and stripes outside finishing (%s)', async secondsLeft => {
    ui = { ...ui, sites: [{ ...site(), secondsLeft }] };
    await render();
    expect(host.textContent).toBe('server duration');
    expect(host.querySelector('.pk-construction-plate')?.getAttribute('data-tone')).toBe('STRIPE');
    expect(host.querySelector('.pk-meter8__fill--stripe')).not.toBeNull();
  });

  it.each([null, '', '  '])('uses an ellipsis for an unknown time (%s) and never calls it zero percent', async timeLeft => {
    ui = { ...ui, sites: [{ ...site(), timeLeft, progress: null }] };
    await render();
    expect(host.textContent).toBe('…');
    expect(host.querySelector('.pk-meter8__fill')).toBeNull();
    expect(host.querySelector('[aria-valuenow]')).toBeNull();
  });

  it('retains the mapper’s last known time while an uncertain order is being checked, with selection still available', async () => {
    ui = { ...ui, sites: [{ ...site(), progress: null, description: 'Workshop: checking with the server' }] };
    await render();
    expect(host.textContent).toBe('server duration');
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Workshop: checking with the server');
    expect(host.querySelectorAll('button')).toHaveLength(1);
    await act(async () => host.querySelector('button')!.click());
    expect(on.onSelect).toHaveBeenCalledExactlyOnceWith('workshop');
  });

  it('clamps supplied progress while keeping only each plate interactive', async () => {
    ui = { ...ui, sites: [{ ...site('low'), progress: -1 }, { ...site('high'), progress: 2 }] };
    await render();
    expect(host.querySelectorAll('.pk-meter8__fill')).toHaveLength(1);
    expect(host.querySelector<HTMLElement>('.pk-meter8__fill')?.style.width).toBe('100%');
    expect(host.querySelectorAll('.interactive')).toHaveLength(2);
    expect(host.firstElementChild?.classList.contains('pk-pass')).toBe(true);
    expect(host.firstElementChild?.classList.contains('interactive')).toBe(false);
  });

  it('updates only from new mapper values and disappears on the server-driven site removal', async () => {
    await render();
    ui = { ...ui, sites: [{ ...site(), timeLeft: 'updated server duration', progress: 0.6 }] };
    await render();
    expect(host.textContent).toBe('updated server duration');
    expect(host.querySelector<HTMLElement>('.pk-meter8__fill')?.style.width).toBe('60%');
    ui = { ...ui, sites: [] };
    await render();
    expect(host.childElementCount).toBe(0);
    expect(on.onSelect).not.toHaveBeenCalled();
  });
});
