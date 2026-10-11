/** Coherent deed snapshot loader. A base, its SHARDS and its selected identity
 * are one UI value: none may be committed from a stale wallet/deed request. */
import { ApiError, api, baseStatePath } from '../lib/api';
import { bus } from '../lib/events';
import { captureFleetJourneyPublication, publishFleetJourneyReturns, stripFleetJourneyEvents } from '../lib/fleetJourneyPresentation';
import {
  beginBaseSelectionGuard,
  captureBaseSnapshotGuard,
  commitBaseSnapshot, isBaseSnapshotGuardCurrent, useApp,
  type BalancesDto,
  type BaseSnapshotGuard,
  type BaseStateDto,
} from './store';

export class BaseSnapshotMismatchError extends Error {
  constructor() {
    super('Server returned a different base. Refresh ownership and try again.');
    this.name = 'BaseSnapshotMismatchError';
  }
}

let nextRead = 0;
let readScope = '';
const latestCommittedReads = new Map<string | null, number>();

function beginSnapshotRead(guard: BaseSnapshotGuard): { scope: string; request: number } {
  const scope = JSON.stringify([guard.wallet, guard.selectedBaseId, guard.selectionEpoch]);
  if (scope !== readScope) { latestCommittedReads.clear(); readScope = scope; }
  return { scope, request: ++nextRead };
}

/** A receipt's balance refresh shares ordering with full base reads. Capture
 * before the read, so neither an older base read nor a late receipt refresh can
 * replace newer funds. No selected-deed substitution is allowed. */
export function captureBaseBalanceCommit(targetBaseId: string | null): (balances: BalancesDto) => boolean {
  const guard = captureBaseSnapshotGuard();
  if (!guard.wallet || targetBaseId !== guard.selectedBaseId) return () => false;
  const { scope, request } = beginSnapshotRead(guard);
  return (balances) => {
    if (!isBaseSnapshotGuardCurrent(guard) || scope !== readScope
      || request < (latestCommittedReads.get(targetBaseId) ?? 0)) return false;
    latestCommittedReads.set(targetBaseId, request);
    useApp.getState().setBalances(balances);
    return true;
  };
}

/** An explicitly scoped feature refresh joins the same ordering as normal base
 * reads and publishes its verified base/balances together. */
export function captureBaseSnapshotCommit(targetBaseId: string, guard = captureBaseSnapshotGuard(), journeys = false): (base: BaseStateDto, balances: BalancesDto) => boolean {
  if (!guard.wallet || targetBaseId !== guard.selectedBaseId || !isBaseSnapshotGuardCurrent(guard)) return () => false;
  const { scope, request } = beginSnapshotRead(guard);
  const journey = captureFleetJourneyPublication(targetBaseId);
  return (base, balances) => {
    if (!guard.wallet || targetBaseId !== guard.selectedBaseId || base.baseId !== targetBaseId || base.player.wallet !== guard.wallet
      || !isBaseSnapshotGuardCurrent(guard) || scope !== readScope || request < (latestCommittedReads.get(targetBaseId) ?? 0)) return false;
    const clean = stripFleetJourneyEvents(base);
    const committed = commitBaseSnapshot(guard, targetBaseId, clean, balances);
    if (committed) {
      latestCommittedReads.set(targetBaseId, request);
      if (journeys) void publishFleetJourneyReturns((base as BaseStateDto & {fleetJourneyEvents?: unknown}).fleetJourneyEvents, clean, journey,
        () => scope === readScope && latestCommittedReads.get(targetBaseId) === request);
      journey.markWarm();
    }
    return committed;
  };
}

async function readAndCommitBaseSnapshot(
  targetBaseId: string | null,
  guard: BaseSnapshotGuard,
  signal?: AbortSignal,
  deferAuthorityUnavailable = false,
  canCommit: () => boolean = () => true,
  journeys = false,
): Promise<boolean> {
  if (!isBaseSnapshotGuardCurrent(guard)) return false;
  const { scope, request } = beginSnapshotRead(guard);
  const journey = targetBaseId ? captureFleetJourneyPublication(targetBaseId) : null;
  const read = <T,>(path: string): Promise<T> => deferAuthorityUnavailable
    ? api.get<T>(path, { ...(signal ? { signal } : {}), deferAuthorityUnavailable: true,
      isCurrent: () => isBaseSnapshotGuardCurrent(guard) })
    : signal ? api.get<T>(path, { signal }) : api.get<T>(path);
  const [base, balances] = await Promise.all([
    read<BaseStateDto>(baseStatePath(targetBaseId)),
    read<BalancesDto>(targetBaseId
      ? `/balances?baseId=${encodeURIComponent(targetBaseId)}`
      : '/balances'),
  ]);
  // A transport/mock may resolve after abort instead of rejecting. Never let
  // that late response commit an authenticated snapshot from a timed-out try.
  signal?.throwIfAborted();
  if (targetBaseId && base.baseId !== targetBaseId) throw new BaseSnapshotMismatchError();
  // A post-purchase refresh must not be overwritten by an older same-base read.
  if (scope === readScope && request < (latestCommittedReads.get(targetBaseId) ?? 0)) return false;
  if (!canCommit()) return false;
  const clean = stripFleetJourneyEvents(base);
  const committed = commitBaseSnapshot(guard, targetBaseId, clean, balances);
  if (committed) {
    latestCommittedReads.set(targetBaseId, request);
    if (journeys && journey) void publishFleetJourneyReturns((base as BaseStateDto & {fleetJourneyEvents?: unknown}).fleetJourneyEvents, clean, journey,
      () => scope === readScope && latestCommittedReads.get(targetBaseId) === request);
    journey?.markWarm();
  }
  return committed;
}

