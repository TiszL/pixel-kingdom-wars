/** Pure historical consistency never authenticates an obstacle, owner or issuer. */
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,expect,it} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {hashExpeditionTermSnapshot,parseExpeditionTermObservation} from '../src/game/expeditionTerms';
import {evaluateShardsTaxAttribution,SHARDS_TAX_LINEAGE} from '../src/mining/shardsTaxAttribution';
import {evaluateObstacleEarningEvidence,parseHistoricalShardsTermCertificate} from '../src/mining/shardsTaxObstacleEvidence';

const start='2037-01-01T00:00:00.000Z',at=(ms:number)=>new Date(Date.parse(start)+ms).toISOString();
const duration=PHASE_E_POLICY.seekerIsland.operatingTermSec*1000;
const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const id=(n:number)=>`ab000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const flags={sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false};
function certificate(){
 const snapshot={version:1,termId:id(1),startsAt:start,endsAt:at(duration),
  source:{kind:'solana_auction_round',genesisHash:key(201),programId:key(202),auctionConfig:key(203),round:'1'},
  spots:Array.from({length:PHASE_E_POLICY.seekerIsland.totalSpots},(_,spotId)=>({spotId,ownerWallet:spotId<2?key(204):null,
   auctionAccount:key(spotId+1),settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))};
 return {version:1,purpose:'historical_shards_attribution',snapshot,termHash:hashExpeditionTermSnapshot(snapshot),completedAt:at(1000),
  completedSlot:String(99+PHASE_E_POLICY.seekerIsland.totalSpots),
  deployment:{programDataAddress:key(205),programDataSha256:'cd'.repeat(32),deployedSlot:'99',upgradeAuthority:key(206) as string|null},
  finality:{commitment:'finalized',contextSlot:String(101+PHASE_E_POLICY.seekerIsland.totalSpots),observedAt:at(duration+1000)},
  operatingAdmissionAuthorized:false};
}
type Acceleration={key:string;kind:'item'|'gems';acceptedAt:string;beforeFinishAt:string;afterFinishAt:string;evidenceSha256:string};
function fixture(){return {version:1,job:{jobId:id(2),baseId:id(3),obstacleId:id(4),capturedAt:start,scheduledFinishAt:at(10000),
 finishesAt:at(10000),gross:7n,evidenceSha256:'ef'.repeat(32)},accelerations:[] as Acceleration[],
 custody:{status:'confirmed',baseId:id(3),wallet:key(207),startsAt:start,endsAt:null as string|null,evidenceSha256:'12'.repeat(32)},
 term:certificate(),processedAt:at(duration+2000)};}
function consistent(input:unknown=fixture()){
 const result=evaluateObstacleEarningEvidence(input);expect(result).toMatchObject({status:'consistent',...flags});
 if(result.status!=='consistent')throw Error('Expected consistent historical evidence');return result;
}
function held(input:unknown,reason:string){const result=evaluateObstacleEarningEvidence(input);expect(result).toEqual({status:'held',reason,evidence:null,...flags});expect(Object.isFrozen(result)).toBe(true);}
function accelerated(){const f=fixture();f.accelerations=[
 {key:id(5),kind:'item',acceptedAt:at(2000),beforeFinishAt:at(10000),afterFinishAt:at(8000),evidenceSha256:'23'.repeat(32)},
 {key:id(6),kind:'gems',acceptedAt:at(3000),beforeFinishAt:at(8000),afterFinishAt:at(5000),evidenceSha256:'34'.repeat(32)},
 ];f.job.finishesAt=at(5000);return f;}

describe('obstacle original earning evidence without source or posting authority',()=>{
 it('retains a late historical observation after expiry without backdating completion or earning',()=>{
  const f=fixture(),r=consistent(f);
  expect(r.evidence).toEqual({version:1,job:f.job,capturedSchedule:f.accelerations,custody:f.custody,earnedAt:f.job.finishesAt,
   processedAt:f.processedAt,gross:f.job.gross,term:f.term,winnerCount:2,poolDisposition:'original_winning_spots'});
  expect(parseHistoricalShardsTermCertificate(f.term)).toEqual(f.term);
  expect(()=>parseExpeditionTermObservation({snapshot:f.term.snapshot,finality:f.term.finality},f.job.finishesAt)).toThrow();
  expect(()=>parseExpeditionTermObservation({snapshot:f.term.snapshot,finality:f.term.finality},f.processedAt)).toThrow();
 });
 it('distinguishes absent term authority from a positively completed original zero-winner pool',()=>{
  const f=fixture();held({...f,term:null},'TERM_AUTHORITY_REQUIRED');
  f.term.snapshot.spots.forEach(s=>{s.ownerWallet=null;});f.term.termHash=hashExpeditionTermSnapshot(f.term.snapshot);
  expect(consistent(f).evidence).toMatchObject({winnerCount:0,poolDisposition:'held_zero_winners',term:{termHash:f.term.termHash}});
  expect(()=>parseHistoricalShardsTermCertificate({...f.term,snapshot:{...f.term.snapshot,spots:[]}})).toThrow();
 });
 it('holds an absent acceleration history or unsupported effective-finish change',()=>{
  const f=fixture();held({...f,accelerations:null},'SCHEDULE_UNRESOLVED');
  held({...f,job:{...f.job,finishesAt:at(9000)}},'SCHEDULE_UNRESOLVED');
  const speedup=accelerated();speedup.job.finishesAt=at(4999);held(speedup,'SCHEDULE_UNRESOLVED');
 });
 it('earns exactly at completion, never merely at job capture or before it is due',()=>{
  const f=fixture();f.term.completedAt=start;f.term.finality.observedAt=start;
  for(const processedAt of [f.job.capturedAt,at(9999)])held({...f,processedAt},'NOT_DUE');
  const r=consistent({...f,processedAt:f.job.finishesAt});expect(r.evidence.earnedAt).toBe(at(10000));
 });
 it('uses the original term half-open interval including its first instant and excluding its end',()=>{
  const f=fixture();f.job.capturedAt=at(-1);f.job.scheduledFinishAt=start;f.job.finishesAt=start;f.custody.startsAt=at(-1);f.term.completedAt=start;
  expect(consistent(f).evidence.earnedAt).toBe(start);
  const before=fixture();before.job.capturedAt=at(-2);before.job.scheduledFinishAt=at(-1);before.job.finishesAt=at(-1);before.custody.startsAt=at(-2);
  held(before,'ORIGINAL_TERM_REQUIRED');
  const end=fixture();end.job.scheduledFinishAt=at(duration);end.job.finishesAt=at(duration);held(end,'ORIGINAL_TERM_REQUIRED');
 });
 it('does not substitute a later term for an old completion',()=>{
  const f=fixture();f.term.snapshot.startsAt=at(duration);f.term.snapshot.endsAt=at(duration*2);f.term.snapshot.termId=id(8);
  f.term.completedAt=at(duration+1);f.term.finality.observedAt=at(duration*2+1);f.processedAt=at(duration*2+2);f.term.termHash=hashExpeditionTermSnapshot(f.term.snapshot);
  held(f,'ORIGINAL_TERM_REQUIRED');
 });
 it('requires the term to have completed by earning, allowing equality without later-finality backdating',()=>{
  const f=fixture();f.term.completedAt=f.job.finishesAt;consistent(f);
  f.term.completedAt=at(10001);held(f,'TERM_NOT_COMPLETE_AT_EARNING');
 });
 it('allows an earlier completed-term observation while independently requiring due processing',()=>{
  const f=fixture();f.term.finality.observedAt=f.term.completedAt;const r=consistent(f);
  expect(r.evidence.term.finality.observedAt).toBe(at(1000));expect(r.evidence.earnedAt).toBe(at(10000));
 });
 it('requires confirmed same-base custody and holds equal-time boundaries without event ordering',()=>{
  const f=fixture();held({...f,custody:{status:'unresolved'}},'CUSTODY_UNRESOLVED');
  for(const patch of [{baseId:id(9)},{startsAt:f.job.finishesAt},{startsAt:at(10001)},{endsAt:f.job.finishesAt},{endsAt:at(9999)}])held({...f,custody:{...f.custody,...patch}},'CUSTODY_UNRESOLVED');
  expect(consistent({...f,custody:{...f.custody,startsAt:at(9999),endsAt:at(10001)}}).evidence.custody.wallet).toBe(f.custody.wallet);
 });
 it('retains the original earner after a later transfer instead of assigning the processing-time owner',()=>{
  const f=fixture();f.custody.endsAt=at(10001);expect(consistent(f).evidence.custody.wallet).toBe(key(207));
  held({...f,custody:{...f.custody,wallet:key(208),startsAt:at(10001),endsAt:null}},'CUSTODY_UNRESOLVED');
 });
 it('replays ordered item and Gems accelerations into one original effective completion',()=>{
  const f=accelerated(),r=consistent(f);expect(r.evidence.capturedSchedule).toEqual(f.accelerations);
  expect(r.evidence.earnedAt).toBe(at(5000));expect(r.evidence.job.scheduledFinishAt).toBe(at(10000));
 });
 it('allows nondecreasing same-instant accelerations and completion at speedup acceptance',()=>{
  const f=accelerated();f.accelerations[1]!.acceptedAt=at(2000);f.accelerations[1]!.afterFinishAt=at(2000);f.job.finishesAt=at(2000);
  expect(consistent(f).evidence.earnedAt).toBe(at(2000));
 });
 it('rejects duplicated, reordered, late or extending acceleration facts rather than repairing the schedule',()=>{
  const changes:Array<(f:ReturnType<typeof accelerated>)=>void>=[
   f=>{f.accelerations[1]!.key=f.accelerations[0]!.key;},f=>{f.accelerations.reverse();},
   f=>{f.accelerations[0]!.acceptedAt=at(-1);},f=>{f.accelerations[0]!.acceptedAt=at(10000);},
   f=>{f.accelerations[1]!.beforeFinishAt=at(7999);},f=>{f.accelerations[1]!.afterFinishAt=at(2999);},
   f=>{f.accelerations[1]!.afterFinishAt=at(8001);},
  ];for(const change of changes){const f=accelerated();change(f);expect(()=>evaluateObstacleEarningEvidence(f)).toThrow();}
  const f=accelerated();expect(()=>evaluateObstacleEarningEvidence({...f,accelerations:[{...f.accelerations[0],kind:'manual'}]})).toThrow();
 });
 it('rejects malformed captured jobs, noncanonical identifiers/times and unsupported quantity representations',()=>{
  const f=fixture();for(const patch of [{scheduledFinishAt:start},{scheduledFinishAt:at(-1)},{jobId:id(2).toUpperCase()},
   {obstacleId:'not-an-id'},{baseId:id(3).toUpperCase()},{capturedAt:'2037-01-01T00:00:00Z'},{finishesAt:'2037-02-30T00:00:00.000Z'},
   {evidenceSha256:'EF'.repeat(32)},{gross:0n},{gross:-1n},{gross:RAW_RESOURCE_STORAGE_MAX+1n},{gross:'7'},{gross:7}])
   expect(()=>evaluateObstacleEarningEvidence({...f,job:{...f.job,...patch}})).toThrow();
 });
 it('retains exact whole quantities above Number precision through the storage maximum',()=>{
  for(const gross of [9_007_199_254_740_993n,RAW_RESOURCE_STORAGE_MAX]){
   const f=fixture();f.job.gross=gross;expect(consistent(f).evidence.gross).toBe(gross);
  }
 });
 it('rejects extra fields and injected authority at each evidence boundary',()=>{
  const f=accelerated();for(const input of [{...f,term:undefined},{...f,postingAuthorized:true},{...f,carry:{}},{...f,job:{...f.job,verified:true}},
   {...f,custody:{...f.custody,authorized:true}},{...f,accelerations:[{...f.accelerations[0],sourceVerified:true},f.accelerations[1]]},
   {...f,[Symbol('authority')]:true}])expect(()=>evaluateObstacleEarningEvidence(input)).toThrow();
  for(const term of [{...f.term,sourceVerified:true},{...f.term,operatingAdmissionAuthorized:true},
   {...f.term,purpose:'operating_admission'},{...f.term,deployment:{...f.term.deployment,verified:true}},
   {...f.term,finality:{...f.term.finality,verified:true}}])expect(()=>parseHistoricalShardsTermCertificate(term)).toThrow();
 });
 it('rejects hash tampering, contradictory completion and observations after processing',()=>{
  const f=fixture();for(const term of [{...f.term,termHash:'00'.repeat(32)},{...f.term,completedAt:at(-1)},
   {...f.term,completedAt:at(duration+1001)},{...f.term,finality:{...f.term.finality,commitment:'confirmed'}},
   {...f.term,snapshot:{...f.term.snapshot,termId:id(10)}}])expect(()=>parseHistoricalShardsTermCertificate(term)).toThrow();
  expect(()=>evaluateObstacleEarningEvidence({...f,processedAt:at(duration)})).toThrow();
 });
 it('checks deployed, every settlement, completion and context slot order using canonical u64 strings',()=>{
  const f=fixture();for(const term of [{...f.term,deployment:{...f.term.deployment,deployedSlot:'101'}},
   {...f.term,completedSlot:'100'},{...f.term,completedSlot:String(BigInt(f.term.completedSlot)+1n)},
   {...f.term,completedSlot:String(BigInt(f.term.finality.contextSlot)+1n)}])expect(()=>parseHistoricalShardsTermCertificate(term)).toThrow();
  for(const slot of ['01','-1','1.0','18446744073709551616',1]){
   expect(()=>parseHistoricalShardsTermCertificate({...f.term,completedSlot:slot})).toThrow();
   expect(()=>parseHistoricalShardsTermCertificate({...f.term,deployment:{...f.term.deployment,deployedSlot:slot}})).toThrow();
   expect(()=>parseHistoricalShardsTermCertificate({...f.term,finality:{...f.term.finality,contextSlot:slot}})).toThrow();
  }
  const max='18446744073709551615';f.term.deployment.deployedSlot=max;f.term.snapshot.spots.forEach(s=>{s.settlementSlot=max;});
  f.term.completedSlot=max;f.term.finality.contextSlot=max;f.term.termHash=hashExpeditionTermSnapshot(f.term.snapshot);
  expect(parseHistoricalShardsTermCertificate(f.term).completedSlot).toBe(max);
 });
 it('requires canonical deployment and snapshot identities without treating well-formed keys as trusted',()=>{
  const f=fixture();for(const deployment of [{...f.term.deployment,programDataAddress:'wrong'},{...f.term.deployment,upgradeAuthority:'wrong'},
   {...f.term.deployment,programDataSha256:'AB'.repeat(32)}])expect(()=>parseHistoricalShardsTermCertificate({...f.term,deployment})).toThrow();
  expect(()=>parseHistoricalShardsTermCertificate({...f.term,snapshot:{...f.term.snapshot,termId:f.term.snapshot.termId.toUpperCase()}})).toThrow();
  f.term.deployment.upgradeAuthority=null;expect(consistent(f)).toMatchObject(flags);
 });
 it('returns detached deeply frozen deterministic evidence without mutating the caller',()=>{
  const f=accelerated(),before=structuredClone(f),a=consistent(f),b=consistent(structuredClone(f));expect(a).toEqual(b);expect(f).toEqual(before);
  const certificateCopy=parseHistoricalShardsTermCertificate(f.term);
  const frozen=(value:unknown):void=>{if(value!==null&&typeof value==='object'){expect(Object.isFrozen(value)).toBe(true);for(const child of Object.values(value))frozen(child);}};
  frozen(a);frozen(certificateCopy);
  f.job.gross=99n;f.accelerations[0]!.evidenceSha256='56'.repeat(32);f.custody.wallet=key(209);f.term.snapshot.spots[0]!.ownerWallet=key(210);
  expect(a).toEqual(b);expect(certificateCopy).toEqual(before.term);expect(a.evidence.job).not.toBe(f.job);expect(a.evidence.capturedSchedule).not.toBe(f.accelerations);
 });
 it('does not admit obstacle issuance through the existing attribution policy after evidence becomes consistent',()=>{
  const f=fixture(),e=consistent(f).evidence;
  const source={version:1,kind:'obstacle_reward',key:`obstacle:${f.job.jobId}`,wallet:f.custody.wallet,baseId:f.job.baseId,gross:e.gross,
   earning:{kind:'instant',at:e.earnedAt},authority:{classification:'new_earning',decisionRef:'fixture:obstacle-evidence-only',evidenceSha256:f.job.evidenceSha256},
   ledger:{transactionId:id(11),idempotencyKey:`obstacle:${f.job.jobId}`}};
  const carry={wallet:f.custody.wallet,currency:'SHARDS',lineage:SHARDS_TAX_LINEAGE,sequence:0n,value:0n};
  // D-153.196 (owner, 2026-09-29; 8cd3fda6a): obstacle rewards are untaxed, so the generic policy now holds them as
  // SOURCE_TAX_EXEMPT instead of SOURCE_POLICY_UNRESOLVED. The guarantee this case protects is unchanged: consistent
  // evidence plus caller new-earning authority still yields no receipt, no carry advance and no posting/payout authority.
  expect(evaluateShardsTaxAttribution({source,term:{snapshot:f.term.snapshot,finality:f.term.finality},carry})).toEqual({
   status:'held',reason:'SOURCE_TAX_EXEMPT',carry,receipt:null,sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});
 });
});
