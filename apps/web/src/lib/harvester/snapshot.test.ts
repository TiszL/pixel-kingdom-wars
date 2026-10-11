/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp } from '../../state/store';
import { base, directory, funds } from '../workshop/snapshot.test-support';
import type { HarvesterPorts } from './controller';
import { refreshHarvesterSnapshot } from './snapshot';
import { id, identity, proof, start, view } from './fixtures.test-support';
let ports: HarvesterPorts;
const read = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return directory();
  if (path.startsWith('/base?')) return base();
  if (path.startsWith('/balances?')) return funds;
  if (path.startsWith('/harvesters?')) return view();
  throw new Error(`Unexpected current Harvester read ${path}`);
};
beforeEach(() => {
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBalances({ ...funds, shards: '999' });
  ports = { get: vi.fn(read), getProof: vi.fn(), post: vi.fn(), capture: () => () => undefined, lock: async (_name, run) => run(), key: () => id(2) };
});
afterEach(() => { useApp.getState().setAuth(null); vi.restoreAllMocks(); });
describe('Harvester current authority and automatic stock', () => {
  it('uses complete family home/completed-facility proofs and publishes current resources independently of historical earning observations', async () => {
    ports.get = vi.fn(async path => path.startsWith('/base?') ? { ...base(), buildings: [] } : read(path));
    const publications: string[] = [], stop = useApp.subscribe(state => publications.push(`${state.base?.baseId}/${state.balances?.shards}`));
    const result = await refreshHarvesterSnapshot(identity, ports); stop();
    expect(result?.enabled).toBe(true); expect(result?.view).toEqual(view()); expect(publications).toEqual([`${id(1)}/${funds.shards}`]);
    expect(ports.getProof).not.toHaveBeenCalled(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['home', 'facility', 'provider'] as const)('%s unavailability still displays current raw stock without enabling a selection', async kind => {
    const current = view();
    if (kind === 'home') current.home = null;
    else if (kind === 'facility') current.facilities = [];
    else current.acceptingSelections = false;
    ports.get = vi.fn(async path => path.startsWith('/harvesters?') ? current : read(path));
    const result = await refreshHarvesterSnapshot(identity, ports);
    expect(result?.enabled).toBe(false); expect(result?.view.rawStock).toEqual(current.rawStock); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['historical-earnings', 'foreign-view', 'wrong-wallet-head', 'unbalanced-stock'] as const)('%s cannot be published as current spendable stock', async kind => {
    ports.get = vi.fn(async path => {
      if (!path.startsWith('/harvesters?')) return read(path);
      if (kind === 'historical-earnings') return proof(start, true);
      if (kind === 'foreign-view') return { ...view(), wallet: 'So11111111111111111111111111111111111111112', baseId: id(9) };
      if (kind === 'wrong-wallet-head') {
        const accepted = proof(start, true); if (accepted.status !== 'accepted') throw new Error('fixture');
        const { sourceId, baseId, harvesterId, policyVersion, realmId, resourceId, admittedAt, leaseExpiresAt } = accepted.originalReceipt.source;
        return { ...view(), source: { sourceId, baseId, harvesterId, policyVersion, realmId, resourceId, admittedAt, leaseExpiresAt }, walletSource: null };
      }
      const current = view(); current.rawStock[0]!.reserved = '1'; return current;
    });
    await expect(refreshHarvesterSnapshot(identity, ports)).rejects.toThrow(); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('settlement-pending current read fails visibly without publishing stock or inventing a new source', async () => {
    ports.get = vi.fn(async path => { if (path.startsWith('/harvesters?')) throw new Error('HARVESTER_SETTLEMENT_PENDING'); return read(path); });
    await expect(refreshHarvesterSnapshot(identity, ports)).rejects.toThrow('HARVESTER_SETTLEMENT_PENDING');
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999'); expect(ports.post).not.toHaveBeenCalled();
  });
  it('a transfer between ownership brackets cannot publish the buyer source or resources', async () => {
    let reads = 0; ports.get = vi.fn(async path => path === '/bases' && ++reads === 2 ? { ...directory(), bases: [] } : read(path));
    await expect(refreshHarvesterSnapshot(identity, ports)).rejects.toThrow('ownership changed');
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('selected-base ABA rejects both the current Harvester result and global balance publication', async () => {
    ports.get = vi.fn(async path => { if (path.startsWith('/harvesters?')) { useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); } return read(path); });
    await expect(refreshHarvesterSnapshot(identity, ports)).rejects.toThrow('selected base changed'); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('newer authoritative balance publication defeats the older Harvester refresh', async () => {
    ports.get = vi.fn(async path => { if (path.startsWith('/harvesters?')) expect(captureBaseBalanceCommit(id(1))({ ...funds, shards: '80000' })).toBe(true); return read(path); });
    await expect(refreshHarvesterSnapshot(identity, ports)).rejects.toThrow('newer base refresh'); expect(useApp.getState().balances?.shards).toBe('80000'); expect(useApp.getState().base).toBeNull();
  });
  it('lost original destination permits historical finish without substituting another selected kingdom', async () => {
    useApp.getState().setSelectedBaseId(id(9), false);
    ports.get = vi.fn(async path => path === '/bases' ? { ...directory(), bases: [{ id: id(9), status: 'active', slot: 1 }] } : read(path));
    expect(await refreshHarvesterSnapshot(identity, ports, () => undefined, id(1))).toBeNull();
    expect(ports.get).toHaveBeenCalledTimes(2); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('unverifiable original authority remains a hydration error rather than simulated destination loss', async () => {
    ports.get = vi.fn(async path => path === '/bases' ? { ...directory(), capabilities: { ...directory().capabilities, baseScopedReads: false } } : read(path));
    await expect(refreshHarvesterSnapshot(identity, ports, () => undefined, id(1))).rejects.toThrow('authority cannot be established');
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('caller retirement during the family read prevents final stock publication', async () => {
    let visible = true; ports.get = vi.fn(async path => { if (path.startsWith('/harvesters?')) visible = false; return read(path); });
    await expect(refreshHarvesterSnapshot(identity, ports, () => { if (!visible) throw new Error('view retired'); })).rejects.toThrow('view retired');
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
});
