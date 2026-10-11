/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp, type BaseStateDto } from '../../state/store';
import { api, ApiError, setBaseSelectionInvalidHandler } from '../api';
import { baseAuthorityRequestScope, recoverBaseAuthority } from '../../state/baseAuthorityRecovery';
import { IDBFactory } from 'fake-indexeddb';
import { HeroProgressionController } from './controller';
import { HeroProgressionJournalStore } from './journal';
import { createHeroProgressionBrowserPorts, heroProgressionIdentity, refreshHeroProgressionSnapshot } from './browser';
import { id, identity, proof, recovery, upgrade } from './fixtures.test-support';
const currencyFeature = { gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 } };
const funds = () => ({ keep: '100', gems: '100', shards: '500', keepRate: 1, features: currencyFeature });
const directory = () => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: id(1), status: 'active', slot: 1 }] });
const roster = () => ({ keepLevel: 5, keepBalance: '100', features: { heroConsent: { version: 1 }, heroReceipts: { version: 1 } }, heroes: [{ hero: upgrade.hero,
  recruited: true, level: 1, available: false, recoveryUntil: recovery.kind === 'recovery' ? recovery.recoveryUntil : null,
  next: { level: 2, costKeep: '100' }, recoveryFinishNow: { costKeep: '100', remainingSec: 100, affordable: false } }] });
const base = () => ({ baseId: id(1), player: { wallet: identity.wallet, keepLevel: 5 }, buildings: [], army: [], jobs: [], obstacles: [],
  heroes: roster().heroes.map(h => ({ hero: h.hero, level: h.level, available: h.available, recoveryUntil: h.recoveryUntil })) }) as unknown as BaseStateDto;
let rows: ReturnType<typeof roster>, balances: ReturnType<typeof funds>, dirs: ReturnType<typeof directory>;
const read = async (path: string): Promise<unknown> => {
  if (path === '/me') return { wallet: identity.wallet };
  if (path === '/bases') return dirs;
  if (path.startsWith('/base?')) return base();
  if (path.startsWith('/heroes?')) return rows;
  if (path.startsWith('/balances?')) return balances;
  throw new Error(`Unexpected test GET ${path}`);
};
const setup = () => {
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, scoped = heroProgressionIdentity(identity.wallet);
  return { page, scoped, ports: createHeroProgressionBrowserPorts({ identity: scoped, lifecycle: () => page }) };
};
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ selectedBaseId: id(1), baseSelectionEpoch: 0 });
  rows = roster(); balances = funds(); dirs = directory(); vi.spyOn(api, 'get').mockImplementation(async path => await read(path) as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setBaseSelectionInvalidHandler(() => undefined); useApp.getState().setAuth(null); });
