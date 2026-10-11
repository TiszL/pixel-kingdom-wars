/** D176 source acceptance through existing real charge/resolve/compensation
 * services. No simulated terminal SQL or caller-provided ante classification. */
import {randomUUID} from 'node:crypto';
import {BuildingType,CLANS} from '@shardkeep/shared';
import {vi} from 'vitest';
import {completeDueJobs,placeBuilding} from '../../src/game/base';
import {completeDueTraining} from '../../src/game/army';
import {compensatePendingRaid,createRaid,submitOrders} from '../../src/game/raids';
import {rewardShards} from '../../src/game/spend';
import {createClanCharterMemberSettlement} from '../../src/game/clanCharterMemberSettlement';
import {fundTestKeep} from '../helpers';
import {trainTroop} from '../training-consent';
import {charterSalesFixture} from './charterSales';
const key=()=>randomUUID(),future=(minutes:number)=>new Date(Date.now()+minutes*60_000);
/** Existing real army/raid writers on the caller's fixture DB. The caller owns
 * terminal settlement choice and explicitly labels any controlled-gross adapter. */
export async function setupCharterSaleRaidActor(c:Pick<Awaited<ReturnType<typeof charterSalesFixture>>,'db'|'sql'>,wallet:string){
 const previous=process.env['MULTI_BASE_ENABLED'];vi.stubEnv('MULTI_BASE_ENABLED','false');
 try{
  await fundTestKeep(c.db,wallet,1_000_000n,'test.charter-sale.army',key());
  await rewardShards(c.db,wallet,BigInt(CLANS.createCostShards)*20n,'test.charter-sale.ante',key());
  await placeBuilding(c.db,wallet,BuildingType.Barracks,17,17,key());await completeDueJobs(c.db,wallet,future(120));
  await placeBuilding(c.db,wallet,BuildingType.Camp,19,19,key());await completeDueJobs(c.db,wallet,future(240));
  await trainTroop(c.db,wallet,'highlander',key(),future(300));await completeDueTraining(c.db,wallet,future(310));
 }finally{if(previous===undefined)delete process.env['MULTI_BASE_ENABLED'];else vi.stubEnv('MULTI_BASE_ENABLED',previous);}
}
export async function charterSalesRaidFixture(){
 const c=await charterSalesFixture();
 try{
  await c.initialize();const birth=await c.birth();
  // Existing ordinary legacy services still own this lane; no raid source edits.
  vi.stubEnv('MULTI_BASE_ENABLED','false');
  await setupCharterSaleRaidActor(c,birth.actor.wallet);
  async function raid(){
   const defender=await c.actor();vi.stubEnv('MULTI_BASE_ENABLED','false');
   const before=await money();
   const value=await createRaid(c.db,birth.actor.wallet,{defenderWallet:defender.wallet,idempotencyKey:key()});return {value,defender,before};
  }
  async function resolve(r:Awaited<ReturnType<typeof raid>>){
   vi.stubEnv('MULTI_BASE_ENABLED','false');
   return submitOrders(c.db,birth.actor.wallet,r.value.id,{deploys:[{troop:'highlander',tx:6,ty:14,tMs:0}],idempotencyKey:key()});
  }
  async function compensate(r:Awaited<ReturnType<typeof raid>>,refund=true){
   vi.stubEnv('MULTI_BASE_ENABLED','false');
   return compensatePendingRaid(c.db,{id:r.value.id,attackerWallet:birth.actor.wallet,simVersion:r.value.simVersion},false,undefined,refund);
  }
  async function pay(){
   vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');
   const draft=await c.draft(birth),accepted=await c.store().accept(c.buyer.wallet,draft.state.original.id,{termsHash:draft.state.original.termsHash,buyerBaseId:c.buyer.baseId});
   const paid=await createClanCharterMemberSettlement(c.db,{deedCollection:birth.actor.collection,
    finalizedDeedReader:async asset=>asset===birth.actor.deed?birth.actor.proof():null}).settle(birth.actor.wallet,accepted.fenceId!);
   return {draft,accepted,paid};
  }
  const money=()=>c.sql`select id,balance::text from accounts order by id`;
  return {...c,birth,raid,resolve,compensate,pay,money};
 }catch(error){await c.dispose();throw error;}
}
export type CharterSalesRaidFixture=Awaited<ReturnType<typeof charterSalesRaidFixture>>;
