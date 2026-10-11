import { markRaidBaseChanged } from '../lib/raidEventBus';
/**
 * Private, deed-scoped raid loot reservation and terminal settlement.
 *
 * A raid never reads a wallet-wide SHARDS balance. At creation we atomically
 * freeze the lootable half of this deed's liquid + open-Forge wealth in the
 * named ledger escrow and detach every physical Mine's accrued buffer. The sim
 * later decides stars and which physical Vaults/Mines fell; settlement pays
 * exactly that deterministic result, or release restores every frozen source.
 */
import { createHash } from 'node:crypto';
import { LOOT, MINING, standingVaultLevel, vaultExposureBps } from '@shardkeep/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx, DbTx } from '../db/client';
import { freezeRawRaidLoot, releaseRawRaidLoot, settleRawRaidLoot } from './rawRaidLoot';
import {
  baseForgePositions,
  baseRaidLocks,
  accounts,
  buildings,
  ledgerEntries,
  mineAccrualStates,
  raidLootReservations,
  raidMineLootReservations,
} from '../db/schema';
import { bootstrapSystemAccounts, getOrCreateBaseAccount } from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';
import {
  currentMineStorageCap, projectMineFill, reanchorBaseMineAccrual, discardFullMineProductionFraction,
} from './baseMining';

import { reservePhysicalMineTaxSegments, restorePhysicalMineTaxSegments, planPhysicalMineRaidIssue, finishPhysicalMineIssue, readPhysicalMineRaidNet } from '../mining/shardsTaxMineAccounting';

type Stars = 0 | 1 | 2 | 3;

export interface RaidBuildingResult {
  id: string;
  type: string;
  destroyed: boolean;
  /** Frozen snapshot level. D-065 (formula v2) reads it for Vaults only: the
   * highest STANDING Vault shields part of the pool. Omitted ⇒ level 1, the
   * weakest protection, so a missing level never over-protects a defender. */
  level?: number;
}

export interface RaidLootSettlement {
  total: bigint;
  balance: bigint;
  mines: bigint;
  fromLiquid: bigint;
  fromOpenForge: bigint;
}

function bps(amount: bigint, factor: number): bigint {
  return amount * BigInt(factor) / 10_000n;
}

function canonicalSnapshot(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshot).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSnapshot(item)}`).join(',')}}`;
}

function privateHash(value: unknown): string {
  return createHash('sha256').update(canonicalSnapshot(value)).digest('hex');
}

/** Split an amount proportionally, assigning the rounding remainder to Forge. */
function splitByReserved(
  amount: bigint, liquidReserved: bigint, forgeReserved: bigint,
): { liquid: bigint; forge: bigint } {
  const total = liquidReserved + forgeReserved;
  if (amount === 0n || total === 0n) return { liquid: 0n, forge: 0n };
  const liquid = amount * liquidReserved / total;
  return { liquid, forge: amount - liquid };
}

/**
 * Freeze exact private sources. Must run after the raid row and defender lock
 * are inserted, inside the same create transaction.
 */
