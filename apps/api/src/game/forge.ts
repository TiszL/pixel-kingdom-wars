/**
 * Gold Forge engine (owner rules 2026-07-24, ITEMS plan §5) — the ONLY
 * shards→KEEP faucet, and it is LIVE: mining mints shards today and the routes
 * serve real money. (The old header claimed a FORGE_ENABLED dark-ship gate and
 * zero shard balances; both were false by 2026-07-29 — a false safety claim on
 * top of a money file is how a reviewer stops looking. There is now a REAL ops
 * kill switch: FORGE_ENABLED=false unregisters the routes, mirroring
 * WITHDRAWALS_ENABLED.)
 *
 * Rules (mirrors scripts/src/forge-model.ts EXACTLY — the tested model is the
 * spec; integer bigint math here, floats there):
 *  - Daily emission FORGE.dailyEmissionKeep (500M play pool over 5 years).
 *  - Contributions accumulate per UTC day into forge_escrow.
 *  - Settlement (lazy, first touch after the day ends):
 *      distributable = emission × min(total, softCap) / softCap
 *      counted_i     = min(shards_i, total × 30%)     (per-player cap)
 *      payout_i      = distributable × counted_i / total
 *      refund_i      = shards_i − counted_i           (excess shards RETURNED)
 *    Uncaptured emission stays in the pool (no redistribution — that would
 *    reward sybil-splitting). Counted shards BURN; refunds return to the
 *    player's shard balance.
 *  - SUB-PARITY INVARIANT: rate = emission/max(total, softCap) < 1 because
 *    softCap > dailyEmissionKeep (constants-tested) — the deposit→forge→
 *    withdraw loop can never print KEEP.
 *
 * CLAIMABLE PAYOUTS (2026-07-29). Settlement no longer auto-credits the player:
 * it moves the day's KEEP emission_pool → forge_payout_escrow and the player
 * CLAIMS it (escrow → player_keep). Unclaimed allocations sweep BACK to
 * emission_pool after FORGE.claimWindowDays. The economic math is byte-identical
 * — only custody of the output moved — so scripts/src/forge-model.ts stays an
 * exact mirror and packages/sim is not involved.
 *
 * PROOF OF RESERVES: unclaimed forge KEEP is a custodial liability living
 * OUTSIDE player_keep. money/snapshot.ts now counts 'forge_payout_escrow' in
 * checkReserves() AND folds each wallet's unclaimed allocation into its
 * proof-of-liabilities leaf — without both, /por overstated coverage by the
 * unclaimed float while each player's inclusion proof under-attested their own
 * claim (money review 2026-07-29 #1/#3, closed).
 *
 * DEED-NATIVE CUTOVER (D-035, owner 2026-08-12). Stable-base calls no longer
 * write the wallet/day table above. One `(base_id, UTC day)` position accepts
 * any number of transactions up to that deed's building-level cap. Its full
 * remaining stake participates at `emission / max(global total, soft cap)`;
 * there is no wallet share cap, dust floor, cooldown or refund. Raid-reserved
 * Forge SHARDS are the only permitted gap between open positions and the deed
 * escrow; settlement waits for that raid, then burns the post-theft net. KEEP
 * and independently-rolled items remain keyed by base id, so both transfer with
 * the deed. A claim credits the current owner, while settlementOwnerWallet is
 * audit history only. The legacy path remains solely for unmigrated flag-off
 * state and already-settled wallet claims/expiry.
 */
import { createHash } from 'node:crypto';
import { ECONOMY, FORGE, FORGE_DROPS, ITEMS, type ItemRarity } from '@shardkeep/shared';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  baseEconomyBackfills, baseForgePositions, baseItems, baseRaidLocks, bases,
  builderJobs, buildings, forgeContributions, ledgerEntries,
  ledgerTransactions, playerItems, players, raidLootReservations,
} from '../db/schema';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { completeDueJobs } from './base';
import {
  lockStablePrerequisiteBase, type StableBaseMutationContext,
} from './stableBasePrerequisites';

/** UTC day key ('YYYY-MM-DD') for a timestamp. */
export function forgeDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The instant the CURRENT cycle closes = the next UTC midnight. Defined right
 * here beside `forgeDayOf` and from the SAME definition, so the countdown the
 * client renders can never disagree with the boundary settlement actually uses.
 * No constant: the boundary is structural, not a tunable — if a non-midnight
 * cutoff is ever wanted, add FORGE.cycleResetUtcHour and read it in BOTH.
 */
export function forgeCycleEndsAt(now: Date): Date {
  const dayStart = new Date(`${forgeDayOf(now)}T00:00:00.000Z`).getTime();
  return new Date(dayStart + 86_400_000);
}

/**
 * The player's EFFECTIVE Gold Forge level: 0 when no goldforge building exists
 * or it is still under construction (owner 2026-07-24: the BUILDING is the
 * faucet — contributionCapByLevel[0] = 0 shards/day). Upgrades don't need a
 * check here: `buildings.level` only bumps when the upgrade job COMPLETES.
 */
async function goldforgeLevelOf(db: DbOrTx, wallet: string, baseId?: string): Promise<number> {
  const [gf] = await db.select({ id: buildings.id, level: buildings.level }).from(buildings)
    .where(and(
      baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet),
      eq(buildings.type, 'goldforge'),
    ));
  if (!gf) return 0;
  const [building] = await db.select({ id: builderJobs.id }).from(builderJobs).where(and(
    eq(builderJobs.buildingId, gf.id), eq(builderJobs.kind, 'build'), isNull(builderJobs.completedAt),
  ));
  return building ? 0 : gf.level;
}

/** Daily contribution cap (shards) at a Gold Forge building level. */
export function contributionCapForLevel(level: number): bigint {
  const arr = FORGE.contributionCapByLevel;
  return BigInt(arr[Math.min(Math.max(level, 0), arr.length - 1)] ?? 0);
}

export interface ForgeStableBaseContext {
  baseId: string;
  assertActiveAuthority: (
    tx: DbTx, wallet: string,
  ) => Promise<Array<{ id: string; landPaidAt: Date | null }>>;
}

const BASE_FORGE_DROP_IDS = Object.keys(FORGE_DROPS.independentDropBps) as Array<
  keyof typeof FORGE_DROPS.independentDropBps
>;

/** One deed/day gets one independent deterministic roll per item. The input is
 * the stable base id, not its mutable owner or contribution transaction count.
 *
 * DAILY PER-ITEM CAP (owner 2026-08-16: "we should drop 1-2 per item daily
 * not more" — FORGE_DROPS.dailyPerItemCap): because each item id is rolled
 * exactly ONCE per unique(day, baseId) position and settlement grants are
 * gated on the position's settledAt claim (FOR UPDATE + isNull), a deed can
 * win at most 1 unit of any item per UTC day no matter how many settle
 * passes/retries run — always within the cap. Any future change that rolls
 * an item more than once per deed/day must bound the yield by
 * FORGE_DROPS.dailyPerItemCap explicitly (test-pinned in forge-base). */
export function computeBaseForgeDrops(day: string, baseId: string): string[] {
  const range = 1n << 64n;
  return BASE_FORGE_DROP_IDS.filter((itemId) => {
    const sample = BigInt(`0x${createHash('sha256')
      .update(`forge-drop:v2:${day}:${baseId}:${itemId}`).digest('hex').slice(0, 16)}`);
    const threshold = (range * BigInt(FORGE_DROPS.independentDropBps[itemId])) / 10_000n;
    return sample < threshold;
  });
}

function netBasePosition(position: typeof baseForgePositions.$inferSelect): bigint {
  return position.contributedShards - position.raidDebitedShards;
}

/** Validate the deed Forge's open-position backing. During a raid, the only
 * permitted gap is the exact Forge amount named by its live reservation. */
export async function assertBaseForgeEscrowReconciles(
  db: DbOrTx, baseId: string,
): Promise<{ openShards: bigint; reservedShards: bigint; escrowShards: bigint }> {
  const rows = await db.select({
    contributed: baseForgePositions.contributedShards,
    raidDebited: baseForgePositions.raidDebitedShards,
  }).from(baseForgePositions).where(and(
    eq(baseForgePositions.baseId, baseId), isNull(baseForgePositions.settledAt),
  ));
  const openShards = rows.reduce((sum, row) => sum + row.contributed - row.raidDebited, 0n);
  const reserved = await db.select({ amount: raidLootReservations.forgeReservedShards })
    .from(raidLootReservations).where(and(
      eq(raidLootReservations.defenderBaseId, baseId), eq(raidLootReservations.state, 'reserved'),
    ));
  const reservedShards = reserved.reduce((sum, row) => sum + row.amount, 0n);
  const escrow = await getOrCreateBaseAccount(db, baseId, 'base_forge_escrow');
  if (escrow.balance + reservedShards !== openShards) {
    throw new Error(
      `base Forge escrow mismatch for ${baseId}: ${escrow.balance} held + ${reservedShards} raid-reserved != ${openShards} open`,
    );
  }
  return { openShards, reservedShards, escrowShards: escrow.balance };
}

async function assertStableForgeAuthority(
  tx: DbTx, wallet: string, baseId: string, context: ForgeStableBaseContext,
): Promise<void> {
  if (context.baseId !== baseId) {
    throw new HttpError(409, 'base authority context does not match target', 'BASE_NOT_OWNED');
  }
  const active = await context.assertActiveAuthority(tx, wallet);
  const selected = active.find((base) => base.id === baseId);
  if (!selected || !selected.landPaidAt) {
    throw new HttpError(409, 'selected land base changed', 'DEED_OWNERSHIP_CHANGED');
  }
  const [raidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
    .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, baseId)).for('update');
  if (raidLock) {
    throw new HttpError(
      423,
      'You are being raided, please wait to continue playing or watch it live',
      'BASE_BEING_RAIDED',
    );
  }
}

