import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function stubResponse(status: number, code?: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code } }), { status })));
}

describe('API mutation closure', () => {
  it.each([[426, 'SIM_VERSION_MISMATCH'], [426, undefined], [503, 'MAINTENANCE']] as const)(
    'closes before the callback and caller rejection for %s %s', async (status, code) => {
      const { mutationGate } = await import('./mutationGate');
      const { api, setOutdatedHandler, setMaintenanceHandler } = await import('./api');
      const callback = vi.fn(() => expect(mutationGate.getSnapshot()).toBe(false));
      setOutdatedHandler(callback); setMaintenanceHandler(callback);
      stubResponse(status, code);
      await expect(api.postRaw('/commands', {})).rejects.toMatchObject({ status });
      expect(callback).toHaveBeenCalledOnce();
      expect(mutationGate.getSnapshot()).toBe(false);
    },
  );

  it.each([[426, 'BASE_CLIENT_UPGRADE_REQUIRED'], [503, undefined], [503, 'DEED_AUTHORITY_UNAVAILABLE']] as const)(
    'keeps new mutations available for %s %s', async (status, code) => {
      const { mutationGate } = await import('./mutationGate');
      const { api } = await import('./api');
      stubResponse(status, code);
      await expect(api.get('/base')).rejects.toMatchObject({ status });
      expect(mutationGate.getSnapshot()).toBe(true);
    },
  );

  it('closes without a mounted UI and still permits receipt recovery transports', async () => {
    const { mutationGate } = await import('./mutationGate');
    const { api } = await import('./api');
    stubResponse(503, 'MAINTENANCE');
    await expect(api.get('/base')).rejects.toMatchObject({ status: 503 });
    expect(mutationGate.getSnapshot()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ recovered: true }))));
    await expect(api.postRaw('/deposits/confirm', { originalKey: 'saved' })).resolves.toEqual({ recovered: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(mutationGate.getSnapshot()).toBe(false);
  });
});