async function reserveDeedRaidLootLocked(
  tx: DbTx,
  input: {
    raidId: string;
    attackerBaseId: string;
    defenderBaseId: string;
    now: Date;
  },
): Promise<{ balancePool: bigint; mines: bigint; maximum: bigint }> {
  await reanchorBaseMineAccrual(tx, input.defenderBaseId, input.now);

  const liquidRef = await getOrCreateBaseAccount(tx, input.defenderBaseId, 'base_shards');
  const forgeRef = await getOrCreateBaseAccount(tx, input.defenderBaseId, 'base_forge_escrow');
  const lockedAccounts = await tx.select().from(accounts)
    .where(inArray(accounts.id, [liquidRef.id, forgeRef.id].sort()))
    .orderBy(asc(accounts.id)).for('update');
  const liquid = lockedAccounts.find((account) => account.id === liquidRef.id);
  const forge = lockedAccounts.find((account) => account.id === forgeRef.id);
  if (!liquid || !forge) throw new Error(`deed loot accounts vanished for ${input.defenderBaseId}`);
  const available = liquid.balance + forge.balance;
  const balancePool = bps(available, LOOT.balanceLootableBps);
  const spendableReservedShards = available === 0n
    ? 0n : balancePool * liquid.balance / available;
  const forgeReservedShards = balancePool - spendableReservedShards;

  const mineRows = await tx.select({
    id: buildings.id,
    accrued: mineAccrualStates.accruedShards,
    version: mineAccrualStates.version,
  }).from(buildings).innerJoin(
    mineAccrualStates,
    eq(mineAccrualStates.mineBuildingId, buildings.id),
  ).where(and(
    eq(buildings.baseId, input.defenderBaseId),
    eq(buildings.type, 'mine'),
  )).orderBy(asc(buildings.id)).for('update');
  const mineReservedShards = mineRows.reduce((sum, row) => sum + row.accrued, 0n);

  let reserveLedgerTxnId: string | null = null;
  if (balancePool > 0n) {
    const sys = await bootstrapSystemAccounts(tx);
    const entries = [
      ...(spendableReservedShards > 0n
        ? [{ account: liquid.id, delta: -spendableReservedShards }] : []),
      ...(forgeReservedShards > 0n
        ? [{ account: forge.id, delta: -forgeReservedShards }] : []),
      { account: sys.raid_loot_escrow, delta: balancePool },
    ];
    const posted = await postTransaction(tx, {
      idempotencyKey: `raid:${input.raidId}:loot-reserve`,
      type: 'raid.loot.reserve',
      entries,
      metadata: {
        raidId: input.raidId,
        attackerBaseId: input.attackerBaseId,
        defenderBaseId: input.defenderBaseId,
      },
    });
    reserveLedgerTxnId = posted.transaction.id;
  }

  await tx.insert(raidLootReservations).values({
    raidId: input.raidId,
    formulaVersion: LOOT.formulaVersion,
    attackerBaseId: input.attackerBaseId,
    defenderBaseId: input.defenderBaseId,
    spendableReservedShards,
    forgeReservedShards,
    mineReservedShards,
    privateSnapshotHash: privateHash({
      formulaVersion: LOOT.formulaVersion,
      attackerBaseId: input.attackerBaseId,
      defenderBaseId: input.defenderBaseId,
      liquid: liquid.balance.toString(),
      forge: forge.balance.toString(),
      mines: mineRows.map((mine) => [mine.id, mine.accrued.toString()]),
    }),
    reserveLedgerTxnId,
    reservedAt: input.now,
  });

  if (mineRows.length > 0) {
    await tx.insert(raidMineLootReservations).values(mineRows.map((mine) => ({
      raidId: input.raidId,
      mineBuildingId: mine.id,
      frozenShards: mine.accrued,
    })));
    for (const mine of mineRows) {
      await reservePhysicalMineTaxSegments(tx, input.raidId, mine.id, mine.accrued);
      const updated = await tx.update(mineAccrualStates).set({
        accruedShards: 0n,
        lastAccrualAt: input.now,
        // Reservation is temporary, so retain the cycle but take its due row
        // out of the sweep until terminal award/restoration decides the buffer.
        fullNotificationCheckAt: null,
        version: mine.version + 1,
      }).where(and(
        eq(mineAccrualStates.mineBuildingId, mine.id),
        eq(mineAccrualStates.version, mine.version),
      )).returning({ id: mineAccrualStates.mineBuildingId });
      if (updated.length !== 1) throw new Error(`Mine reservation version race for ${mine.id}`);
    }
  }

  return {
    balancePool,
    mines: mineReservedShards,
    maximum: balancePool + mineReservedShards,
  };
}

async function lockReservation(tx: DbOrTx, raidId: string) {
  const [reservation] = await tx.select().from(raidLootReservations)
    .where(eq(raidLootReservations.raidId, raidId)).for('update');
  if (!reservation) throw new Error(`raid ${raidId} has no deed loot reservation`);
  return reservation;
}

