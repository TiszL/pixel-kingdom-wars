/** @vitest-environment happy-dom */
import { WARZONE } from '@shardkeep/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseStateDto } from '../state/store';
import { useApp } from '../state/store';
import { useBaseAutoRefetch } from './Overlay';
import { bus } from '../lib/events';

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

afterEach(() => {
  vi.useRealTimers();
  useApp.getState().setBase(null);
});

describe('base auto-refetch loop', () => {
  it('does not overlap a failed phase poll, then retries, reflects, and rearms', async () => {
    vi.useFakeTimers();
    const base: BaseStateDto = {
      player: {
        wallet: 'wallet', name: 'KEEPER', keepLevel: 1, trophies: 0,
        league: 'wood', builders: 1, expansions: 0,
      },
      claim: { min: 0, max: 0 }, energy: { used: 0, free: 1, max: 1 },
      shield: null,
      warzone: { active: false, boundaryAt: null, remainingMs: null },
      buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
    };
    useApp.getState().setBase(base);

    let rejectFirst: ((cause: Error) => void) | null = null;
    const refresh = vi.fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockImplementationOnce(async () => {
        useApp.getState().setBase({
          ...base,
          warzone: {
            active: true,
            boundaryAt: new Date(Date.now() + 3_600_000).toISOString(),
            remainingMs: 3_600_000,
          },
        });
        return true;
      })
      .mockResolvedValue(true);

    function Probe(): null {
      useBaseAutoRefetch(refresh);
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    const refreshed = vi.fn();
    const off = bus.on('base:refresh', refreshed);

    const phaseMs = WARZONE.currentPhasePollSec * 1_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(phaseMs); });
    expect(refresh).toHaveBeenCalledTimes(1);
    // No second timer exists while the first request is still unresolved.
    await act(async () => { await vi.advanceTimersByTimeAsync(phaseMs * 3); });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectFirst?.(new Error('temporary network failure'));
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(phaseMs); });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(useApp.getState().base?.warzone?.active).toBe(true);
    expect(refreshed, 'a committed snapshot must refresh the quest even when its old timer effect cleans up').toHaveBeenCalledTimes(1);

    // The successful active snapshot gets its own current-phase timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(phaseMs); });
    expect(refresh).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(phaseMs * 2); });
    expect(refresh).toHaveBeenCalledTimes(3);
    off();
  });
});