/**
 * Daily item-drop winners (owner 2026-07-24): each item is awarded to up to its
 * `dailyLimit` RANDOM eligible contributors — contribution amount is irrelevant,
 * every eligible wallet has equal odds. DETERMINISTIC from sha256(day,itemId,
 * wallet), so a settle re-run picks the SAME winners (idempotent + auditable).
 * A wallet wins AT MOST ONE item/day; scarcer items (table order) are drawn
 * first, so a whale can't sweep the Aegis AND the kegs. Pure — exported for tests.
 *
 * @param wallets the day's ELIGIBLE contributors (counted ≥ minCountedShards).
 * @returns wallet → itemId for every winner.
 */
export function computeForgeDropWinners(day: string, wallets: string[]): Map<string, string> {
  const winners = new Map<string, string>();
  const taken = new Set<string>();
  for (const { itemId, dailyLimit } of FORGE_DROPS.table) {
    const ranked = wallets
      .filter((w) => !taken.has(w))
      .map((w) => ({ w, h: createHash('sha256').update(`forge-drop:${day}:${itemId}:${w}`).digest('hex') }))
      .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
    for (const { w } of ranked.slice(0, dailyLimit)) { winners.set(w, itemId); taken.add(w); }
  }
  return winners;
}

/**
 * Contribute shards to TODAY's pool. Moves player_shards → forge_escrow and
 * accumulates the day row. Fails when the balance is short (postTransaction
 * enforces the non-negative player floor).
 */
export async function contributeToForge(
  db: Db, wallet: string, shards: bigint, idempotencyKey: string, now = new Date(),
  baseId?: string, stableContext?: ForgeStableBaseContext,
) {
  if (shards <= 0n) throw new HttpError(422, 'contribute a positive shard amount');
  const day = forgeDayOf(now);
  return db.transaction(async (tx) => {
    // Per-wallet serialization (security review 2026-07-24 #4): the cap check
    // below reads the accumulated day row, so two concurrent contributes must
    // not both see the pre-update total and jointly overshoot the cap. Same
    // player-row FOR UPDATE pattern as placeBuilding/createRaid.
    const [locked] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!locked) throw new HttpError(404, 'player not found');
    if (baseId) {
      if (!stableContext) throw new HttpError(409, 'baseId requires deed authority', 'BASE_NOT_OWNED');
      await assertStableForgeAuthority(tx, wallet, baseId, stableContext);
    }

    // Finish due work only AFTER the exact base is locked and its current owner
    // revalidated. Running this before the transaction let a seller pass a route
    // precheck, transfer the deed, then complete the buyer's now-due obstacle job
    // as the old wallet before this function eventually rejected the contribution.
    await completeDueJobs(tx, wallet, now, baseId);

    // Building gate (owner 2026-07-24): the Gold Forge's level caps the DAILY
    // per-player contribution. No building (or still building) → cap 0.
    const level = await goldforgeLevelOf(tx, wallet, baseId);
    const baseCap = contributionCapForLevel(level);
    if (baseCap <= 0n) throw new HttpError(422, 'build a Gold Forge — it unlocks daily shard contributions');
    if (baseId) {
      const [position] = await tx.select().from(baseForgePositions).where(and(
        eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, baseId),
      )).for('update');
      const already = position
        ? position.contributedShards - position.raidDebitedShards : 0n;
      const player = await getOrCreateBaseAccount(tx, baseId, 'base_shards');
      const escrow = await getOrCreateBaseAccount(tx, baseId, 'base_forge_escrow');
      const stableKey = `contrib:base:${baseId}:${idempotencyKey}`;
      const [prior] = await tx.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, stableKey));
      if (prior) {
        const entries = await tx.select().from(ledgerEntries)
          .where(eq(ledgerEntries.txnId, prior.id));
        const metadata = prior.metadata as { wallet?: unknown; baseId?: unknown; day?: unknown };
        const exact = entries.length === 2
          && entries.some((entry) => entry.accountId === player.id && entry.delta === -shards)
          && entries.some((entry) => entry.accountId === escrow.id && entry.delta === shards)
          && metadata.wallet === wallet && metadata.baseId === baseId && metadata.day === day;
        if (!exact) {
          throw new HttpError(409, 'idempotency key was already used with different Forge contribution details');
        }
        return { day, myShards: already.toString() };
      }
      if (already + shards > baseCap) {
        throw new HttpError(422,
          `this Gold Forge's daily cap is ${baseCap} shards at level ${level} — ${baseCap - already > 0n ? baseCap - already : 0n} left today`);
      }
      const posted = await postTransaction(tx, {
        idempotencyKey: stableKey,
        type: 'forge.contribute',
        entries: [
          { account: player.id, delta: -shards },
          { account: escrow.id, delta: shards },
        ],
        metadata: { wallet, baseId, day },
      });
      if (!posted.duplicate) {
        await tx.insert(baseForgePositions).values({
          day, baseId, contributedShards: shards, updatedAt: now,
        }).onConflictDoUpdate({
          target: [baseForgePositions.day, baseForgePositions.baseId],
          set: {
            contributedShards: sql`${baseForgePositions.contributedShards} + ${shards}`,
            updatedAt: now,
          },
        });
        // M23 a15: the smelt quest ticks with the escrow post, in the same tx,
        // duplicate-gated exactly like the position row above.
        const { progressQuestBatch } = await import('./quests');
        await progressQuestBatch(tx, wallet, [['forge_smelt', 1]], now, baseId);
      }
      const [updated] = await tx.select().from(baseForgePositions).where(and(
        eq(baseForgePositions.day, day), eq(baseForgePositions.baseId, baseId),
      ));
      await assertBaseForgeEscrowReconciles(tx, baseId);
      return {
        day,
        myShards: ((updated?.contributedShards ?? 0n) - (updated?.raidDebitedShards ?? 0n)).toString(),
      };
    }
    const walletLevel = level;
    const walletCap = contributionCapForLevel(walletLevel);
    const [todayRow] = await tx.select({ shards: forgeContributions.shards }).from(forgeContributions)
      .where(and(eq(forgeContributions.day, day), eq(forgeContributions.playerWallet, wallet)));
    const already = todayRow?.shards ?? 0n;
    if (already + shards > walletCap) {
      throw new HttpError(422,
        `daily forge cap is ${walletCap} shards at Gold Forge level ${walletLevel} — ${walletCap - already > 0n ? walletCap - already : 0n} left today (upgrade the Gold Forge to raise it)`);
    }

    const sys = await bootstrapSystemAccounts(tx);
    const player = await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
    // Client keys are NAMESPACED (security review 2026-07-24 #3): a raw client
    // key could collide with the server's deterministic settlement keys
    // (`forge:${day}:${wallet}:…`) and permanently swallow a player's payout.
    const posted = await postTransaction(tx, {
      idempotencyKey: `contrib:${wallet}:${idempotencyKey}`,
      type: 'forge.contribute',
      entries: [
        { account: player.id, delta: -shards },
        { account: sys.forge_escrow, delta: shards },
      ],
      metadata: { wallet, day, ...(baseId ? { baseId } : {}) },
    });
    // A duplicate post moved NO shards (security review 2026-07-24 #1) — the
    // day row must never accumulate phantom contribution, or settlement would
    // pay KEEP on shards that were never escrowed (a net mint).
    if (!posted.duplicate) {
      await tx.insert(forgeContributions)
        .values({ day, playerWallet: wallet, shards })
        .onConflictDoUpdate({
          target: [forgeContributions.day, forgeContributions.playerWallet],
          set: { shards: sql`${forgeContributions.shards} + ${shards}` },
        });
      // M23 a15: legacy-mode smelt quest tick (see the base branch above).
      const { progressQuestBatch } = await import('./quests');
      await progressQuestBatch(tx, wallet, [['forge_smelt', 1]], now);
    }
    const [row] = await tx.select().from(forgeContributions)
      .where(and(eq(forgeContributions.day, day), eq(forgeContributions.playerWallet, wallet)));
    return { day, myShards: (row?.shards ?? 0n).toString() };
  });
}

/**
 * Settle every unsettled day BEFORE `today`. Lazy-triggered from contribute/
 * status (and safe under concurrency: each player-day settles behind ledger
 * idempotency keys, and the settledAt stamp is claimed with an IS NULL guard).
 */
export async function settleDueForgeDays(db: Db, now = new Date()): Promise<number> {
  const today = forgeDayOf(now);
  const legacyDue = await db.selectDistinct({ day: forgeContributions.day })
    .from(forgeContributions)
    .where(and(
      lt(forgeContributions.day, today), isNull(forgeContributions.settledAt),
      sql`not exists (select 1 from ${baseEconomyBackfills} bf where bf.legacy_wallet = ${forgeContributions.playerWallet})`,
    ));
  const baseDue = await db.selectDistinct({ day: baseForgePositions.day })
    .from(baseForgePositions)
    .where(and(lt(baseForgePositions.day, today), isNull(baseForgePositions.settledAt)));
  const due = [...new Set([...legacyDue, ...baseDue].map((row) => row.day))].sort();
  // PER-DAY ERROR ISOLATION (money review 2026-07-29 #2). This runs as the first
  // line of the forge STATUS, HISTORY and CLAIM paths, and settleForgeDay fails
  // closed on emission exhaustion or a fail-loud duplicate key. Unisolated, ONE
  // poisoned day took down /forge and POST /forge/claim for EVERY player —
  // verified: a settled, claimable allocation became unreachable because an
  // unrelated player's day could not settle. A day that cannot settle must not
  // hold anyone else's money hostage: log it loudly and carry on. The day stays
  // unsettled (settledAt IS NULL), so the next pass retries it — nothing is
  // skipped silently, and no payout is lost.
  let settled = 0;
  for (const day of due) {
    try {
      if (await settleForgeDayInternal(db, day, now)) settled++;
    } catch (e) {
      console.error(`[forge] day ${day} could not settle — retrying next pass:`, e);
    }
  }
  return settled;
}