async function releaseConditionalBaseLock(
  tx: DbOrTx, raidId: string, defenderBaseId: string,
): Promise<void> {
  const [lock] = await tx.select().from(baseRaidLocks).where(and(
    eq(baseRaidLocks.raidId, raidId),
    eq(baseRaidLocks.baseId, defenderBaseId),
  )).for('update');
  if (!lock) throw new Error(`raid ${raidId} lost its defender base lock before terminal settlement`);
  const deleted = await tx.delete(baseRaidLocks).where(and(
    eq(baseRaidLocks.raidId, raidId),
    eq(baseRaidLocks.baseId, defenderBaseId),
    eq(baseRaidLocks.token, lock.token),
  )).returning({ id: baseRaidLocks.raidId });
  if (deleted.length !== 1) throw new Error(`raid ${raidId} base-lock token was superseded`);
  markRaidBaseChanged(tx, defenderBaseId);
}

/** Terminal lock release for paths that have no deed loot reservation. */
export async function releaseDeedRaidLock(
  tx: DbOrTx, raidId: string, defenderBaseId: string,
): Promise<void> {
  await releaseConditionalBaseLock(tx, raidId, defenderBaseId);
}

async function restoreOrAwardMines(
  tx: DbOrTx,
  raidId: string,
  destroyedMineIds: ReadonlySet<string>,
  victory: boolean,
  now: Date,
): Promise<bigint> {
  const rows = await tx.select().from(raidMineLootReservations)
    .where(eq(raidMineLootReservations.raidId, raidId))
    .orderBy(asc(raidMineLootReservations.mineBuildingId)).for('update');
  let awarded = 0n;
  for (const row of rows) {
    const mineAward = victory && destroyedMineIds.has(row.mineBuildingId)
      ? row.frozenShards : 0n;
    const restore = row.frozenShards - mineAward;
    const cap = await currentMineStorageCap(tx, row.mineBuildingId, now);
    const [priorState] = await tx.select().from(mineAccrualStates)
      .where(eq(mineAccrualStates.mineBuildingId, row.mineBuildingId)).for('update');
    if (!priorState) throw new Error(`reserved Mine ${row.mineBuildingId} vanished`);
    await restorePhysicalMineTaxSegments(tx, raidId, row.mineBuildingId,
      mineAward > 0n, priorState.accruedShards, cap, now);
    let [state] = restore > 0n
      ? await tx.update(mineAccrualStates).set({
        accruedShards: sql`LEAST(${mineAccrualStates.accruedShards} + ${restore}, ${cap})`,
        version: sql`${mineAccrualStates.version} + 1`,
      }).where(eq(mineAccrualStates.mineBuildingId, row.mineBuildingId))
        .returning()
      : await tx.select().from(mineAccrualStates)
        .where(eq(mineAccrualStates.mineBuildingId, row.mineBuildingId)).for('update');
    if (!state) throw new Error(`reserved Mine ${row.mineBuildingId} vanished`);
    state = await discardFullMineProductionFraction(tx, row.mineBuildingId, cap, now);
    const quota = Number(cap / BigInt(MINING.MINE_STORAGE_DAYS));
    const projected = projectMineFill(state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder);
    const fullAtMs = projected.fullAtMs === null ? null : Number(projected.fullAtMs);
    const fullNotificationCheckAt = fullAtMs !== null && Number.isSafeInteger(fullAtMs)
      ? new Date(fullAtMs) : null;
    [state] = await tx.update(mineAccrualStates).set({
      // Only a positive terminal award permanently drained this Mine. A
      // reservation/release, a zero award, and restored remainder keep cycle.
      fullNotificationCycle: mineAward > 0n
        ? state.fullNotificationCycle + 1 : state.fullNotificationCycle,
      fullNotificationBootstrapPending: mineAward > 0n
        ? false : state.fullNotificationBootstrapPending,
      fullNotificationCheckAt,
    }).where(eq(mineAccrualStates.mineBuildingId, row.mineBuildingId)).returning();
    if (!state) throw new Error(`reserved Mine ${row.mineBuildingId} vanished during notification re-arm`);
    await tx.update(raidMineLootReservations).set({ awardedShards: mineAward }).where(and(
      eq(raidMineLootReservations.raidId, raidId),
      eq(raidMineLootReservations.mineBuildingId, row.mineBuildingId),
    ));
    awarded += mineAward;
  }
  return awarded;
}

