/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, ApiError } from '../api';
import { mutationGate } from '../mutationGate';
import { ordinaryOriginal } from '../unpaidResources/transport';
import { createOrdinaryCraftingBrowserPorts, ordinaryCraftingIdentity } from './browser';
import { deferred, id, identity, proof, start } from './fixtures.test-support';
vi.mock('../unpaidResources/transport', () => ({ ordinaryOriginal: vi.fn() }));
vi.mock('../mutationGate', () => ({ mutationGate: { getSnapshot: vi.fn(() => true) } }));
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  vi.spyOn(authCookies, 'current').mockReturnValue(true); vi.mocked(mutationGate.getSnapshot).mockReturnValue(true);
  vi.mocked(ordinaryOriginal).mockReset().mockResolvedValue(proof(start, true));
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); useApp.getState().setAuth(null); });
const setup = () => {
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, scoped = ordinaryCraftingIdentity(identity.wallet);
  return { page, scoped, ports: createOrdinaryCraftingBrowserPorts({ identity: scoped, lifecycle: () => page }) };
};
const noop = async () => undefined;
describe('ordinary refining browser identity and original response adapter', () => {
  it.each(['origin', 'api', 'cluster', 'wallet'] as const)('refuses a foreign %s journal before network admission', field => {
    const { scoped, page } = setup();
    const foreign = { ...scoped, [field]: field === 'origin' ? 'https://other.test' : field === 'api' ? 'https://other.test/api'
      : field === 'cluster' ? scoped.cluster === 'devnet' ? 'mainnet-beta' : 'devnet' : 'So11111111111111111111111111111111111111112' };
    const ports = createOrdinaryCraftingBrowserPorts({ identity: foreign as typeof scoped, lifecycle: () => page });
    expect(() => ports.capture()()).toThrow(); expect(ordinaryOriginal).not.toHaveBeenCalled();
  });
  it('mutation guard binds selected-base generation while original recovery survives selected-base ABA and paused actions', () => {
    const { ports, page } = setup(), mutation = ports.capture(id(1)), recovery = ports.capture();
    useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false);
    expect(mutation).toThrow(); expect(recovery).not.toThrow();
    page.actionsEnabled = false; vi.mocked(mutationGate.getSnapshot).mockReturnValue(false);
    expect(ports.capture(id(1))).toThrow(); expect(recovery).not.toThrow();
    page.epoch++; expect(recovery).toThrow();
  });
  it.each(['wallet', 'logout', 'hidden', 'inactive', 'epoch', 'cookie'] as const)('%s retirement invalidates even historical response publication', change => {
    const { ports, page } = setup(), guard = ports.capture();
    if (change === 'wallet') useApp.setState({ wallet: 'So11111111111111111111111111111111111111112' });
    else if (change === 'logout') useApp.setState({ authed: false });
    else if (change === 'hidden') page.visible = false;
    else if (change === 'inactive') page.active = false;
    else if (change === 'epoch') page.epoch++;
    else vi.mocked(authCookies.current).mockReturnValue(false);
    expect(guard).toThrow();
  });
  it('passes exact original request and explicit attempt classification through dedicated GET/POST, without using generic current GET', async () => {
    const { ports } = setup(), retain = vi.fn(noop), refusal = vi.fn(noop), guard = ports.capture(id(1));
    const get = vi.spyOn(api, 'get').mockResolvedValue({});
    await ports.getProof(start.request, ports.capture(), retain);
    const first = vi.mocked(ordinaryOriginal).mock.calls[0]![0];
    expect(first).toMatchObject({ wallet: identity.wallet, request: start.request, method: 'GET', firstAttempt: false });
    expect(first.request).toBe(start.request); expect(first.retainAccepted).toBe(retain); expect(first.isCurrent()).toBe(true);
    await expect(first.retainRefusal({ status: 503, code: 'PHASE_E_DISABLED' })).rejects.toThrow('recovery GET');
    await ports.post(start.request, guard, retain, refusal, true); await ports.post(start.request, guard, retain, refusal, false);
    const calls = vi.mocked(ordinaryOriginal).mock.calls;
    expect(calls[1]![0]).toMatchObject({ wallet: identity.wallet, request: start.request, method: 'POST', firstAttempt: true });
    expect(calls[2]![0]).toMatchObject({ method: 'POST', firstAttempt: false }); expect(calls[1]![0].request).toBe(start.request);
    expect(get).not.toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled(); expect(refusal).not.toHaveBeenCalled();
  });
  it.each(['maintenance', 'base-aba', 'cookie'] as const)('%s changes during auth enqueue wait block POST while leaving the original request untouched', async change => {
    const { ports, page } = setup(), guard = ports.capture(id(1)), entered = deferred(), release = deferred(); let sent = false;
    vi.mocked(ordinaryOriginal).mockImplementation(async input => { entered.resolve(); await release.promise; input.isCurrent(); sent = true; return proof(start, true); });
    const work = ports.post(start.request, guard, noop, noop, true), failed = expect(work).rejects.toThrow(); await entered.promise;
    if (change === 'maintenance') page.actionsEnabled = false;
    else if (change === 'base-aba') { useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); }
    else vi.mocked(authCookies.assertResponse).mockImplementation(() => { throw new Error('cookie revision changed'); });
    release.resolve(); await failed; expect(sent).toBe(false); expect(ordinaryOriginal).toHaveBeenCalledOnce();
    expect(vi.mocked(ordinaryOriginal).mock.calls[0]![0].request).toBe(start.request);
  });
  it.each(['GET', 'POST'] as const)('owned %s acceptance waits for durable callback despite retired view, then refuses obsolete publication', async method => {
    const { ports, page } = setup(), entered = deferred(), received = deferred(), saved = deferred(); let settled = false, retained = false;
    const retain = vi.fn(async () => { retained = true; received.resolve(); await saved.promise; });
    vi.mocked(ordinaryOriginal).mockImplementation(async input => {
      input.isCurrent(); entered.resolve(); await receivedBody.promise;
      const accepted = proof(start, true); if (accepted.status !== 'accepted') throw new Error('fixture');
      await input.retainAccepted(accepted); input.isCurrent(); return accepted;
    });
    const receivedBody = deferred();
    const work = (method === 'GET' ? ports.getProof(start.request, ports.capture(), retain) : ports.post(start.request, ports.capture(id(1)), retain, noop, true))
      .then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    const failed = expect(work).rejects.toThrow(); await entered.promise; page.visible = false; page.epoch++; receivedBody.resolve(); await received.promise;
    expect(retained).toBe(true); expect(settled).toBe(false); expect(retain).toHaveBeenCalledWith(proof(start, true));
    saved.resolve(); await failed; expect(settled).toBe(true); expect(ordinaryOriginal).toHaveBeenCalledOnce();
  });
  it('awaits owned typed first-refusal persistence without adding stale-view admission to its callback', async () => {
    const { ports, page } = setup(), entered = deferred(), response = deferred(), seen = deferred(), saved = deferred(); let observed: unknown, settled = false;
    vi.mocked(ordinaryOriginal).mockImplementation(async input => {
      input.isCurrent(); entered.resolve(); await response.promise;
      await input.retainRefusal({ status: 422, code: 'INSUFFICIENT_RAW_STOCK' }); input.isCurrent(); return proof();
    });
    const work = ports.post(start.request, ports.capture(id(1)), noop, async error => { observed = error; seen.resolve(); await saved.promise; }, true)
      .finally(() => { settled = true; });
    const failed = expect(work).rejects.toThrow(); await entered.promise; page.active = false; response.resolve();
    await seen.promise;
    expect(observed).toBeInstanceOf(ApiError); expect(observed).toMatchObject({ status: 422, code: 'INSUFFICIENT_RAW_STOCK' }); expect(settled).toBe(false);
    saved.resolve(); await failed;
  });
  it('durable callback failure rejects the exact response without retry, false acceptance or current-stock GET', async () => {
    const { ports } = setup(), retain = vi.fn(async () => { throw new Error('disk full'); });
    vi.mocked(ordinaryOriginal).mockImplementation(async input => {
      input.isCurrent(); const accepted = proof(start, true); if (accepted.status !== 'accepted') throw new Error('fixture');
      await input.retainAccepted(accepted); return accepted;
    });
    const get = vi.spyOn(api, 'get').mockResolvedValue({});
    await expect(ports.post(start.request, ports.capture(id(1)), retain, noop, true)).rejects.toThrow('disk full');
    expect(retain).toHaveBeenCalledOnce(); expect(ordinaryOriginal).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled();
  });
  it('generic current GET rechecks actual enqueue and response guards and never owns historical evidence', async () => {
    const { ports, page } = setup(), guard = ports.capture();
    const get = vi.spyOn(api, 'get').mockImplementation(async (_path, options) => { expect(options?.isCurrent?.()).toBe(true); page.visible = false; return {} as never; });
    await expect(ports.get('/ordinary-crafting', guard)).rejects.toThrow(); expect(get).toHaveBeenCalledOnce(); expect(ordinaryOriginal).not.toHaveBeenCalled();
    page.visible = true; vi.mocked(authCookies.current).mockReturnValue(false);
    await expect(ports.get('/ordinary-crafting', guard)).rejects.toThrow(); expect(get).toHaveBeenCalledOnce();
  });
  it('current GET timeout aborts and rejects a late body instead of publishing it', async () => {
    vi.useFakeTimers(); const { ports } = setup(); let aborted = false;
    vi.spyOn(api, 'get').mockImplementation(async (_path, options) => {
      await new Promise<void>(resolve => { options!.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
      return {} as never;
    });
    const work = ports.get('/ordinary-crafting', ports.capture()), failed = expect(work).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs); await failed;
    expect(aborted).toBe(true); expect(ordinaryOriginal).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