/** User-driven deed switch. The intent epoch makes the latest requested switch
 * win while the previous complete deed remains visible during the read. */
export function selectBaseSnapshot(targetBaseId: string): Promise<boolean> {
  return readAndCommitBaseSnapshot(targetBaseId, beginBaseSelectionGuard());
}

/** Refresh the deed that was selected at request start. A later switch/logout
 * makes this a harmless no-op instead of installing stale base or SHARDS data. */
export function reloadCurrentBaseSnapshot(): Promise<boolean> {
  const guard = captureBaseSnapshotGuard();
  return readAndCommitBaseSnapshot(guard.selectedBaseId, guard, undefined, false, () => true, true);
}

/** Refresh after a gameplay action, then notify quest and tutorial consumers.
 * Kept beside snapshot loading so controllers do not eagerly import UI sheets. */
export async function reloadBase(options: { background?: boolean } = {}): Promise<void> {
  if (options.background) return reloadBaseInBackground();
  if (await reloadCurrentBaseSnapshot()) bus.emit('base:refresh', undefined);
}

// Recovery timing bounds, not gameplay policy. Never retry the action that
// preceded this read: it may already have charged or rewarded the player.
const BACKGROUND_RETRY_MS = [500, 1_500] as const;
const BACKGROUND_READ_TIMEOUT_MS = 10_000;
const backgroundReads = new Map<string, Promise<void>>();
const backgroundDirty = new Set<string>();

function reloadBaseInBackground(): Promise<void> {
  const guard = captureBaseSnapshotGuard();
  if (!guard.wallet) return Promise.resolve();
  const key = JSON.stringify(guard);
  const existing = backgroundReads.get(key);
  if (existing) {
    // Another completed action may postdate the in-flight snapshot. Coalesce
    // its notification, but always take a trailing read before becoming idle.
    backgroundDirty.add(key);
    return existing;
  }
  const controller = new AbortController();
  const stop = useApp.subscribe(() => {
    if (!isBaseSnapshotGuardCurrent(guard)) controller.abort();
  });
  const current = (): boolean => !controller.signal.aborted && isBaseSnapshotGuardCurrent(guard);
  const pending = (async () => {
    try {
      for (let attempt = 0; current(); attempt += 1) {
        backgroundDirty.delete(key);
        const deadline = setTimeout(() => controller.abort(), BACKGROUND_READ_TIMEOUT_MS);
        try {
          if (await readAndCommitBaseSnapshot(
            guard.selectedBaseId, guard, controller.signal, true, () => !backgroundDirty.has(key), attempt === 0,
          )) {
            bus.emit('base:refresh', undefined);
          }
          if (backgroundDirty.has(key)) { attempt = -1; continue; }
          return;
        } catch (error) {
          // A changed wallet/base is silent. A timeout on the same selection
          // still needs a truthful notice, without turning into a failed action.
          if (!isBaseSnapshotGuardCurrent(guard)) return;
          const delay = BACKGROUND_RETRY_MS[attempt];
          if (!controller.signal.aborted && error instanceof ApiError
            && error.status === 503 && error.code === 'DEED_AUTHORITY_UNAVAILABLE'
            && delay !== undefined) {
            clearTimeout(deadline);
            await new Promise<void>((resolve) => {
              const finish = (): void => {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', finish);
                resolve();
              };
              const timer = setTimeout(finish, delay);
              controller.signal.addEventListener('abort', finish, { once: true });
            });
            continue;
          }
          bus.emit('ui:toast', { msg: 'BASE UPDATE DELAYED — RETURN TO YOUR BASE TO REFRESH' });
          return;
        } finally {
          clearTimeout(deadline);
        }
      }
    } finally {
      stop();
      controller.abort();
      // Release the single-flight entry before this promise settles, so an
      // action queued in the same microtask turn starts its own fresh read.
      backgroundReads.delete(key);
      backgroundDirty.delete(key);
    }
  })();
  backgroundReads.set(key, pending);
  return pending;
}

/** Session hydration after fresh ownership resolution. The caller captures the
 * guard before fetching ownership so a user switch can invalidate the whole
 * older request, not merely its final /base read. */
export function hydrateBaseSnapshot(
  targetBaseId: string | null,
  guard: BaseSnapshotGuard = captureBaseSnapshotGuard(),
  signal?: AbortSignal,
): Promise<boolean> {
  return readAndCommitBaseSnapshot(targetBaseId, guard, signal);
}