async function attributeForgeTheft(
  tx: DbOrTx, defenderBaseId: string, amount: bigint, now: Date,
): Promise<void> {
  if (amount === 0n) return;
  const positions = await tx.select().from(baseForgePositions).where(and(
    eq(baseForgePositions.baseId, defenderBaseId),
    isNull(baseForgePositions.settledAt),
  )).orderBy(asc(baseForgePositions.day), asc(baseForgePositions.id)).for('update');
  let remaining = amount;
  for (const position of positions) {
    if (remaining === 0n) break;
    const open = position.contributedShards - position.raidDebitedShards;
    const debit = open < remaining ? open : remaining;
    if (debit <= 0n) continue;
    await tx.update(baseForgePositions).set({
      raidDebitedShards: position.raidDebitedShards + debit,
      updatedAt: now,
    }).where(eq(baseForgePositions.id, position.id));
    remaining -= debit;
  }
  if (remaining !== 0n) {
    throw new Error(`Forge position backing short by ${remaining} SHARDS for base ${defenderBaseId}`);
  }
}

/** Settle one authoritative PvP result. Attacker receives this exact amount. */
async function settleDeedRaidLootLocked(
  tx: DbTx,
  raidId: string,
  stars: Stars,
  buildingResults: readonly RaidBuildingResult[],
  now = new Date(),
): Promise<RaidLootSettlement> {
  const reservation = await lockReservation(tx, raidId);
  if (reservation.state !== 'reserved') {
    throw new Error(`raid ${raidId} loot reservation is already ${reservation.state}`);
  }
  const balancePool = reservation.spendableReservedShards + reservation.forgeReservedShards;
  const vaults = buildingResults.filter((building) => building.type === 'vault');
  // The reservation froze its formula version with the pool. A raid created
  // before the D-065 cutover settles under v1 (destroyed-Vault slice); every
  // newer reservation settles under v2 (standing-Vault LEVEL protection).
  let exposureBps: number;
  if (reservation.formulaVersion === 1) {
    const destroyedVaults = vaults.filter((building) => building.destroyed).length;
    exposureBps = vaults.length === 0
      ? 10_000
      : LOOT.starSliceBps + Math.floor(LOOT.vaultSliceBps * destroyedVaults / vaults.length);
  } else {
    exposureBps = vaultExposureBps(standingVaultLevel(vaults.map((building) => ({
      level: building.level ?? 1, destroyed: building.destroyed,
    }))));
  }
  const starPrize = bps(balancePool, LOOT.starPayoutBps[stars]);
  const balance = bps(starPrize, exposureBps);
  const sourceAward = splitByReserved(
    balance, reservation.spendableReservedShards, reservation.forgeReservedShards,
  );
  const destroyedMineIds = new Set(buildingResults
    .filter((building) => building.type === 'mine' && building.destroyed)
    .map((building) => building.id));
  const grossMines = await restoreOrAwardMines(tx, raidId, destroyedMineIds, stars > 0, now);
  const minePlan = await planPhysicalMineRaidIssue(tx, raidId, grossMines,
    reservation.attackerBaseId, `raid:${raidId}:loot-terminal`);
  const mines = minePlan?.net ?? grossMines;

  const liquidReturn = reservation.spendableReservedShards - sourceAward.liquid;
  const forgeReturn = reservation.forgeReservedShards - sourceAward.forge;
  const total = balance + mines;
  const escrowed = balancePool;
  let terminalLedgerTxnId: string | null = null;
  if (escrowed > 0n || grossMines > 0n) {
    const sys = await bootstrapSystemAccounts(tx);
    const defenderLiquid = await getOrCreateBaseAccount(
      tx, reservation.defenderBaseId, 'base_shards',
    );
    const defenderForge = await getOrCreateBaseAccount(
      tx, reservation.defenderBaseId, 'base_forge_escrow',
    );
    const attacker = await getOrCreateBaseAccount(tx, reservation.attackerBaseId, 'base_shards');
    const entries = [
      ...(escrowed > 0n ? [{ account: sys.raid_loot_escrow, delta: -escrowed }] : []),
      ...(grossMines > 0n ? [{ account: sys.shard_genesis, delta: -grossMines }] : []),
      ...(liquidReturn > 0n ? [{ account: defenderLiquid.id, delta: liquidReturn }] : []),
      ...(forgeReturn > 0n ? [{ account: defenderForge.id, delta: forgeReturn }] : []),
      ...(total > 0n ? [{ account: attacker.id, delta: total }] : []),
      ...(minePlan?.tax ? [{ account: sys.shards_tax_escrow, delta: minePlan.tax }] : []),
    ];
    const posted = await postTransaction(tx, {
      idempotencyKey: `raid:${raidId}:loot-terminal`, type: 'raid.loot.settle', entries,
      metadata: {
        raidId,
        attackerBaseId: reservation.attackerBaseId,
        defenderBaseId: reservation.defenderBaseId,
        stars,
        exactPayout: total.toString(),
      },
    });
    if (minePlan) await finishPhysicalMineIssue(tx, minePlan, posted, entries, 'raid.loot.settle');
    terminalLedgerTxnId = posted.transaction.id;
  }
  await attributeForgeTheft(tx, reservation.defenderBaseId, sourceAward.forge, now);
  await tx.update(raidLootReservations).set({
    state: 'settled',
    rowVersion: reservation.rowVersion + 1,
    terminalLedgerTxnId,
    settledAt: now,
  }).where(and(
    eq(raidLootReservations.raidId, raidId),
    eq(raidLootReservations.rowVersion, reservation.rowVersion),
  ));
  await releaseConditionalBaseLock(tx, raidId, reservation.defenderBaseId);
  return {
    total,
    balance,
    mines,
    fromLiquid: sourceAward.liquid,
    fromOpenForge: sourceAward.forge,
  };
}

