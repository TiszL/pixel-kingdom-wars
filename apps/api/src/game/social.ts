/**
 * Referrals (PLAN.md 4f — GDD §5).
 *
 * STRICTLY ONE LEVEL. A qualified referral changes only the referrer's mining
 * quota while the referee remains active and owns a paid deed. Leagues live in
 * game/leagues.ts; keeping the systems separate prevents referral maintenance
 * from acquiring reward-ledger authority.
 */
import { randomBytes } from 'node:crypto';
import { REFERRALS } from '@shardkeep/shared';
import { ReferralCodeSchema, type ReferralRelationship, type ReferralStatusV1, type ReferralUseV1Response } from '@shardkeep/shared/referrals';
import { and, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { alphaAccess, bases, baseSlots, players, referrals } from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { landTierFilter } from './land';

export {
  leagueForTrophies,
  leagueWeeklyRewards,
  reconcilePendingLeagueRewards,
  runWeeklyLeagueReset,
} from './leagues';

// Referrals
// ---------------------------------------------------------------------------

/** RANDOM, never derived (security review 2026-08-15 F3): codes now gate
 * alpha ADMISSION, and the old FNV-of-wallet derivation let anyone with
 * source knowledge compute any player's code offline from a public wallet
 * address. Determinism bought nothing — the code is stored on first mint.
 * Existing stored codes remain valid; only new mints changed. */
function randomReferralCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(5);
  let code = '';
  for (let i = 0; i < 5; i++) code += alphabet[bytes[i]! % alphabet.length];
  return `KEEP-${code}`;
}

export async function getOrCreateReferralCode(db: Db, wallet: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
        if (!p) throw new HttpError(404, 'player not found');
        if (p.referralCode) return p.referralCode;
        const code = randomReferralCode();
        await tx.update(players).set({ referralCode: code }).where(eq(players.wallet, wallet));
        return code;
      });
    } catch (error) {
      // A uniqueness failure aborts the transaction. Retry outside it, and only
      // for this code constraint; transport/database faults remain uncertain.
      let cause: unknown = error;
      let collision = false;
      for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
        const pg = cause as { code?: string; constraint_name?: string; cause?: unknown };
        if (pg.code === '23505' && pg.constraint_name === 'players_referral_code_unique') collision = true;
        cause = pg.cause;
      }
      if (!collision) throw error;
    }
  }
  throw new HttpError(500, 'could not allocate a referral code');
}

type ReferralRow = typeof referrals.$inferSelect;
const relationship = (row: ReferralRow): ReferralRelationship => ({
  id: row.id, refereeWallet: row.refereeWallet, referrerWallet: row.referrerWallet,
  createdAt: row.createdAt.toISOString(),
});

/** Authenticated wallet scope; this read cannot allocate a code, repair a mirror,
 * qualify a relationship or turn a missing row into negative command proof. */
export async function referralStatusV1(db: Db, wallet: string): Promise<ReferralStatusV1> {
  const [me] = await db.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet));
  if (!me) throw new HttpError(404, 'player not found');
  const [row] = await db.select().from(referrals).where(eq(referrals.refereeWallet, wallet));
  return { version: 1, wallet, relationship: row ? relationship(row) : null };
}

async function bindReferral(db: Db, referee: string, code: string, recover: boolean, now: () => Date) {
  return db.transaction(async (tx) => {
    // Serialize this referee without blocking KEY SHARE on another referral's
    // foreign key. FOR UPDATE deadlocks reciprocal A->B / B->A submissions.
    // This write changes only referredBy; code allocation retains its key lock.
    const [me] = await tx.select().from(players).where(eq(players.wallet, referee)).for('no key update');
    if (!me) throw new HttpError(404, 'player not found');
    const [existing] = await tx.select().from(referrals).where(eq(referrals.refereeWallet, referee));
    const [referrer] = await tx.select().from(players).where(eq(players.referralCode, code));
    // Positive historical proof survives the onboarding window. Another binding
    // is reported honestly; it is not evidence that this submitted code won.
    if (recover && existing) return { row: existing,
      outcome: existing.referrerWallet === referrer?.wallet ? 'already_applied' as const : 'already_bound' as const };
    if (!referrer) throw new HttpError(404, 'unknown referral code', recover ? 'REFERRAL_CODE_UNKNOWN' : undefined);
    if (referrer.wallet === referee) throw new HttpError(422, 'cannot refer yourself', recover ? 'REFERRAL_SELF' : undefined);
    const ageDays = (now().getTime() - me.createdAt.getTime()) / 86_400_000;
    if (ageDays > REFERRALS.useWindowDays) throw new HttpError(422, 'referral window has passed', recover ? 'REFERRAL_WINDOW_CLOSED' : undefined);
    if (existing) throw new HttpError(422, 'already referred');
    const [row] = await tx.insert(referrals)
      .values({ referrerWallet: referrer.wallet, refereeWallet: referee }).returning();
    await tx.update(players).set({ referredBy: referrer.wallet }).where(eq(players.wallet, referee));
    return { row: row!, outcome: 'applied' as const };
  });
}

