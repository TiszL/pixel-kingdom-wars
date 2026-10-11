/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ObstacleRemoveSheet, { type ObstacleRemoveActions, type ObstacleRemoveUi } from './ObstacleRemoveSheet';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };
const actions = (): ObstacleRemoveActions => ({ canRemove: vi.fn(() => true), onRemove: vi.fn(), onReviewGems: vi.fn(),
  onBuilders: vi.fn(), onGetMore: vi.fn(), onClose: vi.fn(), onReport: vi.fn() });
const ui: ObstacleRemoveUi = { obstacleId: 'selected-rock', name: 'MOSSY ROCK', title: 'REMOVE ROCK', art: <span>rock art</span>,
  price: { currency: 'SHARDS', amount: 'server price', status: 'OK' }, time: 'server duration', builders: 'server builders', reward: null,
  state: 'READY', shortfall: null, builderFreeIn: null, reason: null, primaryDetail: 'Uses server builders for server duration' };
const button = (prefix: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label')?.startsWith(prefix))!;
const click = async (prefix: string) => { await act(async () => button(prefix).click()); };

describe('ObstacleRemoveSheet', () => {
  it.each(['SHARDS', 'GEMS'] as const)('treats a throwing %s admission read as false without errors and preserves Close', async currency => {
    const on = actions();
    on.canRemove = vi.fn(() => { throw new Error('Controller snapshot unavailable'); });
    const windowError = vi.fn((event: ErrorEvent) => { event.preventDefault(); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', windowError);
    try {
      await render(<ObstacleRemoveSheet ui={{ ...ui, price: { ...ui.price, currency } }} on={on} />);
      await click('REMOVE');
      expect(on.canRemove).toHaveBeenCalledOnce();
      expect(on.onRemove).not.toHaveBeenCalled(); expect(on.onReviewGems).not.toHaveBeenCalled();
      expect(button('Close').disabled).toBe(false); await click('Close');
      expect(on.onClose).toHaveBeenCalledOnce();
      expect(windowError).not.toHaveBeenCalled(); expect(consoleError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', windowError);
      consoleError.mockRestore();
    }
  });
  it.each(['SOL', 'KEEP', 'SKR', 'ITEM'] as const)('keeps unsupported %s quotes off with no send or purchase door', async currency => {
    const on = actions();
    for (const state of ['READY', 'SHORT', 'CHECKING'] as const) {
      const status = state === 'READY' ? 'OK' : state;
      await render(<ObstacleRemoveSheet ui={{ ...ui, state, price: { ...ui.price, currency, status } }} on={on} />);
      expect(button('REMOVE').getAttribute('aria-disabled')).toBe('true');
      expect(host.textContent).toContain('This removal is not available for this currency.');
      expect(button('GET ')).toBeUndefined(); expect(host.querySelector('.pk-price-door')).toBeNull();
      await click('REMOVE');
    }
    expect(on.canRemove).not.toHaveBeenCalled(); expect(on.onRemove).not.toHaveBeenCalled();
    expect(on.onReviewGems).not.toHaveBeenCalled(); expect(on.onGetMore).not.toHaveBeenCalled();
  });
  it('renders the HALF quote with supplied art, cost, timing and no invented reward', async () => {
    await render(<ObstacleRemoveSheet ui={ui} on={actions()} />);
    expect(host.querySelector('[data-sheet-size="HALF"]')).not.toBeNull(); expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-label="MOSSY ROCK"]')).not.toBeNull(); expect(host.textContent).toContain('rock art');
    expect(host.textContent).toContain('server price'); expect(host.textContent).toContain('Uses server builders for server duration');
    expect(host.querySelector('[data-obstacle-reward]')).toBeNull();
  });
  it('only sends a known Shards removal when the original controller still admits it', async () => {
    const on = actions(); let allowed = true; on.canRemove = () => allowed;
    await render(<ObstacleRemoveSheet ui={ui} on={on} />); await click('REMOVE'); expect(on.onRemove).toHaveBeenCalledOnce();
    allowed = false; await click('REMOVE'); expect(on.onRemove).toHaveBeenCalledOnce(); expect(on.onReviewGems).not.toHaveBeenCalled();
  });
  it('routes a payable Gems removal through consent without a direct removal call', async () => {
    const on = actions(); await render(<ObstacleRemoveSheet ui={{ ...ui, price: { ...ui.price, currency: 'GEMS' } }} on={on} />);
    await click('REMOVE'); expect(on.onReviewGems).toHaveBeenCalledOnce(); expect(on.onRemove).not.toHaveBeenCalled();
  });
  it('keeps the obstacle visible while the unknown price waits and blank readouts stay unknown', async () => {
    const on = actions(); await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'CHECKING', price: { ...ui.price, status: 'CHECKING' }, time: ' ', builders: '', primaryDetail: null }} on={on} />);
    expect(host.textContent).toContain('rock art'); expect(host.textContent).not.toContain('server price');
    expect(host.querySelector('[aria-label="Takes …"]')).not.toBeNull(); expect(host.querySelector('[aria-label="Builders …"]')).not.toBeNull();
    expect(button('Checking price').disabled).toBe(true); await click('Checking price'); expect(on.onRemove).not.toHaveBeenCalled();
  });
  it('shortfall opens Need-more from the price and blue door, hiding time and builders', async () => {
    const on = actions(); await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'SHORT', shortfall: 'server gap' }} on={on} />);
    expect(host.textContent).toContain('Need server gap more Shards'); expect(host.textContent).not.toContain('server duration');
    expect(host.textContent).not.toContain('server builders'); expect(host.querySelector('.pk-price--short')).not.toBeNull();
    await click('GET SHARDS'); await act(async () => host.querySelector<HTMLButtonElement>('.pk-price-door')!.click());
    expect(on.onGetMore).toHaveBeenCalledTimes(2); expect(on.onGetMore).toHaveBeenLastCalledWith('SHARDS'); expect(on.onRemove).not.toHaveBeenCalled();
  });
  it('shows only the supplied builder wait and server reward', async () => {
    const on = actions(); await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'NO_BUILDER', reward: 'Server reward', builderFreeIn: 'server wait' }} on={on} />);
    expect(host.textContent).toContain('Server reward'); expect(host.textContent).toContain('Free in server wait');
    await click('BUILDERS'); expect(on.onBuilders).toHaveBeenCalledOnce(); expect(on.onRemove).not.toHaveBeenCalled();
    await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'NO_BUILDER' }} on={on} />); expect(host.textContent).not.toContain('Free in');
  });
  it('holds Close during BUSY and never resends an uncertain removal', async () => {
    const on = actions(); await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'BUSY' }} on={on} />);
    expect(button('Close').disabled).toBe(true); await click('Close'); await click('Starting'); expect(on.onClose).not.toHaveBeenCalled();
    await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'VERIFYING', reason: 'Checking the original removal' }} on={on} />);
    expect(button('Being checked').disabled).toBe(true); expect(button('RETRY')).toBeUndefined(); expect(host.textContent).toContain('Checking the original removal');
    await click('Being checked'); await click('Report'); await click('Close');
    expect(on.onRemove).not.toHaveBeenCalled(); expect(on.onReport).toHaveBeenCalledOnce(); expect(on.onClose).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain('Nothing was spent');
  });
  it('keeps read-only inert with the herald reason and lets an authoritative refusal retry', async () => {
    const on = actions(); await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'READ_ONLY', reason: 'Viewing another kingdom' }} on={on} />);
    expect(host.textContent).toContain('Viewing another kingdom'); await click('REMOVE'); expect(on.onRemove).not.toHaveBeenCalled();
    await render(<ObstacleRemoveSheet ui={{ ...ui, state: 'ERROR' }} on={on} />); await click('REMOVE'); expect(on.onRemove).toHaveBeenCalledOnce();
  });
});
