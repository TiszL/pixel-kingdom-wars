import { describe, expect, it, vi } from 'vitest';
import { AuthCookieCoordinator, type AuthCookieStorage } from './authCookieCoordinatorCore';

function setup() {
  let revision = ''; let dirty = false;
  const storage: AuthCookieStorage = { revision: () => revision, dirty: () => dirty, set: (r, d) => { revision = r; dirty = d; } };
  const changed = vi.fn(); const clear = vi.fn(async () => undefined);
  const c = new AuthCookieCoordinator(storage, (run) => run(), changed);
  return { c, storage, changed, clear };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

describe('local login ownership', () => {
  it('keeps dirty-cookie repair locked after its caller cancels, before allowing status or another login', async () => {
    let revision = 'interrupted'; let dirty = true;
    const storage: AuthCookieStorage = { revision: () => revision, dirty: () => dirty, set: (r, d) => { revision = r; dirty = d; } };
    const revoked = deferred<void>(); const started = deferred<void>();
    let exclusive = false;
    const c = new AuthCookieCoordinator(storage, async run => {
      expect(exclusive).toBe(false); exclusive = true;
      try { return await run(); } finally { exclusive = false; }
    }, vi.fn(), async run => { expect(exclusive).toBe(false); expect(dirty).toBe(false); return run(); });
    const clear = vi.fn(() => { started.resolve(); return revoked.promise; });
    const controller = new AbortController();
    const ready = c.ready(clear, controller.signal).catch((error: unknown) => error);
    await started.promise; controller.abort();
    expect(await ready).toBe(controller.signal.reason);
    expect(exclusive).toBe(true); expect(dirty).toBe(true);
    const operation = vi.fn(async () => 'clean');
    const status = c.run({ kind: 'status', clear, operation });
    expect(operation).not.toHaveBeenCalled();
    revoked.resolve(); await expect(status).resolves.toBe('clean');
    expect(clear).toHaveBeenCalledOnce(); expect(dirty).toBe(false);
  });
  it('rejects a status response if a foreign revision becomes dirty without adopting it', async () => {
    const { c, storage, clear } = setup();
    await expect(c.run({ kind: 'status', clear, operation: async () => {
      storage.set('foreign-writer', true); return 'obsolete';
    } })).rejects.toThrow('Sign-in changed');
    expect(storage.dirty()).toBe(true);
    expect(clear).not.toHaveBeenCalled();
    expect(() => c.session(async () => undefined)).toThrow('Sign-in changed');
  });
  it('blocks background transport without revoking the login whose cookie response is pending', async () => {
    const { c, changed, clear } = setup();
    const response = deferred<string>(); const started = deferred<void>();
    const attempt = c.begin();
    const login = c.run({ kind: 'login', clear, isCurrent: () => c.current(attempt) && changed.mock.calls.length === 0,
      operation: () => { started.resolve(); return response.promise; } });
    await started.promise;
    const gameplay = vi.fn(async () => 'should never be sent');
    expect(() => c.session(gameplay)).toThrow();
    expect(gameplay).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    response.resolve('accepted');
    await expect(login).resolves.toBe('accepted');
    expect(clear).not.toHaveBeenCalled();
    await expect(c.session(async () => 'new session')).resolves.toBe('new session');
  });
  it('still cleans up a verification explicitly superseded by another tab', async () => {
    const { c, changed, clear } = setup();
    const response = deferred<void>(); const started = deferred<void>();
    const login = c.run({ kind: 'login', clear, operation: () => { started.resolve(); return response.promise; } }).catch((e: unknown) => e);
    await started.promise;
    c.invalidate(); response.resolve();
    expect(await login).toBeInstanceOf(Error);
    expect(changed).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });
  it.each([true, false])('keeps foreign dirty/revised credentials fenced (dirty=%s)', (dirty) => {
    const { c, storage, changed } = setup();
    storage.set('foreign', dirty);
    expect(() => c.session(async () => undefined)).toThrow();
    expect(changed).toHaveBeenCalledOnce();
  });
});
