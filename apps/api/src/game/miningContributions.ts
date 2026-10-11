/** D153.199 protected original-resource custody. Internal until resource
 * publication authority; never put contribution value into legacy ingot rows. */
import { ensureResourceMiningPolicy, readResourceMiningDayPolicy } from '../mining/resourceMiningPolicy';
import { randomUUID } from 'node:crypto';
import { PHASE_E_MINING_CONTRIBUTION_V2 as POLICY, PHASE_E_MINING_SCORE_POLICY as SCORE } from '@shardkeep/shared';
import { valueMiningContribution } from '@shardkeep/shared/miningContribution';
import { MiningContributionRequestSchema, MiningContributionEnvelopeSchema,
  matchMiningContributionEnvelope, type MiningContributionRequest } from '@shardkeep/shared/miningContributionApi';
import { sql } from 'drizzle-orm';
import { phaseEMiningEnabled } from '../config';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { bootstrapSystemAccounts, getOrCreateBaseAccount } from '../ledger/accounts';
import { postTransaction, InsufficientFundsError } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

const clock = (at: Date) => { if (!Number.isFinite(at.getTime())) throw Error('Invalid mining custody time'); return at.toISOString(); };
export async function readMiningContribution(db: DbOrTx, wallet: string, id: string, at = new Date()) {
  MiningContributionRequestSchema.shape.idempotencyKey.parse(id);
  const [row] = await db.execute<{ receipt: unknown; settlement: unknown }>(sql`
    select jsonb_build_object('id',r.id,'epochId',r.epoch_id,'wallet',r.actor_wallet,'day',r.day::text,'request',r.request,
      'lines',(select jsonb_agg(jsonb_build_object('resourceId',l.resource_id,'quantity',l.quantity::text,'unitValue',l.unit_value::text,'value',l.value::text) order by l.resource_id) from mining_contribution_lines l where l.receipt_id=r.id),
      'totalValue',r.total_value::text,'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) receipt,
      case when t.receipt_id is null then null else jsonb_build_object('outcome',t.outcome,'settledAt',to_char(t.settled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end settlement
    from mining_contribution_receipts r left join mining_contribution_terminals t on t.receipt_id=r.id where r.id=${id} and r.actor_wallet=${wallet}`);
  return MiningContributionEnvelopeSchema.parse({ wallet, idempotencyKey: id, serverNow: clock(at),
    status: row ? 'accepted' : 'unknown', receipt: row?.receipt ?? null, settlement: row?.settlement ?? null });
}
export async function miningContributionDevelopmentReady(db: DbOrTx, baseId: string, keepLevel: number) {
  const rows = await db.execute<{ type: 'keep' | 'workshop' | 'goldforge'; level: number }>(sql`
    select b.type,b.level from buildings b where b.base_id=${baseId} and b.type in('keep','workshop','goldforge')
    and not exists(select 1 from builder_jobs j where j.building_id=b.id and j.kind='build' and (j.completed_at is null or j.cancelled_at is not null))`);
  return (['keep', 'workshop', 'goldforge'] as const).every(kind => {
    const matches = rows.filter(r => r.type === kind);
    return matches.length === 1 && matches[0]!.level >= SCORE.requiredLevel[kind] && (kind !== 'keep' || matches[0]!.level === keepLevel);
  });
}
export async function readFreeMiningCommittedValue(db: DbOrTx, wallet: string, day: string) {
  const [row] = await db.execute<{ value: string }>(sql`select coalesce(sum(total_value),0)::text value from mining_contribution_receipts
    where actor_wallet=${wallet} and day=${day}::date and pool='free'`);
  return BigInt(row!.value);
}
/** Original receipt is intentionally independent of today's owner and switches. */
export async function reserveMiningContribution(db: Db, wallet: string, input: MiningContributionRequest,
  authority: StableBaseMutationContext, dependencies: { clock?: () => Date } = {}) {
  const request = MiningContributionRequestSchema.parse(input), now = () => (dependencies.clock ?? (() => new Date()))();
  const original = await readMiningContribution(db, wallet, request.idempotencyKey, now());
  if (original.status === 'accepted') return matchMiningContributionEnvelope(original, wallet, request);
  try { return await db.transaction(async tx => {
    if (!(await tx.execute(sql`select wallet from players where wallet=${wallet} for update`)).length) throw new HttpError(404, 'Player not found');
    const replay = await readMiningContribution(tx, wallet, request.idempotencyKey, now());
    if (replay.status === 'accepted') return matchMiningContributionEnvelope(replay, wallet, request);
    if ((await tx.execute(sql`select id from mining_contribution_receipts where id=${request.idempotencyKey}`)).length)
      throw new HttpError(409, 'Commitment key belongs to another original command', 'IDEMPOTENCY_BODY_MISMATCH');
    if (!phaseEMiningEnabled()) throw new HttpError(503, 'Mining commitments are paused', 'PHASE_E_DISABLED');
    if (authority.baseId !== request.baseId) throw new HttpError(404, 'Base not owned', 'BASE_NOT_OWNED');
    const base = await lockStablePrerequisiteBase(tx, wallet, authority);
    const acceptedAt = clock(now()), day = acceptedAt.slice(0, 10);
    if (request.expectedDay !== day) throw new HttpError(409, 'The mining day changed; review your basket again', 'MINING_DAY_CHANGED');
    if (!await miningContributionDevelopmentReady(tx, base.id, base.keepLevel)) throw new HttpError(422, 'Complete the required mining facilities first', 'DEVELOPMENT_REQUIRED');
    if(request.policyVersion!==await readResourceMiningDayPolicy(tx,day)) throw new HttpError(409, 'Mining policy changed; review your basket again', 'MINING_POLICY_REVIEW_REQUIRED');
    await ensureResourceMiningPolicy(tx,request.policyVersion);
    const valued = valueMiningContribution(request.lines, request.policyVersion);
    const pool = base.landPaidAt !== null && base.deedAssetId !== null ? 'deed' : 'free';
    if (pool === 'free' && await readFreeMiningCommittedValue(tx, wallet, day) + BigInt(valued.totalValue) > BigInt(POLICY.freeValuePerWalletDay))
      throw new HttpError(422, 'This basket exceeds your remaining daily mining allowance', 'MINING_FREE_CAP_EXCEEDED');
    const epochKey = `resource-mining-v${request.policyVersion}:${day}`;
    await tx.execute(sql`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${randomUUID()},${epochKey},${acceptedAt}::timestamptz) on conflict do nothing`);
    const [epoch] = await tx.execute<{ id: string }>(sql`select id from mining_ingot_epochs where epoch_key=${epochKey} for update`);
    const contribution = { id: request.idempotencyKey, baseId: base.id, wallet };
    const shards = valued.lines.find(l => l.resourceId === 'shards');
    const txn = shards ? await postShards(tx, contribution, BigInt(shards.quantity), 'reserve') : null;
    await tx.execute(sql`insert into mining_contribution_receipts(id,actor_wallet,base_id,epoch_id,day,policy_version,pool,request,total_value,shards_txn_id,created_at)
      values(${contribution.id},${wallet},${base.id},${epoch!.id},${day}::date,${request.policyVersion},${pool},${JSON.stringify(request)}::jsonb,${valued.totalValue}::numeric,${txn},${acceptedAt}::timestamptz)`);
    for (const line of valued.lines) await tx.execute(sql`insert into mining_contribution_lines(receipt_id,resource_id,quantity,unit_value,value)
      values(${contribution.id},${line.resourceId},${line.quantity}::bigint,${line.unitValue}::numeric,${line.value}::numeric)`);
    return readMiningContribution(tx, wallet, contribution.id, new Date(acceptedAt));
  }); } catch (error) {
    const cause = error as { cause?: { message?: string }; message?: string };
    if(['MINING_RESOURCE_EPOCH_POLICY','MINING_RESOURCE_POLICY_CONFLICT'].includes(cause.cause?.message??cause.message??''))
      throw new HttpError(409, 'Mining policy changed; review your basket again', 'MINING_POLICY_REVIEW_REQUIRED');
    if (error instanceof InsufficientFundsError || cause.cause?.message === 'INSUFFICIENT_MINING_RESOURCES' || cause.message === 'INSUFFICIENT_MINING_RESOURCES')
      throw new HttpError(422, 'The original resources are no longer available', 'INSUFFICIENT_MINING_RESOURCES');
    throw error;
  }
}
async function postShards(tx: DbTx, original: { id: string; baseId: string; wallet: string }, quantity: bigint, kind: 'reserve' | 'returned' | 'consumed') {
  const systems = await bootstrapSystemAccounts(tx), base = await getOrCreateBaseAccount(tx, original.baseId, 'base_shards');
  const direction = kind === 'reserve' ? 1n : -1n;
  const posted = await postTransaction(tx, { idempotencyKey: `mining-contribution:${original.id}:${kind}`, type: `mining.contribution.${kind}`,
    metadata: { contributionId: original.id, baseId: original.baseId, wallet: original.wallet, quantity: String(quantity) },
    entries: [{ account: systems.mining_contribution_escrow, delta: direction * quantity },
      { account: kind === 'consumed' ? systems.shard_burn : base.id, delta: -direction * quantity }] });
  return posted.transaction.id;
}
/** Internal abort returns every original basket. A prepared attempt
 * permanently refuses this path even if no network receipt has arrived. */