/** Settle one past day (idempotent). Exported for tests. */
export async function settleForgeDay(db: Db, day: string, now = new Date()): Promise<void> {
  await settleForgeDayInternal(db, day, now);
}

/** One global day settles atomically because its pro-rata KEEP rate uses every
 * deed and remaining legacy position. Any live raid defers the whole day; a
 * partial denominator would permanently overpay the rows that settled first. */
async function settleForgeDayInternal(db: Db, day: string, now: Date): Promise<boolean> {
  if (day >= forgeDayOf(now)) throw new HttpError(422, 'day is still open');
  return db.transaction(async (tx) => {
    const candidateBases = await tx.selectDistinct({ baseId: baseForgePositions.baseId })
      .from(baseForgePositions).where(and(
        eq(baseForgePositions.day, day), isNull(baseForgePositions.settledAt),
      )).orderBy(asc(baseForgePositions.baseId));
    const baseIds = candidateBases.map((row) => row.baseId);
    const lockedBases = baseIds.length > 0
      ? await tx.select({ id: bases.id, ownerWallet: bases.ownerWallet }).from(bases)
        .where(inArray(bases.id, baseIds)).orderBy(asc(bases.id)).for('update')
      : [];
    if (lockedBases.length !== baseIds.length) {
      throw new Error(`Forge ${day}: a deed position lost its stable base`);
    }
    if (baseIds.length > 0) {
      const raidLocks = await tx.select({ baseId: baseRaidLocks.baseId }).from(baseRaidLocks)
        .where(inArray(baseRaidLocks.baseId, baseIds)).for('update');
      const reservations = await tx.select({ baseId: raidLootReservations.defenderBaseId })
        .from(raidLootReservations).where(and(
          inArray(raidLootReservations.defenderBaseId, baseIds),
          eq(raidLootReservations.state, 'reserved'),
        )).for('update');
      if (raidLocks.length > 0 || reservations.length > 0) return false;
    }

    const rows = await tx.select().from(forgeContributions)
      .where(and(
        eq(forgeContributions.day, day), isNull(forgeContributions.settledAt),
        sql`not exists (select 1 from ${baseEconomyBackfills} bf where bf.legacy_wallet = ${forgeContributions.playerWallet})`,
      )).orderBy(asc(forgeContributions.playerWallet)).for('update');
    const baseRows = await tx.select().from(baseForgePositions)
      .where(and(eq(baseForgePositions.day, day), isNull(baseForgePositions.settledAt)))
      .orderBy(asc(baseForgePositions.baseId)).for('update');
    if (rows.length === 0 && baseRows.length === 0) return false;

    // Totals include ALL of the day's rows (settled or not) so a partially
    // interrupted settlement resumes with identical math.
    const allRows = await tx.select().from(forgeContributions).where(and(
      eq(forgeContributions.day, day),
      sql`not exists (select 1 from ${baseEconomyBackfills} bf where bf.legacy_wallet = ${forgeContributions.playerWallet})`,
    ));
    const allBaseRows = await tx.select().from(baseForgePositions)
      .where(eq(baseForgePositions.day, day));
    const unsettledLegacyTotal = allRows.reduce(
      (sum, row) => sum + (row.settledAt === null ? row.shards : 0n), 0n,
    );
    const unsettledBaseTotal = allBaseRows.reduce(
      (sum, row) => sum + (row.settledAt === null ? netBasePosition(row) : 0n), 0n,
    );
    const priorDistributedKeep = allRows.reduce(
      (sum, row) => sum + (row.settledAt === null ? 0n : (row.keepPaid ?? 0n)), 0n,
    ) + allBaseRows.reduce(
      (sum, row) => sum + (row.settledAt === null ? 0n : (row.keepPaid ?? 0n)), 0n,
    );
    const total = unsettledLegacyTotal + unsettledBaseTotal;

    const emission = BigInt(FORGE.dailyEmissionKeep);
    const softCap = BigInt(FORGE.softCapShards);
    const capBps = BigInt(FORGE.maxDailyShareBps);
    const capShards = (total * capBps) / 10_000n;
    const payoutDenominator = total > softCap ? total : softCap;
    const remainingEmission = emission > priorDistributedKeep ? emission - priorDistributedKeep : 0n;

    // Daily item-drop winners (owner 2026-07-24): computed ONCE over the day's
    // full eligible set (counted ≥ minCountedShards) so the outcome is stable
    // regardless of settle order/interruption. Deterministic → a re-run picks
    // the same winners; the grant below is still gated on the claim.
    const floor = BigInt(FORGE_DROPS.minCountedShards);
    const eligible = allRows
      .filter((r) => (r.shards < capShards ? r.shards : capShards) >= floor)
      .map((r) => r.playerWallet);
    const dropWinners = computeForgeDropWinners(day, eligible);

    const sys = await bootstrapSystemAccounts(tx);
    for (const r of rows) {
      const counted = r.shards < capShards ? r.shards : capShards;
      const payout = total > 0n ? (remainingEmission * counted) / payoutDenominator : 0n;
      const refund = r.shards - counted;
      const drop = dropWinners.get(r.playerWallet) ?? null;

      // CLAIM FIRST (isNull guard): a concurrent settle blocks on the row
      // lock, then matches 0 rows and skips the whole player — postings are
      // idempotent anyway, but the ITEM GRANT below is not a ledger posting,
      // so it must be gated on winning this claim (double-grant hazard).
      const claimed = await tx.update(forgeContributions)
        .set({ settledAt: now, keepPaid: payout, shardsRefunded: refund, itemDropped: drop })
        .where(and(eq(forgeContributions.id, r.id), isNull(forgeContributions.settledAt)))
        .returning({ id: forgeContributions.id });
      if (claimed.length === 0) continue;

      // KEEP leg: emission_pool → forge_payout_escrow (skipped when the floor
      // rounds to 0). It is NOT credited to the player here (2026-07-29): the
      // player CLAIMS it, and until then it sits in a named, non-negative
      // obligation account. The idempotency key SHAPE is unchanged — a row only
      // re-enters this branch through the isNull(settledAt) gate above, and the
      // escrow post + the id stamp below are in one transaction.
      // A duplicate here is IMPOSSIBLE post-namespacing (client keys can no
      // longer collide with these deterministic keys) and the claim gate above
      // serializes re-runs — so if it ever fires, refuse to stamp the row as
      // settled with money unpaid (security review 2026-07-24 #3, fail loud).
      if (payout > 0n) {
        const paid = await postTransaction(tx, {
          idempotencyKey: `forge:${day}:${r.playerWallet}:keep`,
          type: 'forge.allocate',
          entries: [
            { account: sys.emission_pool, delta: -payout },
            { account: sys.forge_payout_escrow, delta: payout },
          ],
          metadata: { day, wallet: r.playerWallet, shards: r.shards.toString(), counted: counted.toString() },
        });
        if (paid.duplicate) throw new Error(`forge settle ${day}/${r.playerWallet}: KEEP-leg key already used — refusing to settle`);
        // THE claimability gate. A row without this id can never be claimed —
        // which is exactly what makes legacy auto-credited rows (and any day
        // settled by the old code in the migrate→deploy window) unclaimable.
        await tx.update(forgeContributions)
          .set({ keepEscrowTxnId: paid.transaction.id })
          .where(eq(forgeContributions.id, r.id));
      }
      // SHARDS leg: escrow → shard_burn (counted) + back to the player (refund).
      // (shard_burn, not 'burn' — the ledger balances per currency.)
      const shardAcct = await getOrCreatePlayerAccount(tx, r.playerWallet, 'player_shards');
      const burned = await postTransaction(tx, {
        idempotencyKey: `forge:${day}:${r.playerWallet}:shards`,
        type: 'forge.burn',
        entries: [
          { account: sys.forge_escrow, delta: -r.shards },
          { account: sys.shard_burn, delta: counted },
          ...(refund > 0n ? [{ account: shardAcct.id, delta: refund }] : []),
        ],
        metadata: { day, refunded: refund.toString() },
      });
      if (burned.duplicate) throw new Error(`forge settle ${day}/${r.playerWallet}: shard-leg key already used — refusing to settle`);

      // Item grant — inside the claim gate + this tx, atomic with the payout.
      if (drop) {
        await tx.insert(playerItems).values({ playerWallet: r.playerWallet, itemId: drop })
          .onConflictDoUpdate({
            target: [playerItems.playerWallet, playerItems.itemId],
            set: { qty: sql`${playerItems.qty} + 1` },
          });
      }
    }

    const ownerByBase = new Map(lockedBases.map((base) => [base.id, base.ownerWallet]));
    for (const position of baseRows) {
      const ownerWallet = ownerByBase.get(position.baseId);
      if (!ownerWallet) throw new Error(`Forge ${day}/${position.baseId}: owner missing`);
      await assertBaseForgeEscrowReconciles(tx, position.baseId);
      const counted = netBasePosition(position);
      const payout = total > 0n ? (remainingEmission * counted) / payoutDenominator : 0n;
      const drops = counted > 0n ? computeBaseForgeDrops(day, position.baseId) : [];
      const sys = await bootstrapSystemAccounts(tx);
      let shardSettlementTxnId: string | null = null;
      if (counted > 0n) {
        const escrow = await getOrCreateBaseAccount(tx, position.baseId, 'base_forge_escrow');
        const burned = await postTransaction(tx, {
          idempotencyKey: `forge:base:${day}:${position.baseId}:shards`,
          type: 'forge.burn',
          entries: [
            { account: escrow.id, delta: -counted },
            { account: sys.shard_burn, delta: counted },
          ],
          metadata: { day, baseId: position.baseId, counted: counted.toString() },
        });
        if (burned.duplicate) {
          throw new Error(`base Forge settle ${day}/${position.baseId}: shard key already used`);
        }
        shardSettlementTxnId = burned.transaction.id;
      }
      let keepEscrowTxnId: string | null = null;
      if (payout > 0n) {
        const allocated = await postTransaction(tx, {
          idempotencyKey: `forge:base:${day}:${position.baseId}:keep`,
          type: 'forge.allocate',
          entries: [
            { account: sys.emission_pool, delta: -payout },
            { account: sys.forge_payout_escrow, delta: payout },
          ],
          metadata: { day, baseId: position.baseId, counted: counted.toString() },
        });
        if (allocated.duplicate) {
          throw new Error(`base Forge settle ${day}/${position.baseId}: KEEP key already used`);
        }
        keepEscrowTxnId = allocated.transaction.id;
      }
      for (const itemId of drops) {
        await tx.insert(baseItems).values({ baseId: position.baseId, itemId })
          .onConflictDoUpdate({
            target: [baseItems.baseId, baseItems.itemId],
            set: { qty: sql`${baseItems.qty} + 1` },
          });
      }
      await tx.update(baseForgePositions).set({
        countedShards: counted,
        shardsRefunded: 0n,
        keepPaid: payout,
        settlementOwnerWallet: ownerWallet,
        itemsDropped: drops,
        shardSettlementTxnId,
        keepEscrowTxnId,
        settledAt: now,
        updatedAt: now,
      }).where(and(eq(baseForgePositions.id, position.id), isNull(baseForgePositions.settledAt)));
      await assertBaseForgeEscrowReconciles(tx, position.baseId);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Claim / expiry — the settled allocation's second half.
// ---------------------------------------------------------------------------

/** The only states the API ever reports for an allocation row. */
export type ForgeRowStatus = 'open' | 'claimable' | 'claimed' | 'expired' | 'paid_legacy' | 'nothing';

type StatusRow = {
  settledAt: Date | null; keepPaid: bigint | null; keepEscrowTxnId: string | null;
  claimedAt: Date | null; expiredAt: Date | null;
};

/**
 * Row state, derived — never stored (one source of truth).
 * `paid_legacy` is FIRST-CLASS, not leftovers: a row settled by the pre-claim
 * auto-credit code (or by the old code in the migrate→deploy window) has its
 * KEEP in the player's spendable balance already and must read as "paid",
 * never as a stuck unclaimed allocation.
 */
export function forgeRowStatus(r: StatusRow): ForgeRowStatus {
  if (r.settledAt === null) return 'open';
  if (r.expiredAt !== null) return 'expired';
  if ((r.keepPaid ?? 0n) <= 0n) return 'nothing';
  if (r.keepEscrowTxnId === null) return 'paid_legacy';
  return r.claimedAt === null ? 'claimable' : 'claimed';
}

/** When a settled allocation stops being claimable (derived, not stored). */
export function forgeExpiresAt(settledAt: Date): Date {
  return new Date(settledAt.getTime() + FORGE.claimWindowDays * 86_400_000);
}

/** SQL predicate: rows holding real, still-claimable escrowed KEEP. */
function claimablePredicate(wallet: string, now: Date) {
  return and(
    eq(forgeContributions.playerWallet, wallet),
    isNotNull(forgeContributions.settledAt),
    isNotNull(forgeContributions.keepEscrowTxnId),
    isNull(forgeContributions.claimedAt),
    isNull(forgeContributions.expiredAt),
    // Expiry is a PREDICATE, not a timer: a lapsed allocation simply stops
    // being selected, and expireDueForgeAllocations finishes the bookkeeping.
    gt(forgeContributions.settledAt, new Date(now.getTime() - FORGE.claimWindowDays * 86_400_000)),
  );
}

function baseClaimablePredicate(baseId: string, now: Date) {
  return and(
    eq(baseForgePositions.baseId, baseId),
    isNotNull(baseForgePositions.settledAt),
    isNotNull(baseForgePositions.keepEscrowTxnId),
    isNull(baseForgePositions.claimedAt),
    isNull(baseForgePositions.expiredAt),
    gt(baseForgePositions.settledAt, new Date(now.getTime() - FORGE.claimWindowDays * 86_400_000)),
  );
}

/**
 * Claim settled allocations: forge_payout_escrow → player_keep.
 *
 * Idempotency has THREE independent layers:
 *   1. the row-level `claimed_at IS NULL` gate (claim-then-post, the same
 *      ordering and reasoning as settleForgeDay above — the gate must precede
 *      the post so a concurrent claimer skips the row entirely);
 *   2. the deterministic ledger key `forge:${day}:${wallet}:claim` (server
 *      namespace — a client key can never be routed in here);
 *   3. forge_payout_escrow being NON-negative, so a claim against KEEP that was
 *      never escrowed for that row aborts loudly instead of inflating balances.
 *
 * Expiry is a PREDICATE, not a timer: a lapsed allocation is simply not
 * selected, and the sweep finishes the bookkeeping.
 *
 * @param day claim only this day; omitted → every claimable day, OLDEST first
 *   (also the stable lock order), up to FORGE.claimBatchMax.
 */
export async function claimForgeDays(
  db: Db, wallet: string, day?: string, now = new Date(),
  baseId?: string, stableContext?: ForgeStableBaseContext,
): Promise<{ claimed: Array<{ day: string; keep: string }>; totalKeep: string; remaining: number; keepBalance: string }> {
  // A player who only ever claims must never be blocked by an unsettled day.
  await settleDueForgeDays(db, now);
  await expireDueForgeAllocations(db, now);

  const result = await claimForgeDaysAfterSettlement(db, wallet, day, now, baseId, stableContext);
  // Preserve the legacy response exactly; the v1 command alone exposes ledger proof.
  return { ...result, claimed: result.claimed.map(({ day, keep }) => ({ day, keep })) };
}

/** Caller settles/expires first. A command passes its open transaction so payout,
 * original allocation markers and immutable command evidence commit together. */
export async function claimForgeDaysAfterSettlement(
  db: DbOrTx, wallet: string, day: string | undefined, now: Date,
  baseId?: string, stableContext?: ForgeStableBaseContext,
): Promise<{ claimed: Array<{ day: string; keep: string; ledgerTransactionId: string }>; totalKeep: string; remaining: number; keepBalance: string }> {
  if (day !== undefined && day >= forgeDayOf(now)) throw new HttpError(422, 'that cycle has not settled yet');

  if (baseId) {
    if (!stableContext) throw new HttpError(409, 'baseId requires deed authority', 'BASE_NOT_OWNED');
    const claimed = await db.transaction(async (tx) => {
      await assertStableForgeAuthority(tx, wallet, baseId, stableContext);
      const rows = await tx.select().from(baseForgePositions)
        .where(day === undefined ? baseClaimablePredicate(baseId, now)
          : and(baseClaimablePredicate(baseId, now), eq(baseForgePositions.day, day)))
        .orderBy(asc(baseForgePositions.day)).limit(FORGE.claimBatchMax).for('update');
      const sys = await bootstrapSystemAccounts(tx);
      const keepAcct = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
      const out: Array<{ day: string; keep: string; ledgerTransactionId: string }> = [];
      for (const row of rows) {
        const payout = row.keepPaid ?? 0n;
        if (payout <= 0n) continue;
        const posted = await postTransaction(tx, {
          idempotencyKey: `forge:base:${row.day}:${baseId}:claim`,
          type: 'forge.claim',
          entries: [
            { account: sys.forge_payout_escrow, delta: -payout },
            { account: keepAcct.id, delta: payout },
          ],
          metadata: { day: row.day, baseId, claimedBy: wallet },
        });
        if (posted.duplicate) {
          throw new Error(`base Forge claim ${row.day}/${baseId}: claim key already used`);
        }
        const won = await tx.update(baseForgePositions).set({
          claimedAt: now, claimTxnId: posted.transaction.id, updatedAt: now,
        }).where(and(
          eq(baseForgePositions.id, row.id),
          isNull(baseForgePositions.claimedAt), isNull(baseForgePositions.expiredAt),
        )).returning({ id: baseForgePositions.id });
        if (won.length !== 1) throw new Error(`base Forge claim ${row.day}/${baseId}: row gate lost under lock`);
        out.push({ day: row.day, keep: payout.toString(), ledgerTransactionId: posted.transaction.id });
      }
      return out;
    });
    const [left] = await db.select({ count: sql<number>`count(*)::int` })
      .from(baseForgePositions).where(baseClaimablePredicate(baseId, now));
    const keepAcct = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
    return {
      claimed,
      totalKeep: claimed.reduce((sum, row) => sum + BigInt(row.keep), 0n).toString(),
      remaining: left?.count ?? 0,
      keepBalance: keepAcct.balance.toString(),
    };
  }

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.select().from(forgeContributions)
      .where(day === undefined ? claimablePredicate(wallet, now)
        : and(claimablePredicate(wallet, now), eq(forgeContributions.day, day)))
      .orderBy(asc(forgeContributions.day))
      .limit(FORGE.claimBatchMax)
      .for('update');

    const sys = await bootstrapSystemAccounts(tx);
    const out: Array<{ day: string; keep: string; ledgerTransactionId: string }> = [];
    for (const r of rows) {
      const payout = r.keepPaid ?? 0n;
      if (payout <= 0n) continue;
      // CLAIM GATE FIRST (settleForgeDay lines above explain why): a concurrent
      // claim blocks on the row lock, then matches 0 rows and skips the row —
      // so exactly one of the two racers posts the payout.
      const won = await tx.update(forgeContributions)
        .set({ claimedAt: now })
        .where(and(eq(forgeContributions.id, r.id), isNull(forgeContributions.claimedAt)))
        .returning({ id: forgeContributions.id });
      if (won.length === 0) continue;

      const keepAcct = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
      const posted = await postTransaction(tx, {
        idempotencyKey: `forge:${r.day}:${wallet}:claim`,
        type: 'forge.claim',
        entries: [
          { account: sys.forge_payout_escrow, delta: -payout },
          { account: keepAcct.id, delta: payout },
        ],
        metadata: { day: r.day, wallet },
      });
      // Fail loud, same rule as settlement: the row is already stamped claimed
      // in this transaction, so a duplicate key would mean "marked paid, money
      // not moved". Abort the whole claim instead.
      if (posted.duplicate) throw new Error(`forge claim ${r.day}/${wallet}: claim key already used — refusing to claim`);
      await tx.update(forgeContributions)
        .set({ claimTxnId: posted.transaction.id })
        .where(eq(forgeContributions.id, r.id));
      out.push({ day: r.day, keep: payout.toString(), ledgerTransactionId: posted.transaction.id });
    }
    return out;
  });

  const [left] = await db.select({ count: sql<number>`count(*)::int` })
    .from(forgeContributions).where(claimablePredicate(wallet, now));
  const remaining = left?.count ?? 0;
  const keepAcct = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  return {
    claimed,
    totalKeep: claimed.reduce((a, c) => a + BigInt(c.keep), 0n).toString(),
    remaining: remaining ?? 0,
    keepBalance: keepAcct.balance.toString(),
  };
}

/**
 * Sweep lapsed allocations back to emission_pool (owner default: the lifetime
 * mint pool, so unclaimed emission was simply never minted out — the 500M cap
 * only ever tightens. NOT the treasury: that would be the operator profiting
 * from player inattention on a money surface).
 *
 * Lazy, bounded, and deliberately NOT gated on ENABLE_WORKERS (the R9 entry
 * crediting incident): a worker may pre-warm this, the lazy path stays the
 * source of truth.
 */
export async function expireDueForgeAllocations(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - FORGE.claimWindowDays * 86_400_000);
  const due = await db.select().from(forgeContributions).where(and(
    isNotNull(forgeContributions.keepEscrowTxnId),
    isNull(forgeContributions.claimedAt),
    isNull(forgeContributions.expiredAt),
    lte(forgeContributions.settledAt, cutoff),
  )).orderBy(asc(forgeContributions.day)).limit(FORGE.expireBatchMax);

  let swept = 0;
  for (const r of due) {
    const payout = r.keepPaid ?? 0n;
    if (payout <= 0n) continue;
    await db.transaction(async (tx) => {
      // Domain row first, then the custody latch. The operator's full NOWAIT
      // barrier refuses busy writers; expiry never acquires the latch ahead
      // of its allocation lock or sweeps a row selected before fencing.
      const [locked] = await tx.select({ id: forgeContributions.id })
        .from(forgeContributions).where(eq(forgeContributions.id, r.id)).for('update');
      if (!locked) return;
      const latch = await tx.execute<{ phase: string }>(sql`select public.shardkeep_keep_custody_phase_locked() as phase`);
      if (latch[0]?.phase !== 'open') return;
      // Same claim-gate-then-post ordering: whoever stamps expired_at owns the
      // sweep, and a racing CLAIM that already stamped claimed_at wins instead.
      const won = await tx.update(forgeContributions)
        .set({ expiredAt: now })
        .where(and(
          eq(forgeContributions.id, r.id),
          isNull(forgeContributions.claimedAt), isNull(forgeContributions.expiredAt),
        ))
        .returning({ id: forgeContributions.id });
      if (won.length === 0) return;
      const sys = await bootstrapSystemAccounts(tx);
      const posted = await postTransaction(tx, {
        idempotencyKey: `forge-expire:${r.day}:${r.playerWallet}`,
        type: 'forge.expire',
        entries: [
          { account: sys.forge_payout_escrow, delta: -payout },
          { account: sys.emission_pool, delta: payout },
        ],
        metadata: { day: r.day, wallet: r.playerWallet },
      });
      if (posted.duplicate) throw new Error(`forge expire ${r.day}/${r.playerWallet}: expire key already used — refusing to sweep`);
      swept += 1;
    });
  }
  const remaining = Math.max(0, FORGE.expireBatchMax - swept);
  if (remaining === 0) return swept;
  const baseDue = await db.select().from(baseForgePositions).where(and(
    isNotNull(baseForgePositions.keepEscrowTxnId),
    isNull(baseForgePositions.claimedAt),
    isNull(baseForgePositions.expiredAt),
    lte(baseForgePositions.settledAt, cutoff),
  )).orderBy(asc(baseForgePositions.day), asc(baseForgePositions.baseId)).limit(remaining);
  for (const row of baseDue) {
    const payout = row.keepPaid ?? 0n;
    if (payout <= 0n) continue;
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(baseForgePositions)
        .where(eq(baseForgePositions.id, row.id)).for('update');
      if (!locked || locked.claimedAt || locked.expiredAt) return;
      if (!locked.settledAt || locked.settledAt > cutoff) return;
      // Recheck under the domain lock even if candidate selection saw OPEN.
      // The latch's shared lock holds that decision through the expiry commit.
      const latch = await tx.execute<{ phase: string }>(sql`select public.shardkeep_keep_custody_phase_locked() as phase`);
      if (latch[0]?.phase !== 'open') return;
      const sys = await bootstrapSystemAccounts(tx);
      const posted = await postTransaction(tx, {
        idempotencyKey: `forge-expire:base:${locked.day}:${locked.baseId}`,
        type: 'forge.expire',
        entries: [
          { account: sys.forge_payout_escrow, delta: -payout },
          { account: sys.emission_pool, delta: payout },
        ],
        metadata: { day: locked.day, baseId: locked.baseId },
      });
      if (posted.duplicate) {
        throw new Error(`base Forge expire ${locked.day}/${locked.baseId}: expire key already used`);
      }
      const won = await tx.update(baseForgePositions).set({
        expiredAt: now, expireTxnId: posted.transaction.id, updatedAt: now,
      }).where(and(
        eq(baseForgePositions.id, locked.id),
        isNull(baseForgePositions.claimedAt), isNull(baseForgePositions.expiredAt),
      )).returning({ id: baseForgePositions.id });
      if (won.length !== 1) throw new Error(`base Forge expire ${locked.day}/${locked.baseId}: row gate lost under lock`);
      swept += 1;
    });
  }
  return swept;
}