describe('Hero progression current authority and command-local currency', () => {
  it('reviews fresh server price and episode with whole Gems, otherwise whole KEEP, never combined balances', async () => {
    const { ports } = setup(), guard = ports.capture(id(1));
    expect(await ports.prepare(upgrade, upgrade.idempotencyKey, guard)).toEqual(upgrade);
    expect(await ports.prepare(recovery, recovery.idempotencyKey, guard)).toEqual(recovery);
    balances.gems = '99'; expect((await ports.prepare(upgrade, upgrade.idempotencyKey, guard)).expectedCurrency).toBe('KEEP');
    balances.keep = '99'; await expect(ports.prepare(upgrade, upgrade.idempotencyKey, guard)).rejects.toThrow('Neither');
  });
  it.each(['currency', 'consent', 'receipt'] as const)('missing %s capability cannot start a paid Hero action', async feature => {
    const { ports } = setup();
    if (feature === 'currency') balances.features = {} as never;
    else rows.features = { ...rows.features, [feature === 'consent' ? 'heroConsent' : 'heroReceipts']: { version: 2 } };
    await expect(ports.prepare(upgrade, upgrade.idempotencyKey, ports.capture(id(1)))).rejects.toThrow();
  });
  it('validation preserves original currency and ceiling despite newly affordable fallback, newer level or injury', async () => {
    const { ports } = setup(), guard = ports.capture(id(1));
    balances.gems = '0'; await expect(ports.validate(upgrade, guard)).rejects.toThrow('reviewed GEMS'); balances.gems = '100';
    rows.heroes[0]!.level = 2; rows.heroes[0]!.next = { level: 3, costKeep: '100' }; await expect(ports.validate(upgrade, guard)).rejects.toThrow('level or recovery');
    rows = roster(); rows.heroes[0]!.recoveryUntil = '2026-09-22T12:00:00.000Z'; await expect(ports.validate(recovery, guard)).rejects.toThrow('episode');
    rows = roster(); rows.heroes[0]!.next.costKeep = '101'; await expect(ports.validate(upgrade, guard)).rejects.toThrow('exceeds');
  });
  it('a declining recovery price retains the original maximum, while natural readiness prevents a new spend', async () => {
    const { ports } = setup(), guard = ports.capture(id(1)); rows.heroes[0]!.recoveryFinishNow.costKeep = '90'; balances.gems = '90';
    await expect(ports.validate(recovery, guard)).resolves.toBeUndefined(); expect(recovery.maxCostKeep).toBe('100');
    rows.heroes[0]!.available = true; await expect(ports.validate(recovery, guard)).rejects.toThrow('no longer');
  });
  it('ownership read brackets prevent new consent after transfer and current mutation capability is required', async () => {
    const { ports } = setup(); let seen = 0;
    vi.mocked(api.get).mockImplementation(async path => path === '/bases' && ++seen === 2 ? { ...dirs, bases: [] } as never : await read(path) as never);
    await expect(ports.prepare(upgrade, upgrade.idempotencyKey, ports.capture(id(1)))).rejects.toThrow('ownership changed');
    vi.mocked(api.get).mockImplementation(async path => await read(path) as never); dirs.capabilities.baseScopedMutations = false;
    await expect(ports.prepare(upgrade, upgrade.idempotencyKey, ports.capture(id(1)))).rejects.toThrow('unavailable');
  });
  it('actual transport keeps exact currency/body and checks selection epoch again after an auth wait', async () => {
    const { ports, page } = setup(), guard = ports.capture(id(1)), body = { original: true };
    vi.spyOn(api, 'postRaw').mockResolvedValue({}); await ports.post('/heroes/vex/upgrade', body, 'GEMS', guard);
    const call = vi.mocked(api.postRaw).mock.calls[0]!; expect(call[1]).toBe(body); expect(call[2]?.expectedCurrency).toBe('GEMS'); expect(call[2]?.isCurrent?.()).toBe(true);
    useApp.setState({ baseSelectionEpoch: 1 }); expect(call[2]?.isCurrent).toThrow();
    const receipt = ports.capture(); page.actionsEnabled = false; expect(receipt).not.toThrow(); expect(ports.capture(id(1))).toThrow();
  });
  it('origin/API/wallet/visibility/session changes fail closed while old receipt reads have no selected-base dependency', () => {
    const { ports, page, scoped } = setup(), receipt = ports.capture(), mutation = ports.capture(id(1));
    useApp.getState().setSelectedBaseId(id(2), false); expect(mutation).toThrow(); expect(receipt).not.toThrow();
    page.visible = false; expect(receipt).toThrow(); page.visible = true;
    vi.spyOn(authCookies, 'current').mockReturnValue(false); expect(receipt).toThrow();
    const foreign = createHeroProgressionBrowserPorts({ identity: { ...scoped, api: 'https://other.test/api' }, lifecycle: () => page }); expect(() => foreign.capture()).toThrow('another origin');
  });
  it('accepts only typed matching transaction refusals, never generic or mismatched currency errors', () => {
    const { ports } = setup();
    for (const code of ['HERO_CONSENT_STALE', 'HERO_PRICE_CHANGED']) expect(ports.definitiveRefusal(new ApiError(409, 'changed', code), upgrade)?.code).toBe(code);
    expect(ports.definitiveRefusal(new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'GEMS' }), upgrade)?.code).toBe('CURRENCY_CONSENT_CHANGED');
    for (const error of [new ApiError(409, 'not recovering'), new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'KEEP' }), new ApiError(422, 'changed', 'HERO_CONSENT_STALE'), new Error('timeout')]) expect(ports.definitiveRefusal(error, upgrade)).toBeNull();
  });
  it('recognizes only the original kinds typed natural-expiry/altar refusal and verified precommand authority failures', () => {
    const { ports } = setup();
    expect(ports.definitiveRefusal(new ApiError(409, 'expired', 'HERO_NOT_RECOVERING'), recovery)?.code).toBe('HERO_NOT_RECOVERING');
    expect(ports.definitiveRefusal(new ApiError(409, 'expired', 'HERO_NOT_RECOVERING'), upgrade)).toBeNull();
    expect(ports.definitiveRefusal(new ApiError(422, 'altar removed', 'HERO_NOT_RECRUITED'), upgrade)?.code).toBe('HERO_NOT_RECRUITED');
    expect(ports.definitiveRefusal(new ApiError(422, 'altar removed', 'HERO_NOT_RECRUITED'), recovery)).toBeNull();
    for (const [status, code] of [[404, 'BASE_NOT_OWNED'], [409, 'BASE_ID_REQUIRED'], [409, 'DEED_OWNERSHIP_CHANGED'], [423, 'BASE_BEING_RAIDED'], [503, 'DEED_AUTHORITY_UNAVAILABLE']] as const) {
      expect(ports.definitiveRefusal(new ApiError(status, 'refused', code), upgrade)?.code).toBe(code);
      expect(ports.definitiveRefusal(new ApiError(status + 1, 'refused', code), upgrade)).toBeNull();
    }
    expect(ports.definitiveRefusal(new ApiError(409, 'internal mismatch', 'BASE_NOT_OWNED'), upgrade)).toBeNull();
  });
  it.each([[404, 'BASE_NOT_OWNED'], [409, 'DEED_OWNERSHIP_CHANGED']] as const)('preserves the first typed %s/%s refusal through actual transport authority navigation', async (status, code) => {
    const { ports, scoped } = setup(), store = new HeroProgressionJournalStore(scoped, new IDBFactory());
    ports.key = () => upgrade.idempotencyKey; ports.lock = async (_name, run) => run();
    vi.mocked(api.get).mockImplementation(async path => path.includes('/receipt?') ? proof(upgrade) as never : await read(path) as never);
    setBaseSelectionInvalidHandler(recoverBaseAuthority, baseAuthorityRequestScope);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code, message: 'original base no longer owned' } }), { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const controller = new HeroProgressionController(store, ports); await controller.begin(upgrade);
    expect(controller.snapshot().error).toBeNull(); await controller.confirm();
    expect(fetch).toHaveBeenCalledOnce(); expect(useApp.getState().screen).toBe('bases');
    expect((await store.read()).operation).toMatchObject({ intent: upgrade, attempted: true, refusal: { status, code } });
    // Stale presentation cannot consume the reply, but the original journal
    // survives navigation and a later GET-only reader can archive its decline.
    const recovered = new HeroProgressionController(store, ports); await recovered.open(); await recovered.finish();
    expect((await store.read()).archives[0]?.reason).toBe('refused'); expect(fetch).toHaveBeenCalledOnce();
  });
  it('current base and balances publish together from fresh reads, never from original receipt amounts', async () => {
    const { ports, scoped } = setup(); useApp.getState().setBalances({ ...balances, gems: '999' });
    const seen: string[] = [], stop = useApp.subscribe(s => seen.push(`${s.base?.baseId}/${s.balances?.gems}`));
    const snapshot = await refreshHeroProgressionSnapshot(scoped, ports); stop();
    expect(seen).toEqual([`${id(1)}/100`]); expect(snapshot?.heroes.heroes[0]?.level).toBe(1);
    expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(['/me', '/bases', `/base?baseId=${id(1)}`, `/heroes?baseId=${id(1)}`, `/balances?baseId=${id(1)}`, '/me', '/bases']);
  });
  it.each(['wallet', 'base', 'ownership', 'selection', 'newer-read', 'roster'] as const)('a changed %s cannot publish a stale acceptance refresh', async change => {
    const { ports, scoped } = setup(); useApp.getState().setBalances({ ...balances, gems: '999' }); let directories = 0;
    vi.mocked(api.get).mockImplementation(async path => {
      if (change === 'wallet' && path === '/me') return { wallet: 'another-wallet' } as never;
      if (change === 'base' && path.startsWith('/base?')) return { ...base(), baseId: id(2) } as never;
      if (change === 'ownership' && path === '/bases' && ++directories === 2) return { ...dirs, bases: [] } as never;
      if (path.startsWith('/balances?')) {
        if (change === 'selection') useApp.setState({ baseSelectionEpoch: 1 });
        if (change === 'newer-read') captureBaseBalanceCommit(id(1))({ ...balances, gems: '777' });
        if (change === 'roster') rows.heroes[0]!.level = 2;
      }
      return await read(path) as never;
    });
    await expect(refreshHeroProgressionSnapshot(scoped, ports)).rejects.toThrow();
    expect(useApp.getState().balances?.gems).toBe(change === 'newer-read' ? '777' : '999');
  });
  it('a no-longer-owned destination is unavailable without substituting the selected base into history', async () => {
    const { ports, scoped } = setup(); dirs.bases = []; expect(await refreshHeroProgressionSnapshot(scoped, ports)).toBeNull(); expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(['/me', '/bases']);
  });
});
