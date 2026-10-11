/** @vitest-environment happy-dom */
/**
 * CLAIM DEVNET SOL (D-098, owner 2026-09-02). WHY: the reporting player was
 * refused with 0.149 SOL and the only faucet UI they ever saw pointed at
 * faucet.solana.com, which wanted a mainnet balance. The control must show
 * exactly what the SERVER says — eligible, cooling down to the server's own
 * instant, capped, or already funded — a tap must queue exactly one grant,
 * and a build for any cluster but devnet must never show it at all.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FaucetPhase, FaucetStatus } from '../auth/useDevnetFaucet';

// The cluster is a build-time constant; the getter lets one file cover both
// the devnet control and the non-devnet "renders nothing" rule.
const cluster = vi.hoisted(() => ({ value: 'devnet' }));
vi.mock('../lib/cluster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/cluster')>();
  return { ...actual, get SOLANA_CLUSTER() { return cluster.value; } };
});
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: null }),
  useWallet: () => ({}),
}));
vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({}),
  useSolanaWallets: () => ({ wallets: [] }),
}));
vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ signIn: vi.fn(), signingIn: false, error: null }),
}));
vi.mock('../auth/useSocialAuth', () => ({
  useSocialAuth: () => ({ signInWithSocial: vi.fn(), signingIn: false, error: null }),
}));
vi.mock('../auth/useSignOut', () => ({ useSignOut: () => vi.fn() }));
vi.mock('../auth/useWalletSessionFence', () => ({ useWalletSessionFence: () => undefined }));
vi.mock('../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, signMessage: null }),
}));
vi.mock('../auth/useEntry', () => ({
  usePayEntry: () => ({
    reserve: vi.fn(), submit: vi.fn(), phase: 'idle', error: null, reservation: null,
  }),
}));
vi.mock('./useFetch', () => ({
  useFetch: () => ({ data: null, reload: vi.fn() }),
}));
vi.mock('./useSolBalance', () => ({ useSolBalance: () => null }));

import { DevnetSolClaim } from './Overlay';

const WALLET = 'FaUCeT1111111111111111111111111111111111111';

function status(over: Partial<FaucetStatus> = {}): FaucetStatus {
  return {
    enabled: true, eligible: false, reason: 'ok', balanceSol: 0.1, grantSol: 0.5, grantedSol: 0,
    lifetimeCapSol: 3, minBalanceSol: 0.25, cooldownHours: 6, nextEligibleAt: null, last: null, ...over,
  };
}
function handle(phase: FaucetPhase, s: FaucetStatus | null) {
  return { phase, status: s, claim: vi.fn(), refresh: vi.fn() };
}
async function mount(faucet: ReturnType<typeof handle>) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<DevnetSolClaim wallet={WALLET} faucet={faucet} />));
  return { host, root };
}
function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
}
const tap = (el: Element): Promise<void> => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

afterEach(() => { cluster.value = 'devnet'; });

describe('DevnetSolClaim renders only what the server says', () => {
  it('offers exactly one grant per tap when the server says eligible', async () => {
    const faucet = handle('idle', status({ eligible: true, reason: 'ok' }));
    const { host, root } = await mount(faucet);
    const claim = button(host, 'CLAIM 0.5 DEVNET SOL');
    expect(claim).toBeTruthy();
    expect(claim!.disabled).toBe(false);
    await tap(claim!);
    expect(faucet.claim).toHaveBeenCalledTimes(1);
    // Nothing on the eligible path mentions the public faucet.
    expect(host.textContent).not.toContain('FAUCET.SOLANA.COM');
    await act(async () => root.unmount());
  });

  it('counts down to the server\'s nextEligibleAt while cooling down, and cannot be tapped', async () => {
    // WHY: the client never adds cooldownHours itself — it only formats the
    // instant the server computed, so a policy change needs no client deploy.
    const nextEligibleAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const faucet = handle('idle', status({ reason: 'cooldown', nextEligibleAt, grantedSol: 0.5 }));
    const { host, root } = await mount(faucet);
    const wait = button(host, 'NEXT GRANT IN 2h');
    expect(wait).toBeTruthy();
    expect(wait!.disabled).toBe(true);
    await tap(wait!);
    expect(faucet.claim).not.toHaveBeenCalled();
    expect(button(host, 'CLAIM')).toBeUndefined();
    await act(async () => root.unmount());
  });

  it('states the lifetime total used at the cap and only then names the public faucet as a caveat', async () => {
    const faucet = handle('idle', status({ reason: 'cap_reached', grantedSol: 3 }));
    const { host, root } = await mount(faucet);
    expect(host.textContent).toContain('IN-GAME FAUCET LIFETIME 3.0/3.0 SOL USED');
    expect(host.textContent).toContain('THE PUBLIC FAUCET AT FAUCET.SOLANA.COM MAY ASK FOR A SMALL MAINNET SOL BALANCE ON THE SAME WALLET');
    expect(host.querySelector('a')).toBeNull(); // a caveat, never a link
    expect(button(host, 'COPY MY ADDRESS')).toBeTruthy();
    expect(button(host, 'CLAIM')).toBeUndefined();
    expect(faucet.claim).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('renders nothing when the wallet already holds enough', async () => {
    const faucet = handle('idle', status({ reason: 'balance_ok', balanceSol: 1 }));
    const { host, root } = await mount(faucet);
    expect(host.textContent).toBe('');
    await act(async () => root.unmount());
  });

  it('shows an honest retry when the balance cannot be read, and RETRY re-asks the server once', async () => {
    const faucet = handle('idle', status({ reason: 'rpc_unavailable' }));
    const { host, root } = await mount(faucet);
    expect(host.textContent).toContain('FAUCET UNAVAILABLE — TRY AGAIN IN A MINUTE');
    const retry = button(host, 'RETRY');
    expect(retry).toBeTruthy();
    await tap(retry!);
    expect(faucet.refresh).toHaveBeenCalledTimes(1);
    expect(faucet.claim).not.toHaveBeenCalled();
    // A transient RPC hiccup is not a reason to send anyone to the public faucet.
    expect(host.textContent).not.toContain('FAUCET.SOLANA.COM');
    await act(async () => root.unmount());
  });

  it('adds the public-faucet caveat only once the game itself has failed to fund the wallet', async () => {
    const faucet = handle('failed', status({ reason: 'ok', eligible: true }));
    const { host, root } = await mount(faucet);
    expect(host.textContent).toContain('FAUCET UNAVAILABLE — TRY AGAIN IN A MINUTE');
    expect(host.textContent).toContain('FAUCET.SOLANA.COM');
    expect(button(host, 'COPY MY ADDRESS')).toBeTruthy();
    await act(async () => root.unmount());
  });

  it('renders nothing until the server has answered, and nothing at all on a non-devnet build', async () => {
    const silent = await mount(handle('checking', null));
    expect(silent.host.textContent).toBe('');
    await act(async () => silent.root.unmount());

    // The rule (cluster.test.ts): a MAINNET build never tells a player to go
    // and get free SOL — even with a status that says eligible.
    cluster.value = 'mainnet-beta';
    const faucet = handle('idle', status({ eligible: true, reason: 'ok' }));
    const { host, root } = await mount(faucet);
    expect(host.textContent).toBe('');
    expect(faucet.claim).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