/**
 * The caller's OWN allocation history — keyset on day DESC (`before` exclusive).
 * Own rows only: another player's claim status flags an inactive account
 * sitting on value, and their itemDropped reveals who holds the Warzone Aegis.
 */
export async function getForgeAllocations(
  db: Db, wallet: string, opts: { before?: string; limit?: number } = {}, now = new Date(),
  baseId?: string, stableContext?: ForgeStableBaseContext,
) {
  await settleDueForgeDays(db, now);
  await expireDueForgeAllocations(db, now);
  const limit = Math.min(Math.max(opts.limit ?? FORGE.historyPageDays, 1), FORGE.historyMaxPageDays);
  if (baseId) {
    if (!stableContext) throw new HttpError(409, 'baseId requires deed authority', 'BASE_NOT_OWNED');
    return db.transaction(async (tx) => {
      const active = await stableContext.assertActiveAuthority(tx, wallet);
      if (!active.some((base) => base.id === baseId && base.landPaidAt)) {
        throw new HttpError(409, 'selected land base changed', 'DEED_OWNERSHIP_CHANGED');
      }
      // Keep the deed row lock held through every private read. A sale that
      // starts after authority validation must wait instead of letting the
      // seller read the buyer's newly-acquired Forge ledger through a TOCTOU.
      const rows = await tx.select().from(baseForgePositions)
        .where(opts.before
          ? and(eq(baseForgePositions.baseId, baseId), lt(baseForgePositions.day, opts.before))
          : eq(baseForgePositions.baseId, baseId))
        .orderBy(desc(baseForgePositions.day)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const all = await tx.select().from(baseForgePositions)
        .where(eq(baseForgePositions.baseId, baseId));
      const totals = all.reduce((sum, row) => {
        const status = forgeRowStatus(row);
        const keep = row.keepPaid ?? 0n;
        return {
          keepClaimed: sum.keepClaimed + (status === 'claimed' ? keep : 0n),
          keepClaimable: sum.keepClaimable + (status === 'claimable' ? keep : 0n),
          keepExpired: sum.keepExpired + (status === 'expired' ? keep : 0n),
          shardsBurned: sum.shardsBurned + (row.countedShards ?? 0n),
          itemsWon: sum.itemsWon + ((row.itemsDropped as string[]).length),
        };
      }, { keepClaimed: 0n, keepClaimable: 0n, keepExpired: 0n, shardsBurned: 0n, itemsWon: 0 });
      return {
        days: page.map((row) => {
          const drops = row.itemsDropped as string[];
          const status = forgeRowStatus(row);
          return {
            day: row.day,
            shards: netBasePosition(row).toString(),
            counted: (row.countedShards ?? 0n).toString(),
            keepPaid: (row.keepPaid ?? 0n).toString(),
            shardsRefunded: '0',
            itemDropped: drops[0] ?? null,
            itemsDropped: drops,
            settledAt: row.settledAt,
            status,
            claimedAt: row.claimedAt,
            expiresAt: row.settledAt && status === 'claimable' ? forgeExpiresAt(row.settledAt) : null,
          };
        }),
        nextBefore: rows.length > limit ? page[page.length - 1]!.day : null,
        totals: {
          keepClaimed: totals.keepClaimed.toString(),
          keepClaimable: totals.keepClaimable.toString(),
          keepExpired: totals.keepExpired.toString(),
          shardsBurned: totals.shardsBurned.toString(),
          itemsWon: totals.itemsWon,
        },
      };
    });
  }
  const rows = await db.select().from(forgeContributions)
    .where(opts.before
      ? and(eq(forgeContributions.playerWallet, wallet), lt(forgeContributions.day, opts.before))
      : eq(forgeContributions.playerWallet, wallet))
    .orderBy(desc(forgeContributions.day))
    .limit(limit + 1); // +1 probes for a next page without a second query

  const page = rows.slice(0, limit);
  const all = await db.select().from(forgeContributions)
    .where(eq(forgeContributions.playerWallet, wallet));
  const totals = all.reduce((a, r) => {
    const st = forgeRowStatus(r);
    const keep = r.keepPaid ?? 0n;
    return {
      // 'claimed' and 'paid_legacy' are the same thing to a player: the KEEP is
      // in their balance. Splitting them in the totals strip would be noise.
      keepClaimed: a.keepClaimed + (st === 'claimed' || st === 'paid_legacy' ? keep : 0n),
      keepClaimable: a.keepClaimable + (st === 'claimable' ? keep : 0n),
      keepExpired: a.keepExpired + (st === 'expired' ? keep : 0n),
      shardsBurned: a.shardsBurned + (r.settledAt ? r.shards - (r.shardsRefunded ?? 0n) : 0n),
      itemsWon: a.itemsWon + (r.itemDropped ? 1 : 0),
    };
  }, { keepClaimed: 0n, keepClaimable: 0n, keepExpired: 0n, shardsBurned: 0n, itemsWon: 0 });

  return {
    days: page.map((r) => ({
      day: r.day,
      shards: r.shards.toString(),
      counted: (r.shards - (r.shardsRefunded ?? 0n)).toString(), // derived, not a column
      keepPaid: (r.keepPaid ?? 0n).toString(),
      shardsRefunded: (r.shardsRefunded ?? 0n).toString(),
      itemDropped: r.itemDropped,
      settledAt: r.settledAt,
      status: forgeRowStatus(r),
      claimedAt: r.claimedAt,
      expiresAt: r.settledAt && forgeRowStatus(r) === 'claimable' ? forgeExpiresAt(r.settledAt) : null,
    })),
    nextBefore: rows.length > limit ? page[page.length - 1]!.day : null,
    totals: {
      keepClaimed: totals.keepClaimed.toString(),
      keepClaimable: totals.keepClaimable.toString(),
      keepExpired: totals.keepExpired.toString(),
      shardsBurned: totals.shardsBurned.toString(),
      itemsWon: totals.itemsWon,
    },
  };
}

/** Server-side wallet abbreviation for the PUBLIC global list. */
function shortWallet(w: string): string {
  return `${w.slice(0, FORGE.globalWalletHeadChars)}…${w.slice(-FORGE.globalWalletTailChars)}`;
}

interface GlobalCursor { k: string; w: string; r: number }

function encodeCursor(c: GlobalCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(s: string): GlobalCursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as GlobalCursor;
    if (typeof c.k !== 'string' || typeof c.w !== 'string' || typeof c.r !== 'number') throw new Error('shape');
    BigInt(c.k); // throws on a non-numeric k
    return c;
  } catch {
    throw new HttpError(422, 'bad cursor');
  }
}

