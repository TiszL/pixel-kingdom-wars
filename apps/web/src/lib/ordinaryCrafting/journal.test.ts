import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { matchOrdinaryCraftingProof, OrdinaryCraftingJournalStore, ordinaryCraftingRefusalDefinitive, parseOrdinaryCraftingCommand,
  parseOrdinaryCraftingIdentity, parseOrdinaryCraftingJournal, type OrdinaryCraftingRefusal } from './journal';
import { command, id, identity, proof, start } from './fixtures.test-support';
const refusal: OrdinaryCraftingRefusal = { phase: 'first_post', status: 422, code: 'INSUFFICIENT_RAW_STOCK' };
async function intent(store: OrdinaryCraftingJournalStore) {
  return store.compareAndSet(0, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }));
}
describe('ordinary refining durable original journal', () => {
  it('isolates origin/API/cluster/wallet and rejects cross-tab stale revisions', async () => {
    const factory = new IDBFactory(), store = new OrdinaryCraftingJournalStore(identity, factory); await intent(store);
    await expect(new OrdinaryCraftingJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const change of [{ origin: 'https://other.test' }, { api: 'https://other.test/api' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }]) {
      expect((await new OrdinaryCraftingJournalStore({ ...identity, ...change }, factory).read()).operation).toBeNull();
    }
    expect(() => parseOrdinaryCraftingJournal({}, identity)).toThrow();
    await expect(new OrdinaryCraftingJournalStore(identity, undefined).read()).rejects.toThrow('storage');
  });
  it('rejects noncanonical scope, coerced request quantities, altered recipes and foreign proof', () => {
    for (const patch of [{ origin: 'https://game.test/' }, { api: 'https://game.test/api/' }, { api: 'https://u:p@game.test/api' }, { api: 'https://game.test/api?x=1' }, { wallet: 'bad' }, { cluster: 'localnet' }]) {
      expect(() => parseOrdinaryCraftingIdentity({ ...identity, ...patch })).toThrow();
    }
    for (const quantity of ['1', 1.5, 0, null, Number.MAX_SAFE_INTEGER]) expect(() => parseOrdinaryCraftingCommand({ ...start, request: { ...start.request, quantity } })).toThrow();
    expect(() => parseOrdinaryCraftingCommand({ ...start, recipe: { ...start.recipe, output: { ...start.recipe.output, quantity: '999' } } })).toThrow();
    for (const patch of [{ wallet: 'So11111111111111111111111111111111111111112' }, { idempotencyKey: id(9) }, { completion: {} }]) expect(() => matchOrdinaryCraftingProof({ ...proof(start, true), ...patch }, identity, start)).toThrow();
    expect(() => matchOrdinaryCraftingProof(proof(command(2), true), identity, start)).toThrow();
  });
  it('requires intent then a dedicated attempt revision and cannot erase or abandon uncertainty', async () => {
    const store = new OrdinaryCraftingJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1, refusal } }))).rejects.toThrow();
    for (const next of [command(2), command(1, id(9)), { ...start, request: { ...start.request, baseId: id(9) } }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, command: next } }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: null } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: proof() }] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null }))).rejects.toThrow();
    expect((await store.read()).operation?.attemptRevision).toBe(saved.revision);
  });
  it('preserves immutable receipt plus monotonic completion in active and archived records', async () => {
    const store = new OrdinaryCraftingJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }));
    const changed = proof(start, true); if (changed.status !== 'accepted') throw new Error('fixture');
    changed.receipt.startedAt = new Date(Date.parse(changed.receipt.startedAt) + 1_000).toISOString(); changed.receipt.readyAt = new Date(Date.parse(changed.receipt.readyAt) + 1_000).toISOString();
    for (const next of [null, changed]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: next } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: proof(start, true, true) } })) }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: proof(start, true) } })) }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }))).rejects.toThrow('reused');
  });
  it('positive original proof wins over earlier first refusal while preserving that evidence', async () => {
    const store = new OrdinaryCraftingJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }));
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }));
    expect(saved.operation).toMatchObject({ refusal, proof: { status: 'accepted' } });
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal: null } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    expect(saved.archives[0]!.operation.refusal).toEqual(refusal);
  });
  it('archives only exact unknown unattempted or definitively refused commands and retains their keys', async () => {
    for (const refused of [false, true]) {
      const store = new OrdinaryCraftingJournalStore(identity, new IDBFactory()); let saved = await intent(store);
      if (refused) {
        saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
        saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }));
      }
      const reason = refused ? 'refused' as const : 'unattempted' as const;
      for (const evidence of [null, proof(start, true), proof(command(1, id(9)))]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason, evidence }] }))).rejects.toThrow();
      saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason, evidence: proof() }] }));
      expect(saved.archives[0]!.operation.command).toEqual(start);
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }))).rejects.toThrow();
    }
  });
  it('refuses malformed saved bytes without deleting them and keeps a failed transaction atomic', async () => {
    const factory = new IDBFactory(), name = 'corrupt-ordinary', store = new OrdinaryCraftingJournalStore(identity, factory, name); await store.read();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const corrupt = { privateOriginalEvidence: 'must not disappear' };
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('commands', 'readwrite'); tx.objectStore('commands').put(corrupt, store.key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    await expect(store.read()).rejects.toThrow(); await expect(store.compareAndSet(0, old => old)).rejects.toThrow();
    const retained = await new Promise<unknown>((resolve, reject) => { const r = db.transaction('commands').objectStore('commands').get(store.key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    expect(retained).toEqual(corrupt); db.close(); await store.close();
  });
  it('records only the exact documented first-refusal status/code pair', () => {
    for (const [status, code] of [[503, 'PHASE_E_DISABLED'], [409, 'ORDINARY_WORKSHOP_REQUIRED'], [409, 'ORDINARY_CRAFTING_BUSY'], [409, 'ORDINARY_RECIPE_CHANGED'], [400, 'ORDINARY_RECIPE_INVALID'], [409, 'CRAFTING_STORAGE_FULL'], [422, 'INSUFFICIENT_RAW_STOCK'], [422, 'INSUFFICIENT_CRAFTING_STOCK'], [422, 'ledger.insufficient_funds']] as const) expect(ordinaryCraftingRefusalDefinitive(status, code)).toBe(true);
    for (const [status, code] of [[409, 'IDEMPOTENCY_BODY_MISMATCH'], [500, 'PHASE_E_DISABLED'], [404, 'NOT_FOUND'], [503, 'NETWORK_ERROR'], [500, 'ledger.insufficient_funds']] as const) expect(ordinaryCraftingRefusalDefinitive(status, code)).toBe(false);
  });
});
