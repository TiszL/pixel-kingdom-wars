import { captureError } from '../lib/analytics';

/** One broken visual must not prevent the remaining visuals, subscriptions or
 * home scene from being released. Never use this around combat or API writes. */
export function sceneCleanup(part: string, dispose: () => void): void {
  try { dispose(); } catch (cause) {
    captureError('error', {
      source: `scene-cleanup:${part}`, boundary: 'game',
      name: cause instanceof Error ? cause.name : 'Error',
      message: cause instanceof Error ? cause.message : String(cause),
    });
    // Keep the original stack available to browser diagnostics.
    console.error(`Scene cleanup failed: ${part}`, cause);
  }
}
