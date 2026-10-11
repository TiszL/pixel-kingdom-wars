/**
 * Elite-troop item gating (owner 2026-08-16, D-058): dragon, direwyvern,
 * gloamfang, hexbarrow and mage may only be TRAINED/RESEARCHED by wallets
 * holding a `troop_unlocks` row. Rows come from three writers:
 *
 *  1. USE of the matching TRAINING WRIT (items.ts, source 'item') — the mage
 *     writ is shop-purchasable for 5,000 KEEP; the other four are Gold-Forge
 *     drops (FORGE_DROPS). All five writs are market-tradeable until used.
 *  2. The one-shot worker-boot GRANDFATHER backfill below (source
 *     'grandfather'): every wallet that could train the troop under the
 *     retired Keep-level rules at rollout keeps the ability permanently.
 *  3. A lazy self-heal (source 'lazy_grandfather') inside the train/research
 *     gate: a wallet whose OWN book fields the troop (wallet-scoped
 *     army/queue/research rows only — see fieldsTroopInWalletBook for why the
 *     transferable base_* twins are excluded) is granted the row instead of
 *     being refused — existing legacy armies must NEVER become untrainable,
 *     and this path also covers environments where workers (and therefore the
 *     boot sweep) are disabled (the R9 lesson: player-owed state must not
 *     depend on ENABLE_WORKERS).
 *
 * WALLET-scoped by design: training knowledge is account knowledge. Items
 * follow the deed (D-035 custody law), but the consumed unlock does not — a
 * base sale must never strip the seller's army of trainability.
 */
import { ELITE_TROOP_UNLOCKS, ITEMS, isEliteTroop, type EliteTroop, type ItemSpec } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { troopUnlocks } from '../db/schema';
import { HttpError } from '../lib/errors';

/** The wallet's unlocked elite troops (for the /army read model). */
export async function eliteUnlocksOf(db: DbOrTx, wallet: string): Promise<Record<EliteTroop, boolean>> {
  const rows = await db.select({ troop: troopUnlocks.troop }).from(troopUnlocks)
    .where(eq(troopUnlocks.playerWallet, wallet));
  const owned = new Set(rows.map((r) => String(r.troop)));
  return Object.fromEntries(
    (Object.keys(ELITE_TROOP_UNLOCKS.itemByTroop) as EliteTroop[])
      .map((troop) => [troop, owned.has(troop)]),
  ) as Record<EliteTroop, boolean>;
}

/** Grant one unlock. Idempotent; used by the writ USE path and the tests. */
export async function grantTroopUnlock(
  db: DbOrTx, wallet: string, troop: EliteTroop, source: 'item' | 'grandfather' | 'lazy_grandfather',
): Promise<{ granted: boolean }> {
  const inserted = await db.insert(troopUnlocks)
    .values({ playerWallet: wallet, troop, source })
    .onConflictDoNothing()
    .returning({ troop: troopUnlocks.troop });
  return { granted: inserted.length > 0 };
}

export async function hasTroopUnlock(db: DbOrTx, wallet: string, troop: EliteTroop): Promise<boolean> {
  const [row] = await db.select({ troop: troopUnlocks.troop }).from(troopUnlocks)
    .where(and(eq(troopUnlocks.playerWallet, wallet), eq(troopUnlocks.troop, troop)))
    .limit(1);
  return row !== undefined;
}

/** Does the wallet's OWN book field this troop: camp roster, training queue,
 * or a research row that ever progressed? This is the lazy-grandfather
 * predicate, and it deliberately reads WALLET-scoped tables ONLY — never the
 * base_* twins. Deed-scoped rows follow the base on every transfer/sale, so a
 * predicate keyed on current base ownership would let one parked dragon plus
 * one deed mint a permanent unlock for every wallet it is shuttled through
 * (security review 2026-08-16 finding 1), draining the very writ market this
 * change creates. Deed-scoped armies at ROLLOUT are covered instead by the
 * one-shot, marker-protected boot backfill below — evaluated once, before any
 * post-rollout transfer can be staged. A post-rollout base buyer keeps the
 * fielded army itself (deploys are roster-based, ungated); only training MORE
 * of the troop needs the writ, which is the owner's model. */