/** Idempotent read for a retry after the terminal transaction committed. */
export async function getSettledDeedRaidLoot(
  tx: DbOrTx, raidId: string,
): Promise<RaidLootSettlement | null> {
  const [reservation] = await tx.select().from(raidLootReservations)
    .where(eq(raidLootReservations.raidId, raidId));
  if (!reservation || reservation.state !== 'settled') return null;
  const grossMines = (await tx.select({ amount: raidMineLootReservations.awardedShards })
    .from(raidMineLootReservations)
    .where(eq(raidMineLootReservations.raidId, raidId)))
    .reduce((sum, row) => sum + (row.amount ?? 0n), 0n);
  const mines = await readPhysicalMineRaidNet(tx, raidId, grossMines);
  if (!reservation.terminalLedgerTxnId) {
    return { total: mines, balance: 0n, mines, fromLiquid: 0n, fromOpenForge: 0n };
  }
  const liquid = await getOrCreateBaseAccount(tx, reservation.defenderBaseId, 'base_shards');
  const forge = await getOrCreateBaseAccount(tx, reservation.defenderBaseId, 'base_forge_escrow');
  const entries = await tx.select().from(ledgerEntries)
    .where(eq(ledgerEntries.txnId, reservation.terminalLedgerTxnId));
  const liquidReturn = entries.find((entry) => entry.accountId === liquid.id)?.delta ?? 0n;
  const forgeReturn = entries.find((entry) => entry.accountId === forge.id)?.delta ?? 0n;
  const fromLiquid = reservation.spendableReservedShards - liquidReturn;
  const fromOpenForge = reservation.forgeReservedShards - forgeReturn;
  const balance = fromLiquid + fromOpenForge;
  return { total: balance + mines, balance, mines, fromLiquid, fromOpenForge };
}

