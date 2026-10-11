import { randomUUID } from 'node:crypto';
import { ECONOMY } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFantasyMigration, fantasyManifestHash, planFantasyMigration } from '../src/db/fantasyMigration';
import { bases } from '../src/db/schema';
import { fantasyPurchasesCutOver, getFantasyClaim, installFantasyCatalog, lockFantasyAllocation } from '../src/game/fantasyLocation';
import { createDepositIntent, creditDeposit, type VerifiedPayment } from '../src/money/deposits';
import { createTestPlayer, randomWallet } from './helpers';
import { isolatedFantasyTestDb } from './fantasy-test-db';

let conn: ReturnType<typeof isolatedFantasyTestDb>;
const originalFantasy = process.env['FANTASY_WORLD_ENABLED']; const originalMulti = process.env['MULTI_BASE_ENABLED'];
beforeEach(async () => {
  conn = isolatedFantasyTestDb(); await conn.prepare(); await conn.db.transaction(installFantasyCatalog);
  process.env['FANTASY_WORLD_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'true';
});
afterEach(async () => conn.dispose());
afterAll(() => {
  if (originalFantasy === undefined) delete process.env['FANTASY_WORLD_ENABLED']; else process.env['FANTASY_WORLD_ENABLED'] = originalFantasy;
  if (originalMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = originalMulti;
});
const manifest = () => planFantasyMigration({ snapshotAt: new Date().toISOString(), active: [], inactive: [], exclusions: [] });
async function oldPayment() {
  const p = await createTestPlayer(conn.db); const quote = await createDepositIntent(conn.db, p.wallet, 'entry');
  if (!('baseId' in quote) || !quote.baseId) throw new Error('Expected original legacy quote');
  const payment: VerifiedPayment = { wallet: p.wallet, kind: 'entry', txSignature: `coverage-${randomUUID()}`,
    lamports: BigInt(Math.round(ECONOMY.entryFeeSol * 1e9)), finalized: true };
  return { quote, baseId: quote.baseId, payment };
}
async function waitForBlockedTransactions(count: number) {
  // Observe real PostgreSQL lock contention; no race depends on a fixed sleep.
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const [row] = await conn.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`);
    if ((row?.n ?? 0) >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected concurrent transactions did not reach the lock barrier');
}
function allocatorBarrier() {
  let release!: () => void; let ready!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const done = conn.db.transaction(async tx => { await lockFantasyAllocation(tx); ready(); await resume; });
  return { held, release, done };
}

describe('complete paid-deed scope at irreversible fantasy cutover', () => {
  for (const minted of [false, true]) it(`blocks a ${minted ? 'minted deed' : 'pending mint'} settled after the reviewed census`, async () => {
    const reviewed = manifest(); const issued = await oldPayment();
    await creditDeposit(conn.db, issued.quote.id, issued.payment);
    if (minted) await conn.db.update(bases).set({ deedAssetId: randomWallet() }).where(eq(bases.id, issued.baseId));
    const before = await conn.db.select().from(bases).where(eq(bases.id, issued.baseId));
    await expect(applyFantasyMigration(conn.db, reviewed, fantasyManifestHash(reviewed), { dryRun: false }))
      .rejects.toMatchObject({ code: 'FANTASY_CENSUS_DRIFT' });
    expect(await fantasyPurchasesCutOver(conn.db)).toBe(false);
    expect(await getFantasyClaim(conn.db, issued.baseId)).toBeNull();
    expect(await conn.db.select().from(bases).where(eq(bases.id, issued.baseId))).toEqual(before);
  });

  it('retries a census captured while legacy credit is blocked on allocation, then refuses the unreviewed settled deed', async () => {
    const reviewed = manifest(); const issued = await oldPayment(); const barrier = allocatorBarrier(); await barrier.held;
    const credit = creditDeposit(conn.db, issued.quote.id, issued.payment);
    let apply: ReturnType<typeof applyFantasyMigration> | undefined;
    try {
      await waitForBlockedTransactions(1);
      apply = applyFantasyMigration(conn.db, reviewed, fantasyManifestHash(reviewed), { dryRun: false });
      // Attach rejection handling before releasing the barrier.
      const outcomes = Promise.allSettled([credit, apply]);
      await waitForBlockedTransactions(2); barrier.release(); await barrier.done;
      const [payment, migration] = await outcomes;
      expect(payment).toMatchObject({ status: 'fulfilled', value: { credited: true } });
      expect(migration).toMatchObject({ status: 'rejected', reason: { code: 'FANTASY_CUTOVER_RETRY' } });
    } finally { barrier.release(); await barrier.done; await Promise.allSettled([credit, ...(apply ? [apply] : [])]); }
    expect(await fantasyPurchasesCutOver(conn.db)).toBe(false);
    await expect(applyFantasyMigration(conn.db, reviewed, fantasyManifestHash(reviewed), { dryRun: false }))
      .rejects.toMatchObject({ code: 'FANTASY_CENSUS_DRIFT' });
  });

  it('preserves payment recovery when apply owns the pending identity first and credit waits', async () => {
    const reviewed = manifest(); const issued = await oldPayment(); const barrier = allocatorBarrier(); await barrier.held;
    const apply = applyFantasyMigration(conn.db, reviewed, fantasyManifestHash(reviewed), { dryRun: false });
    let credit: ReturnType<typeof creditDeposit> | undefined;
    try {
      await waitForBlockedTransactions(1);
      credit = creditDeposit(conn.db, issued.quote.id, issued.payment);
      const outcomes = Promise.allSettled([apply, credit]);
      await waitForBlockedTransactions(2); barrier.release(); await barrier.done;
      const [migration, payment] = await outcomes;
      expect(migration).toMatchObject({ status: 'fulfilled', value: { pendingLegacyHeld: 1 } });
      expect(payment).toMatchObject({ status: 'fulfilled', value: { credited: true } });
    } finally { barrier.release(); await barrier.done; await Promise.allSettled([apply, ...(credit ? [credit] : [])]); }
    expect(await fantasyPurchasesCutOver(conn.db)).toBe(true);
    expect(await getFantasyClaim(conn.db, issued.baseId)).toMatchObject({ state: 'assigned', source: 'purchase', depositId: issued.quote.id });
  });
});
