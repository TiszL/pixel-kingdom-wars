/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildingMarkerUi } from '../types';
import BuildingMarkerLayer, { selectBuildingMarkerBudget, type BuildingMarkerActions, type BuildingMarkersUi } from './BuildingStateMarkers';
import type { ConstructionSiteUi } from './ConstructionSite';

let host: HTMLDivElement;
let root: Root;
let ui: BuildingMarkersUi;
let on: BuildingMarkerActions;
const marker = (buildingId: string, kind: BuildingMarkerUi['kind'] = 'READY', x = 50): BuildingMarkerUi => ({
  buildingId, kind, anchor: { left: x - 10, right: x + 10, top: 90, bottom: 110 },
  icon: 'shards', text: '+server amount', progress: null, description: `${buildingId}: server description`,
});
const render = () => act(async () => root.render(<BuildingMarkerLayer ui={ui} on={on} overlayWidth={100} overlayHeight={200} />));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  ui = { visible: true, markers: [marker('mine')] };
  on = { onCollect: vi.fn(), onOpen: vi.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BuildingMarkerLayer', () => {
  it('allocates one nearest-three budget across ordinary markers and construction sites', () => {
    const sites: ConstructionSiteUi[] = [
      { buildingId: 'site-near', anchor: { left: 45, right: 55, top: 95, bottom: 105 }, builderIcon: 'builder',
        timeLeft: 'server time', secondsLeft: 9, progress: 0.8, description: 'site near' },
      { buildingId: 'site-far', anchor: { left: 800, right: 900, top: 90, bottom: 110 }, builderIcon: 'builder',
        timeLeft: null, secondsLeft: null, progress: null, description: 'site far' },
    ];
    const result = selectBuildingMarkerBudget([marker('middle', 'READY', 70), marker('closer', 'NOTICE', 60), marker('far', 'READY', 700)], sites, 50, 100);
    expect(result.markers.map(item => item.buildingId)).toEqual(['closer', 'middle']);
    expect(result.sites).toEqual([sites[0]]);
    expect(result.sites[0]).toBe(sites[0]);
    expect(result.markers.length + result.sites.length).toBe(3);
    expect(sites.map(item => item.buildingId)).toEqual(['site-near', 'site-far']);
  });

  it('admits empty lists without producing a marker or mutating any supplied list', () => {
    expect(selectBuildingMarkerBudget([], [], 50, 100)).toEqual({ markers: [], sites: [] });
    const candidates = [marker('mine')];
    const result = selectBuildingMarkerBudget(candidates, [], 50, 100);
    expect(result.markers).toEqual(candidates);
    expect(result.markers).not.toBe(candidates);
    expect(result.sites).toEqual([]);
  });

  it('replaces an ordinary construction or upgrade timer with the same building’s selectable construction site', () => {
    const site: ConstructionSiteUi = {
      buildingId: 'workshop', anchor: { left: 45, right: 55, top: 95, bottom: 105 }, builderIcon: 'builder',
      timeLeft: 'server time', secondsLeft: null, progress: null, description: 'Workshop under construction',
    };
    for (const kind of ['CONSTRUCTION', 'UPGRADING'] as const) {
      const result = selectBuildingMarkerBudget([marker('workshop', kind), marker('mine')], [site], 50, 100);
      expect(result.markers.map(item => item.buildingId)).toEqual(['mine']);
      expect(result.sites).toEqual([site]);
      expect(result.markers.length + result.sites.length).toBe(2);
    }
  });

  it('draws nothing while selection, placement or the editor hides markers', async () => {
    ui = { ...ui, visible: false };
    await render();
    expect(host.childElementCount).toBe(0);
    expect(on.onCollect).not.toHaveBeenCalled();
    expect(on.onOpen).not.toHaveBeenCalled();
  });

  it('draws nothing for an empty candidate list', async () => {
    ui = { ...ui, markers: [] };
    await render();
    expect(host.childElementCount).toBe(0);
  });

  it('uses the shared nearest-three rule without mutating candidates', async () => {
    const candidates = [marker('far', 'READY', 500), marker('near', 'READY', 50), marker('second', 'READY', 60), marker('third', 'READY', 80)];
    ui = { ...ui, markers: candidates };
    await render();
    expect([...host.querySelectorAll('button')].map(item => item.getAttribute('aria-label')))
      .toEqual(['near: server description', 'second: server description', 'third: server description']);
    expect(candidates.map(item => item.buildingId)).toEqual(['far', 'near', 'second', 'third']);
  });

  it('collects a READY bubble directly without opening or selecting the building', async () => {
    await render();
    const bubble = host.querySelector('button')!;
    expect(bubble.getAttribute('aria-label')).toBe('mine: server description');
    expect(bubble.textContent).toContain('+server amount');
    await act(async () => bubble.click());
    expect(on.onCollect).toHaveBeenCalledExactlyOnceWith('mine');
    expect(on.onOpen).not.toHaveBeenCalled();
  });

  it('opens a NOTICE bubble without collecting', async () => {
    ui = { ...ui, markers: [marker('trap', 'NOTICE')] };
    await render();
    await act(async () => host.querySelector('button')!.click());
    expect(on.onOpen).toHaveBeenCalledExactlyOnceWith('trap');
    expect(on.onCollect).not.toHaveBeenCalled();
    expect(host.querySelector('[data-ready="true"]')).toBeNull();
  });

  it('anchors a bubble above the supplied sprite centre and retains its optional count', async () => {
    ui = { ...ui, markers: [{ ...marker('mine'), anchor: { left: 40, top: 70, right: 120, bottom: 150 } }] };
    await render();
    const wrapper = host.querySelector<HTMLElement>('.pk-building-bubble')!;
    expect(wrapper.style.left).toBe('80px');
    expect(wrapper.style.top).toBe('70px');
    expect(wrapper.getAttribute('data-ready')).toBe('true');
    ui = { ...ui, markers: [{ ...ui.markers[0]!, text: null }] };
    await render();
    expect(host.textContent).not.toContain('+server amount');
  });

  it('uses shared paint-only timer plates for CONSTRUCTION and UPGRADING', async () => {
    ui = { ...ui, markers: [
      { ...marker('workshop', 'CONSTRUCTION'), text: 'server duration', progress: 0.4 },
      { ...marker('keep', 'UPGRADING'), text: 'other duration', progress: 0.6 },
    ] };
    await render();
    expect(host.querySelectorAll('.pk-timer-plate')).toHaveLength(2);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.querySelectorAll('.pk-meter8__fill--stripe')).toHaveLength(1);
    expect(host.textContent).toContain('server duration');
    expect(host.querySelectorAll('.interactive')).toHaveLength(0);
    expect(on.onOpen).not.toHaveBeenCalled();
  });

  it('preserves unknown time and an empty unknown meter without claiming zero done', async () => {
    ui = { ...ui, markers: [{ ...marker('workshop', 'CONSTRUCTION'), text: null, progress: null }] };
    await render();
    expect(host.textContent).toBe('…');
    expect(host.querySelector('.pk-meter8__fill')).toBeNull();
    expect(host.querySelector('[aria-valuenow]')).toBeNull();
    expect(host.textContent).not.toContain('0%');
  });

  it('clamps supplied timer progress to its visual track', async () => {
    ui = { ...ui, markers: [{ ...marker('workshop', 'CONSTRUCTION'), progress: -1 }, { ...marker('keep', 'UPGRADING'), progress: 2 }] };
    await render();
    expect(host.querySelectorAll('.pk-meter8__fill')).toHaveLength(1);
    expect(host.querySelector<HTMLElement>('.pk-meter8__fill')?.style.width).toBe('100%');
  });

  it('removes every tap target when the mapper hides an already mounted layer', async () => {
    await render();
    expect(host.querySelectorAll('button')).toHaveLength(1);
    ui = { ...ui, visible: false };
    await render();
    expect(host.childElementCount).toBe(0);
  });

  it('gives only the local bubble face an interactive target and keeps the root paint-through', async () => {
    await render();
    expect(host.firstElementChild?.classList.contains('interactive')).toBe(false);
    expect(host.firstElementChild?.classList.contains('pk-pass')).toBe(true);
    expect(host.querySelectorAll('.interactive')).toHaveLength(1);
    expect(host.querySelector('button')?.classList.contains('interactive')).toBe(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
