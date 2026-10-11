/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UpgradeSheet, { type UpgradeSheetActions, type UpgradeSheetUi } from './UpgradeSheet';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };
const actions = (): UpgradeSheetActions => ({
  canUpgrade: vi.fn(() => true), onUpgrade: vi.fn(), onReviewGems: vi.fn(), onGetMore: vi.fn(),
  onBuilders: vi.fn(), onClose: vi.fn(), onReport: vi.fn(),
});
const ui: UpgradeSheetUi = {
  buildingId: 'selected-building', name: 'WORKSHOP', levelFrom: 'LV 2', levelTo: 'LV 3',
  artNow: <span>current art</span>, artNext: <span>next art</span>, newLook: false,
  rows: [{ icon: 'shape:hammer', label: 'Capacity', old: 'server old', new: 'server new', unlock: false }],
  price: { currency: 'SHARDS', amount: 'server price', status: 'OK' }, time: 'server duration', builders: 'server builders',
  state: 'READY', shortfall: null, bestDoorLabel: null, builderFreeIn: null, reason: null,
};
const button = (prefix: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
  .find(item => item.getAttribute('aria-label')?.startsWith(prefix))!;
const click = async (prefix: string) => { await act(async () => button(prefix).click()); };

describe('UpgradeSheet presentation', () => {
  it('declares a tall body and keeps an unknown price from sending', async () => {
    const on = actions();
    await render(<UpgradeSheet ui={{ ...ui, price: { ...ui.price, amount: 'stale price', status: 'CHECKING' } }} on={on} />);
    expect(host.querySelector('[data-sheet-size="TALL"]')).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull(); // The single shared host owns the dialog.
    expect(host.textContent).toContain('…'); expect(host.textContent).not.toContain('stale price');
    expect(button('Checking the price').disabled).toBe(true);
    await click('Checking the price'); expect(on.onUpgrade).not.toHaveBeenCalled(); expect(on.onReviewGems).not.toHaveBeenCalled();
  });

  it('rechecks the original controller before a payable Shards upgrade', async () => {
    const on = actions(); let allowed = true; on.canUpgrade = () => allowed;
    await render(<UpgradeSheet ui={ui} on={on} />);
    expect(host.textContent).toContain('server duration'); expect(host.textContent).toContain('server builders');
    await click('UPGRADE'); expect(on.onUpgrade).toHaveBeenCalledOnce();
    allowed = false; await click('UPGRADE'); expect(on.onUpgrade).toHaveBeenCalledOnce();
    expect(on.onReviewGems).not.toHaveBeenCalled();
  });

  it('routes a payable Gems price to consent instead of directly spending', async () => {
    const on = actions();
    await render(<UpgradeSheet ui={{ ...ui, price: { ...ui.price, currency: 'GEMS' } }} on={on} />);
    await click('UPGRADE'); expect(on.onReviewGems).toHaveBeenCalledOnce(); expect(on.onUpgrade).not.toHaveBeenCalled();
  });

  it.each(['SOL', 'KEEP', 'SKR', 'ITEM'] as const)('keeps unsupported %s upgrades OFF with a reason and emits no intent', async (currency) => {
    const on = actions();
    for (const state of ['READY', 'ERROR', 'SHORT', 'NO_BUILDER'] as const) {
      await render(<UpgradeSheet ui={{ ...ui, state, price: { ...ui.price, currency } }} on={on} />);
      expect(button('UPGRADE').classList.contains('pk-verb--off')).toBe(true);
      expect(button('UPGRADE').getAttribute('aria-disabled')).toBe('true');
      expect(host.textContent).toContain('This upgrade currency is not supported here.');
      expect(host.querySelector('.pk-upgrade__door')).toBeNull();
      await click('UPGRADE');
    }
    await render(<UpgradeSheet ui={{ ...ui, reason: 'This offer is unavailable in this realm.',
      price: { currency, amount: null, status: 'SERVER_ZERO' } }} on={on} />);
    expect(host.textContent).toContain('This offer is unavailable in this realm.');
    await click('UPGRADE');
    expect(on.canUpgrade).not.toHaveBeenCalled();
    expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onReviewGems).not.toHaveBeenCalled();
    expect(on.onGetMore).not.toHaveBeenCalled();
    expect(on.onBuilders).not.toHaveBeenCalled();
  });

  it('honors the original controller synchronous latch on two upgrade taps before a rerender', async () => {
    const on = actions(); let pending = false;
    on.canUpgrade = vi.fn(() => !pending);
    on.onUpgrade = vi.fn(() => { pending = true; });
    await render(<UpgradeSheet ui={ui} on={on} />);
    await act(async () => { button('UPGRADE').click(); button('UPGRADE').click(); });
    expect(on.canUpgrade).toHaveBeenCalledTimes(2);
    expect(on.onUpgrade).toHaveBeenCalledOnce();
    expect(on.onReviewGems).not.toHaveBeenCalled();
  });

  it.each(['time', 'builders'] as const)('renders null %s as the shared ellipsis without replacing the other supplied requirement', async (field) => {
    await render(<UpgradeSheet ui={{ ...ui, [field]: null }} on={actions()} />);
    const missingLabel = field === 'time' ? 'Takes …' : 'Builders …';
    expect(host.querySelector(`[aria-label="${missingLabel}"]`)?.textContent).toBe('…');
    expect(host.textContent).toContain(field === 'time' ? 'server builders' : 'server duration');
  });

  it('short prices keep both upgrade and the blue door on Need-more', async () => {
    const on = actions();
    await render(<UpgradeSheet ui={{ ...ui, state: 'SHORT', shortfall: 'server gap', bestDoorLabel: 'Collect at your Mines' }} on={on} />);
    expect(host.textContent).toContain('Need server gap more Shards'); expect(host.textContent).toContain('Collect at your Mines');
    expect(host.querySelector('.pk-price--short')).not.toBeNull();
    expect(host.textContent).not.toContain('server duration'); expect(host.textContent).not.toContain('server builders');
    await click('UPGRADE'); await click('GET SHARDS');
    expect(on.onGetMore).toHaveBeenCalledTimes(2); expect(on.onGetMore).toHaveBeenLastCalledWith('SHARDS');
    expect(on.onUpgrade).not.toHaveBeenCalled();
  });

  it('a missing builder opens Builders from the off upgrade and the builder door', async () => {
    const on = actions();
    await render(<UpgradeSheet ui={{ ...ui, state: 'NO_BUILDER', builderFreeIn: 'server wait' }} on={on} />);
    expect(host.textContent).toContain('Free in server wait');
    await click('UPGRADE'); await click('BUILDERS'); expect(on.onBuilders).toHaveBeenCalledTimes(2);
    expect(on.onUpgrade).not.toHaveBeenCalled();
  });

  it('a sent or uncertain order has no second send and retains Report during checking', async () => {
    const on = actions();
    await render(<UpgradeSheet ui={{ ...ui, state: 'BUSY' }} on={on} />);
    expect(button('Starting').disabled).toBe(true); await click('Starting');
    await render(<UpgradeSheet ui={{ ...ui, state: 'VERIFYING', reason: 'Checking whether the upgrade went through.' }} on={on} />);
    expect(button('Checking the upgrade').disabled).toBe(true); await click('Checking the upgrade');
    expect(host.textContent).not.toContain('Nothing was spent'); await click('Report'); expect(on.onReport).toHaveBeenCalledOnce();
    await click('Close'); expect(on.onClose).toHaveBeenCalledOnce();
    expect(on.onUpgrade).not.toHaveBeenCalled();
  });

  it('max and read-only states show their reason and keep the off primary inert', async () => {
    const on = actions();
    await render(<UpgradeSheet ui={{ ...ui, state: 'MAX' }} on={on} />);
    expect(host.textContent).toContain('Already at the highest level'); await click('UPGRADE');
    await render(<UpgradeSheet ui={{ ...ui, state: 'READ_ONLY', reason: 'Viewing another kingdom' }} on={on} />);
    expect(host.textContent).toContain('Viewing another kingdom'); await click('UPGRADE');
    expect(on.onUpgrade).not.toHaveBeenCalled();
    expect(on.onGetMore).not.toHaveBeenCalled(); expect(on.onBuilders).not.toHaveBeenCalled();
  });

  it('folds improvement rows and remembers the expanded view for this mounted sheet', async () => {
    const on = actions(); const rows = Array.from({ length: 6 }, (_, i) => ({ ...ui.rows[0]!, label: `stat ${i}` }));
    await render(<UpgradeSheet ui={{ ...ui, rows }} on={on} />);
    expect(host.querySelectorAll('[data-upgrade-stat]')).toHaveLength(4);
    await click('Show 2 more improvements'); expect(host.querySelectorAll('[data-upgrade-stat]')).toHaveLength(6);
    await render(<UpgradeSheet ui={{ ...ui, buildingId: 'another-building', rows }} on={on} />);
    expect(host.querySelectorAll('[data-upgrade-stat]')).toHaveLength(6);
  });

  it('shows NEW LOOK only from the supplied tier-change flag', async () => {
    const on = actions(); await render(<UpgradeSheet ui={ui} on={on} />);
    expect(host.textContent).not.toContain('NEW LOOK');
    await render(<UpgradeSheet ui={{ ...ui, newLook: true }} on={on} />); expect(host.textContent).toContain('NEW LOOK');
  });

  it('allows a retry after authoritative refusal but never retries a lost answer', async () => {
    const on = actions(); await render(<UpgradeSheet ui={{ ...ui, state: 'ERROR' }} on={on} />);
    await click('UPGRADE'); expect(on.onUpgrade).toHaveBeenCalledOnce();
    await render(<UpgradeSheet ui={{ ...ui, state: 'VERIFYING' }} on={on} />);
    await click('Checking the upgrade'); expect(on.onUpgrade).toHaveBeenCalledOnce();
  });

  it('holds Close briefly while an order starts and releases it after the Android hold', async () => {
    vi.useFakeTimers(); const on = actions();
    await render(<UpgradeSheet ui={{ ...ui, state: 'BUSY' }} on={on} />);
    expect(button('Close').disabled).toBe(true); await click('Close'); expect(on.onClose).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(500); }); // Android presentation delay, not a game value.
    expect(button('Close').disabled).toBe(false); await click('Close'); expect(on.onClose).toHaveBeenCalledOnce();
  });

  it('keeps requirement chips paint-only and omits missing builder timing copy', async () => {
    const on = actions(); await render(<UpgradeSheet ui={{ ...ui, state: 'NO_BUILDER' }} on={on} />);
    expect(host.querySelector('.pk-upgrade__costs button')).toBeNull();
    expect(host.textContent).not.toContain('Free in'); expect(on.onBuilders).not.toHaveBeenCalled();
  });

  it('renders a new-only stat without a fabricated old value or arrow', async () => {
    await render(<UpgradeSheet ui={{ ...ui, rows: [{ ...ui.rows[0]!, old: null }] }} on={actions()} />);
    const stat = host.querySelector('[data-upgrade-stat]')!;
    expect(stat.textContent).toBe('Capacityserver new'); expect(stat.textContent).not.toContain('→');
    expect(stat.getAttribute('aria-label')).toBe('Capacity: server new');
  });
});
