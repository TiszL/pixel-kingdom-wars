import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { matchWorkshopProof, parseWorkshopJournal, WorkshopJournalStore, workshopRefusalDefinitive, type WorkshopRefusal } from './journal';
import { collect, id, identity, proof, start } from './fixtures.test-support';
describe('Workshop durable original commands', () => {
  it('isolates API/origin/network/wallet, refuses stale CAS and corrupt journals', async () => {
    const factory = new IDBFactory(), store = new WorkshopJournalStore(identity, factory);
    await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attempted: false, proof: null } }));
    await expect(new WorkshopJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const change of [{ api: 'https://other.test/api' }, { origin: 'https://other.test' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }]) {
      expect((await new WorkshopJournalStore({ ...identity, ...change }, factory).read()).operation).toBeNull();
    }
    expect(() => parseWorkshopJournal({}, identity)).toThrow();
    await expect(new WorkshopJournalStore(identity, undefined).read()).rejects.toThrow('storage');
  });
  it('cannot replace a pending base, rewrite consent, erase attempted evidence or archive uncertainty', async () => {
    const store = new WorkshopJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attempted: false, proof: null } }));
    for (const command of [collect, { ...start, request: { ...start.request, baseId: id(4) } }, { ...start, request: { ...start.request, ingots: 2 } }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, command } }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: false } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchWorkshopProof(proof(start), identity, start) }] }))).rejects.toThrow();
  });
  it('accepted original receipt remains immutable in history and its key can never be recycled', async () => {
    const store = new WorkshopJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attempted: false, proof: null } }));
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: matchWorkshopProof(proof(start, true), identity, start) } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: null } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attempted: false, proof: null } }))).rejects.toThrow('reused');
  });
  it('unsent archive requires matching unknown evidence and preserves original kind, body, key and reason forever', async () => {
    const store = new WorkshopJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: { command: collect, attempted: false, proof: null } }));
    for (const evidence of [null, matchWorkshopProof(proof(collect, true), identity, collect), matchWorkshopProof(proof(start), identity, start)]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence }] }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: matchWorkshopProof(proof(collect), identity, collect) }] }));
    expect(saved.archives[0]).toMatchObject({ operation: { command: collect, attempted: false }, reason: 'unattempted', evidence: { status: 'unknown' } });
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: collect, attempted: false, proof: null } }))).rejects.toThrow('reused');
  });
});
describe('Workshop refusal evidence invariants', () => {
  const refusal: WorkshopRefusal = { phase: 'first_post', status: 422, code: 'INSUFFICIENT_SHARDS' };
  it('uses the audited operation-specific status/code matrix, excluding conflicts and generic errors', () => {
    for (const [status, code] of [[503, 'PHASE_E_DISABLED'], [409, 'RECIPE_VERSION_STALE'], [409, 'WORKSHOP_REQUIRED'], [422, 'BATCH_EXCEEDED'], [422, 'REFINE_CAP_EXCEEDED'], [422, 'HOLDING_CAP_EXCEEDED'], [422, 'INSUFFICIENT_SHARDS']] as const) {
      expect(workshopRefusalDefinitive('start', status, code)).toBe(true); expect(workshopRefusalDefinitive('collect', status, code)).toBe(false);
    }
    for (const [status, code] of [[404, 'JOB_NOT_FOUND'], [409, 'JOB_ALREADY_COLLECTED'], [409, 'JOB_NOT_READY']] as const) {
      expect(workshopRefusalDefinitive('collect', status, code)).toBe(true); expect(workshopRefusalDefinitive('start', status, code)).toBe(false);
    }
    for (const kind of ['start', 'collect'] as const) {
      for (const [status, code] of [[404, 'BASE_NOT_OWNED'], [409, 'BASE_ID_REQUIRED'], [409, 'DEED_OWNERSHIP_CHANGED'], [423, 'BASE_BEING_RAIDED'], [503, 'DEED_AUTHORITY_UNAVAILABLE']] as const) expect(workshopRefusalDefinitive(kind, status, code)).toBe(true);
      expect(workshopRefusalDefinitive(kind, 409, 'BASE_NOT_OWNED')).toBe(false); expect(workshopRefusalDefinitive(kind, 409, 'IDEMPOTENCY_BODY_MISMATCH')).toBe(false);
    }
  });
  it('refusal requires an already saved attempt, never coexists with acceptance, and cannot be rewritten or erased from immutable history', async () => {
    const store = new WorkshopJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attempted: false, proof: null } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true, refusal } }))).rejects.toThrow('attempt');
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }));
    for (const patch of [{ refusal: null }, { refusal: { ...refusal, code: 'BATCH_EXCEEDED' } }, { proof: matchWorkshopProof(proof(start, true), identity, start) }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, ...patch } }))).rejects.toThrow();
    }
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'refused', evidence: matchWorkshopProof(proof(start, true), identity, start) }] }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'refused', evidence: matchWorkshopProof(proof(start), identity, start) }] }));
    expect(saved.archives[0]?.operation.command).toEqual(start); expect(saved.archives[0]?.operation.refusal).toEqual(refusal);
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attempted: false, proof: null } }))).rejects.toThrow('reused');
  });
});
