import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseReferralJournal, ReferralJournalStore } from './journal';
import { identity, relationship } from './fixtures.test-support';

let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); });
const store = () => new ReferralJournalStore(identity, factory);
describe('durable immutable referral journal', () => {
  it('restores exact normalized code after close, with no secret or eligibility estimate', async () => {
    const first = store(); await first.compareAndSet(0, (old) => ({ ...old, activated: true, code: 'KEEP-ABCDE' })); await first.close();
    const restored = await store().read();
    expect(restored.code).toBe('KEEP-ABCDE'); expect(restored.relationship).toBeNull();
    expect(Object.keys(restored).sort()).toEqual(['activated', 'code', 'identity', 'legacy', 'outcome', 'relationship', 'revision', 'version']);
  });
  it('cannot replace or erase an uncertain code, or silently clear activation after a first refusal', async () => {
    const s = store(); await s.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE' }));
    await expect(s.compareAndSet(1, (r) => ({ ...r, code: 'KEEP-CQRPF' }))).rejects.toThrow('cannot be replaced');
    await expect(s.compareAndSet(1, (r) => ({ ...r, code: null }))).rejects.toThrow('needs recovery');
    const refused = await s.firstRefused(1, 'KEEP-ABCDE'); expect(refused.activated).toBe(true); expect(refused.code).toBeNull();
    await expect(s.compareAndSet(2, (r) => ({ ...r, activated: false }))).rejects.toThrow('cannot be erased');
  });
  it('fences a late competing tab revision within the atomic transaction', async () => {
    const a = store(); const b = store(); await a.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE' }));
    await expect(b.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-CQRPF' }))).rejects.toThrow('another tab');
    expect((await b.read()).code).toBe('KEEP-ABCDE');
  });
  it('retains positive attribution through Finish and refuses null or contradictory replacements', async () => {
    const s = store(); await s.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE', relationship, outcome: 'already_bound' }));
    const finished = await s.compareAndSet(1, (r) => ({ ...r, code: null, outcome: 'observed' }));
    expect(finished.relationship).toEqual(relationship); expect(finished.activated).toBe(true);
    await expect(s.compareAndSet(2, (r) => ({ ...r, relationship: null, outcome: null }))).rejects.toThrow('relationship changed');
    await expect(s.compareAndSet(2, (r) => ({ ...r, relationship: { ...relationship, referrerWallet: '3'.repeat(32) } }))).rejects.toThrow('relationship changed');
  });
  it('isolates the same wallet across origins and clusters', async () => {
    await store().compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE' }));
    for (const other of [{ ...identity, api: 'https://local.example/api' }, { ...identity, cluster: 'mainnet-beta' as const }, { ...identity, wallet: '3'.repeat(32) }]) {
      expect((await new ReferralJournalStore(other, factory).read()).activated).toBe(false);
    }
  });
  it('refuses damaged fields, unnormalized code, wrong wallet and impossible code-specific tombstones', async () => {
    const empty = await store().read();
    for (const broken of [{ ...empty, extra: true }, { ...empty, code: ' keep-abcde ', activated: true },
      { ...empty, activated: true, relationship: { ...relationship, refereeWallet: '3'.repeat(32) }, outcome: 'observed' },
      { ...empty, activated: true, relationship, outcome: 'applied' }, { ...empty, revision: -1 }]) expect(() => parseReferralJournal(broken, identity)).toThrow();
  });
  it('positive legacy attribution and v1 binding must name the same immutable referrer', async () => {
    const s = store(); const empty = await s.read();
    expect(() => parseReferralJournal({ ...empty, activated: true, code: 'KEEP-ABCDE', relationship, outcome: 'observed',
      legacy: { route: '/referrals/use', code: 'KEEP-ABCDE', result: { referrer: '3'.repeat(32) } } }, identity)).toThrow('attribution changed');
  });
  it('unavailable critical storage never becomes an empty record', async () => {
    await expect(new ReferralJournalStore(identity, undefined).read()).rejects.toThrow('working browser site storage');
  });
});
