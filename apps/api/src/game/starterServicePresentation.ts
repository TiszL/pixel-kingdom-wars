/** Optional renderer facts, read only inside the authorized post-settlement base
 * transaction. Original expedition/installation DTOs and their authority stay unchanged. */
import {BuildingType} from '@shardkeep/shared';
import {and,eq,isNotNull,isNull,or} from 'drizzle-orm';
import type {DbTx} from '../db/client';
import {starterExpeditionInflight,starterExpeditionReturns,starterExpeditions} from '../db/schema';
import {readStarterExpedition} from './starterExpeditionDispatch';
import type {readStarterFleetView} from './starterFleetView';

export interface StarterServicePresentation {
 version:1;
 berths:Array<{buildingId:string;installation:null|{family:'starter';presence:'occupied'|'away'}}>;
}
type Building={id:string;type:string;level:number;underConstruction:boolean};

export async function readStarterServicePresentation(tx:DbTx,baseId:string,buildings:readonly Building[],
 fleet:Awaited<ReturnType<typeof readStarterFleetView>>,cutoff:Date):Promise<StarterServicePresentation|null>{
 const berths=buildings.filter(b=>b.type===BuildingType.Berth).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 if(new Set(berths.map(b=>b.id)).size!==berths.length)return null;
 const installed=fleet.installation;
 if(installed){
  const berth=berths.find(b=>b.id===installed.berthId);
  if(installed.baseId!==baseId||!berth||berth.level<1||berth.underConstruction
   ||Date.parse(installed.installedAt)>cutoff.getTime()||Date.parse(installed.berthCompletedAt)>cutoff.getTime()
   ||!fleet.eligibleBerths.some(b=>b.berthId===installed.berthId&&b.completedBuildJobId===installed.completedBuildJobId
    &&b.berthCompletedAt===installed.berthCompletedAt))return null;
 }
 // Originals, not only pointers: losing a reservation cannot make an accepted
 // unreturned trip look like an occupied vessel. Returned-but-reserved is invalid too.
 const active=await tx.select({id:starterExpeditions.id,installationId:starterExpeditions.installationId,
  activeId:starterExpeditionInflight.installationId,returned:starterExpeditionReturns.expeditionId})
  .from(starterExpeditions).leftJoin(starterExpeditionInflight,eq(starterExpeditionInflight.expeditionId,starterExpeditions.id))
  .leftJoin(starterExpeditionReturns,eq(starterExpeditionReturns.expeditionId,starterExpeditions.id))
  .where(and(eq(starterExpeditions.baseId,baseId),or(isNull(starterExpeditionReturns.expeditionId),isNotNull(starterExpeditionInflight.expeditionId))));
 // Independently close the current installation's pointer: its original may be
 // missing or bound to another base, and would then be absent from the base scan.
 const pointers=installed?await tx.select({id:starterExpeditionInflight.expeditionId}).from(starterExpeditionInflight)
  .where(eq(starterExpeditionInflight.installationId,installed.installationId)):[];
 if(active.length>1||pointers.length!==active.length)return null;
 let presence:'occupied'|'away'='occupied';
 if(active.length){
  const item=active[0]!;
  if(!installed||item.returned!==null||item.installationId!==installed.installationId||item.activeId!==installed.installationId
   ||pointers[0]?.id!==item.id)return null;
  const original=await readStarterExpedition(tx,item.id);
  if(!original||original.baseId!==baseId||original.installationId!==installed.installationId
   ||original.departedAt>cutoff||original.returnsAt<=cutoff)return null;
  presence='away';
 }
 // No catch: SQL and mandatory source-integrity failures must abort the caller's
 // transaction. Only the explicit optional-source mismatches above yield null.
 return {version:1,berths:berths.map(b=>({buildingId:b.id,
  installation:installed?.berthId===b.id?{family:'starter',presence}:null}))};
}
