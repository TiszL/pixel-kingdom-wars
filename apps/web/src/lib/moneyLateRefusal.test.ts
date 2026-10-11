/** @vitest-environment happy-dom */
/** K161: actual delayed HTTP responses must preserve original first-refusal
 * evidence before session/base/navigation rejection, across existing families. */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../auth/authCookieCoordinator';
import { useApp } from '../state/store';
import { api } from './api';
import { HeroProgressionController } from './heroProgression/controller';
import { HeroProgressionJournalStore } from './heroProgression/journal';
import { createHeroProgressionBrowserPorts, heroProgressionIdentity } from './heroProgression/browser';
import { identity, id, upgrade, proof as heroProof } from './heroProgression/fixtures.test-support';
import { WorkshopController } from './workshop/controller';
import { WorkshopJournalStore } from './workshop/journal';
import { createWorkshopBrowserPorts, workshopIdentity } from './workshop/browser';
import { start, proof as workshopProof, view } from './workshop/fixtures.test-support';
import { GemsController } from './gems/controller';
import { GemsJournalStore } from './gems/journal';
import { createGemsBrowserPorts, gemsIdentity } from './gems/browser';
import { intent as gemsIntent, envelope, overview } from './gems/fixtures.test-support';
import { HeroRecruitmentController } from './heroRecruitment/controller';
import { HeroRecruitmentJournalStore } from './heroRecruitment/journal';
import { createHeroRecruitmentBrowserPorts, heroRecruitmentIdentity } from './heroRecruitment/browser';
import { intent as recruitmentIntent, input as recruitmentInput, status, hydration, baseA } from './heroRecruitment/fixtures.test-support';

const wallet = identity.wallet, otherWallet = '11111111111111111111111111111112';
const kinds = ['Hero progression', 'Workshop', 'Gems ledger', 'Hero recruitment'] as const;
type Kind = typeof kinds[number];
type Saved = { revision: number; original: unknown; refusal: string | null; proof: unknown; terminal: boolean };
type Harness = { page: { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean };
  status: number; code: string; details?: Record<string, unknown>; mismatched: { status: number; error: Record<string, unknown> };
  review(): Promise<void>; confirm(): Promise<void>; retry(): Promise<void>; recover(): Promise<void>;
  read(): Promise<Saved>; otherBlank(): Promise<boolean>; writes(): number; error(): string | null };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
