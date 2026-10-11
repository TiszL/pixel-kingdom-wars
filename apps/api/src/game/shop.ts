/**
 * Shop: shield extension + balances/exchange info (PLAN.md 4g).
 *
 * Shield (GDD §3.3 + ECONOMY.md §4a, ✅ LOCKED v3): +extendHours on an ACTIVE
 * shield, total capped at maxHours from now. Shields are SOL-only, and SOL is
 * pay-per-action on-chain (v3, owner 2026-07-19): the player pays
 * SHIELD.extendCostSolLamports via shardkeep-core buy_sink (kind=shield) and the
 * extension is granted once the payment is verified at `finalized`
 * (money/deposits.ts creditDeposit → grantShieldExtension). There is no prepaid
 * SOL-credit balance anymore — `assertShieldExtendable` gates the intent so we
 * never take payment when there is nothing to extend.
 *
 * Exchange (Addendum B4): pre-TGE, Shards and KEEP are the SAME ledger unit
 * at the locked 1:1 rate — the play balance is denominated in Shards until
 * TGE makes withdrawable KEEP distinct. The endpoint reports balances and the
 * rate; there is nothing to convert custodially. Documented decision (PLAN).
 */
import { ECONOMY, GEMS, SHIELD, fmtDur } from '@shardkeep/shared';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { shields } from '../db/schema';
import { getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../ledger/accounts';
import { gemsEnabled } from '../config';
import { HttpError } from '../lib/errors';
import {
  assertBaseShieldExtendable, grantBaseShieldExtension, invalidateShieldMap,
} from './baseShields';

const ORDINARY_SHIELD_SOURCES: Array<'loss' | 'purchase'> = ['loss', 'purchase'];

/** Throws 422 unless the wallet has an active shield below the maxHours ceiling.
 *  Preflight run when the shield-extend deposit intent is minted, so a player is
 *  never charged on-chain for an extension that can't apply. */
export async function assertShieldExtendable(
  db: Db, wallet: string, now = new Date(), baseId?: string,
): Promise<void> {
  if (baseId) return assertBaseShieldExtendable(db, wallet, baseId, now);
  const [active] = await db.select().from(shields)
    .where(and(
      eq(shields.playerWallet, wallet),
      gt(shields.expiresAt, now),
      inArray(shields.source, ORDINARY_SHIELD_SOURCES),
    ))
    .orderBy(desc(shields.expiresAt))
    .limit(1);
  if (!active) throw new HttpError(422, 'no active shield to extend');
  const maxPurchaseRemaining = now.getTime()
    + SHIELD.extendPurchaseMaxRemainingHours * 3600 * 1000;
  if (active.expiresAt.getTime() > maxPurchaseRemaining) {
    throw new HttpError(
      422,
      `shield may be extended only at ${fmtDur(SHIELD.extendPurchaseMaxRemainingHours * 3_600)} remaining or less`,
    );
  }
}

/**
 * Grant a shield extension — called from creditDeposit once the on-chain SOL
 * payment is verified at finalized. EXTENDS an already-active shield by
 * extendHours, capped at maxHours.
 *
 * If NO shield is active at grant time it is a no-op — it must NOT mint a fresh
 * shield. Minting one would let a player who holds a loss-shield pay for an
 * extension, then ATTACK (which breaks their own shield, GDD §3.3), and still
 * receive a fresh 12h shield when the payment finalizes — bypassing "attacking
 * breaks your shield / shields are earned on a loss, only extended while active"
 * (security review 2026-07-19 #1). The intent preflight (assertShieldExtendable)
 * already requires an active shield, so the only way to reach the no-op branch
 * is to lapse the shield after paying — a self-inflicted edge, not a robbery.
 * The deposit row is the idempotency anchor (credited exactly once).
 */
export async function grantShieldExtension(
  tx: DbOrTx, wallet: string, now = new Date(), baseId?: string,
  opts: { deferMapInvalidation?: boolean } = {},
): Promise<{ expiresAt: Date | null; granted: boolean }> {
  if (baseId) {
    const result = await grantBaseShieldExtension(tx, wallet, baseId, now, opts);
    return { expiresAt: result.expiresAt, granted: result.granted };
  }
  const [active] = await tx.select().from(shields)
    .where(and(
      eq(shields.playerWallet, wallet),
      gt(shields.expiresAt, now),
      inArray(shields.source, ORDINARY_SHIELD_SOURCES),
    ))
    .orderBy(desc(shields.expiresAt))
    .limit(1);
  if (!active) return { expiresAt: null, granted: false };
  if (active.expiresAt.getTime() - now.getTime()
    > SHIELD.extendPurchaseMaxRemainingHours * 3600 * 1000) {
    return { expiresAt: active.expiresAt, granted: false };
  }
  const maxExpiry = now.getTime() + SHIELD.maxHours * 3600 * 1000;
  const proposed = active.expiresAt.getTime() + SHIELD.extendHours * 3600 * 1000;
  const newExpiry = new Date(Math.min(proposed, maxExpiry));
  const [updated] = await tx.update(shields).set({ expiresAt: newExpiry })
    .where(and(
      eq(shields.id, active.id),
      eq(shields.expiresAt, active.expiresAt),
      gt(shields.expiresAt, now),
      inArray(shields.source, ORDINARY_SHIELD_SOURCES),
    ))
    .returning({ expiresAt: shields.expiresAt });
  // A delayed credit may lose a race with shield break/expiry/another credit.
  // It is safer to grant nothing than to recreate or overwrite stale protection.
  if (!updated) {
    const [current] = await tx.select({ expiresAt: shields.expiresAt }).from(shields)
      .where(and(
        eq(shields.playerWallet, wallet),
        gt(shields.expiresAt, now),
        inArray(shields.source, ORDINARY_SHIELD_SOURCES),
      ))
      .orderBy(desc(shields.expiresAt)).limit(1);
    return { expiresAt: current?.expiresAt ?? null, granted: false };
  }
  if (!opts.deferMapInvalidation) await invalidateShieldMap(tx, wallet);
  return { expiresAt: updated.expiresAt, granted: true };
}

export async function getBalances(db: Db, wallet: string, baseId?: string) {
  // DUAL-CURRENCY SPLIT (owner 2026-07-24): `shards` is now the REAL soft
  // balance (mined, spent on builds/troops); `keep` is the hard token balance
  // (forge payouts, quests, raid loot — deposits/withdrawals move it on-chain).
  const keep = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  const shards = baseId
    ? await getOrCreateBaseAccount(db, baseId, 'base_shards')
    : await getOrCreatePlayerAccount(db, wallet, 'player_shards');
  // D-152: `gems` (whole Gems) and its LOCKED rates appear only while Gems are
  // on, so a flag-off response is byte-identical to today's (invariant G-7).
  // `keep` stays custodial KEEP — truthful for withdrawals.
  const gems = gemsEnabled() ? await getOrCreatePlayerAccount(db, wallet, 'player_gems') : null;
  return {
    shards: shards.balance.toString(),
    keep: keep.balance.toString(),
    keepRate: ECONOMY.shardsPerKeep,
    withdrawFeeBps: ECONOMY.withdrawFeeBps,
    unbondingHours: ECONOMY.unbondingHours,
    ...(gems ? {
      gems: gems.balance.toString(),
      gemsRate: { gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem },
    } : {}),
  };
}
