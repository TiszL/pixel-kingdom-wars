/** Real second-free acquisition; no mining qualification or allocation is implied. */
import { randomUUID } from 'node:crypto';
import { PHASE_E_FREE_BASE_POLICY, PHASE_E_POLICY } from '@shardkeep/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { multiBaseEnabled, phaseEMiningEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { bases, baseSlots, builderJobs, buildings, fantasyLandClaims, players, plotReservations, plots } from '../db/schema';
import { miningFreeBasePurchases } from '../db/miningFreeBaseSchema';
import { initializePurchasedFreeBase } from '../game/base';
import { spendBaseShards } from '../game/baseEconomy';
import { assertFreshLockedBaseAuthority } from '../game/baseOwnership';
import { lockStablePrerequisiteBase } from '../game/stableBasePrerequisites';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';

const Request = z.object({ sourceBaseId: z.uuid(), idempotencyKey: z.string().min(8).max(128) }).strict();
export type FreeBasePurchaseRequest = z.infer<typeof Request>;
type Stored = typeof miningFreeBasePurchases.$inferSelect;
function receipt(row: Stored) {
  return { version: row.policyVersion, wallet: row.wallet, idempotencyKey: row.requestKey,
    sourceBaseId: row.sourceBaseId, baseId: row.baseId, slot: row.slot,
    shardsCharged: row.shardsCharged.toString(), debitTransactionId: row.debitTransactionId,
    development: row.development, acceptedAt: row.acceptedAt.toISOString() };
}
export async function getFreeBasePurchase(db: DbOrTx, wallet: string, key: string) {
  const [row] = await db.select().from(miningFreeBasePurchases)
    .where(and(eq(miningFreeBasePurchases.wallet, wallet), eq(miningFreeBasePurchases.requestKey, key)));
  return row ? receipt(row) : null;
}

export async function purchaseFreeBase(db: Db, wallet: string, input: FreeBasePurchaseRequest) {
  const request = parse(Request, input);
  return db.transaction(async tx => {
    // Same wallet serializes purchase, land admission, activation and transfer.
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found', 'BASE_NOT_OWNED');
    const [prior] = await tx.select().from(miningFreeBasePurchases).where(eq(miningFreeBasePurchases.wallet, wallet));
    if (prior) {
      if (prior.requestKey !== request.idempotencyKey) throw new HttpError(409, 'the second free base was already purchased', 'FREE_BASE_ALREADY_PURCHASED');
      if (prior.sourceBaseId !== request.sourceBaseId) throw new HttpError(409, 'the purchase key belongs to a different source base', 'IDEMPOTENCY_BODY_MISMATCH');
      return receipt(prior);
    }
    // Existing evidence is always recoverable while new admissions are paused.
    if (!phaseEMiningEnabled()) throw new HttpError(503, 'free base purchases are not enabled', 'PHASE_E_DISABLED');
    if (!multiBaseEnabled()) throw new HttpError(409, 'stable bases are required', 'BASE_ID_REQUIRED');
    const owned = await tx.select().from(bases).where(eq(bases.ownerWallet, wallet)).orderBy(asc(bases.id)).for('update');
    const slots = await tx.select().from(baseSlots).where(eq(baseSlots.wallet, wallet)).orderBy(asc(baseSlots.slot)).for('update');
    const source = owned.find(b => b.id === request.sourceBaseId);
    if (!source) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
    const isFree = (b: typeof source) => !b.landPaidAt && !b.deedAssetId && !b.deedMintAssetId && !b.deedMintingAt;
    if (!isFree(source) || owned.filter(isFree).length !== PHASE_E_POLICY.bases.freePerWalletMax - 1) {
      throw new HttpError(409, 'purchase requires exactly one free source base', 'FREE_BASE_SOURCE_REQUIRED');
    }
    await lockStablePrerequisiteBase(tx, wallet, { baseId: source.id, assertAuthority: async (locked, actor, id) => {
      await assertFreshLockedBaseAuthority(locked, actor, id);
    } });
    const reservations = await tx.select({ id: plotReservations.id }).from(plotReservations).where(and(
      eq(plotReservations.baseId, source.id), inArray(plotReservations.state, ['reserved', 'paid', 'converted']),
    ));
    const claims = await tx.select({ baseId: fantasyLandClaims.baseId }).from(fantasyLandClaims).where(and(
      eq(fantasyLandClaims.baseId, source.id), inArray(fantasyLandClaims.state, ['held', 'assigned']),
    ));
    const parcels = await tx.select({ id: plots.id }).from(plots).where(eq(plots.baseId, source.id));
    if (reservations.length || claims.length || parcels.length) throw new HttpError(409, 'source land purchase must be resolved first', 'FREE_BASE_SOURCE_RESERVED');
    // Do not replace an inactive row occupying a slot either; this block never pays a replacement fee.
    const used = new Set(slots.map(s => s.slot));
    const slot = Array.from({ length: PHASE_E_POLICY.bases.activePerWalletMax }, (_, i) => i + 1).find(n => !used.has(n));
    if (slot === undefined) throw new HttpError(409, 'there is no vacant active base slot', 'BASE_SLOTS_FULL');
    const structures = await tx.select().from(buildings).where(and(eq(buildings.baseId, source.id), inArray(buildings.type, ['keep', 'workshop', 'goldforge']))).orderBy(asc(buildings.id)).for('update');
    const keep = structures.find(b => b.type === 'keep'), workshop = structures.find(b => b.type === 'workshop'), forge = structures.find(b => b.type === 'goldforge');
    const pending = structures.length ? await tx.select({ id: builderJobs.id }).from(builderJobs).where(and(
      inArray(builderJobs.buildingId, structures.map(b => b.id)), isNull(builderJobs.completedAt),
    )).for('update') : [];
    if (!keep || !workshop || !forge || keep.level !== source.keepLevel || keep.level < PHASE_E_FREE_BASE_POLICY.minKeepLevel
      || workshop.level < PHASE_E_FREE_BASE_POLICY.minWorkshopLevel || forge.level < PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel || pending.length) {
      throw new HttpError(409, 'develop the first base before purchasing another', 'FREE_BASE_DEVELOPMENT_REQUIRED');
    }
    const development = { keepId: keep.id, keepLevel: keep.level, workshopId: workshop.id, workshopLevel: workshop.level, goldForgeId: forge.id, goldForgeLevel: forge.level };
    const baseId = randomUUID(), cost = BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards);
    const debit = await spendBaseShards(tx, source.id, cost, 'base.free_purchase', `free-base:${wallet}:${request.idempotencyKey}`,
      { wallet, sourceBaseId: source.id, purchasedBaseId: baseId, policyVersion: PHASE_E_FREE_BASE_POLICY.version, development }, { progressQuests: false });
    if (debit.duplicate) throw new HttpError(409, 'purchase debit exists without its receipt', 'FREE_BASE_RECEIPT_UNAVAILABLE');
    await tx.insert(bases).values({ id: baseId, ownerWallet: wallet });
    await tx.insert(baseSlots).values({ wallet, slot, baseId, selectedAt: new Date() });
    await initializePurchasedFreeBase(tx, wallet, baseId);
    const [created] = await tx.insert(miningFreeBasePurchases).values({ wallet, requestKey: request.idempotencyKey,
      sourceBaseId: source.id, baseId, slot, policyVersion: PHASE_E_FREE_BASE_POLICY.version,
      shardsCharged: cost, debitTransactionId: debit.transaction.id, development }).returning();
    if (!created) throw new Error('free base purchase receipt was not written');
    return receipt(created);
  });
}
