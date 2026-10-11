// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it } from 'vitest';
import metadata from '../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/pe_cosmetics.manifest.json';
import { boundCosmeticRecipe } from '@shardkeep/shared/phaseEBoundCosmetics';
import { matchWorkshopProof, parseWorkshopCommand, parseWorkshopJournal, WorkshopJournalStore, type WorkshopCommand, type WorkshopCommandMode, type WorkshopJournal } from './workshopJournal';
import { command, id, identity, now, proof } from './workshopFixtures.test-support';
const opened: WorkshopJournalStore[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(s => s.close())); });
function store(factory: IDBFactory, mode: WorkshopCommandMode = 'awning') {
  const result = new WorkshopJournalStore(identity, factory, mode); opened.push(result); return result;
}
function wake(): WorkshopCommand {
  const recipe = boundCosmeticRecipe('craft_aurora_wake_v1', 1), binding = metadata.bindings.aurora_wake;
  return { recipe, appearance: { version: 1, outputId: 'aurora_wake', sourceId: 'auroraWake',
    sourceManifestSha256: binding.value.sourceManifestSha256, sourceIndexSha256: binding.value.sourceIndexSha256, bindingSha256: binding.sha256 },
  request: { idempotencyKey: id(6), baseId: id(1), recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, appearanceBindingSha256: binding.sha256 } };
}
function completed(c: WorkshopCommand) {
  const p = proof(c); if (p.status !== 'accepted') throw Error('Fixture');
  return { ...p, serverNow: p.receipt.readyAt, completion: { completedAt: p.receipt.readyAt } };
}
async function bytes(factory: IDBFactory, name: string, write?: unknown): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = factory.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('commands'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try { return await new Promise<string>((resolve, reject) => {
    const tx = db.transaction('commands', write === undefined ? 'readonly' : 'readwrite'), rows = tx.objectStore('commands');
    if (write !== undefined) rows.put(write, JSON.stringify(identity));
    const request = rows.get(JSON.stringify(identity)); let raw: unknown;
    request.onsuccess = () => { raw = request.result; }; tx.oncomplete = () => resolve(JSON.stringify(raw)); tx.onabort = tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
it('reopens exact pre-extension Awning bytes without adding mode or rewriting the saved receipt', async () => {
  const factory = new IDBFactory(), c = command();
  const old: WorkshopJournal = { version: 1, identity, revision: 3, operation: { command: c, attempted: true, proof: proof(c) }, archives: [] };
  const before = await bytes(factory, 'pkw-bound-cosmetics-v1', old);
  expect(await store(factory).read()).toEqual(old); expect(await store(factory, 'awning').read()).toEqual(old);
  expect(await bytes(factory, 'pkw-bound-cosmetics-v1')).toBe(before);
  expect((await store(factory, 'wake').read()).operation).toBeNull();
  expect(parseWorkshopJournal(old, identity)).toEqual(old);
});
it('uses separate fixed journals but the unchanged account key for shared mutation coordination', async () => {
  const factory = new IDBFactory(), a = store(factory), w = store(factory, 'wake');
  expect(w.key).toBe(a.key); expect(w.key).toBe(JSON.stringify(identity));
  const save = async (s: WorkshopJournalStore, c: WorkshopCommand) => s.compareAndSet(0, old => ({ ...old, operation: { command: c, attempted: false, proof: null } }));
  await save(a, command()); const awningBytes = await bytes(factory, 'pkw-bound-cosmetics-v1'); await save(w, wake());
  expect(await bytes(factory, 'pkw-bound-cosmetics-v1')).toBe(awningBytes);
  expect((await store(factory).read()).operation?.command).toEqual(command());
  expect((await store(factory, 'wake').read()).operation?.command).toEqual(wake());
  expect((await store(factory, 'wake').read()).archives).toEqual([]);
});
it('admits only its closed command family and complete request recipe appearance binding', async () => {
  const c = wake(); expect(parseWorkshopCommand(c, 'wake')).toEqual(c);
  expect(() => parseWorkshopCommand(c)).toThrow(); expect(() => parseWorkshopCommand(command(), 'wake')).toThrow();
  expect(() => new WorkshopJournalStore(identity, new IDBFactory(), 'other' as WorkshopCommandMode)).toThrow();
  for (const changed of [ { ...c, recipe: command().recipe }, { ...c, appearance: command().appearance },
    { ...c, request: { ...c.request, appearanceBindingSha256: 'a'.repeat(64) } }, { ...c, mode: 'wake' } ]) {
    expect(() => parseWorkshopCommand(changed, 'wake')).toThrow();
  }
  expect(() => matchWorkshopProof(proof(c), identity, c)).toThrow();
  expect(matchWorkshopProof(proof(c), identity, c, 'wake').status).toBe('accepted');
  const w = store(new IDBFactory(), 'wake');
  await expect(w.compareAndSet(0, old => ({ ...old, operation: { command: command(), attempted: false, proof: null } }))).rejects.toThrow();
  expect((await w.read()).revision).toBe(0);
});
it('Wake unknown attempts cannot disappear archive change terms or reuse a stale tab revision', async () => {
  const factory = new IDBFactory(), w = store(factory, 'wake'), c = wake();
  let j = await w.compareAndSet(0, old => ({ ...old, operation: { command: c, attempted: false, proof: null } }));
  j = await w.compareAndSet(j.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
  const before = await bytes(factory, 'pkw-bound-cosmetics-wake-v1');
  for (const update of [ (old: WorkshopJournal) => ({ ...old, operation: null }),
    (old: WorkshopJournal) => ({ ...old, operation: null, archives: [old.operation!] }),
    (old: WorkshopJournal) => ({ ...old, operation: { ...old.operation!, attempted: false } }),
    (old: WorkshopJournal) => ({ ...old, operation: { ...old.operation!, command: { ...c, request: { ...c.request, baseId: id(90) } } } }) ]) {
    await expect(w.compareAndSet(j.revision, update)).rejects.toThrow();
  }
  await expect(store(factory, 'wake').compareAndSet(0, old => old)).rejects.toThrow('Another tab');
  expect(await bytes(factory, 'pkw-bound-cosmetics-wake-v1')).toBe(before);
});
it('retains accepted Wake terms and completion across late observations archival and reopen independently of Awnings', async () => {
  const factory = new IDBFactory(), w = store(factory, 'wake'), c = wake();
  let j = await w.compareAndSet(0, old => ({ ...old, operation: { command: c, attempted: false, proof: null } }));
  j = await w.compareAndSet(j.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true, proof: proof(c) } }));
  j = await w.compareAndSet(j.revision, old => ({ ...old, operation: { ...old.operation!, proof: completed(c) } }));
  const accepted = j.operation!;
  for (const changed of [null, proof(c), { ...completed(c), completion: { completedAt: new Date(Date.parse(now) + (c.recipe.durationSec + 1) * 1000).toISOString() } }]) {
    await expect(w.compareAndSet(j.revision, old => ({ ...old, operation: { ...old.operation!, proof: changed } }))).rejects.toThrow();
  }
  j = await w.compareAndSet(j.revision, old => ({ ...old, operation: null, archives: [old.operation!] }));
  expect((await store(factory, 'wake').read()).archives).toEqual([accepted]);
  await expect(w.compareAndSet(j.revision, old => ({ ...old, archives: [] }))).rejects.toThrow('history');
  await expect(w.compareAndSet(j.revision, old => ({ ...old, operation: { command: c, attempted: false, proof: null } }))).rejects.toThrow('key');
  expect((await store(factory).read()).operation).toBeNull();
});
it('holds foreign or corrupt Wake storage without modifying it or touching the original Awning namespace', async () => {
  const factory = new IDBFactory(), w = store(factory, 'wake');
  const foreign = { version: 1, identity: { ...identity, cluster: 'mainnet-beta' }, revision: 0, operation: null, archives: [] };
  const before = await bytes(factory, 'pkw-bound-cosmetics-wake-v1', foreign);
  await expect(w.read()).rejects.toThrow('another'); await expect(w.compareAndSet(0, old => old)).rejects.toThrow();
  expect(await bytes(factory, 'pkw-bound-cosmetics-wake-v1')).toBe(before);
  const corrupt = await bytes(factory, 'pkw-bound-cosmetics-wake-v1', { ...foreign, identity, operation: { command: wake(), attempted: 'yes', proof: null } });
  await expect(w.read()).rejects.toThrow(); expect(await bytes(factory, 'pkw-bound-cosmetics-wake-v1')).toBe(corrupt);
  expect((await store(factory).read()).operation).toBeNull();
});
