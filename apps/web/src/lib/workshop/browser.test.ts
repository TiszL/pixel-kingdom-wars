/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api } from '../api';
import { createWorkshopBrowserPorts, workshopIdentity } from './browser';
import { id, identity, start } from './fixtures.test-support';
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ selectedBaseId: id(1), baseSelectionEpoch: 0 });
});
afterEach(() => { vi.restoreAllMocks(); useApp.getState().setAuth(null); });
const setup = () => {
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, scoped = workshopIdentity(identity.wallet);
  return { page, scoped, ports: createWorkshopBrowserPorts({ identity: scoped, lifecycle: () => page }) };
};
describe('Workshop browser authority at transport', () => {
  it('requires canonical API/origin/network; mutation binds base epoch while historical recovery survives selection changes', () => {
    const { ports, page, scoped } = setup(), mutation = ports.capture(id(1)), recovery = ports.capture();
    useApp.getState().setSelectedBaseId(id(2), false); expect(mutation).toThrow(); expect(recovery).not.toThrow();
    page.epoch++; expect(recovery).toThrow();
    const foreign = createWorkshopBrowserPorts({ identity: { ...scoped, api: 'https://other.test/api' }, lifecycle: () => page });
    expect(() => foreign.capture()).toThrow('another origin');
  });
  it('retains exact body and actual-fetch cookie/selection checks after authentication waits', async () => {
    const { ports } = setup(), guard = ports.capture(id(1));
    const post = vi.spyOn(api, 'postRaw').mockResolvedValue({}); await ports.post('/workshop/jobs', start.request, guard);
    expect(post.mock.calls[0]?.[1]).toBe(start.request); expect(post.mock.calls[0]?.[2]?.isCurrent?.()).toBe(true);
    useApp.setState({ baseSelectionEpoch: 1 }); expect(post.mock.calls[0]?.[2]?.isCurrent).toThrow();
  });
  it('a maintenance gate closing during an auth wait prevents POST transport while original receipt GET remains available', async () => {
    const { ports, page } = setup(), guard = ports.capture(id(1));
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(yes => { release = yes; }), started = new Promise<void>(yes => { entered = yes; });
    let sent = false;
    vi.spyOn(api, 'postRaw').mockImplementation(async (_path, _body, options) => { entered(); await wait; options?.isCurrent?.(); sent = true; return {} as never; });
    const post = ports.post('/workshop/jobs', start.request, guard); const rejected = expect(post).rejects.toThrow();
    await started; page.actionsEnabled = false; release(); await rejected; expect(sent).toBe(false);
    vi.spyOn(api, 'get').mockResolvedValue({}); await expect(ports.get('/workshop/jobs/by-key/original-start-key', ports.capture())).resolves.toEqual({});
    expect(ports.capture(id(1))).toThrow();
  });
  it('GET response from an obsolete wallet, visibility epoch or cookie generation cannot be consumed', async () => {
    const { ports, page } = setup();
    const get = vi.spyOn(api, 'get').mockImplementation(async () => { page.visible = false; return {} as never; });
    await expect(ports.get('/workshop', ports.capture())).rejects.toThrow(); expect(get).toHaveBeenCalledOnce();
    page.visible = true; useApp.setState({ wallet: 'So11111111111111111111111111111111111111112' });
    await expect(ports.get('/workshop', ports.capture())).rejects.toThrow(); expect(get).toHaveBeenCalledOnce();
    useApp.setState({ wallet: identity.wallet }); vi.spyOn(authCookies, 'current').mockReturnValue(false);
    expect(ports.capture()).toThrow();
  });
});
