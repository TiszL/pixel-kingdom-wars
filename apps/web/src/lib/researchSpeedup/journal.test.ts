import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { matchResearchSpeedupProof } from '@shardkeep/shared/researchSpeedup';
import { ResearchSpeedupJournalStore, parseResearchSpeedupIdentity, parseResearchSpeedupJournal, type ResearchOperation } from './journal';
import { id, identity, proof, restarted, research } from './fixtures.test-support';
const operation = (): ResearchOperation => ({ intent: research, attempted: false, proof: null, refusal: null });
describe('Research speedup durable original currency consent', () => {
  it('isolates wallet/API/origin/chain and rejects corrupt identities and stale CAS', async () => {
    const factory = new IDBFactory(), store = new ResearchSpeedupJournalStore(identity, factory);
    await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    await expect(new ResearchSpeedupJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const change of [{ api: 'https://other.test/api' }, { origin: 'https://other.test' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }]) {
      expect((await new ResearchSpeedupJournalStore({ ...identity, ...change }, factory).read()).operation).toBeNull();
    }
    for (const api of ['ftp://game.test/api', 'https://user:password@game.test/api', 'https://game.test/api?q=1']) expect(() => parseResearchSpeedupIdentity({ ...identity, api })).toThrow();
    expect(() => parseResearchSpeedupJournal({}, identity)).toThrow();
    await expect(new ResearchSpeedupJournalStore(identity, undefined).read()).rejects.toThrow('storage');
  });
  it('cannot retarget a pending Research or rewrite original currency, price, episode or attempt', async () => {
    const store = new ResearchSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    for (const intent of [restarted, { ...research, baseId: id(4) }, { ...research, expectedCurrency: 'KEEP' as const }, { ...research, maxCostKeep: '101' }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, intent } }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: false } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchResearchSpeedupProof(proof(research), identity.wallet, research) }] }))).rejects.toThrow();
  });
  it('acceptance requires original funding and remains immutable in history with permanent key reservation', async () => {
    const store = new ResearchSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof({ ...research, expectedCurrency: 'KEEP' }, true) as never } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: matchResearchSpeedupProof(proof(research, true), identity.wallet, research) } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: null } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: operation() }))).rejects.toThrow('reused');
  });
  it('refusal needs attempted command and cannot coexist with acceptance or change once saved', async () => {
    const store = new ResearchSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    const refusal = { status: 409, code: 'RESEARCH_CONSENT_STALE' } as const;
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true, refusal } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal: { status: 409, code: 'RESEARCH_PRICE_CHANGED' } } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: matchResearchSpeedupProof(proof(research, true), identity.wallet, research) } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'refused', evidence: null }] }));
    expect(saved.archives[0]!.operation.refusal).toEqual(refusal);
  });
  it('unattempted archival requires matching unknown evidence and still reserves its original key', async () => {
    const store = new ResearchSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    for (const evidence of [null, { version: 1, status: 'unknown', idempotencyKey: 'other-research-key' }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: evidence as never }] }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchResearchSpeedupProof(proof(research), identity.wallet, research) }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: operation() }))).rejects.toThrow('reused');
  });
});
