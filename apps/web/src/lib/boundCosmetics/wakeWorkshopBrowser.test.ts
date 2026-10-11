// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, requestBoundCosmeticOriginal } from '../api';
import { mutationGate } from '../mutationGate';
import { ordinaryCraftingIdentity } from '../ordinaryCrafting/browser';
import { createWakeWorkshopBrowserPorts } from './wakeWorkshopBrowser';
import { command, deferred, id } from './workshopFixtures.test-support';
import { wakeCommand, wakeIdentity, wakeProof } from './wakeWorkshopFixtures.test-support';
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), requestBoundCosmeticOriginal: vi.fn() }));
vi.mock('../mutationGate', () => ({ mutationGate: { getSnapshot: vi.fn(() => true), subscribe: vi.fn() } }));
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(wakeIdentity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false); vi.mocked(mutationGate.getSnapshot).mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(requestBoundCosmeticOriginal).mockReset(); useApp.getState().setAuth(null); });
function ports() { const page = { active: true, visible: true, epoch: 0, actionsEnabled: true, ready: false }; return { page,
  ports: createWakeWorkshopBrowserPorts({ identity: ordinaryCraftingIdentity(wakeIdentity.wallet), lifecycle: () => page, applicationReady: () => page.ready }) }; }
it('keeps account Off and recovery independent of base ABA while new craft on and global fences remain closed', () => {
  const { ports: p, page } = ports(), off = p.capturePreference(false), original = p.capture('account'), base = p.capture('base', id(1));
  useApp.getState().setSelectedBaseId(id(2), false); useApp.getState().setSelectedBaseId(id(1), false); page.actionsEnabled = false;
  expect(off).not.toThrow(); expect(original).not.toThrow(); expect(base).toThrow(); expect(p.capturePreference(true)).toThrow(); expect(p.capture('craft', id(1))).toThrow();
  vi.mocked(mutationGate.getSnapshot).mockReturnValue(false); expect(off).toThrow(); expect(original).not.toThrow();
});
it('fences account ABA lifecycle and admission changes at publication without treating artwork as application readiness', () => {
  const { ports: p, page } = ports(); page.ready = true; const on = p.capturePreference(true), craft = p.capture('craft', id(1));
  page.ready = false; expect(on).toThrow(); expect(craft).toThrow(); const off = p.capturePreference(false);
  page.epoch++; expect(off).toThrow(); const recovery = p.capture('account');
  authCookies.invalidate(); useApp.getState().setAuth('11111111111111111111111111111113', true); useApp.getState().setAuth(wakeIdentity.wallet, true); expect(recovery).toThrow();
});
it('uses exact Wake POST with complete late accepted retention and leaves failed attempts uncertain', async () => {
  const { ports: p, page } = ports(); page.ready = true; const held = deferred<void>(), retained = vi.fn(() => held.promise);
  vi.mocked(requestBoundCosmeticOriginal).mockImplementationOnce(async input => input.observe(200, wakeProof()) as never);
  const pending = p.start(wakeCommand().request, p.capture('craft', id(1)), retained);
  await vi.waitFor(() => expect(retained).toHaveBeenCalledOnce()); page.visible = false;
  const input = vi.mocked(requestBoundCosmeticOriginal).mock.calls[0]![0]; expect(input.path).toBe('/bound-cosmetics/wakes/v1/jobs'); expect(input.body).toEqual(wakeCommand().request);
  held.resolve(); await pending; expect(input.isCurrent).toThrow(); expect(await input.observe(409, { error: 'busy' })).toBeUndefined(); expect(retained).toHaveBeenCalledOnce();
  page.visible = true; expect(() => p.start(command().request, p.capture('craft', id(1)), retained)).toThrow(); expect(requestBoundCosmeticOriginal).toHaveBeenCalledOnce();
});
it('uses guarded exact view and account-only PUT bodies without repeating requests or requiring a selected kingdom', async () => {
  const { ports: p, page } = ports(); page.actionsEnabled = false; useApp.getState().setSelectedBaseId(null, false);
  const get = vi.spyOn(api, 'get').mockResolvedValue({}), put = vi.spyOn(api, 'put').mockRejectedValueOnce(Error('Uncertain reply'));
  await p.view(null, p.capture('account')); expect(get.mock.calls[0]?.[0]).toBe('/bound-cosmetics/wakes/v1/workshop');
  await expect(p.preference({ enabled: false, expectedRevision: '2' }, p.capturePreference(false))).rejects.toThrow('Uncertain reply');
  expect(put).toHaveBeenCalledOnce(); expect(put.mock.calls[0]?.slice(0, 2)).toEqual(['/bound-cosmetics/wakes/v1/preference', { enabled: false, expectedRevision: '2' }]);
  expect(() => p.preference({ enabled: false, expectedRevision: '2', baseId: id(1) } as never, p.capturePreference(false))).toThrow(); expect(put).toHaveBeenCalledOnce();
});
