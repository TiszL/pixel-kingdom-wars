/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, ApiError } from '../api';
import { mutationGate } from '../mutationGate';
import { unpaidOriginal } from '../unpaidResources/transport';
import { createStarterExpeditionBrowserPorts, starterExpeditionIdentity } from './browser';
import { deferred, id, identity, proof, start } from './fixtures.test-support';
vi.mock('../unpaidResources/transport', () => ({ unpaidOriginal: vi.fn() }));
vi.mock('../mutationGate', () => ({ mutationGate: { getSnapshot: vi.fn(() => true) } }));
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined); vi.spyOn(authCookies, 'current').mockReturnValue(true);
  vi.mocked(mutationGate.getSnapshot).mockReturnValue(true); vi.mocked(unpaidOriginal).mockReset().mockResolvedValue(proof(start, true));
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false);
});
afterEach(() => { vi.restoreAllMocks(); useApp.getState().setAuth(null); });
const setup = () => {
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, scoped = starterExpeditionIdentity(identity.wallet);
  return { page, scoped, ports: createStarterExpeditionBrowserPorts({ identity: scoped, lifecycle: () => page }) };
};
const noop = async () => undefined;
describe('starter expedition scoped browser adapter', () => {
  it('isolates API identity and wallet while historical guards remain independent of mutable departure admission', () => {
    const { ports, scoped, page } = setup(), mutation = ports.capture(id(1)), historical = ports.capture();
    const foreign = createStarterExpeditionBrowserPorts({ identity: { ...scoped, api: 'https://other.test/api' }, lifecycle: () => page }); expect(() => foreign.capture()).toThrow('another origin');
    useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); page.actionsEnabled = false;
    vi.mocked(mutationGate.getSnapshot).mockReturnValue(false); expect(mutation).toThrow(); expect(historical).not.toThrow();
    useApp.setState({ wallet: 'So11111111111111111111111111111111111111112' }); expect(historical).toThrow();
  });
  it('delegates only the expedition family with exact original body and explicit first-attempt classification', async () => {
    const { ports } = setup(), retain = vi.fn(noop), refusal = vi.fn(noop), get = vi.spyOn(api, 'get').mockResolvedValue({});
    await ports.getProof(start.request, ports.capture(), retain); await ports.post(start.request, ports.capture(id(1)), retain, refusal, true);
    await ports.post(start.request, ports.capture(id(1)), retain, refusal, false);
    const calls = vi.mocked(unpaidOriginal).mock.calls.map(([input]) => input);
    expect(calls.map(input => [input.method, input.firstAttempt])).toEqual([['GET', false], ['POST', true], ['POST', false]]);
    for (const input of calls) { expect(input.command).toEqual({ kind: 'expedition', request: start.request }); expect(input.wallet).toBe(identity.wallet); expect(input.retainAccepted).toBe(retain); expect(input.isCurrent()).toBe(true); }
    await expect(calls[0]!.retainRefusal({ status: 409, code: 'EXPEDITION_LODGE_UNAVAILABLE' })).rejects.toThrow('recovery GET');
    expect(get).not.toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled(); expect(refusal).not.toHaveBeenCalled();
  });
  it.each(['base-aba', 'maintenance'] as const)('%s during authentication enqueue wait refuses the explicit POST without changing its key', async change => {
    const { ports, page } = setup(), entered = deferred(), release = deferred(); let sent = false;
    vi.mocked(unpaidOriginal).mockImplementation(async input => { entered.resolve(); await release.promise; input.isCurrent(); sent = true; return proof(start, true); });
    const work = ports.post(start.request, ports.capture(id(1)), noop, noop, true), failed = expect(work).rejects.toThrow(); await entered.promise;
    if (change === 'base-aba') { useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); } else page.actionsEnabled = false;
    release.resolve(); await failed; expect(sent).toBe(false); expect(unpaidOriginal).toHaveBeenCalledOnce();
    expect(vi.mocked(unpaidOriginal).mock.calls[0]![0].command).toEqual({ kind: 'expedition', request: start.request });
  });
  it.each(['GET', 'POST'] as const)('owned %s original receipt keeps its awaited durable callback after view retirement', async method => {
    const { ports, page } = setup(), entered = deferred(), body = deferred(), seen = deferred(), saved = deferred(); let finished = false;
    const retain = vi.fn(async () => { seen.resolve(); await saved.promise; });
    vi.mocked(unpaidOriginal).mockImplementation(async input => { input.isCurrent(); entered.resolve(); await body.promise;
      const accepted = proof(start, true); if (accepted.status !== 'accepted') throw new Error('fixture'); await input.retainAccepted(accepted); input.isCurrent(); return accepted; });
    const work = (method === 'GET' ? ports.getProof(start.request, ports.capture(), retain) : ports.post(start.request, ports.capture(id(1)), retain, noop, true)).finally(() => { finished = true; });
    const failed = expect(work).rejects.toThrow(); await entered.promise; page.visible = false; page.epoch++; body.resolve(); await seen.promise;
    expect(retain).toHaveBeenCalledWith(proof(start, true)); expect(finished).toBe(false); saved.resolve(); await failed; expect(unpaidOriginal).toHaveBeenCalledOnce();
  });
  it('maps and awaits complete original Lodge refusal evidence independently of obsolete live admission', async () => {
    const { ports, page } = setup(), entered = deferred(), response = deferred(), seen = deferred(), saved = deferred(); let observed: unknown, finished = false;
    vi.mocked(unpaidOriginal).mockImplementation(async input => { input.isCurrent(); entered.resolve(); await response.promise;
      await input.retainRefusal({ status: 409, code: 'EXPEDITION_LODGE_UNAVAILABLE' }); input.isCurrent(); return proof(); });
    const work = ports.post(start.request, ports.capture(id(1)), noop, async error => { observed = error; seen.resolve(); await saved.promise; }, true).finally(() => { finished = true; });
    const failed = expect(work).rejects.toThrow(); await entered.promise; page.active = false; response.resolve(); await seen.promise;
    expect(observed).toBeInstanceOf(ApiError); expect(observed).toMatchObject({ status: 409, code: 'EXPEDITION_LODGE_UNAVAILABLE' }); expect(finished).toBe(false);
    saved.resolve(); await failed;
  });
  it('propagates receipt persistence failure without retry or current-fleet hydration', async () => {
    const { ports } = setup(), retain = vi.fn(async () => { throw new Error('departure journal full'); }), get = vi.spyOn(api, 'get').mockResolvedValue({});
    vi.mocked(unpaidOriginal).mockImplementation(async input => { input.isCurrent(); const accepted = proof(start, true); if (accepted.status !== 'accepted') throw new Error('fixture'); await input.retainAccepted(accepted); return accepted; });
    await expect(ports.post(start.request, ports.capture(id(1)), retain, noop, true)).rejects.toThrow('journal full');
    expect(unpaidOriginal).toHaveBeenCalledOnce(); expect(retain).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled();
  });
  it('current fleet GET rechecks cookie and visible-view guards rather than treating its body as durable historical proof', async () => {
    const { ports, page } = setup(), guard = ports.capture();
    const get = vi.spyOn(api, 'get').mockImplementation(async (_path, options) => { expect(options?.isCurrent?.()).toBe(true); page.visible = false; return {} as never; });
    await expect(ports.get('/starter-expeditions', guard)).rejects.toThrow(); expect(get).toHaveBeenCalledOnce(); expect(unpaidOriginal).not.toHaveBeenCalled();
    page.visible = true; vi.mocked(authCookies.assertResponse).mockImplementation(() => { throw new Error('retired cookie session'); });
    await expect(ports.get('/starter-expeditions', guard)).rejects.toThrow('retired cookie'); expect(get).toHaveBeenCalledOnce();
  });
});