/** Legacy callers retain their response and duplicate-refusal behavior. */
export async function useReferralCode(db: Db, referee: string, code: string, now?: Date) {
  return (await bindReferral(db, referee, code, false, () => now ?? new Date())).row;
}

export async function useReferralCodeV1(db: Db, wallet: string, input: string, now?: Date): Promise<ReferralUseV1Response> {
  const submittedCode = ReferralCodeSchema.parse(input);
  const result = await bindReferral(db, wallet, submittedCode, true, () => now ?? new Date());
  return { version: 1, wallet, submittedCode, outcome: result.outcome, relationship: relationship(result.row) };
}

/**
 * Quality gate (D-052, owner 2026-08-15): THE REFEREE MINTED THEIR LAND DEED
 * and reached Keep L3 → the referral qualifies. "The deed IS the referral."
 *
 * THE LAND CONDITION IS THE ANTI-SYBIL BRAKE (security review 2026-08-09 F4)
 * and it SURVIVES the v2 redesign: free onboarding hands out signature-cheap
 * wallets, so a referral must cost 0.2 SOL of real money to create before it
 * changes anyone's mining. Under the old 5%-match model that bound protected a
 * payout stream; under v2 it prices each +0.5% quota point. Qualification is
 * sticky (like alpha admission) — ACTIVITY gating happens where the money
 * moves, in activeReferralBonusBps below, never only in this cron.
 */
export async function qualifyReferrals(db: Db, now = new Date()): Promise<number> {
  const candidates = multiBaseEnabled()
    ? await db.selectDistinct({ id: referrals.id }).from(referrals)
      .innerJoin(players, eq(players.wallet, referrals.refereeWallet))
      .innerJoin(baseSlots, and(
        eq(baseSlots.wallet, referrals.refereeWallet), eq(baseSlots.active, true),
      ))
      .innerJoin(bases, and(
        eq(bases.id, baseSlots.baseId), eq(bases.ownerWallet, referrals.refereeWallet),
      ))
      .where(and(
        isNull(referrals.qualifiedAt),
        eq(bases.status, 'active'),
        isNotNull(bases.landPaidAt),
        gte(bases.keepLevel, REFERRALS.qualifyKeepLevel),
      ))
    : await db
      .select({ id: referrals.id })
      .from(referrals)
      .innerJoin(players, eq(players.wallet, referrals.refereeWallet))
      .where(and(
        isNull(referrals.qualifiedAt),
        gte(players.keepLevel, REFERRALS.qualifyKeepLevel),
        landTierFilter(true), // the referee bought their land — see above
      ));
  for (const c of candidates) {
    await db.update(referrals).set({ qualifiedAt: now }).where(eq(referrals.id, c.id));
  }
  return candidates.length;
}

/**
 * The referrer's LIVE mining bonus in bps (D-052): +50 per qualified referral
 * whose player is BOTH recently active (players.last_seen_at within
 * REFERRALS.inactivityLapseDays) AND still the owner of an active paid deed.
 * A sold deed or a player gone quiet contributes nothing until they return —
 * "that land deed stays your referral … if its on market not active player
 * then no reward for it." Computed at every quota computation (the choke
 * point where money moves), so an admin or cron can never leave a stale bonus
 * paying out.
 */
