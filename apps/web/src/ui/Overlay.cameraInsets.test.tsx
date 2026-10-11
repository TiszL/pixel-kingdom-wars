/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useApp, type BaseStateDto } from '../state/store';
import { bus } from '../lib/events';
import { api } from '../lib/api';
import { Overlay } from './Overlay';

vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: null }), useWallet: () => ({}) }));
vi.mock('@privy-io/react-auth', () => ({ usePrivy: () => ({}), useSolanaWallets: () => ({ wallets: [] }) }));
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ signIn: vi.fn(), signingIn: false, error: null }) }));
vi.mock('../auth/useSocialAuth', () => ({ useSocialAuth: () => ({}) }));
vi.mock('../auth/useSignOut', () => ({ useSignOut: () => vi.fn() }));
vi.mock('../auth/useWalletSessionFence', () => ({ useWalletSessionFence: () => undefined }));
vi.mock('../auth/useOptionalReferral', () => ({ useOptionalReferral: () => undefined }));
vi.mock('../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, sendTransaction: null, signMessage: null }) }));
vi.mock('../auth/useEntry', () => ({ usePayEntry: () => ({ phase: 'idle' }) }));
vi.mock('./useFetch', () => ({ useFetch: () => ({ data: null, reload: vi.fn() }) }));
vi.mock('./useMineStatus', () => ({ useMineStatus: () => ({ data: null, reload: vi.fn() }) }));
vi.mock('./useSolBalance', () => ({ useSolBalance: () => null }));
vi.mock('./chat/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('./RaidUI', () => ({ RaidUI: () => null }));
vi.mock('./sheets', () => ({ ActionSheet: () => null, ObstacleSheet: () => null, BuildTray: () => null }));

it('refits when the builder label grows into the board without resizing its wrapper', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(api, 'get').mockRejectedValue(new Error('The job awaits its next authoritative refresh'));
  vi.stubGlobal('innerWidth', 844); vi.stubGlobal('innerHeight', 390);
  const observers: Array<{ targets: Set<Element>; publish: () => void }> = [];
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>();
    constructor(callback: () => void) { observers.push({ targets: this.targets, publish: callback }); }
    observe(target: Element): void { this.targets.add(target); }
    disconnect(): void { this.targets.clear(); }
    unobserve(target: Element): void { this.targets.delete(target); }
  });
  const rect = (left: number, top: number, width: number, height: number): DOMRect => new DOMRect(left, top, width, height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this.getAttribute('aria-label') === 'Builder queue') {
      // Real text changes after the server-timed job expires. Only the button's
      // width changes; its parent keeps its width and its 48px row height.
      return rect(8, 64, this.textContent?.includes('VERIFYING') ? 300 : 120, 48);
    }
    if (this.tagName === 'NAV') return rect(650, 326, 180, 56);
    if (this.querySelector('[aria-label="Builder queue"]')) return rect(8, 64, 700, 48);
    return rect(8, 8, 600, 48); // resource row
  });
  const prior = useApp.getState();
  const base: BaseStateDto = {
    baseId: 'base-camera-test', player: { wallet: 'test', name: 'Keeper', keepLevel: 20,
      trophies: 0, league: 'wood', builders: 6, expansions: 12 },
    claim: { min: -10, max: 40 }, plotVersion: 2, energy: { used: 0, free: 1, max: 1 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], freeBuilders: 5,
    jobs: [{ id: 'job', kind: 'build', buildingId: 'building', obstacleId: null, startedAt: new Date(Date.now() - 1000).toISOString(),
      finishesAt: new Date(Date.now() + 500).toISOString() }],
  };
  useApp.setState({ base, screen: 'base', wallet: null, authed: false, entryPaid: true });
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const insets: Array<{ top: number }> = [];
  const off = bus.on('base:insets', value => insets.push(value));
  try {
    await act(async () => root.render(<Overlay />));
    const button = host.querySelector('[aria-label="Builder queue"]')!;
    expect(button).not.toBeNull();
    expect(button.textContent).not.toContain('VERIFYING');
    expect(insets.at(-1)?.top).toBe(56);
    const wrapperBounds = button.parentElement!.getBoundingClientRect();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(button.textContent).toContain('VERIFYING');
    expect(button.parentElement!.getBoundingClientRect()).toEqual(wrapperBounds);
    const before = insets.length;
    // The browser reports only changed targets, not their unchanged ancestors.
    await act(async () => { observers.filter(observer => observer.targets.has(button)).forEach(observer => observer.publish()); });
    expect(insets.length).toBeGreaterThan(before);
    expect(insets.at(-1)?.top).toBe(112);
    await act(async () => root.unmount());
    expect(observers.every(observer => observer.targets.size === 0)).toBe(true);
  } finally {
    off(); await act(async () => root.unmount()); host.remove();
    useApp.setState(prior, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});