/** One relic drop as the PUBLIC feed shows it — nothing per-viewer here. */
export interface ForgeRecentDrop {
  /** UTC cycle the relic was rolled in. */
  day: string;
  settledAt: string;
  itemId: string;
  name: string;
  rarity: ItemRarity | null;
  /** The deed's owner AT SETTLEMENT (audit column) — the person who won it,
   * even if the deed and its relic have since changed hands. Abbreviated
   * server-side like /forge/global; the full address never leaves. */
  winner: { name: string; walletShort: string; seeker: boolean };
}

let recentDropsCache: { at: number; rows: ForgeRecentDrop[] } | null = null;

/** Test seam — the cache is process-wide and time-keyed. */
export function resetRecentForgeDropsCache(): void { recentDropsCache = null; }

/**
 * PUBLIC recent relic drops — who won which relic in which cycle (tester
 * 69arc, report 0d1b6d9d: the Forge screen only showed the KEEP cycle, so
 * players could not tell whether drops really happen).
 *
 * Contract:
 *  - UNCREDENTIALED and viewer-agnostic, so it is cached IN-PROCESS for
 *    FORGE.recentDropsCacheSec (the mapCache reasoning: Redis is workers-only
 *    and must not become a request-path dependency). One query per window
 *    serves every viewer; `limit` only slices the cached page.
 *  - Bounded: at most FORGE.recentDropsMaxPageSize rows, newest settlement
 *    first. Deed-native positions only — the retired wallet-keyed path
 *    (forgeContributions.itemDropped) predates the D-035 cutover and cannot
 *    be "recent".
 *  - Privacy: abbreviated wallet + display name + Seeker badge, exactly the
 *    /forge/global row identity. No base ids, claim status or balances.
 *  - Read-only: no lazy settlement here. GET /forge (which the same screen
 *    loads first) is where a due day settles; this feed must stay cheap.
 */
