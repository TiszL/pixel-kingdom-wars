/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, setBaseSelectionInvalidHandler } from '../api';
import { createResearchSpeedupBrowserPorts, researchSpeedupIdentity } from './browser';
import { ResearchSpeedupController } from './controller';
import { ResearchSpeedupJournalStore } from './journal';
import { id, identity, proof, research } from './fixtures.test-support';
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
  const factory = new IDBFactory(), scoped = researchSpeedupIdentity(identity.wallet), store = new ResearchSpeedupJournalStore(scoped, factory);
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true };
  const ports = createResearchSpeedupBrowserPorts({ identity: scoped, lifecycle: () => page });
  // The test's actual HTTP boundary is the POST; quote/read fixtures are exact
  // and independently verified by browser.test.ts.
  ports.key = () => research.idempotencyKey; ports.lock = async (_name, run) => run();
  ports.prepare = async () => research; ports.validate = async (_intent, guard) => { guard(); };
  vi.spyOn(api, 'get').mockImplementation(async (_path, options) => { options?.isCurrent?.(); return proof(research) as never; });
  return { store, factory, scoped, page, ports, controller: new ResearchSpeedupController(store, ports) };
}
it.each(['session', 'base', 'navigation'] as const)('persists a first typed refusal when %s changed before its actual response body arrived, under the original wallet only', async change => {
  const f = fixture(), entered = deferred(), release = deferred();
  const response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => { entered.resolve(); await release.promise; return { error: { code: 'RESEARCH_CONSENT_STALE', message: 'episode changed' } }; });
  const fetch = vi.fn(async () => response); vi.stubGlobal('fetch', fetch);
  const handler = vi.fn(); setBaseSelectionInvalidHandler(handler);
  await f.controller.begin(research); const confirming = f.controller.confirm(); await entered.promise;
  if (change === 'session') { sessionCurrent = false; useApp.getState().setAuth('11111111111111111111111111111112', true); }
  if (change === 'base') useApp.setState({ selectedBaseId: id(9), baseSelectionEpoch: 1 });
  if (change === 'navigation') f.page.epoch++;
  release.resolve(); await confirming;
  expect((await f.store.read()).operation).toMatchObject({ intent: research, attempted: true, refusal: { status: 409, code: 'RESEARCH_CONSENT_STALE' } });
  expect((await new ResearchSpeedupJournalStore({ ...f.scoped, wallet: '11111111111111111111111111111112' }, f.factory).read()).operation).toBeNull();
  expect(handler).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  expect(f.controller.snapshot().journal?.operation?.refusal).toBeNull();
});
it.each(['generic', 'currency-mismatch', 'malformed', 'retry'] as const)('late %s error remains uncertain and never authorizes a replacement', async kind => {
  const f = fixture();
  if (kind === 'retry') {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await f.controller.begin(research); await f.controller.confirm(); await f.controller.reviewCommand();
  } else await f.controller.begin(research);
  const entered = deferred(), release = deferred(), response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => {
    entered.resolve(); await release.promise;
    if (kind === 'malformed') throw new SyntaxError('invalid JSON');
    return { error: kind === 'currency-mismatch' ? { code: 'CURRENCY_CONSENT_CHANGED', expectedCurrency: 'KEEP' } : kind === 'generic' ? { message: 'unknown' } : { code: 'RESEARCH_CONSENT_STALE' } };
  });
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const running = f.controller.confirm(); await entered.promise; f.page.epoch++; release.resolve(); await running;
  expect((await f.store.read()).operation).toMatchObject({ attempted: true, refusal: null, proof: null });
});
it('postRaw observer persists before cancellation guards and is not invoked by GET or network failure', async () => {
  const entered = deferred(), release = deferred(), abort = new AbortController(), response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => { entered.resolve(); await release.promise; return { error: { code: 'RESEARCH_PRICE_CHANGED' } }; });
  const observed = deferred(), durable = deferred(); let settled = false;
  const observe = vi.fn(async () => { observed.resolve(); await durable.promise; }); vi.stubGlobal('fetch', vi.fn(async () => response));
  const request = api.postRaw('/army/research/speedup', {}, { signal: abort.signal, observeResponseError: observe }).catch(error => error).finally(() => { settled = true; });
  await entered.promise; abort.abort(); release.resolve(); await observed.promise;
  expect(settled).toBe(false); // Original storage cannot close ahead of its evidence write.
  durable.resolve(); await request;
  expect(observe).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'RESEARCH_PRICE_CHANGED' }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"RESEARCH_PRICE_CHANGED"}}', { status: 409 })));
  await expect(api.get('/army/research/speedup/receipt')).rejects.toThrow(); expect(observe).toHaveBeenCalledOnce();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  await expect(api.postRaw('/army/research/speedup', {}, { observeResponseError: observe })).rejects.toThrow(); expect(observe).toHaveBeenCalledOnce();
});
it('the dark-roster first refusal can archive, but it cannot retire an earlier ambiguous attempt', async () => {
  for (const attempted of [false, true]) {
    const f = fixture(); await f.controller.begin(research);
    if (attempted) { vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 }))); await f.controller.confirm(); await f.controller.reviewCommand(); }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"TROOP_ROSTER_INACTIVE"}}', { status: 409 })));
    await f.controller.confirm(); await f.controller.finish();
    expect((await f.store.read()).archives).toHaveLength(attempted ? 0 : 1);
    if (attempted) expect((await f.store.read()).operation).toMatchObject({ attempted: true, refusal: null });
  }
});

it.each(['disk', 'cas'] as const)('a late refusal cannot override a failed original %s write or competing journal revision', async failure => {
  const f = fixture(), entered = deferred(), release = deferred(), response = new Response('{}', { status: 409 });
  vi.spyOn(response, 'json').mockImplementation(async () => { entered.resolve(); await release.promise; return { error: { code: 'RESEARCH_PRICE_CHANGED' } }; });
  vi.stubGlobal('fetch', vi.fn(async () => response)); await f.controller.begin(research);
  const running = f.controller.confirm(); await entered.promise;
  if (failure === 'disk') vi.spyOn(f.store, 'compareAndSet').mockRejectedValue(new Error('disk unavailable'));
  else { const saved = await f.store.read(); await f.store.compareAndSet(saved.revision, old => old); }
  release.resolve(); await running;
  expect((await f.store.read()).operation).toMatchObject({ attempted: true, refusal: null, proof: null });
  expect((await f.store.read()).archives).toHaveLength(0);
});
