/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ForgeClaimReceipt, ForgeClaimRequest } from '@shardkeep/shared/forgeClaims';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { bus } from '../../lib/events';
import { playSfx } from '../../lib/audio';
import { haptic } from '../../lib/juice';
import { useApp, type BaseStateDto } from '../../state/store';
import { ForgeScreen } from './menu';
import { baseA, baseB, deferred, directory, identity, key, ledger, target } from '../../lib/forgeClaims/fixtures.test-support';
import { ForgeClaimJournalStore } from '../../lib/forgeClaims/journal';
import { forgeClaimIdentity } from '../../lib/forgeClaims/browser';
import { reloadCurrentBaseSnapshot } from '../../state/baseSnapshot';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false }) }));
vi.mock('../sheets', async () => ({ reloadBase: (await import('../../state/baseSnapshot')).reloadBase }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));

function baseState(baseId = baseA): BaseStateDto {
  return { baseId, player: { wallet: identity.wallet, name: 'Keeper', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null, buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1 };
}
let count: number, keep: string, statusUnavailable: boolean, enabled: boolean, supported: boolean, root: Root, host: HTMLDivElement;
let proof: ForgeClaimReceipt | null;
const forge = () => ({ day: '2026-09-09', serverNow: '2026-09-09T12:00:00Z', cycleEndsAt: '2026-09-10T00:00:00Z', cycleEndsInSec: 30_000,
  dailyEmissionKeep: 100, softCapShards: 1000, totalShards: '10', myShards: '10', myShardBalance: '1000', goldforgeLevel: 1, myDailyCapShards: '1000', drops: { independentDropBps: {} },
  claimable: { count, totalKeep: String(count * 10), days: ['2026-09-07', '2026-09-08'].slice(0, count), nextExpiresAt: null }, yesterday: null });
const allocations = () => ({ days: [{ day: '2026-09-07', shards: '10', counted: '10', keepPaid: '10', shardsRefunded: '0', itemDropped: null, settledAt: '2026-09-08', status: count ? 'claimable' : 'claimed', claimedAt: count ? null : '2026-09-09', expiresAt: null }], nextBefore: null,
  totals: { keepClaimed: count ? '0' : '20', keepClaimable: String(count * 10), keepExpired: '0', shardsBurned: '10', itemsWon: 0 } });
function result(request: ForgeClaimRequest, amount = '20', remaining = 0, empty = false): ForgeClaimReceipt {
  const days = request.day ? [request.day] : ['2026-09-07', '2026-09-08'];
  return { version: 1, actor: identity.wallet, ...request, createdAt: '2026-09-13T00:00:00.000Z', result: {
    claimed: empty ? [] : days.map((day, i) => ({ day, keep: days.length === 2 ? String(Number(amount) / 2) : amount, ledgerTransactionId: i === 0 ? ledger : baseB })), totalKeep: empty ? '0' : amount, remaining,
  } };
}
function button(label: string): HTMLButtonElement { const b = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label); if (!b) throw Error(`Missing ${label}: ${host.textContent}`); return b; }
const until = async (assertion: () => void) => act(async () => vi.waitFor(assertion));
const click = async (label: string): Promise<void> => { await act(async () => button(label).click()); };
const mount = async (): Promise<void> => { await act(async () => root.render(<ForgeScreen />)); await until(() => expect(host.textContent).not.toContain('Checking your collection…')); };
const review = async (label = 'CLAIM ALL READY · 2'): Promise<void> => { await until(() => expect(button(label).disabled).toBe(false)); await click(label); await until(() => expect(button('CONFIRM CLAIM').disabled).toBe(false)); };
const claim = async (): Promise<void> => { await review(); await click('CONFIRM CLAIM'); await until(() => expect(api.postRaw).toHaveBeenCalledOnce()); };
const saved = () => new ForgeClaimJournalStore(forgeClaimIdentity(identity.wallet)).read();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, action) => action({})) } });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(key); vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  count = 2; keep = '20'; statusUnavailable = false; enabled = true; supported = true; proof = null;
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(baseA); useApp.getState().setBase(baseState());
  useApp.getState().setBalances({ shards: '1000', keep, keepRate: 1 }); useApp.getState().setScreen('forge');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path.startsWith('/forge/claims/v1/')) {
      if (!supported) throw new ApiError(404, 'Unavailable'); if (statusUnavailable) throw Error('Receipt read unavailable');
      return { version: 1, wallet: useApp.getState().wallet, idempotencyKey: path.split('/').at(-1), enabled, receipt: proof };
    }
    if (path === '/me') return { wallet: useApp.getState().wallet, entryPaid: useApp.getState().entryPaid };
    if (path === '/bases') return useApp.getState().entryPaid ? directory() : { ...directory(), bases: [] };
    if (path.startsWith('/forge/allocations')) return allocations(); if (path.startsWith('/forge')) return forge();
    if (path.startsWith('/base?')) return baseState(new URL(path, 'https://fixture.invalid').searchParams.get('baseId')!);
    if (path.startsWith('/balances')) return { shards: '1000', keep, keepRate: 1 };
    throw Error(`Unexpected ${path}`);
  });
  vi.spyOn(api, 'post').mockRejectedValue(new Error('Legacy claim POST must never run'));
  vi.spyOn(api, 'postRaw').mockImplementation(async (_path, body) => { count = 0; keep = '40'; proof = result(body as ForgeClaimRequest); return proof; });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });

