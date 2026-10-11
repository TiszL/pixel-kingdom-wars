/**
 * Build identity — what this running server actually is.
 *
 * Three different numbers, deliberately not one:
 *
 *  - `version`  the release the humans talk about (root package.json, git tag).
 *               Changes every release, means nothing to the code.
 *  - `gitSha`   the exact commit. The only thing worth having when something is
 *               wrong in production at 3am.
 *  - `simVersion` the REPLAY PROTOCOL (see packages/sim/src/version.ts). This is
 *               the one with teeth: a client whose simulator disagrees with the
 *               server's renders battles that did not happen, so a mismatch is a
 *               hard stop, not a warning.
 *
 * version/gitSha/builtAt are stamped by the image build (Docker build args →
 * env). They fall back to dev markers so a local `pnpm dev:api` never crashes on
 * a missing env, but they are never *guessed* — an unstamped build says so.
 */
import { SIM_VERSION } from '@shardkeep/sim';

export interface BuildInfo {
  version: string;
  gitSha: string;
  builtAt: string | null;
  simVersion: number;
}

/** Docker turns an unset `ARG X` into an EMPTY env var, not an absent one, so
 *  `?? fallback` never fires and /version reports `builtAt: ""` — a value that
 *  is not a timestamp and not honestly absent either. Treat blank as unset. */
const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? undefined : v;
};

export const BUILD: BuildInfo = {
  version: env('APP_VERSION') ?? '0.0.0-dev',
  gitSha: env('GIT_SHA') ?? 'dev',
  builtAt: env('BUILD_TIME') ?? null,
  simVersion: SIM_VERSION,
};

/** Header the web client stamps on every request (apps/web/src/lib/api.ts). */
export const SIM_VERSION_HEADER = 'x-sim-version';

/**
 * Is this request from a client whose simulator disagrees with ours?
 *
 * Enforced only when the header is PRESENT. That is not a loophole — the server
 * is authoritative and re-simulates everything, so a client cannot gain anything
 * by omitting it. The check exists to stop an HONEST stale client (a phone
 * holding a cached bundle from before a deploy) from watching a fabricated
 * battle. Omitting the header buys a liar nothing and costs an honest client the
 * protection, which is the right trade.
 */
export function isOutdatedClient(headerValue: string | undefined): boolean {
  if (headerValue === undefined) return false;
  const n = Number(headerValue);
  return !Number.isInteger(n) || n !== SIM_VERSION;
}
