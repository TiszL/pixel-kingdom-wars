/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FaucetStatus } from './useDevnetFaucet';
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), emit: vi.fn() }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { get: h.get, postRaw: h.post } }));
vi.mock('../lib/analytics', () => ({ track: vi.fn(), EVENTS: {} }));
vi.mock('../lib/cluster', () => ({ SOLANA_CLUSTER: 'devnet' }));
vi.mock('../lib/events', () => ({ bus: { emit: h.emit } }));
import { useDevnetFaucet } from './useDevnetFaucet';
let root: Root;
let host: HTMLDivElement;
let serial = 0;
function status(id: string, state: 'requested' | 'sent' = 'requested'): FaucetStatus {
  return { enabled: true, eligible: false, reason: state === 'sent' ? 'balance_ok' : 'pending', balanceSol: state === 'sent' ? .5 : 0,
    grantSol: .5, grantedSol: .5, lifetimeCapSol: 3, minBalanceSol: .25, cooldownHours: 6, nextEligibleAt: null,
    last: { id, status: state, lamports: '500000000', txSignature: null, error: null, requestedAt: new Date().toISOString(), sentAt: null } };
}
function Harness({ wallet, active = true }: { wallet: string; active?: boolean }) {
  const result = useDevnetFaucet(wallet, active);
  return <><output>{result.phase}</output><button onClick={result.refresh}>CHECK</button></>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers(); h.get.mockReset(); h.post.mockReset(); h.emit.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('delayed faucet fulfilment', () => {
  it('keeps the same request alive after the fast minute and announces its later arrival once', async () => {
    const id = `slow-${++serial}`;
    h.get.mockResolvedValue(status(id));
    await act(async () => root.render(<Harness wallet={id} />));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(host.querySelector('output')?.textContent).toBe('unavailable');
    const calls = h.get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(29_000));
    expect(h.get).toHaveBeenCalledTimes(calls);
    h.get.mockResolvedValue(status(id, 'sent'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(host.querySelector('output')?.textContent).toBe('funded');
    expect(h.emit).toHaveBeenCalledOnce();
    expect(h.post).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(h.emit).toHaveBeenCalledOnce();
  });

  it('RETRY after a delayed grant landed recognizes sent and announces arrival instead of returning to idle', async () => {
    const id = `refresh-${++serial}`;
    h.get.mockResolvedValue(status(id));
    await act(async () => root.render(<Harness wallet={id} />));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    h.get.mockResolvedValue(status(id, 'sent'));
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('output')?.textContent).toBe('funded');
    expect(h.emit).toHaveBeenCalledOnce();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('a departed wallet cannot announce or install its delayed response on the next wallet', async () => {
    const id = `switch-${++serial}`;
    let finish!: (value: FaucetStatus) => void;
    h.get.mockReturnValueOnce(new Promise<FaucetStatus>((resolve) => { finish = resolve; }));
    await act(async () => root.render(<Harness wallet={id} />));
    h.get.mockResolvedValue({ ...status('other'), last: null, enabled: false });
    await act(async () => root.render(<Harness wallet={`${id}-other`} />));
    await act(async () => finish(status(id, 'sent')));
    expect(host.querySelector('output')?.textContent).toBe('unavailable');
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
  });
});