// The original eight cases remain. Their direct legacy POST expectations are deliberately
// replaced by explicit v1 review and immutable-key proof, not current-total reconciliation.
it('makes the existing batch claim available on Deploy and My ledger and shows only its actual receipt', async () => {
  await mount(); expect(button('CLAIM ALL READY · 2')).toBeDefined(); await click('MY LEDGER'); await review(); expect(api.postRaw).not.toHaveBeenCalled();
  await click('CONFIRM CLAIM'); await until(() => expect(host.textContent).toContain('+20 KEEP'));
  expect(api.postRaw).toHaveBeenCalledWith('/forge/claims/v1', { idempotencyKey: key, baseId: baseA, day: null }, expect.objectContaining({ isCurrent: expect.any(Function) }));
  await until(() => expect(useApp.getState().balances?.keep).toBe('40')); expect(api.post).not.toHaveBeenCalled();
  expect(vi.mocked(playSfx).mock.calls.filter(([id]) => id === 'sfx_confirm')).toHaveLength(1); expect(haptic).toHaveBeenCalledWith('light');
  await until(() => expect(host.textContent).toContain('CLAIMED')); expect(api.get).toHaveBeenCalledWith(`/forge/allocations?baseId=${baseA}`);
});
it('keeps exact credited amounts prominent and technical records inside collapsed accessible claim details', async () => {
  vi.mocked(api.postRaw).mockImplementation(async (_path, body) => {
    count = 0; proof = { ...result(body as ForgeClaimRequest), result: {
      totalKeep: '9007199254740993', remaining: 0,
      claimed: [{ day: '2026-09-07', keep: '9007199254740993', ledgerTransactionId: ledger }],
    } }; return proof;
  });
  const compactPanel = (): { details: HTMLDetailsElement; visible: string } => {
    const panel = host.querySelector<HTMLElement>('[aria-label="Forge claim recovery"]')!;
    const details = panel.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Claim details');
    const compact = panel.cloneNode(true) as HTMLElement;
    compact.querySelector('details')!.remove();
    const visible = compact.textContent!;
    for (const value of [identity.wallet, baseA, key, ledger]) expect(visible).not.toContain(value);
    return { details, visible };
  };
  await mount(); await review();
  const reviewPanel = compactPanel();
  expect(reviewPanel.details.textContent).toContain(identity.wallet);
  expect(reviewPanel.details.textContent).toContain(baseA);
  expect(api.postRaw).not.toHaveBeenCalled();
  // Expanding review metadata must not leave the receipt expanded after consent.
  reviewPanel.details.open = true;
  await click('CONFIRM CLAIM');
  await until(() => expect(host.textContent).toContain('+9,007,199,254,740,993 KEEP'));
  const receiptPanel = compactPanel();
  expect(receiptPanel.visible).toContain('Added to your game wallet');
  expect(receiptPanel.details.textContent).toContain(ledger);
  expect(receiptPanel.details.textContent).toContain('0 allocations remained when this receipt was recorded.');
  await until(() => expect(button('CHECK ORIGINAL RECEIPT').disabled).toBe(false));
  await click('CHECK ORIGINAL RECEIPT');
  await until(() => expect(button('CHECK ORIGINAL RECEIPT').disabled).toBe(false));
  expect(api.postRaw).toHaveBeenCalledOnce(); expect(api.post).not.toHaveBeenCalled();
});
it('uses one synchronous guard for same-frame batch and individual clicks', async () => {
  let resolve!: (value: unknown) => void; vi.mocked(api.postRaw).mockImplementation(() => new Promise(r => { resolve = r; }));
  await mount(); await click('MY LEDGER'); await until(() => expect(button('CLAIM ALL READY · 2').disabled).toBe(false));
  const all = button('CLAIM ALL READY · 2'), single = button('CLAIM'); await act(async () => { all.click(); all.click(); single.click(); });
  await until(() => expect(button('CONFIRM CLAIM').disabled).toBe(false)); expect(api.postRaw).not.toHaveBeenCalled();
  await act(async () => { button('CONFIRM CLAIM').click(); button('CONFIRM CLAIM').click(); }); await until(() => expect(api.postRaw).toHaveBeenCalledOnce());
  await act(async () => { proof = result(vi.mocked(api.postRaw).mock.calls[0]![1] as ForgeClaimRequest, '0', 0, true); resolve(proof); });
  await until(() => expect(host.textContent).toContain('This completed request paid zero')); expect(api.postRaw).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('+0 KEEP');
  expect(host.textContent).toContain('Nothing was ready for this collection.');
  expect(host.textContent).not.toContain('Added to your game wallet');
});
it('retains explicit individual-day claiming through the same handler', async () => {
  await mount(); await click('MY LEDGER'); await review('CLAIM'); await click('CONFIRM CLAIM'); await until(() => expect(api.postRaw).toHaveBeenCalledOnce());
  expect(api.postRaw).toHaveBeenCalledWith('/forge/claims/v1', { idempotencyKey: key, day: '2026-09-07', baseId: baseA }, expect.objectContaining({ isCurrent: expect.any(Function) }));
});
it('reports remaining cycles from a bounded server batch without automatically claiming again', async () => {
  vi.mocked(api.postRaw).mockImplementation(async (_path, body) => { count = 1; proof = { ...result(body as ForgeClaimRequest, '0'), result: { claimed: [{ day: '2026-09-07', keep: '7', ledgerTransactionId: ledger }], totalKeep: '7', remaining: 1 } }; return proof; });
  await mount(); await claim(); await until(() => expect(host.textContent).toContain('+7 KEEP'));
  expect(host.querySelector('[aria-label="Forge claim recovery"] details')?.textContent).toContain('1 allocations remained when this receipt was recorded.');
  // The receipt is published before destination hydration. Only hydrated
  // recovery triggers the separate Forge-count refresh effect.
  await until(() => expect(button('FINISH REVIEW').disabled).toBe(false));
  await until(() => expect(button('CLAIM ALL READY · 1').disabled).toBe(true)); await click('FINISH REVIEW');
  await until(() => expect(button('CLAIM ALL READY · 1').disabled).toBe(false)); expect(api.postRaw).toHaveBeenCalledOnce();
});
it('shows a failed new confirmation truthfully when an older finished collection receipt remains saved', async () => {
  vi.mocked(api.postRaw).mockImplementation(async (_path, body) => {
    count = 1; proof = result(body as ForgeClaimRequest, '20', 1); return proof;
  });
  await mount(); await claim();
  await until(() => expect(button('FINISH REVIEW').disabled).toBe(false));
  await click('FINISH REVIEW');
  await until(() => expect(button('CLAIM ALL READY · 1').disabled).toBe(false));
  const original = await saved();
  expect(original.finished).toBe(true);
  vi.mocked(crypto.randomUUID).mockReturnValue(baseB);
  await review('CLAIM ALL READY · 1');
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(path => path === '/bases'
    ? Promise.resolve({ ...directory(), bases: [] }) as ReturnType<typeof api.get> : read(path));
  await click('CONFIRM CLAIM');
  const reason = 'The original allocation deed is unavailable. Keep the saved claim.';
  await until(() => expect(host.textContent).toContain(reason));
  const panel = host.querySelector('[aria-label="Forge claim recovery"]')!.cloneNode(true) as HTMLElement;
  panel.querySelector('details')!.remove();
  expect(panel.textContent).toContain(reason);
  expect(panel.textContent).toContain('+20 KEEP');
  expect(panel.textContent).not.toContain('REVIEW FORGE CLAIM');
  expect(panel.textContent).not.toContain('The latest refresh could not finish');
  expect(await saved()).toEqual(original);
  expect(api.postRaw).toHaveBeenCalledOnce(); expect(api.post).not.toHaveBeenCalled();
});
it('reconciles a lost response after commit without reposting or claiming an invented receipt', async () => {
  vi.mocked(api.postRaw).mockImplementation(async (_path, body) => { count = 0; keep = '40'; proof = result(body as ForgeClaimRequest); throw Error('Response lost'); });
  await mount(); await claim(); await until(() => expect(host.textContent).toContain('Response lost')); expect(host.textContent).not.toContain('+20 KEEP'); expect(useApp.getState().balances?.keep).toBe('20');
  await click('CHECK ORIGINAL RECEIPT'); await until(() => expect(host.textContent).toContain('+20 KEEP')); expect(api.postRaw).toHaveBeenCalledOnce(); await until(() => expect(useApp.getState().balances?.keep).toBe('40'));
});
it('keeps a confirmed payout in the HUD when a pre-claim same-deed balance read arrives late', async () => {
  const oldBalance = deferred<{ shards: string; keep: string; keepRate: number }>();
  const read = vi.mocked(api.get).getMockImplementation()!;
  let delayNextBalance = true;
  vi.mocked(api.get).mockImplementation(path => {
    if (path.startsWith('/balances') && delayNextBalance) { delayNextBalance = false; return oldBalance.promise as ReturnType<typeof api.get>; }
    return read(path);
  });
  const oldSnapshot = reloadCurrentBaseSnapshot();
  await until(() => expect(delayNextBalance).toBe(false));
  try {
    await mount(); await claim();
    await until(() => expect(useApp.getState().balances?.keep).toBe('40'));
    await act(async () => { oldBalance.resolve({ shards: '1000', keep: '20', keepRate: 1 }); await oldSnapshot; });
    expect(useApp.getState().balances?.keep).toBe('40');
    expect((await saved()).receipt).toEqual(proof);
    expect(host.textContent).toContain('+20 KEEP');
    expect(api.postRaw).toHaveBeenCalledOnce();
  } finally { oldBalance.resolve({ shards: '1000', keep: '20', keepRate: 1 }); await oldSnapshot; }
});
it('does not reopen stale batch or day claims while post-claim availability refreshes are pending', async () => {
  const overview = deferred<ReturnType<typeof forge>>(), history = deferred<ReturnType<typeof allocations>>();
  const read = vi.mocked(api.get).getMockImplementation()!;
  let overviewStarted = false, historyStarted = false;
  vi.mocked(api.get).mockImplementation(path => {
    if (proof && path.startsWith('/forge/allocations')) { historyStarted = true; return history.promise as ReturnType<typeof api.get>; }
    if (proof && path.startsWith('/forge?')) { overviewStarted = true; return overview.promise as ReturnType<typeof api.get>; }
    return read(path);
  });
  try {
    await mount(); await click('MY LEDGER'); await claim();
    await until(() => expect(button('FINISH REVIEW').disabled).toBe(false));
    await until(() => { expect(overviewStarted).toBe(true); expect(historyStarted).toBe(true); });
    await click('FINISH REVIEW'); await until(() => expect(host.textContent).toContain('Review finished'));
    // Finishing the receipt is not proof that the old overview/ledger is current.
    expect(button('CLAIM ALL READY · 2').disabled).toBe(true);
    expect(button('CLAIM').disabled).toBe(true);
    await act(async () => overview.resolve(forge()));
    expect(button('CLAIM ALL READY · 2').disabled).toBe(true);
    expect(button('CLAIM').disabled).toBe(true);
    await act(async () => history.resolve(allocations()));
    await until(() => expect(host.querySelector('.sk-forge-claim')).toBeNull());
    expect([...host.querySelectorAll('button')].some(b => b.textContent?.trim() === 'CLAIM')).toBe(false);
    expect(api.postRaw).toHaveBeenCalledOnce();
  } finally { await act(async () => { overview.resolve(forge()); history.resolve(allocations()); }); }
});
it.each(['overview', 'ledger'] as const)('keeps receipt success and stale claim controls blocked after a failed %s refresh until GET-only retry succeeds', async failure => {
  const read = vi.mocked(api.get).getMockImplementation()!;
  let unavailable = true;
  vi.mocked(api.get).mockImplementation(path => {
    const failedPath = failure === 'overview' ? path.startsWith('/forge?') : path.startsWith('/forge/allocations');
    if (proof && unavailable && failedPath) return Promise.reject(Error('Availability read unavailable'));
    return read(path);
  });
  await mount(); await click('MY LEDGER'); await claim();
  await until(() => expect(host.textContent).toContain('Your claim is confirmed. Forge availability could not refresh.'));
  expect(host.textContent).toContain('+20 KEEP');
  expect(useApp.getState().balances?.keep).toBe('40');
  await click('FINISH REVIEW'); await until(() => expect(host.textContent).toContain('Review finished'));
  expect(button('CLAIM ALL READY · 2').disabled).toBe(true); expect(button('CLAIM').disabled).toBe(true);
  await act(async () => { button('CLAIM ALL READY · 2').click(); button('CLAIM').click(); });
  expect(api.postRaw).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('REVIEW FORGE CLAIM');
  unavailable = false; await click('REFRESH FORGE');
  await until(() => expect(host.querySelector('.sk-forge-claim')).toBeNull());
  expect([...host.querySelectorAll('button')].some(b => b.textContent?.trim() === 'CLAIM')).toBe(false);
  expect(host.textContent).not.toContain('Forge availability could not refresh.');
  expect((await saved()).receipt).toEqual(proof); expect(api.postRaw).toHaveBeenCalledOnce(); expect(api.post).not.toHaveBeenCalled();
});
it('ignores a pre-claim ledger page arriving after the fresh claimed first page', async () => {
  const oldPage = deferred<ReturnType<typeof allocations>>();
  const read = vi.mocked(api.get).getMockImplementation()!;
  let pageStarted = false;
  vi.mocked(api.get).mockImplementation(path => {
    if (path.startsWith('/forge/allocations') && path.includes('before=')) { pageStarted = true; return oldPage.promise as ReturnType<typeof api.get>; }
    if (!proof && path.startsWith('/forge/allocations')) return Promise.resolve({ ...allocations(), nextBefore: '2026-09-07' }) as ReturnType<typeof api.get>;
    return read(path);
  });
  const stale = allocations(); stale.days[0]!.day = '2026-09-06';
  try {
    await mount(); await click('MY LEDGER'); await until(() => expect(button('LOAD MORE').disabled).toBe(false));
    await click('LOAD MORE'); expect(pageStarted).toBe(true); await claim();
    await until(() => expect(button('FINISH REVIEW').disabled).toBe(false));
    await until(() => expect(host.querySelector('.sk-forge-claim')).toBeNull());
    await click('FINISH REVIEW'); await until(() => expect(host.textContent).toContain('Review finished'));
    await act(async () => oldPage.resolve(stale));
    expect(host.textContent).not.toContain('2026-09-06');
    expect([...host.querySelectorAll('button')].some(b => b.textContent?.trim() === 'CLAIM')).toBe(false);
    expect(api.postRaw).toHaveBeenCalledOnce();
  } finally { await act(async () => oldPage.resolve(stale)); }
});
it('retains a successful receipt across failed balance refresh and reopening, recovering with reads only', async () => {
  const read = vi.mocked(api.get).getMockImplementation()!;
  let balanceUnavailable = true;
  vi.mocked(api.get).mockImplementation(path => {
    if (proof && balanceUnavailable && path.startsWith('/balances')) return Promise.reject(Error('Balance refresh unavailable'));
    return read(path);
  });
  await mount(); await claim();
  await until(() => expect(host.textContent).toContain('Balance refresh unavailable'));
  const original = await saved();
  expect(original.receipt).toEqual(proof); expect(original.hydrated).toBeNull(); expect(original.finished).toBe(false);
  expect(host.textContent).toContain('+20 KEEP');
  expect(host.textContent).toContain('Collection confirmed.');
  const panel = host.querySelector('[aria-label="Forge claim recovery"]')!.cloneNode(true) as HTMLElement;
  panel.querySelector('details')!.remove();
  expect(panel.textContent).toContain('Balance refresh unavailable');
  expect(host.textContent).toContain('Added to your game wallet');
  expect(host.textContent).not.toContain('Your collection is saved. Check its outcome before collecting again.');
  expect(button('FINISH REVIEW').disabled).toBe(true); expect(button('CLAIM ALL READY · 2').disabled).toBe(true);
  expect([...host.querySelectorAll('button')].some(b => b.textContent?.trim() === 'RETRY ORIGINAL CLAIM')).toBe(false);
  expect(useApp.getState().balances?.keep).toBe('20');
  await act(async () => root.unmount()); root = createRoot(host); await mount();
  await until(() => expect(button('CHECK ORIGINAL RECEIPT').disabled).toBe(false));
  expect(host.textContent).toContain('+20 KEEP');
  balanceUnavailable = false; await click('CHECK ORIGINAL RECEIPT');
  await until(() => expect(button('FINISH REVIEW').disabled).toBe(false));
  expect(useApp.getState().balances?.keep).toBe('40'); expect((await saved()).receipt).toEqual(original.receipt);
  await click('FINISH REVIEW'); await until(() => expect(host.textContent).toContain('Review finished'));
  expect(api.postRaw).toHaveBeenCalledOnce(); expect(api.post).not.toHaveBeenCalled();
  expect(vi.mocked(playSfx).mock.calls.filter(([id]) => id === 'sfx_confirm')).toHaveLength(1);
});
it('requires exact receipt recovery before another claim when reconciliation is unavailable', async () => {
  vi.mocked(api.postRaw).mockImplementation(async () => { statusUnavailable = true; throw Error('Response lost'); });
  await mount(); await claim(); await until(() => expect(button('CHECK ORIGINAL RECEIPT').disabled).toBe(false)); await click('CHECK ORIGINAL RECEIPT');
  await until(() => expect(host.textContent).toContain('Receipt read unavailable')); statusUnavailable = false; await click('CHECK ORIGINAL RECEIPT');
  await until(() => expect(button('RETRY ORIGINAL CLAIM').disabled).toBe(false)); expect(button('CLAIM ALL READY · 2').disabled).toBe(true); expect(api.postRaw).toHaveBeenCalledOnce(); expect((await saved()).receipt).toBeNull();
});
it.each(['base', 'account'] as const)('fences an old claim receipt after a %s change', async change => {
  let resolve!: (value: unknown) => void; vi.mocked(api.postRaw).mockImplementation(() => new Promise(r => { resolve = r; }));
  const toasts: string[] = []; const off = bus.on('ui:toast', event => toasts.push(event.msg));
  try {
    await mount(); await claim(); const body = vi.mocked(api.postRaw).mock.calls[0]![1] as ForgeClaimRequest;
    await act(async () => { if (change === 'base') useApp.getState().setSelectedBaseId(baseB); else useApp.getState().setAuth(target, true); });
    expect(() => vi.mocked(api.postRaw).mock.calls[0]![2]!.isCurrent!()).toThrow(); await act(async () => resolve(result(body)));
    await until(() => expect(toasts).toEqual([])); expect(host.textContent).not.toContain('+20 KEEP'); expect((await saved()).intent?.request).toEqual(body); expect((await saved()).receipt).toBeNull(); expect(vi.mocked(playSfx).mock.calls.filter(([id]) => id === 'sfx_confirm')).toHaveLength(0);
  } finally { off(); }
});
it('Back and unsupported v1 never trigger a legacy fallback', async () => {
  await mount(); await review(); await click('BACK'); expect((await saved()).intent).toBeNull(); expect(api.postRaw).not.toHaveBeenCalled();
  supported = false; await click('CHECK ORIGINAL RECEIPT'); await until(() => expect(host.textContent).toContain('Claims stay read-only')); expect(button('CLAIM ALL READY · 2').disabled).toBe(true); expect(api.post).not.toHaveBeenCalled();
});
it('historical receipt remains visible before land gate and Finish survives Close and reopen', async () => {
  vi.mocked(api.postRaw).mockImplementation(async (_path, body) => { proof = result(body as ForgeClaimRequest); throw Error('lost'); });
  await mount(); await claim(); await until(() => expect(host.textContent).toContain('lost'));
  await act(async () => useApp.getState().setEntryPaid(false)); await click('CHECK ORIGINAL RECEIPT'); await until(() => expect(host.textContent).toContain('balance is unavailable through the original allocation scope'));
  await click('FINISH REVIEW'); await until(() => expect(host.textContent).toContain('Review finished')); await act(async () => root.unmount()); root = createRoot(host); await mount();
  await until(() => expect(host.textContent).toContain('Review finished')); expect((await saved()).finished).toBe(true); expect(api.postRaw).toHaveBeenCalledOnce(); expect(api.get).not.toHaveBeenCalledWith('/wallet/balances');
});
it('Forge kill switch keeps new buttons disabled without hiding the screen or contributions', async () => {
  enabled = false; await mount(); expect(button('CLAIM ALL READY · 2').disabled).toBe(true); expect(host.textContent).toContain('New Forge claims are paused'); expect(host.textContent).toContain('DEPLOY SHARDS'); expect(api.postRaw).not.toHaveBeenCalled();
});
