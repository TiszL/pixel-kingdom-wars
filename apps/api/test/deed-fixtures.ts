import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { bases, baseSlots } from '../src/db/schema';
import { testDbName } from './db-url';

/** Opt-in isolation for suites that admit real deed fixtures. The cumulative
 * test DB must not turn mint/activation assertions into observer-capacity
 * tests. New fixtures still exercise the real capacity guard. */
export async function isolateDeedTestFixtures(
  db: Db, options: { pendingQueue?: boolean; observerQueue?: boolean } = {},
) {
  const [database] = await db.execute(sql`select current_database() as name`);
  // The disposable database global-setup recreates (shardkeep_test in CI; a per-lane
  // *_test locally, 2026-10-10), never another one: this rewrites shared slot rows.
  if (database?.['name'] !== testDbName()) throw new Error(`deed fixture isolation requires the disposable ${testDbName()}`);
  const prior = await db.transaction(async (tx) => {
    const slots = await tx.select({
      baseId: baseSlots.baseId, active: baseSlots.active, selectedAt: baseSlots.selectedAt,
    }).from(baseSlots).where(or(eq(baseSlots.active, true), isNotNull(baseSlots.selectedAt)));
    if (slots.length) await tx.update(baseSlots).set({ active: false, selectedAt: null })
      .where(inArray(baseSlots.baseId, slots.map((slot) => slot.baseId)));
    // The observer scans active deed bases directly, independently of slots.
    // Its suite must likewise observe its own fixtures within the real SLA.
    const observed = options.observerQueue
      ? await tx.select({ id: bases.id, status: bases.status }).from(bases)
        .where(and(eq(bases.status, 'active'), isNotNull(bases.deedAssetId)))
      : [];
    if (observed.length) await tx.update(bases).set({ status: 'inactive' })
      .where(inArray(bases.id, observed.map((base) => base.id)));
    // Only the worker suite needs a private pending queue. Other suites leave
    // prior payment/claim records untouched, including ambiguous mint plans.
    const pending = options.pendingQueue
      ? await tx.select({ id: bases.id, landPaidAt: bases.landPaidAt }).from(bases)
        .where(and(isNotNull(bases.landPaidAt), isNull(bases.deedAssetId)))
      : [];
    if (pending.length) await tx.update(bases).set({ landPaidAt: null })
      .where(inArray(bases.id, pending.map((base) => base.id)));
    return { slots, pending, observed };
  });
  return async () => {
    await db.transaction(async (tx) => {
      for (const base of prior.pending) await tx.update(bases).set({ landPaidAt: base.landPaidAt })
        .where(eq(bases.id, base.id));
      for (const base of prior.observed) await tx.update(bases).set({ status: base.status })
        .where(eq(bases.id, base.id));
      for (const slot of prior.slots) await tx.update(baseSlots)
        .set({ active: slot.active, selectedAt: slot.selectedAt }).where(eq(baseSlots.baseId, slot.baseId));
    });
  };
}
