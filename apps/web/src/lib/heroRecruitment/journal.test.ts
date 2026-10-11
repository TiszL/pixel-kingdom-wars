import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { HeroRecruitmentJournalStore, parseHeroRecruitmentIntent, parseHeroRecruitmentJournal } from './journal';
import { baseA, baseB, hydration, identity, intent, receipt, target } from './fixtures.test-support';
describe('durable immutable Hero original intent', () => {
  it.each(['api', 'wallet', 'cluster'] as const)('separates account identity dimension %s', async field => {
    const factory = new IDBFactory(), store = new HeroRecruitmentJournalStore(identity, factory);
    await store.compareAndSet(0, old => ({ ...old, intent: intent() }));
    const other = { ...identity, [field]: field === 'wallet' ? target : field === 'api' ? 'https://other.example' : 'mainnet-beta' } as typeof identity;
    expect((await new HeroRecruitmentJournalStore(other, factory).read()).intent).toBeNull();
    expect((await new HeroRecruitmentJournalStore(identity, factory).read()).intent).toEqual(intent());
  });
  it('CAS refuses another tab and original mechanism/body cannot be changed or deleted', async () => {
    const store = new HeroRecruitmentJournalStore(identity, new IDBFactory()); await store.compareAndSet(0, r => ({ ...r, intent: intent('legacy') }));
    await expect(store.compareAndSet(0, r => r)).rejects.toThrow('Another tab');
    await expect(store.compareAndSet(1, r => ({ ...r, intent: intent() }))).rejects.toThrow('cannot be replaced');
    await expect(store.compareAndSet(1, r => ({ ...r, intent: null }))).rejects.toThrow('cannot be replaced');
    expect((await store.read()).intent).toEqual(intent('legacy'));
  });
  it('strict body parsing binds omitted legacy base and refuses injected ceiling or selector changes', () => {
    const old = intent('legacy', null); expect(old.legacyBody).not.toHaveProperty('baseId');
    expect(() => parseHeroRecruitmentIntent({ ...old, legacyBody: { ...old.legacyBody, baseId: baseA } })).toThrow();
    expect(() => parseHeroRecruitmentIntent({ ...old, legacyBody: { ...old.legacyBody, maxCostKeep: '0' } })).toThrow();
    expect(() => parseHeroRecruitmentIntent({ ...intent(), mechanism: 'future' })).toThrow();
  });
  it('only matching immutable acceptance plus destination refresh permits Finish and distinct-key replacement', async () => {
    const store = new HeroRecruitmentJournalStore(identity, new IDBFactory()); await store.compareAndSet(0, r => ({ ...r, intent: intent() }));
    await expect(store.compareAndSet(1, r => ({ ...r, finished: true }))).rejects.toThrow('needs recovery');
    await expect(store.compareAndSet(1, r => ({ ...r, receipt: receipt(baseB) }))).rejects.toThrow();
    await store.compareAndSet(1, r => ({ ...r, receipt: receipt(), hydrated: hydration, finished: true }));
    await expect(store.compareAndSet(2, r => ({ ...r, receipt: { ...receipt(), createdAt: '2026-09-14T00:00:00.000Z' } }))).rejects.toThrow('changed');
    await expect(store.compareAndSet(2, r => ({ ...r, finished: false }))).rejects.toThrow('replayed');
    await store.compareAndSet(2, r => ({ ...r, intent: intent('v1', baseB, true, 'heroaltar', baseB), receipt: null, hydrated: null, finished: false }));
    expect((await store.read()).intent?.request.baseId).toBe(baseB);
  });
  it('malformed journal and unavailable storage fail loudly, never becoming empty consent', async () => {
    const store = new HeroRecruitmentJournalStore(identity, new IDBFactory()); const raw = await store.read();
    expect(() => parseHeroRecruitmentJournal({ ...raw, future: true }, identity)).toThrow();
    expect(() => parseHeroRecruitmentJournal({ ...raw, revision: -1 }, identity)).toThrow();
    expect(() => parseHeroRecruitmentJournal({ ...raw, intent: intent(), hydrated: hydration }, identity)).toThrow();
    await expect(new HeroRecruitmentJournalStore(identity, undefined).read()).rejects.toThrow('storage');
  });
});

describe('currency and refusal remain part of immutable saved consent', () => {
  it('old records retain their shape; exact currency cannot be attached to their existing key', async () => {
    const store = new HeroRecruitmentJournalStore(identity, new IDBFactory()); const old = intent('v1', baseA, false);
    await store.compareAndSet(0, r => ({ ...r, intent: old }));
    expect((await store.read()).intent).not.toHaveProperty('expectedCurrency');
    await expect(store.compareAndSet(1, r => ({ ...r, intent: { ...old, expectedCurrency: 'GEMS' } }))).rejects.toThrow('cannot be replaced');
    for (const value of ['SOL', undefined, null]) expect(() => parseHeroRecruitmentIntent({ ...old, expectedCurrency: value })).toThrow();
    expect(() => parseHeroRecruitmentIntent({ ...intent(), expectedCurrency: 'GEMS' })).toThrow('paid');
  });
  it('a durable first refusal is terminal without invented acceptance and permits only a new distinct key', async () => {
    const store = new HeroRecruitmentJournalStore(identity, new IDBFactory());
    await store.compareAndSet(0, r => ({ ...r, intent: { ...intent('v1', baseA, false), expectedCurrency: 'GEMS' } }));
    await store.compareAndSet(1, r => ({ ...r, refusal: 'CURRENCY_CONSENT_CHANGED', finished: true }));
    const refused = await store.read(); expect(refused.receipt).toBeNull(); expect(refused.hydrated).toBeNull();
    await expect(store.compareAndSet(2, r => ({ ...r, receipt: receipt(baseA, false) }))).rejects.toThrow();
    await expect(store.compareAndSet(2, r => ({ ...r, refusal: undefined } as never))).rejects.toThrow();
    await store.compareAndSet(2, r => { const { refusal: _refusal, ...old } = r; return { ...old, intent: intent('v1', baseB, true, 'heroaltar', baseB), finished: false }; });
    expect((await store.read()).refusal).toBeUndefined();
  });
});
