/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildCardUi, BuildSectionUi } from './buildingTypes';
import BuildTray, { type BuildTrayActions, type BuildTrayProps, type BuildTrayUi } from './BuildTray';

let host: HTMLDivElement;
let root: Root;
let ui: BuildTrayUi;
let on: BuildTrayActions;
let content: Pick<BuildTrayProps, 'suppliesContent' | 'suppliesUnavailableReason' | 'layoutsContent' | 'layoutsUnavailableReason'>;
const labels = ['BUILDINGS', 'DEFENCES', 'TRAPS', 'HEROES', 'SUPPLIES', 'LAYOUTS'];
const card = (type: string, patch: Partial<BuildCardUi> = {}): BuildCardUi => ({
  type, name: type.toUpperCase(), purpose: `Supplied purpose for ${type}`, art: `art:${type}`,
  count: '0/1', countTone: 'BLUE', state: 'AVAILABLE', price: { currency: 'SHARDS', amount: '521', status: 'OK' },
  time: '1h 30m', reason: null, isNew: false, requires: null, ...patch,
});
const section = (id: string, cards: readonly BuildCardUi[]): BuildSectionUi => ({ id, title: id.toUpperCase(), icon: `section:${id}`, count: 'Server count', cards });
const render = () => act(async () => root.render(<BuildTray ui={ui} on={on} renderArt={(name) => <span data-art={name} />} {...content} />));
const cardButton = (type: string) => host.querySelector<HTMLButtonElement>(`button[data-build-type="${type}"]`)!;
const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.includes(label))!;
const clickCard = (type: string) => act(async () => cardButton(type).click());

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  on = { onTab: vi.fn(), onCard: vi.fn(), onClose: vi.fn(), onBuilders: vi.fn() };
  content = { suppliesUnavailableReason: 'Supplies view is not available in this snapshot.',
    layoutsUnavailableReason: 'Layouts view is not available in this snapshot.' };
  ui = { selectedTab: 'BUILDINGS', builders: '1/2', buildersFree: true,
    sections: [section('realm trade', [card('workshop')])], firstTimeHint: true, emptyReason: 'No offers in this snapshot.' };
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-motion');
});

