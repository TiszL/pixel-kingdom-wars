/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBaseSnapshotCommit, captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp } from '../../state/store';
import { refreshWorkshopSnapshot } from './snapshot';
import type { WorkshopPorts } from './controller';
import { id, identity, view } from './fixtures.test-support';
import { base, directory, funds, snapshotRead } from './snapshot.test-support';
let ports: WorkshopPorts;
beforeEach(() => {
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBalances({ ...funds, shards: '999' });
  ports = { get: vi.fn(snapshotRead), post: vi.fn(), capture: () => () => undefined, lock: async (_n, run) => run(), clock: () => ({ wall: 0, elapsed: 0 }), key: () => 'original-key' };
});
afterEach(() => { useApp.getState().setAuth(null); vi.restoreAllMocks(); });
describe('Workshop authoritative selected-base refresh', () => {
  it('brackets base/balances/view with fresh wallet ownership and commits base plus balances together', async () => {
    const publications: string[] = [], stop = useApp.subscribe(s => { publications.push(`${s.base?.baseId}/${s.balances?.shards}`); });
    const result = await refreshWorkshopSnapshot(identity, ports); stop();
    expect(publications).toEqual([`${id(1)}/70000`]); expect(result?.view.inventory.held).toBe(1); expect(result?.view.allowance.holding.held).toBe(3);
    expect(vi.mocked(ports.get).mock.calls.map(([p]) => p)).toEqual(['/me', '/bases', `/base?baseId=${id(1)}`, `/balances?baseId=${id(1)}`, `/workshop?baseId=${id(1)}`, '/native/capabilities', '/me', '/bases']);
  });
  it.each(['wallet', 'base', 'view', 'funds', 'ownership'] as const)('wrong %s response cannot publish historical or foreign stock', async bad => {
    let directories = 0;
    ports.get = vi.fn(async path => {
      if (bad === 'wallet' && path === '/me') return { wallet: 'another-wallet' };
      if (bad === 'base' && path.startsWith('/base?')) return { ...base(), baseId: id(9) };
      if (bad === 'view' && path.startsWith('/workshop?')) return { ...view(), inventory: { ...view().inventory, baseId: id(9) } };
      if (bad === 'funds' && path.startsWith('/balances?')) return { ...funds, shards: '-1' };
      if (bad === 'ownership' && path === '/bases' && ++directories === 2) return { ...directory(), bases: [] };
      return snapshotRead(path);
    });
    await expect(refreshWorkshopSnapshot(identity, ports)).rejects.toThrow(); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('missing current ownership is an unavailable destination and never substitutes another base', async () => {
    ports.get = vi.fn(async path => path === '/bases' ? { ...directory(), bases: [] } : snapshotRead(path));
    expect(await refreshWorkshopSnapshot(identity, ports)).toBeNull(); expect(ports.get).toHaveBeenCalledTimes(2); expect(useApp.getState().balances?.shards).toBe('999');
  });
  it('selection changed while a response arrives fences both global publication and the returned view', async () => {
    ports.get = vi.fn(async path => { if (path.startsWith('/workshop?')) useApp.getState().setSelectedBaseId(id(9), false); return snapshotRead(path); });
    await expect(refreshWorkshopSnapshot(identity, ports)).rejects.toThrow('selected base changed'); expect(useApp.getState().balances?.shards).not.toBe('70000');
  });
  it('shares base ordering so a newer balance or full snapshot defeats an older feature refresh without partial writes', () => {
    const old = captureBaseSnapshotCommit(id(1)); captureBaseBalanceCommit(id(1))({ ...funds, shards: '80000' });
    expect(old(base(), funds)).toBe(false); expect(useApp.getState().balances?.shards).toBe('80000');
    const wrong = captureBaseSnapshotCommit(id(9)); expect(wrong({ ...base(), baseId: id(9) }, funds)).toBe(false);
    const current = captureBaseSnapshotCommit(id(1)); expect(current({ ...base(), player: { ...base().player, wallet: 'another-wallet' } }, funds)).toBe(false);
    expect(current(base(), funds)).toBe(true);
  });
});
