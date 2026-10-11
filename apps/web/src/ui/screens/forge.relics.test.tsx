/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ITEMS } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useApp, type BaseStateDto } from '../../state/store';
import { ForgeScreen } from './menu';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false }) }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn() }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));

function baseState(): BaseStateDto {
  return {
    baseId: 'base-a',
    player: { wallet: 'wallet-a', name: 'Keeper', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
  };
}

const forgeState = {
  day: '2026-09-17', serverNow: '2026-09-17T15:33:00Z', cycleEndsAt: '2026-09-18T00:00:00Z', cycleEndsInSec: 30_000,
  dailyEmissionKeep: 100, softCapShards: 1000, maxDailyShareBps: 1000,
  totalShards: '0', myShards: '0', myShardBalance: '1000',
  goldforgeLevel: 1, myDailyCapShards: '1000', drops: { independentDropBps: {} },
  claimable: { count: 0, totalKeep: '0', days: [], nextExpiresAt: null }, yesterday: null,
};

/** The caller's own ledger page: one settled day that dropped two relics. */
const allocations = {
  days: [{
    day: '2026-09-15', shards: '400', counted: '400', keepPaid: '12', shardsRefunded: '0',
    itemDropped: 'keg_of_haste', itemsDropped: ['keg_of_haste', 'wardens_helm'], settledAt: '2026-09-16T00:00:01Z',
    status: 'claimed', claimedAt: '2026-09-16T08:00:00Z', expiresAt: null,
  }],
  nextBefore: null,
  totals: { keepClaimed: '12', keepClaimable: '0', keepExpired: '0', shardsBurned: '400', itemsWon: 2 },
};

/** What the server publishes: abbreviated winners only, newest first. */
const feed = {
  drops: [
    { day: '2026-09-16', settledAt: '2026-09-17T00:00:02Z', itemId: 'banner_of_nine', name: ITEMS.banner_of_nine.name, rarity: 'mythic',
      winner: { name: 'Ironhold', walletShort: '4A3o…zxNC', seeker: true } },
    { day: '2026-09-16', settledAt: '2026-09-17T00:00:01Z', itemId: 'warzone_aegis', name: ITEMS.warzone_aegis.name, rarity: 'legendary',
      winner: { name: '', walletShort: '9QmP…kd2E', seeker: false } },
  ],
  cacheSec: 60,
};

let root: Root;
let host: HTMLDivElement;

function tab(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button.sk-forge-tab')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`Missing tab: ${label}`);
  return found;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.getState().setAuth('wallet-a', true);
  useApp.getState().setSelectedBaseId('base-a');
  useApp.getState().setBase(baseState());
  useApp.getState().setScreen('forge');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/forge?baseId=base-a') return forgeState;
    if (path === '/forge/allocations?baseId=base-a') return allocations;
    if (path === '/forge/drops/recent') return feed;
    throw new Error(`Unexpected GET ${path}`);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  useApp.getState().setAuth(null);
});

describe('Gold Forge RELICS WON', () => {
  // WHY: tester 69arc (report 0d1b6d9d) could only see the KEEP cycle and had
  // no way to tell whether relic drops really happen. The tab must show who
  // won which relic in which cycle, from the public feed, with the winner
  // exactly as the server abbreviated it.
  it('lists every published drop with item name, rarity, cycle and abbreviated winner', async () => {
    await act(async () => root.render(<ForgeScreen />));
    expect(api.get).not.toHaveBeenCalledWith('/forge/drops/recent');
    await act(async () => tab('RELICS WON').click());
    expect(api.get).toHaveBeenCalledWith('/forge/drops/recent');
    const rows = [...host.querySelectorAll('.sk-forge-relic')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain(ITEMS.banner_of_nine.name);
    expect(rows[0]!.textContent).toContain('MYTHIC · CYCLE 2026-09-16');
    expect(rows[0]!.textContent).toContain('Ironhold');
    expect(rows[0]!.textContent).toContain('4A3o…zxNC');
    // An unnamed winner shows the server's abbreviation, never a blank.
    expect(rows[1]!.textContent).toContain(ITEMS.warzone_aegis.name);
    expect(rows[1]!.querySelector('.sk-forge-relic__winner')?.textContent).toContain('9QmP…kd2E');
    // Gear art (itm_*) lives outside the Phaser atlas and resolves through
    // itemArtUrl like the DAILY DROPS panel — the Banner must not render blank.
    expect(rows[0]!.querySelector('img')?.getAttribute('src')).toContain('itm_banner');
  });

  it('shows the player\'s own relic history from the ledger page it already loads', async () => {
    await act(async () => root.render(<ForgeScreen />));
    await act(async () => tab('RELICS WON').click());
    expect(api.get).toHaveBeenCalledWith('/forge/allocations?baseId=base-a');
    const mine = host.querySelector('.sk-forge-relics__mine');
    expect(mine?.textContent).toContain(ITEMS.keg_of_haste.name);
    expect(mine?.textContent).toContain(ITEMS.wardens_helm.name);
    expect(host.querySelector('.sk-forge-relics .sk-forge-panel__head')?.textContent).toContain('2 WON');
  });

  it('keeps the screen usable when the public feed is empty or unavailable', async () => {
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === '/forge?baseId=base-a') return forgeState;
      if (path === '/forge/allocations?baseId=base-a') return { ...allocations, days: [], totals: { ...allocations.totals, itemsWon: 0 } };
      if (path === '/forge/drops/recent') return { drops: [], cacheSec: 60 };
      throw new Error(`Unexpected GET ${path}`);
    });
    await act(async () => root.render(<ForgeScreen />));
    await act(async () => tab('RELICS WON').click());
    expect(host.querySelectorAll('.sk-forge-relic')).toHaveLength(0);
    expect(host.textContent).toContain('No relic has dropped yet');
    expect(host.textContent).toContain('No relic yet');

    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === '/forge?baseId=base-a') return forgeState;
      if (path === '/forge/allocations?baseId=base-a') return allocations;
      throw new Error('feed down');
    });
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<ForgeScreen />));
    await act(async () => tab('RELICS WON').click());
    expect(host.textContent).toContain('The relic feed could not load.');
    expect(host.querySelector('.sk-forge-relics__mine')?.textContent).toContain(ITEMS.keg_of_haste.name);
  });
});
