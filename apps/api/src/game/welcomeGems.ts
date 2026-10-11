/** K-148: a welcome promise survives budget exhaustion without issuing a second
 * currency. Called only under ensureStartingBase's wallet row lock, after game
 * admission; authentication alone is deliberately not a reward boundary. */
import { PLAYTEST } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import { devnetWelcomeGemsEnabled } from '../config';
import type { DbOrTx } from '../db/client';
import { ledgerTransactions, mailMessages, welcomeGemsObligations } from '../db/schema';
import { grantGems, grantKey } from './gemsGrants';

export interface WelcomeGemsStatus { gems: bigint; granted: boolean }

/** Mail is retained when claimed/expired/deleted. Any historical welcome or
 * direct grant excludes a second welcome, including B4's KEEP fallback. */
export async function hasWelcomeHistory(db: DbOrTx, wallet: string): Promise<boolean> {
  const [mail] = await db.select({ id: mailMessages.id }).from(mailMessages).where(and(
    eq(mailMessages.recipientWallet, wallet), eq(mailMessages.dedupeKey, `welcome:${wallet}`),
  )).limit(1);
  if (mail) return true;
  const [grant] = await db.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, grantKey('welcome', wallet))).limit(1);
  return Boolean(grant);
}

/** This snapshot is taken BEFORE inserting the new Keep/terrain. Stable second
 * bases and bases acquired then sold must not make an old wallet look new. */
export async function firstWalletBaseSetup(db: DbOrTx, wallet: string): Promise<boolean> {
  const [row] = await db.execute(sql<{ initialized: boolean }>`SELECT
    EXISTS(SELECT 1 FROM buildings b LEFT JOIN bases s ON s.id = b.base_id
      WHERE b.player_wallet = ${wallet} OR s.owner_wallet = ${wallet})
    OR EXISTS(SELECT 1 FROM obstacles WHERE player_wallet = ${wallet})
    OR EXISTS(SELECT 1 FROM base_transfers WHERE from_wallet = ${wallet} OR to_wallet = ${wallet})
    OR EXISTS(SELECT 1 FROM ledger_transactions WHERE idempotency_key = ${`starter:${wallet}`})
    AS initialized`);
  return row?.initialized === false;
}

/** Accept only the original eligible setup. Mail delivery and reward-budget
 * availability cannot decide whether this wallet owns the frozen promise. */
export async function acceptWelcomeGems(db: DbOrTx, wallet: string, firstSetup: boolean): Promise<void> {
  if (!firstSetup || (process.env['SOLANA_CLUSTER'] ?? 'devnet') !== 'devnet' || !devnetWelcomeGemsEnabled()) return;
  if (await hasWelcomeHistory(db, wallet)) return;
  await db.insert(welcomeGemsObligations).values({ wallet, gems: BigInt(PLAYTEST.welcomeGems) }).onConflictDoNothing();
}

/** An accepted promise is independent of later feature-flag pauses. Its amount
 * comes from durable evidence, never today's tuning. A savepoint isolates every
 * grant/bootstrap failure from the base and the accepted obligation. */
export async function retryWelcomeGems(db: DbOrTx, wallet: string): Promise<WelcomeGemsStatus | null> {
  const [obligation] = await db.select().from(welcomeGemsObligations).where(eq(welcomeGemsObligations.wallet, wallet));
  if (!obligation) return null;
  try {
    await db.transaction(async (tx) => {
      await grantGems(tx, { wallet, gems: obligation.gems, reason: 'welcome',
        metadata: { welcomeAcceptedAt: obligation.acceptedAt.toISOString() } });
    });
    return { gems: obligation.gems, granted: true };
  } catch (error) {
    console.warn(`[welcome-gems] pending for ${wallet}: ${error instanceof Error ? error.message : String(error)}`);
    return { gems: obligation.gems, granted: false };
  }
}
