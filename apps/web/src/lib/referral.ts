/** Referral-link capture (D-052, M23 a16): a friend opens
 * https://play.pixelkingdomwars.com/?ref=KEEP-XXXXX, the code is stashed
 * before auth exists, and onboarding redeems it after sign-in.
 * The param is stripped from the URL so it never lingers in history/shares.
 * Everything is try/wrapped: storage being unavailable must never break boot —
 * the gate's manual code input is the fallback path. */
const KEY = 'skp_ref';
const CODE_RE = /^keep-[a-z2-9]{5}$/i;
let memoryCode: string | null = null;

export function captureReferralFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const ref = url.searchParams.get('ref')?.trim();
    if (!ref || !CODE_RE.test(ref)) return;
    memoryCode = ref.toUpperCase();
    try { localStorage.setItem(KEY, memoryCode); memoryCode = null; } catch { /* retain this tab's attribution */ }
    url.searchParams.delete('ref');
    window.history.replaceState(null, '', url.toString());
  } catch { /* boot must not depend on storage */ }
}

export function readStoredReferralCode(): string | null {
  if (memoryCode) return memoryCode;
  try {
    const stored = localStorage.getItem(KEY);
    return stored && CODE_RE.test(stored) ? stored : memoryCode;
  } catch { return memoryCode; }
}

export function clearStoredReferralCode(expectedCode?: string): void {
  if (expectedCode && readStoredReferralCode() !== expectedCode) return;
  memoryCode = null;
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
