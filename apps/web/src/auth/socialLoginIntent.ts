import { LOGIN_AUTH } from '@shardkeep/shared';

const KEY = 'pkw:social-login-intent:v1';
/** Only a player-requested provider flow may continue across its page redirect.
 * No provider tokens or ownership claims are stored in this tab-local intent. */
export function rememberSocialLoginIntent(cookieRevision: string): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ cookieRevision, startedAt: Date.now() })); }
  catch { throw new Error('Social sign-in needs working site storage. Allow site data and try again.'); }
}
export function clearSocialLoginIntent(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* Missing storage cannot resume an intent. */ }
}
export function consumeSocialLoginIntent(cookieRevision: string): boolean {
  try {
    const raw = sessionStorage.getItem(KEY);
    // Do not authenticate unless consuming the intent actually persisted.
    sessionStorage.removeItem(KEY);
    if (!raw) return false;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('cookieRevision' in value) || !('startedAt' in value)
      || value.cookieRevision !== cookieRevision || typeof value.startedAt !== 'number') return false;
    const age = Date.now() - value.startedAt;
    return age >= 0 && age <= LOGIN_AUTH.pendingTtlSec * 1_000;
  } catch { return false; }
}
