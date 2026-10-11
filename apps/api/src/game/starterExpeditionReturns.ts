import {finishStarterEquipmentReturn} from './starterEquipmentReturn';
import {lockEquipmentReturnStocks,readEquipmentSecondaryReturn} from './ordinaryEquipmentSecondary';
import {assertEquipmentRelease} from './ordinaryEquipment';
/** DARK automatic source settlement. The caller owns an existing transaction
 * and samples cutoff after its base locks. No player lock, authority/provider
 * lookup, current catalogue, completeDueJobs, notification or independent commit.
 * Multi-base callers hold ALL bases in sorted order before entering this helper.
 * Positive per-source island entries are original-term liabilities, not payouts.
 */
import { RAW_RESOURCE_STORAGE_MAX, RawResourceStockSchema } from '@shardkeep/shared/phaseEResources';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx, DbTx } from '../db/client';
import {
  bases, resourceStocks, starterExpeditionEntries, starterExpeditionInflight,
  starterExpeditionReturns, starterExpeditions,
} from '../db/schema';
import { readStarterExpedition } from './starterExpeditionDispatch';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
type Trip = typeof starterExpeditions.$inferSelect;
type Receipt = typeof starterExpeditionReturns.$inferSelect;
type Entry = typeof starterExpeditionEntries.$inferSelect;
export interface StarterExpeditionReturnProof {
  expedition: NonNullable<Awaited<ReturnType<typeof readStarterExpedition>>>;
  receipt: Receipt;
  entries: Entry[];
}

function expectedEntries(trip: Trip) {
  return [
    { bucket: 'issued' as const, delta: -trip.gross },
    { bucket: 'base_stock' as const, delta: trip.net },
    { bucket: 'island_pool' as const, delta: trip.tax },
  ];
}

/** Internal historical evidence only; a public caller must authenticate the
 * original actor separately. Never includes the buyer's current inventory. */
export async function readStarterExpeditionReturn(
  db: DbOrTx, expeditionId: string,
): Promise<StarterExpeditionReturnProof | null> {
  expeditionId = uuid.parse(expeditionId);
  const [receipt] = await db.select().from(starterExpeditionReturns)
    .where(eq(starterExpeditionReturns.expeditionId, expeditionId));
  if (!receipt) return null;
  const expedition = await readStarterExpedition(db, expeditionId);
  if (!expedition || !Number.isFinite(receipt.returnedAt.getTime())
    || receipt.returnedAt.getTime() < expedition.returnsAt.getTime() || receipt.custodyWallet.length === 0) {
    throw new Error('Invalid original expedition return identity or time');
  }
  const entries = await db.select().from(starterExpeditionEntries)
    .where(eq(starterExpeditionEntries.returnId, receipt.id)).orderBy(asc(starterExpeditionEntries.bucket));
  const expected = expectedEntries(expedition);
  if (entries.length !== expected.length || expected.some(e => !entries.some(actual =>
    actual.bucket === e.bucket && actual.delta === e.delta))) {
    throw new Error('Invalid original expedition return entries');
  }
  const [flight] = await db.select({ id: starterExpeditionInflight.expeditionId })
    .from(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId, expeditionId));
  if (flight) throw new Error('Returned expedition still holds an active vehicle');
  if(expedition.routeSnapshot.fitting)await assertEquipmentRelease(db,'starter',expeditionId,receipt.id);
  await readEquipmentSecondaryReturn(db,'starter',expeditionId,receipt.id,expedition.routeSnapshot.secondaryOutput);
  return { expedition, receipt, entries };
}

/** Drain EVERY due source for this saved base, even inactive/sold/raid-locked.
 * A nested savepoint protects the whole batch if a caller catches an integrity
 * or overflow error. Releasing it does not commit the enclosing transaction.
 * Never accepts a root Db cast to DbTx: caller must use db.transaction itself.
 */
export async function settleDueStarterExpeditions(
  tx: DbTx, originalBaseId: string, cutoff: Date,
): Promise<StarterExpeditionReturnProof[]> {
  originalBaseId = uuid.parse(originalBaseId);
  const settledAt = new Date(z.date().parse(cutoff).getTime());
  return tx.transaction(async locked => {
    const [base] = await locked.select().from(bases).where(eq(bases.id, originalBaseId)).for('update');
    if (!base) throw new Error('Original expedition base is missing');
    // Query accepted obligations, not only reservations: a missing flight must
    // fail loudly instead of hiding an unpaid source from every future worker.
    const due = await locked.select({ id: starterExpeditions.id }).from(starterExpeditions)
      .leftJoin(starterExpeditionReturns, eq(starterExpeditionReturns.expeditionId, starterExpeditions.id))
      .where(and(eq(starterExpeditions.baseId, originalBaseId), lte(starterExpeditions.returnsAt, settledAt),
        isNull(starterExpeditionReturns.id)))
      .orderBy(asc(starterExpeditions.returnsAt), asc(starterExpeditions.id));
    const proofs: StarterExpeditionReturnProof[] = [];
    for (const source of due) {
      const trip = await readStarterExpedition(locked, source.id);
      if (!trip || trip.baseId !== base.id || trip.returnsAt.getTime() > settledAt.getTime()) {
        throw new Error('Original due expedition evidence changed');
      }
      const [flight] = await locked.select().from(starterExpeditionInflight)
        .where(eq(starterExpeditionInflight.expeditionId, trip.id)).for('update');
      if (!flight || flight.installationId !== trip.installationId) {
        throw new Error('Original expedition vehicle reservation is missing or different');
      }
      await lockEquipmentReturnStocks(locked,base.id,trip.resourceId,trip.routeSnapshot.secondaryOutput);
      await locked.insert(resourceStocks).values({ baseId: base.id, resourceId: trip.resourceId })
        .onConflictDoNothing();
      const [stock] = await locked.select().from(resourceStocks)
        .where(and(eq(resourceStocks.baseId, base.id), eq(resourceStocks.resourceId, trip.resourceId))).for('update');
      if (!stock) throw new Error('Original expedition stock could not be locked');
      RawResourceStockSchema.parse({ resourceId: stock.resourceId, available: stock.available.toString(),
        reserved: stock.reserved.toString(), total: (stock.available + stock.reserved).toString() });
      const available = stock.available + trip.net;
      if (available + stock.reserved > RAW_RESOURCE_STORAGE_MAX) {
        throw new Error('Expedition return would overflow original raw stock');
      }
      const [receipt] = await locked.insert(starterExpeditionReturns)
        .values({ expeditionId: trip.id, custodyWallet: base.ownerWallet, returnedAt: settledAt }).returning();
      if (!receipt) throw new Error('Original expedition return was not persisted');
      const entries = await locked.insert(starterExpeditionEntries)
        .values(expectedEntries(trip).map(entry => ({ returnId: receipt.id, ...entry }))).returning();
      await locked.update(resourceStocks).set({ available })
        .where(and(eq(resourceStocks.baseId, base.id), eq(resourceStocks.resourceId, trip.resourceId)));
      const released = await locked.delete(starterExpeditionInflight).where(and(
        eq(starterExpeditionInflight.expeditionId, trip.id),
        eq(starterExpeditionInflight.installationId, trip.installationId),
      )).returning({ id: starterExpeditionInflight.expeditionId });
      if (released.length !== 1) throw new Error('Original expedition vehicle was not released');
      if(trip.routeSnapshot.fitting)await finishStarterEquipmentReturn(locked,trip.id);
      proofs.push({ expedition: trip, receipt, entries: entries.sort((a, b) => a.bucket.localeCompare(b.bucket)) });
    }
    return proofs;
  });
}
