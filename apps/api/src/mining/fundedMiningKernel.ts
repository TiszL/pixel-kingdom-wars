/** Quantity-independent integer pool/split/cumulative kernel. Domain wrappers
 * validate their own units and retain their original manifest fields. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY as P, PHASE_E_MINING_PUBLICATION as SPLIT, PHASE_E_MINING_PARTICIPATION as R, TOKEN } from '@shardkeep/shared';
import { buildMiningAllocationTree } from '@shardkeep/chain/mining-allocation';
import { auditMiningAllocation, type MiningAllocationPublication } from './allocationAudit';

export type MiningWeightedBase = { wallet:string;baseId:string;pool:'free'|'deed';weight:bigint };
const need=(v:unknown):void=>{if(!v)throw Error('MINING_FUNDED_SOURCE_CONFLICT');};
export function calculateMiningWeightedAllocation<T extends MiningWeightedBase>(participants:readonly T[],floor:bigint,
 budgetGross:bigint,splitStart:number,previous:MiningAllocationPublication|null){
 need(budgetGross>=0n&&budgetGross<=BigInt(P.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals));
 need(Number.isInteger(splitStart)&&splitStart>=0&&splitStart<SPLIT.splitPeriod&&floor>0n);
 const freeBudget=budgetGross*BigInt(P.mining.freePoolBps)/BigInt(P.basisPoints),deedBudget=budgetGross-freeBudget;
 const sumWeight={free:0n,deed:0n};
 for(const p of participants){need(['free','deed'].includes(p.pool)&&typeof p.weight==='bigint'&&p.weight>=0n);sumWeight[p.pool]+=p.weight;}
 const denominator={free:sumWeight.free>floor?sumWeight.free:floor,deed:sumWeight.deed>floor?sumWeight.deed:floor};
 const baseAwards=participants.map(p=>({...p,gross:(p.pool==='free'?freeBudget:deedBudget)*p.weight/denominator[p.pool]}));
 const wallets=[...new Set(participants.map(p=>p.wallet))].sort((a,b)=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer()));
 need(wallets.length<=32);let cursor=splitStart,playerNet=0n,recycle=0n,tax=0n,freeGross=0n,deedGross=0n;
 const awards=wallets.map(wallet=>{
  const bases=baseAwards.filter(p=>p.wallet===wallet),gross=bases.reduce((n,b)=>n+b.gross,0n),begin=cursor,cycles=gross/BigInt(SPLIT.splitPeriod);
  let net=cycles*BigInt(SPLIT.splitPlayerUnits),r=cycles*BigInt(SPLIT.splitRecycleUnits),t=cycles*BigInt(SPLIT.splitTaxUnits);
  for(let i=0;i<Number(gross%BigInt(SPLIT.splitPeriod));i++){if(cursor<SPLIT.splitPlayerUnits)net++;else if(cursor<SPLIT.splitPlayerUnits+SPLIT.splitRecycleUnits)r++;else t++;cursor=(cursor+1)%SPLIT.splitPeriod;}
  if(net===0n){cursor=begin;return {wallet,gross:0n,net:0n,recycle:0n,tax:0n,renown:0n,days:0n,splitStart:begin,splitEnd:begin};}
  for(const b of bases){if(b.pool==='free')freeGross+=b.gross;else deedGross+=b.gross;}
  playerNet+=net;recycle+=r;tax+=t;
  return {wallet,gross,net,recycle:r,tax:t,renown:BigInt(R.renownPerQualifiedDay),days:BigInt(R.daysPerQualifiedDay),splitStart:begin,splitEnd:cursor};
 });
 need(freeGross<=freeBudget&&deedGross<=deedBudget&&freeGross+deedGross===playerNet+recycle+tax);
 const leaves=new Map((previous?.leaves??[]).map(l=>[l.wallet,{...l,sequence:(previous?.sequence??0n)+1n}]));
 for(const a of awards)if(a.net>0n){const p=leaves.get(a.wallet);leaves.set(a.wallet,{wallet:a.wallet,sequence:(previous?.sequence??0n)+1n,cumulativeKeep:(p?.cumulativeKeep??0n)+a.net,cumulativeRenown:(p?.cumulativeRenown??0n)+a.renown,cumulativeDays:(p?.cumulativeDays??0n)+a.days});}
 let declaration:MiningAllocationPublication|null=null;
 if(playerNet>0n){need(leaves.size<=10000);const tree=buildMiningAllocationTree([...leaves.values()]);declaration={sequence:(previous?.sequence??0n)+1n,root:Buffer.from(tree.root).toString('hex'),total:tree.total,leafCount:tree.leafCount,leaves:tree.leaves};auditMiningAllocation({previousPublication:previous,nextPublication:declaration});}
 return {freeBudget,deedBudget,sumWeight,denominator,freeGross,deedGross,playerNet,recycle,tax,splitStart,splitEnd:cursor,awards,baseAwards,declaration};
}
