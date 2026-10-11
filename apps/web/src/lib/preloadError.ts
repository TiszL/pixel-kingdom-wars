/**
 * Chunk-load recovery. Every deploy replaces the content-hashed chunks, so a
 * tab holding the previous index.html fails its next lazy import with "Failed
 * to fetch dynamically imported module" — Vite reports it as a cancelable
 * `vite:preloadError` on window. The fix is always the same, fetch the new
 * bundle, so do that instead of showing the player a broken screen (and
 * instead of mailing Sentry about it — the error is denylisted in
 * analytics.ts).
 *
 * The reload is guarded by a sessionStorage stamp: if a chunk is STILL missing
 * after a fresh load (a half-deployed CDN, a stale index served from cache)
 * the error is left to propagate to the boundaries rather than reloading
 * forever.
 */
import { reloadToLatest } from './version';

const FLAG = 'pkw:preload-reloaded';
/** A second preload failure inside this window is not fixed by reloading. */
const LOOP_WINDOW_MS = 60_000;
let reloadedThisLoad = false;

/** Returns true when a reload was triggered, false when the guard held. */
export function handlePreloadError(
  reload: () => void | Promise<void> = reloadToLatest,
  now: () => number = () => Date.now(),
): boolean {
  let recent = false;
  try {
    const stamp = Number(sessionStorage.getItem(FLAG) ?? 0);
    recent = stamp > 0 && now() - stamp < LOOP_WINDOW_MS;
    if (!recent) sessionStorage.setItem(FLAG, String(now()));
  } catch {
    // No sessionStorage (private mode): reload once per page load at most —
    // the module-level latch below still prevents a same-load loop.
    recent = reloadedThisLoad;
  }
  if (recent) return false;
  reloadedThisLoad = true;
  void reload();
  return true;
}

export function installPreloadErrorReload(reload?: () => void | Promise<void>): void {
  window.addEventListener('vite:preloadError', () => {
    // Vite treats cancellation as a fulfilled undefined import, which crashes
    // React.lazy even while the async reload is pending. Preserve the original
    // rejection both during recovery and when the reload loop guard holds.
    handlePreloadError(reload);
  });
}
