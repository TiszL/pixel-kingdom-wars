/**
 * Warzone shield (owner 2026-07-20, #49) — the ONLY protection usable while a
 * warzone window is open. Normal loss-shields are SUPPRESSED during a warzone
 * (game/warzone.ts); a player can instead PAY for this shield (WARZONE.shieldCost
 * = 10 SOL, 48h) to stay protected. Buyable ONLY while a warzone is active. The SOL
 * payment + on-chain split (50% liquidity / 50% dev-mkt-ops) is wired in money/ —
 * this module holds the grant + the purchase preflight + the "is protected" check
 * that raids/scout/map consult.
 */
import { WARZONE } from '@shardkeep/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { shields } from '../db/schema';
import { HttpError } from '../lib/errors';
import { getGameConfig } from './gameConfig';
import { isWarzoneActive } from './warzone';
import { invalidateShieldMap } from './baseShields';

/** True iff the wallet holds an active WARZONE-source shield right now. */
export async function hasActiveWarzoneShield(
  db: DbOrTx, wallet: string, now: Date, baseId?: string,
): Promise<boolean> {
  const rows = await db.select({ id: shields.id }).from(shields)
    .where(and(
      baseId ? eq(shields.baseId, baseId) : eq(shields.playerWallet, wallet),
      eq(shields.source, 'warzone'), gt(shields.expiresAt, now),
    ))
    .limit(1);
  return rows.length > 0;
}

/** Preflight (run when the SOL intent mints): a warzone shield is buyable ONLY
 *  while a warzone is active, and NOT if the player already holds one (no stacking)
 *  — so a player is never charged for a shield that can't apply. */
export async function assertWarzoneShieldPurchasable(
  db: Db, wallet: string, now = new Date(), baseId?: string,
): Promise<void> {
  const cfg = await getGameConfig(db);
  if (!isWarzoneActive(cfg, now)) throw new HttpError(422, 'warzone shields are only sold during an active warzone');
  if (await hasActiveWarzoneShield(db, wallet, now, baseId)) throw new HttpError(422, 'you already have an active warzone shield');
}

/** Mint a 48h warzone shield — called from creditDeposit once the SOL payment is
 *  verified at finalized. The deposit row is the idempotency anchor (granted once).
 *
 *  ACCEPTED RACE (E5/Q4, owner decision 2026-07-26): the item-USE path
 *  (items.ts) and the SOL-credit path (deposits.ts) both check-then-insert with
 *  no unique constraint, so a player running both concurrently can land TWO
 *  live warzone-shield rows (reviewer reproduced it). Accepted rather than
 *  locked because the harm is fully bounded: both rows expire together, the
 *  duplicate grants no extra protection (isShielded is existence-checked, not
 *  counted), and no house money moves — the player merely wasted their own
 *  second payment/relic on nothing, which the preflights already make hard to
 *  do by accident. Locking would mean FOR UPDATE on the hot player row inside
 *  two money paths — a deadlock surface — to prevent an outcome that costs the
 *  house nothing. If shields ever STACK duration or COUNT rows, this stops
 *  being safe: add a partial unique index on (player_wallet) WHERE source =
 *  'warzone' AND active, and revisit. */
export async function grantWarzoneShield(
  tx: DbOrTx, wallet: string, now = new Date(), baseId?: string,
  opts: { deferMapInvalidation?: boolean } = {},
): Promise<{ expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + WARZONE.shieldDurationHours * 3600 * 1000);
  await tx.insert(shields).values({
    playerWallet: wallet, source: 'warzone', expiresAt, ...(baseId ? { baseId } : {}),
  });
  if (!opts.deferMapInvalidation) await invalidateShieldMap(tx, wallet, baseId);
  return { expiresAt };
}
