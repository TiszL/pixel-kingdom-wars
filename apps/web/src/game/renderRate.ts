/**
 * Render-rate policy for the Solana-Mobile shell.
 *
 * High-refresh Android panels make requestAnimationFrame drive Phaser at 90 or
 * 120 rendered frames per second even though the game is authored and measured
 * for 60. The sticky TWA client therefore caps the engine at 60; ordinary web
 * sessions retain Phaser's uncapped/browser-native behavior. `?hz=auto` is the
 * diagnostic escape hatch and persists because a push/deep link can relaunch
 * the TWA without the original query. `?hz=60` returns to the safe default.
 */
export const RENDER_RATE_OVERRIDE_KEY = 'skp_hz';

export interface RenderRateEnvironment {
  search: string;
  solanaMobile: boolean;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export function renderFpsLimit(environment: RenderRateEnvironment): number {
  const requested = new URLSearchParams(environment.search).get('hz');
  if (!environment.solanaMobile) return 0;
  if (requested === 'auto') {
    try { environment.storage?.setItem(RENDER_RATE_OVERRIDE_KEY, 'auto'); } catch { /* query still wins */ }
  } else if (requested === '60') {
    try { environment.storage?.removeItem(RENDER_RATE_OVERRIDE_KEY); } catch { /* safe default still wins */ }
  }
  if (requested === 'auto') return 0;
  if (requested !== '60') {
    try {
      if (environment.storage?.getItem(RENDER_RATE_OVERRIDE_KEY) === 'auto') return 0;
    } catch { /* storage denial falls through to the mobile-safe cap */ }
  }
  return 60;
}
