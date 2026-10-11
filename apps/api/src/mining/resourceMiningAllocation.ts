/** Resource value is an integer weight domain, never synthetic Forge Ingots. */
import { KEEP_MINING_FLOOR, PHASE_E_POLICY as P, PHASE_E_MINING_CONTRIBUTION_V2 as V2 } from '@shardkeep/shared';
import type { MiningContributionReceipt, MiningContributionRequest } from '@shardkeep/shared/miningContributionApi';
import type { MiningAllocationPublication } from './allocationAudit';
import { deriveMiningWalletQualification, type MiningQualificationCapture } from './fundedMiningQualification';
import { calculateMiningWeightedAllocation } from './fundedMiningKernel';

export type ResourceMiningOriginal = { id:string;baseId:string;actorWallet:string;pool:'free'|'deed';
 request:MiningContributionRequest;lines:MiningContributionReceipt['lines'];totalValue:string;createdAt:string };
export type ResourceMiningCapture = Omit<MiningQualificationCapture,'bases'> & {
 bases:(MiningQualificationCapture['bases'][number]&{reservedValue:string})[];
};
const need=(v:unknown):void=>{if(!v)throw Error('MINING_RESOURCE_SOURCE_CONFLICT');};
export function resourceMiningValue(value:unknown):bigint {
 need(typeof value==='string'&&/^(0|[1-9][0-9]{0,31})$/.test(value));return BigInt(value as string);
}
export function deriveResourceMiningWallet(capture:ResourceMiningCapture,genesisHash:string,allowSeekerQualification=false,seekerQualificationVersion:1|2=1,allowExistingWallet=false,allowSeekerAbsence=false,allowPostZero=false){
 let freeEligible=0n;
 return deriveMiningWalletQualification(capture,genesisHash,V2.version,allowSeekerQualification,seekerQualificationVersion,allowExistingWallet,allowSeekerAbsence,allowPostZero).map(q=>{
  const reservedValue=capture.bases.find(b=>b.baseId===q.baseId)!.reservedValue,value=resourceMiningValue(reservedValue);
  need(value>0n);
  const eligible=q.eligible?value:0n;
  if(q.pool==='free'){freeEligible+=eligible;need(freeEligible<=BigInt(V2.freeValuePerWalletDay));}
  return {...q,reservedValue,eligibleValue:String(eligible),capacityValue:q.pool==='free'?String(V2.freeValuePerWalletDay):null,
   weight:String(eligible*BigInt(q.baseScoreBps)*BigInt(P.basisPoints+q.bonusBps)/BigInt(P.basisPoints))};
 });
}
export type ResourceMiningBase=ReturnType<typeof deriveResourceMiningWallet>[number];
export function calculateResourceMining(participants:readonly ResourceMiningBase[],budgetGross:bigint,splitStart:number,previous:MiningAllocationPublication|null,allowSeekerQualification=false){
 need(new Set(participants.map(p=>`${p.wallet}:${p.baseId}`)).size===participants.length);
 const freeByWallet=new Map<string,bigint>();
 const weighted=participants.map(p=>{
  const reserved=resourceMiningValue(p.reservedValue),eligible=resourceMiningValue(p.eligibleValue),weight=resourceMiningValue(p.weight);
  need(p.bonusBps===0||allowSeekerQualification&&p.bonusBps===P.mining.seekerBonusBps);
  need(Number.isSafeInteger(p.baseScoreBps)&&p.baseScoreBps>=0&&reserved>0n&&eligible===(p.eligible?reserved:0n)
   &&weight===eligible*BigInt(p.baseScoreBps)*BigInt(P.basisPoints+p.bonusBps)/BigInt(P.basisPoints));
  if(p.pool==='free'){const total=(freeByWallet.get(p.wallet)??0n)+eligible;need(total<=BigInt(V2.freeValuePerWalletDay));freeByWallet.set(p.wallet,total);}
  return {...p,weight};
 });
 // One ingot's resource value preserves exactly the old pool-floor economics.
 const floor=BigInt(KEEP_MINING_FLOOR.minUnitsPerPool)*BigInt(P.basisPoints)*BigInt(V2.valuePerIngot);
 const {baseAwards,awards:walletAwards,...totals}=calculateMiningWeightedAllocation(weighted,floor,budgetGross,splitStart,previous);
 const awards=walletAwards.map(a=>({wallet:a.wallet,eligibleValue:a.net>0n?String(baseAwards.filter(b=>b.wallet===a.wallet&&b.gross>0n).reduce((n,b)=>n+BigInt(b.eligibleValue),0n)):'0',
  gross:a.gross,net:a.net,recycle:a.recycle,tax:a.tax,renown:a.renown,days:a.days,splitStart:a.splitStart,splitEnd:a.splitEnd}));
 const consumed=baseAwards.map(b=>({baseId:b.baseId,actorWallet:b.wallet,value:b.gross>0n&&awards.find(a=>a.wallet===b.wallet)!.net>0n?b.eligibleValue:'0'}));
 const {declaration,...rest}=totals;
 return {...rest,awards,consumed,declaration};
}
/** No rounding or partial basket disposition: a useful base award consumes all
 * of that actor's accepted baskets; every other basket returns its exact inputs. */
export function planResourceMiningContributions(originals:readonly ResourceMiningOriginal[],consumed:readonly {baseId:string;actorWallet:string;value:string}[]){
 need(new Set(originals.map(r=>r.id)).size===originals.length);
 need(new Set(consumed.map(r=>`${r.actorWallet}:${r.baseId}`)).size===consumed.length);
 const totals=new Map<string,bigint>();
 for(const r of originals){const key=`${r.actorWallet}:${r.baseId}`,value=resourceMiningValue(r.totalValue);need(value>0n);totals.set(key,(totals.get(key)??0n)+value);}
 need(consumed.length===totals.size);
 for(const row of consumed){const reserved=totals.get(`${row.actorWallet}:${row.baseId}`),value=resourceMiningValue(row.value);need(reserved!==undefined&&(value===0n||value===reserved));}
 return originals.map(r=>{const value=consumed.find(row=>row.baseId===r.baseId&&row.actorWallet===r.actorWallet)!.value;
  return {id:r.id,baseId:r.baseId,actorWallet:r.actorWallet,lines:r.lines,totalValue:r.totalValue,outcome:value==='0'?'returned' as const:'consumed' as const};});
}
export type ResourceMiningDisposition=ReturnType<typeof planResourceMiningContributions>[number];
