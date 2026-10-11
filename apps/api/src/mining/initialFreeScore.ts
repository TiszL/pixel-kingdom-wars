/** Database-derived first-free score. This read never allocates or consumes. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_MINING_SCORE_POLICY as POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { collectFreeWalletShadow } from './freeWalletShadow';
import { MiningWalletActivityError, readMiningWalletActivity } from './walletActivity';
import { readMiningDevelopmentEvidence } from './developmentEvidence';
import { readFreeGemsEvidence } from './freeGemsEvidence';

const DAY_MS=86_400_000;
const SCALE=PHASE_E_POLICY.basisPoints;
const schema=z.object({wallet:z.string().min(32).max(44).refine(value=>{if(value.length<32||value.length>44)return false;try{return new PublicKey(value).toBase58()===value;}catch{return false;}}),
 day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(POLICY.version)}).strict();
type Code='INVALID_INPUT'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT'|'XP_COVERAGE_UNAVAILABLE';
export class InitialFreeMiningScoreError extends Error{constructor(readonly code:Code){super(`Initial-free mining score refused: ${code}`);this.name='InitialFreeMiningScoreError';}}
function fail(code:Code):never{throw new InitialFreeMiningScoreError(code);}
const ratio=(value:number,numerator:number,denominator:number)=>Number(BigInt(value)*BigInt(numerator)/BigInt(denominator));

export async function evaluateInitialFreeMiningScore(db:Db,value:unknown){
 const parsed=schema.safeParse(value);if(!parsed.success)return fail('INVALID_INPUT');
 const {wallet,day,policyVersion}=parsed.data,start=Date.parse(`${day}T00:00:00.000Z`);
 if(!Number.isFinite(start)||new Date(start).toISOString().slice(0,10)!==day)return fail('INVALID_INPUT');
 // Require already collected authority. Evaluation cannot manufacture journals
 // or silently turn an unprocessed day into a day without earnings.
 const [present]=await db.execute(sql`select 1 from mining_free_wallet_shadows s join mining_wallet_experience_days x on x.day=s.day
  where s.wallet=${wallet} and s.day=${day}::date and s.policy_version='free-shadow-v1' and x.policy_version=${POLICY.version}`);
 if(!present)return fail('SOURCE_UNAVAILABLE');
 const inputs=await collectFreeWalletShadow(db,{wallet,day,policyVersion:'free-shadow-v1'});
 const development=await readMiningDevelopmentEvidence(db,{baseId:inputs.baseId,day,policyVersion:POLICY.version});
 const gems=await readFreeGemsEvidence(db,{wallet,day});
 // Use only the explicitly covered range; old immutable XP journals can include
 // a sub-millisecond partial day whose serialized coverage rounded to midnight.
 const xp=await readMiningWalletActivity(db,{wallet,day,policyVersion}).catch(error=>{
  if(error instanceof MiningWalletActivityError){
   if(['IDENTITY_COVERAGE_UNAVAILABLE','DAY_COVERAGE_UNAVAILABLE','DAY_OPEN'].includes(error.code))fail('XP_COVERAGE_UNAVAILABLE');
   fail(error.code==='SOURCE_CONFLICT'?'SOURCE_CONFLICT':'SOURCE_UNAVAILABLE');
  }
  throw error;
 });
 const activity=xp.days.at(-1)!,qualifying=new Set(activity.qualifyingRaidIds);
 const freshQualified=inputs.playedRaidIds.some(id=>qualifying.has(id));
 const base=development.base;
 let progressTotal=0,progressWeight=0,developed=true;
 for(const kind of ['keep','workshop','goldforge'] as const){
  const completed=development.completed[kind],weight=POLICY.developmentWeights[kind];
  if(completed.length>1)return fail('SOURCE_CONFLICT');
  const level=completed[0]?.level??0;
  if(!Number.isSafeInteger(level)||level<0)return fail('SOURCE_CONFLICT');
  if(level<POLICY.requiredLevel[kind])developed=false;
  if(kind==='keep'&&base&&level!==base.keep_level)developed=false;
  progressTotal+=ratio(Math.min(level,POLICY.fullLevel[kind]),SCALE,POLICY.fullLevel[kind])*weight;progressWeight+=weight;
 }
 const progressionBps=Math.floor(progressTotal/progressWeight);
 const baseMultiplierBps=POLICY.baseFloorBps+ratio(progressionBps,POLICY.baseProgressBps,SCALE);
 // Separate prospective evidence covers every positive Gems origin, including
 // late credits absent from the earlier cohort. Paid or unknown sources cannot
 // inherit this restricted cohort's zero useful-chain component.
 const lastDay=xp.latestQualifiedDay;
 const lastActivity=xp.days.find(row=>row.day===lastDay);
 const usefulChainBps=gems.zeroQualifyingCredit?0:null,activityBps=lastActivity?.activityBps??0;
 const walletScoreBps=usefulChainBps===null?0:Math.floor((activityBps*POLICY.activityWeight+xp.experienceBps*POLICY.experienceWeight+usefulChainBps*POLICY.usefulChainWeight)
  /(POLICY.activityWeight+POLICY.experienceWeight+POLICY.usefulChainWeight));
 const lastQualifiedAt=xp.qualifiedRaids.filter(raid=>raid.baseId===inputs.baseId&&raid.day===lastDay).map(raid=>raid.firstAcceptedAt).sort().at(-1)??null;
 const ageSec=lastQualifiedAt?Math.max(0,(start+DAY_MS-Date.parse(lastQualifiedAt))/1000):null;
 const retentionBps=ageSec===null?0:ageSec<=PHASE_E_POLICY.mining.scoreGraceSec?SCALE:
  Math.max(0,Math.floor((POLICY.decayZeroAfterSec-ageSec)*SCALE/(POLICY.decayZeroAfterSec-PHASE_E_POLICY.mining.scoreGraceSec)));
 const baseScoreBps=ratio(ratio(walletScoreBps,baseMultiplierBps,SCALE),retentionBps,SCALE);
 const identityValid=inputs.cohortValid&&gems.zeroQualifyingCredit&&base?.owner_wallet===wallet&&base.status==='active'&&base.land_paid_at===null&&base.deed_asset_id===null&&base.deed_mint_asset_id===null&&base.deed_minting_at===null;
 const reason=!identityValid?'cohort_invalid':!developed?'development_required':!freshQualified?'no_qualified_activity':inputs.pendingUnits===0?'no_contribution':'qualified';
 const eligibleUnits=reason==='qualified'?Math.min(inputs.pendingUnits,PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay):0;
 return {wallet,baseId:inputs.baseId,day,policyVersion,reason,eligibleUnits,recordedXp:xp.recordedXp,experienceBps:xp.experienceBps,
  experienceCoverage:{fromDay:xp.experienceCoverage.fromDay,throughDay:day,partialBirthDayExcluded:xp.experienceCoverage.partialBirthDayExcluded},
  activityBps,usefulChainBps,progressionBps,baseMultiplierBps,retentionBps,walletScoreBps,baseScoreBps,
  weight:(BigInt(eligibleUnits)*BigInt(baseScoreBps)).toString(),reservationIds:inputs.reservationIds,
  gemsOriginIds:gems.originIds,allocationReady:false as const,publicationAuthorized:false as const};
}
