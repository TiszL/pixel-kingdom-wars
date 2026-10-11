/** Independent D149 gross replay; production arithmetic is not its own oracle. */
import { describe,it,expect } from 'vitest';
import { PHASE_E_POLICY as P,TOKEN,KEEP_MINING_FLOOR } from '@shardkeep/shared';
import { settleWalletMining,type MiningWallet } from '../../../scripts/src/phase-e-wallet-mining-model';
import { calculateFundedMining,type FundedBase } from '../src/mining/fundedMiningAudit';
import type { MiningAllocationPublication } from '../src/mining/allocationAudit';
import { Keypair } from '@solana/web3.js';
const wallet=()=>Keypair.generate().publicKey.toBase58();
function actor(id:string,paid:boolean,units:number):{model:MiningWallet;input:FundedBase}{
 const baseId=paid?'00000000-0000-4000-8000-000000000002':'00000000-0000-4000-8000-000000000001';
 return {model:{id,controller:id,seeker:false,ownsAnyDeed:paid,developmentEligible:true,freshActivity:true,activityBps:10000,experienceBps:10000,usefulChainBps:0,hoursSinceScoreRefresh:12,
  bases:[{id:baseId,hasDeed:paid,genesis:false,ownedEntireDay:true,forgeReady:true,progressBps:10000,committedIngots:units}]},
  input:{wallet:id,baseId,pool:paid?'deed':'free',reservedUnits:units,eligibleUnits:units,progressionBps:10000,walletScoreBps:7500,usefulChainBps:0,retentionBps:10000,baseScoreBps:7500,capacityUnits:paid?24:2,bonusBps:0,weight:String(BigInt(units)*7500n)}};
}
describe('funded two-pool arithmetic',()=>{
 it('matches fourteen independent D149 gross days while conserving every D150 atom and cumulative right',()=>{
  const free=wallet(),paid=wallet();let previous:MiningAllocationPublication|null=null,cursor=0,totalNet=0n,totalRenown=0n;
  const ceiling=BigInt(P.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals);
  for(let day=0;day<14;day++){
   const actors=[actor(free,false,day%2+1),actor(paid,true,day%4+1)],funding=ceiling/BigInt(day+1)+BigInt(day);
   const independent=settleWalletMining(actors.map(a=>a.model),funding,false,{free:KEEP_MINING_FLOOR.minUnitsPerPool,deed:KEEP_MINING_FLOOR.minUnitsPerPool});
   const result=calculateFundedMining(actors.map(a=>a.input),funding,cursor,previous);
   expect(result.freeGross).toBe(independent.pools.free.awarded);expect(result.deedGross).toBe(independent.pools.deed.awarded);
   expect(result.playerNet+result.recycle+result.tax).toBe(result.freeGross+result.deedGross);
   expect(result.freeGross).toBeLessThanOrEqual(result.freeBudget);expect(result.deedGross).toBeLessThanOrEqual(result.deedBudget);
   expect(result.consumed.reduce((n,r)=>n+r.units,0)).toBe(actors.reduce((n,a)=>n+a.input.eligibleUnits,0));
   totalNet+=result.playerNet;totalRenown+=2n;previous=result.declaration;cursor=result.splitEnd;
   expect(previous?.total).toBe(totalNet);expect(previous?.leaves.reduce((n,l)=>n+l.cumulativeRenown,0n)).toBe(totalRenown);
   expect(previous?.leaves.every(l=>l.cumulativeDays===BigInt(day+1))).toBe(true);
  }
 });
 it('returns every input when underfunding rounds all usable wallet awards to zero',()=>{
  const a=actor(wallet(),true,1),r=calculateFundedMining([a.input],1n,0,null);
  expect(r.declaration).toBeNull();expect(r.consumed[0]?.units).toBe(0);expect(r.playerNet+r.recycle+r.tax).toBe(0n);expect(r.splitEnd).toBe(0);
 });
 it('awards once per wallet across multiple bases and never drops an inactive prior right',()=>{
  const id=wallet(),a=actor(id,true,1),b={...a.input,baseId:'00000000-0000-4000-8000-000000000003'};
  const first=calculateFundedMining([a.input,b],1000000000n,0,null);
  expect(first.declaration?.leaves[0]).toMatchObject({cumulativeRenown:1n,cumulativeDays:1n});
  const next=calculateFundedMining([actor(wallet(),false,1).input],1000000000n,first.splitEnd,first.declaration);
  expect(next.declaration?.leaves.find(l=>l.wallet===id)).toMatchObject({cumulativeKeep:first.playerNet,cumulativeRenown:1n,cumulativeDays:1n});
 });
});
