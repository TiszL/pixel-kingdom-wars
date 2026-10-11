import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { StarterExpeditionJournalStore, matchStarterExpeditionProof, parseStarterExpeditionCommand, parseStarterExpeditionIdentity, parseStarterExpeditionJournal,
  starterExpeditionRefusalDefinitive, type StarterExpeditionRefusal } from './journal';
import { command, id, identity, installation, now, proof, start } from './fixtures.test-support';
const refusal: StarterExpeditionRefusal = { phase: 'first_post', status: 503, code: 'EXPEDITION_TERM_UNAVAILABLE' };
const intent = (store: StarterExpeditionJournalStore, original = start) => store.compareAndSet(0, old => ({ ...old, operation: { command: original, attemptRevision: null, proof: null, refusal: null } }));
describe('starter departure original journal', () => {
  it('isolates exact origin/API/cluster/wallet and prevents stale cross-tab intent writes', async () => {
    const factory = new IDBFactory(), store = new StarterExpeditionJournalStore(identity, factory); await intent(store);
    await expect(new StarterExpeditionJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const patch of [{ origin: 'https://other.test' }, { api: 'https://other.test/api' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }]) expect((await new StarterExpeditionJournalStore({ ...identity, ...patch }, factory).read()).operation).toBeNull();
    for (const patch of [{ origin: 'https://game.test/' }, { api: 'https://u:p@game.test/api' }, { api: 'https://game.test/api?x=1' }, { cluster: 'localnet' }, { wallet: 'bad' }]) expect(() => parseStarterExpeditionIdentity({ ...identity, ...patch })).toThrow();
    await expect(new StarterExpeditionJournalStore(identity, undefined).read()).rejects.toThrow('storage'); expect(() => parseStarterExpeditionJournal({}, identity)).toThrow();
  });
  it('requires strict original scalars and full route/installation linkage without client term or clock assertions', () => {
    for (const patch of [{ routeVersion: '2' }, { rewardVersion: 1.5 }, { termId: id(9) }, { home: 'frostveil' }, { currency: 'sol' }, { observedAt: now }, { installationId: id(9) }, { baseId: id(9) }]) expect(() => parseStarterExpeditionCommand({ ...start, request: { ...start.request, ...patch } })).toThrow();
    for (const route of [{ ...start.route, grossQuantity: 1 }, { ...start.route, netQuantity: '-1' }, { ...start.route, durationSec: '1' }, { ...start.route, islandPoolQuantity: (BigInt(start.route.islandPoolQuantity) + 1n).toString() }, { ...start.route, routeId: 'different' }]) expect(() => parseStarterExpeditionCommand({ ...start, route })).toThrow();
    expect(() => parseStarterExpeditionCommand({ ...start, installation: null })).toThrow();
    expect(() => parseStarterExpeditionCommand({ ...start, installation: { ...installation(), baseId: id(9) } })).toThrow();
  });
  it('preserves historical route terms independently of current tuning and never strips a common-access marker', () => {
    const legacy = parseStarterExpeditionCommand({ ...start, request: { ...start.request, routeVersion: 1, rewardVersion: 1 }, route: { ...start.route, routeCatalogueVersion: 1, rewardTableVersion: 1,
      durationSec: 13, grossQuantity: '100', netQuantity: '97', islandPoolQuantity: '3' } });
    expect(matchStarterExpeditionProof(proof(legacy, true), identity, legacy).status).toBe('accepted');
    const common = command('common_cinderfall'), stripped: Record<string, unknown> = { ...common.route }; delete stripped.access;
    expect(() => parseStarterExpeditionCommand({ ...common, route: stripped })).toThrow();
    expect(matchStarterExpeditionProof(proof(common, true), identity, common).status).toBe('accepted');
  });
  it('rejects receipt body, term-format, chronology, future observation and unbalanced reward corruption', () => {
    for (const patch of [{ wallet: 'So11111111111111111111111111111111111111112' }, { idempotencyKey: id(9) }]) expect(() => matchStarterExpeditionProof({ ...proof(start, true), ...patch }, identity, start)).toThrow();
    for (const kind of ['term', 'route', 'deadline', 'before-install', 'future-departure', 'future-return', 'early-return'] as const) {
      const raw = proof(start, true, kind.includes('return')); if (raw.status !== 'accepted') throw new Error('fixture');
      if (kind === 'term') raw.receipt.termHash = 'Z'.repeat(64);
      else if (kind === 'route') raw.receipt.route = { ...raw.receipt.route, netQuantity: (BigInt(raw.receipt.route.netQuantity) + 1n).toString() };
      else if (kind === 'deadline') raw.receipt.returnsAt = now;
      else if (kind === 'future-return') raw.serverNow = now;
      else if (kind === 'early-return') raw.return!.returnedAt = now;
      else {
        raw.receipt.departedAt = kind === 'before-install' ? '2026-09-22T10:00:00.000Z' : '2026-09-23T12:00:00.000Z';
        raw.receipt.returnsAt = new Date(Date.parse(raw.receipt.departedAt) + raw.receipt.route.durationSec * 1_000).toISOString();
      }
      expect(() => matchStarterExpeditionProof(raw, identity, start)).toThrow();
    }
    const changed = proof(command('coastal_survey'), true); expect(() => matchStarterExpeditionProof(changed, identity, start)).toThrow();
  });
  it('persists intent before each attempt and cannot erase uncertainty or replace reviewed route/vehicle', async () => {
    const store = new StarterExpeditionJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    for (const original of [command('coastal_survey'), command('introduction', id(9)), { ...start, installation: { ...start.installation, installedAt: '2026-09-22T11:10:00.000Z' } }]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, command: original } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1, refusal } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: null } }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: proof() }] }))).rejects.toThrow();
  });
  it('keeps original departure/term immutable while return advances once and cannot regress in active or archived history', async () => {
    const store = new StarterExpeditionJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }));
    const changed = proof(start, true); if (changed.status !== 'accepted') throw new Error('fixture'); changed.receipt.termId = id(9);
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: changed } }))).rejects.toThrow();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true, true) } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }))).rejects.toThrow('return');
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
    const changedReturn = proof(start, true, true); if (changedReturn.status !== 'accepted') throw new Error('fixture'); changedReturn.return!.returnId = id(9);
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: changedReturn } })) }))).rejects.toThrow('return');
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }))).rejects.toThrow('reused');
  });
  it.each(['unattempted', 'refused'] as const)('archived %s preserves original absence/reason/refusal when acceptance and return later arrive', async reason => {
    const store = new StarterExpeditionJournalStore(identity, new IDBFactory()); let saved = await intent(store);
    if (reason === 'refused') {
      saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
      saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, refusal } }));
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason, evidence: proof() }] }));
    const before = saved.archives[0]!;
    for (const returned of [false, true]) saved = await store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: proof(start, true, returned) } })) }));
    expect(saved.archives[0]).toEqual({ ...before, operation: { ...before.operation, proof: proof(start, true, true) } });
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, reason: 'accepted', evidence: null })) }))).rejects.toThrow();
  });
  it('retains malformed saved bytes and refuses to reset the original journal', async () => {
    const factory = new IDBFactory(), name = 'corrupt-starter-expedition', store = new StarterExpeditionJournalStore(identity, factory, name); await store.read();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const corrupt = { originalTermEvidence: 'preserve' };
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('commands', 'readwrite'); tx.objectStore('commands').put(corrupt, store.key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    await expect(store.read()).rejects.toThrow(); await expect(store.compareAndSet(0, old => old)).rejects.toThrow();
    const saved = await new Promise<unknown>((resolve, reject) => { const r = db.transaction('commands').objectStore('commands').get(store.key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    expect(saved).toEqual(corrupt); db.close(); await store.close();
  });
  it('classifies only the exact departure first-refusal status/code pairs, excluding installation or key conflicts', () => {
    for (const [status, code] of [[503, 'STARTER_EXPEDITIONS_DISABLED'], [503, 'EXPEDITION_TERM_UNAVAILABLE'], [409, 'EXPEDITION_HOME_UNAVAILABLE'], [409, 'STARTER_FLEET_UNAVAILABLE'], [409, 'STARTER_EXPEDITION_INFLIGHT'], [409, 'EXPEDITION_LODGE_UNAVAILABLE'], [400, 'EXPEDITION_ROUTE_INVALID'], [409, 'EXPEDITION_ROUTE_CHANGED']] as const) expect(starterExpeditionRefusalDefinitive(status, code)).toBe(true);
    for (const [status, code] of [[500, 'EXPEDITION_TERM_UNAVAILABLE'], [409, 'IDEMPOTENCY_BODY_MISMATCH'], [409, 'STARTER_BERTH_UNAVAILABLE'], [503, 'PHASE_E_DISABLED']] as const) expect(starterExpeditionRefusalDefinitive(status, code)).toBe(false);
  });
});
