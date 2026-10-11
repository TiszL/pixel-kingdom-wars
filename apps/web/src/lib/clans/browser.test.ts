/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { clanBrowserLock } from './controller';
import { createClanBrowserPorts, refreshClanDestination } from './browser';
import { baseA, baseB, clanId, directory, identity, intent, key, mine, receipt, target } from './fixtures.test-support';
const balances = { keep: '10', shards: '20', keepRate: 1 };
const page = () => ({ active: true, visible: true, epoch: 0 });
const read = () => vi.fn(async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet, entryPaid: true };
  if (path === '/bases') return directory(); if (path === '/clans/mine') return mine();
  if (path === '/clans') return { clans: [] }; if (path.startsWith('/balances')) return balances;
  throw new Error(`Unexpected ${path}`);
});
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet, selectedBaseId: baseA, baseSelectionEpoch: 0, entryPaid: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.setState({ authed: false, wallet: null }); });
describe('browser clan original consent and destination', () => {
  it('new consent binds fresh server mode, exact selected original base and current clan', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const ports = createClanBrowserPorts(identity, page);
    expect(await ports.consent({ kind: 'leave', clanId }, key, () => undefined)).toEqual(intent());
    const d = directory(); d.enabled = false; vi.mocked(api.get).mockImplementation(async (path) => path === '/bases' ? d : await read()(path) as never);
    expect((await ports.consent({ kind: 'leave', clanId }, key, () => undefined)).request).toHaveProperty('baseId', null);
  });
  it('review refuses stale clan, leader with members, self kick and unavailable selected deed', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const ports = createClanBrowserPorts(identity, page);
    await expect(ports.consent({ kind: 'leave', clanId: baseB }, key, () => undefined)).rejects.toThrow('clan changed');
    await expect(ports.consent({ kind: 'kick', clanId, target: identity.wallet }, key, () => undefined)).rejects.toThrow('cannot be removed');
    useApp.setState({ selectedBaseId: null }); await expect(ports.consent({ kind: 'leave', clanId }, key, () => undefined)).rejects.toThrow('destination');
    useApp.setState({ selectedBaseId: baseA }); const members = mine(); members.clan.roster.push({ wallet: target });
    vi.mocked(api.get).mockImplementation(async (path) => path === '/clans/mine' ? members : await read()(path) as never);
    await expect(ports.consent({ kind: 'leave', clanId }, key, () => undefined)).rejects.toThrow('Remove other members');
  });
  it('explicit retry validates original A despite selected B, without reinterpreting current clan membership', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const ports = createClanBrowserPorts(identity, page);
    useApp.setState({ selectedBaseId: baseB }); await ports.validate(intent(), () => undefined, true);
    expect(api.get).not.toHaveBeenCalledWith('/clans/mine'); await expect(ports.validate(intent(), () => undefined, false)).rejects.toThrow('currently selected');
  });
  it('refreshes the exact original payout A, never selected B; all history reads stay GET-only', async () => {
    const get = read(); useApp.setState({ selectedBaseId: baseB });
    const result = await refreshClanDestination(identity.wallet, receipt(), get as typeof api.get, () => undefined);
    expect(result.hydration).toEqual({ membershipAvailable: true, originalPayout: 'refreshed' });
    expect(get).toHaveBeenCalledWith(`/balances?baseId=${baseA}`); expect(get).not.toHaveBeenCalledWith(`/balances?baseId=${baseB}`);
  });
  it.each(['missing', 'inactive', 'slotless', 'wallet-mode-changed', 'landless'] as const)('%s gives original destination unavailable without a guaranteed-refused balance read or transfer claim', async (mode) => {
    const d = directory(); let proof = receipt();
    if (mode === 'missing') d.bases = d.bases.filter((b) => b.id !== baseA);
    if (mode === 'inactive') d.bases[0]!.status = 'inactive'; if (mode === 'slotless') d.bases[0]!.slot = null;
    if (mode === 'wallet-mode-changed') proof = { ...proof, baseId: null };
    const get = vi.fn(async (path: string) => path === '/bases' ? d : path === '/me' ? { wallet: identity.wallet, entryPaid: mode !== 'landless' } : read()(path));
    const result = await refreshClanDestination(identity.wallet, proof, get as typeof api.get, () => undefined);
    expect(result.hydration.originalPayout).toBe('unavailable'); expect(get.mock.calls.some(([path]) => path.startsWith('/balances'))).toBe(false);
    if (mode === 'landless') expect(get).not.toHaveBeenCalledWith('/clans/mine');
  });
  it('unavailable final authority, bad balances, or changing directory retain incomplete hydration', async () => {
    for (const problem of ['RPC', 'balances', 'directory']) {
      let count = 0; const get = vi.fn(async (path: string): Promise<unknown> => {
        if (path.startsWith('/balances')) { if (problem === 'RPC') throw new Error('authority unavailable'); if (problem === 'balances') return {}; }
        if (path === '/bases' && ++count === 2 && problem === 'directory') return { ...directory(), bases: [] }; return read()(path);
      });
      await expect(refreshClanDestination(identity.wallet, receipt(), get as typeof api.get, () => undefined)).rejects.toThrow();
    }
  });
  it('zero payout dissolution still records a consistent original destination refresh', async () => {
    const result = await refreshClanDestination(identity.wallet, { ...receipt(), payoutShards: '0', ledgerTransactionId: null }, read() as typeof api.get, () => undefined);
    expect(result.hydration.originalPayout).toBe('refreshed');
  });
  it('payout hydration never overwrites B HUD and session/base/visibility epochs fence new consent, not history ownership', async () => {
    vi.spyOn(api, 'get').mockImplementation(read() as typeof api.get); const life = page(); const ports = createClanBrowserPorts(identity, () => life);
    const approval = ports.capture(true); const history = ports.capture(false); useApp.setState({ selectedBaseId: baseB, balances: { ...balances, shards: '999' }, entryPaid: false });
    expect(approval).toThrow('base or page'); expect(history).not.toThrow(); await ports.hydrate(receipt(), history);
    expect(useApp.getState().balances?.shards).toBe('999'); const current = ports.capture(true); life.visible = false; expect(current).toThrow();
    life.visible = true; life.epoch++; expect(current).toThrow(); const after = ports.capture(false); useApp.setState({ wallet: target }); expect(after).toThrow();
  });
  it('refuses missing/busy Web Locks and passes a final pre-transport guard without changing exact POST body', async () => {
    vi.stubGlobal('navigator', {}); await expect(clanBrowserLock('clan', async () => undefined)).rejects.toThrow('Update your browser');
    vi.stubGlobal('navigator', { locks: { request: async (_n: unknown, _o: unknown, fn: (v: null) => Promise<void>) => fn(null) } });
    await expect(clanBrowserLock('clan', async () => undefined)).rejects.toThrow('Another tab');
    const ports = createClanBrowserPorts(identity, page); vi.spyOn(api, 'postRaw').mockResolvedValue({}); const guard = vi.fn();
    await ports.post('/clans/v1/leave', intent().request, guard); const options = vi.mocked(api.postRaw).mock.calls[0]![2];
    expect(options?.isCurrent?.()).toBe(true); expect(guard).toHaveBeenCalledOnce(); expect(ports.unsupported(new ApiError(404, 'missing'))).toBe(true);
  });
});
