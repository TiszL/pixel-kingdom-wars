/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp } from '../../state/store';
import { base, directory, funds } from '../workshop/snapshot.test-support';
import type { StarterFleetPorts } from './controller';
import { refreshStarterFleetSnapshot } from './snapshot';
import { id, identity, installation, proof, start, view } from './fixtures.test-support';
let ports: StarterFleetPorts;
const read = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return directory();
  if (path.startsWith('/base?')) return base();
  if (path.startsWith('/balances?')) return funds;
  if (path.startsWith('/starter-fleet?')) return view();
  throw new Error(`Unexpected current fleet read ${path}`);
};
beforeEach(() => {
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBalances({ ...funds, shards: '999' });
  ports = { get: vi.fn(read), getProof: vi.fn(), post: vi.fn(), capture: () => () => undefined, lock: async (_name, run) => run(), key: () => id(2) };
});
afterEach(() => { useApp.getState().setAuth(null); vi.restoreAllMocks(); });
describe('starter installation authoritative current fleet', () => {
  it('uses positive family berth evidence without a client building-level heuristic and commits base/funds together', async () => {
    ports.get = vi.fn(async path => path.startsWith('/base?') ? { ...base(), buildings: [] } : path.startsWith('/starter-fleet?') ? view(true) : read(path));
    const publications: string[] = [], stop = useApp.subscribe(state => publications.push(`${state.base?.baseId}/${state.balances?.shards}`));
    const result = await refreshStarterFleetSnapshot(identity, ports); stop();
    expect(result).toMatchObject({ enabled: true, view: { installation: installation(), eligibleBerths: view(true).eligibleBerths } });
    expect(publications).toEqual([`${id(1)}/${funds.shards}`]);
    expect(vi.mocked(ports.get).mock.calls.map(([path]) => path)).toEqual(['/me', '/bases', `/base?baseId=${id(1)}`, `/balances?baseId=${id(1)}`, `/starter-fleet?baseId=${id(1)}`, '/me', '/bases']);
    expect(ports.getProof).not.toHaveBeenCalled(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['no-completed-berth', 'paused'] as const)('%s retains current fleet discovery while refusing new controls', async kind => {
    ports.get = vi.fn(async path => path.startsWith('/starter-fleet?') ? kind === 'paused' ? { ...view(true), acceptingInstallations: false }
      : { ...view(), eligibleBerths: [] } : read(path));
    const result = await refreshStarterFleetSnapshot(identity, ports);
    expect(result?.enabled).toBe(false); expect(result?.view.installation).toEqual(kind === 'paused' ? installation() : null);
    expect(useApp.getState().balances).toEqual(funds); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['historical-receipt', 'foreign-view', 'inconsistent-installation'] as const)('%s cannot replace an authorized current fleet snapshot', async kind => {
    ports.get = vi.fn(async path => {
      if (!path.startsWith('/starter-fleet?')) return read(path);
      if (kind === 'historical-receipt') return proof(start, true);
      if (kind === 'foreign-view') return { ...view(), wallet: 'So11111111111111111111111111111111111111112', baseId: id(9) };
      return { ...view(true), eligibleBerths: [{ ...view(true).eligibleBerths[0], completedBuildJobId: id(9) }] };
    });
    await expect(refreshStarterFleetSnapshot(identity, ports)).rejects.toThrow(); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('ownership transfer between bracket reads rejects the complete view without publishing buyer fleet or funds', async () => {
    let reads = 0;
    ports.get = vi.fn(async path => path === '/bases' && ++reads === 2 ? { ...directory(), bases: [] } : read(path));
    await expect(refreshStarterFleetSnapshot(identity, ports)).rejects.toThrow('ownership changed');
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('selected-base ABA during fleet hydration retires both the returned view and the pending global publication', async () => {
    ports.get = vi.fn(async path => { if (path.startsWith('/starter-fleet?')) { useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); } return read(path); });
    await expect(refreshStarterFleetSnapshot(identity, ports)).rejects.toThrow('selected base changed'); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('a newer authoritative balance publication defeats an older installation refresh without partial fleet writes', async () => {
    ports.get = vi.fn(async path => { if (path.startsWith('/starter-fleet?')) expect(captureBaseBalanceCommit(id(1))({ ...funds, shards: '80000' })).toBe(true); return read(path); });
    await expect(refreshStarterFleetSnapshot(identity, ports)).rejects.toThrow('newer base refresh');
    expect(useApp.getState().balances?.shards).toBe('80000'); expect(useApp.getState().base).toBeNull();
  });
  it('a lost original destination never hydrates the newly selected kingdom while finishing historical acceptance', async () => {
    useApp.getState().setSelectedBaseId(id(9), false);
    ports.get = vi.fn(async path => path === '/bases' ? { ...directory(), bases: [{ id: id(9), status: 'active', slot: 1 }] } : read(path));
    expect(await refreshStarterFleetSnapshot(identity, ports, () => undefined, id(1))).toBeNull();
    expect(ports.get).toHaveBeenCalledTimes(2); expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('unverifiable original authority and failed final hydration remain errors, never fabricated destination loss', async () => {
    ports.get = vi.fn(async path => path === '/bases' ? { ...directory(), capabilities: { ...directory().capabilities, baseScopedReads: false } } : read(path));
    await expect(refreshStarterFleetSnapshot(identity, ports, () => undefined, id(1))).rejects.toThrow('authority cannot be established');
    let reads = 0; ports.get = vi.fn(async path => { if (path === '/me' && ++reads === 2) throw new Error('account refresh failed'); return read(path); });
    await expect(refreshStarterFleetSnapshot(identity, ports, () => undefined, id(1))).rejects.toThrow('account refresh failed');
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('caller retirement after the fleet read prevents current publication even with an unchanged wallet and base', async () => {
    let visible = true; ports.get = vi.fn(async path => { if (path.startsWith('/starter-fleet?')) visible = false; return read(path); });
    await expect(refreshStarterFleetSnapshot(identity, ports, () => { if (!visible) throw new Error('view retired'); })).rejects.toThrow('view retired');
    expect(useApp.getState().base).toBeNull(); expect(useApp.getState().balances?.shards).toBe('999');
  });
});
