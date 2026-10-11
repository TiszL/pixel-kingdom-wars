/** Dark Mine policy initialization. Only durable DB evidence is read while
 * gameplay locks are held; this is neither a policy installer nor a term reader. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { lockPhysicalMineTaxActors } from './shardsTaxMineSources';

function held(reason: string): never {
  throw new HttpError(503, `Mine policy initialization held: ${reason}`, 'SHARDS_MINE_POLICY_HELD');
}
function provenanceBusy(error: unknown): never {
  const failure = error as { code?: string; cause?: { code?: string } };
  if (failure?.code === '55P03' || failure?.cause?.code === '55P03')
    held('original source rows are busy; retry');
  throw error;
}

/** Caller already owns the canonical base and Mine-state locks. freshlyInserted
 * comes only from that caller's INSERT RETURNING, never from a player command.
 * Opening stock and its fractional clock are not advanced by initialization. */
export async function initializePhysicalMinePolicyEra(
  tx: DbOrTx,
  input: { mineId: string; at: Date; freshlyInserted: boolean },
): Promise<void> {
  const [policy] = await tx.execute<{ id: number; effective_at: Date }>(sql`
    select id,effective_at from shards_mine_policy_boundary where id=1`);
  if (!policy) return;
  const [prior] = await tx.execute(sql`select mine_id from shards_mine_eras where mine_id=${input.mineId}`);
  if (prior) return;
  const [source] = await tx.execute<{
    base_id: string; owner_wallet: string; type: string; accrued_shards: string;
    last_accrual_at: Date; version: number;
  }>(sql`select b.base_id,p.owner_wallet,b.type,s.accrued_shards::text,s.last_accrual_at,s.version
    from buildings b join bases p on p.id=b.base_id join mine_accrual_states s on s.mine_building_id=b.id
    where b.id=${input.mineId} for update of s nowait`).catch(provenanceBusy);
  if (!source || source.type !== 'mine') held('original physical Mine is unavailable');
  const anchor = new Date(source.last_accrual_at), amount = BigInt(source.accrued_shards);
  if (!Number.isFinite(+input.at) || +anchor > +input.at) held('original clock is unavailable');
  const [reserved] = await tx.execute(sql`select r.raid_id from raid_mine_loot_reservations r
    join raid_loot_reservations h on h.raid_id=r.raid_id
    where r.mine_building_id=${input.mineId} and h.state='reserved' and r.frozen_shards>0 limit 1`);
  if (reserved) held('older raid owns untracked Mine stock');

  let kind: 'locked_pre_policy_state' | 'fresh_scheduled_build' = 'locked_pre_policy_state';
  let jobId: string | null = null, productionAt: Date | null = null;
  if (input.freshlyInserted) {
    const jobs = await tx.execute<{ id: string; finishes_at: Date }>(sql`
      select id,finishes_at from builder_jobs where building_id=${input.mineId}
      and base_id=${source.base_id} and kind='build' and cancelled_at is null for update nowait`).catch(provenanceBusy);
    if (jobs.length > 1) held('ambiguous scheduled Mine origin');
    const job = jobs[0];
    if (job) {
      if (source.version !== 0 || amount !== 0n || +new Date(job.finishes_at) !== +anchor
        || +new Date(job.finishes_at) > +input.at) held('scheduled Mine opening differs');
      kind = 'fresh_scheduled_build'; jobId = job.id; productionAt = new Date(job.finishes_at);
    }
  }
  // A previously materialized unit exactly at B is already post-policy. Without
  // its original split, a nonzero anchor at or after B cannot become legacy.
  if (kind === 'locked_pre_policy_state' && amount > 0n && +anchor >= +new Date(policy.effective_at))
    held('pre-policy buffer evidence is unavailable');
  await lockPhysicalMineTaxActors(tx, [source.owner_wallet]);
  await tx.execute(sql`insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross,
    policy_boundary_id,initialization_kind,source_state_version,source_anchor_at,build_job_id,production_started_at)
    values(${input.mineId},${source.base_id},${input.at.toISOString()},${amount.toString()},${policy.id},${kind},
    ${source.version},${anchor.toISOString()},${jobId},${productionAt?.toISOString() ?? null})`).catch(provenanceBusy);
  if (amount > 0n) await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,source_key,
    starts_at,ends_at,quota,gross,buffer) values(${randomUUID()},${input.mineId},${source.base_id},
    ${'legacy:' + input.mineId},${input.at.toISOString()},${input.at.toISOString()},0,${amount.toString()},${amount.toString()})`);
}
