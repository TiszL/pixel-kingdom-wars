/** D184 admission facts from an actual settled allocation and finalized bank.
 * Claimability is not qualification: a fully claimed leaf can qualify, while
 * paused/correction/stale Renown must never inherit the claim reader's status. */
import {createHash} from 'node:crypto';
import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {createMiningClaimReader} from '../mining/claimStatus';
export interface DivineTrialQualification {
 readonly wallet:string;readonly domain:{genesisHash:string;economyProgram:string};
 readonly observedAtMs:number;readonly chainUnixTimestamp:string;
 readonly qualification:{sequence:string;day:number;renown:string;daysAttested:string;sourceSha256:string};
 readonly sourceJson:string;
}
const hold=():never=>{throw new HttpError(503,'Current earned Renown evidence is unavailable','DIVINE_TRIAL_QUALIFICATION');};
export function assertDivineTrialQualificationAge(proof:DivineTrialQualification,now:Date){
 const ms=now.getTime(),age=ms-proof.observedAtMs,chain=BigInt(proof.chainUnixTimestamp)*1000n;
 if(!Number.isSafeInteger(ms)||age<0||age>P.observationMaxAgeMs||chain>BigInt(ms)||BigInt(ms)-chain>BigInt(P.observationMaxAgeMs))hold();
}
export function createDivineTrialQualificationReader(db:Db,sources:Parameters<typeof createMiningClaimReader>[1],clock:()=>Date=()=>new Date()){
 const reader=createMiningClaimReader(db,sources),flights=new Map<string,Promise<DivineTrialQualification>>();
 const domain=Object.freeze({genesisHash:sources.trust.expectedGenesisHash,economyProgram:sources.trust.programId.toBase58()});
 async function observe(wallet:string):Promise<DivineTrialQualification>{
  // Capture before RPC. All coalesced callers below retain this first timestamp.
  const observedAtMs=clock().getTime(),a=await reader.assess(wallet),p=a.projection,s=a.snapshot;
  if(!Number.isSafeInteger(observedAtMs)||!p||p.kind!=='entitlement'||!s)return hold();
  const r=s.renownRecord,c=s.backing.config,l=p.leaf;
  if(c.flags!==0||c.correctionPending||s.root.revoked||!r||r.wallet!==wallet||l.wallet!==wallet
   ||c.latestSequence!==BigInt(p.header.sequence)||r.lastSequence!==BigInt(l.sequence)
   ||r.renownTotal!==BigInt(l.cumulativeRenown)||r.daysAttested!==BigInt(l.cumulativeDays)
   ||r.renownTotal<BigInt(P.minRenown)||r.daysAttested<BigInt(P.minDaysAttested))return hold();
  const day=Number(p.header.day);if(!Number.isSafeInteger(day)||day<0)return hold();
  const sourceJson=JSON.stringify({version:P.version,wallet,domain,observedAtMs,projection:p,snapshot:s},(_key,value)=>typeof value==='bigint'?value.toString():value);
  if(Buffer.byteLength(sourceJson)>P.maxPayloadBytes)return hold();
  const sourceSha256=createHash('sha256').update(sourceJson).digest('hex');
  const proof=Object.freeze({wallet,domain,observedAtMs,chainUnixTimestamp:s.chainClock.unixTimestamp.toString(),sourceJson,
   qualification:Object.freeze({sequence:p.header.sequence,day,renown:r.renownTotal.toString(),daysAttested:r.daysAttested.toString(),sourceSha256})});
  assertDivineTrialQualificationAge(proof,clock());return proof;
 }
 return (wallet:string):Promise<DivineTrialQualification>=>{
  const old=flights.get(wallet);if(old)return old;
  const flight=observe(wallet).finally(()=>{if(flights.get(wallet)===flight)flights.delete(wallet);});flights.set(wallet,flight);return flight;
 };
}
