/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api } from '../api';
import { createGemsBrowserPorts, gemsIdentity, hydrateGemsDestination } from './browser';
import { gemsBrowserLock } from './controller';
import { base, identity, intent } from './fixtures.test-support';
const page = () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true });
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet, selectedBaseId: base, baseSelectionEpoch: 0 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.setState({ authed: false, wallet: null }); });
describe('Gems browser session binding', () => {
  it('refuses another origin or cluster before reading its journal over current transport', () => {
    const who = gemsIdentity(identity.wallet), ports = createGemsBrowserPorts(who, page, async () => undefined);
    for (const other of [{ ...who, api: 'https://another.example/' }, { ...who, cluster: who.cluster === 'devnet' ? 'mainnet-beta' as const : 'devnet' as const }])
      expect(() => ports.capture(other, false)).toThrow('server or network');
  });
  it('account and base switches invalidate new approval while history can still recover its original scope', () => {
    const who = gemsIdentity(identity.wallet), ports = createGemsBrowserPorts(who, page, async () => undefined);
    const fresh = ports.capture(who, true), recovery = ports.capture(who, false);
    useApp.getState().setSelectedBaseId(null, false);
    expect(fresh).toThrow('account, base'); expect(recovery).not.toThrow();
    useApp.setState({ wallet: 'other' }); expect(recovery).toThrow('account, base');
  });
  it('exact raw mutation and GET both recheck the original guard inside transport admission', async () => {
    const who = gemsIdentity(identity.wallet), ports = createGemsBrowserPorts(who, page, async () => undefined), guard = ports.capture(who, true);
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({}), get = vi.spyOn(api, 'get').mockResolvedValue({});
    const body = { idempotencyKey: 'fixed-key', keep: '10' };
    await ports.post('/gems/from-keep', body, guard); await ports.get('/gems', guard);
    expect(post.mock.calls[0]?.[1]).toBe(body);
    const beforePost = post.mock.calls[0]?.[2]?.isCurrent, beforeGet = get.mock.calls[0]?.[1]?.isCurrent;
    expect(beforePost?.()).toBe(true); expect(beforeGet?.()).toBe(true);
    useApp.setState({ wallet: 'other' }); expect(beforePost).toThrow(); expect(beforeGet).toThrow();
  });
  it('missing browser locking refuses instead of sending an uncoordinated mutation', async () => {
    vi.stubGlobal('navigator', {});
    const mutate = vi.fn(async () => undefined);
    await expect(gemsBrowserLock('test', mutate)).rejects.toThrow('browser'); expect(mutate).not.toHaveBeenCalled();
  });
});

const funds = { keep: '10', shards: '20', gems: '30', keepRate: 1 };
const directory = () => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: base, status: 'active', slot: 1 }] });
const read = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return directory();
  if (path.startsWith('/balances')) return funds;
  throw new Error(`Unexpected ${path}`);
};
describe('Gems original destination hydration', () => {
  it('reads original base SHARDS without replacing the currently selected other base', async () => {
    useApp.setState({ selectedBaseId: '00000000-0000-4000-8000-000000000099', balances: { ...funds, shards: '999' } });
    const get = vi.spyOn(api, 'get').mockImplementation(read as typeof api.get);
    await hydrateGemsDestination(identity.wallet, intent('gems-to-shards'), () => undefined);
    expect(get).toHaveBeenCalledWith(`/balances?baseId=${base}`, expect.anything()); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('a paused feature still refreshes legacy balances without reading the gated Gems catalogue', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async path => path.startsWith('/balances') ? { keep: '8', shards: '20', keepRate: 1 } as never : await read(path) as never);
    await hydrateGemsDestination(identity.wallet, intent(), () => undefined);
    expect(get).not.toHaveBeenCalledWith('/gems', expect.anything()); expect(useApp.getState().balances?.keep).toBe('8');
  });
  it('missing original ownership preserves historical proof without guessing another destination', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async path => path === '/bases' ? { ...directory(), bases: [] } as never : await read(path) as never);
    await hydrateGemsDestination(identity.wallet, intent('gems-to-shards'), () => undefined);
    expect(get.mock.calls.some(([path]) => path.startsWith('/balances'))).toBe(false);
  });
  it.each(['authority outage', 'malformed balance', 'changed directory', 'wrong wallet'])('%s leaves balance hydration incomplete', async problem => {
    let count = 0;
    vi.spyOn(api, 'get').mockImplementation(async path => {
      if (path === '/me' && problem === 'wrong wallet') return { wallet: 'other' } as never;
      if (path === '/bases' && ++count === 2 && problem === 'changed directory') return { ...directory(), bases: [] } as never;
      if (path.startsWith('/balances')) {
        if (problem === 'authority outage') throw new Error('authority unavailable');
        if (problem === 'malformed balance') return { ...funds, shards: '1e3' } as never;
      }
      return await read(path) as never;
    });
    await expect(hydrateGemsDestination(identity.wallet, intent('gems-to-shards'), () => undefined)).rejects.toThrow();
  });
});
