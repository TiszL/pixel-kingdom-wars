import { currentOrdinaryCraftingRecipes } from '@shardkeep/shared/ordinaryCraftingApi';
import { ORDINARY_CRAFTING_ITEM_IDS, ordinaryCraftingRecipe } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { OrdinaryCraftingController, ordinaryCraftingBatch, type OrdinaryCraftingPorts } from './controller';
import { OrdinaryCraftingJournalStore } from './journal';
import { base, command, deferred, id, identity, proof, start, view } from './fixtures.test-support';
let factory: IDBFactory, store: OrdinaryCraftingJournalStore, controller: OrdinaryCraftingController, ports: OrdinaryCraftingPorts;
let accepted: boolean, completed: boolean, selected: string, baseEpoch: number, sessionEpoch: number, active: boolean, locked: boolean;
let currentView: ReturnType<typeof view>, currentBase: unknown, original: ReturnType<typeof command>;
beforeEach(() => {
  factory = new IDBFactory(); store = new OrdinaryCraftingJournalStore(identity, factory); accepted = false; completed = false;
  selected = id(1); baseEpoch = 0; sessionEpoch = 0; active = true; locked = false; currentView = view(); currentBase = base(); original = start;
  ports = {
    get: vi.fn(async (path, guard) => { guard(); return path.startsWith('/base?') ? currentBase : currentView; }),
    getProof: vi.fn(async (request, guard, retain) => { guard(); expect(request).toEqual(original.request); const raw = proof(original, accepted, completed); await retain(raw); guard(); return raw; }),
    post: vi.fn(async (request, guard, retain, _observe, firstAttempt) => {
      guard(); const saved = await store.read(); expect(saved.operation?.command.request).toEqual(request);
      expect(saved.operation?.attemptRevision).toBe(saved.revision); expect(firstAttempt).toBe(true);
      accepted = true; const raw = proof(original, true); await retain(raw); guard(); return raw;
    }),
    capture: baseId => { const session = sessionEpoch, selection = baseEpoch; return () => {
      if (!active || session !== sessionEpoch || baseId && (baseId !== selected || selection !== baseEpoch)) throw new Error('session or base changed');
    }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab owns this command'); locked = true; try { return await run(); } finally { locked = false; } },
    key: () => original.request.idempotencyKey,
  };
  controller = new OrdinaryCraftingController(store, ports);
});
const begin = () => controller.beginStart(original.request.baseId, original.request.recipeId, original.request.quantity);
const hydrate = async (guard: () => void) => { guard(); };
describe('ordinary refining explicit consent and historical recovery', () => {
  it('saves exact server-scaled review and durable attempt before the sole explicit POST', async () => {
    original = command(2); await begin(); expect(ports.post).not.toHaveBeenCalled();
    expect(controller.snapshot().review?.command).toEqual(original);
    expect(ordinaryCraftingBatch(currentView.recipes[0]!, 2)).toEqual(original.recipe);
    await controller.confirm(); expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledOnce();
    expect((await store.read()).operation?.proof).toEqual(proof(original, true));
    const stockBefore = structuredClone(currentView); const refreshed = vi.fn(hydrate);
    await controller.finish(refreshed); expect(refreshed).toHaveBeenCalledOnce();
    expect((await store.read()).operation).toBeNull(); expect((await store.read()).archives[0]?.operation.command).toEqual(original);
    expect(currentView).toEqual(stockBefore); // accepted quantity is never a live-stock grant
  });
  it('lost acknowledgment recovers through GET while paused and after the original base changes', async () => {
    ports.post = vi.fn(async () => { accepted = true; throw new Error('lost acknowledgement'); });
    await begin(); await controller.confirm(); expect((await store.read()).operation?.proof).toBeNull();
    selected = id(9); baseEpoch++; currentView.acceptingJobs = false; currentBase = null;
    controller = new OrdinaryCraftingController(new OrdinaryCraftingJournalStore(identity, factory), ports);
    vi.mocked(ports.get).mockClear(); await controller.open(); await controller.reviewCommand(); await controller.confirm();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledOnce();
    await controller.finish(hydrate); expect((await store.read()).archives).toHaveLength(1);
  });
  it('unknown retries retain exact original body/key and require another explicit review', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost request')); await begin(); await controller.confirm();
    const firstRevision = (await store.read()).operation!.attemptRevision;
    controller = new OrdinaryCraftingController(new OrdinaryCraftingJournalStore(identity, factory), ports);
    await controller.open(); await controller.confirm(); expect(ports.post).toHaveBeenCalledOnce();
    await controller.beginStart(id(1), start.request.recipeId, 2); expect((await store.read()).operation?.command).toEqual(start);
    await controller.reviewCommand(); await controller.confirm(); expect(ports.post).toHaveBeenCalledTimes(2);
    expect((await store.read()).operation!.attemptRevision).toBeGreaterThan(firstRevision!);
    expect(vi.mocked(ports.post).mock.calls.map(call => [call[0], call[4]])).toEqual([[start.request, true], [start.request, false]]);
    await controller.abandonDraft(); expect((await store.read()).operation).not.toBeNull(); expect((await store.read()).archives).toHaveLength(0);
  });
  it.each(['missing', 'constructing', 'zero', 'coerced', 'foreign-base', 'foreign-wallet'] as const)('refuses %s Workshop authority before a new intent or POST', async kind => {
    const b = base();
    if (kind === 'missing') b.buildings = [];
    else if (kind === 'constructing') b.buildings[0]!.underConstruction = true;
    else if (kind === 'zero') b.buildings[0]!.level = 0;
    else if (kind === 'coerced') currentBase = { ...b, buildings: [{ ...b.buildings[0], level: '1' }] };
    else if (kind === 'foreign-base') b.baseId = id(9);
    else b.player.wallet = 'So11111111111111111111111111111111111111112';
    if (kind !== 'coerced') currentBase = b;
    await begin(); expect((await store.read()).operation).toBeNull(); expect(controller.snapshot().error).toContain('completed Workshop'); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['facility', 'paused', 'raw', 'crafting', 'recipe', 'output-space', 'busy'] as const)('fresh %s admission invalidates earlier consent without any POST', async kind => {
    if (kind === 'crafting') {
      const recipe = currentView.recipes.find(row => row.recipeId === 'craft_navigation_kit')!;
      original = { request: { ...start.request, recipeId: recipe.recipeId }, recipe };
    }
    await begin(); expect(controller.snapshot().review).not.toBeNull();
    if (kind === 'facility') currentBase = { ...base(), buildings: [] };
    else if (kind === 'paused') currentView.acceptingJobs = false;
    else if (kind === 'raw') { const row = currentView.rawStock.find(row => row.resourceId === original.recipe.inputs[0]!.itemId)!; row.available = '0'; row.total = '0'; }
    else if (kind === 'crafting') currentView.craftingStock.find(row => row.itemId === original.recipe.inputs[0]!.itemId)!.available = '0';
    else if (kind === 'recipe') currentView = { ...currentView, recipes: currentView.recipes.map(row => ({ ...row, durationSec: row.durationSec + 1 })) };
    else if (kind === 'output-space') currentView.craftingStock.find(row => row.itemId === original.recipe.output.itemId)!.available = '9223372036854775807';
    else {
      const acceptedProof = proof(original, true); if (acceptedProof.status !== 'accepted') throw new Error('fixture');
      const { jobId, recipe, startedAt, readyAt } = acceptedProof.receipt;
      currentView.pendingJobs = [{ jobId, recipe, startedAt, readyAt }];
      currentView.craftingStock.find(row => row.itemId === recipe.output.itemId)!.pendingOutput = recipe.output.quantity;
    }
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review).toBeNull();
    expect((await store.read()).operation?.attemptRevision).toBeNull();
  });
  it('GET probe failure retains unsent original intent but never authorizes confirmation', async () => {
    ports.getProof = vi.fn().mockRejectedValue(new Error('unsupported endpoint')); await begin();
    expect((await store.read()).operation?.command).toEqual(start); expect(controller.snapshot().review).toBeNull();
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['intent', 'attempt'] as const)('failed durable %s write cannot enqueue a mutation', async stage => {
    if (stage === 'attempt') await begin();
    vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    if (stage === 'intent') await begin(); else await controller.confirm();
    expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().error).toContain('disk full');
  });
  it.each(['base-aba', 'session', 'hidden', 'dismiss'] as const)('rechecks %s at actual enqueue after waits', async kind => {
    await begin(); const entered = deferred(), release = deferred();
    ports.post = vi.fn(async (_request, guard, retain) => { entered.resolve(); await release.promise; guard(); accepted = true; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise;
    if (kind === 'base-aba') { selected = id(9); baseEpoch++; selected = id(1); baseEpoch++; }
    else if (kind === 'session') sessionEpoch++; else if (kind === 'hidden') active = false; else controller.dismiss();
    const snapshot = controller.snapshot(); release.resolve(); await work; expect(controller.snapshot()).toBe(snapshot); expect(accepted).toBe(false); expect((await store.read()).operation?.attemptRevision).not.toBeNull();
    expect((await store.read()).operation?.proof).toBeNull();
  });
  it.each(['POST', 'GET'] as const)('owned %s acceptance persists after dismissal/session loss without obsolete publication', async kind => {
    await begin(); const entered = deferred(), release = deferred();
    if (kind === 'POST') ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    else ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    const work = kind === 'POST' ? controller.confirm() : controller.open(); await entered.promise;
    controller.dismiss(); sessionEpoch++; const snapshot = controller.snapshot(); release.resolve(); await work;
    expect((await store.read()).operation?.proof).toEqual(proof(start, true)); expect(controller.snapshot()).toBe(snapshot);
  });
  it('failed accepted-body persistence keeps the attempted original and recovers it by GET on reload', async () => {
    await begin(); const compare = store.compareAndSet.bind(store);
    ports.post = vi.fn(async (_request, guard, retain) => {
      guard(); accepted = true; vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('receipt disk full'));
      const raw = proof(start, true); await retain(raw); return raw;
    });
    await controller.confirm(); expect((await store.read()).operation?.proof).toBeNull(); expect(controller.snapshot().error).toContain('disk full');
    store.compareAndSet = compare; controller = new OrdinaryCraftingController(store, ports); await controller.open();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect(ports.post).toHaveBeenCalledOnce();
  });
  it.each(['wallet', 'key', 'body', 'partial'] as const)('rejects mismatched or incomplete %s response without saving fabricated acceptance', async kind => {
    await begin(); const raw = proof(start, true); if (raw.status !== 'accepted') throw new Error('fixture');
    let invalid: unknown = raw;
    if (kind === 'wallet') raw.wallet = 'So11111111111111111111111111111111111111112';
    else if (kind === 'key') raw.idempotencyKey = id(9);
    else if (kind === 'body') invalid = proof(command(2), true);
    else invalid = { status: 'accepted' };
    ports.getProof = vi.fn(async (_request, _guard, retain) => { await retain(invalid); return invalid; });
    await controller.open(); expect((await store.read()).operation?.proof).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('another tab cannot read/submit while the first response owner still retains its body', async () => {
    await begin(); const entered = deferred(), release = deferred();
    ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise; const count = vi.mocked(ports.getProof).mock.calls.length;
    await controller.confirm(); const other = new OrdinaryCraftingController(new OrdinaryCraftingJournalStore(identity, factory), ports); await other.open();
    expect(other.snapshot().error).toContain('Another tab'); expect(ports.getProof).toHaveBeenCalledTimes(count);
    release.resolve(); await work; expect(ports.post).toHaveBeenCalledOnce(); expect(locked).toBe(false);
  });
});
describe('ordinary refining refusal fencing and history', () => {
  const refusal = new ApiError(422, 'not enough raw stock', 'INSUFFICIENT_RAW_STOCK');
  it.each([false, true])('retains original first refusal only at its attempted revision; competing revision=%s', async competing => {
    let attemptRevision = 0;
    ports.post = vi.fn(async (_request, _guard, _retain, observe) => {
      attemptRevision = (await store.read()).revision;
      if (competing) await store.compareAndSet(attemptRevision, old => old);
      await observe(refusal); await observe(refusal); throw refusal;
    });
    await begin(); await controller.confirm(); const saved = await store.read();
    expect(saved.revision).toBe(attemptRevision + 1); expect(saved.operation?.refusal).toEqual(competing ? null : { phase: 'first_post', status: 422, code: 'INSUFFICIENT_RAW_STOCK' });
  });
  it('SHARDS ingredient rollback permits archival only after fresh original absence', async () => {
    const shortage = new ApiError(422, 'Insufficient SHARDS', 'ledger.insufficient_funds');
    ports.post = vi.fn(async (_request, _guard, _retain, observe) => { await observe(shortage); throw shortage; });
    await begin(); await controller.confirm();
    expect((await store.read()).operation?.refusal).toEqual({ phase: 'first_post', status: 422, code: 'ledger.insufficient_funds' });
    await controller.archiveRefusal();
    expect((await store.read()).operation).toBeNull();
    expect((await store.read()).archives.at(-1)?.reason).toBe('refused');
  });
  it('a later retry refusal and delayed first-attempt callback cannot erase earlier ambiguity', async () => {
    let oldObserver!: (error: unknown) => Promise<void>;
    ports.post = vi.fn(async (_request, _guard, _retain, observe) => { oldObserver = observe; throw new Error('ambiguous first attempt'); });
    await begin(); await controller.confirm(); const delayed = oldObserver;
    ports.post = vi.fn(async (_request, _guard, _retain, observe, first) => { expect(first).toBe(false); await delayed(refusal); await observe(refusal); throw refusal; });
    await controller.reviewCommand(); await controller.confirm(); expect((await store.read()).operation?.refusal).toBeNull();
    await controller.archiveRefusal(); await controller.abandonDraft(); expect((await store.read()).archives).toHaveLength(0);
  });
  it('complete owned first refusal saves after cancellation, but later acceptance wins during recovery', async () => {
    await begin(); const entered = deferred(), release = deferred();
    ports.post = vi.fn(async (_request, guard, _retain, observe) => { guard(); entered.resolve(); await release.promise; await observe(refusal); guard(); throw refusal; });
    const work = controller.confirm(); await entered.promise; controller.dismiss(); const snapshot = controller.snapshot(); release.resolve(); await work;
    expect((await store.read()).operation?.refusal?.code).toBe('INSUFFICIENT_RAW_STOCK'); expect(controller.snapshot()).toBe(snapshot);
    accepted = true; selected = id(9); currentBase = null; currentView.acceptingJobs = false;
    controller = new OrdinaryCraftingController(store, ports); await controller.reviewCommand();
    expect((await store.read()).operation).toMatchObject({ proof: { status: 'accepted' }, refusal: { code: 'INSUFFICIENT_RAW_STOCK' } });
    await controller.finish(hydrate); expect((await store.read()).archives[0]!.reason).toBe('accepted'); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('explicit refusal archival needs fresh unknown proof; newly positive proof is retained instead', async () => {
    ports.post = vi.fn().mockRejectedValue(refusal); await begin(); await controller.confirm();
    accepted = true; await controller.archiveRefusal(); expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0);
    await controller.finish(hydrate); expect((await store.read()).archives[0]?.reason).toBe('accepted');
  });
  it.each(['draft', 'refused'] as const)('explicit %s archival uses only GET and preserves original command and absence evidence', async kind => {
    await begin(); if (kind === 'refused') { ports.post = vi.fn().mockRejectedValue(refusal); await controller.confirm(); }
    selected = id(9); baseEpoch++; currentBase = null; vi.mocked(ports.get).mockClear();
    if (kind === 'draft') await controller.abandonDraft(); else await controller.archiveRefusal();
    const saved = await store.read(); expect(saved.operation).toBeNull(); expect(saved.archives[0]).toMatchObject({ reason: kind === 'draft' ? 'unattempted' : 'refused', operation: { command: start }, evidence: { status: 'unknown' } });
    expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledTimes(kind === 'draft' ? 0 : 1);
  });
  it('failed current hydration leaves accepted operation active and requires another explicit finish', async () => {
    await begin(); await controller.confirm(); await controller.finish(async () => { throw new Error('current snapshot failed'); });
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0);
    expect(controller.snapshot().error).toContain('snapshot failed'); await controller.finish(hydrate); expect((await store.read()).archives).toHaveLength(1);
  });
  it.each(['draft', 'refused'] as const)('positive original proof after %s archive preserves absence/refusal and only advances acceptance with GET', async kind => {
    await begin(); if (kind === 'refused') { ports.post = vi.fn().mockRejectedValue(refusal); await controller.confirm(); }
    if (kind === 'draft') await controller.abandonDraft(); else await controller.archiveRefusal();
    const archived = (await store.read()).archives[0]!;
    selected = id(9); baseEpoch++; currentView.acceptingJobs = false; currentBase = null; accepted = true;
    vi.mocked(ports.get).mockClear(); await controller.checkArchived(start.request.idempotencyKey);
    let row = (await store.read()).archives[0]!;
    expect(row).toMatchObject({ reason: archived.reason, evidence: archived.evidence, operation: { refusal: archived.operation.refusal, proof: proof(start, true) } });
    completed = true; await controller.open(); row = (await store.read()).archives[0]!;
    expect(row.operation.proof).toEqual(proof(start, true, true));
    accepted = false; await controller.checkArchived(start.request.idempotencyKey);
    expect(controller.snapshot().error).toContain('missing'); expect((await store.read()).archives[0]).toEqual(row);
    expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledTimes(kind === 'draft' ? 0 : 1);
  });
  it('competing journal revision during hydration blocks archive without dropping original evidence', async () => {
    await begin(); await controller.confirm(); await controller.finish(async guard => { guard(); const saved = await store.read(); await store.compareAndSet(saved.revision, old => old); });
    expect(controller.snapshot().error).toContain('Another tab'); expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0);
  });
  it('foreground advances archived completion with GET only, stops automatic reads after completion and rejects regressions', async () => {
    await begin(); await controller.confirm(); await controller.finish(hydrate); completed = true;
    vi.mocked(ports.getProof).mockClear(); await controller.open(); expect(ports.getProof).toHaveBeenCalledOnce();
    const saved = await store.read(); expect(saved.archives[0]?.operation.proof).toEqual(proof(start, true, true));
    vi.mocked(ports.getProof).mockClear(); await controller.open(); expect(ports.getProof).not.toHaveBeenCalled();
    completed = false; await controller.checkArchived(start.request.idempotencyKey); expect(controller.snapshot().error).toContain('completion');
    expect((await store.read()).archives).toEqual(saved.archives); accepted = false;
    await controller.checkArchived(start.request.idempotencyKey); expect(controller.snapshot().error).toContain('missing'); expect((await store.read()).archives).toEqual(saved.archives);
    expect(ports.post).toHaveBeenCalledOnce();
  });
  it('an unreadable journal fails loud and no recovery or mutation transport starts', async () => {
    vi.spyOn(store, 'read').mockRejectedValue(new Error('corrupt original journal')); await controller.open(); await begin();
    expect(controller.snapshot().error).toContain('corrupt original'); expect(ports.getProof).not.toHaveBeenCalled(); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).not.toHaveBeenCalled();
  });
});

// D153.208: the SHARDS leaf is part of consent and cannot be replaced by a
// wallet balance, a later catalogue, or a new idempotency key on recovery.
it('rechecks the selected kingdom SHARDS ingredient before sending an Expedition job', async () => {
  const recipe = currentView.recipes.find(row => row.recipeId === 'craft_expedition_kit')!;
  original = { request: { ...start.request, recipeId: recipe.recipeId }, recipe };
  await begin(); expect(controller.snapshot().review?.command.recipe).toEqual(recipe);
  expect(vi.mocked(ports.get).mock.calls.some(([path]) => path.endsWith('&catalogueVersion=2'))).toBe(true);
  if (!('shardsAvailable' in currentView)) throw Error('Missing new catalogue fixture');
  currentView.shardsAvailable = '0';
  await controller.confirm(); expect(ports.post).not.toHaveBeenCalled();
  expect((await store.read()).operation?.attemptRevision).toBeNull();
  expect(controller.snapshot().error).toContain('ingredients are unavailable');
});
it('recovers an unknown saved v1 command and explicitly reviews its original catalogue without rewriting it', async () => {
  const recipe = ordinaryCraftingRecipe('refine_frostglass', 1, 1);
  original = { request: { ...start.request, recipeVersion: 1 }, recipe };
  const initial = await store.read();
  const draft = await store.compareAndSet(initial.revision, old => ({ ...old, operation: { command: original, attemptRevision: null, proof: null, refusal: null } }));
  await store.compareAndSet(draft.revision, old => ({ ...old, operation: { ...old.operation!, attemptRevision: old.revision + 1 } }));
  const oldPolicy = currentOrdinaryCraftingRecipes();
  const { catalogueVersion: _version, shardsAvailable: _shards, ...oldView } = view() as ReturnType<typeof view> & { catalogueVersion: 2; shardsAvailable: string };
  currentView = { ...oldView, ...oldPolicy, craftingStock: oldView.craftingStock.filter(row => (ORDINARY_CRAFTING_ITEM_IDS as readonly string[]).includes(row.itemId)) };
  const paths: string[] = [];
  ports.get = vi.fn(async path => { paths.push(path); return path.startsWith('/base?') ? currentBase : currentView; });
  ports.post = vi.fn(async (_request, _guard, retain) => { accepted = true; const result = proof(original, true); await retain(result); return result; });
  await controller.open(); expect(ports.post).not.toHaveBeenCalled();
  await controller.reviewCommand(); expect(controller.snapshot().review?.command).toEqual(original);
  expect(paths).toContain(`/ordinary-crafting?baseId=${id(1)}`);
  await controller.confirm(); expect(ports.post).toHaveBeenCalledOnce();
  expect((await store.read()).operation?.command).toEqual(original);
});
it('refuses a downgraded catalogue before saving a new job', async () => {
  const { catalogueVersion: _version, shardsAvailable: _shards, ...legacy } = view() as ReturnType<typeof view> & { catalogueVersion: 2; shardsAvailable: string };
  currentView = { ...legacy, ...currentOrdinaryCraftingRecipes(), craftingStock: legacy.craftingStock.filter(row => (ORDINARY_CRAFTING_ITEM_IDS as readonly string[]).includes(row.itemId)) };
  await begin(); expect((await store.read()).operation).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  expect(controller.snapshot().error).toContain('catalogue');
});
