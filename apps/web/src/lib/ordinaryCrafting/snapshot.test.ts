/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBaseBalanceCommit, captureBaseSnapshotCommit } from '../../state/baseSnapshot';
import { useApp } from '../../state/store';
import { base, directory, funds } from '../workshop/snapshot.test-support';
import { refreshOrdinaryCraftingSnapshot } from './snapshot';
import type { OrdinaryCraftingPorts } from './controller';
import { id, identity, proof, view } from './fixtures.test-support';
let ports: OrdinaryCraftingPorts;
const snapshotRead = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return directory();
  if (path.startsWith('/base?')) return base();
  if (path.startsWith('/balances?')) return funds;
  if (path.startsWith('/ordinary-crafting?')) return view();
  throw new Error(`Unexpected current snapshot request ${path}`);
};
beforeEach(() => {
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBalances({ ...funds, shards: '999' });
  ports = { get: vi.fn(snapshotRead), getProof: vi.fn(), post: vi.fn(), capture: () => () => undefined,
    lock: async (_name, run) => run(), key: () => id(2) };
});
afterEach(() => { useApp.getState().setAuth(null); vi.restoreAllMocks(); });
describe('ordinary refining current authorized snapshot', () => {
  it('brackets identity and ownership and publishes base plus funds together, with raw/protected stock only from the current family view', async () => {
    const publications: string[] = [], stop = useApp.subscribe(state => publications.push(`${state.base?.baseId}/${state.balances?.shards}`));
    const result = await refreshOrdinaryCraftingSnapshot(identity, ports); stop();
    expect(publications).toEqual([`${id(1)}/${funds.shards}`]); expect(result).toMatchObject({ enabled: true, workshopLevel: 1, balances: funds });
    expect(result?.view.rawStock).toEqual(view().rawStock); expect(result?.view.craftingStock).toEqual(view().craftingStock);
    expect(vi.mocked(ports.get).mock.calls.map(([path]) => path)).toEqual(['/me', '/bases', `/base?baseId=${id(1)}`, `/balances?baseId=${id(1)}`, `/ordinary-crafting?baseId=${id(1)}&catalogueVersion=2`, '/me', '/bases']);
    expect(ports.getProof).not.toHaveBeenCalled(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['wallet', 'base', 'base-wallet', 'view-base', 'view-wallet', 'historical-proof', 'raw-conservation', 'protected-pending', 'funds', 'rate', 'ownership', 'closing-wallet'] as const)('invalid %s response cannot publish foreign, partial or historical quantities', async bad => {
    let meReads = 0, directoryReads = 0;
    ports.get = vi.fn(async path => {
      if (path === '/me') { meReads++; if (bad === 'wallet' || bad === 'closing-wallet' && meReads === 2) return { wallet: 'So11111111111111111111111111111111111111112' }; }
      if (path.startsWith('/base?')) {
        if (bad === 'base') return { ...base(), baseId: id(9) };
        if (bad === 'base-wallet') return { ...base(), player: { ...base().player, wallet: 'So11111111111111111111111111111111111111112' } };
      }
      if (path.startsWith('/ordinary-crafting?')) {
        if (bad === 'view-base') return { ...view(), baseId: id(9) };
        if (bad === 'view-wallet') return { ...view(), wallet: 'So11111111111111111111111111111111111111112' };
        if (bad === 'historical-proof') return proof(undefined, true);
        if (bad === 'raw-conservation') { const raw = view(); raw.rawStock[0]!.reserved = '1'; return raw; }
        if (bad === 'protected-pending') { const raw = view(); raw.craftingStock[0]!.pendingOutput = '1'; return raw; }
      }
      if (path.startsWith('/balances?')) {
        if (bad === 'funds') return { ...funds, shards: '-1' };
        if (bad === 'rate') return { ...funds, keepRate: '1' };
      }
      if (path === '/bases' && ++directoryReads === 2 && bad === 'ownership') return { ...directory(), bases: [] };
      return snapshotRead(path);
    });
    await expect(refreshOrdinaryCraftingSnapshot(identity, ports)).rejects.toThrow(); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it.each(['absent', 'constructing', 'zero', 'coerced', 'paused'] as const)('%s admission still displays current stock while withholding new-job controls', async mode => {
    ports.get = vi.fn(async path => {
      if (path.startsWith('/base?')) {
        const current = base();
        if (mode === 'absent') current.buildings = [];
        else if (mode === 'constructing') current.buildings[0]!.underConstruction = true;
        else if (mode === 'zero') current.buildings[0]!.level = 0;
        else if (mode === 'coerced') return { ...current, buildings: [{ ...current.buildings[0], level: '1' }] };
        return current;
      }
      return path.startsWith('/ordinary-crafting?') && mode === 'paused' ? { ...view(), acceptingJobs: false } : snapshotRead(path);
    });
    const result = await refreshOrdinaryCraftingSnapshot(identity, ports);
    expect(result?.enabled).toBe(false); expect(result?.workshopLevel).toBe(mode === 'paused' ? 1 : 0);
    expect(result?.view.rawStock).toEqual(view().rawStock); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['missing', 'inactive', 'unslotted', 'disabled', 'unreadable', 'no-selection'] as const)('%s current authority returns unavailable without substituting another base', async mode => {
    const owned = directory();
    if (mode === 'missing') owned.bases = [];
    else if (mode === 'inactive') owned.bases[0]!.status = 'inactive';
    else if (mode === 'disabled') owned.enabled = false;
    else if (mode === 'unreadable') owned.capabilities.baseScopedReads = false;
    else if (mode === 'no-selection') useApp.getState().setSelectedBaseId(null, false);
    ports.get = vi.fn(async path => path === '/bases' ? mode === 'unslotted' ? { ...owned, bases: [{ ...owned.bases[0], slot: null }] } : owned : snapshotRead(path));
    expect(await refreshOrdinaryCraftingSnapshot(identity, ports)).toBeNull(); expect(ports.get).toHaveBeenCalledTimes(2); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('original destination loss permits historical finish without hydrating another selected kingdom', async () => {
    useApp.getState().setSelectedBaseId(id(9), false);
    ports.get = vi.fn(async path => path === '/bases' ? { ...directory(), bases: [{ id: id(9), status: 'active', slot: 1 }] } : snapshotRead(path));
    expect(await refreshOrdinaryCraftingSnapshot(identity, ports, () => undefined, id(1))).toBeNull();
    expect(ports.get).toHaveBeenCalledTimes(2); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it.each(['disabled', 'unreadable', 'malformed'] as const)('%s original authority fails hydration rather than pretending the destination was lost', async mode => {
    ports.get = vi.fn(async path => path === '/bases' ? mode === 'disabled' ? { ...directory(), enabled: false }
      : mode === 'unreadable' ? { ...directory(), capabilities: { ...directory().capabilities, baseScopedReads: false } } : { enabled: true } : snapshotRead(path));
    await expect(refreshOrdinaryCraftingSnapshot(identity, ports, () => undefined, id(1))).rejects.toThrow();
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it.each(['base-aba', 'account', 'caller', 'session'] as const)('%s invalidation while responses arrive fences both global publication and returned view', async kind => {
    let visible = true, sessionCurrent = true;
    ports.capture = () => () => { if (!sessionCurrent) throw new Error('old session'); };
    ports.get = vi.fn(async path => {
      if (path.startsWith('/ordinary-crafting?')) {
        if (kind === 'base-aba') { useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); }
        else if (kind === 'account') useApp.getState().setAuth('So11111111111111111111111111111111111111112');
        else if (kind === 'caller') visible = false;
        else sessionCurrent = false;
      }
      return snapshotRead(path);
    });
    await expect(refreshOrdinaryCraftingSnapshot(identity, ports, () => { if (!visible) throw new Error('dismissed'); })).rejects.toThrow();
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).not.toBe(funds.shards);
  });
  it.each(['balance', 'full'] as const)('a newer %s publication defeats older refining hydration without partial writes', async kind => {
    const newer = { ...funds, shards: '80000' };
    ports.get = vi.fn(async path => {
      if (path.startsWith('/ordinary-crafting?')) {
        expect(kind === 'balance' ? captureBaseBalanceCommit(id(1))(newer) : captureBaseSnapshotCommit(id(1))(base(), newer)).toBe(true);
      }
      return snapshotRead(path);
    });
    await expect(refreshOrdinaryCraftingSnapshot(identity, ports)).rejects.toThrow('newer base refresh');
    expect(useApp.getState().balances).toEqual(newer); expect(useApp.getState().base).toEqual(kind === 'balance' ? null : base());
  });
  it('a failed final ownership read keeps previous current stock intact and is not retried implicitly', async () => {
    let calls = 0;
    ports.get = vi.fn(async path => { if (path === '/bases' && ++calls === 2) throw new Error('ownership unavailable'); return snapshotRead(path); });
    await expect(refreshOrdinaryCraftingSnapshot(identity, ports)).rejects.toThrow('ownership unavailable');
    expect(calls).toBe(2); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
});
