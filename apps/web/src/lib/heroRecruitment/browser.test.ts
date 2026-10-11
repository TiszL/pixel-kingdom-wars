/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { playSfx } from '../audio';
import { haptic } from '../juice';
vi.mock('../audio', () => ({ playSfx: vi.fn() })); vi.mock('../juice', () => ({ haptic: vi.fn() }));
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { createHeroRecruitmentBrowserPorts, refreshHeroRecruitmentDestination } from './browser';
import { heroRecruitmentBrowserLock } from './controller';
import { base, baseA, baseB, directory, heroes, hydration, identity, input, intent, items, key, read, target } from './fixtures.test-support';
const page = () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true });
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet, screen: 'build', selectedBaseId: baseA, baseSelectionEpoch: 0, entryPaid: true });
  vi.spyOn(api, 'get').mockImplementation(read as typeof api.get);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.setState({ authed: false, wallet: null }); });
describe('Hero canonical consent and original destination', () => {
  it.each(['heroaltar', 'siegestool'] as const)('%s uses current canonical stock and price for contract-first consent', async type => {
    const ports = createHeroRecruitmentBrowserPorts(identity, page);
    expect(await ports.consent({ ...input, type }, key, 'v1', () => undefined)).toEqual(intent('v1', baseA, true, type));
    vi.mocked(api.get).mockImplementation(async path => path.startsWith('/items') ? items(0) as never : await read(path) as never);
    expect(await ports.consent({ ...input, type }, key, 'v1', () => undefined)).toEqual({ ...intent('v1', baseA, false, type), expectedCurrency: 'KEEP' });
  });
  it('legacy original null is permitted only from fresh disabled directory and stores omitted base on exact wire body', async () => {
    useApp.setState({ selectedBaseId: null }); vi.mocked(api.get).mockImplementation(async path => path === '/bases' ? { ...directory(), enabled: false } as never : await read(path) as never);
    const ports = createHeroRecruitmentBrowserPorts(identity, page); expect(await ports.consent({ ...input, baseId: null }, key, 'legacy', () => undefined)).toEqual(intent('legacy', null));
    vi.mocked(api.get).mockImplementation(read as typeof api.get); await expect(ports.validate(intent('v1', null), () => undefined, true)).rejects.toThrow('unavailable');
  });
  it.each(['directory', 'wallet', 'builders', 'keep', 'cap', 'geometry', 'contract', 'price', 'funds'])('%s changing at confirm blocks the immutable command before POST', async changed => {
    const b = base(), d = directory(), h = heroes();
    if (changed === 'builders') b.freeBuilders = 0; if (changed === 'keep') b.player.keepLevel = 1;
    if (changed === 'cap') b.buildings.push({ id: baseB, type: 'heroaltar', level: 1, tx: 1, ty: 1, underConstruction: true });
    if (changed === 'geometry') b.obstacles.push({ id: baseB, spriteKey: 'tree', tx: 10, ty: 10 });
    if (changed === 'directory') d.bases = []; if (changed === 'price') h.heroes[0]!.recruitCostKeep = '999999';
    vi.mocked(api.get).mockImplementation(async path => {
      if (path === '/me' && changed === 'wallet') return { wallet: target, entryPaid: true } as never;
      if (path === '/bases') return d as never; if (path.startsWith('/base?')) return b as never;
      if (path.startsWith('/items')) return items(changed === 'contract' || changed === 'funds' ? 0 : 1) as never;
      if (path.startsWith('/heroes')) return h as never;
      if (path.startsWith('/balances')) return { keep: '0', shards: '1', keepRate: 1 } as never;
      return await read(path) as never;
    });
    const ports = createHeroRecruitmentBrowserPorts(identity, page);
    await expect(ports.validate(intent('v1', baseA, changed !== 'funds'), () => undefined, false)).rejects.toThrow();
  });
  it('explicit retry validates original A while B is selected, and hydration cannot replace B with A', async () => {
    useApp.setState({ selectedBaseId: baseB, base: base(baseB) }); const ports = createHeroRecruitmentBrowserPorts(identity, page);
    await ports.validate(intent(), () => undefined, true); expect(await ports.hydrate(intent(), () => undefined)).toEqual(hydration);
    expect(useApp.getState().base?.baseId).toBe(baseB); expect(vi.mocked(api.get).mock.calls.some(([path]) => path === `/items?baseId=${baseA}`)).toBe(true);
  });
  it('lost original deed records truthful unavailable scopes using account and directory only', async () => {
    const reads = vi.fn(async path => path === '/me' ? { wallet: identity.wallet, entryPaid: false } : path === '/bases' ? { ...directory(), bases: [] } : Promise.reject(new Error('must not read land')));
    const result = await refreshHeroRecruitmentDestination(identity.wallet, intent(), reads as typeof api.get, () => undefined);
    expect(result.hydration).toEqual({ base: 'unavailable', items: 'unavailable', roster: 'unavailable' }); expect(reads.mock.calls.map(([path]) => path)).toEqual(['/me', '/bases']);
  });
  it.each(['base', 'balance', 'items', 'roster', 'activation', 'directory'])('malformed or racing %s hydration cannot be recorded as refreshed', async invalid => {
    let dirs = 0; const reads = async (path: string): Promise<unknown> => {
      if (path === '/bases' && invalid === 'directory' && ++dirs === 2) return { ...directory(), bases: [] };
      if (path.startsWith('/base?') && invalid === 'base') return base(baseB);
      if (path.startsWith('/balances') && invalid === 'balance') return { keep: '1e3', shards: '0', keepRate: 1 };
      if (path.startsWith('/items') && invalid === 'items') return { catalog: [] };
      if (path.startsWith('/heroes') && invalid === 'roster') return { heroes: [] };
      if (path.startsWith('/heroes') && invalid === 'activation') { const h = heroes(); h.heroes[0]!.recruited = true; return h; }
      return read(path);
    };
    await expect(refreshHeroRecruitmentDestination(identity.wallet, intent(), reads as typeof api.get, () => undefined)).rejects.toThrow();
  });
  it.each(['wallet', 'base', 'selection', 'hidden', 'page', 'screen', 'raid'])('%s changes invalidate the transport approval after auth lock waiting', changed => {
    const lifecycle = page(), ports = createHeroRecruitmentBrowserPorts(identity, () => lifecycle), guard = ports.capture(true);
    if (changed === 'wallet') useApp.setState({ wallet: target }); if (changed === 'base') useApp.setState({ selectedBaseId: baseB });
    if (changed === 'selection') useApp.setState({ baseSelectionEpoch: 1 }); if (changed === 'hidden') lifecycle.visible = false;
    if (changed === 'page') lifecycle.epoch++; if (changed === 'screen') useApp.setState({ screen: 'base' }); if (changed === 'raid') lifecycle.actionsEnabled = false;
    expect(guard).toThrow();
  });
  it('raw POST rechecks current guard and never adds a new key; exact callback preserves placement feedback', async () => {
    const ports = createHeroRecruitmentBrowserPorts(identity, page), guard = vi.fn(); vi.spyOn(api, 'postRaw').mockResolvedValue({});
    await ports.post('/heroes/recruit/v1', intent().request, guard); const options = vi.mocked(api.postRaw).mock.calls[0]![2]!;
    expect(options.isCurrent!()).toBe(true); expect(guard).toHaveBeenCalledOnce(); ports.confirmed();
    expect(playSfx).toHaveBeenCalledExactlyOnceWith('sfx_place_thump'); expect(haptic).toHaveBeenCalledExactlyOnceWith('light');
    expect(ports.unsupported(new ApiError(503, 'paused'))).toBe(false); expect(ports.unsupported(new ApiError(404, 'missing'))).toBe(true);
  });
  it('missing or contended Web Lock fails closed', async () => {
    vi.stubGlobal('navigator', {}); const action = vi.fn(async () => undefined); await expect(heroRecruitmentBrowserLock('hero', action)).rejects.toThrow('browser');
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, run: (lock: null) => Promise<void>) => run(null) } });
    await expect(heroRecruitmentBrowserLock('hero', action)).rejects.toThrow('Another tab'); expect(action).not.toHaveBeenCalled();
  });
});

