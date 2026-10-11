/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp, type BaseStateDto } from '../../state/store';
import { api, ApiError, setBaseSelectionInvalidHandler } from '../api';
import { baseAuthorityRequestScope, recoverBaseAuthority } from '../../state/baseAuthorityRecovery';
import { ResearchSpeedupController } from './controller';
import { ResearchSpeedupJournalStore } from './journal';
import { createResearchSpeedupBrowserPorts, researchSpeedupIdentity, refreshResearchSpeedupSnapshot, type ResearchQuote } from './browser';
import { id, identity, proof, research } from './fixtures.test-support';
const currencyFeature = { gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 } };
const funds = () => ({ keep: '100', gems: '100', shards: '500', keepRate: 1, features: currencyFeature });
const directory = () => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: id(1), status: 'active', slot: 1 }] });
const quote = (): ResearchQuote => ({ currentLevel: research.currentLevel, toLevel: research.toLevel, finishesAt: research.finishesAt, episodeId: research.episodeId, maxCostKeep: research.maxCostKeep });
const army = () => ({ levels: { giant: 1 }, features: { researchConsent: { version: 1 }, researchSpeedupReceipts: { version: 1 } }, research: [{ troop: research.troop, toLevel: research.toLevel, finishesAt: research.finishesAt, episodeId: research.episodeId, finishQuote: quote() as ResearchQuote | null }] });
const base = () => ({ baseId: id(1), player: { wallet: identity.wallet, keepLevel: 5 }, buildings: [], army: [{ troop: 'giant', count: 1, level: 1 }], jobs: [], obstacles: [] }) as unknown as BaseStateDto;
let rows: ReturnType<typeof army>, balances: ReturnType<typeof funds>, dirs: ReturnType<typeof directory>;
const read = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return dirs;
  if (path.startsWith('/base?')) return base();
  if (path.startsWith('/army?')) return rows;
  if (path.startsWith('/balances?')) return balances;
  throw new Error(`Unexpected test GET ${path}`);
};
const setup = () => {
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, scoped = researchSpeedupIdentity(identity.wallet);
  return { page, scoped, ports: createResearchSpeedupBrowserPorts({ identity: scoped, lifecycle: () => page }) };
};
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ selectedBaseId: id(1), baseSelectionEpoch: 0 });
  rows = army(); balances = funds(); dirs = directory(); vi.spyOn(api, 'get').mockImplementation(async path => structuredClone(await read(path)) as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setBaseSelectionInvalidHandler(() => undefined); useApp.getState().setAuth(null); });
