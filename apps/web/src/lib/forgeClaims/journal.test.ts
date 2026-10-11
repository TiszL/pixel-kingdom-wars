import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { ForgeClaimJournalStore, parseForgeClaimJournal } from './journal';
import { baseB, identity, intent, receipt, target } from './fixtures.test-support';
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); });
const store = () => new ForgeClaimJournalStore(identity, factory);
describe('durable original Forge claim consent', () => {
  it.each([null, '2026-09-11'])('restores day=%s with explicit null base before any POST', async (day) => {
    const s = store(); await s.compareAndSet(0, (r) => ({ ...r, intent: intent(day, null) })); await s.close();
    const restored = await store().read(); expect(restored.intent).toEqual(intent(day, null)); expect(restored.receipt).toBeNull();
    expect(Object.keys(restored.intent!.request).sort()).toEqual(['baseId', 'day', 'idempotencyKey']);
  });
  it('unknown consent cannot be erased or replaced and Finish requires exact proof plus hydration', async () => {
    const s = store(); await s.compareAndSet(0, r => ({ ...r, intent: intent() }));
    await expect(s.compareAndSet(1, r => ({ ...r, intent: null }))).rejects.toThrow('cannot be replaced');
    await expect(s.compareAndSet(1, r => ({ ...r, intent: intent('2026-09-11') }))).rejects.toThrow('cannot be replaced');
    await s.compareAndSet(1, r => ({ ...r, receipt: receipt() }));
    await expect(s.compareAndSet(2, r => ({ ...r, finished: true }))).rejects.toThrow('needs recovery');
    await s.compareAndSet(2, r => ({ ...r, hydrated: { walletKeep: 'unavailable' }, finished: true }));
    await expect(s.compareAndSet(3, r => ({ ...r, finished: false }))).rejects.toThrow('cannot be replayed');
    await expect(s.compareAndSet(3, r => ({ ...r, intent: intent('2026-09-11'), receipt: null, hydrated: null, finished: false }))).rejects.toThrow('distinct key');
    await s.compareAndSet(3, r => ({ ...r, intent: intent('2026-09-11', baseB, baseB), receipt: null, hydrated: null, finished: false }));
    expect((await s.read()).intent).toEqual(intent('2026-09-11', baseB, baseB));
  });
  it('positive and empty receipts stay immutable and hydration cannot be rewritten', async () => {
    const s = store(); await s.compareAndSet(0, r => ({ ...r, intent: intent(), receipt: receipt(), hydrated: { walletKeep: 'refreshed' } }));
    await expect(s.compareAndSet(1, r => ({ ...r, receipt: receipt(null, undefined, true) }))).rejects.toThrow('receipt changed');
    await expect(s.compareAndSet(1, r => ({ ...r, hydrated: { walletKeep: 'unavailable' } }))).rejects.toThrow('refresh changed');
    expect((await s.read()).receipt).toEqual(receipt());
  });
  it('competing CAS cannot overwrite consent and origin wallet cluster each isolate recovery', async () => {
    const a = store(), b = store(); await a.compareAndSet(0, r => ({ ...r, intent: intent() }));
    await expect(b.compareAndSet(0, r => ({ ...r, intent: intent('2026-09-11') }))).rejects.toThrow('Another tab');
    for (const who of [{ ...identity, api: 'https://other.example/api' }, { ...identity, wallet: target }, { ...identity, cluster: 'mainnet-beta' as const }])
      expect((await new ForgeClaimJournalStore(who, factory).read()).intent).toBeNull();
  });
  it('malformed storage aliases mismatched proof and impossible hydration fail closed', async () => {
    const empty = await store().read();
    for (const bad of [{ ...empty, extra: true }, { ...empty, identity: { ...identity, wallet: target } }, { ...empty, revision: -1 },
      { ...empty, intent: { request: { ...intent().request, baseId: 'AAAAAAAA-0000-4000-8000-000000000000' } } },
      { ...empty, intent: { request: { idempotencyKey: intent().request.idempotencyKey, baseId: null } } },
      { ...empty, intent: intent(), receipt: { ...receipt(), actor: target } }, { ...empty, hydrated: { walletKeep: 'refreshed' } },
      { ...empty, intent: intent(), receipt: receipt(), hydrated: { walletKeep: 'not-applicable' } },
      { ...empty, intent: intent(), receipt: receipt(), hydrated: { walletKeep: ['refreshed'] }, finished: true }]) expect(() => parseForgeClaimJournal(bad, identity)).toThrow();
    await expect(new ForgeClaimJournalStore(identity, undefined).read()).rejects.toThrow('working browser site storage');
  });
});
