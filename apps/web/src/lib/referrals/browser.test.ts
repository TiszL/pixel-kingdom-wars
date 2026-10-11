/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { createReferralBrowserPorts, firstReferralRefusal, referralIdentity, withLegacyReferralFence as fence } from './browser';
import { referralBrowserLock } from './controller';
import { ReferralJournalStore } from './journal';
import { deferred, identity, relationship } from './fixtures.test-support';

const withLegacyReferralFence = <T>(wallet: Parameters<typeof fence>[0], guard: Parameters<typeof fence>[2], operation: () => Promise<T>, factory: Parameters<typeof fence>[4], lock: Parameters<typeof fence>[5]) => fence(wallet, { route: '/referrals/use', code: 'KEEP-ABCDE', retry: false }, guard, operation, factory, lock);

beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.setState({ authed: false, wallet: null }); });
describe('browser referral account and legacy fences', () => {
  it('recognizes only the exact source atomic first-refusal status/code pairs', () => {
    expect(firstReferralRefusal(new ApiError(404, 'unknown', 'REFERRAL_CODE_UNKNOWN'))).toBe(true);
    for (const code of ['REFERRAL_SELF', 'REFERRAL_WINDOW_CLOSED']) expect(firstReferralRefusal(new ApiError(422, 'refused', code))).toBe(true);
    for (const error of [new ApiError(404, 'route missing'), new ApiError(422, 'other'), new ApiError(400, 'unknown', 'REFERRAL_CODE_UNKNOWN'),
      new ApiError(503, 'unknown', 'REFERRAL_CODE_UNKNOWN'), new Error('REFERRAL_SELF')]) expect(firstReferralRefusal(error)).toBe(false);
  });
  it('does not gate attribution on selected base, while visibility/epoch and session replacement fence approval', () => {
    const page = { active: true, visible: true, epoch: 0 }; const ports = createReferralBrowserPorts(identity, () => page);
    const approval = ports.capture(true); const recovery = ports.capture(false);
    useApp.setState({ selectedBaseId: 'another-base', baseSelectionEpoch: 5 }); expect(approval).not.toThrow();
    page.visible = false; expect(approval).toThrow('page changed'); expect(recovery).not.toThrow();
    page.visible = true; page.epoch += 1; expect(approval).toThrow('page changed');
    const afterReturn = ports.capture(true); vi.spyOn(authCookies, 'current').mockReturnValue(false); expect(afterReturn).toThrow('account');
  });
  it('inactive page and wallet change fence both responses and new requests', () => {
    const page = { active: true, visible: true, epoch: 0 }; const ports = createReferralBrowserPorts(identity, () => page);
    const guard = ports.capture(false); useApp.setState({ wallet: '2'.repeat(32) }); expect(guard).toThrow();
    useApp.setState({ wallet: identity.wallet }); page.active = false; expect(guard).toThrow();
  });
  it('uses exact postRaw body and distinguishes GET404 from POST coded refusal', async () => {
    const ports = createReferralBrowserPorts(identity, () => ({ active: true, visible: true, epoch: 0 }));
    vi.spyOn(api, 'postRaw').mockResolvedValue({}); await ports.post('/referrals/v1/use', { code: 'KEEP-ABCDE' });
    expect(api.postRaw).toHaveBeenCalledExactlyOnceWith('/referrals/v1/use', { code: 'KEEP-ABCDE' });
    expect(ports.unsupported(new ApiError(404, 'not found'))).toBe(true); expect(ports.firstRefusal(new ApiError(404, 'not found'))).toBe(false);
  });
  it('legacy admission cannot run with unknown session identity, missing storage, or an existing v1 intent', async () => {
    const factory = new IDBFactory(); const make = (i: typeof identity) => new ReferralJournalStore(i, factory);
    const lock = async <T>(_name: string, action: () => Promise<T>) => action(); const action = vi.fn(async () => 'admitted');
    await expect(withLegacyReferralFence(null, () => undefined, action, make, lock)).rejects.toThrow('signed-in account');
    const s = make(referralIdentity(identity.wallet)); await s.compareAndSet(0, (old) => ({ ...old, activated: true, code: 'KEEP-ABCDE' }));
    await expect(withLegacyReferralFence(identity.wallet, () => undefined, action, make, lock)).rejects.toThrow('saved referral');
    await expect(withLegacyReferralFence(identity.wallet, () => undefined, action,
      (i) => new ReferralJournalStore(i, undefined), lock)).rejects.toThrow('working browser site storage');
    expect(action).not.toHaveBeenCalled();
  });
  it('legacy submission stays blocked after Finish and after a first definitive v1 refusal', async () => {
    for (const positive of [false, true]) {
      const factory = new IDBFactory(); const make = (i: typeof identity) => new ReferralJournalStore(i, factory);
      const s = make(referralIdentity(identity.wallet)); await s.compareAndSet(0, (old) => ({ ...old, activated: true, code: null,
        relationship: positive ? relationship : null, outcome: positive ? 'observed' : null }));
      const action = vi.fn(async () => undefined);
      await expect(withLegacyReferralFence(identity.wallet, () => undefined, action, make, async (_n, run) => run())).rejects.toThrow('saved referral');
      expect(action).not.toHaveBeenCalled();
    }
  });
  it('legacy no-conflict proof holds the same exclusive identity lock through completion', async () => {
    const factory = new IDBFactory(); const pending = deferred<{ referrer: string }>(); const seen: string[] = []; let held = false;
    const lock = async <T>(name: string, action: () => Promise<T>) => { if (held) throw new Error('busy'); held = true; seen.push(name); try { return await action(); } finally { held = false; } };
    const action = vi.fn(() => pending.promise); const make = (i: typeof identity) => new ReferralJournalStore(i, factory);
    const request = withLegacyReferralFence(identity.wallet, () => undefined, action, make, lock);
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce()); expect(held).toBe(true);
    expect(seen[0]).toBe(`pkw-referrals-v1:${JSON.stringify(referralIdentity(identity.wallet))}`);
    const other = vi.fn(async () => 'other'); await expect(withLegacyReferralFence(identity.wallet, () => undefined, other, make, lock)).rejects.toThrow('busy');
    pending.resolve({ referrer: relationship.referrerWallet }); await expect(request).resolves.toEqual({ referrer: relationship.referrerWallet }); expect(held).toBe(false); expect(other).not.toHaveBeenCalled();
  });
  it('checks current identity/page after asynchronous storage proof before legacy submit', async () => {
    const factory = new IDBFactory(); const guard = vi.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error('left page'); });
    const action = vi.fn(async () => undefined);
    await expect(withLegacyReferralFence(identity.wallet, guard, action, (i) => new ReferralJournalStore(i, factory), async (_n, run) => run())).rejects.toThrow('left page');
    expect(action).not.toHaveBeenCalled();
  });
  it('real browser action locks refuse queued stale clicks and missing support', async () => {
    const action = vi.fn(async () => 'sent');
    await expect(referralBrowserLock('test', action)).rejects.toThrow('coordinate');
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, run) => run(null)) } });
    await expect(referralBrowserLock('test', action)).rejects.toThrow('Another game tab'); expect(action).not.toHaveBeenCalled();
    expect(navigator.locks.request).toHaveBeenCalledWith('test', { mode: 'exclusive', ifAvailable: true }, expect.any(Function));
  });
});

