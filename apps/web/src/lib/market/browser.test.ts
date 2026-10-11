/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { ApiError, api } from '../api';
import { firstMarketRefusal, marketRequest, marketSolAmount, refreshMarketDestination } from './browser';
import { id, identity } from './fixtures.test-support';

const base = (n: number) => ({ id: id(n), status: 'active', slot: 1 });
const directory = (bases = [base(5), base(6)]) => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases });
const fixture = (owned: unknown = directory()) => {
  const requests: string[] = [];
  const read = async <T>(path: string): Promise<T> => {
    requests.push(path);
    if (path === '/me') return { wallet: identity.wallet, entryPaid: true } as T;
    if (path === '/bases') return owned as T;
    if (path.startsWith('/balances')) return { keep: '5', shards: '6', keepRate: 1 } as T;
    if (path.startsWith('/items')) return { catalog: [], owned: [] } as T;
    throw new Error(path);
  };
  return { read, requests };
};
describe('market browser production contracts', () => {
  it('uses exact decimal lamports and shared bounds without float rounding', () => {
    expect(marketSolAmount('0.001000001')).toBe('1000001');
    for (const input of ['0.0010000001', '1e-3', '0.1 SOL', '-1', 'Infinity', '0001', '1000000', '0']) expect(() => marketSolAmount(input)).toThrow();
  });
  it('does not classify uncertainty, generic conflict, or plain provider messages as first refusal', () => {
    expect(firstMarketRefusal(new ApiError(422, 'unavailable'))?.status).toBe(422);
    expect(firstMarketRefusal(new ApiError(409, 'changed', 'MARKET_CONSENT_CHANGED'))?.status).toBe(409);
    for (const error of [new ApiError(0, 'offline'), new ApiError(408, 'timeout'), new ApiError(409, 'existing key'), new ApiError(503, 'uncertain'), new Error('HTTP 422')]) expect(firstMarketRefusal(error)).toBeNull();
  });
  it('reads original destination A even after selecting B, while balances remain attributed to B', async () => {
    const f = fixture(); const result = await refreshMarketDestination(identity.wallet, id(5), f.read, () => undefined, id(6));
    expect(f.requests).toContain(`/items?baseId=${id(5)}`); expect(f.requests).not.toContain(`/items?baseId=${id(6)}`);
    expect(result.destination).toEqual({ baseId: id(5), stillOwned: true }); expect(result.balanceBase).toBe(id(6));
  });
  it('records transferred original destination only after fresh wallet and directory proof', async () => {
    const f = fixture(directory([base(6)])); const result = await refreshMarketDestination(identity.wallet, id(5), f.read, () => undefined, id(6));
    expect(result.destination).toEqual({ baseId: id(5), stillOwned: false }); expect(f.requests.some((p) => p.startsWith('/items'))).toBe(false);
    expect(f.requests).toEqual(['/me', '/bases', `/balances?baseId=${id(6)}`]);
  });
  it('never treats missing authority or a flag-off directory as a confirmed transfer', async () => {
    for (const invalid of [null, {}, { ...directory(), enabled: false }, { ...directory(), bases: [base(5), base(5)] }]) {
      const f = fixture(invalid); await expect(refreshMarketDestination(identity.wallet, id(5), f.read, () => undefined, id(6))).rejects.toThrow();
      expect(f.requests.some((p) => p.startsWith('/items'))).toBe(false);
    }
  });
  it('holds hydration when identity, balances or original inventory fails', async () => {
    for (const path of ['/me', '/bases', `/balances?baseId=${id(6)}`, `/items?baseId=${id(5)}`]) {
      const f = fixture(); const read = async <T>(p: string): Promise<T> => { if (p === path) throw new Error('offline'); return f.read<T>(p); };
      await expect(refreshMarketDestination(identity.wallet, id(5), read, () => undefined, id(6))).rejects.toThrow('offline');
    }
    const f = fixture(); await expect(refreshMarketDestination('other-wallet', id(5), f.read, () => undefined, id(6))).rejects.toThrow('original account');
    const guard = vi.fn(() => { throw new Error('identity changed'); }); await expect(refreshMarketDestination(identity.wallet, id(5), f.read, guard, id(6))).rejects.toThrow('identity changed');
  });
  it('pins capability reads to the actual canonical route instead of a fabricated book endpoint', () => {
    const source = readFileSync(new NodeURL('../../../../api/src/game/routes.ts', import.meta.url), 'utf8');
    const client = readFileSync(new NodeURL('./controller.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.get('/market/listings',"); expect(client).toContain("this.ports.get('/market/listings')"); expect(client).not.toContain('/market/book');
  });
});

describe('browser account and page fences', () => {
  it('blocks selected-base changes for new approvals while allowing original receipt recovery', async () => {
    const { useApp } = await import('../../state/store');
    const { authCookies } = await import('../../auth/authCookieCoordinator');
    const { createMarketBrowserPorts } = await import('./browser');
    const spies = [vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'), vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined)];
    const state = useApp.getState(); useApp.setState({ authed: true, wallet: identity.wallet, selectedBaseId: id(5), baseSelectionEpoch: 1 });
    const page = { active: true, epoch: 0, visible: true };
    const ports = createMarketBrowserPorts({ identity, connection: {} as import('@solana/web3.js').Connection,
      wallet: () => ({ publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false }), lifecycle: () => page });
    try {
      const fresh = ports.capture(true); const recovery = ports.capture(false);
      useApp.setState({ selectedBaseId: id(6), baseSelectionEpoch: 2 });
      expect(fresh).toThrow('selected base'); expect(recovery).not.toThrow(); expect(() => ports.assertDestination(id(5))).toThrow('original receiving');
      const next = ports.capture(true); page.epoch += 1; expect(next).toThrow('page changed');
      const hidden = ports.capture(true); page.visible = false; expect(hidden).toThrow('page changed');
      page.active = false; expect(recovery).toThrow('page changed');
    } finally { useApp.setState(state, true); spies.forEach((spy) => spy.mockRestore()); }
  });
  it('fails closed without browser action locks instead of allowing two wallets to race', async () => {
    const { marketBrowserLock } = await import('./controller');
    const action = vi.fn(async () => 'sent');
    await expect(marketBrowserLock('test', action)).rejects.toThrow('coordinate'); expect(action).not.toHaveBeenCalled();
  });
});


describe('bounded market transport without abandoning a live request', () => {
  it.each(['get', 'post'] as const)('aborts an actual stalled %s while keeping timeout uncertain', async (method) => {
    const { createMarketBrowserPorts } = await import('./browser');
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const aborted = (s: AbortSignal | undefined): Promise<never> => {
      signal = s;
      return new Promise((_, reject) => s!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const spy = method === 'get'
      ? vi.spyOn(api, 'get').mockImplementation((_path, options) => aborted(options?.signal))
      : vi.spyOn(api, 'postRaw').mockImplementation((_path, _body, options) => aborted(options?.signal));
    const ports = createMarketBrowserPorts({ identity, connection: {} as import('@solana/web3.js').Connection,
      wallet: () => ({ publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false }), lifecycle: () => ({ active: true, epoch: 0, visible: true }) });
    try {
      const result = (method === 'get' ? ports.get('/market/v1/reservations/by-key/test') : ports.post('/market/v1/reservations/test/settle', { reference: 'original' })).catch((error: unknown) => error);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      const error = await result;
      expect(signal?.aborted).toBe(true); expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('saved receipt is kept'); expect(firstMarketRefusal(error)).toBeNull(); expect(spy).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); spy.mockRestore(); }
  });
  it('keeps ownership while an abort-ignoring request is unresolved and rejects its late result', async () => {
    vi.useFakeTimers(); let complete!: (value: string) => void; let released = false; let signal!: AbortSignal;
    const result = marketRequest((s) => { signal = s; return new Promise<string>((resolve) => { complete = resolve; }); })
      .finally(() => { released = true; }).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      expect(signal.aborted).toBe(true); expect(released).toBe(false);
      complete('late receipt'); expect((await result as Error).message).toContain('timed out'); expect(released).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