describe('BuildTray presentation', () => {
  it('declares a TALL region with six visible labelled tabs and no host dialog or render action', async () => {
    await render();
    expect(host.querySelector('[role="region"]')?.getAttribute('data-sheet-size')).toBe('TALL');
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('BUILD');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect([...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent?.trim())).toEqual(labels);
    expect(tab('BUILDINGS').getAttribute('aria-selected')).toBe('true');
    expect(tab('SUPPLIES').getAttribute('aria-selected')).toBe('false');
    expect(host.textContent).toContain('Tap one to place it. You pay on PLACE.');
    for (const action of Object.values(on)) expect(action).not.toHaveBeenCalled();
  });

  it('forwards tab selection without changing the controlled snapshot or rendering another category early', async () => {
    await render(); await act(async () => tab('DEFENCES').click());
    expect(on.onTab).toHaveBeenCalledWith('DEFENCES');
    expect(tab('BUILDINGS').getAttribute('aria-selected')).toBe('true');
    expect(cardButton('workshop')).not.toBeNull();
    ui = { ...ui, selectedTab: 'DEFENCES', sections: [section('defences', [card('tower')])] };
    await render();
    expect(tab('DEFENCES').getAttribute('aria-selected')).toBe('true');
    expect(cardButton('workshop')).toBeNull();
    expect(cardButton('tower')).not.toBeNull();
  });

  it('supports keyboard traversal across all labelled tabs and retains supplied locked metadata', async () => {
    ui = { ...ui, tabs: [{ id: 'HEROES', icon: 'hero-art', locked: true, badge: { text: '!', tone: 'READY', description: 'Hero ready' } }] };
    await render();
    await act(async () => tab('BUILDINGS').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(on.onTab).toHaveBeenLastCalledWith('LAYOUTS');
    expect(document.activeElement).toBe(tab('LAYOUTS'));
    await act(async () => tab('LAYOUTS').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(on.onTab).toHaveBeenLastCalledWith('BUILDINGS');
    await act(async () => tab('HEROES').click());
    expect(on.onTab).toHaveBeenLastCalledWith('HEROES');
    expect(tab('HEROES').getAttribute('aria-label')).toBe('HEROES, locked, Hero ready');
    expect(host.querySelector('[data-art="hero-art"]')).not.toBeNull();
  });

  it('keeps all seven card states tappable and forwards only the supplied type to the owning route', async () => {
    const states = ['AVAILABLE', 'SHORT', 'CHECKING', 'REQUIRES', 'LOCKED', 'MAX', 'UNAVAILABLE'] as const;
    ui = { ...ui, sections: [section('states', states.map((state) => card(state.toLowerCase(), { state, reason: `Server ${state}` })))] };
    await render();
    for (const state of states) {
      const type = state.toLowerCase();
      expect(cardButton(type).disabled).toBe(false);
      await clickCard(type);
      expect(on.onCard).toHaveBeenLastCalledWith(type);
    }
    expect(on.onCard).toHaveBeenCalledTimes(7);
    expect(on.onClose).not.toHaveBeenCalled();
  });

  it('uses the accepted price rules: SHORT marks an OK quote short and CHECKING masks stale amounts', async () => {
    ui = { ...ui, sections: [section('prices', [card('short', { state: 'SHORT' }), card('checking', { state: 'CHECKING' })])] };
    await render();
    expect(cardButton('short').getAttribute('aria-label')).toContain('Costs 521 Shards, not enough');
    expect(cardButton('checking').getAttribute('aria-label')).toContain('Shards price: checking');
    expect(cardButton('checking').textContent).not.toContain('521');
    expect(cardButton('checking').textContent).toContain('…');
    expect(cardButton('short').querySelector('button')).toBeNull();
    expect(cardButton('checking').querySelector('button')).toBeNull();
  });

  it('renders unknown prices without zero or invented offers and preserves authoritative zero', async () => {
    ui = { ...ui, sections: [section('prices', [card('unknown', { price: null, time: null }),
      card('zero', { price: { currency: 'SHARDS', amount: null, status: 'SERVER_ZERO' } })])] };
    await render();
    expect(cardButton('unknown').textContent).toContain('…');
    expect(cardButton('unknown').textContent).not.toContain('FREE');
    expect(cardButton('zero').getAttribute('aria-label')).toContain('Costs 0 Shards');
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(2);
    expect(cardButton('market')).toBeNull();
  });

  it('clears stale custom price descriptions when card state normalizes a quote while preserving supplied available copy', async () => {
    const price = { currency: 'SHARDS', amount: '521', status: 'OK', description: 'Old price: 521 Shards, enough' } as const;
    ui = { ...ui, sections: [section('prices', [card('checking', { state: 'CHECKING', price }),
      card('short', { state: 'SHORT', price }), card('available', { price })])] };
    await render();
    expect(cardButton('checking').getAttribute('aria-label')).toContain('Shards price: checking');
    expect(cardButton('checking').getAttribute('aria-label')).not.toContain('521');
    expect(cardButton('short').getAttribute('aria-label')).toContain('Costs 521 Shards, not enough');
    expect(cardButton('short').getAttribute('aria-label')).not.toContain('Old price');
    expect(cardButton('available').getAttribute('aria-label')).toContain('Old price: 521 Shards, enough');
    expect(price.description).toBe('Old price: 521 Shards, enough');
  });

  it('renders server lock and cap reasons without exposing the previous price', async () => {
    ui = { ...ui, sections: [section('gated', [card('locked', { state: 'LOCKED', reason: 'Opens at the supplied Keep level' }),
      card('max', { state: 'MAX', reason: 'One per kingdom', count: '1/1' }), card('off', { state: 'UNAVAILABLE', reason: null })])] };
    await render();
    expect(cardButton('locked').textContent).toContain('Opens at the supplied Keep level');
    expect(cardButton('max').textContent).toContain('One per kingdom');
    expect(cardButton('max').textContent).toContain('MAX');
    expect(cardButton('off').textContent).toContain('…');
    for (const type of ['locked', 'max', 'off']) expect(cardButton(type).textContent).not.toContain('521');
  });

  it('hides empty sections and keeps NEW sections first without mutating mapper order', async () => {
    const old = section('old', [card('mine')]);
    const firstNew = section('first new', [card('workshop', { isNew: true })]);
    const secondNew = section('second new', [card('lodge', { isNew: true })]);
    const original = [old, firstNew, section('empty', []), secondNew];
    ui = { ...ui, sections: original };
    await render();
    expect([...host.querySelectorAll('[data-build-section]')].map((node) => node.getAttribute('data-build-section')))
      .toEqual(['first new', 'second new', 'old']);
    expect(original.map((item) => item.id)).toEqual(['old', 'first new', 'empty', 'second new']);
    expect(host.querySelectorAll('[aria-label="New building"]')).toHaveLength(2);
    expect(host.querySelector('[data-art="art:workshop"]')).not.toBeNull();
    expect(host.textContent?.match(/Tap one to place it/g)).toHaveLength(1);
  });

  it('reveals the required supplied card inside the tray and still forwards the original card', async () => {
    ui = { ...ui, sections: [section('realm', [card('berth', { state: 'REQUIRES', requires: 'lodge', reason: 'Build a Lodge first' }), card('lodge')])] };
    await render();
    const viewport = host.querySelector<HTMLElement>('[data-build-scroll]')!;
    const scrollTo = vi.fn(); viewport.scrollTo = scrollTo; viewport.scrollTop = 15;
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(cardButton('lodge'), 'getBoundingClientRect').mockReturnValue({ top: 300 } as DOMRect);
    await clickCard('berth');
    expect(scrollTo).toHaveBeenCalledWith({ top: 207, behavior: 'smooth' });
    expect(cardButton('lodge').getAttribute('data-cue')).toBe('pulse');
    expect(on.onCard).toHaveBeenCalledWith('berth');
    expect(on.onCard).not.toHaveBeenCalledWith('lodge');
  });

  it('never fabricates a missing required card and leaves its explanation to the owning route', async () => {
    ui = { ...ui, sections: [section('realm', [card('berth', { state: 'REQUIRES', requires: 'absent', reason: 'Lodge unavailable here' })])] };
    await render(); await clickCard('berth');
    expect(cardButton('absent')).toBeNull();
    expect(on.onCard).toHaveBeenCalledWith('berth');
    expect(host.querySelector('[data-cue="pulse"]')).toBeNull();
  });

  it('marks locked taps for their visual cue while keeping the server explanation route live', async () => {
    ui = { ...ui, sections: [section('gated', [card('market', { state: 'LOCKED', reason: 'Server lock reason' })])] };
    await render(); await clickCard('market');
    expect(cardButton('market').getAttribute('data-cue')).toBe('shake');
    expect(on.onCard).toHaveBeenCalledWith('market');
    expect(cardButton('market').getAttribute('aria-label')).toContain('Server lock reason');
  });

  it('focuses a supplied card without executing its action and honors reduced-motion scrolling', async () => {
    await render();
    document.documentElement.setAttribute('data-motion', 'reduce');
    const viewport = host.querySelector<HTMLElement>('[data-build-scroll]')!;
    const scrollTo = vi.fn(); viewport.scrollTo = scrollTo;
    ui = { ...ui, focusType: 'workshop' };
    await render();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(cardButton('workshop').getAttribute('data-cue')).toBe('pulse');
    expect(on.onCard).not.toHaveBeenCalled();
  });

  it('uses current props after a quote update instead of preserving an old card route', async () => {
    await render();
    ui = { ...ui, sections: [section('realm', [card('workshop', { state: 'LOCKED', reason: 'Offers changed' })])] };
    const latest = vi.fn(); on = { ...on, onCard: latest };
    await render(); await clickCard('workshop');
    expect(latest).toHaveBeenCalledWith('workshop');
    expect(cardButton('workshop').getAttribute('data-cue')).toBe('shake');
    expect(cardButton('workshop').getAttribute('aria-label')).toContain('Offers changed');
  });

  it('forwards builders and Close with their supplied count and no purchase action', async () => {
    await render();
    const builders = host.querySelector<HTMLButtonElement>('[aria-label="Builders 1/2 free. Opens builders"]')!;
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close build"]')!;
    await act(async () => builders.click()); await act(async () => close.click());
    expect(on.onBuilders).toHaveBeenCalledOnce(); expect(on.onClose).toHaveBeenCalledOnce();
    expect(on.onCard).not.toHaveBeenCalled();
  });

  it('renders the supplied empty reason without seeding Phase E cards', async () => {
    ui = { ...ui, sections: [] };
    await render();
    expect(host.textContent).toContain('No offers in this snapshot.');
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(0);
    expect(host.textContent).not.toContain('Tap one to place it');
  });

  it('shows supplied missing-offer reasons as messages without manufacturing BuildCards', async () => {
    ui = { ...ui, sections: [], unavailableReasons: [{ id: 'market-offer', name: 'MARKET', reason: 'Market is not offered in this realm.' }] };
    await render();
    expect(host.textContent).toContain('MARKET');
    expect(host.textContent).toContain('Market is not offered in this realm.');
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(0);
    expect(host.querySelector('[data-unavailable-offer="market-offer"] button')).toBeNull();
  });

  it('hosts supplied SUPPLIES content only on its controlled tab without copying another lane', async () => {
    const supplyAction = vi.fn();
    content = { ...content, suppliesContent: <button type="button" onClick={supplyAction}>Supplied Supplies action</button> };
    await render();
    expect(host.textContent).not.toContain('Supplied Supplies action');
    ui = { ...ui, selectedTab: 'SUPPLIES' }; await render();
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(0);
    expect(host.textContent).toContain('Supplied Supplies action');
    expect(host.textContent).not.toContain(content.suppliesUnavailableReason);
    expect(supplyAction).not.toHaveBeenCalled();
    content = { ...content, suppliesContent: null }; await render();
    expect(host.textContent).toContain('Supplies view is not available in this snapshot.');
    expect(host.textContent).not.toContain('521');
  });

  it('keeps LAYOUTS a host-owned destination and never substitutes construction cards', async () => {
    ui = { ...ui, selectedTab: 'LAYOUTS' };
    content = { ...content, layoutsContent: <p>Supplied layout destination</p> };
    await render();
    expect(host.textContent).toContain('Supplied layout destination');
    expect(host.textContent).not.toContain(content.layoutsUnavailableReason);
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(0);
    expect(on.onTab).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, true, '', ' \n '])('shows the supplied SUPPLIES unavailable reason for absent content %s', async (suppliesContent) => {
    ui = { ...ui, selectedTab: 'SUPPLIES' };
    content = { ...content, suppliesContent };
    await render();
    expect(host.querySelector('[role="tabpanel"] [role="status"]')?.textContent).toBe(content.suppliesUnavailableReason);
    expect(host.textContent).not.toContain(content.layoutsUnavailableReason);
    expect(host.textContent).not.toContain('No offers in this snapshot.');
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(0);
    for (const action of Object.values(on)) expect(action).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, true, '', ' \n '])('shows the independent LAYOUTS unavailable reason for absent content %s', async (layoutsContent) => {
    ui = { ...ui, selectedTab: 'LAYOUTS' };
    content = { ...content, layoutsContent };
    await render();
    expect(host.querySelector('[role="tabpanel"] [role="status"]')?.textContent).toBe(content.layoutsUnavailableReason);
    expect(host.textContent).not.toContain(content.suppliesUnavailableReason);
    expect(host.textContent).not.toContain('No offers in this snapshot.');
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(0);
    for (const action of Object.values(on)) expect(action).not.toHaveBeenCalled();
  });

  it.each(['SUPPLIES', 'LAYOUTS'] as const)('preserves visible numeric zero supplied to %s instead of treating it as absent', async (selectedTab) => {
    ui = { ...ui, selectedTab };
    content = { ...content, suppliesContent: 0, layoutsContent: 0 };
    await render();
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toBe('0');
    expect(host.querySelector('[role="tabpanel"] [role="status"]')).toBeNull();
    expect(host.querySelectorAll('[data-build-type]')).toHaveLength(0);
    for (const action of Object.values(on)) expect(action).not.toHaveBeenCalled();
  });
});
