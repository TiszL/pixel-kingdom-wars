/** An observed production settlement preserves an earned numerator. It does not
 * claim historical referral/emission change times or freeze a future quota. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';

const quantity = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const mineProductionClockSchema = z.object({
  version: z.literal(2), settlementId: z.uuid(), remainder: quantity,
}).strict();
export type MineProductionClock = Readonly<z.infer<typeof mineProductionClockSchema>>;

export function mineUnitCompletion(anchor: bigint, quota: bigint, day: bigint, unit: bigint, remainder = 0n): bigint {
  if (quota <= 0n || day <= 0n || unit <= 0n || remainder < 0n || remainder >= day)
    throw Error('Invalid original Mine production clock');
  return anchor + (unit * day - remainder + quota - 1n) / quota;
}
export function mineProductionRemainder(clock: MineProductionClock | undefined, day: bigint): bigint {
  if (!clock) return 0n;
  const value = mineProductionClockSchema.parse(clock), remainder = BigInt(value.remainder);
  if (remainder >= day) throw Error('Invalid original Mine fractional numerator');
  return remainder;
}

export interface MineProductionSettlementInput {
  mineId: string; baseId: string; wallet: string; version: number;
  lastAt: Date; previous: bigint; remainderBefore: bigint | null;
  now: Date; quota: bigint; capacity: bigint; gross: bigint; remainderAfter: bigint;
  targetBuffer: bigint; targetAt: Date;
  kind: 'capture' | 'reanchor' | 'collect' | 'capacity_discard';
}
/** Must precede this settlement's segments and exact numeric state UPDATE in
 * the caller's existing transaction. SQL binds the actual before/after rows. */
export async function prepareMineProductionSettlement(db: DbOrTx, input: MineProductionSettlementInput): Promise<string> {
  await db.execute(sql`select public.shardkeep_mine_production_hooks()`);
  const id = randomUUID();
  await db.execute(sql`insert into shards_mine_production_settlements
    (id,mine_id,base_id,wallet,state_version,anchor_at,previous_gross,remainder_before,
     observed_at,quota,capacity,gross,remainder_after,target_buffer,target_at,kind)
    values(${id},${input.mineId},${input.baseId},${input.wallet},${input.version},${input.lastAt.toISOString()},
      ${input.previous.toString()},${input.remainderBefore?.toString() ?? null},${input.now.toISOString()},
      ${input.quota.toString()},${input.capacity.toString()},${input.gross.toString()},${input.remainderAfter.toString()},
      ${input.targetBuffer.toString()},${input.targetAt.toISOString()},${input.kind})`);
  return id;
}
export async function attachMineProductionClock(db: DbOrTx, segmentId: string, settlementId: string): Promise<void> {
  await db.execute(sql`insert into shards_mine_segment_production(segment_id,settlement_id) values(${segmentId},${settlementId})`);
}
/** Missing side rows mean v1 only. SQL's paired source-state/segment guards
 * forbid a tracked settlement from omitting its original clock relation. */
