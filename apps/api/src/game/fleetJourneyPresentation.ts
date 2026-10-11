/** Transient return projection. Freshness comes ONLY from the trusted caller's
 * just-settled proof array. Identity reads never discover or replay old events.
 * Caller holds current player/base/slot locks and publishes after outer commit. */
import { AdvancedExpeditionSnapshotSchema } from '@shardkeep/shared/phaseEAdvancedExpeditions';
import { FleetJourneyEventSchema, matchFleetJourneyEventBatch, type FleetJourneyEvent } from '@shardkeep/shared/fleetJourneyPresentation';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';
import { assertFreshLockedBaseAuthority } from './baseOwnership';
import type { AdvancedExpeditionReturnProof } from './advancedExpeditionReturns';
import type { StarterExpeditionReturnProof } from './starterExpeditionReturns';
import { boundCosmeticWakeFields } from './boundCosmeticWakePresentation';
import { readStarterFleetView } from './starterFleetView';
import { readLockedVehicleLifecycle } from './vehicleLifecycle';

type ReturnProof = StarterExpeditionReturnProof | AdvancedExpeditionReturnProof;
async function currentBase(tx: DbTx, wallet: string, baseId: string): Promise<void> {
  if (!('rollback' in tx)) throw new Error('Journey return projection requires an existing transaction');
  const [base] = await tx.execute(sql`select b.id from bases b join base_slots s on s.base_id=b.id
    where b.id=${baseId}::uuid and b.owner_wallet=${wallet} and b.status='active'
      and s.wallet=${wallet} and s.active`);
  if (!base) throw new Error('Journey return base is not currently owned and active');
  await assertFreshLockedBaseAuthority(tx, wallet, baseId);
}

async function returnIdentity(tx: DbTx, kind: 'starter' | 'advanced', wallet: string, baseId: string, proof: ReturnProof): Promise<void> {
  const { expedition, receipt } = proof;
  if (expedition.baseId !== baseId || receipt.expeditionId !== expedition.id || receipt.custodyWallet !== wallet
    || !Number.isFinite(receipt.returnedAt.getTime()) || !Number.isFinite(expedition.returnsAt.getTime())
    || receipt.returnedAt < expedition.returnsAt) throw new Error('Journey return differs from its new source proof');
  const rows = kind === 'starter'
    ? await tx.execute(sql`select r.id from starter_expedition_returns r join starter_expeditions e on e.id=r.expedition_id
        where r.id=${receipt.id}::uuid and e.id=${expedition.id}::uuid and e.base_id=${baseId}::uuid
          and e.installation_id=${expedition.installationId}::uuid and r.custody_wallet=${wallet}
          and r.returned_at=${receipt.returnedAt.toISOString()}::timestamptz
          and not exists(select 1 from starter_expedition_inflight f where f.installation_id=e.installation_id)`)
    : await tx.execute(sql`select r.id from advanced_expedition_returns r join advanced_expeditions e on e.id=r.expedition_id
        where r.id=${receipt.id}::uuid and e.id=${expedition.id}::uuid and e.base_id=${baseId}::uuid
          and e.installation_id=${expedition.installationId}::uuid and r.custody_wallet=${wallet}
          and r.returned_at=${receipt.returnedAt.toISOString()}::timestamptz
          and not exists(select 1 from advanced_expedition_inflight f where f.installation_id=e.installation_id)`);
  if (rows.length !== 1) throw new Error('Journey return identity is not the settled original');
}

export async function readNewStarterReturnJourneyEvents(
  tx: DbTx, wallet: string, baseId: string, proofs: readonly StarterExpeditionReturnProof[],
): Promise<FleetJourneyEvent[]> {
  if (!('rollback' in tx)) throw new Error('Journey return projection requires an existing transaction');
  if (proofs.length === 0) return [];
  await currentBase(tx, wallet, baseId);
  const fleet = await readStarterFleetView(tx, baseId), events: FleetJourneyEvent[] = [];
  for (const proof of proofs) {
    await returnIdentity(tx, 'starter', wallet, baseId, proof);
    const installation = fleet.installation;
    if (!installation || installation.installationId !== proof.expedition.installationId)
      throw new Error('Journey return differs from the current starter installation');
    const source = await boundCosmeticWakeFields(tx, 'starter', proof.expedition.id);
    events.push(FleetJourneyEventSchema.parse({ version: 1, kind: 'return', baseId,
      berthId: installation.berthId, installationId: installation.installationId,
      expeditionId: proof.expedition.id, returnId: proof.receipt.id, at: proof.receipt.returnedAt.toISOString(),
      vehicle: { family: 'starter' }, wake: source.boundCosmeticWake ?? { state: 'legacy', visual: null } }));
  }
  return matchFleetJourneyEventBatch({ version: 1, events }, baseId).events;
}

export async function readNewAdvancedReturnJourneyEvents(
  tx: DbTx, wallet: string, baseId: string, proofs: readonly AdvancedExpeditionReturnProof[],
): Promise<FleetJourneyEvent[]> {
  if (!('rollback' in tx)) throw new Error('Journey return projection requires an existing transaction');
  if (proofs.length === 0) return [];
  await currentBase(tx, wallet, baseId);
  const events: FleetJourneyEvent[] = [];
  for (const proof of proofs) {
    await returnIdentity(tx, 'advanced', wallet, baseId, proof);
    const installation = await readLockedVehicleLifecycle(tx, proof.expedition.installationId);
    const route = AdvancedExpeditionSnapshotSchema.parse(proof.expedition.routeSnapshot);
    if (!installation || installation.baseId !== baseId || installation.away
      || installation.family !== route.family || installation.tier !== route.tier
      || installation.completedTotal !== proof.receipt.completedTotal)
      throw new Error('Journey return differs from the current advanced installation');
    const source = await boundCosmeticWakeFields(tx, 'advanced', proof.expedition.id);
    events.push(FleetJourneyEventSchema.parse({ version: 1, kind: 'return', baseId,
      berthId: installation.berthId, installationId: installation.installationId,
      expeditionId: proof.expedition.id, returnId: proof.receipt.id, at: proof.receipt.returnedAt.toISOString(),
      vehicle: { family: route.family, tier: route.tier }, wake: source.boundCosmeticWake ?? { state: 'legacy', visual: null } }));
  }
  return matchFleetJourneyEventBatch({ version: 1, events }, baseId).events;
}