export async function abortMiningContributions(db: Db, request: { epochId: string; decisionKey: string; reason: string }, at = new Date()) {
  return db.transaction(async tx => {
    const original = await tx.execute<{ decision_key: string; reason: string }>(sql`select decision_key,reason from mining_ingot_aborts where epoch_id=${request.epochId}`);
    if (original[0]) {
      if (original[0].decision_key !== request.decisionKey || original[0].reason !== request.reason) throw new HttpError(409, 'Abort body mismatch', 'IDEMPOTENCY_BODY_MISMATCH');
      return;
    }
    const discovered = await tx.execute<{ base_id: string; owner_wallet: string }>(sql`select distinct r.base_id,b.owner_wallet from mining_contribution_receipts r join bases b on b.id=r.base_id where r.epoch_id=${request.epochId} order by r.base_id`);
    for (const wallet of [...new Set(discovered.map(r => r.owner_wallet))].sort()) await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
    for (const source of discovered) {
      const [base] = await tx.execute<{ owner_wallet: string }>(sql`select owner_wallet from bases where id=${source.base_id} for update`);
      if (base?.owner_wallet !== source.owner_wallet) throw new HttpError(409, 'Ownership changed; retry abort');
      if ((await tx.execute(sql`select raid_id from base_raid_locks where base_id=${source.base_id} for update`)).length) throw new HttpError(423, 'Base is being raided', 'BASE_BEING_RAIDED');
    }
    const [epoch] = await tx.execute(sql`select id from mining_ingot_epochs where id=${request.epochId} and epoch_key like 'resource-mining-v%' for update nowait`);
    if (!epoch) throw new HttpError(404, 'Resource epoch not found');
    const [replay] = await tx.execute<{ decision_key: string; reason: string }>(sql`select decision_key,reason from mining_ingot_aborts where epoch_id=${request.epochId}`);
    if (replay) {
      if (replay.decision_key !== request.decisionKey || replay.reason !== request.reason) throw new HttpError(409, 'Abort body mismatch', 'IDEMPOTENCY_BODY_MISMATCH');
      return;
    }
    const receipts = await tx.execute<{ id: string; base_id: string; actor_wallet: string; quantity: string | null }>(sql`select r.id,r.base_id,r.actor_wallet,l.quantity::text from mining_contribution_receipts r left join mining_contribution_lines l on l.receipt_id=r.id and l.resource_id='shards' where r.epoch_id=${request.epochId} order by r.base_id,r.id`);
    if (receipts.some(r => !discovered.some(d => d.base_id === r.base_id))) throw new HttpError(409, 'Epoch sources changed; retry abort');
    await tx.execute(sql`insert into mining_ingot_aborts(epoch_id,decision_key,reason,created_at) values(${request.epochId},${request.decisionKey},${request.reason},${clock(at)}::timestamptz)`);
    for (const r of receipts) {
      const txn = r.quantity ? await postShards(tx, { id: r.id, baseId: r.base_id, wallet: r.actor_wallet }, BigInt(r.quantity), 'returned') : null;
      await tx.execute(sql`insert into mining_contribution_terminals(receipt_id,outcome,epoch_id,shards_txn_id,settled_at) values(${r.id},'returned',${request.epochId},${txn},${clock(at)}::timestamptz)`);
    }
  });
}

/** Transaction-only settlement primitive. Database guards require the exact saved
 * manifest and finalized settlement before this can consume or return anything.
 * Callers hold current-owner/base/raid/epoch locks in the ordinary order. */
export async function settleMiningContribution(tx: DbTx, epochId: string, id: string, outcome: 'consumed' | 'returned', at?:Date) {
  const [r] = await tx.execute<{ base_id: string; actor_wallet: string; quantity: string | null }>(sql`
    select r.base_id,r.actor_wallet,l.quantity::text from mining_contribution_receipts r
    left join mining_contribution_lines l on l.receipt_id=r.id and l.resource_id='shards'
    where r.id=${id} and r.epoch_id=${epochId}`);
  if (!r) throw Error('MINING_RESOURCE_SOURCE_CONFLICT');
  const txn = r.quantity ? await postShards(tx, { id, baseId: r.base_id, wallet: r.actor_wallet }, BigInt(r.quantity), outcome) : null;
  await tx.execute(sql`insert into mining_contribution_terminals(receipt_id,outcome,epoch_id,shards_txn_id,settled_at)
    values(${id},${outcome},${epochId},${txn},coalesce(${at?clock(at):null}::timestamptz,clock_timestamp()))`);
}