async function fieldsTroopInWalletBook(db: DbOrTx, wallet: string, troop: EliteTroop): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 WHERE EXISTS (
      SELECT 1 FROM army a WHERE a.player_wallet = ${wallet} AND a.troop = ${troop} AND a.count > 0
    ) OR EXISTS (
      SELECT 1 FROM training_queue q WHERE q.player_wallet = ${wallet} AND q.troop = ${troop}
    ) OR EXISTS (
      SELECT 1 FROM troop_research r WHERE r.player_wallet = ${wallet} AND r.troop = ${troop}
        AND (r.level > 1 OR r.researching_to_level IS NOT NULL)
    )
  `) as unknown as Array<unknown>;
  return rows.length > 0;
}

/**
 * The train/research gate. Non-elite troops pass untouched. An elite troop
 * needs an unlock row; a wallet that already fields the troop is self-healed
 * (see module header) rather than refused. The refusal names the exact unlock
 * path so the client can render it verbatim.
 */
export async function assertEliteTroopUnlocked(
  db: DbOrTx, wallet: string, troop: string,
): Promise<void> {
  if (!isEliteTroop(troop)) return;
  if (await hasTroopUnlock(db, wallet, troop)) return;
  if (await fieldsTroopInWalletBook(db, wallet, troop)) {
    await grantTroopUnlock(db, wallet, troop, 'lazy_grandfather');
    return;
  }
  const itemId = ELITE_TROOP_UNLOCKS.itemByTroop[troop];
  const spec = (ITEMS as Record<string, ItemSpec>)[itemId]!;
  const path = spec.acquisition.type === 'shop' || spec.acquisition.type === 'keep_level'
    ? `buy its ${spec.name} for ${spec.costKeep.toLocaleString('en-US')} KEEP (or on the market)`
    : `its ${spec.name} drops from the Gold Forge (or buy one on the market)`;
  throw new HttpError(422, `${troop.toUpperCase()} is locked — ${path}, then USE it`, 'TROOP_ITEM_LOCKED');
}

/**
 * One-shot grandfather backfill, run at worker boot (jobs.ts). Idempotent and
 * self-marking: any existing source='grandfather' row proves a prior complete
 * run, so re-boots skip the scan (re-running would otherwise keep granting the
 * retired Keep-level rule to pre-cutover wallets that level up later). The
 * created_at < cutover filter fixes the population; the keep-gate criterion is
 * evaluated once, at the first post-deploy boot ("can train today").
 */
export async function grandfatherEliteTroopUnlocks(
  db: Db,
): Promise<{ skipped: boolean; inserted: number }> {
  const [already] = await db.select({ troop: troopUnlocks.troop }).from(troopUnlocks)
    .where(eq(troopUnlocks.source, 'grandfather')).limit(1);
  if (already) return { skipped: true, inserted: 0 };

  // ONE transaction for all five troops (security review 2026-08-16 finding
  // 2): the completion marker is "any grandfather row exists", so a partial
  // run that crashed mid-loop would otherwise mark itself complete and
  // silently strand the remaining troops' keep-gate cohorts forever.
  const cutover = ELITE_TROOP_UNLOCKS.grandfather.cutoverIso;
  return db.transaction(async (tx) => {
    let inserted = 0;
    for (const [troop, gate] of Object.entries(ELITE_TROOP_UNLOCKS.grandfather.legacyKeepGates)) {
      // (a) The retired Keep-level rule: wallet-level keep OR any owned deed's
      //     keep meets the retired gate (training reads the selected deed's
      //     keep, so owning one qualifying base = "can train today"). gate 1 =
      //     the troop was never Keep-gated — every pre-cutover wallet
      //     qualifies.
      const byGate = await tx.execute(sql`
        INSERT INTO troop_unlocks (player_wallet, troop, source)
        SELECT p.wallet, ${troop}::troop_type, 'grandfather'
        FROM players p
        WHERE p.created_at < ${cutover}::timestamptz
          AND (
            p.keep_level >= ${gate}
            OR EXISTS (
              SELECT 1 FROM bases b
              WHERE b.owner_wallet = p.wallet AND b.keep_level >= ${gate}
            )
          )
        ON CONFLICT DO NOTHING
        RETURNING player_wallet
      `) as unknown as Array<unknown>;
      inserted += byGate.length;
      // (b) Fielded-troop safety net, independent of created_at: nobody's
      //     existing army may become untrainable, full stop. Deed-scoped rows
      //     are safe HERE (unlike the lazy self-heal) because this runs once,
      //     at rollout, before a post-rollout transfer can be staged.
      const byPresence = await tx.execute(sql`
        INSERT INTO troop_unlocks (player_wallet, troop, source)
        SELECT w.wallet, ${troop}::troop_type, 'grandfather'
        FROM (
          SELECT a.player_wallet AS wallet FROM army a WHERE a.troop = ${troop} AND a.count > 0
          UNION SELECT q.player_wallet FROM training_queue q WHERE q.troop = ${troop}
          UNION SELECT r.player_wallet FROM troop_research r
            WHERE r.troop = ${troop} AND (r.level > 1 OR r.researching_to_level IS NOT NULL)
          UNION SELECT b.owner_wallet FROM base_army ba JOIN bases b ON b.id = ba.base_id
            WHERE ba.troop = ${troop} AND ba.count > 0
          UNION SELECT b.owner_wallet FROM base_training_queue bq JOIN bases b ON b.id = bq.base_id
            WHERE bq.troop = ${troop}
          UNION SELECT b.owner_wallet FROM base_troop_research br JOIN bases b ON b.id = br.base_id
            WHERE br.troop = ${troop} AND (br.level > 1 OR br.researching_to_level IS NOT NULL)
        ) w
        ON CONFLICT DO NOTHING
        RETURNING player_wallet
      `) as unknown as Array<unknown>;
      inserted += byPresence.length;
    }
    return { skipped: false, inserted };
  });
}