export async function getRecentForgeDrops(
  db: Db, opts: { limit?: number } = {}, nowMs = Date.now(),
): Promise<{ drops: ForgeRecentDrop[]; cacheSec: number }> {
  const limit = Math.min(Math.max(opts.limit ?? FORGE.recentDropsPageSize, 1), FORGE.recentDropsMaxPageSize);
  const ttlMs = FORGE.recentDropsCacheSec * 1000;
  if (!recentDropsCache || nowMs - recentDropsCache.at >= ttlMs || nowMs < recentDropsCache.at) {
    // Every position holds ≥ 1 item here, so `max` positions yield ≥ `max`
    // rows; the flatten is then sliced back to the ceiling.
    const positions = await db.select({
      day: baseForgePositions.day,
      settledAt: baseForgePositions.settledAt,
      itemsDropped: baseForgePositions.itemsDropped,
      wallet: players.wallet,
      name: players.name,
      seeker: players.seekerVerified,
    }).from(baseForgePositions)
      .innerJoin(players, eq(players.wallet, baseForgePositions.settlementOwnerWallet))
      .where(and(
        isNotNull(baseForgePositions.settledAt),
        sql`jsonb_array_length(${baseForgePositions.itemsDropped}) > 0`,
      ))
      .orderBy(desc(baseForgePositions.settledAt), desc(baseForgePositions.day), asc(baseForgePositions.baseId))
      .limit(FORGE.recentDropsMaxPageSize);
    const catalog = ITEMS as Record<string, { name: string; rarity: ItemRarity } | undefined>;
    const rows = positions.flatMap((position) => (position.itemsDropped as string[]).map((itemId) => ({
      day: position.day,
      settledAt: position.settledAt!.toISOString(),
      itemId,
      name: catalog[itemId]?.name ?? itemId,
      rarity: catalog[itemId]?.rarity ?? null,
      winner: { name: position.name, walletShort: shortWallet(position.wallet), seeker: position.seeker },
    }))).slice(0, FORGE.recentDropsMaxPageSize);
    recentDropsCache = { at: nowMs, rows };
  }
  return { drops: recentDropsCache.rows.slice(0, limit), cacheSec: FORGE.recentDropsCacheSec };
}

/**
 * PUBLIC per-day allocations for ONE SETTLED cycle.
 *
 * Only four fields per row leave the server — abbreviated wallet, name, Seeker
 * badge, contributed shards, KEEP allocated — all already public surfaces (map
 * roster, clan roster, raid log). What must NEVER leak, and why:
 *  - the FULL wallet: truncating in React still ships every address in the
 *    JSON, turning this into a one-request harvester that links in-game
 *    identity to on-chain holdings and withdrawal history;
 *  - claim status: "settled 12 days ago, still unclaimed" flags an inactive
 *    account sitting on value (raid-targeting + social-engineering signal);
 *  - itemDropped: not on THIS surface. (The Aegis-winner tactical-leak
 *    argument that once kept every drop private was overruled by the owner's
 *    transparency ask — tester 69arc, report 0d1b6d9d: players must SEE that
 *    drops happen. getRecentForgeDrops below publishes settled drops with
 *    the same abbreviated-wallet rule; this list stays KEEP-only.)
 *  - balances, forge level, caps: not on this surface at all.
 *
 * OPEN CYCLES ARE REFUSED. That is an economic rule before it is a privacy one:
 * live per-player positions let a whale size a contribution to sit exactly under
 * the 30% share cap while nobody can react, and time deposits against the soft
 * cap. Today's AGGREGATE total stays public (GET /forge needs it); today's
 * COMPOSITION does not.
 */
