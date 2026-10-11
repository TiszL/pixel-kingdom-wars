/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BuildingInfoSheet, { type BuildingInfoActions, type BuildingInfoUi } from './BuildingInfoSheet';

let host: HTMLDivElement;
let root: Root;
let ui: BuildingInfoUi;
let on: BuildingInfoActions;
const render = () => act(async () => root.render(<BuildingInfoSheet ui={ui} on={on} />));
const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label')?.startsWith(name));
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
};
const click = (name: string) => act(async () => button(name).click());

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  on = {
    onClose: vi.fn(), onUpgrade: vi.fn(), onFinish: vi.fn(), onGetMore: vi.fn(),
    onExtra: vi.fn(), onAllLevels: vi.fn(), onRetry: vi.fn(), onExplain: vi.fn(),
  };
  // Display fixtures only: production values and art are supplied by the mapper.
  ui = {
    buildingId: 'tower-fixture', name: 'ARCHER TOWER', levelTag: 'LV 4',
    role: 'Hits flying troops too.', category: { text: 'DEFENCE', verb: 'STONE' },
    stateTag: { text: 'GUARDING', verb: 'MOSS' }, headerArt: <span data-art="tower" />,
    stats: [{ icon: 'shield', art: <span data-art="shield" />, label: 'Hitpoints', now: '360', next: '430' }],
    nextLegend: 'at LV 5', price: { currency: 'SHARDS', amount: '521', status: 'OK' },
    time: '1h 30m', builders: '1/2 free', primary: {
      kind: 'UPGRADE', label: 'UPGRADE TO LV 5', sub: 'Uses 1 builder for 1h 30m', state: 'ENABLED',
    },
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BuildingInfoSheet', () => {
  it('declares a named HALF body without owning a dialog or invoking an action on render', async () => {
    await render();
    const region = host.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('ARCHER TOWER info');
    expect(region?.getAttribute('data-sheet-size')).toBe('HALF');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-art="tower"]')).not.toBeNull();
    expect(host.textContent).toContain('Hits flying troops too.');
    expect(host.textContent).toContain('GUARDING');
    for (const action of Object.values(on)) expect(action).not.toHaveBeenCalled();
  });

  it('keeps UPGRADE navigation enabled when checking or short and never routes it to FINISH', async () => {
    for (const status of ['CHECKING', 'SHORT'] as const) {
      ui = { ...ui, price: { currency: 'SHARDS', amount: '521', status }, primary: {
        ...ui.primary, state: status === 'SHORT' ? 'SHORT' : 'ENABLED', price: { currency: 'SHARDS', amount: '521', status },
      } };
      await render();
      expect(button('UPGRADE TO LV 5').disabled).toBe(false);
      await click('UPGRADE TO LV 5');
    }
    expect(on.onUpgrade).toHaveBeenCalledTimes(2);
    expect(on.onFinish).not.toHaveBeenCalled();
    expect(on.onGetMore).not.toHaveBeenCalled();
  });

  it('hands ready and checking FINISH taps to the Seal callback', async () => {
    for (const status of ['OK', 'CHECKING'] as const) {
      ui = { ...ui, price: null, primary: {
        kind: 'FINISH', label: 'FINISH', sub: null, state: 'ENABLED', price: { currency: 'GEMS', amount: '38', status },
      } };
      await render();
      await click('FINISH');
    }
    expect(on.onFinish).toHaveBeenCalledTimes(2);
    expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onGetMore).not.toHaveBeenCalled();
  });

  it('routes both a short FINISH and its separate price door to Need-more', async () => {
    ui = { ...ui, price: null, primary: {
      kind: 'FINISH', label: 'FINISH', sub: null, state: 'ENABLED',
      price: { currency: 'GEMS', amount: '38', status: 'SHORT' },
    } };
    await render();
    await click('FINISH');
    await click('Costs 38 Gems, not enough. See where to get more');
    expect(on.onGetMore).toHaveBeenCalledTimes(2);
    expect(on.onGetMore).toHaveBeenCalledWith('GEMS');
    expect(on.onFinish).not.toHaveBeenCalled();
  });

  it('explains unavailable and locked primaries without opening a spend or upgrade', async () => {
    ui = { ...ui, primary: {
      kind: 'FINISH', label: 'FINISH', sub: null, state: 'ENABLED',
      price: { currency: 'GEMS', amount: null, status: 'UNAVAILABLE' },
    } };
    await render();
    expect(button('FINISH').getAttribute('aria-disabled')).toBe('true');
    await click('FINISH');
    expect(on.onExplain).toHaveBeenLastCalledWith('price unavailable right now');
    ui = { ...ui, primary: { kind: 'UPGRADE', label: 'UPGRADE', sub: null, state: 'LOCKED', reason: 'Opens 14 Oct' } };
    await render();
    await click('UPGRADE');
    expect(on.onExplain).toHaveBeenLastCalledWith('Opens 14 Oct');
    expect(on.onFinish).not.toHaveBeenCalled();
    expect(on.onUpgrade).not.toHaveBeenCalled();
  });

  it.each(['UPGRADE', 'FINISH'] as const)
  ('explains the read-only reason for a DISABLED %s instead of navigating or opening consent', async kind => {
    ui = { ...ui, primary: {
      kind, label: kind, sub: null, state: 'DISABLED', reason: 'Viewing another kingdom',
      price: kind === 'FINISH' ? { currency: 'GEMS', amount: '38', status: 'OK' } : null,
    } };
    await render();
    expect(host.textContent).toContain('Viewing another kingdom');
    expect(button(kind).getAttribute('aria-disabled')).toBe('true');
    expect(button(kind).disabled).toBe(false); // Disabled primaries remain a door to their explanation.
    await click(kind);
    expect(on.onExplain).toHaveBeenCalledExactlyOnceWith('Viewing another kingdom');
    expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onFinish).not.toHaveBeenCalled();
    expect(on.onGetMore).not.toHaveBeenCalled();
  });

  it('never invokes the primary while BUSY', async () => {
    ui = { ...ui, primary: { ...ui.primary, state: 'BUSY' } };
    await render();
    expect(button('UPGRADE TO LV 5').disabled).toBe(true);
    await click('UPGRADE TO LV 5');
    expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onExplain).not.toHaveBeenCalled();
  });

  it('loading preserves four unknown rows and blocks the primary while Android extra and Close stay available', async () => {
    ui = { ...ui, load: 'LOADING', extra: { art: <span />, label: 'EXPAND', description: 'Expand kingdom' } };
    await render();
    expect(host.textContent).toContain('ARCHER TOWER');
    expect(host.querySelectorAll('[aria-label="Loading"]')).toHaveLength(4);
    expect(host.querySelector('[aria-label="Hitpoints: 360, next level 430"]')).toBeNull();
    expect(host.textContent).not.toContain('521');
    expect(host.textContent).not.toContain('at LV 5');
    expect(button('Checking').disabled).toBe(true);
    expect(button('Expand kingdom').disabled).toBe(false);
    await click('Checking');
    await click('Expand kingdom');
    expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onExtra).toHaveBeenCalledOnce();
    await click('Close ARCHER TOWER info');
    expect(on.onClose).toHaveBeenCalledOnce();
  });

  it('errors retain unknown stats and provide retry plus the waiting-for-server explanation', async () => {
    ui = { ...ui, load: 'ERROR' };
    await render();
    expect(host.textContent).toContain('…');
    expect(host.textContent).not.toContain('430');
    expect(host.textContent).not.toContain('521');
    await click('Try loading the stats again');
    expect(on.onRetry).toHaveBeenCalledOnce();
    await click('UPGRADE TO LV 5');
    expect(on.onExplain).toHaveBeenCalledWith('waiting for the server');
    expect(on.onUpgrade).not.toHaveBeenCalled();
  });

  it('MAX is a labelled plate with no primary button or cost row', async () => {
    ui = { ...ui, primary: { kind: 'MAX', label: 'MAX LEVEL', sub: 'next level needs Keep 6' } };
    await render();
    expect(host.querySelector('[aria-label="MAX LEVEL. next level needs Keep 6"]')).not.toBeNull();
    expect([...host.querySelectorAll('button')].some((item) => item.textContent?.includes('MAX LEVEL'))).toBe(false);
    expect(host.textContent).not.toContain('521');
    expect(host.textContent).not.toContain('1/2 free');
  });

  it('shows only five stats then All levels and forwards the optional overflow action', async () => {
    ui = { ...ui, stats: Array.from({ length: 6 }, (_, i) => ({ icon: 'shield', art: <span />, label: `Stat ${i}`, now: `${i}` })),
      extra: { art: <span data-art="expand" />, label: 'EXPAND', description: 'Expand kingdom' } };
    await render();
    expect(host.querySelectorAll('[data-info-stat]')).toHaveLength(5);
    expect(host.textContent).not.toContain('Stat 5');
    await click('All levels: 1 more stats');
    await click('Expand kingdom');
    expect(on.onAllLevels).toHaveBeenCalledOnce();
    expect(on.onExtra).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-art="expand"]')).not.toBeNull();
  });

  it('speaks supplied changes and capabilities, keeps unknown ellipses and frames only portraits', async () => {
    ui = { ...ui, upgrading: true, stats: [
      ...ui.stats,
      { icon: 'ui_portrait_dragon_t2', art: <span />, label: 'Damage per second', now: null },
      { icon: 'attack', art: <span />, label: 'Hits flying troops', now: null, yesNo: true },
      { icon: 'shield', art: <span />, label: 'Hidden', now: null, yesNo: false },
    ] };
    await render();
    expect(host.querySelector('[aria-label="Hitpoints: 360, next level 430"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Damage per second: …"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Hits flying troops: yes"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Hidden: no"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-framed="true"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-pending="true"]')).toHaveLength(1);
  });

  it('short upgrade costs open Need-more separately and display only supplied values', async () => {
    ui = { ...ui, price: { currency: 'SHARDS', amount: '521', status: 'SHORT' }, shortfall: '203' };
    await render();
    expect(host.textContent).toContain('Need 203 more Shards');
    expect(host.querySelector('[aria-label="Takes 1h 30m"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Builders 1/2 free"]')).not.toBeNull();
    await click('Costs 521 Shards, not enough. See where to get more');
    expect(on.onGetMore).toHaveBeenCalledWith('SHARDS');
    expect(on.onUpgrade).not.toHaveBeenCalled();
    ui = { ...ui, shortfall: null, time: null, builders: null };
    await render();
    expect(host.textContent).toContain('Need … more Shards');
    expect(host.querySelector('[aria-label^="Takes "]')).toBeNull();
    expect(host.querySelector('[aria-label^="Builders "]')).toBeNull();
  });
});
