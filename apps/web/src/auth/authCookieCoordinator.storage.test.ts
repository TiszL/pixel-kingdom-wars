/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const key = 'pkw:auth-cookie-transition:v1';
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    (callback ?? options as () => Promise<unknown>)() } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('persistent cookie-transition storage', () => {
  it('keeps existing reads available without browser locks but refuses even limited-cookie clears', async () => {
    vi.stubGlobal('navigator', {});
    const { authCookies } = await import('./authCookieCoordinator');
    const clear = vi.fn(); const operation = vi.fn();
    await authCookies.ready(clear);
    await expect(authCookies.session(async () => 'existing session')).resolves.toBe('existing session');
    await expect(authCookies.run({ kind: 'status', operation, clear })).rejects.toMatchObject({ reason: 'browser' });
    expect(operation).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
  });
  it('preserves the existing dirty marker through probing and repairs before another login', async () => {
    const marker = JSON.stringify({ revision: 'interrupted-login', dirty: true });
    localStorage.setItem(key, marker);
    const { authCookies } = await import('./authCookieCoordinator');
    expect(localStorage.getItem(key)).toBe(marker);
    const order: string[] = [];
    await authCookies.run({ kind: 'login', clear: async () => { order.push('revoke'); },
      operation: async () => { order.push('login'); } });
    expect(order).toEqual(['revoke', 'login']);
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ dirty: false });
  });

  it.each(['denied', 'read-only'] as const)('fails closed with recovery guidance when storage is %s', async (mode) => {
    if (mode === 'denied') vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('denied'); });
    else vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      getItem: () => null, setItem: () => { throw new Error('read-only'); }, removeItem: vi.fn(),
    } as unknown as Storage);
    const { authCookies } = await import('./authCookieCoordinator');
    const clear = vi.fn();
    const operation = vi.fn();
    // Neither startup repair nor login can issue/revoke cookies while lacking
    // the cross-tab, reload-safe marker. Importing the UI remains possible.
    await expect(authCookies.ready(clear)).rejects.toThrow('Allow site data');
    await expect(authCookies.run({ kind: 'login', clear, operation })).rejects.toThrow('Allow site data');
    expect(() => authCookies.session(operation)).toThrow();
    expect(clear).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not issue cookies if writes fail after the initial capability check', async () => {
    let writable = true;
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      getItem: () => null, setItem: () => { if (!writable) throw new Error('quota'); }, removeItem: vi.fn(),
    } as unknown as Storage);
    const { authCookies } = await import('./authCookieCoordinator');
    writable = false;
    const operation = vi.fn();
    const clear = vi.fn();
    await expect(authCookies.run({ kind: 'login', operation, clear })).rejects.toThrow('Allow site data');
    await expect(authCookies.ready(clear)).rejects.toThrow('Allow site data');
    expect(operation).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
