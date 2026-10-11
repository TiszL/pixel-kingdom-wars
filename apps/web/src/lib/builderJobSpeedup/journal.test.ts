import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { matchBuilderJobSpeedupProof } from '@shardkeep/shared/builderJobSpeedup';
import { BuilderJobSpeedupJournalStore, parseBuilderJobSpeedupIdentity, parseBuilderJobSpeedupJournal, type BuilderOperation } from './journal';
import { id, identity, proof, restarted, builder } from './fixtures.test-support';
const operation = (): BuilderOperation => ({ intent: builder, attempted: false, proof: null, refusal: null });
describe('Builder speedup durable original currency consent', () => {
  it('isolates wallet/API/origin/chain and rejects corrupt identities and stale CAS', async () => {
    const factory = new IDBFactory(), store = new BuilderJobSpeedupJournalStore(identity, factory);
    await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    await expect(new BuilderJobSpeedupJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const change of [{ api: 'https://other.test/api' }, { origin: 'https://other.test' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }]) {
      expect((await new BuilderJobSpeedupJournalStore({ ...identity, ...change }, factory).read()).operation).toBeNull();
    }
    for (const api of ['ftp://game.test/api', 'https://user:password@game.test/api', 'https://game.test/api?q=1']) expect(() => parseBuilderJobSpeedupIdentity({ ...identity, api })).toThrow();
    expect(() => parseBuilderJobSpeedupJournal({}, identity)).toThrow();
    await expect(new BuilderJobSpeedupJournalStore(identity, undefined).read()).rejects.toThrow('storage');
  });
  it('cannot retarget a pending Builder or rewrite original currency, price, episode or attempt', async () => {
    const store = new BuilderJobSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    for (const intent of [restarted, { ...builder, baseId: id(4) }, { ...builder, expectedCurrency: 'KEEP' as const }, { ...builder, consent: { ...builder.consent, maxCostKeep: '101' } }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, intent } }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: false } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchBuilderJobSpeedupProof(proof(builder), identity.wallet, builder) }] }))).rejects.toThrow();
  });
  it('acceptance requires original funding and remains immutable in history with permanent key reservation', async () => {
    const store = new BuilderJobSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof({ ...builder, expectedCurrency: 'KEEP' }, true) as never } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: matchBuilderJobSpeedupProof(proof(builder, true), identity.wallet, builder) } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: null } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: operation() }))).rejects.toThrow('reused');
  });
  it('refusal needs attempted command and cannot coexist with acceptance or change once saved', async () => {
    const store = new BuilderJobSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    const refusal = { status: 409, code: 'BUILDER_SPEEDUP_QUOTE_CHANGED' } as const;
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true, refusal } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal: { status: 409, code: 'BUILDER_JOB_NOT_RUNNING' } } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: matchBuilderJobSpeedupProof(proof(builder, true), identity.wallet, builder) } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'refused', evidence: null }] }));
    expect(saved.archives[0]!.operation.refusal).toEqual(refusal);
  });
  it('unattempted archival requires matching unknown evidence and still reserves its original key', async () => {
    const store = new BuilderJobSpeedupJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: operation() }));
    for (const evidence of [null, { version: 1, status: 'unknown', idempotencyKey: 'other-builder-key' }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: evidence as never }] }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchBuilderJobSpeedupProof(proof(builder), identity.wallet, builder) }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: operation() }))).rejects.toThrow('reused');
  });
});
