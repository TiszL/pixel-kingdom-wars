/**
 * What THIS bundle is, and how it finds out it has been superseded.
 *
 * The app is a PWA wrapped in a TWA for the dApp Store, which means the shell in
 * the store almost never changes and the game updates by us deploying new web
 * assets. That is the good news (no store review to ship a fix) and the whole
 * problem (a phone can hold a cached bundle indefinitely).
 *
 * Two failure modes, deliberately treated differently:
 *
 *  - SIM MISMATCH — this bundle's simulator disagrees with the server's. The
 *    client simulates the battle the player watches; the server re-simulates it
 *    authoritatively. Disagreement means watching a fight you did not have. HARD
 *    BLOCK: the server already refuses to start a raid (426 OUTDATED_CLIENT) and
 *    we surface an unskippable prompt, rather than let them find out by losing an
 *    army to a battle they never saw.
 *
 *  - EVERYTHING ELSE — new build, same simulator. A bugfix, new art, a UI tweak.
 *    Worth telling the player about; not worth interrupting them mid-raid for.
 *
 * SIM_VERSION is imported from the sim package this bundle actually ships, so it
 * cannot drift from the simulator being used. There is no second copy to forget.
 *
 * APP_VERSION was a hand-edited 'v0.9.2' literal here. It is now derived from the
 * build so it cannot silently disagree with what was actually deployed.
 */
import { SIM_VERSION } from '@shardkeep/sim';
import { API_URL } from './api';
import { waitForCaller } from './callerCancellation';

declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __BUILD_TIME__: string | null;

export const BUILD = {
  version: __APP_VERSION__,
  gitSha: __GIT_SHA__,
  builtAt: __BUILD_TIME__,
  simVersion: SIM_VERSION,
} as const;

/** Display string for the loading screen + ABOUT. Keeps the historical `v` prefix. */
export const APP_VERSION = `v${BUILD.version}`;

/** The one player-facing version line, identical on the web loading screen, the
 * ABOUT pane and the native boot screen (D-192: one product version, one label). */
export const APP_VERSION_LABEL = `PIXEL KINGDOM WARS ${APP_VERSION}`;

/** Mutable public artifacts are cache-first in the PWA. Bind every request to
 * this bundle's immutable build identity so an older controlling service worker
 * cannot answer a new page with pre-release brand or generated-art bytes. */
export function versionedPublicAsset(path: `/${string}`): string {
  return `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(BUILD.gitSha)}`;
}

export interface ServerVersion {
  version: string;
  gitSha: string;
  builtAt: string | null;
  simVersion: number;
}

export type UpdateState =
  /** Server agrees with us. */
  | { kind: 'current' }
  /** New build, same simulator — offer a reload. */
  | { kind: 'soft'; server: ServerVersion }
  /** Simulator disagrees — the player must reload before they can raid. */
  | { kind: 'forced'; server: ServerVersion }
  /** The server's ground revision is newer than this bundle draws: the scene
   *  paints old ground, so reload (raiding stays open — the simulator agrees). */
  | { kind: 'artwork'; groundRevision: number };

/** How often to ask. Cheap unauthenticated GET; the goal is to notice a deploy
 *  within a couple of minutes, not instantly. */
export const UPDATE_POLL_MS = 120_000;
/** Small metadata reads use the same ten-second UI deadline as the active-raid
 * interlock. This bounds discovery, never a battle or payment's lifetime. */
export const VERSION_REQUEST_TIMEOUT_MS = 10_000;

