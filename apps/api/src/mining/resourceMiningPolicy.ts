/** One immutable prospective transition. This private installer is deliberately
 * absent from routes, environment configuration and server bootstrap. */
import { PHASE_E_MINING_CONTRIBUTION_V2 as V2 } from '@shardkeep/shared';
import { miningContributionResourceIds, miningResourceUnitValue } from '@shardkeep/shared/miningContribution';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { miningCanonical, miningDigest } from './fundedMiningAudit';

export type ResourceMiningPolicyVersion = 2 | 3;
export type ResourceMiningCutover = { firstDay: string; policyVersion: 3; installedAt: string; sha256: string };
export async function ensureResourceMiningPolicy(db: DbOrTx, version: ResourceMiningPolicyVersion) {
 const catalogue=Object.fromEntries(miningContributionResourceIds(version).map(id=>[id,String(miningResourceUnitValue(id,version))]));
 await db.execute(sql`insert into mining_contribution_policies(version,catalogue,free_value)
  values(${version},${JSON.stringify(catalogue)}::jsonb,${String(V2.freeValuePerWalletDay)}::numeric) on conflict do nothing`);
 const [row]=await db.execute(sql`select version from mining_contribution_policies where version=${version}
  and catalogue=${JSON.stringify(catalogue)}::jsonb and free_value=${String(V2.freeValuePerWalletDay)}::numeric`);
 if(!row)throw Error('Mining contribution policy differs from frozen shared catalogue');
}
export async function readResourceMiningDayPolicy(db:DbOrTx,day:string):Promise<ResourceMiningPolicyVersion>{
 const [row]=await db.execute<{version:number}>(sql`select public.shardkeep_mining_resource_day_policy(${day}::date) version`);
 if(row?.version!==2&&row?.version!==3)throw Error('MINING_RESOURCE_POLICY_CONFLICT');return row.version;
}
export async function readResourceMiningCutover(db:DbOrTx):Promise<ResourceMiningCutover|null>{
 const [row]=await db.execute<{firstDay:string;policyVersion:3;installedAt:string}>(sql`
  select first_day::text "firstDay",policy_version "policyVersion",
   to_char(installed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "installedAt"
  from mining_resource_v3_cutover where singleton`);
 return row?{...row,sha256:miningDigest(miningCanonical(row))}:null;
}
export async function installResourceMiningV3Cutover(db:Db,firstDay:string):Promise<ResourceMiningCutover>{
 if('rollback' in db||!/^\d{4}-\d{2}-\d{2}$/.test(firstDay)||!Number.isFinite(Date.parse(firstDay))||new Date(firstDay).toISOString().slice(0,10)!==firstDay)
  throw Error('MINING_RESOURCE_CUTOVER_INPUT');
 return db.transaction(async tx=>{
  await tx.execute(sql`select public.shardkeep_divine_fragment_source()`);
  await tx.execute(sql`lock table mining_ingot_epochs in share row exclusive mode`);
  // Both the trigger and this second statement see rows committed by a writer
  // which held the epoch lock before this installer acquired it.
  const original=await readResourceMiningCutover(tx);
  if(original){if(original.firstDay!==firstDay)throw Error('MINING_RESOURCE_CUTOVER_IMMUTABLE');return original;}
  await ensureResourceMiningPolicy(tx,3);
  await tx.execute(sql`insert into mining_resource_v3_cutover(singleton,first_day,policy_version) values(true,${firstDay}::date,3)`);
  const saved=await readResourceMiningCutover(tx);if(!saved)throw Error('MINING_RESOURCE_CUTOVER_MISSING');return saved;
 });
}