export async function getForgeGlobalDay(
  db: Db, wallet: string, opts: { day?: string; cursor?: string; limit?: number } = {}, now = new Date(),
) {
  await settleDueForgeDays(db, now);
  const today = forgeDayOf(now);

  // Selectable settled cycles, newest first.
  const legacyDayRows = await db.selectDistinct({ day: forgeContributions.day }).from(forgeContributions)
    .where(and(lt(forgeContributions.day, today), isNotNull(forgeContributions.settledAt)))
    .orderBy(desc(forgeContributions.day))
    .limit(FORGE.globalListDays);
  const baseDayRows = await db.selectDistinct({ day: baseForgePositions.day }).from(baseForgePositions)
    .where(and(lt(baseForgePositions.day, today), isNotNull(baseForgePositions.settledAt)))
    .orderBy(desc(baseForgePositions.day)).limit(FORGE.globalListDays);
  const days = [...new Set([...legacyDayRows, ...baseDayRows].map((row) => row.day))]
    .sort((a, b) => b.localeCompare(a)).slice(0, FORGE.globalListDays);

  const day = opts.day ?? days[0];
  if (!day) return { day: null, settled: false, totalShards: '0', distributedKeep: '0', contributors: 0, rows: [], nextCursor: null, me: null, days };
  if (day >= today) throw new HttpError(422, 'the current cycle is still open');

  const limit = Math.min(Math.max(opts.limit ?? FORGE.globalPageSize, 1), FORGE.globalMaxPageSize);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  const [hasBaseDay] = await db.select({ id: baseForgePositions.id }).from(baseForgePositions)
    .where(and(eq(baseForgePositions.day, day), isNotNull(baseForgePositions.settledAt))).limit(1);
  if (hasBaseDay) {
    const stableRows = await db.select({
      baseId: baseForgePositions.baseId,
      shards: baseForgePositions.countedShards,
      keepPaid: baseForgePositions.keepPaid,
      wallet: bases.ownerWallet,
      name: players.name,
      seeker: players.seekerVerified,
    }).from(baseForgePositions)
      .innerJoin(bases, eq(bases.id, baseForgePositions.baseId))
      .innerJoin(players, eq(players.wallet, bases.ownerWallet))
      .where(and(eq(baseForgePositions.day, day), isNotNull(baseForgePositions.settledAt)))
      .orderBy(desc(baseForgePositions.keepPaid), asc(baseForgePositions.baseId));
    // A rolling deployment may still have legitimate non-migrated legacy
    // contributors on the same day. Do not hide them merely because at least
    // one deed-native row exists; only migrated OPEN rows were copied, and they
    // remain unsettled in the legacy table, so settled rows cannot duplicate.
    const legacyRows = await db.select({
      wallet: forgeContributions.playerWallet,
      shards: forgeContributions.shards,
      keepPaid: forgeContributions.keepPaid,
      name: players.name,
      seeker: players.seekerVerified,
    }).from(forgeContributions)
      .innerJoin(players, eq(players.wallet, forgeContributions.playerWallet))
      .where(and(eq(forgeContributions.day, day), isNotNull(forgeContributions.settledAt)));
    const all = [
      ...stableRows.map((row) => ({ ...row, tieKey: row.baseId })),
      ...legacyRows.map((row) => ({ ...row, tieKey: row.wallet })),
    ].sort((a, b) => {
      const keepOrder = (b.keepPaid ?? 0n) > (a.keepPaid ?? 0n)
        ? 1 : (b.keepPaid ?? 0n) < (a.keepPaid ?? 0n) ? -1 : 0;
      return keepOrder || (a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0);
    });
    const afterCursor = cursor
      ? all.filter((row) => (row.keepPaid ?? 0n) < BigInt(cursor.k)
        || ((row.keepPaid ?? 0n) === BigInt(cursor.k) && row.tieKey > cursor.w))
      : all;
    const rows = afterCursor.slice(0, limit + 1);
    const page = rows.slice(0, limit);
    const rankFrom = cursor?.r ?? 0;
    const mine = all.find((row) => row.wallet === wallet);
    const mineRank = mine ? all.findIndex((row) => row.tieKey === mine.tieKey) + 1 : 0;
    return {
      day,
      settled: true,
      totalShards: all.reduce((sum, row) => sum + (row.shards ?? 0n), 0n).toString(),
      distributedKeep: all.reduce((sum, row) => sum + (row.keepPaid ?? 0n), 0n).toString(),
      contributors: all.length,
      rows: page.map((row, index) => ({
        rank: rankFrom + index + 1,
        walletShort: shortWallet(row.wallet),
        name: row.name,
        seeker: row.seeker,
        shards: (row.shards ?? 0n).toString(),
        keepPaid: (row.keepPaid ?? 0n).toString(),
      })),
      nextCursor: rows.length > limit && page.length > 0
        ? encodeCursor({
          k: (page[page.length - 1]!.keepPaid ?? 0n).toString(),
          w: page[page.length - 1]!.tieKey,
          r: rankFrom + page.length,
        })
        : null,
      me: mine ? {
        rank: mineRank,
        walletShort: shortWallet(wallet),
        name: mine.name,
        seeker: mine.seeker,
        shards: (mine.shards ?? 0n).toString(),
        keepPaid: (mine.keepPaid ?? 0n).toString(),
      } : null,
      days,
    };
  }

  // Keyset on (keep_paid DESC, player_wallet ASC) — a TOTAL order, so ranks are
  // stable and tie-free and no OFFSET scan is needed.
  const after = cursor
    ? sql`(${forgeContributions.keepPaid}, ${forgeContributions.playerWallet}) < (${BigInt(cursor.k)}::bigint, ${cursor.w}::text)`
    : undefined;
  const rows = await db.select({
    wallet: forgeContributions.playerWallet,
    shards: forgeContributions.shards,
    keepPaid: forgeContributions.keepPaid,
    name: players.name,
    seeker: players.seekerVerified,
  }).from(forgeContributions)
    .innerJoin(players, eq(players.wallet, forgeContributions.playerWallet))
    .where(after ? and(eq(forgeContributions.day, day), after) : eq(forgeContributions.day, day))
    .orderBy(desc(forgeContributions.keepPaid), asc(forgeContributions.playerWallet))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const rankFrom = cursor?.r ?? 0;
  const [agg] = await db.select({
    totalShards: sql<string>`coalesce(sum(${forgeContributions.shards}), 0)::text`,
    distributedKeep: sql<string>`coalesce(sum(${forgeContributions.keepPaid}), 0)::text`,
    contributors: sql<number>`count(*)::int`,
    settled: sql<number>`count(${forgeContributions.settledAt})::int`,
  }).from(forgeContributions).where(eq(forgeContributions.day, day));

  // `me`: one index-only count of the strictly-better rows.
  const [mine] = await db.select({ shards: forgeContributions.shards, keepPaid: forgeContributions.keepPaid })
    .from(forgeContributions)
    .where(and(eq(forgeContributions.day, day), eq(forgeContributions.playerWallet, wallet)));
  let me = null;
  if (mine) {
    const [aheadRow] = await db.select({ ahead: sql<number>`count(*)::int` }).from(forgeContributions)
      .where(and(eq(forgeContributions.day, day),
        sql`(${forgeContributions.keepPaid}, ${forgeContributions.playerWallet}) > (${mine.keepPaid ?? 0n}::bigint, ${wallet}::text)`));
    const [self] = await db.select({ name: players.name, seeker: players.seekerVerified })
      .from(players).where(eq(players.wallet, wallet));
    me = {
      rank: (aheadRow?.ahead ?? 0) + 1,
      walletShort: shortWallet(wallet),
      name: self?.name ?? '',
      seeker: self?.seeker ?? false,
      shards: mine.shards.toString(),
      keepPaid: (mine.keepPaid ?? 0n).toString(),
    };
  }

  return {
    day,
    settled: (agg?.settled ?? 0) > 0,
    totalShards: agg?.totalShards ?? '0',
    distributedKeep: agg?.distributedKeep ?? '0',
    contributors: agg?.contributors ?? 0,
    rows: page.map((r, i) => ({
      rank: rankFrom + i + 1,
      walletShort: shortWallet(r.wallet), // NEVER the full address
      name: r.name,
      seeker: r.seeker,
      shards: r.shards.toString(),
      keepPaid: (r.keepPaid ?? 0n).toString(),
    })),
    nextCursor: rows.length > limit && page.length > 0
      ? encodeCursor({
        k: (page[page.length - 1]!.keepPaid ?? 0n).toString(),
        w: page[page.length - 1]!.wallet,
        r: rankFrom + page.length,
      })
      : null,
    me,
    days,
  };
}

/**
 * KEEP → shards converter (plan §3, the whale fast-lane): one-way at the
 * authoritative ECONOMY.shardsPerKeep rate.
 * The KEEP RECYCLES to emission_pool (it becomes future forge budget — the
 * redistribution flywheel), and matching shards mint from shard_genesis.
 * ONE-WAY BY DESIGN: shards→KEEP happens only through the forge's daily,
 * capped, sub-parity settlement — a direct reverse would be a free mint.
 */
