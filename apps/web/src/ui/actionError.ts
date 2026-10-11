/**
 * THE ONE PLACE A FAILED ACTION BECOMES NOISE — and the one place the land gate
 * is exempted from it.
 *
 * Before free onboarding every catch site in the menu screens did the same two
 * things: `playSfx('sfx_error')` and `toast(e.message)`. That is right for a
 * failure the player can do something about ("NOT ENOUGH SHARDS"). It is wrong
 * for `402 LAND_NOT_OWNED`, because api.ts already routes that code to the
 * buy-land sheet GLOBALLY (setLandGatedHandler) — so the toast fires a second,
 * quieter refusal UNDERNEATH the sheet that is already explaining it, with an
 * error sound on top. One tap, two refusals, and the sound says "you broke
 * something" about a purchase prompt.
 *
 * So: the sheet is the refusal, and this suppresses the duplicate. It does NOT
 * swallow the error — callers still get their `finally` and still clear `busy`.
 *
 * The message is passed in rather than derived so each call site keeps the casing
 * it already shipped (some upper-case, some not); this file only decides WHETHER.
 */
import { isLandNotOwned } from '../lib/api';
import { playSfx } from '../lib/audio';
import { bus } from '../lib/events';

/**
 * True when a failure must NOT be surfaced as a failed action, because something
 * else is already showing the player what happened.
 *
 * Exported separately from `failToast` so a test can pin the rule without a bus,
 * and so a call site that renders an inline error (rather than a toast) can use
 * the same judgement — `sheets.tsx` sets `err` into the panel, for instance.
 */
export function isHandledGlobally(e: unknown): boolean {
  return isLandNotOwned(e);
}

/** Error sound + toast for a failed action, EXCEPT when it is already handled. */
export function failToast(e: unknown, msg: string): void {
  if (isHandledGlobally(e)) return;
  playSfx('sfx_error');
  bus.emit('ui:toast', { msg });
}
