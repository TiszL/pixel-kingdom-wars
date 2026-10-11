import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { StarterFleetJournalStore, matchStarterFleetProof, parseStarterFleetCommand, parseStarterFleetIdentity, parseStarterFleetJournal,
  starterFleetRefusalDefinitive, type StarterFleetRefusal } from './journal';
import { command, id, identity, installation, now, proof, start } from './fixtures.test-support';
const refusal: StarterFleetRefusal = { phase: 'first_post', status: 409, code: 'STARTER_BERTH_UNAVAILABLE' };
const intent = (store: StarterFleetJournalStore) => store.compareAndSet(0, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }));
describe('starter installation original journal', () => {
  it('isolates canonical origin/API/cluster/wallet and refuses stale cross-tab revisions', async () => {
    const factory = new IDBFactory(), store = new StarterFleetJournalStore(identity, factory); await intent(store);
    await expect(new StarterFleetJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const patch of [{ origin: 'https://other.test' }, { api: 'https://other.test/api' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }]) expect((await new StarterFleetJournalStore({ ...identity, ...patch }, factory).read()).operation).toBeNull();
    for (const patch of [{ origin: 'https://game.test/' }, { api: 'https://u:p@game.test/api' }, { api: 'https://game.test/api?x=1' }, { cluster: 'localnet' }, { wallet: 'bad' }]) expect(() => parseStarterFleetIdentity({ ...identity, ...patch })).toThrow();
    await expect(new StarterFleetJournalStore(identity, undefined).read()).rejects.toThrow('storage');
    expect(() => parseStarterFleetJournal({}, identity)).toThrow();
  });
  it('requires a strict request and positive original completed-job evidence, not a guessed level or pending-timer absence', () => {
    for (const request of [{ ...start.request, actor: identity.wallet }, { ...start.request, family: 'starter' }, { ...start.request, currency: 'sol' }, { ...start.request, berthId: 3 }, { ...start.request, idempotencyKey: 'ABCDEF00-0000-4000-8000-000000000002' }]) expect(() => parseStarterFleetCommand({ ...start, request })).toThrow();
    for (const berth of [{ berthId: id(3), level: 1 }, { ...start.berth, completedBuildJobId: null }, { ...start.berth, berthCompletedAt: '2026-09-22T11:00:00Z' }, { ...start.berth, berthId: id(9) }]) expect(() => parseStarterFleetCommand({ ...start, berth })).toThrow();
    expect(() => parseStarterFleetCommand({ ...start, installation: { ...installation(), baseId: id(9) } })).toThrow();
    expect(() => parseStarterFleetCommand({ ...start, installation: { ...installation(), completedBuildJobId: id(9) } })).toThrow();
  });
  it('binds accepted proof to the reviewed berth completion and preserves the exact existing vehicle for a buyer', () => {
    expect(matchStarterFleetProof(proof(start, true), identity, start).status).toBe('accepted');
    const existing = command(true); expect(matchStarterFleetProof(proof(existing, true), identity, existing).status).toBe('accepted');
    for (const patch of [{ completedBuildJobId: id(9) }, { berthCompletedAt: '2026-09-22T10:00:00.000Z' }, { installationId: id(9) }, { installedAt: '2026-09-22T11:10:00.000Z' }]) {
      const raw = proof(existing, true); if (raw.status !== 'accepted') throw new Error('fixture');
      raw.receipt.installation = { ...raw.receipt.installation, ...patch };
      expect(() => matchStarterFleetProof(raw, identity, existing)).toThrow();
    }
    const future = proof(start, true); if (future.status !== 'accepted') throw new Error('fixture'); future.receipt.acceptedAt = '2026-09-23T12:00:00.000Z';
    expect(() => matchStarterFleetProof(future, identity, start)).toThrow('observation');
    expect(() => matchStarterFleetProof({ ...proof(start, true), wallet: 'So11111111111111111111111111111111111111112' }, identity, start)).toThrow();
    expect(() => matchStarterFleetProof(proof(command(false, id(9)), true), identity, start)).toThrow();
  });
  it('saves intent before the original attempt revision and cannot erase uncertainty or alter frozen berth/install terms', async () => {
    const store = new StarterFleetJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    for (const changed of [command(true), command(false, id(9)), { ...start, berth: { ...start.berth, completedBuildJobId: id(9) } }, { ...start, request: { ...start.request, baseId: id(9) } }]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, command: changed } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1, refusal } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
    for (const attemptRevision of [null, 0, '2', saved.revision - 1]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: attemptRevision as number | null } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: proof() }] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null }))).rejects.toThrow();
  });
  it('accepted receipt is immutable, cannot become an absence archive, and cannot recycle its original key', async () => {
    const store = new StarterFleetJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }));
    const changed = proof(start, true); if (changed.status !== 'accepted') throw new Error('fixture'); changed.receipt.acceptedAt = '2026-09-22T11:59:00.000Z';
    for (const proof of [null, changed]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: proof() }] }))).rejects.toThrow('accepted');
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }))).rejects.toThrow('reused');
  });
  it.each(['unattempted', 'refused'] as const)('archived %s can later retain positive proof without rewriting original absence, reason, request or refusal', async reason => {
    const store = new StarterFleetJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    if (reason === 'refused') {
      saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
      saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }));
    }
    for (const evidence of [null, proof(start, true), proof(command(false, id(9)))]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason, evidence }] }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason, evidence: proof() }] }));
    const before = saved.archives[0]!;
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: proof(start, true) } })) }));
    expect(saved.archives[0]).toEqual({ ...before, operation: { ...before.operation, proof: proof(start, true) } });
    for (const patch of [{ reason: 'accepted' as const, evidence: null }, { evidence: { ...proof(), serverNow: new Date(Date.parse(now) + 1_000).toISOString() } }]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, ...patch })) }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: null } })) }))).rejects.toThrow();
  });
  it('positive active proof wins over an earlier refusal while preserving both original facts', async () => {
    const store = new StarterFleetJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }));
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }));
    expect(saved.operation).toMatchObject({ refusal, proof: { status: 'accepted' } });
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal: null } }))).rejects.toThrow();
  });
  it('keeps unreadable saved evidence intact instead of replacing it with an empty journal', async () => {
    const factory = new IDBFactory(), name = 'corrupt-starter-fleet', store = new StarterFleetJournalStore(identity, factory, name); await store.read();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const corrupt = { original: 'preserve these bytes' };
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('commands', 'readwrite'); tx.objectStore('commands').put(corrupt, store.key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    await expect(store.read()).rejects.toThrow(); await expect(store.compareAndSet(0, old => old)).rejects.toThrow();
    const retained = await new Promise<unknown>((resolve, reject) => { const r = db.transaction('commands').objectStore('commands').get(store.key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    expect(retained).toEqual(corrupt); db.close(); await store.close();
  });
  it('classifies only exact documented installation first-refusal pairs', () => {
    for (const [status, code] of [[404, 'BASE_NOT_OWNED'], [409, 'BASE_ID_REQUIRED'], [409, 'DEED_OWNERSHIP_CHANGED'], [423, 'BASE_BEING_RAIDED'], [503, 'DEED_AUTHORITY_UNAVAILABLE'], [503, 'PHASE_E_DISABLED'], [409, 'STARTER_BERTH_UNAVAILABLE'], [409, 'STARTER_FAMILY_OCCUPIED'], [409, 'STARTER_BERTH_OCCUPIED']] as const) expect(starterFleetRefusalDefinitive(status, code)).toBe(true);
    for (const [status, code] of [[500, 'STARTER_BERTH_UNAVAILABLE'], [409, 'IDEMPOTENCY_BODY_MISMATCH'], [409, 'EXPEDITION_HOME_UNAVAILABLE'], [503, 'NETWORK_ERROR']] as const) expect(starterFleetRefusalDefinitive(status, code)).toBe(false);
  });
});
