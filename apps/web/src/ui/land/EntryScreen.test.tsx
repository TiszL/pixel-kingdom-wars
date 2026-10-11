/** @vitest-environment happy-dom */
/**
 * CLAIM YOUR LAND — the one-job land screen (M35 lane D, D-103).
 *
 * WHY these pins: the owner replaced a wall of text with a screen whose rail
 * and parcel card must say exactly where the money is; the three contexts
 * (paywall, base without land, another keep) must keep their distinct exits;
 * EXIT preserves the submitted payment while leaving checkout; sign-out still
 * requires confirmation; and the funnel events are the only
 * client-side record of where a purchase stalled.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryPhase, LandReservation } from '../../auth/useEntry';
import type { FaucetStatus } from '../../auth/useDevnetFaucet';

const h = vi.hoisted(() => ({
  entryState: { busy: false, error: null as string | null },
  feeEstimate: null as null | { requiredLamports: number; accountRentLamports: number },
  track: vi.fn(),
  reserve: vi.fn(),
  submit: vi.fn(),
  signOut: vi.fn(),
  isEmbedded: false,
  retryPayment: vi.fn(),
  canRetryEntry: false,
  retryEntryInSec: null as number | null,
  reservationRetryInSec: null as number | null,
  flow: { phase: 'idle' as EntryPhase, error: null as string | null, reservation: null as LandReservation | null },
  onDone: null as null | ((r: LandReservation) => void),
  faucet: { phase: 'idle' as const, status: null as FaucetStatus | null, claim: vi.fn(), refresh: vi.fn() },
  rpcSol: null as number | null,
  claimable: null as null | { claimable: boolean; deedAssetId: string | null; reason: string },
}));

vi.mock('../../lib/analytics', async (orig) => ({ ...(await orig<typeof import('../../lib/analytics')>()), track: h.track }));
vi.mock('../../auth/useEntry', () => ({
  usePayEntry: (_kind: string, onDone: (r: LandReservation) => void) => {
    h.onDone = onDone;
    return { reserve: h.reserve, submit: h.submit, retryPayment: h.retryPayment, canRetryEntry: h.canRetryEntry, retryEntryInSec: h.retryEntryInSec, reservationRetryInSec: h.reservationRetryInSec, isEmbedded: h.isEmbedded, ...h.flow };
  },
}));
vi.mock('../../auth/gameEntry', () => ({ useGameEntryState: () => h.entryState }));
vi.mock('../../auth/useLandFunding', () => ({ useLandFunding: () => ({ estimate: h.feeEstimate, unavailable: false, refresh: vi.fn() }) }));
vi.mock('../../auth/useSignOut', () => ({ useSignOut: () => h.signOut }));
vi.mock('../../auth/useDevnetFaucet', () => ({ useDevnetFaucet: () => h.faucet }));
vi.mock('../useSolBalance', () => ({ useSolBalance: () => h.rpcSol }));
vi.mock('../useFetch', () => ({ useFetch: () => ({ data: h.claimable, reload: vi.fn() }) }));

import { bus } from '../../lib/events';
import { LAND_UNLOCKS } from '../../state/land';
import { useApp, type BaseStateDto } from '../../state/store';
import { EntryScreen } from './EntryScreen';

const WALLET = 'LaNd1111111111111111111111111111111111111111';
const RES: LandReservation = {
  id: 'd1', reference: 'ref', kind: 'entry', baseId: 'b1', earthCell: 4321, amountLamports: 200_000_000,
  countryA3: 'GEO', countryName: 'Georgia',
};

function base(): BaseStateDto {
  return {
    baseId: 'base-land',
    player: { wallet: WALLET, name: 'Keeper', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
  };
}

let root: Root | null = null;
let host: HTMLElement;
const enterGame = vi.fn(async () => ({ ok: true }));
const FaucetControl = ({ wallet }: { wallet: string }): React.JSX.Element => (
  <div data-testid="faucet-control">FAUCET FOR {wallet.slice(0, 4)}</div>
);
let faucetView: () => string | null = () => null;

async function render(): Promise<void> {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<EntryScreen enterGame={enterGame} FaucetControl={FaucetControl} faucetView={() => faucetView()} />);
  });
}
const button = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const tap = (el: Element): Promise<void> => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
const activeStage = (): string | null => host.querySelector('[aria-current="step"]')?.getAttribute('data-stage') ?? null;
const parcelKind = (): string | null => host.querySelector('[data-parcel]')?.getAttribute('data-parcel') ?? null;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.track.mockReset(); h.reserve.mockReset(); h.submit.mockReset(); h.signOut.mockReset();
  h.flow = { phase: 'idle', error: null, reservation: null };
  h.faucet.status = null;
  h.isEmbedded = false; h.canRetryEntry = false; h.retryEntryInSec = null; h.reservationRetryInSec = null; h.retryPayment.mockReset();
  h.rpcSol = null; h.feeEstimate = null; h.entryState = { busy: false, error: null };
  h.claimable = null;
  faucetView = () => null;
  enterGame.mockClear();
  useApp.getState().setAuth(WALLET);
  useApp.setState({ screen: 'entry', mapTab: 'world', landPurchase: null, base: null });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  useApp.getState().setAuth(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the three contexts', () => {
  it('paywall (no base): CLAIM YOUR LAND, the unlock tiles, both pick actions, no BACK, no cell input', async () => {
    await render();
    expect(host.textContent).toContain('CLAIM YOUR LAND');
    for (const u of LAND_UNLOCKS) expect(host.textContent).toContain(u.title);
    expect(button('CHOOSE YOUR LAND ON THE GLOBE')).toBeTruthy();
    expect(button('SECURE A RANDOM CELL')).toBeTruthy();
    expect(button('BACK TO')).toBeUndefined();
    expect(button('SIGN OUT / SWITCH ACCOUNT')).toBeTruthy();
    expect(activeStage()).toBe('pick');
    expect(parcelKind()).toBe('empty');
    expect(host.textContent).toContain('NO PARCEL YET');
    // The typed-cell path is gone: the globe drafts a cell, or the server picks one.
    expect(host.querySelector('input')).toBeNull();
  });

  it('base without land: the same one job plus BACK TO BASE, which preserves the chosen land and refreshes the base', async () => {
    useApp.setState({ base: base(), landPurchase: { kind: 'entry', earthCell: 55 } });
    const refreshed = vi.fn();
    const off = bus.on('base:refresh', refreshed);
    await render();
    expect(host.textContent).toContain('CLAIM YOUR LAND');
    expect(host.textContent).toContain(LAND_UNLOCKS[0]!.title);
    await tap(button('BACK TO BASE')!);
    expect(useApp.getState()).toMatchObject({ screen: 'base', landPurchase: { kind: 'entry', earthCell: 55 } });
    expect(refreshed).toHaveBeenCalledOnce();
    off();
  });

  it('another keep: FOUND ANOTHER KEEP, no unlock pitch, BACK TO YOUR BASES', async () => {
    useApp.setState({ base: base(), landPurchase: { kind: 'deed', earthCell: null } });
    await render();
    expect(host.textContent).toContain('FOUND ANOTHER KEEP');
    expect(host.textContent).not.toContain('CLAIM YOUR LAND');
    expect(host.textContent).not.toContain(LAND_UNLOCKS[1]!.title);
    await tap(button('BACK TO YOUR BASES')!);
    expect(useApp.getState().screen).toBe('bases');
  });
});

describe('pick and reserve', () => {
  it('names and submits the exact fantasy tile instead of stringifying its address', async () => {
    vi.stubEnv('VITE_FEATURE_FANTASY_WORLD', '1');
    const address = { kind: 'fantasy' as const, worldId: 'fantasy-v1' as const, tileId: 96892 };
    useApp.setState({ landPurchase: { kind: 'entry', earthCell: null, landAddress: address } });
    await render();
    expect(parcelKind()).toBe('fantasy-drafted');
    expect(host.textContent).not.toMatch(/Earth|EARTH|\[object Object\]/);
    await tap(button('RESERVE TILE 96892')!);
    expect(h.reserve).toHaveBeenCalledWith(address);
    expect(button('SECURE A RANDOM TILE')).toBeTruthy();
  });

  it('ignores an unreserved old Earth draft after cutover while restoring issued reservations unchanged', async () => {
    vi.stubEnv('VITE_FEATURE_FANTASY_WORLD', '1');
    useApp.setState({ landPurchase: { kind: 'entry', earthCell: 777 } });
    await render();
    expect(parcelKind()).toBe('empty');
    expect(button('RESERVE CELL 777')).toBeUndefined();
    expect(h.reserve).not.toHaveBeenCalled();
    h.flow = { phase: 'ready', error: null, reservation: RES };
    await render();
    expect(parcelKind()).toBe('reserved');
    expect(host.textContent).toContain('Georgia');
    expect(host.textContent).toContain('CELL 4321');
  });

  it('a drafted globe cell lights RESERVE, shows CELL n, and RESERVE CELL n reserves that exact cell', async () => {
    useApp.setState({ landPurchase: { kind: 'entry', earthCell: 777 } });
    await render();
    expect(activeStage()).toBe('reserve');
    expect(parcelKind()).toBe('drafted');
    expect(host.textContent).toContain('CELL 777');
    await tap(button('RESERVE CELL 777')!);
    expect(h.reserve).toHaveBeenCalledWith(777);
    expect(h.track).toHaveBeenCalledWith('land_reserve', { kind: 'entry', mode: 'globe' });
    // The globe stays one tap away for a change of mind.
    await tap(button('PICK A DIFFERENT SPOT')!);
    // …in choose-land mode, so World v2's hint says what the visit is for (D-186).
    expect(useApp.getState()).toMatchObject({ screen: 'map', mapTab: 'world', worldIntent: 'choose-land' });
  });

  it('SECURE A RANDOM CELL asks the server for any cell and records the random mode', async () => {
    await render();
    await tap(button('SECURE A RANDOM CELL')!);
    expect(h.reserve).toHaveBeenCalledWith();
    expect(h.track).toHaveBeenCalledWith('land_reserve', { kind: 'entry', mode: 'random' });
  });
});

describe('the parcel card and PAY', () => {
  it('shows the reserved land as land — country, cell, sovereign, frozen price — before the wallet prompt', async () => {
    h.flow = { phase: 'ready', error: null, reservation: RES };
    await render();
    expect(activeStage()).toBe('pay');
    expect(parcelKind()).toBe('reserved');
    expect(host.textContent).toContain('Georgia');
    expect(host.textContent).toContain('CELL 4321 · SOVEREIGN LAND');
    expect(host.textContent).toContain('0.20 SOL · FROZEN');
    expect(host.textContent).toContain('FROZEN BEFORE WALLET APPROVAL');
    // No pick controls once a cell is frozen.
    expect(button('CHOOSE YOUR LAND ON THE GLOBE')).toBeUndefined();
    await tap(button('PAY 0.20 SOL')!);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.track).toHaveBeenCalledWith('land_pay', { kind: 'entry' });
  });

  it('falls back to the frozen code when an older API sent no country name', async () => {
    h.flow = { phase: 'ready', error: null, reservation: { ...RES, countryName: null } };
    await render();
    expect(host.textContent).toContain('GEO');
    expect(host.textContent).toContain('CELL 4321');
  });
});

describe('leave checkout without cancelling payment', () => {
  it('keeps EXIT and BACK available while paying or confirming, preserving sign-out confirmation', async () => {
    useApp.setState({ base: base() });
    h.flow = { phase: 'paying', error: null, reservation: RES };
    await render();
    expect(button('BACK TO BASE')).toBeTruthy();
    expect(button('EXIT')).toBeTruthy();
    expect(button('SIGN OUT')).toBeUndefined();
    expect(button('CONFIRM IN WALLET…')?.disabled).toBe(true);

    h.flow = { phase: 'confirming', error: null, reservation: RES };
    await render();
    expect(activeStage()).toBe('pay');
    expect(host.textContent).toContain('CONFIRMING ON-CHAIN');
    expect(host.textContent).toContain('CHECKING YOUR PAYMENT ON DEVNET');
    expect(button('BACK TO BASE')).toBeTruthy();
    expect(button('EXIT')).toBeTruthy();
    expect(button('SIGN OUT')).toBeUndefined();

    h.flow = { phase: 'ready', error: null, reservation: RES };
    await render();
    expect(button('BACK TO BASE')).toBeTruthy();
    expect(button('SIGN OUT / SWITCH ACCOUNT')).toBeTruthy();
  });
});

describe('funnel events from the hook state', () => {
  it('confirming → failed is land_failed, with the failure copy kept on screen', async () => {
    h.flow = { phase: 'confirming', error: null, reservation: RES };
    await render();
    h.flow = { phase: 'failed', error: 'payment was seen but land could not be granted — email support', reservation: RES };
    await render();
    expect(h.track).toHaveBeenCalledWith('land_failed', { kind: 'entry' });
    expect(host.textContent).toContain('payment was seen but land could not be granted');
    expect(button('PAY 0.20 SOL')).toBeUndefined();
  });

  it('confirming → idle with the reservation cleared is land_expired, and the player is back at PICK', async () => {
    h.flow = { phase: 'confirming', error: null, reservation: RES };
    await render();
    h.flow = { phase: 'idle', error: 'payment intent expired — reserve a cell again', reservation: null };
    await render();
    expect(h.track).toHaveBeenCalledWith('land_expired', { kind: 'entry' });
    expect(host.textContent).toContain('payment intent expired');
    expect(activeStage()).toBe('pick');
    expect(button('CHOOSE YOUR LAND ON THE GLOBE')).toBeTruthy();
  });

  it('a credit shows pending minting and permits play without fabricating a ready deed', async () => {
    h.flow = { phase: 'idle', error: null, reservation: RES };
    await render();
    await act(async () => { h.onDone!(RES); });
    expect(h.track).toHaveBeenCalledWith('land_credited', { kind: 'entry' });
    expect(activeStage()).toBe('minting');
    expect(parcelKind()).toBe('paid');
    expect(host.textContent).toContain('PAYMENT CONFIRMED · DEED MINTING');
    expect(host.querySelector('img[alt="Your Land Deed"]')).toBeNull();
    expect(host.textContent).toContain('YOU CAN PLAY');
  });
});

describe('funding chip', () => {
  const status = (over: Partial<FaucetStatus>): FaucetStatus => ({
    enabled: true, eligible: true, reason: 'ok', balanceSol: null, grantSol: 0.5, grantedSol: 0,
    lifetimeCapSol: 3, minBalanceSol: 0.25, cooldownHours: 6, nextEligibleAt: null, last: null, ...over,
  });

  it('shows the server balance until the client RPC read answers, then the live read', async () => {
    h.faucet.status = status({ balanceSol: 0.75 });
    await render();
    expect(host.textContent).toContain('0.7500 SOL');
    h.rpcSol = 1.5;
    await render();
    expect(host.textContent).toContain('1.5000 SOL');
    expect(host.textContent).not.toContain('NEEDS');
  });

  it('offers the faucet control only while under-funded, and TAP TO COPY copies the full address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const toasts: string[] = [];
    const off = bus.on('ui:toast', (t) => toasts.push(t.msg));
    faucetView = () => 'claim';
    h.rpcSol = 0.01;
    await render();
    expect(host.querySelector('[data-testid="faucet-control"]')).toBeTruthy();
    expect(host.textContent).toContain('NEEDS 0.2 SOL');
    expect(host.textContent).toContain('LaNd…1111 · TAP TO COPY');
    await tap(button('TAP TO COPY')!);
    expect(writeText).toHaveBeenCalledWith(WALLET);
    expect(host.textContent).toContain(`${WALLET} · TAP TO COPY`);
    await act(async () => { await Promise.resolve(); });
    expect(toasts).toContain('ADDRESS COPIED');

    h.rpcSol = 1;
    await render();
    expect(host.querySelector('[data-testid="faucet-control"]')).toBeNull();
    off();
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});


describe('onboarding payment recovery', () => {
  it('uses the reserved payment plus estimated fees for the funding gate', async () => {
    h.flow = { phase: 'ready', error: null, reservation: RES };
    h.rpcSol = 0.2;
    h.feeEstimate = { requiredLamports: 201_250_840, accountRentLamports: 1_245_840 };
    await render();
    expect(button('PAY 0.20')!.disabled).toBe(true);
    expect(host.textContent).toContain('ESTIMATED TOTAL 0.201251 SOL');
    h.rpcSol = 0.3;
    await render();
    expect(button('PAY 0.20')!.disabled).toBe(false);
  });
  it.each(['paying', 'confirming', 'credited'] as const)('does not guide the player back to funding during %s', async (phase) => {
    h.flow = { phase, error: null, reservation: RES };
    h.rpcSol = 0;
    faucetView = () => 'claim';
    await render();
    expect(host.querySelector('[data-funding]')).toBeNull();
    expect(host.querySelector('[data-testid="faucet-control"]')).toBeNull();
  });
  it('never offers PAY after credit, even when entering the base fails', async () => {
    h.flow = { phase: 'credited', error: null, reservation: RES };
    enterGame.mockRejectedValueOnce(new Error('deed authority not ready'));
    await render();
    expect(button('PAY 0.20')).toBeUndefined();
    await tap(button('RETRY ENTERING GAME')!);
    expect(button('RETRY ENTERING GAME')).toBeDefined();
    expect(button('PAY 0.20')).toBeUndefined();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('known insufficient SOL makes funding primary and disables PAY; an unknown balance permits consent', async () => {
    h.flow = { phase: 'ready', error: null, reservation: RES };
    h.rpcSol = 0;
    await render();
    expect(button('PAY 0.20')!.disabled).toBe(true);
    const funding = host.querySelector('[data-funding]')!;
    expect(funding.compareDocumentPosition(button('PAY 0.20')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    h.rpcSol = null; h.feeEstimate = null; h.entryState = { busy: false, error: null };
    await render();
    expect(button('PAY 0.20')!.disabled).toBe(false);
  });

  it('sign-out needs confirmation and STAY keeps the purchase intact', async () => {
    await render();
    await tap(button('SIGN OUT / SWITCH ACCOUNT')!);
    expect(host.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(h.signOut).not.toHaveBeenCalled();
    await tap(button('STAY')!);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    await tap(button('SIGN OUT / SWITCH ACCOUNT')!);
    await tap([...host.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === 'SIGN OUT')!);
    expect(h.signOut).toHaveBeenCalledOnce();
  });
});

describe('network correction guidance', () => {
  it('shows the embedded wallet network without asking a social account to configure Backpack', async () => {
    h.isEmbedded = true;
    h.flow = { phase: 'ready', error: null, reservation: RES };
    await render();
    expect(host.textContent).toContain('THIS PAYMENT USES SOLANA DEVNET');
    expect(host.textContent).not.toContain('Developer Mode');
  });

  it('distinguishes Backpack Developer Mode from the Devnet network before payment', async () => {
    h.flow = { phase: 'ready', error: null, reservation: RES };
    await render();
    expect(host.textContent).toContain('USE SOLANA DEVNET IN YOUR WALLET');
    expect(host.textContent).toContain('turn on Developer Mode and select Devnet');
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('shows the server retry boundary without claiming elapsed time proves nonpayment', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-06T15:00:00Z');
    vi.setSystemTime(now);
    h.flow = { phase: 'confirming', error: null, reservation: { ...RES, retryAt: '2026-09-06T15:01:15Z' } };
    h.reservationRetryInSec = 75;
    await render();
    expect(host.textContent).toContain('Reservation release check in 1:15');
    expect(host.textContent).toContain('If you changed wallet networks');
    expect(host.textContent).toContain('A delayed network check can take longer');
    h.reservationRetryInSec = 0;
    await render();
    expect(host.textContent).toContain('Checking whether payment completed');
    expect(button('PAY 0.20 SOL')).toBeUndefined();
    expect(h.submit).not.toHaveBeenCalled();
  });
});

describe('persistent checkout exit', () => {
  it.each(['paying', 'confirming', 'restoring'] as const)('exits %s to the loaded base without resetting the purchase', async (phase) => {
    const draft = { kind: 'entry' as const, earthCell: 4321 };
    useApp.setState({ base: base(), landPurchase: draft });
    h.flow = { phase, error: null, reservation: RES };
    await render();
    await tap(button('EXIT')!);
    expect(useApp.getState().screen).toBe('base');
    expect(useApp.getState().landPurchase).toEqual(draft);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('exits to fresh base selection when no base is hydrated, preserving the authenticated wallet', async () => {
    useApp.setState({ selectedBaseId: 'previous-selection-without-snapshot' });
    h.flow = { phase: 'restoring', error: null, reservation: null };
    await render();
    await tap(button('EXIT')!);
    expect(useApp.getState().screen).toBe('bases');
    expect(useApp.getState().selectedBaseId).toBeNull();
    expect(useApp.getState().wallet).toBe(WALLET);
    expect(h.signOut).not.toHaveBeenCalled();
  });
});

describe('explicit first-land retry', () => {
  it('shows a one-minute first-land countdown and requires a tap when ready', async () => {
    h.flow = { phase: 'confirming', error: null, reservation: RES };
    h.retryEntryInSec = 60;
    await render();
    expect(host.textContent).toContain('First-land retry available in 1:00');
    expect(button('RETRY FIRST-LAND PAYMENT')).toBeUndefined();
    h.retryEntryInSec = 0; h.canRetryEntry = true;
    await render();
    expect(host.textContent).toContain('SAME PARCEL');
    expect(h.retryPayment).not.toHaveBeenCalled();
    await tap(button('RETRY FIRST-LAND PAYMENT')!);
    expect(h.retryPayment).toHaveBeenCalledOnce();
    expect(h.submit).not.toHaveBeenCalled();
    expect(button('EXIT')).toBeTruthy();
  });
});
