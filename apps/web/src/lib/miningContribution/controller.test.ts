import { miningContributionResourceIds, miningResourceUnitValue } from '@shardkeep/shared/miningContribution';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { MiningContributionController, contributionTotal, type MiningContributionPorts } from './controller';
import { MiningContributionJournalStore } from './journal';
import { command, deferred, id, identity, proof, start, view } from './fixtures.test-support';
let factory: IDBFactory, store: MiningContributionJournalStore, controller: MiningContributionController, ports: MiningContributionPorts;
let accepted: boolean, settled: boolean, selected: string, baseEpoch: number, sessionEpoch: number, active: boolean, locked: boolean;
let currentView: ReturnType<typeof view>, original: ReturnType<typeof command>;
beforeEach(() => {
  factory = new IDBFactory(); store = new MiningContributionJournalStore(identity, factory); accepted = false; settled = false;
  selected = id(1); baseEpoch = 0; sessionEpoch = 0; active = true; locked = false; currentView = view(); original = command();
  ports = {
    get: vi.fn(async (_path, guard) => { guard(); return currentView; }),
    getProof: vi.fn(async (request, guard, retain) => { guard(); expect(request).toEqual(original.request); const raw = proof(original, accepted, settled); await retain(raw); guard(); return raw; }),
    post: vi.fn(async (request, guard, retain) => { guard(); const saved = await store.read(); expect(saved.operation?.command.request).toEqual(request);
      expect(saved.operation?.attemptRevision).toBe(saved.revision); accepted = true; const raw = proof(original, true); await retain(raw); guard(); return raw; }),
    capture: baseId => { const session = sessionEpoch, selection = baseEpoch; return () => {
      if (!active || session !== sessionEpoch || baseId && (baseId !== selected || selection !== baseEpoch)) throw new Error('session or base changed');
    }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab owns this command'); locked = true; try { return await run(); } finally { locked = false; } },
    key: () => original.request.idempotencyKey,
  };
  controller = new MiningContributionController(store, ports);
});
const begin = () => controller.begin(original.request.baseId, original.request.lines);
it('saves exact server-valued basket and attempt before explicit POST; history never credits live stock', async () => {
  original = command('2'); await begin(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review?.command).toEqual(original);
  expect(contributionTotal(currentView, original.request.lines)).toBe(2n * BigInt(currentView.resources.find(row => row.resourceId === 'frost_quartz')!.unitValue));
  await controller.confirm(); expect(controller.snapshot().error).toBeNull(); expect((await store.read()).operation?.proof).toEqual(proof(original, true));
  const before = structuredClone(currentView); await controller.finish(); expect((await store.read()).archives[0]?.operation.command).toEqual(original);
  expect(currentView).toEqual(before); expect(ports.post).toHaveBeenCalledOnce();
});
it('lost acceptance recovers with GET while admission is paused and original kingdom is no longer selected', async () => {
  ports.post = vi.fn(async () => { accepted = true; throw Error('lost acknowledgement'); }); await begin(); await controller.confirm();
  selected = id(9); baseEpoch++; currentView.acceptingContributions = false;
  controller = new MiningContributionController(new MiningContributionJournalStore(identity, factory), ports); vi.mocked(ports.get).mockClear();
  await controller.open(); await controller.confirm(); expect((await store.read()).operation?.proof?.status).toBe('accepted');
  expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledOnce();
});
it('unknown recovery never auto-POSTs or replaces its key; same-body retry requires explicit fresh review', async () => {
  ports.post = vi.fn().mockRejectedValue(Error('timeout')); await begin(); await controller.confirm();
  controller = new MiningContributionController(new MiningContributionJournalStore(identity, factory), ports);
  await controller.open(); await controller.confirm(); await controller.begin(id(1), command('2').request.lines); await controller.abandonDraft();
  expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).operation?.command).toEqual(start); expect((await store.read()).archives).toHaveLength(0);
  await controller.reviewCommand(); await controller.confirm();
  expect(vi.mocked(ports.post).mock.calls.map(row => [row[0], row[4]])).toEqual([[start.request, true], [start.request, false]]);
});
it.each(['development', 'paused', 'stock', 'cap', 'day', 'pool', 'wallet'] as const)('rechecks %s before final consent can POST', async kind => {
  await begin(); expect(controller.snapshot().review).not.toBeNull();
  if (kind === 'development') currentView.developmentReady = false;
  if (kind === 'paused') currentView.acceptingContributions = false;
  if (kind === 'stock') currentView.resources.find(row => row.resourceId === 'frost_quartz')!.available = '0';
  if (kind === 'cap') { currentView.committedValue = currentView.dailyCapValue!; currentView.remainingValue = '0'; }
  if (kind === 'day') { currentView.day = '2026-09-30'; currentView.serverNow = '2026-09-30T00:00:00.000Z'; }
  if (kind === 'pool') { currentView.pool = 'deed'; currentView.dailyCapValue = null; currentView.remainingValue = null; }
  if (kind === 'wallet') currentView.wallet = 'So11111111111111111111111111111111111111112';
  await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review).toBeNull();
  expect((await store.read()).operation?.attemptRevision).toBeNull();
});
it('free cap rejects the entire basket while deed contributions have no value cap', async () => {
  original = command('10000'); await begin(); expect((await store.read()).operation).toBeNull();
  currentView.pool = 'deed'; currentView.dailyCapValue = null; currentView.remainingValue = null;
  await begin(); expect(controller.snapshot().review?.command).toEqual(original); expect(ports.post).not.toHaveBeenCalled();
});
it.each(['intent', 'attempt'] as const)('failed durable %s write prevents POST', async stage => {
  if (stage === 'attempt') await begin(); vi.spyOn(store, 'compareAndSet').mockRejectedValue(Error('disk full'));
  if (stage === 'intent') await begin(); else await controller.confirm();
  expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().error).toContain('disk full');
});
it.each(['base-aba', 'session', 'hidden', 'dismiss'] as const)('invalidates %s at actual enqueue after auth waits', async kind => {
  await begin(); const entered = deferred(), release = deferred();
  ports.post = vi.fn(async (_request, guard) => { entered.resolve(); await release.promise; guard(); accepted = true; return proof(start, true); });
  const pending = controller.confirm(); await entered.promise;
  if (kind === 'base-aba') { baseEpoch++; selected = id(9); baseEpoch++; selected = id(1); }
  else if (kind === 'session') sessionEpoch++; else if (kind === 'hidden') active = false; else controller.dismiss();
  const snapshot = controller.snapshot(); release.resolve(); await pending;
  expect(accepted).toBe(false); expect(controller.snapshot()).toBe(snapshot); expect((await store.read()).operation?.attemptRevision).not.toBeNull();
});
it.each(['GET', 'POST'] as const)('retains owned %s acceptance after dismissal without obsolete publication', async method => {
  await begin(); const entered = deferred(), release = deferred();
  const response = async (_request: unknown, guard: () => void, retain: (raw: unknown) => Promise<void>) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; };
  if (method === 'GET') ports.getProof = vi.fn(response); else ports.post = vi.fn(response);
  const pending = method === 'GET' ? controller.open() : controller.confirm(); await entered.promise;
  controller.dismiss(); sessionEpoch++; const snapshot = controller.snapshot(); release.resolve(); await pending;
  expect((await store.read()).operation?.proof).toEqual(proof(start, true)); expect(controller.snapshot()).toBe(snapshot);
});
it('typed first refusal is archived only after explicit GET; replay refusals cannot erase previous uncertainty', async () => {
  const refused = new ApiError(422, 'not enough stock', 'INSUFFICIENT_MINING_RESOURCES');
  ports.post = vi.fn().mockRejectedValue(Error('timeout')); await begin(); await controller.confirm();
  ports.post = vi.fn().mockRejectedValue(refused); await controller.reviewCommand(); await controller.confirm(); await controller.archiveRefusal();
  expect((await store.read()).operation?.refusal).toBeNull(); expect((await store.read()).archives).toHaveLength(0);
  const other = new MiningContributionJournalStore(identity, new IDBFactory()); controller = new MiningContributionController(other, ports);
  await begin(); await controller.confirm(); expect((await other.read()).operation?.refusal?.code).toBe('INSUFFICIENT_MINING_RESOURCES');
  await controller.archiveRefusal(); expect((await other.read()).archives[0]?.evidence?.status).toBe('unknown');
});
it('settlement advances only through GET and cannot revert consumed resources or fabricate return', async () => {
  await begin(); await controller.confirm(); await controller.finish(); settled = true;
  await controller.open(); const archive = (await store.read()).archives[0]!; expect(archive.operation.proof?.settlement?.outcome).toBe('consumed');
  vi.mocked(ports.getProof).mockClear(); await controller.open(); expect(ports.getProof).not.toHaveBeenCalled();
  settled = false; await controller.checkArchived(start.request.idempotencyKey); expect((await store.read()).archives[0]).toEqual(archive);
  expect(controller.snapshot().error).toContain('settlement'); expect(ports.post).toHaveBeenCalledOnce();
});
it('parallel tabs cannot race another request while the original response is being retained', async () => {
  await begin(); const entered = deferred(), release = deferred(); ports.post = vi.fn(async (_request, guard, retain) => {
    guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); return raw;
  });
  const pending = controller.confirm(); await entered.promise;
  const other = new MiningContributionController(new MiningContributionJournalStore(identity, factory), ports); await other.open();
  expect(other.snapshot().error).toContain('Another tab'); release.resolve(); await pending; expect(ports.post).toHaveBeenCalledOnce();
});

