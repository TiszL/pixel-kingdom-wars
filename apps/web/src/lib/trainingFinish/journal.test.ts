import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { matchTrainingFinishProof } from '@shardkeep/shared/trainingFinish';
import { TrainingFinishJournalStore, parseTrainingFinishIdentity, parseTrainingFinishJournal, type TrainingOperation } from './journal';
import { id, identity, proof, restarted, training } from './fixtures.test-support';
const operation = (): TrainingOperation => ({ intent: training, attempted: false, proof: null, refusal: null });
describe('Training speedup durable original currency consent', () => {
  it('isolates wallet/API/origin/chain and rejects corrupt identities and stale CAS', async () => {
    const factory = new IDBFactory(), store = new TrainingFinishJournalStore(identity, factory);
    await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    await expect(new TrainingFinishJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const change of [{ api: 'https://other.test/api' }, { origin: 'https://other.test' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }]) {
      expect((await new TrainingFinishJournalStore({ ...identity, ...change }, factory).read()).operation).toBeNull();
    }
    for (const api of ['ftp://game.test/api', 'https://user:password@game.test/api', 'https://game.test/api?q=1']) expect(() => parseTrainingFinishIdentity({ ...identity, api })).toThrow();
    expect(() => parseTrainingFinishJournal({}, identity)).toThrow();
    await expect(new TrainingFinishJournalStore(identity, undefined).read()).rejects.toThrow('storage');
  });
  it('cannot retarget a pending Training or rewrite original currency, price, episode or attempt', async () => {
    const store = new TrainingFinishJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    for (const intent of [restarted, { ...training, baseId: id(4) }, { ...training, expectedCurrency: 'KEEP' as const }, { ...training, consent: { ...training.consent, maxCostKeep: '101' } }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, intent } }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: false } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchTrainingFinishProof(proof(training), identity.wallet, training) }] }))).rejects.toThrow();
  });
  it('acceptance requires original funding and remains immutable in history with permanent key reservation', async () => {
    const store = new TrainingFinishJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof({ ...training, expectedCurrency: 'KEEP' }, true) as never } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: matchTrainingFinishProof(proof(training, true), identity.wallet, training) } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: null } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: operation() }))).rejects.toThrow('reused');
  });
  it('refusal needs attempted command and cannot coexist with acceptance or change once saved', async () => {
    const store = new TrainingFinishJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    const refusal = { status: 409, code: 'TRAINING_FINISH_QUOTE_CHANGED' } as const;
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true, refusal } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal: { status: 409, code: 'TRAINING_NOT_RUNNING' } } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: matchTrainingFinishProof(proof(training, true), identity.wallet, training) } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'refused', evidence: null }] }));
    expect(saved.archives[0]!.operation.refusal).toEqual(refusal);
  });
  it('unattempted archival requires matching unknown evidence and still reserves its original key', async () => {
    const store = new TrainingFinishJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    for (const evidence of [null, { version: 1, status: 'unknown', idempotencyKey: 'other-training-key' }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: evidence as never }] }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchTrainingFinishProof(proof(training), identity.wallet, training) }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: operation() }))).rejects.toThrow('reused');
  });
});
