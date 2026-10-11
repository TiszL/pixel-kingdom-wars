import {fittingSelection} from '@shardkeep/shared/phaseEOrdinaryEquipment';
/** Current base state and original actor receipts have deliberately separate projections. */
import { StarterRouteIdSchema, starterRoutePreview } from '@shardkeep/shared/phaseEExpeditions';
import { StarterExpeditionEnvelopeSchema, StarterExpeditionFlightSchema, StarterExpeditionReceiptSchema } from '@shardkeep/shared/starterExpeditionApi';
import { eq } from 'drizzle-orm';
import type { DbOrTx, DbTx } from '../db/client';
import { bases, starterExpeditionInflight } from '../db/schema';
import { readExpeditionHomePreview } from './expeditionHome';
import { readOwnedStarterExpedition, readStarterExpedition, type AcceptedStarterExpedition } from './starterExpeditionDispatch';
import { readCompletedLodge } from './starterExpeditionFacilities';
import { readStarterExpeditionReturn } from './starterExpeditionReturns';
import type { readStarterFleetView } from './starterFleetView';

function flight(row: AcceptedStarterExpedition) {
  return StarterExpeditionFlightSchema.parse({ expeditionId: row.id, installationId: row.installationId,
    route: row.routeSnapshot, departedAt: row.departedAt.toISOString(), returnsAt: row.returnsAt.toISOString(),
    termId: row.termId, termHash: row.termHash });
}
export async function starterExpeditionEnvelope(db: DbOrTx, wallet: string, key: string) {
  // Never invoke private term/home/return integrity readers for a foreign actor.
  const row = await readOwnedStarterExpedition(db, wallet, key);
  const scope = { wallet, idempotencyKey: key, serverNow: new Date().toISOString() };
  if (!row) return StarterExpeditionEnvelopeSchema.parse({ ...scope, status: 'unknown', receipt: null, return: null });
  const receipt = StarterExpeditionReceiptSchema.parse({ ...flight(row), wallet,
    request: { idempotencyKey: row.id, baseId: row.baseId, installationId: row.installationId,
      routeId: row.routeId, routeVersion: row.routeVersion, rewardVersion: row.rewardVersion, ...fittingSelection(row.routeSnapshot) } });
  const proof = await readStarterExpeditionReturn(db, row.id);
  return StarterExpeditionEnvelopeSchema.parse({ ...scope, status: 'accepted', receipt,
    return: proof ? { returnId: proof.receipt.id, returnedAt: proof.receipt.returnedAt.toISOString(),...row.routeSnapshot.secondaryOutput?{secondaryOutput:row.routeSnapshot.secondaryOutput}:{} } : null });
}
/** Caller owns player/base/slot authority and has settled through cutoff. */
export async function readStarterExpeditionView(tx: DbTx, base: typeof bases.$inferSelect, cutoff: Date,
  fleet: Awaited<ReturnType<typeof readStarterFleetView>>) {
  const home = await readExpeditionHomePreview(tx, base);
  const lodge = await readCompletedLodge(tx, base.id);
  const [inflight] = fleet.installation ? await tx.select().from(starterExpeditionInflight)
    .where(eq(starterExpeditionInflight.installationId, fleet.installation.installationId)) : [];
  const row = inflight ? await readStarterExpedition(tx, inflight.expeditionId) : null;
  if (inflight && (!row || row.baseId !== base.id || row.installationId !== fleet.installation?.installationId))
    throw new Error('Current expedition differs from original base/installation');
  return { home, routes: home ? StarterRouteIdSchema.options.map(id => starterRoutePreview(home.realmId, id)) : [],
    installation: fleet.installation, flight: row ? flight(row) : null,
    lodgeCompletedAt: lodge && lodge <= cutoff ? lodge.toISOString() : null, serverNow: cutoff.toISOString() };
}
