/**
 * First-run tutorial progress (M23 a6, owner 2026-08-15: "step-by-step,
 * replayable in-game tutorial explaining each core system").
 *
 * SERVER-AUTHORITATIVE ON PURPOSE: the client renders coach marks, it never
 * decides where the player is. `step` is the index into the shared
 * TUTORIAL_STEPS.ids order, and the only legal transition is current+1 —
 * a client (or a replayed request) posting a step ≤ current gets the current
 * state back idempotently, and a step more than one ahead is refused. That
 * makes double-taps, offline retries and a second device all converge on the
 * same row instead of racing it.
 *
 * REPLAYABLE is a route, not a hack: reset() returns the row to step 0 with
 * `completedAt` cleared, and the whole advance chain runs again — the settings
 * screen's REPLAY chip is this contract's caller.
 *
 * skip() exists so SKIP TUTORIAL is one request that completes directly rather
 * than a client-side loop of N advances (which would race its own responses).
 * `completedAt` keeps the FIRST completion time across replays (coalesce), so
 * "when did this player finish onboarding" stays a stable analytics fact.
 *
 * GUIDANCE IS A SECOND, LONGER-LIVED SWITCH (owner 2026-08-29). The deck is
 * three cards; the guided chain that follows it runs for the player's whole
 * first session, so "skip" has to mean something after `completedAt` is already
 * stamped. skipGuidance()/resumeGuidance() own that bit — see the column note in
 * db/schema.ts for why it is not folded into completedAt.
 */
import { TUTORIAL_STEPS } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { tutorialProgress } from '../db/schema';
import { HttpError } from '../lib/errors';

export interface TutorialStateDto {
  step: number;
  completedAt: string | null;
  /** True while the player has switched the GUIDED first-run flow off. */
  guideSkipped: boolean;
}

/** Index of the terminal 'done' marker; advancing onto it stamps completion. */
const FINAL_STEP = TUTORIAL_STEPS.count - 1;

/** The three columns every answer on this route is built from. */
const COLS = {
  step: tutorialProgress.step,
  completedAt: tutorialProgress.completedAt,
  guideSkippedAt: tutorialProgress.guideSkippedAt,
} as const;

type Row = { step: number; completedAt: Date | null; guideSkippedAt: Date | null };

function toDto(row: Row | undefined): TutorialStateDto {
  return {
    step: row?.step ?? 0,
    completedAt: row?.completedAt?.toISOString() ?? null,
    // A BOOLEAN on the wire, not the timestamp: the client's only question is
    // "am I being guided", and shipping the instant invites it to be rendered.
    guideSkipped: row?.guideSkippedAt != null,
  };
}

/** Current progress. A wallet with no row simply has not started: step 0. */
export async function getTutorial(db: DbOrTx, wallet: string): Promise<TutorialStateDto> {
  const [row] = await db.select(COLS).from(tutorialProgress)
    .where(eq(tutorialProgress.playerWallet, wallet));
  return toDto(row);
}

/**
 * Advance to exactly `step` (must be current+1). The monotonic guard is ONE
 * conditional UPDATE (`WHERE step = step - 1`), so two concurrent advances can
 * never both win — the loser falls through to the idempotent-replay read.
 */
export async function advanceTutorial(
  db: DbOrTx, wallet: string, step: number,
): Promise<TutorialStateDto> {
  await db.insert(tutorialProgress).values({ playerWallet: wallet }).onConflictDoNothing();
  const [advanced] = await db.update(tutorialProgress)
    .set({
      step,
      updatedAt: new Date(),
      ...(step === FINAL_STEP
        ? { completedAt: sql`coalesce(${tutorialProgress.completedAt}, now())` }
        : {}),
    })
    .where(and(eq(tutorialProgress.playerWallet, wallet), eq(tutorialProgress.step, step - 1)))
    .returning(COLS);
  if (advanced) return toDto(advanced);

  const current = await getTutorial(db, wallet);
  // Idempotent replay: a retried/duplicated advance of a step already taken
  // answers with the truth instead of an error, so flaky networks cannot wedge
  // the overlay.
  if (step <= current.step) return current;
  throw new HttpError(
    409,
    `Tutorial advances one step at a time (you are at ${current.step}, asked for ${step})`,
    'TUTORIAL_STEP_OUT_OF_ORDER',
  );
}

/** SKIP TUTORIAL: complete directly in one request. Keeps the first
 *  completion time if one exists (a replay that gets skipped). */
export async function skipTutorial(db: DbOrTx, wallet: string): Promise<TutorialStateDto> {
  const now = new Date();
  const [row] = await db.insert(tutorialProgress)
    .values({ playerWallet: wallet, step: FINAL_STEP, completedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: tutorialProgress.playerWallet,
      set: {
        step: FINAL_STEP,
        completedAt: sql`coalesce(${tutorialProgress.completedAt}, now())`,
        updatedAt: now,
      },
    })
    .returning(COLS);
  return toDto(row);
}

/**
 * SKIP THE GUIDED FLOW (owner 2026-08-29). One request that ends the hand-
 * holding wherever the player is standing: the card deck stops AND the coach
 * marks stop, because from the player's chair those are one thing — "the
 * tutorial" — and a SKIP that silenced only half of it would be a bug report.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH: the onboarding quest rows. They stay on
 * the board with their progress and their rewards, exactly as a daily does. The
 * player asked to stop being led, not to forfeit five payouts.
 *
 * Idempotent, and it keeps the FIRST timestamp of each fact (coalesce), so a
 * double-tap or an offline retry converges on one row.
 */
export async function skipGuidance(db: DbOrTx, wallet: string): Promise<TutorialStateDto> {
  const now = new Date();
  const [row] = await db.insert(tutorialProgress)
    .values({ playerWallet: wallet, step: FINAL_STEP, completedAt: now, guideSkippedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: tutorialProgress.playerWallet,
      set: {
        step: FINAL_STEP,
        completedAt: sql`coalesce(${tutorialProgress.completedAt}, now())`,
        guideSkippedAt: sql`coalesce(${tutorialProgress.guideSkippedAt}, now())`,
        updatedAt: now,
      },
    })
    .returning(COLS);
  return toDto(row);
}

/**
 * TURN GUIDANCE BACK ON — the undo for a mis-tapped SKIP (settings).
 *
 * It clears `guideSkippedAt` and NOTHING else: the card deck stays finished, so
 * resuming drops the player back onto the chain step they are actually on rather
 * than replaying three cards they have already read. REPLAY TUTORIAL is still
 * the control that rewinds the deck.
 */
export async function resumeGuidance(db: DbOrTx, wallet: string): Promise<TutorialStateDto> {
  const [row] = await db.insert(tutorialProgress)
    .values({ playerWallet: wallet })
    .onConflictDoUpdate({
      target: tutorialProgress.playerWallet,
      set: { guideSkippedAt: null, updatedAt: new Date() },
    })
    .returning(COLS);
  return toDto(row);
}

/** REPLAY: back to step 0 with completion cleared — the full run plays again.
 *  It also un-skips guidance: replaying a tutorial you switched off and getting
 *  no tutorial is the one outcome this button cannot produce. */
export async function resetTutorial(db: DbOrTx, wallet: string): Promise<TutorialStateDto> {
  const [row] = await db.insert(tutorialProgress)
    .values({ playerWallet: wallet })
    .onConflictDoUpdate({
      target: tutorialProgress.playerWallet,
      set: { step: 0, completedAt: null, guideSkippedAt: null, updatedAt: new Date() },
    })
    .returning(COLS);
  return toDto(row);
}
