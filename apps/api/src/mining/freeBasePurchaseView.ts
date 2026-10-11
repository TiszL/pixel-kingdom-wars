/** Read-only purchase advice. POST rechecks all authority under its own locks. */
import { PHASE_E_FREE_BASE_POLICY, PHASE_E_POLICY } from '@shardkeep/shared';
import { FreeBasePurchaseReceiptSchema, type FreeBasePurchaseAdmissionReason,
  type FreeBasePurchaseView } from '@shardkeep/shared/freeBasePurchaseApi';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { multiBaseEnabled, phaseEMiningEnabled } from '../config';
import type { Db } from '../db/client';
import { accounts, baseRaidLocks, bases, baseSlots, builderJobs, buildings,
  fantasyLandClaims, plotReservations, plots } from '../db/schema';
import { miningFreeBasePurchases } from '../db/miningFreeBaseSchema';
import { getFreeBasePurchase } from './freeBasePurchase';

export async function getFreeBasePurchaseView(db: Db, wallet: string, sourceBaseId?: string): Promise<FreeBasePurchaseView> {
  const enabled = phaseEMiningEnabled(), stable = multiBaseEnabled();
  return db.transaction(async tx => {
    const [prior] = await tx.select({ key: miningFreeBasePurchases.requestKey }).from(miningFreeBasePurchases)
      .where(eq(miningFreeBasePurchases.wallet, wallet));
    const receipt = prior ? FreeBasePurchaseReceiptSchema.parse(await getFreeBasePurchase(tx, wallet, prior.key)) : null;
    const result = (reason: FreeBasePurchaseAdmissionReason): FreeBasePurchaseView => ({
      version: 1, wallet, sourceBaseId: sourceBaseId ?? null, enabled, receipt,
      terms: { policyVersion: PHASE_E_FREE_BASE_POLICY.version,
        costShards: String(PHASE_E_POLICY.bases.secondFreeBaseCostShards),
        minKeepLevel: PHASE_E_FREE_BASE_POLICY.minKeepLevel, minWorkshopLevel: PHASE_E_FREE_BASE_POLICY.minWorkshopLevel,
        minGoldForgeLevel: PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel, maxFreeBases: PHASE_E_POLICY.bases.freePerWalletMax,
        maxActiveBases: PHASE_E_POLICY.bases.activePerWalletMax },
      admission: { allowed: reason === 'ready', reason },
    });
    if (receipt) return result('already-purchased');
    if (!enabled) return result('disabled');
    if (!stable) return result('stable-bases-required');
    if (!sourceBaseId) return result('source-required');
    const owned = await tx.select().from(bases).where(eq(bases.ownerWallet, wallet));
    const slots = await tx.select().from(baseSlots).where(eq(baseSlots.wallet, wallet));
    const source = owned.find(b => b.id === sourceBaseId);
    if (!source || source.status !== 'active' || !slots.some(s => s.baseId === sourceBaseId && s.active)) return result('source-unavailable');
    const isFree = (b: typeof source) => !b.landPaidAt && !b.deedAssetId && !b.deedMintAssetId && !b.deedMintingAt;
    if (!isFree(source) || owned.filter(isFree).length !== PHASE_E_POLICY.bases.freePerWalletMax - 1) return result('source-not-free');
    const [raid] = await tx.select({ id: baseRaidLocks.raidId }).from(baseRaidLocks).where(eq(baseRaidLocks.baseId, sourceBaseId));
    if (raid) return result('being-raided');
    const reservations = await tx.select({ id: plotReservations.id }).from(plotReservations).where(and(
      eq(plotReservations.baseId, sourceBaseId), inArray(plotReservations.state, ['reserved', 'paid', 'converted'])));
    const claims = await tx.select({ id: fantasyLandClaims.baseId }).from(fantasyLandClaims).where(and(
      eq(fantasyLandClaims.baseId, sourceBaseId), inArray(fantasyLandClaims.state, ['held', 'assigned'])));
    const parcels = await tx.select({ id: plots.id }).from(plots).where(eq(plots.baseId, sourceBaseId));
    if (reservations.length || claims.length || parcels.length) return result('source-reserved');
    const used = new Set(slots.map(s => s.slot));
    if (!Array.from({ length: PHASE_E_POLICY.bases.activePerWalletMax }, (_, i) => i + 1).some(n => !used.has(n))) return result('full-roster');
    const structures = await tx.select().from(buildings).where(and(eq(buildings.baseId, sourceBaseId),
      inArray(buildings.type, ['keep', 'workshop', 'goldforge'])));
    const keep = structures.find(b => b.type === 'keep'), workshop = structures.find(b => b.type === 'workshop'), forge = structures.find(b => b.type === 'goldforge');
    const pending = structures.length ? await tx.select({ id: builderJobs.id }).from(builderJobs).where(and(
      inArray(builderJobs.buildingId, structures.map(b => b.id)), isNull(builderJobs.completedAt))) : [];
    if (!keep || !workshop || !forge || keep.level !== source.keepLevel || keep.level < PHASE_E_FREE_BASE_POLICY.minKeepLevel
      || workshop.level < PHASE_E_FREE_BASE_POLICY.minWorkshopLevel || forge.level < PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel || pending.length) return result('development-required');
    // Unlike getBaseShardBalance, this read never creates a missing account.
    const [balance] = await tx.select({ value: accounts.balance }).from(accounts).where(and(
      eq(accounts.baseId, sourceBaseId), eq(accounts.kind, 'base_shards'), eq(accounts.currency, 'SHARDS')));
    if ((balance?.value ?? 0n) < BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards)) return result('insufficient-shards');
    return result('ready');
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
