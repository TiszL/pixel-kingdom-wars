import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { deferred, intent } from './fixtures.test-support';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('clan consent at final HTTP send', () => {
  it('Back/base change while waiting for the auth lock prevents fetch, preserving the saved command for GET recovery', async () => {
    const pending = deferred<void>(); let current = true;
    vi.spyOn(authCookies, 'session').mockImplementation(async (run) => { await pending.promise; return run(); });
    vi.stubGlobal('fetch', vi.fn()); const action = api.postRaw('/clans/v1/leave', intent().request, { isCurrent: () => current });
    current = false; pending.resolve(); await expect(action).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it('current consent sends exactly once and a late obsolete response cannot invoke handlers', async () => {
    vi.spyOn(authCookies, 'session').mockImplementation(async (run) => run());
    const pending = deferred<unknown>(); let current = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => pending.promise })));
    const action = api.postRaw('/clans/v1/kick', intent('kick').request, { isCurrent: () => current });
    current = false; pending.resolve({}); await expect(action).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)).toEqual(intent('kick').request);
  });
});
