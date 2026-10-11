/** Shared read predicate only. Synthetic build proofs do not claim placement. */
import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, builderJobs, buildings, ledgerTransactions, players } from '../src/db/schema';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { readCompletedLodge } from '../src/game/starterExpeditionFacilities';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
async function fixture() {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  const baseId = base!.id;
  await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  const [lodge] = await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Lodge, tx: 2, ty: 2 }).returning();
  const completedAt = new Date(Date.now() - 1_000);
  const [job] = await db.insert(builderJobs).values({ playerWallet: wallet, baseId, buildingId: lodge!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS.lodge.buildSec * 1_000), finishesAt: completedAt, completedAt }).returning();
  return { wallet, baseId, lodge: lodge!, job: job!, completedAt };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (f: Fixture) => db.transaction(async tx => {
  await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
  const [base] = await tx.select().from(bases).where(and(eq(bases.id, f.baseId), eq(bases.ownerWallet, f.wallet), eq(bases.status, 'active'))).for('update');
  const [slot] = await tx.select().from(baseSlots).where(and(eq(baseSlots.baseId, f.baseId), eq(baseSlots.wallet, f.wallet), eq(baseSlots.active, true))).for('update');
  if (!base || !slot) throw new Error('Lodge fixture lacks current custody');
  await assertFreshLockedBaseAuthority(tx, f.wallet, f.baseId);
  return readCompletedLodge(tx, base.id);
});

describe('shared positive Lodge completion', () => {
  it('returns the original timestamp without changing the building or job', async () => {
    const f = await fixture();
    expect(await read(f)).toEqual(f.completedAt);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, f.job.id)))[0]).toEqual(f.job);
    expect((await db.select().from(buildings).where(eq(buildings.id, f.lodge.id)))[0]).toEqual(f.lodge);
  });
  it.each(['no-proof', 'unfinished', 'cancelled', 'upgrade-only', 'wrong-type', 'zero-level'] as const)
    ('does not advertise a Lodge from %s evidence or settle an unfinished job', async invalid => {
      const f = await fixture();
      if (invalid === 'no-proof') await db.delete(builderJobs).where(eq(builderJobs.id, f.job.id));
      if (invalid === 'unfinished') await db.update(builderJobs).set({ completedAt: null }).where(eq(builderJobs.id, f.job.id));
      if (invalid === 'cancelled') {
        // SQL forbids cancelling an original build. A lawful cancelled upgrade
        // carries both receipt identities and must never substitute for it.
        await expect(db.update(builderJobs).set({ cancelledAt: f.completedAt }).where(eq(builderJobs.id, f.job.id))).rejects.toThrow();
        const receipts = await db.insert(ledgerTransactions).values(['debit', 'refund'].map(kind => ({
          type: `test.cancelled-lodge.${kind}`, idempotencyKey: randomUUID(), metadata: { synthetic: true },
        }))).returning();
        await db.update(builderJobs).set({ kind: 'upgrade', paidShardCost: 1n,
          debitLedgerTxnId: receipts[0]!.id, refundLedgerTxnId: receipts[1]!.id,
          cancelledAt: f.completedAt, cancelIdempotencyKey: randomUUID() }).where(eq(builderJobs.id, f.job.id));
      }
      if (invalid === 'upgrade-only') await db.update(builderJobs).set({ kind: 'upgrade' }).where(eq(builderJobs.id, f.job.id));
      if (invalid === 'wrong-type') await db.update(buildings).set({ type: BuildingType.Camp }).where(eq(buildings.id, f.lodge.id));
      if (invalid === 'zero-level') await db.update(buildings).set({ level: 0 }).where(eq(buildings.id, f.lodge.id));
      expect(await read(f)).toBeNull();
      if (invalid === 'unfinished') expect((await db.select().from(builderJobs).where(eq(builderJobs.id, f.job.id)))[0]!.completedAt).toBeNull();
    });
  it('never substitutes a completed Lodge on another base', async () => {
    const f = await fixture(), other = await fixture();
    await db.delete(builderJobs).where(eq(builderJobs.id, f.job.id));
    expect(await read(f)).toBeNull(); expect(await read(other)).toEqual(other.completedAt);
  });
  it('returns a future completion explicitly so callers must compare their locked cutoff', async () => {
    const f = await fixture(), future = new Date(Date.now() + 60_000);
    await db.update(builderJobs).set({ completedAt: future }).where(eq(builderJobs.id, f.job.id));
    expect(await read(f)).toEqual(future);
  });
});
