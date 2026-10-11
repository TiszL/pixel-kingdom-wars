/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { playSfx } from '../audio';
import { haptic } from '../juice';
vi.mock('../audio', () => ({ playSfx: vi.fn() }));
vi.mock('../juice', () => ({ haptic: vi.fn() }));
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { forgeClaimBrowserLock } from './controller';
import { createForgeClaimBrowserPorts, refreshForgeClaimDestination } from './browser';
import { baseA, baseB, directory, identity, intent, key, receipt, target } from './fixtures.test-support';
const balances = { keep: '10', shards: '20', keepRate: 1 };
const page = () => ({ active: true, visible: true, epoch: 0 });
const read = () => vi.fn(async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet, entryPaid: true };
  if (path === '/bases') return directory(); if (path.startsWith('/balances')) return balances;
  throw new Error(`Unexpected ${path}`);
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet, selectedBaseId: baseA, baseSelectionEpoch: 0, entryPaid: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.setState({ authed: false, wallet: null }); });
describe('Forge browser original wallet payout and transport', () => {
  it('successful explicit claim callback preserves the original confirm sound and light haptic', () => {
    const ports = createForgeClaimBrowserPorts(identity, page); ports.confirmed();
    expect(playSfx).toHaveBeenCalledExactlyOnceWith('sfx_confirm'); expect(haptic).toHaveBeenCalledExactlyOnceWith('light');
  });
  it('new consent keeps exact nullable day and explicit original visible base under fresh authority', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const ports = createForgeClaimBrowserPorts(identity, page);
    expect(await ports.consent({ baseId: baseA, day: '2026-09-11' }, key, () => undefined)).toEqual(intent('2026-09-11'));
    const d = directory(); d.enabled = false; vi.mocked(api.get).mockImplementation(async path => path === '/bases' ? d : await read()(path) as never);
    expect(await ports.consent({ baseId: null, day: null }, key, () => undefined)).toEqual(intent(null, null));
  });
  it('unavailable original deed and stale selected scope refuse new consent before POST', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const ports = createForgeClaimBrowserPorts(identity, page);
    useApp.setState({ selectedBaseId: baseB }); await expect(ports.validate(intent(), () => undefined, false)).rejects.toThrow('currently on screen');
    const d = directory(); d.bases = d.bases.filter(b => b.id !== baseA); vi.mocked(api.get).mockImplementation(async path => path === '/bases' ? d : await read()(path) as never);
    await expect(ports.validate(intent(), () => undefined, true)).rejects.toThrow('unavailable');
  });
  it('explicit retry uses A despite selected B and preserves wallet null through a multi-base transition', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const ports = createForgeClaimBrowserPorts(identity, page);
    useApp.setState({ selectedBaseId: baseB }); await ports.validate(intent(), () => undefined, true); await ports.validate(intent(null, null), () => undefined, true);
    expect(api.get).not.toHaveBeenCalledWith('/forge'); expect(api.get).not.toHaveBeenCalledWith('/wallet/balances');
  });
  it('payout reads exact original A wallet KEEP without selected B or on-chain substitution', async () => {
    const get = read(); useApp.setState({ selectedBaseId: baseB });
    const result = await refreshForgeClaimDestination(identity.wallet, receipt(), get as typeof api.get, () => undefined);
    expect(result.hydration).toEqual({ walletKeep: 'refreshed' }); expect(result.balances).toEqual(balances);
    expect(get).toHaveBeenCalledWith(`/balances?baseId=${baseA}`); expect(get).not.toHaveBeenCalledWith(`/balances?baseId=${baseB}`); expect(get).not.toHaveBeenCalledWith('/wallet/balances');
  });
  it.each(['missing', 'inactive', 'slotless', 'wallet-mode-changed', 'landless'])('%s records unavailable without guessing transfer or issuing guaranteed-refused balance read', async mode => {
    const d = directory(); let proof = receipt(); if (mode === 'missing') d.bases = d.bases.filter(b => b.id !== baseA);
    if (mode === 'inactive') d.bases[0]!.status = 'inactive'; if (mode === 'slotless') d.bases[0]!.slot = null;
    if (mode === 'wallet-mode-changed') proof = { ...proof, baseId: null };
    const get = vi.fn(async (path: string) => path === '/bases' ? d : path === '/me' ? { wallet: identity.wallet, entryPaid: mode !== 'landless' } : read()(path));
    const result = await refreshForgeClaimDestination(identity.wallet, proof, get as typeof api.get, () => undefined);
    expect(result.hydration.walletKeep).toBe('unavailable'); expect(result.balances).toBeNull(); expect(get.mock.calls.some(([p]) => p.startsWith('/balances'))).toBe(false);
  });
  it('historical wallet mode reads custodial wallet balance even after land loss and empty claim still hydrates', async () => {
    const get = vi.fn(async (path: string) => path === '/bases' ? { ...directory(), enabled: false } : path === '/me' ? { wallet: identity.wallet, entryPaid: false } : read()(path));
    const result = await refreshForgeClaimDestination(identity.wallet, receipt(null, null, true), get as typeof api.get, () => undefined);
    expect(result.hydration.walletKeep).toBe('refreshed'); expect(get).toHaveBeenCalledWith('/balances'); expect(get).not.toHaveBeenCalledWith('/wallet/balances');
  });
  it('RPC failure malformed funds mismatched account or changed directory keeps hydration incomplete', async () => {
    for (const problem of ['RPC', 'balance', 'account', 'directory']) {
      let count = 0; const get = vi.fn(async (path: string): Promise<unknown> => {
        if (path.startsWith('/balances')) { if (problem === 'RPC') throw new Error('authority unavailable'); if (problem === 'balance') return { ...balances, keep: '1e4' }; }
        if (path === '/me' && problem === 'account') return { wallet: target, entryPaid: true };
        if (path === '/bases' && ++count === 2 && problem === 'directory') return { ...directory(), bases: [] }; return read()(path);
      });
      await expect(refreshForgeClaimDestination(identity.wallet, receipt(), get as typeof api.get, () => undefined)).rejects.toThrow();
    }
  });
  it('custodial wallet KEEP hydration rejects numeric JSON and unsafe integer amount aliases', async () => {
    for (const keep of [10, '9223372036854775808', '01']) {
      const get = vi.fn(async (path: string) => path.startsWith('/balances') ? { ...balances, keep } : read()(path));
      await expect(refreshForgeClaimDestination(identity.wallet, receipt(), get as typeof api.get, () => undefined)).rejects.toThrow();
    }
  });
  it('original A hydration cannot publish into B HUD and approval checks page session or selection epoch', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const life = page(), ports = createForgeClaimBrowserPorts(identity, () => life);
    const approval = ports.capture(true), history = ports.capture(false); useApp.setState({ selectedBaseId: baseB, balances: { ...balances, keep: '999' }, entryPaid: false });
    expect(approval).toThrow('base or page'); expect(history).not.toThrow(); await ports.hydrate(receipt(), history); expect(useApp.getState().balances?.keep).toBe('999');
    const next = ports.capture(true); life.visible = false; expect(next).toThrow(); life.visible = true; life.epoch++; expect(next).toThrow();
    const active = ports.capture(false); useApp.setState({ wallet: target }); expect(active).toThrow();
  });
  it('Web Locks fail closed and final transport option rechecks exact current intent without body conversion', async () => {
    vi.stubGlobal('navigator', {}); await expect(forgeClaimBrowserLock('forge', async () => undefined)).rejects.toThrow('Update your browser');
    vi.stubGlobal('navigator', { locks: { request: async (_n: unknown, _o: unknown, fn: (v: null) => Promise<void>) => fn(null) } });
    await expect(forgeClaimBrowserLock('forge', async () => undefined)).rejects.toThrow('Another tab');
    const ports = createForgeClaimBrowserPorts(identity, page); vi.spyOn(api, 'postRaw').mockResolvedValue({}); let active = true;
    const guard = vi.fn(() => { if (!active) throw new Error('stale callback'); });
    await ports.post('/forge/claims/v1', intent().request, guard); const call = vi.mocked(api.postRaw).mock.calls[0]!;
    expect(call.slice(0, 2)).toEqual(['/forge/claims/v1', intent().request]); expect(call[2]?.isCurrent?.()).toBe(true); active = false;
    expect(() => call[2]?.isCurrent?.()).toThrow('stale callback'); expect(ports.unsupported(new ApiError(404, 'missing'))).toBe(true);
  });
});
