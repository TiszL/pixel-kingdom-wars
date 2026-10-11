import { AuthCookieCoordinator, AuthCoordinationError, type AuthCookieDiagnostic } from './authCookieCoordinatorCore';
import { clearSocialLoginIntent } from './socialLoginIntent';

const STORAGE_KEY = 'pkw:auth-cookie-transition:v1';
let invalidated: (() => void) | null = null;
let diagnostic: ((event: AuthCookieDiagnostic) => void) | null = null;
let memory = { revision: '', dirty: false };
let storageChecked = false;
let storageUnavailable = false;
let persistentStorage: Storage | null = null;
const storageError = (): Error => new AuthCoordinationError('storage', 'Secure sign-in needs working site storage. Allow site data for this game, then reload.');
function storage(): Storage | null {
  if (storageChecked) return persistentStorage;
  storageChecked = true;
  if (typeof window === 'undefined') return null;
  try {
    const candidate = window.localStorage;
    // Probe a separate key so checking capability neither overwrites the
    // shared auth marker nor broadcasts a false account change to other tabs.
    const probeKey = `${STORAGE_KEY}:probe`;
    const previous = candidate.getItem(probeKey);
    candidate.setItem(probeKey, previous ?? '1');
    if (previous === null) candidate.removeItem(probeKey);
    persistentStorage = candidate;
  } catch {
    storageUnavailable = true;
    memory = { ...memory, dirty: true };
  }
  return persistentStorage;
}
function requireStorage(): void {
  storage();
  if (storageUnavailable) throw storageError();
}
function readState(): typeof memory {
  const persistent = storage();
  if (!persistent || storageUnavailable) return memory;
  try {
    const raw = persistent.getItem(STORAGE_KEY);
    if (!raw) return memory;
    const state: unknown = JSON.parse(raw);
    if (state && typeof state === 'object' && 'revision' in state && 'dirty' in state
      && typeof state.revision === 'string' && typeof state.dirty === 'boolean') return memory = state as typeof memory;
  } catch { /* A damaged/unreadable marker requires explicit reconciliation. */ }
  return { revision: '', dirty: true };
}
const channel = typeof window !== 'undefined' && typeof window.BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('pkw:auth-cookie-transition:v1') : null;
const browserError = (): Error => new AuthCoordinationError('browser', 'This browser cannot coordinate secure sign-in. Update your browser and try again.');
async function sharedLock<T>(operation: () => Promise<T>, signal?: AbortSignal, clearsLimitedCookie = false): Promise<T> {
  requireStorage();
  if (typeof navigator === 'undefined') return operation();
  // Existing stable reads remain available on older browsers, but even an
  // idempotent limited-cookie clear needs exclusion from cookie issuance.
  if (!navigator.locks?.request) {
    if (clearsLimitedCookie) throw browserError();
    return operation();
  }
  return navigator.locks.request('pkw:auth-cookies:v1', { mode: 'shared', ...(signal ? { signal } : {}) }, operation);
}
export const authCookies = new AuthCookieCoordinator({
  revision: () => readState().revision,
  dirty: () => readState().dirty,
  set: (revision, dirty) => {
    requireStorage();
    memory = { revision, dirty };
    try { persistentStorage?.setItem(STORAGE_KEY, JSON.stringify(memory)); }
    catch {
      storageUnavailable = true;
      memory = { revision, dirty: true };
      // Memory alone cannot fence another tab or survive an interrupted login.
      // Never continue issuing cookies after losing the durable marker.
      throw storageError();
    }
    if (dirty) channel?.postMessage({ changed: true });
  },
}, async (operation, signal) => {
  requireStorage();
  if (typeof navigator === 'undefined') return operation(); // Server-side tests inject a real lock above.
  if (!navigator.locks?.request) throw browserError();
  return navigator.locks.request('pkw:auth-cookies:v1', { ...(signal ? { signal } : {}) }, operation);
}, () => invalidated?.(), sharedLock, clearSocialLoginIntent, (event) => diagnostic?.(event),
  operation => sharedLock(operation, undefined, true));
channel?.addEventListener('message', () => authCookies.invalidate());
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) authCookies.invalidate();
});
export function setAuthCookieInvalidatedHandler(handler: (() => void) | null): void { invalidated = handler; }
export function setAuthCookieDiagnosticHandler(handler: ((event: AuthCookieDiagnostic) => void) | null): void { diagnostic = handler; }
