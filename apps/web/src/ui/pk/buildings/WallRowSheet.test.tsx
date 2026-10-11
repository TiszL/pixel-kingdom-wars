/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WallRowSheet, { type WallRowSheetActions, type WallRowSheetUi } from './WallRowSheet';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };
const actions = (): WallRowSheetActions => ({ canUpgrade: vi.fn(() => true), onUpgrade: vi.fn(), onReviewGems: vi.fn(),
  onCancelRow: vi.fn(), onGetMore: vi.fn(), onRecheck: vi.fn(), onBuilders: vi.fn(), onReport: vi.fn() });
const ui: WallRowSheetUi = {
  fromLevel: 'LV supplied old', toLevel: 'LV supplied new', artNow: <span>wall now</span>, artNext: <span>wall next</span>, count: 7,
  rows: [{ icon: 'shield', label: 'Hitpoints each', old: 'server old', new: 'server new', unlock: false }],
  unitPrice: { currency: 'SHARDS', amount: 'server unit', status: 'OK' }, total: { currency: 'SHARDS', amount: 'server total', status: 'OK' },
  time: 'server duration', builders: 'server builders', state: 'READY', shortfall: null, builderFreeIn: null, reason: null, wallsStayUp: false,
};
const button = (prefix: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label')?.startsWith(prefix))!;
const click = async (prefix: string) => { await act(async () => button(prefix).click()); };

describe('WallRowSheet', () => {
  it.each(['SHARDS', 'GEMS'] as const)('treats a throwing %s admission read as false without errors and preserves Cancel and Close', async currency => {
    const on = actions();
    on.canUpgrade = vi.fn(() => { throw new Error('Controller snapshot unavailable'); });
    const windowError = vi.fn((event: ErrorEvent) => { event.preventDefault(); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', windowError);
    try {
      await render(<WallRowSheet ui={{ ...ui, unitPrice: { ...ui.unitPrice, currency }, total: { ...ui.total, currency } }} on={on} />);
      await click('UPGRADE 7');
      expect(on.canUpgrade).toHaveBeenCalledOnce();
      expect(on.onUpgrade).not.toHaveBeenCalled(); expect(on.onReviewGems).not.toHaveBeenCalled();
      expect(button('CANCEL ROW').disabled).toBe(false); expect(button('Close').disabled).toBe(false);
      await click('CANCEL ROW'); await click('Close');
      expect(on.onCancelRow).toHaveBeenCalledTimes(2);
      expect(windowError).not.toHaveBeenCalled(); expect(consoleError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', windowError);
      consoleError.mockRestore();
    }
  });
  it.each(['SHARDS', 'GEMS'] as const)('keeps a supported %s total OFF when its unit currency differs, with an unavailable pill and no doors', async totalCurrency => {
    const on = actions();
    const unitCurrency = totalCurrency === 'SHARDS' ? 'GEMS' : 'SHARDS';
    for (const state of ['READY', 'ERROR', 'SHORT', 'CHECKING'] as const) {
      const status = state === 'READY' || state === 'ERROR' ? 'OK' : state;
      await render(<WallRowSheet ui={{ ...ui, state,
        unitPrice: { ...ui.unitPrice, currency: unitCurrency, status, description: 'Stale unit price description' },
        total: { ...ui.total, currency: totalCurrency, status, description: 'Stale total price description' },
      }} on={on} />);
      expect(button('UPGRADE 7').getAttribute('aria-disabled')).toBe('true');
      expect(host.textContent).toContain('Price unavailable right now');
      expect(host.querySelector('.pk-price--unavailable .pk-price__text')?.textContent).toBe('unavailable');
      expect(host.textContent).not.toContain('server unit'); expect(host.textContent).not.toContain('server total');
      expect(host.innerHTML).not.toContain('Stale unit price description');
      expect(host.innerHTML).not.toContain('Stale total price description');
      expect(button('GET ')).toBeUndefined(); expect(host.querySelector('.pk-price-door')).toBeNull();
      await click('UPGRADE 7');
    }
    expect(on.canUpgrade).not.toHaveBeenCalled(); expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onReviewGems).not.toHaveBeenCalled(); expect(on.onGetMore).not.toHaveBeenCalled();
    expect(on.onRecheck).not.toHaveBeenCalled(); expect(on.onBuilders).not.toHaveBeenCalled();
  });
  it.each(['SOL', 'KEEP', 'SKR', 'ITEM'] as const)('never opens an unsupported %s unit-price door even when the total says Shards', async currency => {
    const on = actions();
    for (const status of ['SHORT', 'CHECKING'] as const) {
      await render(<WallRowSheet ui={{ ...ui, unitPrice: { ...ui.unitPrice, currency, status } }} on={on} />);
      expect(host.querySelector('.pk-price-door')).toBeNull();
    }
    expect(on.onGetMore).not.toHaveBeenCalled(); expect(on.onRecheck).not.toHaveBeenCalled();
  });
  it.each(['SOL', 'KEEP', 'SKR', 'ITEM'] as const)('keeps unsupported %s quotes off with no send or purchase door', async currency => {
    const on = actions();
    for (const state of ['READY', 'SHORT', 'CHECKING'] as const) {
      const status = state === 'READY' ? 'OK' : state;
      await render(<WallRowSheet ui={{ ...ui, state, total: { ...ui.total, currency, status }, unitPrice: { ...ui.unitPrice, currency, status } }} on={on} />);
      expect(button('UPGRADE 7').getAttribute('aria-disabled')).toBe('true');
      expect(host.textContent).toContain('This row upgrade is not available for this currency.');
      expect(button('GET ')).toBeUndefined(); expect(host.querySelector('.pk-price-door')).toBeNull();
      await click('UPGRADE 7');
    }
    expect(on.canUpgrade).not.toHaveBeenCalled(); expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onReviewGems).not.toHaveBeenCalled(); expect(on.onGetMore).not.toHaveBeenCalled();
    expect(on.onRecheck).not.toHaveBeenCalled();
  });
  it('renders HALF with three supplied pieces per grass well, no promised art change or duplicate dialog', async () => {
    await render(<WallRowSheet ui={ui} on={actions()} />);
    expect(host.querySelector('[data-sheet-size="HALF"]')).not.toBeNull(); expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelectorAll('[data-wall-piece]')).toHaveLength(6);
    expect(host.querySelector('[data-gold-rim="true"]')).toBeNull();
    expect(host.textContent).toContain('7 × server unit'); expect(host.textContent).toContain('server total Shards in all');
    expect(host.textContent).not.toContain('Walls stay up');
  });
  it('rechecks live admission and routes a Gems row to consent, never direct spend', async () => {
    const on = actions(); let allowed = true; on.canUpgrade = () => allowed;
    await render(<WallRowSheet ui={ui} on={on} />); await click('UPGRADE 7'); expect(on.onUpgrade).toHaveBeenCalledOnce();
    allowed = false; await click('UPGRADE 7'); expect(on.onUpgrade).toHaveBeenCalledOnce();
    allowed = true; await render(<WallRowSheet ui={{ ...ui, unitPrice: { ...ui.unitPrice, currency: 'GEMS' }, total: { ...ui.total, currency: 'GEMS' } }} on={on} />);
    await click('UPGRADE 7'); expect(on.onReviewGems).toHaveBeenCalledOnce(); expect(on.onUpgrade).toHaveBeenCalledOnce();
  });
  it('keeps a checking price pill on recheck while the commit waits', async () => {
    const on = actions(); await render(<WallRowSheet ui={{ ...ui, count: 0, state: 'CHECKING', unitPrice: { ...ui.unitPrice, status: 'CHECKING' } }} on={on} />);
    expect(button('Checking price').disabled).toBe(true); expect(host.textContent).not.toContain('server unit');
    await act(async () => host.querySelector<HTMLButtonElement>('.pk-price-door')!.click());
    expect(on.onRecheck).toHaveBeenCalledOnce(); expect(on.onUpgrade).not.toHaveBeenCalled();
  });
  it('an empty row disables the commit with the supplied target level and hides an instant time chip', async () => {
    const on = actions(); await render(<WallRowSheet ui={{ ...ui, count: 0, time: null }} on={on} />);
    expect(host.textContent).toContain('All walls are LV supplied new'); expect(host.textContent).not.toContain('server duration');
    await click('UPGRADE 0'); expect(on.onUpgrade).not.toHaveBeenCalled();
  });
  it('shortfall replaces time and builders, and both primaries and the pill open Need-more', async () => {
    const on = actions(); await render(<WallRowSheet ui={{ ...ui, state: 'SHORT', shortfall: 'server gap' }} on={on} />);
    expect(host.textContent).toContain('Need server gap more Shards'); expect(host.textContent).not.toContain('server duration');
    expect(host.textContent).not.toContain('server builders'); expect(host.textContent).toContain('server total');
    await click('UPGRADE 7'); await click('GET SHARDS');
    await act(async () => host.querySelector<HTMLButtonElement>('.pk-price-door')!.click());
    expect(on.onGetMore).toHaveBeenCalledTimes(3); expect(on.onGetMore).toHaveBeenLastCalledWith('SHARDS'); expect(on.onUpgrade).not.toHaveBeenCalled();
  });
  it('routes builder recovery from the disabled upgrade and Builders door', async () => {
    const on = actions(); await render(<WallRowSheet ui={{ ...ui, state: 'NO_BUILDER', builderFreeIn: 'server wait' }} on={on} />);
    expect(host.textContent).toContain('Free in server wait'); await click('UPGRADE 7'); await click('BUILDERS');
    expect(on.onBuilders).toHaveBeenCalledTimes(2); expect(on.onUpgrade).not.toHaveBeenCalled();
  });
  it('holds cancel and Close throughout BUSY, then exposes both during VERIFYING without a resend', async () => {
    const on = actions(); await render(<WallRowSheet ui={{ ...ui, state: 'BUSY' }} on={on} />);
    expect(button('CANCEL ROW').disabled).toBe(true); expect(button('Close').disabled).toBe(true);
    await click('CANCEL ROW'); await click('Close'); await click('Starting'); expect(on.onCancelRow).not.toHaveBeenCalled();
    await render(<WallRowSheet ui={{ ...ui, state: 'VERIFYING' }} on={on} />);
    expect(button('Being checked').disabled).toBe(true); expect(button('RETRY')).toBeUndefined(); await click('Being checked');
    await click('Report'); await click('CANCEL ROW'); await click('Close');
    expect(on.onReport).toHaveBeenCalledOnce(); expect(on.onCancelRow).toHaveBeenCalledTimes(2); expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Nothing was spent');
  });
  it('keeps read-only off and permits ERROR retry only through the live controller', async () => {
    const on = actions(); await render(<WallRowSheet ui={{ ...ui, state: 'READ_ONLY', reason: 'Server restriction' }} on={on} />);
    expect(host.textContent).toContain('Server restriction'); await click('UPGRADE 7'); expect(on.onUpgrade).not.toHaveBeenCalled();
    await render(<WallRowSheet ui={{ ...ui, state: 'ERROR' }} on={on} />); await click('UPGRADE 7'); expect(on.onUpgrade).toHaveBeenCalledOnce();
  });
  it('does not invent old stat values, builder timing, or wall-active promises', async () => {
    await render(<WallRowSheet ui={{ ...ui, state: 'NO_BUILDER', rows: [{ ...ui.rows[0]!, old: null }], wallsStayUp: true }} on={actions()} />);
    expect(host.querySelector('[data-wall-stat]')!.textContent).toBe('Hitpoints eachserver new');
    expect(host.textContent).not.toContain('Free in'); expect(host.textContent).toContain('Walls stay up while they upgrade.');
  });
});
