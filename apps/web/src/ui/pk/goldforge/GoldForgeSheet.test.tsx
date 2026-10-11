// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { view as contributionView } from '../../../lib/miningContribution/fixtures.test-support';
import type { MiningClaimProjection } from './ClaimAdapters';
import type { GemsAdapterProjection } from './GemsAdapters';
import type { SmeltProjection } from './SmeltAdapter';
import { GoldForgeSheet, type GoldForgeSheetProps, type GoldForgeOwner } from './GoldForgeSheet';

const originalKey = 'Original-Purchase.Key-Exact';
const claim = (update: Partial<MiningClaimProjection> = {}): MiningClaimProjection => ({
  amountBaseUnits: '3000000000', amountLabel: '3', paidBaseUnits: null, paidLabel: '…',
  status: 'ready', reason: null, observedAt: null, current: true, stage: 'READY', failure: null,
  displayMessage: 'Coins are ready to collect.', canOpenNewFlow: true, celebration: false,
  recovery: { available: false, requestKey: null, continuationRequestKey: null, held: false, canOpen: false }, ...update,
});
const gems = (update: Partial<GemsAdapterProjection> = {}): GemsAdapterProjection => ({
  balance: { amount: '9007199254740993', freshness: 'current' }, ledger: null, purchase: null,
  fresh: { walletBuy: true, ledgerKeepToGems: true, gemsToShards: true }, ...update,
});
const smelt = (update: Partial<SmeltProjection> = {}): SmeltProjection => ({
  day: '2035-01-01', pool: 'free', committed: '2', cap: { kind: 'limited', amount: '10' },
  resources: [{ resourceId: 'shards', available: '100', unitValue: '1' }],
  basket: { valid: true, reason: null, count: '1', value: '1' }, freshness: 'current',
  original: null, history: [], canReviewNew: true, message: 'Choose what to smelt.',
  estimate: null, qualified: null, raidDays: null, ...update,
});
const owner = (update: Partial<GoldForgeOwner> = {}): GoldForgeOwner => ({
  scopeCurrent: () => true, canStart: () => true, onStart: vi.fn(),
  canRecover: () => true, onRecover: vi.fn(), ...update,
});
const buy = () => ({ current: true, keepIn: '7', gemsOut: '7', rateLabel: 'Rate supplied by the forge',
  minimumKeep: '1', maximumKeep: '20', walletAfter: '13', quick: ['7', '13'], onAmountChange: vi.fn() });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function render(props: Partial<GoldForgeSheetProps> = {}) {
  act(() => root.render(<GoldForgeSheet scopeMatches onTab={vi.fn()} {...props} />));
}
function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(node => node.getAttribute('aria-label') === label || node.textContent === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
function click(label: string) { act(() => button(label).click()); }
const text = () => container.textContent ?? '';
const selected = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;

describe('GoldForgeSheet controlled owner handoff', () => {
  it('defaults to CLAIM for current claimable coins and SMELT otherwise without firing navigation on render', () => {
    const onTab = vi.fn(); render({ claim: claim(), onTab });
    expect(selected()).toContain('CLAIM'); expect(onTab).not.toHaveBeenCalled();
    render({ claim: claim({ amountBaseUnits: '0', amountLabel: '0', status: 'no_allocation' }), onTab });
    expect(selected()).toContain('SMELT');
    render({ claim: claim({ current: false }), onTab }); expect(selected()).toContain('SMELT');
  });

  it('always offers locked CLAIM and sends a hidden LEGACY deep link to CLAIM', () => {
    render({ tab: 'LEGACY', claim: claim({ status: 'unavailable', amountBaseUnits: null, amountLabel: '…', canOpenNewFlow: false,
      displayMessage: 'Coins are not open yet.' }) });
    expect(selected()).toContain('CLAIM'); expect(text()).toContain('Coins are not open yet.');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(text()).not.toContain('ALL COLLECTED');
  });

  it('uses controlled tab changes without mutating the selected tab', () => {
    const onTab = vi.fn(); render({ tab: 'SMELT', onTab }); click('GEMS');
    expect(onTab).toHaveBeenCalledWith('GEMS'); expect(selected()).toContain('SMELT');
  });

  it('keeps unknown coins as ellipsis and renders distinct no-allocation and collected messages', () => {
    render({ tab: 'CLAIM' }); expect(container.querySelector('[data-claim-amount]')?.textContent).toBe('…');
    render({ tab: 'CLAIM', claim: claim({ amountBaseUnits: '0', amountLabel: '0', status: 'no_allocation', displayMessage: 'No coins allocated yet.' }) });
    expect(text()).toContain('No coins allocated yet.'); expect(text()).not.toContain('These coins were collected.');
    render({ tab: 'CLAIM', claim: claim({ status: 'claimed', displayMessage: 'These coins were collected.' }) });
    expect(text()).toContain('These coins were collected.');
  });

  it('does not render raw reason metadata or identity-like fields on the CLAIM face', () => {
    const raw = 'RPC transaction devnet fixture-wallet-address signature failure';
    render({ tab: 'CLAIM', claim: claim({ reason: raw as MiningClaimProjection['reason'], displayMessage: 'Check your saved collection.' }) });
    expect(text()).toContain('To your wallet'); expect(text()).not.toMatch(/RPC|transaction|devnet|fixture-wallet-address|signature|custodial/i);
  });

  it('defaults fresh callbacks closed and rechecks the exact intent at click time', () => {
    const onStart = vi.fn(); render({ tab: 'CLAIM', claim: claim(), owner: { onStart } }); click('CLAIM. Coins are ready to collect.');
    expect(onStart).not.toHaveBeenCalled();
    let admitted = true; const canStart = vi.fn(() => admitted);
    render({ tab: 'CLAIM', claim: claim(), owner: owner({ canStart, onStart }) });
    admitted = false; click('CLAIM. 3 KEEP to your wallet'); expect(onStart).not.toHaveBeenCalled();
    admitted = true; click('CLAIM. 3 KEEP to your wallet');
    expect(onStart).toHaveBeenCalledWith({ kind: 'claim', amountBaseUnits: '3000000000', observedAt: null });
    expect(canStart).toHaveBeenLastCalledWith({ kind: 'claim', amountBaseUnits: '3000000000', observedAt: null });
  });

  it('paints controls disabled when live fresh or recovery admission already refuses', () => {
    const denied = owner({ canStart: () => false, canRecover: () => false });
    render({ tab: 'CLAIM', claim: claim(), owner: denied });
    expect(button('CLAIM. Coins are ready to collect.').getAttribute('aria-disabled')).toBe('true');
    render({ tab: 'CLAIM', claim: claim({ canOpenNewFlow: false,
      recovery: { available: true, requestKey: originalKey, continuationRequestKey: null, held: false, canOpen: true } }), owner: denied });
    expect(button('CONTINUE CLAIM').getAttribute('aria-disabled')).toBe('true');
  });

  it('fails closed when admission getters throw while keeping Close and History usable', () => {
    const onClose = vi.fn(), onHistory = vi.fn(), onStart = vi.fn(), onRecover = vi.fn();
    const unavailable = () => { throw new Error('Owner snapshot changed'); };
    render({ tab: 'CLAIM', claim: claim(), onClose, onHistory,
      owner: owner({ canStart: unavailable, onStart, onRecover }) });
    click('CLAIM. Coins are ready to collect.'); click('Close'); click('History');
    expect(onStart).not.toHaveBeenCalled(); expect(onRecover).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce(); expect(onHistory).toHaveBeenCalledOnce();
    render({ tab: 'CLAIM', claim: claim({ canOpenNewFlow: false,
      recovery: { available: true, requestKey: originalKey, continuationRequestKey: null, held: false, canOpen: true } }),
      onClose, onHistory, owner: owner({ scopeCurrent: unavailable, canRecover: unavailable, onRecover }) });
    // A live scope failure now masks the saved record, instead of merely disabling its door.
    expect(text()).not.toContain('CONTINUE CLAIM'); expect(onRecover).not.toHaveBeenCalled();
    click('Close'); expect(onClose).toHaveBeenCalledTimes(2);
    expect(Array.from(container.querySelectorAll('button')).some(node => node.getAttribute('aria-label') === 'History')).toBe(false);
  });

  it('keeps the saved claim reachable during a fresh hold and refuses a changed scope or original key before repaint', () => {
    let scope = true, key = originalKey; const onStart = vi.fn(), onRecover = vi.fn(), onHistory = vi.fn();
    render({ tab: 'CLAIM', onHistory, claim: claim({ current: false, canOpenNewFlow: false, stage: 'FAILED', failure: 'UNCERTAIN',
      displayMessage: 'Check your saved collection.', recovery: { available: true, requestKey: originalKey, continuationRequestKey: null, held: true, canOpen: true } }),
      owner: owner({ scopeCurrent: () => scope, canStart: () => false, canRecover: (_kind, requestKey) => requestKey === key, onStart, onRecover }) });
    click('CONTINUE CLAIM'); expect(onRecover).toHaveBeenCalledWith('claim', originalKey);
    onRecover.mockClear(); key = 'replacement-key'; click('CONTINUE CLAIM'); expect(onRecover).not.toHaveBeenCalled();
    key = originalKey; scope = false; click('CONTINUE CLAIM'); expect(onRecover).not.toHaveBeenCalled();
    click('History'); expect(onHistory).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled(); expect(text()).not.toContain('Nothing was sent');
  });

  it('retains Gems balance and both original recovery doors while all new buys and conversions are held', () => {
    const onRecover = vi.fn(), onStart = vi.fn(), heldQuote = buy();
    render({ tab: 'GEMS', buy: heldQuote, gems: gems({ fresh: { walletBuy: false, ledgerKeepToGems: false, gemsToShards: false },
      balance: { amount: '9007199254740993', freshness: 'retained' },
      purchase: { requestKey: originalKey, keepIn: '7', quotedGems: '7', outcome: 'uncertain', stage: 'SENDING', receipt: null, hydrated: false },
      ledger: { requestKey: 'Original-Ledger.Key', kind: 'gems-to-shards', inputAmount: '3', outcome: 'uncertain', stage: 'SENDING', receipt: null, hydrated: false, finished: false } }),
      owner: owner({ onRecover, onStart, canStart: () => false }) });
    expect(text()).toContain('9,007,199,254,740,993'); expect(text()).toContain('Last known Gems balance');
    // Lantern1088ff5e M-2: the hold covers every amount control as well as money entry.
    for (const label of ['Decrease KEEP amount', 'Increase KEEP amount', 'Choose 7 KEEP', 'Choose 13 KEEP', 'MAX']) {
      expect(button(label).disabled, label).toBe(true); click(label);
    }
    expect(heldQuote.onAmountChange).not.toHaveBeenCalled();
    click('CONTINUE PURCHASE'); click('CHECK SAVED EXCHANGE');
    expect(onRecover.mock.calls).toEqual([['gems-purchase', originalKey], ['gems-ledger', 'Original-Ledger.Key']]);
    expect(onStart).not.toHaveBeenCalled(); expect(text()).not.toContain('Sending');
    expect(container.querySelector('[aria-label="A saved Gems purchase needs checking"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="A Gems purchase is waiting for your wallet"]')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some(node => node.getAttribute('aria-label') === 'SENT')).toBe(false);
  });

  it('suppresses previous-scope amounts and saved request doors after a wallet switch', () => {
    render({ tab: 'GEMS', scopeMatches: false, onHistory: vi.fn(), gems: gems({ purchase: { requestKey: originalKey, keepIn: '7', quotedGems: '7', outcome: 'saved', stage: 'READY', receipt: null, hydrated: false } }), owner: owner() });
    expect(text()).not.toContain('9,007,199,254,740,993'); expect(text()).not.toContain('CONTINUE PURCHASE');
    expect(text()).toContain('Gems balance'); expect(container.querySelector('[data-gems-balance]')?.textContent).toBe('…');
    expect(Array.from(container.querySelectorAll('button')).some(node => node.getAttribute('aria-label') === 'History')).toBe(false);
  });

  it('masks every prior-owner projection when a supplied live scope contradicts scopeMatches', () => {
    const canRecover = vi.fn(() => true), onRecover = vi.fn(), onStart = vi.fn(), onClose = vi.fn();
    const props: Partial<GoldForgeSheetProps> = {
      scopeMatches: true, owner: owner({ scopeCurrent: () => false, canRecover, onRecover, onStart }), onClose,
      claim: claim({ amountLabel: '246,813', amountBaseUnits: '246813000000000',
        recovery: { available: true, requestKey: originalKey, continuationRequestKey: 'old-continuation', held: false, canOpen: true } }),
      gems: gems({ purchase: { requestKey: originalKey, keepIn: '7', quotedGems: '7', outcome: 'saved', stage: 'READY', receipt: null, hydrated: false } }),
      buy: buy(), smelt: { projection: smelt({ original: { requestKey: originalKey, day: '2034-12-31',
        outcome: 'held', value: '13579', lines: [{ resourceId: 'shards', quantity: '13579' }] } }), view: null, lines: [], labels: {} },
      legacy: { visible: true, saved: '97531', current: true, conversionCopy: 'Private old forge offer', historySummary: 'Private old forge history' },
    };
    render({ ...props, tab: 'CLAIM' });
    expect(container.querySelector('[data-claim-amount]')?.textContent).toBe('…'); expect(text()).not.toContain('CONTINUE CLAIM');
    render({ ...props, tab: 'GEMS' });
    expect(container.querySelector('[data-gems-balance]')?.textContent).toBe('…'); expect(text()).not.toContain('CONTINUE PURCHASE');
    expect(text()).not.toContain('Rate supplied by the forge');
    render({ ...props, tab: 'SMELT' });
    expect(container.querySelector('[data-basket-worth]')?.textContent).toBe('…'); expect(text()).not.toContain('13579');
    expect(text()).not.toContain('OPEN SAVED BASKET');
    render({ ...props, tab: 'LEGACY' }); expect(selected()).toContain('CLAIM');
    expect(container.querySelector('[data-legacy-saved]')).toBeNull(); expect(text()).not.toContain('Private old forge');
    expect(canRecover).not.toHaveBeenCalled(); expect(onRecover).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled();
    click('Close'); expect(onClose).toHaveBeenCalledOnce();
  });

  it('masks previously rendered amounts and recovery when the live scope read throws on rerender', () => {
    const canRecover = vi.fn(() => true), onRecover = vi.fn();
    const snapshot = gems({ purchase: { requestKey: originalKey, keepIn: '7', quotedGems: '7', outcome: 'saved', stage: 'READY', receipt: null, hydrated: false } });
    render({ tab: 'GEMS', gems: snapshot, owner: owner({ canRecover, onRecover }) });
    expect(container.querySelector('[data-gems-balance]')?.textContent).toBe('9,007,199,254,740,993');
    expect(text()).toContain('CONTINUE PURCHASE'); canRecover.mockClear();
    render({ tab: 'GEMS', scopeMatches: true, gems: snapshot, owner: owner({
      scopeCurrent: () => { throw new Error('Owner scope unavailable'); }, canRecover, onRecover,
    }) });
    expect(container.querySelector('[data-gems-balance]')?.textContent).toBe('…'); expect(text()).not.toContain('CONTINUE PURCHASE');
    expect(text()).not.toContain('9,007,199,254,740,993'); expect(canRecover).not.toHaveBeenCalled(); expect(onRecover).not.toHaveBeenCalled();
  });

  it('keeps admitted read-only amounts visible without an owner while action handoffs remain closed', () => {
    render({ scopeMatches: true, tab: 'CLAIM', claim: claim() });
    expect(container.querySelector('[data-claim-amount]')?.textContent).toBe('3');
    expect(button('CLAIM. Coins are ready to collect.').getAttribute('aria-disabled')).toBe('true');
    render({ scopeMatches: true, tab: 'GEMS', gems: gems(), buy: buy() });
    expect(container.querySelector('[data-gems-balance]')?.textContent).toBe('9,007,199,254,740,993');
    expect(button('BUY 7 GEMS').getAttribute('aria-disabled')).toBe('true');
  });

  it('rechecks the Gems amount-control hold before invoking a stale painted callback', () => {
    const projection = gems(), quote = buy();
    render({ tab: 'GEMS', gems: projection, buy: quote, owner: owner() });
    expect(button('Increase KEEP amount').disabled).toBe(false);
    projection.fresh.walletBuy = false;
    for (const label of ['Decrease KEEP amount', 'Increase KEEP amount', 'Choose 7 KEEP', 'Choose 13 KEEP', 'MAX']) click(label);
    expect(quote.onAmountChange).not.toHaveBeenCalled();
  });

  it.each(['claim', 'walletBuy', 'gemsToShards', 'ledgerKeepToGems', 'smelt'] as const)(
    'requires the isolated %s projection gate even when the owner admits all fresh intents', gate => {
      const onStart = vi.fn(), claimView = claim(), gemsView = gems(), basket = smelt();
      const resources = [{ resourceId: 'shards' as const, available: '3', unitValue: '1' }];
      const data = { ...contributionView(), dailyCapValue: null, remainingValue: null, resources };
      if (gate === 'claim') claimView.canOpenNewFlow = false;
      else if (gate === 'smelt') basket.canReviewNew = false;
      else gemsView.fresh[gate] = false;
      render({ tab: gate === 'claim' ? 'CLAIM' : gate === 'smelt' ? 'SMELT' : 'GEMS',
        owner: owner({ canStart: () => true, onStart }), claim: claimView, gems: gemsView, buy: buy(),
        smelt: { projection: basket, view: data, lines: [{ resourceId: 'shards', quantity: '1' }], labels: {} } });
      const target = gate === 'gemsToShards' ? button('CONVERT') : gate === 'ledgerKeepToGems' ? button('KEEP INTO GEMS')
        : container.querySelector<HTMLButtonElement>('.pk-frame__foot .pk-btn--primary');
      expect(target).not.toBeNull();
      expect(target!.disabled || target!.getAttribute('aria-disabled') === 'true').toBe(true);
      act(() => target!.click()); expect(onStart).not.toHaveBeenCalled();
    },
  );

  it('groups whole-unit Gems displays and accessibility labels while preserving raw amount intents', () => {
    // Lantern1088ff5e m-1: display formatting never rewrites a request amount.
    const onStart = vi.fn(), quote = { ...buy(), keepIn: '9007199254740993', gemsOut: '18014398509481986',
      minimumKeep: '1', maximumKeep: '9007199254740994', walletAfter: '1234567', quick: ['1000'] };
    render({ tab: 'GEMS', gems: gems(), buy: quote, owner: owner({ onStart }) });
    expect(container.querySelector('[data-gems-balance]')?.textContent).toBe('9,007,199,254,740,993');
    expect(text()).toContain('9,007,199,254,740,993 KEEP'); expect(text()).toContain('18,014,398,509,481,986 GEMS');
    expect(text()).toContain('1,234,567 KEEP');
    expect(button('Choose 1,000 KEEP').textContent).toBe('1,000');
    expect(button('Choose maximum 9,007,199,254,740,994 KEEP').textContent).toBe('MAX');
    click('Choose 1,000 KEEP'); expect(quote.onAmountChange).toHaveBeenLastCalledWith('1000');
    click('Choose maximum 9,007,199,254,740,994 KEEP'); expect(quote.onAmountChange).toHaveBeenLastCalledWith('9007199254740994');
    click('BUY 18,014,398,509,481,986 GEMS. Paid with 9,007,199,254,740,993 KEEP');
    expect(onStart).toHaveBeenCalledWith({ kind: 'walletBuy', keepIn: '9007199254740993', gemsOut: '18014398509481986' });
    render({ tab: 'GEMS', gems: gems({
      purchase: { requestKey: originalKey, keepIn: '1000', quotedGems: '2000', outcome: 'credited', stage: 'SENT', hydrated: false,
        receipt: { receiptId: 'receipt-gems', acceptedAt: '2035-01-01T00:00:00Z', amount: '2000', currency: 'GEMS' } },
      ledger: { requestKey: 'Original-Exchange.Key', kind: 'gems-to-shards', inputAmount: '1000', outcome: 'credited', stage: 'SENT', hydrated: true, finished: true,
        receipt: { receiptId: 'receipt-shards', acceptedAt: '2035-01-01T00:00:00Z', amount: '3000', currency: 'SHARDS' } },
    }), owner: owner() });
    expect(text()).toContain('Saved receipt: 2,000 GEMS'); expect(text()).toContain('Saved receipt: 3,000 SHARDS');
  });

  it('uses one validated exact basket for its count, worth and action instead of stale projection totals', () => {
    const onStart = vi.fn(); const resources = [{ resourceId: 'shards' as const, available: '3000', unitValue: '1000' }];
    const data = { ...contributionView(), dailyCapValue: null, remainingValue: null, resources };
    const staleTotals = smelt({ resources, committed: '10000', cap: { kind: 'limited', amount: '10000000' },
      basket: { valid: true, reason: null, count: '9999', value: '9999' } });
    const lines = [{ resourceId: 'shards' as const, quantity: '2000' }];
    render({ tab: 'SMELT', owner: owner({ onStart }), smelt: { projection: staleTotals, view: data, lines,
      labels: { shards: { name: 'Shards', icon: 'shards', source: '' } } } });
    expect(container.querySelector('[data-basket-worth]')?.textContent).toBe('2,000,000');
    expect(text()).toContain('10,000'); expect(text()).toContain('10,000,000'); expect(text()).toContain('Have 3,000');
    expect(text()).toContain('+2,000'); expect(text()).toContain('Worth 1,000 each');
    expect(text()).not.toContain('9,999');
    click('SMELT. 2,000 items'); expect(onStart).toHaveBeenCalledWith({ kind: 'smelt', baseId: data.baseId, day: data.day, lines });
    render({ tab: 'SMELT', owner: owner({ onStart }), smelt: { projection: staleTotals, view: data, lines: [], labels: {} } });
    expect(button('SMELT. Choose what to smelt.').getAttribute('aria-disabled')).toBe('true');
  });

  it('groups historical saved quantities without treating them as current spendable stock', () => {
    render({ tab: 'SMELT', owner: owner(), smelt: { projection: smelt({ original: {
      requestKey: originalKey, day: '2034-12-31', outcome: 'held', value: '2000000', lines: [{ resourceId: 'shards', quantity: '2000' }],
    } }), view: null, lines: [], labels: { shards: { name: 'Shards', icon: 'shards', source: '' } } } });
    expect(container.querySelector('[data-basket-worth]')?.textContent).toBe('2,000,000'); expect(text()).toContain('Shards · 2,000');
    render({ tab: 'LEGACY', legacy: { visible: true, saved: '1234567', current: true, conversionCopy: null, historySummary: null } });
    expect(container.querySelector('[data-legacy-saved]')?.textContent).toBe('1,234,567');
  });

  it('explains the actual disabled state without inventing a pause for empty, unallocated or unknown data', () => {
    const data = { ...contributionView(), dailyCapValue: null, remainingValue: null };
    render({ tab: 'SMELT', owner: owner(), smelt: { projection: smelt(), view: data, lines: [], labels: {} } });
    expect(button('SMELT. Choose what to smelt.').getAttribute('aria-disabled')).toBe('true'); expect(text()).not.toMatch(/paused/i);
    render({ tab: 'CLAIM', owner: owner(), claim: claim({ status: 'no_allocation', amountBaseUnits: '0', amountLabel: '0',
      canOpenNewFlow: false, displayMessage: 'No coins allocated yet.' }) });
    expect(button('CLAIM. No coins allocated yet.').getAttribute('aria-disabled')).toBe('true'); expect(text()).not.toMatch(/paused/i);
    render({ tab: 'GEMS', owner: owner(), gems: gems() });
    expect(button('BUY … GEMS').getAttribute('aria-disabled')).toBe('true'); expect(text()).not.toMatch(/paused/i);
    render({ tab: 'CLAIM', owner: owner(), claim: claim({ status: 'paused', canOpenNewFlow: false, displayMessage: 'New collections are paused.' }) });
    expect(button('CLAIM. New collections are paused.').getAttribute('aria-disabled')).toBe('true');
  });

  it('passes current quoted buy amounts exactly and does not start a buy when its live quote is revoked', () => {
    const onStart = vi.fn(); let current = true;
    const canStart = vi.fn(() => current); render({ tab: 'GEMS', gems: gems(), buy: buy(), owner: owner({ canStart, onStart }) });
    current = false; click('BUY 7 GEMS. Paid with 7 KEEP'); expect(onStart).not.toHaveBeenCalled();
    current = true; click('BUY 7 GEMS. Paid with 7 KEEP');
    expect(onStart).toHaveBeenCalledWith({ kind: 'walletBuy', keepIn: '7', gemsOut: '7' });
    expect(text()).not.toContain('500'); expect(text()).not.toContain('1,000');
  });

  it('uses exact-string MAX and announces cap rejection instead of silently clamping a +1', () => {
    const onLinesChange = vi.fn(); const data = { ...contributionView(), dailyCapValue: null, remainingValue: null,
      resources: [{ resourceId: 'shards' as const, available: '9007199254740993', unitValue: '1' }] };
    render({ tab: 'SMELT', owner: owner(), smelt: { projection: smelt({ cap: { kind: 'uncapped', amount: null }, resources: data.resources }),
      view: data, lines: [], labels: { shards: { name: 'Shards', icon: 'shards', source: 'Your supplies' } }, onLinesChange } });
    click('MAX Shards'); expect(onLinesChange).toHaveBeenCalledWith([{ resourceId: 'shards', quantity: '9007199254740993' }]);
    const limited = { ...data, dailyCapValue: '1', remainingValue: '1' }; onLinesChange.mockClear();
    render({ tab: 'SMELT', owner: owner(), smelt: { projection: smelt(), view: limited, lines: [{ resourceId: 'shards', quantity: '1' }],
      labels: { shards: { name: 'Shards', icon: 'shards', source: 'Your supplies' } }, onLinesChange } });
    // Use the supplied label verbatim; resource names do not carry a singular-form contract.
    click('Shards: add 1'); expect(onLinesChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Today's allowance is full.");
    click('Shards: remove 1'); expect(onLinesChange).toHaveBeenCalledWith([]);
  });

  it('keeps an archived held basket reachable under a fresh hold using its original key', () => {
    const onRecover = vi.fn(), onStart = vi.fn();
    render({ tab: 'SMELT', owner: owner({ canStart: () => false, onRecover, onStart }), smelt: {
      projection: smelt({ canReviewNew: false, history: [{ requestKey: originalKey, day: '2034-12-31',
        outcome: 'held', value: '7', lines: [{ resourceId: 'shards', quantity: '7' }] }] }),
      view: null, lines: [], labels: {},
    } });
    click('OPEN BASKET FROM 2034-12-31');
    expect(onRecover).toHaveBeenCalledWith('smelt', originalKey); expect(onStart).not.toHaveBeenCalled();
    expect(text()).toContain('Your basket is held in the furnace.');
  });

  it('shows the original saved basket worth rather than an unrelated editable draft value', () => {
    render({ tab: 'SMELT', owner: owner(), smelt: { projection: smelt({ original: {
      requestKey: originalKey, day: '2034-12-31', outcome: 'held', value: '7', lines: [{ resourceId: 'shards', quantity: '7' }],
    } }), view: null, lines: [{ resourceId: 'shards', quantity: '1' }], labels: {} } });
    expect(container.querySelector('[data-basket-worth]')?.textContent).toBe('7');
  });

  it('keeps selected zero-stock or removed resources visible and allows progressive draft repair', () => {
    const onLinesChange = vi.fn(); const data = { ...contributionView(), resources: [
      { resourceId: 'shards' as const, available: '0', unitValue: '1' },
    ] };
    const lines = [{ resourceId: 'shards' as const, quantity: '2' }, { resourceId: 'forge_ingot' as const, quantity: '2' }];
    render({ tab: 'SMELT', owner: owner(), smelt: {
      projection: smelt({ resources: data.resources, canReviewNew: false }), view: data, lines,
      labels: { shards: { name: 'Shards', icon: 'shards', source: '' }, forge_ingot: { name: 'Ingots', icon: 'streak', source: '' } }, onLinesChange,
    } });
    click('Shards: remove 1');
    expect(onLinesChange).toHaveBeenLastCalledWith([{ resourceId: 'forge_ingot', quantity: '2' }, { resourceId: 'shards', quantity: '1' }]);
    click('Ingots: remove 1');
    expect(onLinesChange).toHaveBeenLastCalledWith([{ resourceId: 'shards', quantity: '2' }, { resourceId: 'forge_ingot', quantity: '1' }]);
  });

  it('labels a retained offer and refuses fresh buying until the owner supplies a current quote', () => {
    const onStart = vi.fn(); render({ tab: 'GEMS', gems: gems(), buy: { ...buy(), current: false }, owner: owner({ onStart }) });
    expect(text()).toContain('Last known offer. Check again before buying.');
    expect(button('BUY 7 GEMS').getAttribute('aria-disabled')).toBe('true');
    click('BUY 7 GEMS'); expect(onStart).not.toHaveBeenCalled();
  });

  it('honors owner resource order while retaining unlisted and removed selected resources', () => {
    const resources = [
      { resourceId: 'shards' as const, available: '3', unitValue: '1' },
      { resourceId: 'forge_ingot' as const, available: '3', unitValue: '1' },
    ];
    render({ tab: 'SMELT', owner: owner(), smelt: {
      projection: smelt({ resources }), view: { ...contributionView(), resources },
      lines: [{ resourceId: 'frost_quartz', quantity: '1' }], resourceOrder: ['forge_ingot'],
      labels: { forge_ingot: { name: 'Ingots', icon: 'streak', source: '' }, shards: { name: 'Shards', icon: 'shards', source: '' },
        frost_quartz: { name: 'Quartz', icon: 'shape:unknown', source: '' } }, onLinesChange: vi.fn(),
    } });
    expect(Array.from(container.querySelectorAll('.pk-goldforge__tile strong')).map(node => node.textContent)).toEqual(['Ingots', 'Shards', 'Quartz']);
  });

  it('shows terminal CLAIM as inert SENT while preserving original collection recovery and History', () => {
    const onRecover = vi.fn(), onHistory = vi.fn();
    render({ tab: 'CLAIM', onHistory, owner: owner({ canStart: () => false, onRecover }), claim: claim({
      stage: 'SENT', paidBaseUnits: '3000000000', paidLabel: '3', canOpenNewFlow: false,
      recovery: { available: true, requestKey: originalKey, continuationRequestKey: null, held: false, canOpen: true },
    }) });
    expect(button('SENT').disabled).toBe(true); click('OPEN SAVED COLLECTION'); click('History');
    expect(onRecover).toHaveBeenCalledWith('claim', originalKey); expect(onHistory).toHaveBeenCalledOnce();
    expect(text()).not.toContain('In your wallet now');
    render({ tab: 'CLAIM', owner: owner(), claim: claim({ stage: 'SENT', paidBaseUnits: null }) });
    expect(Array.from(container.querySelectorAll('button')).some(node => node.getAttribute('aria-label') === 'SENT')).toBe(false);
  });

  it('shows a credited purchase as inert SENT while preserving original purchase recovery', () => {
    const onRecover = vi.fn(); render({ tab: 'GEMS', owner: owner({ canStart: () => false, onRecover }), gems: gems({
      purchase: { requestKey: originalKey, keepIn: '7', quotedGems: '7', outcome: 'credited', stage: 'SENT', hydrated: false,
        receipt: { receiptId: 'receipt-one', acceptedAt: '2035-01-01T00:00:00Z', amount: '7', currency: 'GEMS' } },
    }) });
    expect(button('SENT').disabled).toBe(true); click('OPEN SAVED PURCHASE');
    expect(onRecover).toHaveBeenCalledWith('gems-purchase', originalKey);
    expect(text()).not.toContain('Added to your Gems');
  });

  it('routes the exact basket to its existing consent owner without confirming or creating a request', () => {
    const onStart = vi.fn(); const lines = [{ resourceId: 'shards' as const, quantity: '1' }];
    const data = { ...contributionView(), dailyCapValue: null, remainingValue: null, resources: [{ resourceId: 'shards' as const, available: '3', unitValue: '1' }] };
    render({ tab: 'SMELT', owner: owner({ onStart }), smelt: { projection: smelt(), view: data, lines, labels: {}, onLinesChange: vi.fn() } });
    click('SMELT. 1 item'); expect(onStart).toHaveBeenCalledWith({ kind: 'smelt', baseId: data.baseId, day: data.day, lines });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('offers LEGACY only from its admitted projection and no new primary or invented balance', () => {
    render({ tab: 'LEGACY', legacy: { visible: true, saved: null, current: true, conversionCopy: null, historySummary: null } });
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(4); expect(selected()).toContain('LEGACY');
    expect(container.querySelector('[data-legacy-saved]')?.textContent).toBe('…');
    expect(container.querySelector('.pk-frame__foot')).toBeNull(); expect(text()).not.toContain('1:1');
  });

  it('shows saved credited receipts without automatic reward, navigation or balance changes', () => {
    const onStart = vi.fn(), onRecover = vi.fn(), onTab = vi.fn();
    render({ tab: 'GEMS', onTab, owner: owner({ onStart, onRecover }), gems: gems({ purchase: {
      requestKey: originalKey, keepIn: '7', quotedGems: '7', outcome: 'credited', stage: 'SENT', hydrated: true,
      receipt: { receiptId: 'receipt-one', acceptedAt: '2035-01-01T00:00:00Z', amount: '7', currency: 'GEMS' },
    } }) });
    expect(text()).toContain('Saved receipt: 7 GEMS'); expect(text()).not.toContain('Added to your Gems');
    expect(onStart).not.toHaveBeenCalled(); expect(onRecover).not.toHaveBeenCalled(); expect(onTab).not.toHaveBeenCalled();
    expect(container.querySelector('[data-gems-balance]')?.textContent).toBe('9,007,199,254,740,993');
  });
});
