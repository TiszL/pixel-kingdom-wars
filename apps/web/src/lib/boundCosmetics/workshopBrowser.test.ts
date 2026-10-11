// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { requestBoundCosmeticOriginal } from '../api';
import { mutationGate } from '../mutationGate';
import { ordinaryCraftingIdentity } from '../ordinaryCrafting/browser';
import { loadCosmeticPreview } from './preview';
import { createWorkshopBrowserPorts } from './workshopBrowser';
import { command, deferred, id, identity, proof } from './workshopFixtures.test-support';
vi.mock('../api', async importOriginal => ({ ...await importOriginal<typeof import('../api')>(), requestBoundCosmeticOriginal: vi.fn() }));
vi.mock('../mutationGate', () => ({ mutationGate: { getSnapshot: vi.fn(() => true), subscribe: vi.fn() } }));
vi.mock('./preview', () => ({ loadCosmeticPreview: vi.fn() }));
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false); vi.mocked(mutationGate.getSnapshot).mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(requestBoundCosmeticOriginal).mockReset(); vi.mocked(loadCosmeticPreview).mockReset(); useApp.getState().setAuth(null); });
function ports() { const page = { active: true, visible: true, epoch: 0, actionsEnabled: true }; return { page, ports: createWorkshopBrowserPorts({ identity: ordinaryCraftingIdentity(identity.wallet), lifecycle: () => page }) }; }
it('binds current snapshots and crafting to selected-base generation while account receipt recovery survives ABA', () => {
  const { ports: p } = ports(); const snapshot = p.capture('base', id(1)), craft = p.capture('craft', id(1)), recovery = p.capture('account');
  useApp.getState().setSelectedBaseId(id(2), false); useApp.getState().setSelectedBaseId(id(1), false);
  expect(snapshot).toThrow(); expect(craft).toThrow(); expect(recovery).not.toThrow();
});
it('off ignores cosmetic pause but obeys the global mutation fence, and background/account changes refuse every publication', () => {
  const { ports: p, page } = ports(); page.actionsEnabled = false;
  expect(p.capture('craft', id(1))).toThrow(); expect(p.capture('preference', id(1))).not.toThrow();
  vi.mocked(mutationGate.getSnapshot).mockReturnValue(false); expect(p.capture('preference', id(1))).toThrow(); expect(p.capture('account')).not.toThrow();
  const original = p.capture('account'); page.visible = false; expect(original).toThrow(); page.visible = true;
  useApp.getState().setAuth('3'.repeat(32), true); expect(original).toThrow();
});
it('wraps only the frozen original endpoint and awaits matching acceptance retention without inventing definitive refusals', async () => {
  const { ports: p } = ports(); const retention = deferred<void>(), retained = vi.fn(() => retention.promise); const original = proof();
  vi.mocked(requestBoundCosmeticOriginal).mockImplementationOnce(async input => input.observe(200, original) as never);
  let settled = false; const pending = p.start(command().request, p.capture('craft', id(1)), retained).then(() => { settled = true; });
  await vi.waitFor(() => expect(retained).toHaveBeenCalledOnce()); expect(settled).toBe(false);
  const input = vi.mocked(requestBoundCosmeticOriginal).mock.calls[0]![0]; expect(input.path).toBe('/bound-cosmetics/jobs'); expect(input.body).toEqual(command().request);
  retention.resolve(); await pending; expect(await input.observe(409, { error: { code: 'ORDINARY_CRAFTING_BUSY', message: 'Busy' } })).toBeUndefined();
  expect(retained).toHaveBeenCalledOnce();
});
it('preflight closes verified bitmaps and refuses a stale or unavailable selected image before a craft can dispatch', async () => {
  const { ports: p, page } = ports(); const bitmap = { close: vi.fn() };
  vi.mocked(loadCosmeticPreview).mockResolvedValueOnce({ bitmap } as unknown as Awaited<ReturnType<typeof loadCosmeticPreview>>);
  await p.preview(command().appearance, p.capture('craft', id(1))); expect(bitmap.close).toHaveBeenCalledOnce();
  vi.mocked(loadCosmeticPreview).mockImplementationOnce(async () => { page.visible = false; return { bitmap } as unknown as Awaited<ReturnType<typeof loadCosmeticPreview>>; });
  await expect(p.preview(command().appearance, p.capture('craft', id(1)))).rejects.toThrow('could not be verified'); expect(bitmap.close).toHaveBeenCalledTimes(2);
  expect(requestBoundCosmeticOriginal).not.toHaveBeenCalled();
});
