/**
 * ONE `/tester/me` read, shared by the FOUNDING KINGDOMS HUD chip, the TESTER
 * screen and the Profile referral counts (D-103).
 *
 * WHY A MODULE STORE AND NOT THREE useFetch() CALLS. The server runs a bounded
 * recompute on every authed `/tester/me` (one per wallet per
 * TESTER_PROGRAM.recomputeMinIntervalMs) and returns `justEarned` — the points
 * that landed in THAT call — exactly once. Three independent readers would
 * (a) triple the traffic on the persistent HUD and (b) race for the one-shot
 * `justEarned`, so a toast could fire from the chip's read and never be seen
 * on the screen, or vice versa. Here the read is deduplicated and cached for
 * the same interval the server gates on, and the toast is emitted from the
 * single place a fresh result arrives, so it fires exactly once per award.
 *
 * Everything in `data` is server truth (derived from ledgers, never a client
 * claim); this module only decides WHEN to ask and WHO to tell.
 *
 * First paint: this file is in the eager HUD graph, so it must not import the
 * shared catalog objects (TESTER_PROGRAM / TESTER_DAILY): a single reference
 * would pull the whole milestone table into the entry chunk. The interval is
 * mirrored below and pinned to the constant by foundingKingdoms.test.tsx.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { EVENTS, track } from '../lib/analytics';
import { api, ApiError, type TesterMeDto } from '../lib/api';
import { bus } from '../lib/events';
import { useApp } from '../state/store';

/** = TESTER_PROGRAM.recomputeMinIntervalMs (packages/shared/src/constants.ts).
 *  Re-reading sooner than this cannot return new points, only the same
 *  snapshot, so it is also the floor between two chip reads. */
export const TESTER_ME_MIN_INTERVAL_MS = 60_000;

export interface TesterMeState {
  /** The wallet the snapshot belongs to; a sign-out or wallet swap drops it. */
  wallet: string | null;
  data: TesterMeDto | null;
  error: string | null;
  loading: boolean;
  fetchedAt: number;
}

const EMPTY: TesterMeState = { wallet: null, data: null, error: null, loading: false, fetchedAt: 0 };

let state: TesterMeState = EMPTY;
let inflight: Promise<TesterMeDto | null> | null = null;
const listeners = new Set<() => void>();

function publish(next: TesterMeState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = (): TesterMeState => state;

function errorMessage(cause: unknown): string {
  return cause instanceof ApiError
    ? cause.message : cause instanceof Error ? cause.message : 'failed to load';
}

/** Human line for the "+N TESTER POINTS" toast. `titles` maps every key the
 *  server can name in `justEarned` — milestones AND daily sources/streaks —
 *  to its catalog title; an unknown key falls back to the key itself so a
 *  newer API cut still toasts rather than crashing. */
export function earnedToast(
  earned: ReadonlyArray<{ key: string; points: number }>, titles: ReadonlyMap<string, string>,
): string | null {
  if (earned.length === 0) return null;
  const total = earned.reduce((s, e) => s + e.points, 0);
  const first = titles.get(earned[0]!.key) ?? earned[0]!.key;
  return earned.length === 1
    ? `+${total} TESTER POINTS — ${first.toUpperCase()}`
    : `+${total} TESTER POINTS — ${first.toUpperCase()} +${earned.length - 1} MORE`;
}

/** Every title the toast may need: the milestone catalog first (its keys are
 *  the durable identities), then the daily catalog for keys only it knows
 *  (`played`, `pvp_win`, `streak_7`, …). Where both catalogs share a key
 *  (`mine_collected`, `chat_sent`, …) the milestone title wins — the toast is
 *  a headline, not a ledger line, and either wording names the same action. */
export function earnedTitles(data: TesterMeDto): Map<string, string> {
  const titles = new Map(data.milestones.map((m) => [m.key, m.title]));
  for (const entry of [...(data.daily?.catalog?.sources ?? []), ...(data.daily?.catalog?.streaks ?? [])]) {
    if (!titles.has(entry.key)) titles.set(entry.key, entry.title);
  }
  return titles;
}

function announce(data: TesterMeDto): void {
  // A capped daily source can report a raised-but-unpaid row (the 21st PvP
  // win) with a zero delta; never toast "+0".
  const earned = data.justEarned.filter((e) => e.points > 0);
  if (earned.length === 0) return;
  const msg = earnedToast(earned, earnedTitles(data));
  if (msg) bus.emit('ui:toast', { msg });
  // ANNOUNCED, not earned: the server emits the singular
  // tester_milestone_earned per row at commit; this is the toast aggregate.
  track(EVENTS.TESTER_MILESTONES_ANNOUNCED, {
    count: earned.length,
    points: earned.reduce((s, e) => s + e.points, 0),
  });
}

/**
 * Read `/tester/me` for the signed-in wallet. Returns the cached snapshot when
 * it is younger than the server's recompute gate, joins an in-flight request
 * otherwise, and only then goes to the network. `force` skips the age check
 * (RETRY after an error, or a screen that must show the latest feedback rows)
 * but still joins an in-flight read.
 */
export function readTesterMe(opts: { force?: boolean } = {}): Promise<TesterMeDto | null> {
  const wallet = useApp.getState().wallet;
  if (!wallet) {
    if (state !== EMPTY) publish(EMPTY);
    return Promise.resolve(null);
  }
  const own = state.wallet === wallet;
  if (own && inflight) return inflight;
  if (own && !opts.force && state.data && Date.now() - state.fetchedAt < TESTER_ME_MIN_INTERVAL_MS) {
    return Promise.resolve(state.data);
  }
  publish({ ...(own ? state : EMPTY), wallet, loading: true, error: null });
  const request = api.get<TesterMeDto>('/tester/me')
    .then((data) => {
      // A sign-out or wallet swap while the read was in flight: the result is
      // someone else's progress now, so it must not be shown or toasted.
      if (useApp.getState().wallet !== wallet) return null;
      announce(data);
      publish({ wallet, data, error: null, loading: false, fetchedAt: Date.now() });
      return data;
    }, (cause: unknown) => {
      if (useApp.getState().wallet !== wallet) return null;
      publish({ ...state, wallet, loading: false, error: errorMessage(cause) });
      return null;
    })
    .finally(() => { if (inflight === request) inflight = null; });
  inflight = request;
  return request;
}

/** Subscribe to the shared snapshot and make sure one read is under way for
 *  the current wallet. Mounting many readers costs one request. */
export function useTesterMe(): TesterMeState & { reload: () => void } {
  const wallet = useApp((s) => s.wallet);
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { void readTesterMe(); }, [wallet]);
  const view = current.wallet === wallet ? current : EMPTY;
  return { ...view, reload: () => { void readTesterMe({ force: true }); } };
}

/** Tests only: forget the cached snapshot between cases. */
export function resetTesterMeForTests(): void {
  state = EMPTY;
  inflight = null;
}