/** Restore a never-started/cancelled reservation and unlock the exact token. */
async function releaseDeedRaidLootLocked(
  tx: DbTx, raidId: string, now = new Date(),
): Promise<boolean> {
  const [reservation] = await tx.select().from(raidLootReservations)
    .where(eq(raidLootReservations.raidId, raidId)).for('update');
  if (!reservation) return false;
  if (reservation.state !== 'reserved') return true;
  await restoreOrAwardMines(tx, raidId, new Set(), false, now);
  const balancePool = reservation.spendableReservedShards + reservation.forgeReservedShards;
  let terminalLedgerTxnId: string | null = null;
  if (balancePool > 0n) {
    const sys = await bootstrapSystemAccounts(tx);
    const liquid = await getOrCreateBaseAccount(tx, reservation.defenderBaseId, 'base_shards');
    const forge = await getOrCreateBaseAccount(tx, reservation.defenderBaseId, 'base_forge_escrow');
    const posted = await postTransaction(tx, {
      idempotencyKey: `raid:${raidId}:loot-terminal`,
      type: 'raid.loot.release',
      entries: [
        { account: sys.raid_loot_escrow, delta: -balancePool },
        ...(reservation.spendableReservedShards > 0n
          ? [{ account: liquid.id, delta: reservation.spendableReservedShards }] : []),
        ...(reservation.forgeReservedShards > 0n
          ? [{ account: forge.id, delta: reservation.forgeReservedShards }] : []),
      ],
      metadata: {
        raidId,
        defenderBaseId: reservation.defenderBaseId,
        reason: 'raid did not reach terminal combat settlement',
      },
    });
    terminalLedgerTxnId = posted.transaction.id;
  }
  await tx.update(raidLootReservations).set({
    state: 'released',
    rowVersion: reservation.rowVersion + 1,
    terminalLedgerTxnId,
    releasedAt: now,
  }).where(and(
    eq(raidLootReservations.raidId, raidId),
    eq(raidLootReservations.rowVersion, reservation.rowVersion),
  ));
  await releaseConditionalBaseLock(tx, raidId, reservation.defenderBaseId);
  return true;
}

/** Raw and SHARDS loot share one transaction, including the incoming lock. Raw
 * base locks precede SHARDS account locks in every lifecycle path. */
export async function reserveDeedRaidLoot(db: DbOrTx, input: Parameters<typeof reserveDeedRaidLootLocked>[1]) {
  return db.transaction(async tx => {
    const raw = await freezeRawRaidLoot(tx, input.raidId, input.now);
    if (raw && (raw.snapshot.attackerBaseId !== input.attackerBaseId || raw.snapshot.defenderBaseId !== input.defenderBaseId)) {
      throw new Error('raid loot base identity mismatch');
    }
    return reserveDeedRaidLootLocked(tx, input);
  });
}
export async function settleDeedRaidLoot(db: DbOrTx, raidId: string, stars: Stars,
  buildingResults: readonly RaidBuildingResult[], now = new Date()): Promise<RaidLootSettlement> {
  return db.transaction(async tx => {
    await settleRawRaidLoot(tx, raidId, buildingResults, now);
    return settleDeedRaidLootLocked(tx, raidId, stars, buildingResults, now);
  });
}
export async function releaseDeedRaidLoot(db: DbOrTx, raidId: string, now = new Date()): Promise<boolean> {
  return db.transaction(async tx => {
    await releaseRawRaidLoot(tx, raidId, now);
    return releaseDeedRaidLootLocked(tx, raidId, now);
  });
}
