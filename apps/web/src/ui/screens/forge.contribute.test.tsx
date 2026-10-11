/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { selectBaseSnapshot } from '../../state/baseSnapshot';
import { useApp, type BalancesDto, type BaseStateDto } from '../../state/store';
import { ForgeScreen } from './menu';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false }) }));
// Keep the production snapshot loader: a reload spy alone cannot prove that
// the balance a player sees actually moves, or that a land switch stays safe.
vi.mock('../sheets', async () => ({ reloadBase: (await import('../../state/baseSnapshot')).reloadBase }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));

function baseState(baseId = 'base-a'): BaseStateDto {
  return {
    baseId,
    player: { wallet: 'wallet-a', name: 'Keeper', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
  };
}

function forgeState(balance: number) {
  return {
    day: '2026-09-07', serverNow: '2026-09-07T15:33:00Z', cycleEndsAt: '2026-09-08T00:00:00Z', cycleEndsInSec: 30_000,
    dailyEmissionKeep: 100, softCapShards: 1000, maxDailyShareBps: 1000,
    totalShards: String(1000 - balance), myShards: String(1000 - balance), myShardBalance: String(balance),
    goldforgeLevel: 1, myDailyCapShards: '1000', drops: { independentDropBps: {} },
    claimable: { count: 0, totalKeep: '0', days: [], nextExpiresAt: null }, yesterday: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function ScreenWithHudBalance(): React.JSX.Element {
  const shards = useApp((state) => state.balances?.shards);
  const screen = useApp((state) => state.screen);
  return <><output aria-label="HUD shards">{shards}</output>{screen === 'forge' && <ForgeScreen />}</>;
}

let root: Root;
let host: HTMLDivElement;
let balance: number;

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label && !item.classList.contains('sk-forge-tab'));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function hudBalance(): string | null | undefined {
  return host.querySelector('output[aria-label="HUD shards"]')?.textContent;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  balance = 1000;
  useApp.getState().setAuth('wallet-a', true);
  useApp.getState().setSelectedBaseId('base-a');
  useApp.getState().setBase(baseState());
  useApp.getState().setBalances({ shards: String(balance), keep: '20', keepRate: 1 });
  useApp.getState().setScreen('forge');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/forge?baseId=base-a') return forgeState(balance);
    if (path === '/base?baseId=base-a') return baseState();
    if (path === '/balances?baseId=base-a') return { shards: String(balance), keep: '20', keepRate: 1 };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(api, 'post').mockImplementation(async (_path, body) => {
    balance -= Number((body as { shards: string }).shards);
    return {};
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  useApp.getState().setAuth(null);
});

describe('Forge contribution refreshes the balance without reopening the game', () => {
  it.each([
    ['25%', 250], ['50%', 500], ['MAX · 1,000', 1000], ['manual', 123],
  ] as const)('updates both Forge and HUD after deploying %s', async (choice, amount) => {
    await act(async () => root.render(<ScreenWithHudBalance />));
    if (choice === 'manual') {
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Shards to deploy"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(amount));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    } else {
      await act(async () => button(choice).click());
    }
    expect(button('DEPLOY').disabled).toBe(false);
    await act(async () => button('DEPLOY').click());
    expect(api.post).toHaveBeenCalledWith('/forge/contribute', { shards: String(amount), baseId: 'base-a' });
    expect(hudBalance()).toBe(String(1000 - amount));
    const balanceRow = [...host.querySelectorAll('.sk-forge-trow')].find((row) => row.textContent?.includes('MY SHARD BALANCE'));
    expect(balanceRow?.querySelector('.sk-forge-trow__value')?.textContent).toBe(String(1000 - amount));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(hudBalance()).toBe(String(1000 - amount));
    expect(host.querySelector('.sk-forge-deploy')).toBeNull();
  });

  it('retains both balances when the server refuses a contribution', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Contribution refused'));
    await act(async () => root.render(<ScreenWithHudBalance />));
    const readsBefore = vi.mocked(api.get).mock.calls.length;
    await act(async () => button('50%').click());
    await act(async () => button('DEPLOY').click());
    // The refusal handler loads its custody classifier before releasing busy.
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(hudBalance()).toBe('1000');
    expect(button('MAX · 1,000')).toBeDefined();
    expect(api.get).toHaveBeenCalledTimes(readsBefore);
    expect(button('DEPLOY').disabled).toBe(false);
  });

  it('still refreshes the HUD when the player closes Forge before the contribution completes', async () => {
    const contribution = deferred<object>();
    vi.mocked(api.post).mockImplementation(() => contribution.promise);
    await act(async () => root.render(<ScreenWithHudBalance />));
    await act(async () => button('50%').click());
    await act(async () => button('DEPLOY').click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    await act(async () => { balance = 500; contribution.resolve({}); });
    expect(hudBalance()).toBe('500');
  });

  it('does not replace another land balance when an old Forge refresh arrives after switching', async () => {
    const oldBalance = deferred<BalancesDto>();
    const get = vi.mocked(api.get);
    get.mockImplementation(async (path) => {
      if (path === '/forge?baseId=base-a') return forgeState(balance);
      if (path === '/base?baseId=base-a') return baseState();
      if (path === '/balances?baseId=base-a') return oldBalance.promise;
      if (path === '/forge?baseId=base-b') return forgeState(700);
      if (path === '/base?baseId=base-b') return baseState('base-b');
      if (path === '/balances?baseId=base-b') return { shards: '700', keep: '20', keepRate: 1 };
      throw new Error(`Unexpected GET ${path}`);
    });
    await act(async () => root.render(<ScreenWithHudBalance />));
    await act(async () => button('50%').click());
    await act(async () => button('DEPLOY').click());
    expect(get).toHaveBeenCalledWith('/balances?baseId=base-a');
    await act(async () => { await selectBaseSnapshot('base-b'); });
    await act(async () => oldBalance.resolve({ shards: '500', keep: '20', keepRate: 1 }));
    expect(useApp.getState().selectedBaseId).toBe('base-b');
    expect(useApp.getState().base?.baseId).toBe('base-b');
    expect(hudBalance()).toBe('700');
  });
});
