import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { HarvesterJournalStore, matchHarvesterProof, parseHarvesterCommand, parseHarvesterIdentity, parseHarvesterJournal,
  harvesterRefusalDefinitive, type HarvesterRefusal } from './journal';
import { command, head, id, identity, now, policy, proof, start } from './fixtures.test-support';
const refusal: HarvesterRefusal = { phase: 'first_post', status: 409, code: 'HARVESTER_SOURCE_CHANGED' };
const intent = (store: HarvesterJournalStore, original = start) => store.compareAndSet(0, old => ({ ...old, operation: { command: original, attemptRevision: null, proof: null, refusal: null } }));
describe('Harvester immutable consent and settlement journal', () => {
  it('isolates exact origin/API/cluster/wallet and prevents stale cross-tab intent writes', async () => {
    const factory = new IDBFactory(), store = new HarvesterJournalStore(identity, factory); await intent(store);
    await expect(new HarvesterJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const patch of [{ origin: 'https://other.test' }, { api: 'https://other.test/api' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }])
      expect((await new HarvesterJournalStore({ ...identity, ...patch }, factory).read()).operation).toBeNull();
  });
  it('fails closed on noncanonical identity, extra saved fields and mismatched journal scope', async () => {
    for (const patch of [{ origin: `${identity.origin}/` }, { api: `${identity.api}?secret=x` }, { api: 'https://user:password@game.test/api' }, { wallet: 'not a wallet' }, { extra: true }])
      expect(() => parseHarvesterIdentity({ ...identity, ...patch })).toThrow();
    const store = new HarvesterJournalStore(identity, new IDBFactory()), saved = await intent(store);
    expect(() => parseHarvesterJournal(saved, { ...identity, cluster: 'mainnet-beta' })).toThrow();
    expect(() => parseHarvesterJournal({ ...saved, extra: true }, identity)).toThrow();
  });
  it('requires explicit nullable expected head and exact full facility, realm and canonical policy snapshots', () => {
    const replacement = command(head(id(90), true)); expect(replacement.request.expectedSourceId).toBe(head().sourceId);
    for (const raw of [
      { ...start, request: { ...start.request, expectedSourceId: undefined } },
      { ...start, request: { ...start.request, expectedSourceId: id(8) } },
      { ...replacement, request: { ...replacement.request, idempotencyKey: id(8) } },
      { ...start, request: { ...start.request, harvesterId: id(9) } },
      { ...start, facility: { ...start.facility, baseId: id(9) } },
      { ...start, realmId: 'unrecognized' },
      { ...start, policy: { ...policy, grossPerCadence: '01' } },
      { ...start, policy: { ...policy, grossPerCadence: Number(policy.grossPerCadence) } },
      { ...start, policy: { ...policy, cadenceSec: policy.cadenceSec + 1 } },
    ]) expect(() => parseHarvesterCommand(raw)).toThrow();
  });
  it('binds accepted proof to original actor/key/request and complete reviewed facility/realm/policy', () => {
    const accepted = proof(start, true); if (accepted.status !== 'accepted') throw new Error('fixture');
    for (const raw of [
      { ...accepted, wallet: 'So11111111111111111111111111111111111111112' },
      { ...accepted, idempotencyKey: id(9) },
      { ...accepted, originalReceipt: { ...accepted.originalReceipt, request: { ...start.request, expectedSourceId: id(8) } } },
      { ...accepted, originalReceipt: { ...accepted.originalReceipt, source: { ...accepted.originalReceipt.source, completedBuildJobId: id(9) } } },
      { ...accepted, originalReceipt: { ...accepted.originalReceipt, source: { ...accepted.originalReceipt.source, harvesterCompletedAt: '2026-09-22T11:00:00.000Z' } } },
      { ...accepted, originalReceipt: { ...accepted.originalReceipt, source: { ...accepted.originalReceipt.source, realmId: 'frostveil', resourceId: 'frost_quartz' } } },
      { ...accepted, serverNow: '2026-09-22T11:00:00.000Z' },
    ]) expect(() => matchHarvesterProof(raw, identity, start)).toThrow();
    const another = proof(command(null, id(10)), true); expect(() => matchHarvesterProof(another, identity, start)).toThrow();
  });
  it('delegates strict event amounts, cadence, cap-zero and tax-only conservation to the shared proof parser', () => {
    for (const options of [{ events: 2 }, { events: 2, capped: true }, { events: 1, carry: String(policy.taxBasisPoints - policy.islandPoolBps) }])
      expect(matchHarvesterProof(proof(start, true, options), identity, start).status).toBe('accepted');
    const accepted = proof(start, true, { events: 2 }); if (accepted.status !== 'accepted') throw new Error('fixture');
    for (const patch of [{ grossQuantity: 1 }, { netQuantity: '01' }, { netQuantity: '9223372036854775808' }, { earnedAt: now }, { walletSequence: '0' }, { carryBefore: '1' }]) {
      const raw = structuredClone(accepted); Object.assign(raw.settlement.events[1]!, patch); expect(() => matchHarvesterProof(raw, identity, start)).toThrow();
    }
    const max = Math.floor(policy.maxLeaseSec / policy.cadenceSec);
    expect(matchHarvesterProof(proof(start, true, { events: max, closed: true }), identity, start).status).toBe('accepted');
    expect(() => proof(start, true, { events: max + 1 })).toThrow();
  });
  it('saves intent before each attempted revision and cannot erase an ambiguous request or rewrite replacement consent', async () => {
    const store = new HarvesterJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    for (const original of [command(head()), command(null, id(9)), { ...start, facility: { ...start.facility, completedBuildJobId: id(9) } }])
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, command: original } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1, refusal } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: null } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: proof() }] }))).rejects.toThrow();
  });
  it('keeps the original source interval/term immutable while events extend only by an exact prefix', async () => {
    const store = new HarvesterJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true, { events: 1 }) } }));
    const changed = proof(start, true, { events: 2 }); if (changed.status !== 'accepted') throw new Error('fixture'); changed.originalReceipt.source.term.termId = id(9);
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: changed } }))).rejects.toThrow('acceptance');
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true, { events: 2 }) } }));
    for (const raw of [proof(start, true, { events: 1 }), proof(start, true, { events: 2, capped: true })])
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: raw } }))).rejects.toThrow('prefix');
    const reordered = proof(start, true, { events: 2 }); if (reordered.status !== 'accepted') throw new Error('fixture'); reordered.settlement.events.reverse();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: reordered } }))).rejects.toThrow();
    expect((await store.read()).operation?.proof).toEqual(proof(start, true, { events: 2 }));
  });
  it('retains an immutable custody cutoff while earned events continue, then fixes the complete closure frontier', async () => {
    const store = new HarvesterJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true, { stopAfter: 2 }) } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }))).rejects.toThrow('custody stop');
    const changed = proof(start, true, { stopAfter: 2 }); if (changed.status !== 'accepted') throw new Error('fixture'); changed.settlement.custodyStop!.auditHash = 'c'.repeat(64);
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: changed } }))).rejects.toThrow('custody stop');
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true, { events: 2, stopAfter: 2, closed: true }) } }));
    for (const raw of [proof(start, true, { events: 2, stopAfter: 2 }), proof(start, true, { events: 3, stopAfter: 3, closed: true })])
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: raw } }))).rejects.toThrow('closure');
    expect(() => proof(start, true, { events: 1, stopAfter: 2, closed: true })).toThrow();
    expect(() => proof(start, true, { events: 3, stopAfter: 2 })).toThrow();
  });
  it.each(['unattempted', 'refused'] as const)('archived %s can gain positive evidence without changing historical absence, reason, refusal or attempts', async reason => {
    const store = new HarvesterJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    if (reason === 'refused') {
      saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
      saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }));
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason, evidence: proof() }] }));
    const before = saved.archives[0]!;
    for (const options of [{}, { events: 2 }, { events: 2, closed: true }]) saved = await store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: proof(start, true, options) } })) }));
    expect(saved.archives[0]).toEqual({ ...before, operation: { ...before.operation, proof: proof(start, true, { events: 2, closed: true }) } });
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, reason: 'accepted', evidence: null })) }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: proof(start, true, { events: 2 }) } })) }))).rejects.toThrow('closure');
  });
  it('forbids removing history, reusing any archived key or replacing positive acceptance with absence', async () => {
    const store = new HarvesterJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof() } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }))).rejects.toThrow('reused');
  });
  it('retains malformed saved bytes and refuses to reset original interval history', async () => {
    const factory = new IDBFactory(), name = 'corrupt-harvester', store = new HarvesterJournalStore(identity, factory, name); await store.read();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const corrupt = { originalIntervalEvidence: 'preserve' };
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('commands', 'readwrite'); tx.objectStore('commands').put(corrupt, store.key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    await expect(store.read()).rejects.toThrow(); await expect(store.compareAndSet(0, old => old)).rejects.toThrow();
    const saved = await new Promise<unknown>((resolve, reject) => { const r = db.transaction('commands').objectStore('commands').get(store.key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    expect(saved).toEqual(corrupt); db.close(); await store.close();
  });
  it('classifies only exact first-response refusal pairs, never a broad conflict or feature error', () => {
    for (const [status, code] of [[503, 'HARVESTERS_DISABLED'], [503, 'EXPEDITION_TERM_UNAVAILABLE'], [409, 'EXPEDITION_HOME_UNAVAILABLE'], [409, 'HARVESTER_SOURCE_CHANGED'], [409, 'HARVESTER_SOURCE_PENDING'], [409, 'HARVESTER_POLICY_CHANGED'], [409, 'HARVESTER_FACILITY_UNAVAILABLE'], [409, 'HARVESTER_SETTLEMENT_PENDING']] as const) expect(harvesterRefusalDefinitive(status, code)).toBe(true);
    for (const [status, code] of [[503, 'HARVESTER_SOURCE_CHANGED'], [409, 'IDEMPOTENCY_BODY_MISMATCH'], [409, 'EXPEDITION_LODGE_UNAVAILABLE'], [503, 'PHASE_E_DISABLED']] as const) expect(harvesterRefusalDefinitive(status, code)).toBe(false);
  });
});
