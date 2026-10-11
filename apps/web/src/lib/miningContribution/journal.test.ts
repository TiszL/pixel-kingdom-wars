import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { MiningContributionJournalStore, matchMiningContributionProof, parseMiningContributionIdentity, parseMiningContributionCommand } from './journal';
import { command, id, identity, proof, start } from './fixtures.test-support';
const intent = (store: MiningContributionJournalStore) => store.compareAndSet(0, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }));
it('isolates original records by origin, API, cluster and wallet; storage absence fails closed', async () => {
  const factory = new IDBFactory(), store = new MiningContributionJournalStore(identity, factory); await intent(store);
  for (const patch of [{ origin: 'https://other.test' }, { api: 'https://other.test/api' }, { cluster: 'mainnet-beta' as const }, { wallet: 'So11111111111111111111111111111111111111112' }])
    expect((await new MiningContributionJournalStore({ ...identity, ...patch }, factory).read()).operation).toBeNull();
  for (const patch of [{ origin: 'https://game.test/' }, { api: 'https://game.test/api/' }, { api: 'https://user:pass@game.test/api' }, { cluster: 'localnet' }])
    expect(() => parseMiningContributionIdentity({ ...identity, ...patch })).toThrow();
  await expect(new MiningContributionJournalStore(identity, undefined).read()).rejects.toThrow('storage');
});
it('rejects fractional/coerced/duplicate resource lines and mismatched or future evidence', () => {
  for (const quantity of ['1.5', '01', '0', 1, null]) expect(() => parseMiningContributionCommand({ request: { ...start.request, lines: [{ resourceId: 'frost_quartz', quantity }] } })).toThrow();
  expect(() => parseMiningContributionCommand({ request: { ...start.request, lines: [...start.request.lines, ...start.request.lines] } })).toThrow();
  for (const patch of [{ wallet: 'So11111111111111111111111111111111111111112' }, { idempotencyKey: id(9) }, { serverNow: '2026-09-29T00:00:00.000Z' }])
    expect(() => matchMiningContributionProof({ ...proof(start, true), ...patch }, identity, start)).toThrow();
  expect(() => matchMiningContributionProof(proof(command('2'), true), identity, start)).toThrow();
});
it('preserves exact original key/body, attempt marker and ambiguity across competing writes', async () => {
  const store = new MiningContributionJournalStore(identity, new IDBFactory()); let saved = await intent(store);
  await expect(store.compareAndSet(0, old => old)).rejects.toThrow('Another tab');
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, command: command('2') } }))).rejects.toThrow();
  saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null }))).rejects.toThrow();
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: null } }))).rejects.toThrow();
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: proof() }] }))).rejects.toThrow();
});
it('only advances immutable accepted receipts to one permanent settlement, including after archive', async () => {
  const store = new MiningContributionJournalStore(identity, new IDBFactory()); let saved = await intent(store);
  saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: proof(start, true) } }));
  saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'accepted', evidence: null }] }));
  saved = await store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: proof(start, true, true) } })) }));
  const changed = proof(start, true, true); if (changed.status !== 'accepted' || !changed.settlement) throw Error('fixture'); changed.settlement.outcome = 'returned';
  for (const replacement of [null, proof(start, true), changed]) await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: old.archives.map(row => ({ ...row, operation: { ...row.operation, proof: replacement } })) }))).rejects.toThrow();
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, archives: [] }))).rejects.toThrow();
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: start, attemptRevision: null, proof: null, refusal: null } }))).rejects.toThrow('reused');
});
it('can discard an unsent draft only with matching original absence evidence', async () => {
  const store = new MiningContributionJournalStore(identity, new IDBFactory()); let saved = await intent(store);
  for (const evidence of [null, proof(start, true), proof(command('1', id(9)))])
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence }] }))).rejects.toThrow();
  saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: null, archives: [{ operation: old.operation!, reason: 'unattempted', evidence: proof() }] }));
  expect(saved.archives[0]?.operation.command).toEqual(start);
});
