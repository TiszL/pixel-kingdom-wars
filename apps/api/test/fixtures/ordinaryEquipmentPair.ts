/** Private finite fixture. Actual ordinary refinements and SQL jobs/returns;
 * explicit existing raw stock/installed vehicle/term inputs are fixture data. */
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {PHASE_E_ORDINARY_EQUIPMENT,PHASE_E_POLICY} from '@shardkeep/shared';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {ordinaryRoutePairFixture} from './ordinaryRoutePair';
import {startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../../src/game/ordinaryCrafting';
import {createStarterExpeditionWorkflow} from '../../src/game/starterExpeditionWorkflow';
import {createOrdinaryEquipmentProvider} from '../../src/game/ordinaryEquipmentProvider';
import {ordinaryEquipmentEnvelope} from '../../src/game/ordinaryEquipment';
import {assertFreshLockedBaseAuthority} from '../../src/game/baseOwnership';
import {installStarterFleet} from '../../src/game/starterFleet';
export async function ordinaryEquipmentPairFixture(){
 const f=await ordinaryRoutePairFixture(),db=f.f.conn.db;
 try{
  vi.stubEnv('ORDINARY_CRAFTING_ENABLED','true');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','true');
  const id=randomUUID(),completed=new Date(Date.now()-3_600_000).toISOString(),started=new Date(Date.now()-7_200_000).toISOString();await f.f.conn.sql`insert into buildings(id,base_id,player_wallet,type,tx,ty) values(${id},${f.config.baseId},${f.config.wallet},'workshop',14,5)`;
  await f.f.conn.sql`insert into builder_jobs(base_id,player_wallet,building_id,kind,started_at,finishes_at,completed_at) values(${f.config.baseId},${f.config.wallet},${id},'build',${started},${completed},${completed})`;
  const authority={baseId:f.config.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
  const starterBerth=randomUUID();await f.f.conn.sql`insert into buildings(id,base_id,player_wallet,type,tx,ty) values(${starterBerth},${f.config.baseId},${f.config.wallet},'berth',17,5)`;
  await f.f.conn.sql`insert into builder_jobs(base_id,player_wallet,building_id,kind,started_at,finishes_at,completed_at) values(${f.config.baseId},${f.config.wallet},${starterBerth},'build',${started},${completed},${completed})`;
  const starter=await installStarterFleet(db,f.config.wallet,starterBerth,authority);
  for(const input of ordinaryEquipmentRecipe().inputs){const job=await startOrdinaryCrafting(db,f.config.wallet,{id:randomUUID(),baseId:f.config.baseId,recipeId:`refine_${input.itemId}`,recipeVersion:1,quantity:Number(input.quantity)},authority);f.advanceTo(job.job.readyAt);await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.config.baseId,job.job.readyAt));}
  const state=(next:{paused:boolean;providerless?:boolean})=>{f.state(next);vi.stubEnv('ORDINARY_CRAFTING_ENABLED',next.paused?'false':'true');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED',next.paused?'false':'true');};
  async function finishCraft(id:string){const proof=await ordinaryEquipmentEnvelope(db,f.config.wallet,id);if(proof.status!=='accepted')throw Error('No accepted equipment job');f.advanceTo(new Date(proof.receipt.readyAt));return {advancedTo:proof.receipt.readyAt};}
  return {...f,state,finishCraft,config:{...f.config,starterInstallationId:starter.installationId,recipe:ordinaryEquipmentRecipe(),policy:{...f.config.policy,equipment:PHASE_E_ORDINARY_EQUIPMENT,tax:{basisPoints:PHASE_E_POLICY.basisPoints,islandPoolBps:PHASE_E_POLICY.taxes.resources.islandPoolBps}}},
   providers:()=>({...f.providers(),ordinaryEquipment:createOrdinaryEquipmentProvider(db),starterExpeditionProvider:f.termProvider(),starterExpeditionWorkflow:createStarterExpeditionWorkflow(db,{provider:f.termProvider()})})};
 }catch(error){await f.dispose();throw error;}
}
export type OrdinaryEquipmentPairFixture=Awaited<ReturnType<typeof ordinaryEquipmentPairFixture>>;
