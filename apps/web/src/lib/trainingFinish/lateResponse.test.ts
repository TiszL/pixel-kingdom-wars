/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, setBaseSelectionInvalidHandler } from '../api';
import { createTrainingFinishBrowserPorts, trainingFinishIdentity } from './browser';
import { TrainingFinishController } from './controller';
import { TrainingFinishJournalStore } from './journal';
import { id, identity, proof, training } from './fixtures.test-support';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
let sessionCurrent: boolean;
beforeEach(() => {
  sessionCurrent = true;
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('original-session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => { if (!sessionCurrent) throw new Error('original session changed'); });
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ selectedBaseId: id(1), baseSelectionEpoch: 0 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setBaseSelectionInvalidHandler(() => undefined); useApp.getState().setAuth(null); });
function fixture() {
  const factory = new IDBFactory(), scoped = trainingFinishIdentity(identity.wallet), store = new TrainingFinishJournalStore(scoped, factory);
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true };
  const ports = createTrainingFinishBrowserPorts({ identity: scoped, lifecycle: () => page });
  // The test's actual HTTP boundary is the POST; quote/read fixtures are exact
  // and independently verified by browser.test.ts.
  ports.key = () => training.idempotencyKey; ports.lock = async (_name, run) => run();
  ports.prepare = async () => training; ports.validate = async (_intent, guard) => { guard(); };
  vi.spyOn(api, 'get').mockImplementation(async (_path, options) => { options?.isCurrent?.(); return proof(training) as never; });
  return { store, factory, scoped, page, ports, controller: new TrainingFinishController(store, ports) };
}
it.each(['session', 'base', 'navigation'] as const)('persists a first typed refusal when %s changed before its actual response body arrived, under the original wallet only', async change => {
  const f = fixture(), entered = deferred(), release = deferred();
  const response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => { entered.resolve(); await release.promise; return { error: { code: 'TRAINING_FINISH_QUOTE_CHANGED', message: 'queue changed' } }; });
  const fetch = vi.fn(async () => response); vi.stubGlobal('fetch', fetch);
  const handler = vi.fn(); setBaseSelectionInvalidHandler(handler);
  await f.controller.begin(training); const confirming = f.controller.confirm(); await entered.promise;
  if (change === 'session') { sessionCurrent = false; useApp.getState().setAuth('11111111111111111111111111111112', true); }
  if (change === 'base') useApp.setState({ selectedBaseId: id(9), baseSelectionEpoch: 1 });
  if (change === 'navigation') f.page.epoch++;
  release.resolve(); await confirming;
  expect((await f.store.read()).operation).toMatchObject({ intent: training, attempted: true, refusal: { status: 409, code: 'TRAINING_FINISH_QUOTE_CHANGED' } });
  expect((await new TrainingFinishJournalStore({ ...f.scoped, wallet: '11111111111111111111111111111112' }, f.factory).read()).operation).toBeNull();
  expect(handler).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  expect(f.controller.snapshot().journal?.operation?.refusal).toBeNull();
});
it.each(['generic', 'currency-mismatch', 'malformed', 'retry'] as const)('late %s error remains uncertain and never authorizes a replacement', async kind => {
  const f = fixture();
  if (kind === 'retry') {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await f.controller.begin(training); await f.controller.confirm(); await f.controller.reviewCommand();
  } else await f.controller.begin(training);
  const entered = deferred(), release = deferred(), response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => {
    entered.resolve(); await release.promise;
    if (kind === 'malformed') throw new SyntaxError('invalid JSON');
    return { error: kind === 'currency-mismatch' ? { code: 'CURRENCY_CONSENT_CHANGED', expectedCurrency: 'KEEP' } : kind === 'generic' ? { message: 'unknown' } : { code: 'TRAINING_FINISH_QUOTE_CHANGED' } };
  });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const running = f.controller.confirm(); await entered.promise; f.page.epoch++; release.resolve(); await running;
  expect((await f.store.read()).operation).toMatchObject({ attempted: true, refusal: null, proof: null });
});
it('postRaw observer persists before cancellation guards and is not invoked by GET or network failure', async () => {
  const entered = deferred(), release = deferred(), abort = new AbortController(), response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => { entered.resolve(); await release.promise; return { error: { code: 'TRAINING_FINISH_QUOTE_CHANGED' } }; });
  const observed = deferred(), durable = deferred(); let settled = false;
  const observe = vi.fn(async () => { observed.resolve(); await durable.promise; }); vi.stubGlobal('fetch', vi.fn(async () => response));
  const request = api.postRaw('/army/train/speedup', {}, { signal: abort.signal, observeResponseError: observe }).catch(error => error).finally(() => { settled = true; });
  await entered.promise; abort.abort(); release.resolve(); await observed.promise;
  expect(settled).toBe(false); // Original storage cannot close ahead of its evidence write.
  durable.resolve(); await request;
  expect(observe).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'TRAINING_FINISH_QUOTE_CHANGED' }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"TRAINING_FINISH_QUOTE_CHANGED"}}', { status: 409 })));
  await expect(api.get('/army/train/speedup/receipt')).rejects.toThrow(); expect(observe).toHaveBeenCalledOnce();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await expect(api.postRaw('/army/train/speedup', {}, { observeResponseError: observe })).rejects.toThrow(); expect(observe).toHaveBeenCalledOnce();
});
it('the dark-roster first refusal can archive, but it cannot retire an earlier ambiguous attempt', async () => {
  for (const attempted of [false, true]) {
    const f = fixture(); await f.controller.begin(training);
    if (attempted) { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 }))); await f.controller.confirm(); await f.controller.reviewCommand(); }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"TROOP_ROSTER_INACTIVE"}}', { status: 409 })));
    await f.controller.confirm(); await f.controller.finish();
    expect((await f.store.read()).archives).toHaveLength(attempted ? 0 : 1);
    if (attempted) expect((await f.store.read()).operation).toMatchObject({ attempted: true, refusal: null });
  }
});