async function fetchVersion<T>(url: string, valid: (value: unknown) => value is T, signal?: AbortSignal): Promise<T | null> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(), VERSION_REQUEST_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    // Include body consumption in the deadline. Waiting also ends if a stale
    // worker ignores abort; its late read has no state to publish or mutate.
    return await waitForCaller((async () => {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) return null;
      const value: unknown = await res.json();
      controller.signal.throwIfAborted();
      return valid(value) ? value : null;
    })(), controller.signal);
  } catch {
    // Offline, or the API is down. That is NOT an update — say nothing and try
    // again later. Treating a failed poll as "out of date" would throw an update
    // wall at every player whose train went through a tunnel.
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function isDeployedWeb(value: unknown): value is DeployedWeb {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DeployedWeb>;
  return typeof candidate.version === 'string' && candidate.version.length > 0
    && typeof candidate.gitSha === 'string' && candidate.gitSha.length > 0
    && (candidate.builtAt === null || typeof candidate.builtAt === 'string');
}

export function fetchServerVersion(signal?: AbortSignal): Promise<ServerVersion | null> {
  return fetchVersion(`${API_URL}/version`, (value): value is ServerVersion => isDeployedWeb(value)
    && 'simVersion' in value && Number.isSafeInteger(value.simVersion) && (value.simVersion as number) > 0, signal);
}

/**
 * `local` is a parameter rather than a closed-over constant so the decision can
 * be tested at every combination. BUILD is frozen into the bundle at build time,
 * which means a test process can never be a "stamped release" — and the soft-
 * update branch is only reachable from one, so it would otherwise be untestable.
 */
/** The build currently DEPLOYED as the web bundle (dist/version.json). */
export interface DeployedWeb { version: string; gitSha: string; builtAt: string | null }

/**
 * Same-origin, so it always describes the bundle the next reload would fetch.
 * null when absent (dev server) or unreachable — both mean "say nothing".
 */
export function fetchDeployedWeb(signal?: AbortSignal): Promise<DeployedWeb | null> {
  return fetchVersion('/version.json', isDeployedWeb, signal);
}

export function compareVersions(
  server: ServerVersion | null,
  deployedWeb: DeployedWeb | null,
  local: { gitSha: string; simVersion: number } = BUILD,
): UpdateState {
  // FORCED is judged against the API: replay correctness is a client-vs-server
  // contract, checked first and in EITHER direction — a client somehow AHEAD of
  // the server (an API rollback) desyncs exactly as badly as one behind it, and
  // this must never be downgraded to the dismissible branch below.
  if (server && server.simVersion !== local.simVersion) return { kind: 'forced', server };
  // SOFT is judged against the DEPLOYED WEB BUILD, never the API. Comparing web
  // shas to the API sha made the banner permanent: web assets legitimately ship
  // far more often than the API (that is the whole TWA update model), so the two
  // almost always differ — and RELOAD could never clear it, because the freshly
  // loaded bundle still disagreed with the API. Against version.json the banner
  // means exactly one thing: a reload would fetch a newer bundle than this one.
  if (deployedWeb && deployedWeb.gitSha !== local.gitSha
    && local.gitSha !== 'dev' && deployedWeb.gitSha !== 'dev') {
    return { kind: 'soft', server: server ?? { ...deployedWeb, simVersion: local.simVersion } };
  }
  return { kind: 'current' };
}

/**
 * Drop every build/shell cache and re-fetch the app.
 *
 * `location.reload()` alone is NOT enough under a service worker: the SW serves
 * the old precache and the reload lands straight back on the stale bundle — the
 * exact loop this whole mechanism exists to prevent. Unregister and bin the
 * caches first so the next load has to come from the network. Deliberately
 * blunt for the web shell, but deliberately preserves two cross-build stores:
 * `pkw-asset-pack-v1` avoids a complete 200+ MB redownload, and
 * `pkw-push-session-v1` is the durable logout/OFF privacy fence. Removing the
 * latter can expose an old wallet's push after an offline endpoint retirement.
 */
export async function reloadToLatest(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => (
        k !== 'pkw-asset-pack-v1' && k !== 'pkw-push-session-v1'
      )).map((k) => caches.delete(k)));
    }
  } catch {
    // Even if clearing fails, still reload — a plain reload fixes the
    // no-service-worker case, which is every desktop browser session.
  }
  location.reload();
}