function kitView(): ReturnType<typeof view> {
  return { ...view(), policyVersion: 3, resources: miningContributionResourceIds(3).map(resourceId => ({ resourceId, available: '10', unitValue: String(miningResourceUnitValue(resourceId, 3)) })) };
}
it('reviews kit mining only from the server-selected v3 catalogue and recovers its original after a lost response', async () => {
  currentView = kitView(); original = { request: { ...start.request, policyVersion: 3, lines: [{ resourceId: 'expedition_kit', quantity: '1' }] } };
  await begin(); expect(controller.snapshot().review?.command).toEqual(original);
  expect(vi.mocked(ports.get).mock.calls[0]?.[0]).toContain('&catalogueVersion=3');
  expect(contributionTotal(currentView, original.request.lines)).toBe(miningResourceUnitValue('expedition_kit', 3));
  ports.post = vi.fn(async () => { accepted = true; throw Error('lost response'); });
  await controller.confirm(); currentView = view(); selected = id(9); baseEpoch++;
  controller = new MiningContributionController(new MiningContributionJournalStore(identity, factory), ports);
  vi.mocked(ports.get).mockClear(); await controller.open();
  expect((await store.read()).operation?.proof?.status).toBe('accepted');
  expect((await store.read()).operation?.command).toEqual(original); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledOnce();
});
it('a day policy transition never rewrites unresolved v2 consent or automatically resubmits it', async () => {
  ports.post = vi.fn().mockRejectedValue(Error('unknown')); await begin(); await controller.confirm();
  currentView = kitView(); await controller.reviewCommand(); await controller.confirm();
  expect(controller.snapshot().review).toBeNull(); expect((await store.read()).operation?.command).toEqual(start);
  expect(ports.post).toHaveBeenCalledOnce();
});
