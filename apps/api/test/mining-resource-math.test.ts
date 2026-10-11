/** D153.199 preserves integer resource value and each basket's original custody. */
import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { KEEP_MINING_FLOOR,PHASE_E_POLICY as P,PHASE_E_MINING_CONTRIBUTION_V2 as V2,TOKEN } from '@shardkeep/shared';
import { MINING_CONTRIBUTION_RESOURCE_IDS,valueMiningContribution } from '@shardkeep/shared/miningContribution';
import { calculateFundedMining,type FundedBase } from '../src/mining/fundedMiningAudit';
import { calculateResourceMining,planResourceMiningContributions,type ResourceMiningBase,type ResourceMiningOriginal } from '../src/mining/resourceMiningAllocation';
import { validateResourceMiningOriginals } from '../src/mining/resourceMiningAudit';
import type { MiningAllocationPublication } from '../src/mining/allocationAudit';

const wallet=()=>Keypair.generate().publicKey.toBase58(),day='2020-01-01',createdAt=day+'T00:00:00.000Z';
const ceiling=BigInt(P.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals);
function participant(id:string,pool:'free'|'deed',value:bigint,score=7500):ResourceMiningBase {
 return {wallet:id,baseId:randomUUID(),pool,eligible:true,reservedValue:String(value),eligibleValue:String(value),
  progressionBps:P.basisPoints,walletScoreBps:score,usefulChainBps:0,retentionBps:P.basisPoints,baseScoreBps:score,bonusBps:0,
  capacityValue:pool==='free'?String(V2.freeValuePerWalletDay):null,weight:String(value*BigInt(score))};
}
function original(actorWallet=wallet(),pool:'free'|'deed'='deed',lines=[{resourceId:'forge_ingot' as const,quantity:'1'}]):ResourceMiningOriginal {
 const id=randomUUID(),baseId=randomUUID(),valued=valueMiningContribution(lines,V2.version);
 return {id,baseId,actorWallet,pool,request:{idempotencyKey:id,baseId,policyVersion:2,expectedDay:day,lines},
  lines:[...valued.lines],totalValue:valued.totalValue,createdAt};
}
describe('resource-funded two-pool allocation',()=>{
 it('applies the admitted Seeker weight once per base without multiplying it by wallet base count',()=>{
  const id=wallet(),score=7333,value=901n;
  const boosted=Array.from({length:P.bases.activePerWalletMax},()=>{
   const p=participant(id,'deed',value,score);
   return {...p,bonusBps:P.mining.seekerBonusBps,weight:String(value*BigInt(score)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints))};
  });
  const result=calculateResourceMining(boosted,ceiling,0,null,true);
  expect(result.sumWeight.deed).toBe(BigInt(boosted[0]!.weight)*BigInt(boosted.length));
  expect(result.awards).toHaveLength(1);expect(result.awards[0]!.days).toBe(1n);
  expect(result.playerNet+result.recycle+result.tax).toBe(result.freeGross+result.deedGross);
  expect(()=>calculateResourceMining(boosted,ceiling,0,null)).toThrow();
  const forged=boosted.map(p=>({...p,bonusBps:P.mining.seekerBonusBps*boosted.length}));
  expect(()=>calculateResourceMining(forged,ceiling,0,null,true)).toThrow();
 });
 it('keeps the free input cap and zero eligibility while a Seeker bonus changes only allocation weight',()=>{
  const p=participant(wallet(),'free',BigInt(V2.freeValuePerWalletDay));
  const boosted={...p,bonusBps:P.mining.seekerBonusBps,weight:String(BigInt(p.weight)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints))};
  const paid=calculateResourceMining([boosted],ceiling,0,null,true);
  expect(paid.consumed[0]!.value).toBe(String(V2.freeValuePerWalletDay));
  const extra={...boosted,baseId:randomUUID(),reservedValue:'1',eligibleValue:'1',weight:String(BigInt(p.baseScoreBps)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints))};
  expect(()=>calculateResourceMining([boosted,extra],ceiling,0,null,true)).toThrow();
  const zero=calculateResourceMining([{...boosted,eligible:false,eligibleValue:'0',weight:'0'}],ceiling,0,null,true);
  expect(zero.declaration).toBeNull();expect(zero.consumed[0]!.value).toBe('0');
 });
 it('preserves ingot-equivalent economics, split atoms and cumulative rights across fourteen days',()=>{
  const ids=[wallet(),wallet()];let previous:MiningAllocationPublication|null=null,cursor=0;
  for(let n=0;n<14;n++){
   const resource=ids.map((id,i)=>participant(id,i===0?'free':'deed',BigInt(i===0?n%2+1:n+3)*BigInt(V2.valuePerIngot)));
   const ingots:FundedBase[]=resource.map(p=>({wallet:p.wallet,baseId:p.baseId,pool:p.pool,reservedUnits:Number(BigInt(p.reservedValue)/BigInt(V2.valuePerIngot)),
    eligibleUnits:Number(BigInt(p.eligibleValue)/BigInt(V2.valuePerIngot)),progressionBps:p.progressionBps,walletScoreBps:p.walletScoreBps,
    usefulChainBps:p.usefulChainBps,retentionBps:p.retentionBps,baseScoreBps:p.baseScoreBps,capacityUnits:p.pool==='free'?P.mining.freeCapacityUnitsPerWalletDay:null,
    bonusBps:0,weight:String(BigInt(p.weight)/BigInt(V2.valuePerIngot))}));
   const funds=ceiling/BigInt(n+1)+BigInt(n),a=calculateResourceMining(resource,funds,cursor,previous),b=calculateFundedMining(ingots,funds,cursor,previous);
   for(const key of ['freeBudget','deedBudget','freeGross','deedGross','playerNet','recycle','tax','splitStart','splitEnd','declaration'] as const)expect(a[key]).toEqual(b[key]);
   expect(a.awards.map(({eligibleValue,...r})=>({...r,eligibleUnits:Number(BigInt(eligibleValue)/BigInt(V2.valuePerIngot))}))).toEqual(b.awards);
   expect(a.consumed.map(r=>({...r,value:undefined,units:Number(BigInt(r.value)/BigInt(V2.valuePerIngot))})))
    .toEqual(b.consumed.map(r=>({...r,value:undefined})));
   previous=a.declaration;cursor=a.splitEnd;
  }
 });
 it('uses a single value point without rounding to an ingot and preserves integers above Number precision',()=>{
  const tiny=participant(wallet(),'free',1n),result=calculateResourceMining([tiny],ceiling,0,null);
  const floor=BigInt(KEEP_MINING_FLOOR.minUnitsPerPool)*BigInt(P.basisPoints)*BigInt(V2.valuePerIngot);
  expect(result.freeGross).toBe(result.freeBudget*BigInt(tiny.baseScoreBps)/floor);
  expect(result.playerNet).toBeGreaterThan(0n);expect(result.consumed[0]!.value).toBe('1');
  const large=participant(wallet(),'deed',9007199254740993n),other=participant(wallet(),'deed',9007199254740992n);
  const huge=calculateResourceMining([large,other],ceiling,0,null);
  expect(huge.sumWeight.deed).toBe((9007199254740993n+9007199254740992n)*BigInt(large.baseScoreBps));
  expect(huge.consumed.map(r=>r.value)).toEqual([large.reservedValue,other.reservedValue]);
  expect(huge.playerNet+huge.recycle+huge.tax).toBe(huge.freeGross+huge.deedGross);
 });
 it('rejects free over-cap value across a wallet, partial eligibility and forged weight instead of clipping',()=>{
  const id=wallet(),a=participant(id,'free',BigInt(V2.freeValuePerWalletDay)),b=participant(id,'free',1n);
  expect(()=>calculateResourceMining([a,b],ceiling,0,null)).toThrow();
  expect(()=>calculateResourceMining([{...a,eligibleValue:'1',weight:String(a.baseScoreBps)}],ceiling,0,null)).toThrow();
  expect(()=>calculateResourceMining([{...a,weight:String(BigInt(a.weight)+1n)}],ceiling,0,null)).toThrow();
  expect(()=>calculateResourceMining([a,a],ceiling,0,null)).toThrow();
 });
 it('returns underfunded inputs and carries every inactive historical right without another daily award',()=>{
  const a=participant(wallet(),'deed',BigInt(V2.valuePerIngot));
  const old:FundedBase={wallet:a.wallet,baseId:a.baseId,pool:'deed',reservedUnits:1,eligibleUnits:1,progressionBps:a.progressionBps,
   walletScoreBps:a.walletScoreBps,usefulChainBps:0,retentionBps:a.retentionBps,baseScoreBps:a.baseScoreBps,capacityUnits:null,bonusBps:0,weight:String(a.baseScoreBps)};
  const first=calculateFundedMining([old],ceiling,0,null),empty=calculateResourceMining([a],1n,first.splitEnd,first.declaration);
  expect(empty.declaration).toBeNull();expect(empty.consumed[0]!.value).toBe('0');expect(empty.splitEnd).toBe(first.splitEnd);
  const next=calculateResourceMining([participant(wallet(),'free',1n)],ceiling,first.splitEnd,first.declaration);
  expect(next.declaration!.leaves.find(l=>l.wallet===a.wallet)).toEqual({...first.declaration!.leaves[0]!,sequence:2n});
  expect(()=>calculateFundedMining([{...old,weight:String(1n<<64n)}],ceiling,0,null)).toThrow();
 });
 it('consumes or returns whole original baskets independently for different actors on the same base',()=>{
  const a=original(),b=original(a.actorWallet),c=original();b.baseId=a.baseId;c.baseId=a.baseId;
  const rows=[a,b,c],consume=[{baseId:a.baseId,actorWallet:a.actorWallet,value:String(BigInt(a.totalValue)+BigInt(b.totalValue))},
   {baseId:c.baseId,actorWallet:c.actorWallet,value:'0'}];
  expect(planResourceMiningContributions(rows,consume).map(r=>r.outcome)).toEqual(['consumed','consumed','returned']);
  expect(()=>planResourceMiningContributions(rows,[{...consume[0]!,value:a.totalValue},consume[1]!])).toThrow();
  expect(()=>planResourceMiningContributions(rows,consume.slice(0,1))).toThrow();
  expect(()=>planResourceMiningContributions([a,a],consume.slice(0,1))).toThrow();
 });
 it('authenticates all twenty original resource values, source ordering and millisecond/microsecond chronology',()=>{
  const lines=MINING_CONTRIBUTION_RESOURCE_IDS.map(resourceId=>({resourceId,quantity:'1'})),r=original();
  r.request.lines=lines;const valued=valueMiningContribution(lines,V2.version);r.lines=[...valued.lines];r.totalValue=valued.totalValue;
  const epoch=randomUUID(),validate=(row:ResourceMiningOriginal,at=createdAt)=>validateResourceMiningOriginals(epoch,day,at,[row]);
  expect(validate(r)).toMatch(/^[a-f0-9]{64}$/);expect(validate(r,day+'T00:00:00.000000Z')).toBe(validate(r));
  expect(()=>validate(r,day+'T00:00:00.000001Z')).toThrow();
  expect(()=>validate(r,day+'T00:00:00Z')).toThrow();
  for(const key of ['unitValue','value'] as const){const changed=structuredClone(r);changed.lines[0]![key]=String(BigInt(changed.lines[0]![key])+1n);expect(()=>validate(changed)).toThrow();}
  expect(()=>validate({...r,totalValue:String(BigInt(r.totalValue)+1n)})).toThrow();
  expect(()=>validate({...r,createdAt:'2020-01-02T00:00:00.000Z'})).toThrow();
  const reordered=structuredClone(r);reordered.lines.reverse();expect(()=>validate(reordered)).toThrow();
  const duplicate=structuredClone(r);duplicate.request.lines.push(duplicate.request.lines[0]!);expect(()=>validate(duplicate)).toThrow();
 });
 it('binds the original admission pool and refuses aggregate free allowance overflow',()=>{
  const a=original(wallet(),'free',[{resourceId:'forge_ingot',quantity:String(P.mining.freeCapacityUnitsPerWalletDay)}]),b=original(a.actorWallet,'free');
  b.baseId=a.baseId;b.request.baseId=a.baseId;
  const rows=[a,b].sort((x,y)=>x.baseId.localeCompare(y.baseId)||x.id.localeCompare(y.id));
  expect(()=>validateResourceMiningOriginals(randomUUID(),day,createdAt,rows)).toThrow();
  const deed=rows.map(r=>({...r,pool:'deed' as const}));expect(validateResourceMiningOriginals(randomUUID(),day,createdAt,deed)).toMatch(/^[a-f0-9]{64}$/);
  expect(()=>validateResourceMiningOriginals(randomUUID(),day,createdAt,[...deed].reverse())).toThrow();
 });
});