describe('original legacy intent survives a server upgrade', () => {
  it('persists route/code before POST, then v1 null cannot allow a different code or automatic v1 retry', async () => {
    const { ReferralController } = await import('./controller');
    const factory = new IDBFactory(); const who = referralIdentity(identity.wallet); const make = (i: typeof identity) => new ReferralJournalStore(i, factory);
    const post = vi.fn(async () => { const saved = await make(who).read(); expect(saved.code).toBe('KEEP-ABCDE'); expect(saved.legacy?.route).toBe('/referrals/use'); throw new Error('response lost'); });
    await expect(fence(identity.wallet, { route: '/referrals/use', code: ' keep-abcde ', retry: false }, () => undefined, post, make, async (_n, run) => run())).rejects.toThrow('lost');
    const ports = createReferralBrowserPorts(who, () => ({ active: true, visible: true, epoch: 0 }));
    ports.lock = async (_n, run) => run(); ports.get = vi.fn(async () => ({ version: 1, wallet: identity.wallet, relationship: null })); ports.post = vi.fn();
    const c = new ReferralController(make(who), ports); await c.open(); await c.review('KEEP-CQRPF'); await c.confirm(); await c.retry();
    expect(ports.post).not.toHaveBeenCalled(); expect((await make(who).read()).code).toBe('KEEP-ABCDE');
    await expect(fence(identity.wallet, { route: '/referrals/use', code: 'KEEP-CQRPF', retry: true }, () => undefined, post, make, async (_n, run) => run())).rejects.toThrow('original');
    const retry = vi.fn(async (request) => { expect(request).toEqual({ route: '/referrals/use', code: 'KEEP-ABCDE' }); return { referrer: relationship.referrerWallet }; });
    await fence(identity.wallet, { route: '/referrals/use', code: 'KEEP-ABCDE', retry: true }, () => undefined, retry, make, async (_n, run) => run());
    expect((await make(who).read()).legacy?.result).toEqual({ referrer: relationship.referrerWallet });
  });
  it('positive v1 attribution cannot finish an unresolved alpha admission or switch its original route', async () => {
    const { ReferralController } = await import('./controller'); const factory = new IDBFactory(); const who = referralIdentity(identity.wallet);
    const make = (i: typeof identity) => new ReferralJournalStore(i, factory); const post = vi.fn(async () => { throw new Error('lost admission'); });
    await expect(fence(identity.wallet, { route: '/alpha/referral', code: 'KEEP-ABCDE', retry: false }, () => undefined, post, make, async (_n, run) => run())).rejects.toThrow('lost');
    const ports = createReferralBrowserPorts(who, () => ({ active: true, visible: true, epoch: 0 })); ports.lock = async (_n, run) => run();
    ports.get = vi.fn(async () => ({ version: 1, wallet: identity.wallet, relationship })); ports.post = vi.fn();
    const c = new ReferralController(make(who), ports); await c.open(); await c.finish(); await c.retry();
    expect((await make(who).read()).code).toBe('KEEP-ABCDE'); expect((await make(who).read()).legacy?.result).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
    await expect(fence(identity.wallet, { route: '/referrals/use', code: 'KEEP-ABCDE', retry: true }, () => undefined, post, make, async (_n, run) => run())).rejects.toThrow('original');
  });
  it('legacy result with wrong wallet or route shape cannot become proof; late competing revision also fails closed', async () => {
    const factory = new IDBFactory(); const who = referralIdentity(identity.wallet); const make = (i: typeof identity) => new ReferralJournalStore(i, factory);
    await expect(fence(identity.wallet, { route: '/alpha/referral', code: 'KEEP-ABCDE', retry: false }, () => undefined,
      async () => ({ ok: true, wallet: '3'.repeat(32) }), make, async (_n, run) => run())).rejects.toThrow('does not match');
    expect((await make(who).read()).legacy?.result).toBeNull();
    await expect(fence(identity.wallet, { route: '/alpha/referral', code: 'KEEP-ABCDE', retry: true }, () => undefined,
      async () => { const s = make(who); const saved = await s.read(); await s.compareAndSet(saved.revision, (r) => ({ ...r })); return { ok: true, wallet: identity.wallet }; }, make,
      async (_n, run) => run())).rejects.toThrow('another tab');
    expect((await make(who).read()).legacy?.result).toBeNull();
  });
});
