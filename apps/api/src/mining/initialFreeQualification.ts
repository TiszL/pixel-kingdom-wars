/** Closed-day source qualification only; no contribution consumption or funded right. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_MINING_SCORE_POLICY as POLICY } from '@shardkeep/shared';
import { readDeedMiningWalletEvidence,type DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { z } from 'zod';
import type { Db } from '../db/client';
import { evaluateInitialFreeMiningScore } from './initialFreeScore';
import { readMiningRosterHistory } from './rosterHistory';

const key=z.string().min(32).max(44).refine(value=>{
 if(value.length<32||value.length>44)return false;
 try{return new PublicKey(value).toBase58()===value;}catch{return false;}
});
const inputSchema=z.object({wallet:key,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(POLICY.version)}).strict();
export interface InitialFreeQualificationSource {
 /** Application-authenticated archival provider and collection configuration,
  * never request-body fields. Matching genesis alone cannot authenticate a URL. */
 source:DeedMiningWalletReader|((signal:AbortSignal)=>DeedMiningWalletReader);
 collection:string;expectedGenesisHash:string;
}
type Code='INVALID_INPUT'|'SOURCE_CONFIGURATION_INVALID'|'SOURCE_CONFLICT';
export class InitialFreeQualificationError extends Error {
 constructor(readonly code:Code){super(`Initial-free qualification refused: ${code}`);this.name='InitialFreeQualificationError';}
}
function fail(code:Code):never{throw new InitialFreeQualificationError(code);}

export async function qualifyInitialFreeMiningDay(db:Db,source:InitialFreeQualificationSource,value:unknown){
 const parsed=inputSchema.safeParse(value);if(!parsed.success)return fail('INVALID_INPUT');
 const {wallet,day,policyVersion}=parsed.data,startAt=new Date(`${day}T00:00:00.000Z`);
 if(!Number.isFinite(+startAt)||startAt.toISOString().slice(0,10)!==day)return fail('INVALID_INPUT');
 const endAt=new Date(+startAt+86_400_000);
 if(!source||!key.safeParse(source.collection).success||!key.safeParse(source.expectedGenesisHash).success)return fail('SOURCE_CONFIGURATION_INVALID');
 const reader=source.source,collection=source.collection,expectedGenesisHash=source.expectedGenesisHash;
 // Each database reader closes its own bounded source transaction before RPC.
 // Their histories use first-mutation database clocks and closed UTC cutoffs;
 // no DB locks are held across provider calls and no journal is created here.
 const score=await evaluateInitialFreeMiningScore(db,{wallet,day,policyVersion});
 const roster=await readMiningRosterHistory(db,{wallet,day,policyVersion});
 const deeds=await readDeedMiningWalletEvidence(reader,{collection,expectedGenesisHash,targetWallet:wallet,startAt,endAt});
 if(score.wallet!==wallet||score.day!==day||roster.wallet!==wallet||roster.day!==day
  ||deeds.targetWallet!==wallet||deeds.collection!==collection||deeds.genesisHash!==expectedGenesisHash
  ||+deeds.startAt!==+startAt||+deeds.endAt!==+endAt||deeds.throughBlockTime*1000<+endAt
  ||deeds.deedlessThroughout!==(deeds.heldDuringIntervalAssetIds.length===0))return fail('SOURCE_CONFLICT');
 const unchangedInitial=(snapshot:typeof roster.open)=>{
  const [base]=snapshot.bases,[slot]=snapshot.slots;
  return snapshot.facts.sourceIdentityConsistent&&snapshot.bases.length===1&&snapshot.slots.length===1
   &&base?.id===score.baseId&&base.owner_wallet===wallet&&base.status==='active'
   &&base.land_paid_at===null&&base.deed_asset_id===null&&base.deed_mint_asset_id===null&&base.deed_minting_at===null
   &&slot?.wallet===wallet&&slot.base_id===score.baseId&&slot.active;
 };
 const registeredValid=unchangedInitial(roster.open)&&unchangedInitial(roster.close)&&roster.changes.length===0&&roster.continuityBrokenBaseIds.length===0;
 const reason=!registeredValid?'registered_roster_invalid':!deeds.deedlessThroughout?'external_deed_owned':score.reason;
 const qualified=reason==='qualified';
 return {...score,scoreReason:score.reason,reason,eligibleUnits:qualified?score.eligibleUnits:0,weight:qualified?score.weight:'0',
  sourceQualification:'complete' as const,sources:{registeredRoster:roster,deeds},
  allocationReady:false as const,publicationAuthorized:false as const};
}