let sessionCurrent: boolean;
beforeEach(() => {
  sessionCurrent = true; vi.spyOn(authCookies, 'assertSession').mockReturnValue('original-session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => { if (!sessionCurrent) throw new Error('Original session changed'); });
  useApp.getState().setAuth(wallet, true); useApp.setState({ selectedBaseId: id(1), baseSelectionEpoch: 0, screen: 'build' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });
function fixture(kind: Kind): Harness {
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, factory = new IDBFactory();
  // Only capability/quote/receipt reads are fixtures. Every POST below runs the
  // real family adapter, api.postRaw, cookie boundary and parsed HTTP observer.
  if (kind === 'Hero progression') {
    const scoped = heroProgressionIdentity(wallet), store = new HeroProgressionJournalStore(scoped, factory);
    const ports = createHeroProgressionBrowserPorts({ identity: scoped, lifecycle: () => page });
    ports.key = () => upgrade.idempotencyKey; ports.lock = async (_name, run) => run();
    ports.prepare = async () => upgrade; ports.validate = async (_intent, guard) => { guard(); };
    vi.spyOn(api, 'get').mockImplementation(async (_path, options) => { options?.isCurrent?.(); return heroProof(upgrade) as never; });
    const controller = new HeroProgressionController(store, ports), writes = vi.spyOn(store, 'compareAndSet');
    return { page, status: 409, code: 'HERO_CONSENT_STALE', mismatched: { status: 409, error: { code: 'CURRENCY_CONSENT_CHANGED', expectedCurrency: 'KEEP' } },
      review: () => controller.begin(upgrade), confirm: () => controller.confirm(), retry: async () => { await controller.reviewCommand(); await controller.confirm(); }, recover: () => controller.open(),
      read: async () => { const s = await store.read(); return { revision: s.revision, original: s.operation?.intent, refusal: s.operation?.refusal?.code ?? null, proof: s.operation?.proof, terminal: s.archives.length > 0 }; },
      otherBlank: async () => (await new HeroProgressionJournalStore({ ...scoped, wallet: otherWallet }, factory).read()).operation === null,
      writes: () => writes.mock.calls.length, error: () => controller.snapshot().error };
  }
  if (kind === 'Workshop') {
    const scoped = workshopIdentity(wallet), store = new WorkshopJournalStore(scoped, factory);
    const ports = createWorkshopBrowserPorts({ identity: scoped, lifecycle: () => page });
    ports.key = () => start.request.idempotencyKey; ports.lock = async (_name, run) => run();
    vi.spyOn(api, 'get').mockImplementation(async (path, options) => { options?.isCurrent?.(); return (path.startsWith('/workshop?') ? view() : workshopProof(start)) as never; });
    const controller = new WorkshopController(store, ports), writes = vi.spyOn(store, 'compareAndSet');
    return { page, status: 409, code: 'RECIPE_VERSION_STALE', mismatched: { status: 404, error: { code: 'JOB_NOT_FOUND' } },
      review: () => controller.beginStart(start.request.baseId, start.request.ingots, start.request.recipeVersion), confirm: () => controller.confirm(), retry: async () => { await controller.reviewCommand(); await controller.confirm(); }, recover: () => controller.open(),
      read: async () => { const s = await store.read(); return { revision: s.revision, original: s.operation?.command, refusal: s.operation?.refusal?.code ?? null, proof: s.operation?.proof, terminal: s.archives.length > 0 }; },
      otherBlank: async () => (await new WorkshopJournalStore({ ...scoped, wallet: otherWallet }, factory).read()).operation === null,
      writes: () => writes.mock.calls.length, error: () => controller.snapshot().error };
  }
  if (kind === 'Gems ledger') {
    const scoped = gemsIdentity(wallet), store = new GemsJournalStore(scoped, factory), original = gemsIntent();
    const ports = createGemsBrowserPorts(scoped, () => page, async () => undefined);
    ports.key = () => original.idempotencyKey; ports.lock = async (_name, run) => run();
    vi.spyOn(api, 'get').mockImplementation(async (path, options) => { options?.isCurrent?.(); return (path === '/gems' ? overview() : { ...envelope(original, null), wallet }) as never; });
    const controller = new GemsController(store, ports), writes = vi.spyOn(store, 'compareAndSet');
    return { page, status: 422, code: 'INSUFFICIENT_KEEP', mismatched: { status: 404, error: { code: 'TASK_UNKNOWN' } },
      review: () => controller.review({ kind: 'gems-from-keep', keep: '10' }), confirm: () => controller.confirm(), retry: () => controller.retry(), recover: () => controller.check(),
      read: async () => { const s = await store.read(); return { revision: s.revision, original: s.intent, refusal: s.refusal?.code ?? null, proof: s.receipt, terminal: s.finished }; },
      otherBlank: async () => (await new GemsJournalStore({ ...scoped, wallet: otherWallet }, factory).read()).intent === null,
      writes: () => writes.mock.calls.length, error: () => controller.snapshot().error };
  }
  useApp.setState({ selectedBaseId: baseA });
  const scoped = heroRecruitmentIdentity(wallet), store = new HeroRecruitmentJournalStore(scoped, factory);
  const ports = createHeroRecruitmentBrowserPorts(scoped, () => page);
  const original = { ...recruitmentIntent('v1', baseA, false), expectedCurrency: 'GEMS' as const };
  ports.key = () => original.request.idempotencyKey; ports.lock = async (_name, run) => run();
  ports.consent = async () => original; ports.validate = async (_intent, guard) => { guard(); };
  ports.hydrate = async () => hydration; ports.confirmed = vi.fn();
  vi.spyOn(api, 'get').mockImplementation(async () => status() as never);
  const controller = new HeroRecruitmentController(store, ports), writes = vi.spyOn(store, 'compareAndSet');
  return { page, status: 409, code: 'CURRENCY_CONSENT_CHANGED', details: { expectedCurrency: 'GEMS' }, mismatched: { status: 409, error: { code: 'CURRENCY_CONSENT_CHANGED', expectedCurrency: 'KEEP' } },
    review: () => controller.review(recruitmentInput), confirm: () => controller.confirm(), retry: () => controller.retry(), recover: () => controller.open(),
    read: async () => { const s = await store.read(); return { revision: s.revision, original: s.intent, refusal: s.refusal ?? null, proof: s.receipt ?? s.legacyAcceptance, terminal: s.finished }; },
    otherBlank: async () => (await new HeroRecruitmentJournalStore({ ...scoped, wallet: otherWallet }, factory).read()).intent === null,
    writes: () => writes.mock.calls.length, error: () => controller.snapshot().error };
}
const firstError = (f: Harness) => ({ error: { code: f.code, message: 'Original command declined', ...f.details } });
function delayed(statusCode: number, body: unknown, malformed = false) {
  const entered = deferred(), release = deferred(), response = new Response('{}', { status: statusCode });
  vi.spyOn(response, 'json').mockImplementation(async () => { entered.resolve(); await release.promise; if (malformed) throw new SyntaxError('invalid JSON'); return body; });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response); vi.stubGlobal('fetch', fetch);
  return { entered, release, fetch };
}
for (const kind of kinds) describe(`${kind} original late refusal`, () => {
  it.each(['session', 'base', 'navigation'] as const)('retains first refusal after %s changed before HTTP body arrival, under the original wallet only', async change => {
    const f = fixture(kind); await f.review(); const http = delayed(f.status, firstError(f));
    const confirming = f.confirm(); await http.entered.promise;
    const before = await f.read(), writes = f.writes(); expect(before.original).toBeTruthy(); expect(before.refusal).toBeNull();
    if (change === 'session') { sessionCurrent = false; useApp.getState().setAuth(otherWallet, true); }
    if (change === 'base') useApp.setState({ selectedBaseId: id(99), baseSelectionEpoch: 1 });
    if (change === 'navigation') f.page.epoch++;
    http.release.resolve(); await confirming;
    const after = await f.read(); expect(after.original).toEqual(before.original); expect(after.refusal).toBe(f.code); expect(after.proof).toBeFalsy();
    expect(after.revision).toBe(before.revision + 1); expect(f.writes()).toBe(writes + 1);
    expect(await f.otherBlank()).toBe(true); expect(http.fetch).toHaveBeenCalledOnce();
    // GET-only recovery must not silently resend, even if the original UI is obsolete.
    await f.recover(); expect(http.fetch).toHaveBeenCalledOnce();
  });
  it('a current first refusal is persisted exactly once by observer plus ordinary catch', async () => {
    const f = fixture(kind); await f.review(); const http = delayed(f.status, firstError(f));
    const confirming = f.confirm(); await http.entered.promise; const before = await f.read(), writes = f.writes();
    http.release.resolve(); await confirming;
    expect((await f.read()).refusal).toBe(f.code); expect((await f.read()).revision).toBe(before.revision + 1); expect(f.writes()).toBe(writes + 1);
    await f.recover(); expect(http.fetch).toHaveBeenCalledOnce();
  });
  it.each(['generic', 'malformed', 'wrong-status', 'body-mismatch', 'retry'] as const)('already-stale %s response cannot retire the original uncertain command', async failure => {
    const f = fixture(kind); await f.review();
    let originalBody: unknown;
    if (failure === 'retry') {
      const first = vi.fn(async (_url: unknown, options?: RequestInit) => { originalBody = options?.body; return new Response('{}', { status: 500 }); });
      vi.stubGlobal('fetch', first); await f.confirm(); expect(first).toHaveBeenCalledOnce(); expect((await f.read()).refusal).toBeNull();
    }
    const body = failure === 'generic' ? { error: { message: 'Unclassified refusal' } } : failure === 'body-mismatch' ? { error: f.mismatched.error } : firstError(f);
    const code = failure === 'wrong-status' ? f.status + 1 : failure === 'body-mismatch' ? f.mismatched.status : f.status;
    const http = delayed(code, body, failure === 'malformed');
    const submitting = failure === 'retry' ? f.retry() : f.confirm(); await http.entered.promise;
    const before = await f.read(), writes = f.writes(); f.page.epoch++; http.release.resolve(); await submitting;
    const after = await f.read(); expect(after.original).toEqual(before.original); expect(after.refusal).toBeNull(); expect(after.proof).toBeFalsy(); expect(after.terminal).toBe(false);
    expect(after.revision).toBe(before.revision); expect(f.writes()).toBe(writes); expect(http.fetch).toHaveBeenCalledOnce();
    if (failure === 'retry') expect(http.fetch.mock.calls[0]?.[1]?.body).toBe(originalBody);
  });
  it('a later actual receipt GET typed error cannot become first-POST refusal evidence', async () => {
    const f = fixture(kind); await f.review();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 }))); await f.confirm();
    const before = await f.read(); expect(before.original).toBeTruthy(); expect(before.refusal).toBeNull();
    vi.mocked(api.get).mockRestore();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(firstError(f)), { status: f.status })); vi.stubGlobal('fetch', fetch);
    await f.recover(); const after = await f.read();
    expect(after.original).toEqual(before.original); expect(after.refusal).toBeNull(); expect(after.terminal).toBe(false); expect(after.revision).toBe(before.revision);
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
  });
});