describe('research original quote and account authority', () => {
  it('uses the server quote and complete episode with whole Gems, otherwise whole KEEP, never pooled balances', async () => {
    const { ports } = setup(), guard = ports.capture(id(1));
    // Even a wildly skewed client clock cannot reprice the authoritative quote.
    vi.spyOn(Date, 'now').mockReturnValue(0);
    expect(await ports.prepare(research, research.idempotencyKey, guard)).toEqual(research);
    balances.gems = '99'; expect((await ports.prepare(research, research.idempotencyKey, guard)).expectedCurrency).toBe('KEEP');
    balances.keep = '99'; await expect(ports.prepare(research, research.idempotencyKey, guard)).rejects.toThrow('Neither');
  });
  it.each(['currency', 'consent', 'receipt', 'quote'] as const)('missing %s contract cannot begin a paid action', async feature => {
    const { ports } = setup();
    if (feature === 'currency') balances.features = {} as never;
    else if (feature === 'quote') delete (rows.research[0] as Partial<typeof rows.research[0]>).finishQuote;
    else rows.features = { ...rows.features, [feature === 'consent' ? 'researchConsent' : 'researchSpeedupReceipts']: { version: 2 } };
    await expect(ports.prepare(research, research.idempotencyKey, ports.capture(id(1)))).rejects.toThrow();
  });
  it.each(['currentLevel', 'toLevel', 'finishesAt', 'episodeId', 'maxCostKeep'] as const)('refuses mismatched/invalid %s server quote before approval', async field => {
    const { ports } = setup();
    Object.assign(rows.research[0]!.finishQuote!, { [field]: field === 'currentLevel' ? 2 : field === 'toLevel' ? 3 : field === 'finishesAt' ? '2026-09-22T12:00:00.000Z' : field === 'episodeId' ? id(99) : '0' });
    await expect(ports.prepare(research, research.idempotencyKey, ports.capture(id(1)))).rejects.toThrow();
  });
  it('validation never changes the original debit episode, currency or ceiling', async () => {
    const { ports } = setup(), guard = ports.capture(id(1));
    balances.gems = '0'; await expect(ports.validate(research, guard)).rejects.toThrow('reviewed GEMS'); balances.gems = '100';
    rows.research[0]!.episodeId = id(9); rows.research[0]!.finishQuote!.episodeId = id(9);
    await expect(ports.validate(research, guard)).rejects.toThrow('episode changed'); rows = army();
    rows.research[0]!.finishQuote!.maxCostKeep = '101'; await expect(ports.validate(research, guard)).rejects.toThrow('exceeds');
  });
  it('declining price keeps the original ceiling; natural completion or missing quote never creates a new spend', async () => {
    const { ports } = setup(), guard = ports.capture(id(1)); rows.research[0]!.finishQuote!.maxCostKeep = '90'; balances.gems = '90';
    await expect(ports.validate(research, guard)).resolves.toBeUndefined(); expect(research.maxCostKeep).toBe('100');
    rows.research[0]!.finishQuote = null; await expect(ports.validate(research, guard)).rejects.toThrow('no current');
    rows.research = []; await expect(ports.validate(research, guard)).rejects.toThrow('no current');
  });
  it('ownership brackets and mutation capability reject changed ownership, legacy NULL and inactive bases', async () => {
    const { ports } = setup(); let seen = 0;
    vi.mocked(api.get).mockImplementation(async path => path === '/bases' && ++seen === 2 ? { ...dirs, bases: [] } as never : structuredClone(await read(path)) as never);
    await expect(ports.prepare(research, research.idempotencyKey, ports.capture(id(1)))).rejects.toThrow('ownership changed');
    vi.mocked(api.get).mockImplementation(async path => structuredClone(await read(path)) as never);
    dirs.capabilities.baseScopedMutations = false; await expect(ports.prepare(research, research.idempotencyKey, ports.capture(id(1)))).rejects.toThrow('unavailable');
    dirs.capabilities.baseScopedMutations = true; dirs.bases[0]!.status = 'inactive';
    await expect(ports.prepare(research, research.idempotencyKey, ports.capture(id(1)))).rejects.toThrow('unavailable');
    useApp.setState({ selectedBaseId: null }); await expect(ports.prepare({ ...research, baseId: null }, research.idempotencyKey, ports.capture(null))).rejects.toThrow('unavailable');
  });
  it('actual transport keeps original body/currency and fences selection ABA after an auth wait', async () => {
    const { ports, page } = setup(), guard = ports.capture(id(1)), body = { original: true };
    vi.spyOn(api, 'postRaw').mockResolvedValue({}); await ports.post('/army/research/speedup', body, 'GEMS', guard);
    const call = vi.mocked(api.postRaw).mock.calls[0]!; expect(call[1]).toBe(body); expect(call[2]?.expectedCurrency).toBe('GEMS'); expect(call[2]?.isCurrent?.()).toBe(true);
    useApp.setState({ baseSelectionEpoch: 1 }); expect(call[2]?.isCurrent).toThrow();
    const receipt = ports.capture(); page.actionsEnabled = false; expect(receipt).not.toThrow(); expect(ports.capture(id(1))).toThrow();
  });
  it('original receipt capture ignores selected-base loss but not session/navigation/visibility changes', () => {
    const { ports, page } = setup(), receipt = ports.capture(), mutation = ports.capture(id(1));
    useApp.getState().setSelectedBaseId(id(2), false); expect(mutation).toThrow(); expect(receipt).not.toThrow();
    page.visible = false; expect(receipt).toThrow(); page.visible = true; page.epoch++; expect(receipt).toThrow();
  });
  it('allows only actual typed first-dispatch no-debit refusals, never invalid receipts, retries, generic or mismatched currency errors', () => {
    const { ports } = setup();
    for (const [status, code] of [[409, 'RESEARCH_CONSENT_STALE'], [409, 'RESEARCH_PRICE_CHANGED'], [404, 'BASE_NOT_OWNED'], [409, 'BASE_ID_REQUIRED'], [409, 'DEED_OWNERSHIP_CHANGED'], [423, 'BASE_BEING_RAIDED'], [503, 'DEED_AUTHORITY_UNAVAILABLE']] as const) {
      expect(ports.definitiveRefusal(new ApiError(status, 'refused', code), research)?.code).toBe(code);
      expect(ports.definitiveRefusal(new ApiError(status + 1, 'refused', code), research)).toBeNull();
    }
    expect(ports.definitiveRefusal(new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'GEMS' }), research)?.code).toBe('CURRENCY_CONSENT_CHANGED');
    for (const error of [new ApiError(409, 'unknown'), new ApiError(409, 'collision', 'RESEARCH_RECEIPT_INVALID'), new ApiError(400, 'invalid'), new ApiError(409, 'internal', 'BASE_NOT_OWNED'), new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'KEEP' }), new Error('timeout')]) expect(ports.definitiveRefusal(error, research)).toBeNull();
  });
  it.each([[404, 'BASE_NOT_OWNED'], [409, 'DEED_OWNERSHIP_CHANGED']] as const)('persists original first %s/%s refusal before global authority navigation rejects presentation', async (status, code) => {
    const { ports, scoped } = setup(), store = new ResearchSpeedupJournalStore(scoped, new IDBFactory());
    ports.key = () => research.idempotencyKey; ports.lock = async (_name, run) => run();
    vi.mocked(api.get).mockImplementation(async path => path.includes('/receipt?') ? proof(research) as never : structuredClone(await read(path)) as never);
    setBaseSelectionInvalidHandler(recoverBaseAuthority, baseAuthorityRequestScope);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code, message: 'original base no longer owned' } }), { status, headers: { 'content-type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    const controller = new ResearchSpeedupController(store, ports); await controller.begin(research);
    expect(controller.snapshot().error).toBeNull(); await controller.confirm();
    expect(fetch).toHaveBeenCalledOnce(); expect(useApp.getState().screen).toBe('bases');
    expect((await store.read()).operation).toMatchObject({ intent: research, attempted: true, refusal: { status, code } });
    const recovered = new ResearchSpeedupController(store, ports); await recovered.open(); await recovered.finish();
    expect((await store.read()).archives[0]?.reason).toBe('refused'); expect(fetch).toHaveBeenCalledOnce();
  });
  it('current army/base/balances use fresh guarded reads, never receipt result hydration', async () => {
    const { ports, scoped } = setup(); useApp.getState().setBalances({ ...balances, gems: '999' });
    const seen: string[] = [], stop = useApp.subscribe(s => seen.push(`${s.base?.baseId}/${s.balances?.gems}`));
    const snapshot = await refreshResearchSpeedupSnapshot(scoped, ports); stop();
    expect(seen).toEqual([`${id(1)}/100`]); expect(snapshot?.research.levels.giant).toBe(1);
    expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(['/me', '/bases', `/base?baseId=${id(1)}`, `/army?baseId=${id(1)}`, `/balances?baseId=${id(1)}`, '/me', '/bases']);
  });
  it.each(['wallet', 'base', 'ownership', 'selection', 'newer-read', 'research'] as const)('changed %s cannot overwrite current account state during hydration', async change => {
    const { ports, scoped } = setup(); useApp.getState().setBalances({ ...balances, gems: '999' }); let directories = 0;
    vi.mocked(api.get).mockImplementation(async path => {
      if (change === 'wallet' && path === '/me') return { wallet: 'another-wallet' } as never;
      if (change === 'base' && path.startsWith('/base?')) return { ...base(), baseId: id(2) } as never;
      if (change === 'ownership' && path === '/bases' && ++directories === 2) return { ...dirs, bases: [] } as never;
      if (change === 'research' && path.startsWith('/army?')) return { ...rows, research: [], levels: { giant: 2 } } as never;
      if (path.startsWith('/balances?')) {
        if (change === 'selection') useApp.setState({ baseSelectionEpoch: 1 });
        if (change === 'newer-read') captureBaseBalanceCommit(id(1))({ ...balances, gems: '777' });
      }
      return structuredClone(await read(path)) as never;
    });
    await expect(refreshResearchSpeedupSnapshot(scoped, ports)).rejects.toThrow();
    expect(useApp.getState().balances?.gems).toBe(change === 'newer-read' ? '777' : '999');
  });
  it('an unavailable current base returns no snapshot without substituting another owned base', async () => {
    const { ports, scoped } = setup(); dirs.bases = []; expect(await refreshResearchSpeedupSnapshot(scoped, ports)).toBeNull(); expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(['/me', '/bases']);
  });
});
