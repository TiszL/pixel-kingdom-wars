import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClanJournalStore, parseClanJournal } from './journal';
import { identity, intent, receipt, target } from './fixtures.test-support';
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); });
const store = () => new ClanJournalStore(identity, factory);
describe('exact durable clan consent', () => {
  it.each(['leave', 'kick'] as const)('restores %s before any attempted request without inventing a legacy key', async (kind) => {
    const s = store(); await s.compareAndSet(0, (r) => ({ ...r, intent: intent(kind) })); await s.close();
    const restored = await store().read(); expect(restored.intent).toEqual(intent(kind)); expect(restored.receipt).toBeNull();
    expect(Object.keys(restored).sort()).toEqual(['finished', 'hydrated', 'identity', 'intent', 'receipt', 'revision', 'version']);
  });
  it('cannot erase or replace unknown consent, mutate immutable proof, or Finish before hydration', async () => {
    const s = store(); await s.compareAndSet(0, (r) => ({ ...r, intent: intent() }));
    await expect(s.compareAndSet(1, (r) => ({ ...r, intent: null }))).rejects.toThrow('cannot be replaced');
    await expect(s.compareAndSet(1, (r) => ({ ...r, intent: intent('kick') }))).rejects.toThrow('cannot be replaced');
    await s.compareAndSet(1, (r) => ({ ...r, receipt: receipt() }));
    await expect(s.compareAndSet(2, (r) => ({ ...r, finished: true }))).rejects.toThrow('needs recovery');
    await expect(s.compareAndSet(2, (r) => ({ ...r, receipt: { ...receipt(), payoutShards: '1' } }))).rejects.toThrow('receipt changed');
    await s.compareAndSet(2, (r) => ({ ...r, hydrated: { membershipAvailable: false, originalPayout: 'unavailable' }, finished: true }));
    await expect(s.compareAndSet(3, (r) => ({ ...r, finished: false }))).rejects.toThrow('cannot be replayed');
    await expect(s.compareAndSet(3, (r) => ({ ...r, intent: intent('kick'), receipt: null, hydrated: null, finished: false }))).rejects.toThrow('distinct key');
    const next = intent('kick'); next.request.idempotencyKey = '00000000-0000-4000-8000-000000000099';
    await s.compareAndSet(3, (r) => ({ ...r, intent: next, receipt: null, hydrated: null, finished: false }));
    expect((await s.read()).intent?.kind).toBe('kick');
  });
  it('CAS atomically rejects a competing tab and isolates origin/wallet/cluster', async () => {
    const a = store(); const b = store(); await a.compareAndSet(0, (r) => ({ ...r, intent: intent() }));
    await expect(b.compareAndSet(0, (r) => ({ ...r, intent: intent('kick') }))).rejects.toThrow('Another tab');
    for (const who of [{ ...identity, api: 'https://other.example/api' }, { ...identity, wallet: target }, { ...identity, cluster: 'mainnet-beta' as const }])
      expect((await new ClanJournalStore(who, factory).read()).intent).toBeNull();
  });
  it('refuses malformed identity, aliases, receipt mismatch and impossible hydration rather than treating storage as empty', async () => {
    const empty = await store().read();
    for (const bad of [{ ...empty, extra: true }, { ...empty, identity: { ...identity, wallet: target } }, { ...empty, revision: -1 },
      { ...empty, intent: { ...intent(), request: { ...intent().request, clanId: 'AAAAAAAA-0000-4000-8000-000000000000' } } },
      { ...empty, intent: intent(), receipt: { ...receipt(), actor: target } },
      { ...empty, hydrated: { membershipAvailable: true, originalPayout: 'refreshed' } },
      { ...empty, intent: intent(), receipt: receipt(), hydrated: { membershipAvailable: true, originalPayout: 'not-applicable' } }])
      expect(() => parseClanJournal(bad, identity)).toThrow();
    await expect(new ClanJournalStore(identity, undefined).read()).rejects.toThrow('working browser site storage');
  });
});
