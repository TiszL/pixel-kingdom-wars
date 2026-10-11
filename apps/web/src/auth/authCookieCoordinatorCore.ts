/** HttpOnly cookies are applied before fetch resolves: ignoring a stale JSON
 * body cannot undo them. Hold the cookie lock through response delivery and
 * stale-session revocation, and never abort a request then release the lock. */
import { waitForCaller } from '../lib/callerCancellation';

type CookieLock = <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
export interface AuthCookieStorage {
  revision(): string;
  dirty(): boolean;
  set(revision: string, dirty: boolean): void;
}
export class AuthChangedError extends Error {
  constructor() { super('Sign-in changed. Please try again.'); }
}
export class AuthCoordinationError extends Error {
  constructor(readonly reason: 'storage' | 'browser', message: string) { super(message); }
}
export interface AuthCookieDiagnostic {
  phase: 'start' | 'blocked' | 'invalidated' | 'cleanup' | 'accepted';
  reason: 'login' | 'logout' | 'cross_tab' | 'session_revision' | 'dirty_cookie' | 'local_transition' | 'interrupted_response' | 'superseded_verification';
}
export class AuthCookieCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private active = 0;
  private acceptedRevision: string;
  constructor(
    private readonly storage: AuthCookieStorage,
    private readonly lock: CookieLock,
    private readonly changed: () => void = () => undefined,
    private readonly sessionLock = lock,
    private readonly began: () => void = () => undefined,
    private readonly diagnostic: (event: AuthCookieDiagnostic) => void = () => undefined,
    private readonly statusLock = sessionLock,
  ) { this.acceptedRevision = storage.revision(); }

  begin(): number { this.began(); this.generation += 1; return this.generation; }
  captureGeneration(): number { return this.generation; }
  current(generation: number): boolean { return generation === this.generation; }
  invalidate(): void {
    this.begin();
    this.diagnostic({ phase: 'invalidated', reason: 'cross_tab' });
    this.changed();
  }
  private serial<T>(operation: () => Promise<T>, signal?: AbortSignal, lock = this.lock): Promise<T> {
    const result = this.tail.then(() => {
      signal?.throwIfAborted();
      return lock(operation, signal);
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async repair(clear: () => Promise<unknown>): Promise<void> {
    if (!this.storage.dirty()) return;
    this.diagnostic({ phase: 'cleanup', reason: 'interrupted_response' });
    await clear(); // Failure deliberately keeps the durable dirty marker.
    this.storage.set(this.storage.revision(), false);
  }
  async ready(clear: () => Promise<unknown>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.active && !this.storage.dirty()) {
      await waitForCaller(this.sessionLock(async () => {
        signal?.throwIfAborted();
        if (this.storage.dirty()) throw new AuthChangedError();
        if (this.acceptedRevision !== this.storage.revision()) this.changed();
        this.acceptedRevision = this.storage.revision();
      }, signal), signal);
      return;
    }
    await waitForCaller(this.serial(async () => {
      signal?.throwIfAborted();
      await this.repair(clear);
      // Once repair starts it retains the cookie lock through revocation,
      // even when the waiting screen has timed out or unmounted.
      signal?.throwIfAborted();
      if (this.acceptedRevision !== this.storage.revision()) this.changed();
      this.acceptedRevision = this.storage.revision();
    }, signal), signal);
  }
  assertSession(): string {
    // A background read must not invalidate the local login that owns the
    // cookie lock. Doing so makes its successful response look superseded and
    // revokes the newly issued session. Other tabs still invalidate explicitly.
    if (this.active) {
      this.diagnostic({ phase: 'blocked', reason: 'local_transition' });
      throw new AuthChangedError();
    }
    if (this.storage.dirty() || this.storage.revision() !== this.acceptedRevision) {
      this.diagnostic({ phase: 'invalidated', reason: this.storage.dirty() ? 'dirty_cookie' : 'session_revision' });
      this.changed(); throw new AuthChangedError();
    }
    return this.acceptedRevision;
  }
  assertResponse(revision: string): void {
    if (this.active) throw new AuthChangedError();
    if (this.storage.dirty() || this.storage.revision() !== revision) {
      this.diagnostic({ phase: 'invalidated', reason: this.storage.dirty() ? 'dirty_cookie' : 'session_revision' });
      this.changed(); throw new AuthChangedError();
    }
  }
  session<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // Check before queueing and again under a shared browser lock. A command
    // queued before another tab logs in must never run with its new identity.
    signal?.throwIfAborted();
    this.assertSession();
    return waitForCaller(this.sessionLock(async () => {
      signal?.throwIfAborted();
      const revision = this.assertSession();
      const result = await operation();
      signal?.throwIfAborted();
      this.assertResponse(revision);
      return result;
    }, signal), signal);
  }
  run<T>(input: {
    kind: 'login' | 'logout' | 'status';
    operation: () => Promise<T>;
    clear: () => Promise<unknown>;
    isCurrent?: () => boolean;
    unchangedOnError?: (error: unknown) => boolean;
    before?: () => Promise<unknown>;
    after?: () => Promise<unknown>;
  }): Promise<T> {
    const generation = input.kind === 'logout' ? this.begin() : this.generation;
    if (input.kind === 'status') {
      // This route only clears an expired limited-login cookie. Shared status
      // readers may coexist with stable game requests and idempotent clears,
      // but retain their lock through the response to exclude login/logout.
      // Dirty repair can revoke full cookies, so it MUST run exclusively first.
      return this.ready(input.clear).then(() => this.serial(async () => {
        if (!this.current(generation) || input.isCurrent?.() === false) throw new AuthChangedError();
        const revision = this.assertSession();
        const result = await input.operation();
        this.assertResponse(revision);
        return result;
      }, undefined, this.statusLock));
    }
    const kind = input.kind;
    this.diagnostic({ phase: 'start', reason: kind });
    this.active += 1;
    return this.serial(async () => {
      await this.repair(input.clear);
      if (input.kind !== 'logout' && (!this.current(generation) || input.isCurrent?.() === false)) {
        throw new AuthChangedError();
      }
      await input.before?.();
      const revision = crypto.randomUUID();
      this.storage.set(revision, true);
      try {
        const result = await input.operation();
        if (input.kind === 'login' && (!this.current(generation) || input.isCurrent?.() === false)) {
          this.diagnostic({ phase: 'cleanup', reason: 'superseded_verification' });
          await input.clear();
          this.storage.set(revision, false);
          throw new AuthChangedError();
        }
        await input.after?.();
        this.storage.set(revision, false);
        this.acceptedRevision = revision;
        this.diagnostic({ phase: 'accepted', reason: kind });
        return result;
      } catch (error) {
        // A documented rejection before session issuance (e.g. wrong TOTP)
        // preserves the credential so the player can retry the same challenge.
        // Uncertain/lost responses may have installed cookies and must revoke.
        if (input.unchangedOnError?.(error) && this.current(generation) && input.isCurrent?.() !== false) {
          this.storage.set(revision, false);
          this.acceptedRevision = revision;
        } else await this.repair(input.clear);
        throw error;
      }
    }).finally(() => { this.active -= 1; });
  }
}