export async function convertKeepToShards(
  db: Db, wallet: string, keep: bigint, idempotencyKey: string,
  baseId?: string, stableContext?: StableBaseMutationContext,
) {
  if (keep <= 0n) throw new HttpError(422, 'convert a positive KEEP amount');
  const shards = keep * BigInt(ECONOMY.shardsPerKeep);
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    if (baseId) {
      if (!stableContext || stableContext.baseId !== baseId) {
        throw new HttpError(409, 'base authority context does not match target', 'BASE_NOT_OWNED');
      }
      await lockStablePrerequisiteBase(tx, wallet, stableContext);
    }
    const sys = await bootstrapSystemAccounts(tx);
    const keepAcct = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
    const shardAcct = baseId
      ? await getOrCreateBaseAccount(tx, baseId, 'base_shards')
      : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
    // NAMESPACED keys (security review 2026-07-24 #3): a raw client key here
    // could be crafted to equal a settlement key and swallow a victim's payout.
    const keepPost = await postTransaction(tx, {
      idempotencyKey: `convert:${wallet}:${idempotencyKey}:keep`,
      type: 'forge.convert',
      entries: [
        { account: keepAcct.id, delta: -keep },
        { account: sys.emission_pool, delta: keep }, // recycles into future budgets
      ],
      metadata: {
        wallet, ...(baseId ? { baseId } : {}),
        keep: keep.toString(), shards: shards.toString(), rate: ECONOMY.shardsPerKeep,
      },
    });
    const originalKeepDebit = keepPost.entries.find((e) => e.accountId === keepAcct.id)?.delta;
    if (originalKeepDebit !== -keep) {
      throw new HttpError(409, 'idempotency key was already used with a different conversion amount');
    }
    const shardPost = await postTransaction(tx, {
      idempotencyKey: `convert:${wallet}:${idempotencyKey}:shards`,
      type: 'forge.convert',
      entries: [
        { account: sys.shard_genesis, delta: -shards },
        { account: shardAcct.id, delta: shards },
      ],
      metadata: {
        wallet, ...(baseId ? { baseId } : {}),
        keep: keep.toString(), shards: shards.toString(), rate: ECONOMY.shardsPerKeep,
      },
    });
    const originalShardCredit = shardPost.entries.find((e) => e.accountId === shardAcct.id)?.delta;
    if (originalShardCredit !== shards) {
      throw new HttpError(409, 'idempotency key was already used with a different conversion amount');
    }
    return { converted: keep.toString(), shards: shards.toString(), rate: ECONOMY.shardsPerKeep };
  });
}

/** Forge status for the UI: today's pool + my stake + yesterday's result. */
export async function getForgeStatus(
  db: Db, wallet: string, now = new Date(), baseId?: string,
  stableContext?: ForgeStableBaseContext,
) {
  await settleDueForgeDays(db, now);
  await expireDueForgeAllocations(db, now);
  const today = forgeDayOf(now);
  if (baseId) {
    if (!stableContext) throw new HttpError(409, 'baseId requires deed authority', 'BASE_NOT_OWNED');
    return db.transaction(async (tx) => {
      const active = await stableContext.assertActiveAuthority(tx, wallet);
      if (!active.some((base) => base.id === baseId && base.landPaidAt)) {
        throw new HttpError(409, 'selected land base changed', 'DEED_OWNERSHIP_CHANGED');
      }
      const [position] = await tx.select().from(baseForgePositions).where(and(
        eq(baseForgePositions.day, today), eq(baseForgePositions.baseId, baseId),
      ));
      const allBaseToday = await tx.select().from(baseForgePositions)
        .where(eq(baseForgePositions.day, today));
      const legacyToday = await tx.select({ shards: forgeContributions.shards })
        .from(forgeContributions).where(and(
          eq(forgeContributions.day, today),
          sql`not exists (select 1 from ${baseEconomyBackfills} bf where bf.legacy_wallet = ${forgeContributions.playerWallet})`,
        ));
      const total = allBaseToday.reduce((sum, row) => sum + netBasePosition(row), 0n)
        + legacyToday.reduce((sum, row) => sum + row.shards, 0n);
      const shardAcct = await getOrCreateBaseAccount(tx, baseId, 'base_shards');
      const goldforgeLevel = await goldforgeLevelOf(tx, wallet, baseId);
      const myDailyCap = contributionCapForLevel(goldforgeLevel);
      const myShards = position
        ? position.contributedShards - position.raidDebitedShards : 0n;
      const claimableRows = await tx.select().from(baseForgePositions)
        .where(baseClaimablePredicate(baseId, now)).orderBy(asc(baseForgePositions.day));
      const firstClaimable = claimableRows[0];
      const yesterday = forgeDayOf(new Date(now.getTime() - 86_400_000));
      const [yRow] = await tx.select().from(baseForgePositions).where(and(
        eq(baseForgePositions.day, yesterday), eq(baseForgePositions.baseId, baseId),
      ));
      const cycleEndsAt = forgeCycleEndsAt(now);
      return {
        day: today,
        serverNow: now,
        cycleEndsAt,
        cycleEndsInSec: Math.max(0, Math.round((cycleEndsAt.getTime() - now.getTime()) / 1_000)),
        dailyEmissionKeep: FORGE.dailyEmissionKeep,
        softCapShards: FORGE.softCapShards,
        maxDailyShareBps: FORGE.maxDailyShareBps,
        totalShards: total.toString(),
        myShards: myShards.toString(),
        myShardBalance: shardAcct.balance.toString(),
        goldforgeLevel,
        myDailyCapShards: myDailyCap.toString(),
        drops: {
          independentDropBps: FORGE_DROPS.independentDropBps,
        },
        claimable: {
          count: claimableRows.length,
          totalKeep: claimableRows.reduce((sum, row) => sum + (row.keepPaid ?? 0n), 0n).toString(),
          days: claimableRows.map((row) => row.day),
          nextExpiresAt: firstClaimable?.settledAt ? forgeExpiresAt(firstClaimable.settledAt) : null,
        },
        yesterday: yRow ? {
          shards: netBasePosition(yRow).toString(),
          keepPaid: (yRow.keepPaid ?? 0n).toString(),
          shardsRefunded: '0',
          itemDropped: (yRow.itemsDropped as string[])[0] ?? null,
          itemsDropped: yRow.itemsDropped as string[],
          status: forgeRowStatus(yRow),
        } : null,
      };
    });
  }
  const rows = await db.select().from(forgeContributions).where(eq(forgeContributions.day, today));
  const total = rows.reduce((a, r) => a + r.shards, 0n);
  const mine = rows.find((r) => r.playerWallet === wallet)?.shards ?? 0n;
  const shardAcct = await getOrCreatePlayerAccount(db, wallet, 'player_shards');
  const goldforgeLevel = await goldforgeLevelOf(db, wallet, baseId);
  const myDailyCap = contributionCapForLevel(goldforgeLevel);
  const yesterday = forgeDayOf(new Date(now.getTime() - 86_400_000));
  const [yRow] = await db.select().from(forgeContributions)
    .where(and(eq(forgeContributions.day, yesterday), eq(forgeContributions.playerWallet, wallet)));
  // Claimable spans the WHOLE open window, not just yesterday: a today/
  // yesterday-only view hides the payout of a player who was away three days.
  const claimableRows = await db.select({
    day: forgeContributions.day, keepPaid: forgeContributions.keepPaid, settledAt: forgeContributions.settledAt,
  }).from(forgeContributions).where(claimablePredicate(wallet, now)).orderBy(asc(forgeContributions.day));
  const firstClaimable = claimableRows[0];

  const cycleEndsAt = forgeCycleEndsAt(now);
  return {
    day: today,
    /** The cycle clock is SERVER-computed: `cycleEndsInSec` is what the client
     * counts down from, so a skewed device clock cannot show a pour that
     * already happened (or one hours away). */
    serverNow: now,
    cycleEndsAt,
    cycleEndsInSec: Math.max(0, Math.round((cycleEndsAt.getTime() - now.getTime()) / 1000)),
    dailyEmissionKeep: FORGE.dailyEmissionKeep,
    softCapShards: FORGE.softCapShards,
    maxDailyShareBps: FORGE.maxDailyShareBps,
    totalShards: total.toString(),
    myShards: mine.toString(),
    myShardBalance: shardAcct.balance.toString(),
    /** Gold Forge BUILDING level (0 = none/under construction) + its daily cap. */
    goldforgeLevel,
    myDailyCapShards: myDailyCap.toString(),
    /** Advertised daily drops (FORGE_DROPS) — the UI's "daily drops" panel.
     * Random eligible contributors win; amount doesn't matter. */
    drops: {
      independentDropBps: FORGE_DROPS.independentDropBps,
      minCountedShards: FORGE_DROPS.minCountedShards,
      table: FORGE_DROPS.table.map((d) => ({ itemId: d.itemId, dailyLimit: d.dailyLimit })),
    },
    /** Everything settled and still waiting in forge_payout_escrow. */
    claimable: {
      count: claimableRows.length,
      totalKeep: claimableRows.reduce((a, r) => a + (r.keepPaid ?? 0n), 0n).toString(),
      days: claimableRows.map((r) => r.day),
      nextExpiresAt: firstClaimable?.settledAt ? forgeExpiresAt(firstClaimable.settledAt) : null,
    },
    yesterday: yRow ? {
      shards: yRow.shards.toString(),
      keepPaid: (yRow.keepPaid ?? 0n).toString(),
      shardsRefunded: (yRow.shardsRefunded ?? 0n).toString(),
      itemDropped: yRow.itemDropped,
      status: forgeRowStatus(yRow),
    } : null,
  };
}
