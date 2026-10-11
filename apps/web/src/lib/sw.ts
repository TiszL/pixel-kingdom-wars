/**
 * Service-worker registration.
 *
 * Deliberately NOT registered in development. A service worker caching a dev
 * server is a machine for producing "why is my change not showing up" — and the
 * fix (hard reload, clear storage) is exactly the confusion this file exists to
 * prevent in production.
 *
 * The `?v=<gitSha>` is load-bearing, not decoration: the browser only reinstalls
 * a worker whose SCRIPT BYTES differ, and sw.js is a static file that does not
 * change between builds. The query string is what makes each deploy a new
 * worker, and it is also where the worker reads its cache name from.
 */
import { BUILD } from './version';
import { serviceWorkerControlsAssetPackBuild } from './assetPack';

let registrationRequest: Promise<boolean> | undefined;

export function registerServiceWorker(retry = false): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(false);
  // import.meta.env.DEV is compiled out of the production bundle entirely.
  if (import.meta.env.DEV) return Promise.resolve(false);

  if (registrationRequest && !retry) return registrationRequest;
  // A previous worker refuses this page's new, build-bound artwork until the
  // new worker takes control. Waiting for window.load makes those same image
  // requests delay their own recovery (and misses callers after load entirely).
  try {
    const request = navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(BUILD.gitSha)}`, { scope: '/' })
      .then(() => true, () => {
        if (registrationRequest === request) registrationRequest = undefined;
        return false;
      });
    registrationRequest = request;
    return request;
  } catch {
    return Promise.resolve(false);
  }
}

export type GameWorkerReadiness = 'ready' | 'waiting' | 'error';
const GAME_WORKER_WAIT_MS = 10_000;

/** An uncontrolled first visit can fetch the exact pinned files directly. Only
 * an older controller can reject this page's build before its index is ready. */
function blockingGameWorker(): ServiceWorkerContainer | null {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return null;
  try {
    const worker = navigator.serviceWorker;
    return worker.controller && !serviceWorkerControlsAssetPackBuild(worker.controller, BUILD.gitSha) ? worker : null;
  } catch {
    // Sandboxed/private contexts can expose the property but deny its getter.
    // They retain the same direct-network path as an unsupported browser.
    return null;
  }
}

export function gameWorkerBootBlocked(): boolean {
  return blockingGameWorker() !== null;
}

/** Wait once before mounting Phaser, never interrupt an already-running game.
 * A timeout exposes retry but keeps watching for a late successful takeover. */
export function waitForGameWorker(
  publish: (state: GameWorkerReadiness) => void,
  retry = false,
): () => void {
  const worker = blockingGameWorker();
  if (!worker) {
    publish('ready');
    return () => {};
  }
  let live = true;
  const dispose = (): void => {
    live = false;
    clearTimeout(timeout);
    worker.removeEventListener('controllerchange', check);
  };
  const check = (): void => {
    if (!live || gameWorkerBootBlocked()) return;
    dispose();
    publish('ready');
  };
  const fail = (): void => {
    if (!live) return;
    check();
    if (!live) return;
    clearTimeout(timeout);
    publish('error');
  };
  const timeout = setTimeout(fail, GAME_WORKER_WAIT_MS);
  worker.addEventListener('controllerchange', check);
  publish('waiting');
  void registerServiceWorker(retry).then((registered) => { if (!registered) fail(); });
  check();
  return dispose;
}
