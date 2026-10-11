/**
 * Diagnostics flag (D-101 "measure first"). This is the ONLY diagnostics code
 * on the normal path: a localStorage bit plus a change listener. The
 * measurement itself (`./perfDiag`) is dynamically imported by PhaserGame only
 * while the flag is on, so a session that never turns it on never downloads,
 * parses or mounts it — first paint and per-frame cost stay unchanged.
 *
 * Enable: `?diag=1` (persists, like the Solana-Mobile marker) or the Settings
 * row; `?diag=0` clears the persisted bit.
 */
export const PERF_DIAG_KEY = 'skp_diag';

const listeners = new Set<(on: boolean) => void>();

export function perfDiagEnabled(): boolean {
  try { return localStorage.getItem(PERF_DIAG_KEY) === '1'; } catch { return false; }
}

/** Boot-time read: the URL wins and is persisted so the overlay survives the
 *  in-app navigation that strips the query (the TWA start URL carries none). */
export function resolvePerfDiagFromUrl(search: string): boolean {
  const q = new URLSearchParams(search).get('diag');
  if (q === '1') { setPerfDiagEnabled(true); return true; }
  if (q === '0') { setPerfDiagEnabled(false); return false; }
  return perfDiagEnabled();
}

export function setPerfDiagEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(PERF_DIAG_KEY, '1');
    else localStorage.removeItem(PERF_DIAG_KEY);
  } catch { /* private mode: the listener still applies it for this session */ }
  for (const cb of listeners) cb(on);
}

/** The mounted game reacts to the Settings toggle without a reload. */
export function subscribePerfDiag(cb: (on: boolean) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
