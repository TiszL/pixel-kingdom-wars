import { readResourceMiningDayPolicy, readResourceMiningCutover } from './resourceMiningPolicy';
/** Private exact native-resource capture. A saved attempt is a permanent fence,
 * not proof that its transaction landed and never permission to return stock. */
import { createHash } from 'node:crypto';
import { PACKET_DATA_SIZE } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { miningCanonical } from './fundedMiningAudit';
import { validateResourceMiningOriginals } from './resourceMiningAudit';
import type { ResourceMiningOriginal } from './resourceMiningAllocation';

export async function readResourceMiningEpoch(db: Db, input: { epochId: string; day: string; policyVersion: 2 | 3 }, clock?:()=>Date) {
  return db.transaction(async tx => {
    await tx.execute(sql`select public.shardkeep_divine_fragment_source()`);
    const at=clock?.();if(at&&!Number.isFinite(at.getTime()))throw Error('MINING_RESOURCE_CLOCK');
    const [e] = await tx.execute<{ id: string; key: string; createdAt: string; closed: boolean }>(sql`
      select id,epoch_key key,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "createdAt",
        coalesce(${at?.toISOString()??null}::timestamptz,clock_timestamp())>=(${input.day}::date+1)::timestamp at time zone 'UTC' closed
      from mining_ingot_epochs where id=${input.epochId} for update nowait`);
    if(input.policyVersion!==await readResourceMiningDayPolicy(tx,input.day))throw Error('MINING_RESOURCE_POLICY_CONFLICT');
    if (!e || e.key !== `resource-mining-v${input.policyVersion}:${input.day}` || !e.closed) throw Error('MINING_RESOURCE_EPOCH_UNAVAILABLE');
    if ((await tx.execute(sql`select 1 from mining_ingot_aborts where epoch_id=${e.id} union all select 1 from mining_publication_attempts where epoch_id=${e.id}`)).length)
      throw Error('MINING_RESOURCE_EPOCH_DECIDED');
    const [row] = await tx.execute<{ contributions: ResourceMiningOriginal[] }>(sql`select public.shardkeep_mining_resource_originals(${e.id}) contributions`);
    if (!row) throw Error('MINING_RESOURCE_SOURCE_CONFLICT');
    const contributionSetSha256 = validateResourceMiningOriginals(e.id, input.day, e.createdAt, row.contributions,input.policyVersion);
    const cutover=input.policyVersion===3?await readResourceMiningCutover(tx):null;
    if(input.policyVersion===3){
      if(!cutover)throw Error('MINING_RESOURCE_CUTOVER_MISSING');
      await tx.execute(sql`select public.shardkeep_mining_resource_prior_decided(${input.day}::date)`);
    }
    return { ...(cutover?{cutover}:{}), id: e.id, key: e.key, createdAt: e.createdAt, contributionSetSha256, contributions: row.contributions };
  });
}
export interface ResourceMiningPublicationAttempt {
  epochId: string; attemptKey: string; intentHex: string; intentSha256: string;
  contributionSetSha256: string; contributionCount: number; reservedValue: string;
  contributions: ResourceMiningOriginal[]; preparedAt: string;
  publicationFinalized: false; consumptionAuthorized: false;
}
/** Owner-only immutable recovery remains independent of flag/provider state. */
export async function getResourceMiningPublicationAttempt(db: DbOrTx, epochId: string): Promise<ResourceMiningPublicationAttempt | null> {
  z.uuid().parse(epochId);
  const [owner] = await db.execute<{ allowed: boolean }>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_publication_attempts'::regclass) allowed`);
  if (!owner?.allowed) throw Error('MINING_PUBLICATION_OWNER_REQUIRED');
  const [row] = await db.execute<{ receipt: ResourceMiningPublicationAttempt; epoch_created_at: string; epoch_key: string }>(sql`
    select jsonb_build_object('epochId',a.epoch_id,'attemptKey',a.attempt_key,'intentHex',encode(a.intent_bytes,'hex'),'intentSha256',a.intent_sha256,
      'contributionSetSha256',a.contributions_sha256,'contributionCount',a.contribution_count,'reservedValue',a.reserved_value::text,
      'contributions',a.contributions,'preparedAt',to_char(a.prepared_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'publicationFinalized',false,'consumptionAuthorized',false) receipt,
      e.epoch_key,to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') epoch_created_at
    from mining_publication_attempts a join mining_ingot_epochs e on e.id=a.epoch_id where a.epoch_id=${epochId} and a.contributions is not null`);
  if (!row) return null;
  const p = row.receipt, match=/^resource-mining-v([23]):(\d{4}-\d{2}-\d{2})$/.exec(row.epoch_key),day=match?.[2];
  if(!day||!match)throw Error('MINING_RESOURCE_SOURCE_CONFLICT');
  const version=Number(match[1]) as 2|3;
  if (!p.intentHex || p.intentHex.length > PACKET_DATA_SIZE * 2
    || !/^(?:[0-9a-f]{2})+$/.test(p.intentHex) || createHash('sha256').update(Buffer.from(p.intentHex, 'hex')).digest('hex') !== p.intentSha256
    || validateResourceMiningOriginals(epochId, day, row.epoch_created_at, p.contributions,version) !== p.contributionSetSha256
    || p.contributionCount !== p.contributions.length || p.reservedValue !== String(p.contributions.reduce((n, r) => n + BigInt(r.totalValue), 0n))
    || !Number.isFinite(Date.parse(p.preparedAt))) throw Error('MINING_RESOURCE_SOURCE_CONFLICT');
  // Ensure ordinary object/array shapes remain serializable and bounded too.
  miningCanonical(p);
  return p;
}
