/**
 * "ASK BEFORE SPENDING KEEP" preference (player report 2026-08-29: "I
 * accidentally spent KEEP to instantly finish a building because there was no
 * confirmation warning before the purchase").
 *
 * KEEP is the HARD currency (store.ts BalancesDto) — it is earned slowly and
 * withdrawable, unlike mined shards. Every KEEP speed-up therefore asks first.
 * Defaults ON ('0' = the player opted out): a protection that ships off is the
 * same bug with an extra step, and the opt-out stays reversible from
 * PROFILE ▸ CONFIRM KEEP SPENDS.
 *
 * Storage matches the other client preferences (skp_sound_fx / skp_haptics /
 * skp_landscape): one localStorage flag, read at spend time.
 */
export const KEEP_CONFIRM_KEY = 'skp_confirm_keep';

/** True when a KEEP spend must be confirmed before it is posted. Reads that
 * throw (restricted WebViews revoke the localStorage getter, see
 * mobilePhantomAdapter) fail SAFE — an unreadable preference must never be
 * read as "this player opted out of money confirmations". */
export function keepConfirmOn(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(KEEP_CONFIRM_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setKeepConfirm(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEEP_CONFIRM_KEY, on ? '1' : '0');
  } catch { /* a preference we cannot persist still applies to this session */ }
}