describe('fresh exact Hero currency negotiation', () => {
  const funds = (gems = '1000000', keep = '1000000') => ({ gems, keep, shards: '1000', keepRate: 1,
    features: { gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 } } });
  const readPaid = (balance: unknown, contracts = 0) => vi.mocked(api.get).mockImplementation(async path =>
    path.startsWith('/items') ? items(contracts) as never : path.startsWith('/balances') ? balance as never : await read(path) as never);
  it('freezes Gems or whole KEEP from fresh balances; a later balance race cannot switch the choice', async () => {
    const ports = createHeroRecruitmentBrowserPorts(identity, page);
    readPaid(funds()); const reviewed = await ports.consent(input, key, 'v1', () => undefined);
    expect(reviewed.expectedCurrency).toBe('GEMS');
    readPaid(funds('0')); await expect(ports.validate(reviewed, () => undefined, false)).rejects.toThrow('reviewed GEMS');
    expect((await ports.consent(input, key, 'v1', () => undefined)).expectedCurrency).toBe('KEEP');
    readPaid({ keep: '1000000', shards: '1000', keepRate: 1, features: { gameCurrency: { version: 1, exactSpendCurrency: 1 } } });
    expect((await ports.consent(input, key, 'v1', () => undefined)).expectedCurrency).toBe('KEEP');
  });
  it('missing currency capability or receipt mechanism blocks new cash but not contract-only or historical recovery', async () => {
    const ports = createHeroRecruitmentBrowserPorts(identity, page); const old = { keep: '1000000', shards: '1000', keepRate: 1 };
    readPaid(old); await expect(ports.consent(input, key, 'v1', () => undefined)).rejects.toThrow('cannot enforce');
    await expect(ports.consent(input, key, 'legacy', () => undefined)).rejects.toThrow('cannot recover');
    await expect(ports.validate(intent('v1', baseA, false), () => undefined, true)).resolves.toBeUndefined();
    readPaid(old, 1); expect((await ports.consent(input, key, 'legacy', () => undefined)).request.heroContractOnly).toBe(true);
  });
  it('a contract acquired after monetary review can satisfy it without cash; capability loss still prevents dispatch', async () => {
    const ports = createHeroRecruitmentBrowserPorts(identity, page); readPaid(funds());
    const reviewed = await ports.consent(input, key, 'v1', () => undefined);
    readPaid(funds('0', '0'), 1); await expect(ports.validate(reviewed, () => undefined, false)).resolves.toBeUndefined();
    readPaid({ keep: '0', shards: '1000', keepRate: 1 }, 1); await expect(ports.validate(reviewed, () => undefined, false)).rejects.toThrow('enforcement');
  });
  it('transports exactly the saved currency through the existing guard and recognizes only its typed first refusal', async () => {
    const ports = createHeroRecruitmentBrowserPorts(identity, page); const guard = vi.fn(); vi.spyOn(api, 'postRaw').mockResolvedValue({});
    await ports.post('/heroes/recruit/v1', intent('v1', baseA, false).request, guard, 'GEMS');
    const options = vi.mocked(api.postRaw).mock.calls[0]![2]!;
    expect(options.expectedCurrency).toBe('GEMS'); options.isCurrent!(); expect(guard).toHaveBeenCalledOnce();
    expect(ports.currencyRefused!(new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'GEMS' }), 'GEMS')).toBe(true);
    expect(ports.currencyRefused!(new ApiError(409, 'changed', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'KEEP' }), 'GEMS')).toBe(false);
    expect(ports.currencyRefused!(new ApiError(0, 'lost'), 'GEMS')).toBe(false);
  });
});
