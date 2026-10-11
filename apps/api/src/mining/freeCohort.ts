/** Internal prospective identity evidence; no fee, score or allocation authority. */
import { BUILD_COSTS } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from '../game/stableBasePrerequisites';

export interface FreeCohortEnrollment {
  wallet: string; baseId: string; enrolledAt: string; effectiveFrom: string; baseline: Record<string, unknown>;
}
const iso = (value: unknown) => new Date(String(value)).toISOString();
const barrier = sql`lock table mining_free_coverage,mining_free_cohorts,mining_free_cohort_events in share mode nowait`;
async function enrollment(db: DbOrTx, wallet: string): Promise<FreeCohortEnrollment | null> {
  const [row] = await db.execute<{ wallet: string; base_id: string; enrolled_at: unknown; effective_from: unknown; baseline: Record<string, unknown> }>(sql`select * from mining_free_cohorts where wallet=${wallet}`);
  return row ? { wallet: row.wallet, baseId: row.base_id, enrolledAt: iso(row.enrolled_at), effectiveFrom: iso(row.effective_from), baseline: row.baseline } : null;
}
/** One explicit prospective coverage boundary. No history is backfilled. */
export async function initializeFreeCohortCoverage(db: Db): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`lock table players,bases,base_slots,seeker_links,ledger_entries,accounts,ledger_transactions,
      mining_free_cohort_events,playtest_activity_coverage,player_action_events,buildings,builder_jobs in share mode nowait`);
    await tx.execute(sql`insert into mining_free_coverage(id,started_at) values(true,public.shardkeep_mining_free_clock()) on conflict do nothing`);
  });
}
export async function enrollInitialFreeCohort(db: Db, wallet: string, context: StableBaseMutationContext): Promise<FreeCohortEnrollment> {
  return db.transaction(async tx => {
    await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
    const prior = await enrollment(tx, wallet);
    if (prior) {
      if (prior.baseId !== context.baseId) throw new Error('MINING_FREE_ALREADY_ENROLLED');
      return prior;
    }
    if (!phaseEMiningEnabled()) throw new Error('MINING_FREE_DISABLED');
    const base = await lockStablePrerequisiteBase(tx, wallet, context);
    if (base.keepLevel < BUILD_COSTS.workshop.requiresKeepLevel) throw new Error('MINING_FREE_DEVELOPMENT_REQUIRED');
    await tx.execute(sql`insert into mining_free_cohorts(wallet,base_id,enrolled_at,effective_from,baseline)
      values(${wallet},${context.baseId},public.shardkeep_mining_free_clock(),public.shardkeep_mining_free_clock(),'{}')`);
    return (await enrollment(tx, wallet))!;
  });
}
export async function readFreeCohortInterval(db: DbOrTx, wallet: string, day: string) {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(+start) || start.toISOString().slice(0, 10) !== day) throw new Error('MINING_FREE_DAY_INVALID');
  const end = new Date(+start + 86_400_000).toISOString();
  return db.transaction(async tx => {
    await tx.execute(barrier);
    const [clock] = await tx.execute<{ now: unknown; isolation: string }>(sql`select public.shardkeep_mining_free_clock() as now,current_setting('transaction_isolation') as isolation`);
    if (clock?.isolation !== 'read committed') throw new Error('MINING_FREE_READ_COMMITTED_REQUIRED');
    const observedAt = iso(clock!.now);
    if (observedAt < end) throw new Error('MINING_FREE_DAY_OPEN');
    const record = await enrollment(tx, wallet);
    if (!record) throw new Error('MINING_FREE_NOT_ENROLLED');
    const rows = await tx.execute<{ id: string; observed_at: unknown; source_table: string; source_id: string; operation: string; before_state: unknown; after_state: unknown }>(sql`
      select id::text,observed_at,source_table,source_id,operation,before_state,after_state from mining_free_cohort_events
      where wallet=${wallet} and id>${String(record.baseline['lastEventId'])}::bigint and observed_at<${end}::timestamptz order by id limit 10001`);
    if (rows.length > 10000) throw new Error('MINING_FREE_HISTORY_TOO_LARGE');
    const events = rows.map(r => ({ id: r.id, observedAt: iso(r.observed_at), sourceTable: r.source_table, sourceId: r.source_id,
      operation: r.operation, beforeState: r.before_state, afterState: r.after_state }));
    const reason = record.effectiveFrom > start.toISOString() ? 'not-effective' : events.length ? 'invalidated' : 'valid';
    return { wallet, baseId: record.baseId, day, enrollment: record, observedAt, valid: reason === 'valid', reason, events };
  });
}
