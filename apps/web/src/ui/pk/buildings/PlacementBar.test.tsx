/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceUi } from '../types';
import type { PlacementState } from './buildingTypes';
import PlacementBar, { type PlacementBarActions, type PlacementBarUi } from './PlacementBar';

let host: HTMLDivElement, root: Root, ui: PlacementBarUi, on: PlacementBarActions;
const render = async () => { await act(async () => root.render(<PlacementBar ui={ui} on={on} />)); };
const placeButton = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Place WORKSHOP."]')!;
const cancelButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Cancel placement"]')!;
const clickPlace = () => act(() => placeButton().click());
const states: PlacementState[] = ['VALID', 'BLOCKED', 'CHECKING_PRICE', 'SHORT', 'NO_BUILDER', 'SENDING', 'ERROR', 'VERIFYING'];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  // Display fixtures only; all live prices, times, builders and placement admission come from the owner.
  ui = { type: 'workshop', name: 'WORKSHOP', price: { currency: 'SHARDS', amount: '40,000', status: 'OK' },
    time: '2h', builders: '1/2', state: 'VALID', hint: null, reason: null };
  on = { canPlace: vi.fn(() => true), onPlace: vi.fn(), onReviewGems: vi.fn(), onCancel: vi.fn(), onNeedMore: vi.fn(), onBuilders: vi.fn(), onReport: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('PlacementBar', () => {
  it('renders the native strip values without a dialog, ghost, rotation or implicit action', async () => {
    await render();
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('WORKSHOP placement controls');
    expect(host.querySelector('.pk-placement-bar')?.classList.contains('interactive')).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-placement-ghost]')).toBeNull();
    expect(host.querySelector('[aria-label*="Rotate"]')).toBeNull();
    expect(host.querySelector('[aria-label="WORKSHOP. Takes 2h. Builders 1/2"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Drag to move · PLACE when green');
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(host.textContent).toContain('40,000');
    for (const callback of [on.onPlace, on.onReviewGems, on.onCancel, on.onNeedMore, on.onBuilders, on.onReport]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it.each(['VALID', 'ERROR'] as const)('routes payable %s to the existing controller after live admission', async state => {
    ui = { ...ui, state }; await render();
    expect(placeButton().disabled).toBe(false);
    expect(placeButton().classList.contains('pk-verb--green')).toBe(true);
    clickPlace(); expect(on.onPlace).toHaveBeenCalledTimes(1);
    expect(on.onNeedMore).not.toHaveBeenCalled(); expect(on.onBuilders).not.toHaveBeenCalled();
  });

  it('accepts only the authoritative server-zero price as known when its amount is absent', async () => {
    ui = { ...ui, price: { currency: 'SHARDS', amount: null, status: 'SERVER_ZERO' } }; await render();
    expect(host.querySelector('.pk-price__text')?.textContent).toBe('0');
    clickPlace(); expect(on.onPlace).toHaveBeenCalledTimes(1);
  });

  it.each(['VALID', 'ERROR'] as const)('routes payable Gems in %s to consent with a live admission check', async state => {
    let allowed = true;
    on.canPlace = () => allowed;
    ui = { ...ui, state, price: { ...ui.price, currency: 'GEMS' } }; await render();
    allowed = false; clickPlace(); expect(on.onReviewGems).not.toHaveBeenCalled();
    allowed = true; clickPlace(); expect(on.onReviewGems).toHaveBeenCalledTimes(1);
    expect(on.onPlace).not.toHaveBeenCalled();
  });

  it.each(['SOL', 'KEEP', 'SKR', 'ITEM'] as const)('draws unsupported %s placement OFF with a reason and never sends or opens consent', async currency => {
    for (const state of ['VALID', 'ERROR'] as const) {
      for (const status of ['OK', 'SERVER_ZERO'] as const) {
        ui = { ...ui, state, price: { currency, amount: status === 'SERVER_ZERO' ? null : 'server price', status } };
        await render();
        expect(placeButton().disabled).toBe(true);
        expect(placeButton().classList.contains('pk-verb--off')).toBe(true);
        expect(host.querySelector('.pk-placement-bar__reason')?.textContent).toContain('unavailable');
        expect(placeButton().getAttribute('aria-label')).toContain('unavailable');
        clickPlace();
      }
    }
    ui = { ...ui, state: 'SHORT', price: { ...ui.price, status: 'SHORT' } };
    await render();
    expect(placeButton().disabled).toBe(true);
    expect(host.querySelector('.pk-price-door')).toBeNull();
    clickPlace();
    expect(on.canPlace).not.toHaveBeenCalled();
    expect(on.onPlace).not.toHaveBeenCalled();
    expect(on.onReviewGems).not.toHaveBeenCalled();
    expect(on.onNeedMore).not.toHaveBeenCalled();
  });

  it.each([null, '', '   '])('does not place from an OK price without a known amount (%j)', async amount => {
    ui = { ...ui, price: { ...ui.price, amount } }; await render();
    expect(placeButton().disabled).toBe(true);
    expect(placeButton().querySelector('.pk-dots')).not.toBeNull();
    clickPlace(); expect(on.onPlace).not.toHaveBeenCalled();
  });

  it('does not place when the original controller refuses at render or at the tap', async () => {
    let allowed = false; on.canPlace = () => allowed; await render();
    expect(placeButton().disabled).toBe(true); clickPlace(); expect(on.onPlace).not.toHaveBeenCalled();
    allowed = true; await render(); expect(placeButton().disabled).toBe(false);
    allowed = false; clickPlace(); expect(on.onPlace).not.toHaveBeenCalled();
    allowed = true; expect(on.onPlace).not.toHaveBeenCalled(); // No queued early tap.
    clickPlace(); expect(on.onPlace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SHARDS', 'initially'], ['SHARDS', 'at the tap'],
    ['GEMS', 'initially'], ['GEMS', 'at the tap'],
  ] as const)('treats %s admission throwing %s as false and preserves Cancel', async (currency, when) => {
    let throws = when === 'initially';
    const canPlace = vi.fn(() => {
      if (throws) throw new Error('Original placement controller temporarily unavailable');
      return true;
    });
    on.canPlace = canPlace;
    ui = { ...ui, price: { ...ui.price, currency } };
    const windowError = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', windowError);
    try {
      await render();
      expect(host.querySelector('[role="region"]')).not.toBeNull();
      expect(placeButton().disabled).toBe(when === 'initially');
      if (when === 'at the tap') canPlace.mockClear();
      throws = true; clickPlace();
      // An enabled button must reach the live guard; a disabled-button click alone cannot test the tap-time catch.
      if (when === 'at the tap') expect(canPlace).toHaveBeenCalledTimes(1);
      expect(on.onPlace).not.toHaveBeenCalled();
      expect(on.onReviewGems).not.toHaveBeenCalled();
      await render();
      expect(placeButton().disabled).toBe(true);
      expect(cancelButton().disabled).toBe(false);
      act(() => cancelButton().click());
      expect(on.onCancel).toHaveBeenCalledTimes(1);
      expect(windowError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', windowError);
      consoleError.mockRestore();
    }
  });

  it('checks live controller admission on each rapid tap before the owner repaints', async () => {
    let allowed = true;
    on.canPlace = () => allowed; on.onPlace = vi.fn(() => { allowed = false; });
    await render(); act(() => { placeButton().click(); placeButton().click(); });
    expect(on.onPlace).toHaveBeenCalledTimes(1);
  });

  it('uses the latest controller callbacks and UI after a repaint', async () => {
    const previous = on.onPlace; await render();
    on = { ...on, onPlace: vi.fn() }; await render(); clickPlace();
    expect(previous).not.toHaveBeenCalled(); expect(on.onPlace).toHaveBeenCalledTimes(1);
    ui = { ...ui, state: 'VERIFYING' }; await render(); clickPlace();
    expect(on.onPlace).toHaveBeenCalledTimes(1);
  });

  it('shows blocked feedback, keeps Cancel available and never places', async () => {
    ui = { ...ui, state: 'BLOCKED' }; await render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Red tiles are taken. Drag it clear.');
    expect(host.textContent).toContain('Spot is blocked');
    expect(placeButton().disabled).toBe(true); expect(placeButton().classList.contains('pk-verb--off')).toBe(true);
    clickPlace(); expect(on.onPlace).not.toHaveBeenCalled();
    expect(cancelButton().disabled).toBe(false);
  });

  it.each(['CHECKING_PRICE', 'SENDING', 'VERIFYING'] as const)('shows stone waiting dots and prevents %s from resending', async state => {
    ui = { ...ui, state }; await render();
    expect(placeButton().classList.contains('pk-verb--stone')).toBe(true);
    expect(placeButton().querySelector('.pk-dots')).not.toBeNull();
    expect(placeButton().getAttribute('aria-label')).toContain('waiting for the server');
    expect(placeButton().disabled).toBe(true); clickPlace(); expect(on.onPlace).not.toHaveBeenCalled();
  });

  it('hides an old amount in the checking-price pill', async () => {
    ui = { ...ui, state: 'CHECKING_PRICE', price: { ...ui.price, description: 'Costs 40,000 Shards' } }; await render();
    expect(host.querySelector('.pk-price__text')?.textContent).toBe('…');
    expect(host.textContent).not.toContain('40,000');
    expect(placeButton().getAttribute('aria-label')).not.toContain('40,000');
    expect(placeButton().getAttribute('aria-label')).toContain('Shards price: checking');
    expect(host.querySelector('.pk-price-door')).toBeNull();
  });

  it('waits for an unknown price even when the placement tiles are valid', async () => {
    ui = { ...ui, price: { ...ui.price, status: 'CHECKING' } }; await render();
    expect(placeButton().disabled).toBe(true); clickPlace();
    expect(host.querySelector('.pk-price__text')?.textContent).toBe('…');
    expect(on.onPlace).not.toHaveBeenCalled();
  });

  it('shows unavailable price feedback and never turns it into a zero or a place', async () => {
    ui = { ...ui, price: { ...ui.price, status: 'UNAVAILABLE' } }; await render();
    expect(host.querySelector('.pk-price__text')?.textContent).toBe('unavailable');
    expect(host.textContent).toContain('Price unavailable right now');
    expect(placeButton().disabled).toBe(true); clickPlace(); expect(on.onPlace).not.toHaveBeenCalled();
  });

  it.each(['SHORT', 'VALID'] as const)('routes a %s shortfall through PLACE and the separate red price door', async state => {
    const price: PriceUi = { ...ui.price, currency: 'GEMS', status: state === 'SHORT' ? 'OK' : 'SHORT' };
    ui = { ...ui, state, price }; on.canPlace = vi.fn(() => false); await render();
    expect(host.querySelector('.pk-price--short')).not.toBeNull();
    expect(placeButton().disabled).toBe(false);
    clickPlace(); act(() => host.querySelector<HTMLButtonElement>('.pk-price-door')!.click());
    expect(on.onNeedMore).toHaveBeenCalledTimes(2); expect(on.onNeedMore).toHaveBeenCalledWith('GEMS');
    expect(on.onPlace).not.toHaveBeenCalled(); expect(on.canPlace).not.toHaveBeenCalled();
  });

  it('opens Builders from NO_BUILDER and keeps the supplied availability text', async () => {
    ui = { ...ui, state: 'NO_BUILDER', builders: 'free in 2h 14m' }; await render();
    expect(host.textContent).toContain('free in 2h 14m'); expect(host.textContent).toContain('No free builder');
    expect(placeButton().disabled).toBe(false); clickPlace();
    expect(on.onBuilders).toHaveBeenCalledTimes(1); expect(on.onPlace).not.toHaveBeenCalled();
  });

  it.each(states)('preserves native Cancel availability in %s', async state => {
    ui = { ...ui, state }; await render();
    expect(cancelButton().disabled).toBe(state === 'SENDING');
    act(() => cancelButton().click());
    expect(on.onCancel).toHaveBeenCalledTimes(state === 'SENDING' ? 0 : 1);
    expect(on.onPlace).not.toHaveBeenCalled();
  });

  it('offers Report only for an uncertain placement and never claims nothing was spent', async () => {
    ui = { ...ui, state: 'VERIFYING' }; await render();
    expect(host.textContent).toContain('Checking with the server');
    expect(host.textContent).not.toContain('Nothing was spent');
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Report a problem with this placement"]')!.click());
    expect(on.onReport).toHaveBeenCalledTimes(1); expect(on.onPlace).not.toHaveBeenCalled();
    ui = { ...ui, state: 'ERROR' }; await render();
    expect(host.querySelector('button[aria-label="Report a problem with this placement"]')).toBeNull();
    clickPlace(); expect(on.onPlace).toHaveBeenCalledTimes(1);
  });

  it('preserves mapper-supplied hint and reason and keeps paint-only surfaces inert', async () => {
    ui = { ...ui, state: 'BLOCKED', hint: 'Move the workshop away from the wall.', reason: 'Reserved tile' }; await render();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(ui.hint);
    expect(host.textContent).toContain('Reserved tile');
    act(() => {
      host.querySelector<HTMLElement>('.pk-placement-bar__shelf')!.click();
      host.querySelector<HTMLElement>('.pk-placement-bar__hint')!.click();
      host.querySelector<HTMLElement>('.pk-placement-bar__info')!.click();
    });
    for (const callback of [on.onPlace, on.onReviewGems, on.onCancel, on.onNeedMore, on.onBuilders, on.onReport]) {
      expect(callback).not.toHaveBeenCalled();
    }
  });
});