export async function activeReferralBonusBps(
  db: DbOrTx, referrerWallet: string, now = new Date(),
): Promise<number> {
  const activeSince = new Date(now.getTime() - REFERRALS.inactivityLapseDays * 86_400_000);
  const rows = multiBaseEnabled()
    ? await db.selectDistinct({ id: referrals.id }).from(referrals)
      .innerJoin(players, eq(players.wallet, referrals.refereeWallet))
      .innerJoin(baseSlots, and(
        eq(baseSlots.wallet, referrals.refereeWallet), eq(baseSlots.active, true),
      ))
      .innerJoin(bases, and(
        eq(bases.id, baseSlots.baseId), eq(bases.ownerWallet, referrals.refereeWallet),
      ))
      .where(and(
        eq(referrals.referrerWallet, referrerWallet),
        isNotNull(referrals.qualifiedAt),
        gte(players.lastSeenAt, activeSince),
        eq(bases.status, 'active'),
        isNotNull(bases.landPaidAt),
      ))
    : await db.select({ id: referrals.id }).from(referrals)
      .innerJoin(players, eq(players.wallet, referrals.refereeWallet))
      .where(and(
        eq(referrals.referrerWallet, referrerWallet),
        isNotNull(referrals.qualifiedAt),
        gte(players.lastSeenAt, activeSince),
        landTierFilter(true),
      ));
  return rows.length * REFERRALS.miningBonusBpsPerReferral;
}

/**
 * A friend's referral code IS a closed-alpha invite (owner 2026-08-15, M23
 * a16: "seeker users should be able to invite other users to closed alpha
 * even if not seeker owner"). Admission is the sticky insert-once
 * `alpha_access` row (source 'referral'), exactly like invite/seeker
 * admission; the referral RELATIONSHIP is recorded best-effort — an account
 * outside its 14-day window or already referred is still admitted, because
 * standing at the door with a valid friend's code is the product promise.
 *
 * Enumeration posture: one uniform 422 for unknown code and self-referral,
 * behind the same rate limit as invite redemption. Codes are only mintable by
 * wallets that passed the alpha gate themselves (GET /referrals/code sits
 * behind the authenticated gate), so admission cannot be bootstrapped from
 * outside the alpha.
 */
export async function redeemReferralAdmission(
  db: Db, wallet: string, rawCode: string, now = new Date(),
): Promise<void> {
  const code = rawCode.trim().toUpperCase();
  const [referrer] = await db.select().from(players).where(eq(players.referralCode, code));
  if (!referrer || referrer.wallet === wallet) {
    throw new HttpError(422, 'invalid referral code', 'INVALID_REFERRAL_CODE');
  }
  // REVOCATION MUST WIN (security review 2026-08-15 F1, mirroring the invite
  // path's rule): admission revocation is deleting the alpha_access row, and a
  // kicked tester holding any public referral link must not have a ten-second
  // self-service undo. A wallet that HAS a referrals row but NO access row can
  // only be one that was admitted and then revoked (every referral writer sits
  // behind admission), so it is refused with the same uniform 422. Manual
  // re-admission remains an ops insert, exactly as before.
  const [priorReferral] = await db.select({ id: referrals.id }).from(referrals)
    .where(eq(referrals.refereeWallet, wallet));
  if (priorReferral) {
    const [access] = await db.select({ wallet: alphaAccess.wallet }).from(alphaAccess)
      .where(eq(alphaAccess.wallet, wallet));
    if (!access) throw new HttpError(422, 'invalid referral code', 'INVALID_REFERRAL_CODE');
  }
  // One code admits a bounded cohort (security review 2026-08-15 F2): a link
  // posted publicly must not open the whole closed alpha. Counted as the
  // referrer's referral rows that were ADMITTED through this path.
  const admitted = await db.select({ id: referrals.id }).from(referrals)
    .innerJoin(alphaAccess, and(
      eq(alphaAccess.wallet, referrals.refereeWallet),
      eq(alphaAccess.source, 'referral'),
    ))
    .where(eq(referrals.referrerWallet, referrer.wallet));
  if (admitted.length >= REFERRALS.maxAlphaAdmissionsPerReferrer) {
    throw new HttpError(422, 'invalid referral code', 'INVALID_REFERRAL_CODE');
  }
  await db.insert(alphaAccess)
    .values({ wallet, source: 'referral' })
    .onConflictDoNothing();
  try {
    await useReferralCode(db, wallet, code, now);
  } catch {
    // Already referred / window passed — admission stands regardless.
  }
}

// The 5%-match machinery (ownMiningIncome / applyReferralMatch /
// payCollectReferralMatch / payReferralMatch) was REMOVED with D-052
// (owner 2026-08-15): the v2 model pays no matched shards at collect —
// the referral bonus is a quota factor computed by activeReferralBonusBps
// above and applied inside getMiningQuota. referrals.match_ends_at and
// referrals.total_matched_keep remain as historical bookkeeping columns.
