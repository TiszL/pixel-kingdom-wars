/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api } from '../api';
import { mutationGate } from '../mutationGate';
import { createBuilderJobSpeedupBrowserPorts, builderJobSpeedupIdentity } from './browser';
import { id, identity, builder } from './fixtures.test-support';

afterEach(() => { vi.restoreAllMocks(); useApp.getState().setAuth(null); });
it('the shared forced-update latch prevents actual builder dispatch before React updates while receipt reads remain available', async () => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ selectedBaseId: id(1) });
  // Intentionally keep the rendered allowance true: the transport must consult
  // the synchronous source, not wait for a hook render or disabled button.
  const ports = createBuilderJobSpeedupBrowserPorts({ identity: builderJobSpeedupIdentity(identity.wallet),
    lifecycle: () => ({ active: true, visible: true, epoch: 0, actionsEnabled: true }) });
  const guard = ports.capture(id(1)); let dispatched = false;
  vi.spyOn(api, 'postRaw').mockImplementation(async (_path, _body, options) => {
    mutationGate.close(); options?.isCurrent?.(); dispatched = true; return {} as never;
  });
  await expect(ports.post(`/base/jobs/${builder.jobId}/speedup`, {}, 'GEMS', guard)).rejects.toThrow('view changed');
  expect(dispatched).toBe(false);
  vi.spyOn(api, 'get').mockImplementation(async (_path, options) => { options?.isCurrent?.(); return { status: 'unknown' } as never; });
  await expect(ports.get('/base/jobs/speedup/receipt', ports.capture())).resolves.toEqual({ status: 'unknown' });
});
