/** Synthetic DB fixtures only. Opening inventory and raid/simulator evidence
 * here do not authorize production issuance or prove a real battle result. */
import { randomUUID } from 'node:crypto';
import { FORGE_INGOT } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS, type PhaseERawResourceId } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { baseRaidLocks, bases, baseSlots, buildings, raids, resourceStockEntries, resourceStockOperations, resourceStocks } from '../../src/db/schema';
import { rewardBaseShards } from '../../src/game/baseEconomy';
import { readResourceStockProof, reserveRawStock } from '../../src/game/resourceStock';
import { createTestPlayer } from '../helpers';

export type RawRaidFixtureOptions = {
  now?: Date;
  /** Quantities are synthetic OPENING stock, before the real reservations. */
  stocks?: Partial<Record<PhaseERawResourceId, bigint>>;
  reservations?: { resourceId: PhaseERawResourceId; quantity: bigint; id?: string; createdAt?: Date }[];
  defender?: { wallet: string; baseId: string };
  keep?: boolean;
  shards?: bigint;
};
export async function createRawRaidFixture(db: Db, options: RawRaidFixtureOptions = {}) {
  // The raid row is stamped at the real current time by default, never in the
  // future: since D153.235 / D153.238 (0284/0286) the raids capture triggers
  // refuse created_at > clock_timestamp() (RAID_*_CAPTURE_SOURCE), as the
  // server only ever stamps a raid when it is actually created.
  const now = options.now ?? new Date();
  const attacker = await createTestPlayer(db);
  const defender = options.defender ?? (await (async () => {
    const player = await createTestPlayer(db);
    const [base] = await db.insert(bases).values({ ownerWallet: player.wallet, status: 'active' }).returning();
    await db.insert(baseSlots).values({ wallet: player.wallet, slot: 1, baseId: base!.id });
    return { wallet: player.wallet, baseId: base!.id };
  })());
  const [attackerBase] = await db.insert(bases).values({ ownerWallet: attacker.wallet, status: 'active' }).returning();
  const stocks = options.stocks ?? { [PHASE_E_RAW_RESOURCE_IDS[0]]: BigInt(FORGE_INGOT.rawStockTheftDivisor) * 3n };
  for (const resourceId of PHASE_E_RAW_RESOURCE_IDS) {
    const available = stocks[resourceId];
    if (available !== undefined) await db.insert(resourceStocks).values({ baseId: defender.baseId, resourceId, available });
  }
  const reservations = [];
  for (const request of options.reservations ?? []) {
    const operationId = request.id ?? randomUUID();
    if (request.createdAt) {
      // Only exact timestamp/UUID ordering tests need this explicit original
      // proof fixture. It runs BEFORE the incoming raid lock, like admission.
      await db.transaction(async tx => {
        await tx.insert(resourceStockOperations).values({ id: operationId, kind: 'reserve', baseId: defender.baseId,
          resourceId: request.resourceId, quantity: request.quantity, custodyWallet: defender.wallet, createdAt: request.createdAt });
        await tx.insert(resourceStockEntries).values([{ operationId, bucket: 'available', delta: -request.quantity },
          { operationId, bucket: 'reserved', delta: request.quantity }]);
        await tx.update(resourceStocks).set({ available: sql`${resourceStocks.available} - ${request.quantity}`,
          reserved: sql`${resourceStocks.reserved} + ${request.quantity}` }).where(and(eq(resourceStocks.baseId, defender.baseId), eq(resourceStocks.resourceId, request.resourceId)));
      });
      reservations.push((await readResourceStockProof(db, operationId))!);
    } else reservations.push(await reserveRawStock(db, defender.wallet,
      { operationId, baseId: defender.baseId, resourceId: request.resourceId, quantity: request.quantity },
      { baseId: defender.baseId, assertAuthority: async () => {} }));
  }
  const keepId = options.keep === false ? null : randomUUID();
  if (keepId) await db.insert(buildings).values({ id: keepId, playerWallet: defender.wallet, baseId: defender.baseId,
    type: 'keep', level: 1, tx: 2, ty: 2 });
  if (options.shards !== undefined) await rewardBaseShards(db, defender.baseId, options.shards, 'test.raw_raid_opening', randomUUID());
  const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet,
    attackerBaseId: attackerBase!.id, defenderWallet: defender.wallet, defenderBaseId: defender.baseId,
    seed: 1n, snapshot: { buildings: keepId ? [{ id: keepId, type: 'keep' }] : [] }, armySnapshot: {},
    createdAt: now, simVersion: 9, ordersDeadlineAt: new Date(now.getTime() + 120_000) }).returning();
  await db.insert(baseRaidLocks).values({ baseId: defender.baseId, raidId: raid!.id, expiresAt: new Date(now.getTime() + 180_000) });
  return { raid: raid!, now, attackerWallet: attacker.wallet, attackerBaseId: attackerBase!.id,
    defenderWallet: defender.wallet, defenderBaseId: defender.baseId, keepId, reservations };
}
export type RawRaidFixture = Awaited<ReturnType<typeof createRawRaidFixture>>;
export async function rawStock(db: Db, baseId: string, resourceId: PhaseERawResourceId = PHASE_E_RAW_RESOURCE_IDS[0]) {
  const [row] = await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId, baseId), eq(resourceStocks.resourceId, resourceId)));
  return { available: row?.available ?? 0n, reserved: row?.reserved ?? 0n };
}
