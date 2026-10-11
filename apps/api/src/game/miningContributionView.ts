import { readResourceMiningDayPolicy } from '../mining/resourceMiningPolicy';
import { HttpError } from '../lib/errors';
/** Current stock is read only under the selected base's authority/locks.
 * Pending outputs, reservations and protected mining inputs are not available. */
import { PHASE_E_MINING_CONTRIBUTION_V2 as POLICY } from '@shardkeep/shared';
import { miningContributionResourceIds, miningResourceUnitValue } from '@shardkeep/shared/miningContribution';
import { MiningContributionViewSchema } from '@shardkeep/shared/miningContributionApi';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { getBaseState } from './base';
import { getBaseShardBalance } from './baseEconomy';
import { miningContributionDevelopmentReady, readFreeMiningCommittedValue } from './miningContributions';
import { requireActiveStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

export async function readMiningContributionView(db:Db,wallet:string,authority:StableBaseMutationContext,clock:()=>Date=()=>new Date(),catalogueVersion:2|3=2){
 return db.transaction(async tx=>{
  // Reuse the established read boundary, including post-lock completion of
  // accepted work. Its locks remain held by this outer transaction.
  const state=await getBaseState(tx,wallet,undefined,authority.baseId,authority.assertAuthority,clock,2);
  if(!state.rawStock||!state.craftingStock||!state.ordinaryCrafting)throw Error('Authorized mining inventory missing');
  const base=await requireActiveStablePrerequisiteBase(tx,wallet,authority.baseId),serverNow=state.ordinaryCrafting.serverNow,day=serverNow.slice(0,10);
  const policyVersion=await readResourceMiningDayPolicy(tx,day);
  if(policyVersion>catalogueVersion)throw new HttpError(409,'Update mining to review the current resources','MINING_POLICY_REVIEW_REQUIRED');
  const stock=new Map<string,string>([...state.rawStock.map(r=>[r.resourceId,r.available] as const),...state.craftingStock.map(r=>[r.itemId,r.available] as const)]);
  stock.set('shards',String(await getBaseShardBalance(tx,base.id)));
  const [ingots]=await tx.execute<{available:string}>(sql`select coalesce(sum(qty),0)::text available from base_items where base_id=${base.id} and item_id='forge_ingot'`);
  const [fragments]=await tx.execute<{available:string}>(sql`select available::text from crystal_fragment_stocks where base_id=${base.id}`);
  stock.set('forge_ingot',ingots!.available);stock.set('crystal_fragment',fragments?.available??'0');
  const pool=base.landPaidAt!==null&&base.deedAssetId!==null?'deed':'free';
  const [all]=pool==='deed'?await tx.execute<{value:string}>(sql`select coalesce(sum(total_value),0)::text value from mining_contribution_receipts where actor_wallet=${wallet} and day=${day}::date`):[];
  const committed=all?BigInt(all.value):await readFreeMiningCommittedValue(tx,wallet,day);
  const cap=BigInt(POLICY.freeValuePerWalletDay),remaining=committed>=cap?0n:cap-committed;
  return MiningContributionViewSchema.parse({wallet,baseId:base.id,policyVersion,day,serverNow,
   acceptingContributions:phaseEMiningEnabled(),pool,dailyCapValue:pool==='deed'?null:String(cap),committedValue:String(committed),remainingValue:pool==='deed'?null:String(remaining),
   developmentReady:await miningContributionDevelopmentReady(tx,base.id,base.keepLevel),
   resources:miningContributionResourceIds(policyVersion).map(resourceId=>({resourceId,available:stock.get(resourceId)??'0',unitValue:String(miningResourceUnitValue(resourceId,policyVersion))})),
   consistency:{windowDays:POLICY.consistencyWindowDays,bonusPerQualifiedDayBps:POLICY.consistencyBonusPerDayBps,maximumBonusBps:POLICY.consistencyWindowDays*POLICY.consistencyBonusPerDayBps}});
 });
}