export async function readMineProductionClock(db: DbOrTx, segmentId: string, sourceKey: string): Promise<MineProductionClock | undefined> {
  const marker = /:p([0-9a-f-]{36})$/.exec(sourceKey);
  if (!marker) return undefined;
  await db.execute(sql`select public.shardkeep_mine_production_hooks()`);
  type Row = { id: string; mine_id: string; base_id: string; wallet: string; source_key: string; anchor_at: Date;
    quota: string; first_unit: string; last_unit: string; gross: string; starts_at: Date; ends_at: Date;
    recovery_parent_id: string | null; settlement_id: string; applied: boolean; p_mine: string; p_base: string;
    p_wallet: string; p_anchor: Date; p_at: Date; p_target_at: Date; p_version: number; p_quota: string;
    p_capacity: string; p_previous: string; p_gross: string; p_remainder: string | null; p_after: string;
    p_target: string; p_kind: MineProductionSettlementInput['kind']; precise: boolean };
  const [row] = await db.execute<Row>(sql`
    select s.*,p.id settlement_id,p.applied,p.mine_id p_mine,p.base_id p_base,p.wallet p_wallet,
      p.anchor_at p_anchor,p.observed_at p_at,p.target_at p_target_at,p.state_version p_version,
      p.quota::text p_quota,p.capacity::text p_capacity,p.previous_gross::text p_previous,
      p.gross::text p_gross,p.remainder_before::text p_remainder,p.remainder_after::text p_after,
      p.target_buffer::text p_target,p.kind p_kind,
      (s.anchor_at=date_trunc('milliseconds',s.anchor_at) and s.starts_at=date_trunc('milliseconds',s.starts_at)
       and s.ends_at=date_trunc('milliseconds',s.ends_at) and p.anchor_at=date_trunc('milliseconds',p.anchor_at)
       and p.observed_at=date_trunc('milliseconds',p.observed_at) and p.target_at=date_trunc('milliseconds',p.target_at)) precise
    from shards_mine_segments s join shards_mine_segment_production c on c.segment_id=s.id
    join shards_mine_production_settlements p on p.id=c.settlement_id where s.id=${segmentId}`);
  const need = (value: unknown): void => { if (!value) throw Error('Original Mine production clock differs from retained settlement'); };
  need(row && row.settlement_id === marker[1] && row.source_key === sourceKey && row.applied && row.precise);
  if (!row) throw Error('Original Mine production clock unavailable');
  // This checks retained arithmetic and original source scope, never today's
  // owner/rate and never a claim that SQL authenticates historical providers.
  const { MINE_DAY_MS } = await import('../game/baseMining');
  const { MINING } = await import('@shardkeep/shared');
  const day = BigInt(MINE_DAY_MS), quota = BigInt(row.p_quota), remainder = BigInt(row.p_remainder ?? '0');
  const before = BigInt(row.p_previous), gross = BigInt(row.p_gross), capacity = BigInt(row.p_capacity);
  const anchor = +new Date(row.p_anchor), observed = +new Date(row.p_at), target = +new Date(row.p_target_at);
  need(Number.isSafeInteger(anchor) && Number.isSafeInteger(observed) && Number.isSafeInteger(target)
    && Number.isSafeInteger(row.p_version) && row.p_version >= 0 && observed >= anchor
    && quota > 0n && remainder >= 0n && remainder < day && before >= 0n && gross > 0n
    && capacity === quota * BigInt(MINING.MINE_STORAGE_DAYS)
    && ['capture', 'collect', 'reanchor'].includes(row.p_kind));
  const numerator = remainder + quota * BigInt(observed - anchor);
  const room = capacity > before ? capacity - before : 0n, uncapped = numerator / day;
  const gain = uncapped < room ? uncapped : room, projected = before + gain;
  need(gross === gain && BigInt(row.p_after) === (projected >= capacity ? 0n : numerator % day)
    && target === observed && BigInt(row.p_target) === (row.p_kind === 'collect' ? 0n : projected)
    && (row.p_remainder !== null || row.p_kind === 'capture' && projected < capacity));
  const first = BigInt(row.first_unit), last = BigInt(row.last_unit);
  need(row.mine_id === row.p_mine && row.base_id === row.p_base && row.wallet === row.p_wallet
    && +new Date(row.anchor_at) === anchor && BigInt(row.quota) === quota
    && first > 0n && last >= first && last <= gross && BigInt(row.gross) === last - first + 1n
    && +new Date(row.starts_at) === Number(mineUnitCompletion(BigInt(anchor), quota, day, first, remainder))
    && +new Date(row.ends_at) === Number(mineUnitCompletion(BigInt(anchor), quota, day, last, remainder)));
  if (row.recovery_parent_id) {
    const [parent] = await db.execute<{ source_key: string; recovery_parent_id: string | null; first_unit: string; last_unit: string }>(sql`
      select source_key,recovery_parent_id,first_unit::text,last_unit::text from shards_mine_segments where id=${row.recovery_parent_id}`);
    need(parent && parent.recovery_parent_id === null);
    if (!parent || parent.recovery_parent_id !== null) throw Error('Original Mine production parent unavailable');
    const original = await readMineProductionClock(db, row.recovery_parent_id, parent.source_key);
    need(original?.settlementId === row.settlement_id && original.remainder === remainder.toString()
      && first >= BigInt(parent.first_unit) && last <= BigInt(parent.last_unit)
      && sourceKey === `mine-recovered:${row.recovery_parent_id}:u${first}:p${row.settlement_id}`);
  } else need(sourceKey === `mine:${row.mine_id}:v${row.p_version}:u${first}:p${row.settlement_id}`);
  return Object.freeze({ version: 2, settlementId: row.settlement_id, remainder: remainder.toString() });
}