it.each(['disk', 'cas'] as const)('a late refusal cannot override a failed original %s write or competing journal revision', async failure => {
  const f = fixture(), entered = deferred(), release = deferred(), response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => { entered.resolve(); await release.promise; return { error: { code: 'TRAINING_FINISH_QUOTE_CHANGED' } }; });
  vi.stubGlobal('fetch', vi.fn(async () => response)); await f.controller.begin(training);
  const running = f.controller.confirm(); await entered.promise;
  if (failure === 'disk') vi.spyOn(f.store, 'compareAndSet').mockRejectedValue(new Error('disk unavailable'));
  else { const saved = await f.store.read(); await f.store.compareAndSet(saved.revision, old => old); }
  release.resolve(); await running;
  expect((await f.store.read()).operation).toMatchObject({ attempted: true, refusal: null, proof: null });
  expect((await f.store.read()).archives).toHaveLength(0);
});

it.each(['first-typed', 'retry-typed', 'generic'] as const)('natural completion %s response never erases an ambiguous payment', async kind => {
  const f = fixture(); await f.controller.begin(training);
  if (kind === 'retry-typed') {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await f.controller.confirm(); await f.controller.reviewCommand();
  }
  const body = kind === 'generic' ? { error: { message: 'nothing is training' } } : { error: { code: 'TRAINING_NOT_RUNNING', message: 'nothing is training' } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 404 })));
  await f.controller.confirm(); await f.controller.finish();
  const saved = await f.store.read();
  expect(saved.archives).toHaveLength(kind === 'first-typed' ? 1 : 0);
  if (kind === 'first-typed') expect(saved.archives[0]?.operation.refusal).toEqual({ status: 404, code: 'TRAINING_NOT_RUNNING' });
  else expect(saved.operation).toMatchObject({ attempted: true, proof: null, refusal: null });
});
