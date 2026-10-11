/** Pure obstacle amounts bind independently reconstructed historical evidence. */
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,expect,it} from 'vitest';
import {PHASE_E_HARVESTER,PHASE_E_POLICY} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {hashExpeditionTermSnapshot} from '../src/game/expeditionTerms';
import {evaluateShardsTaxAttribution,SHARDS_TAX_LINEAGE,type ShardsTaxCarry} from '../src/mining/shardsTaxAttribution';
import {evaluateObstacleEarningEvidence,hashHistoricalShardsTermCertificate,serializeHistoricalShardsTermCertificate} from '../src/mining/shardsTaxObstacleEvidence';
import {evaluateShardsObstacleTaxAttribution,replayShardsObstacleTaxAttribution,hashShardsObstacleSourceEvidence,SHARDS_OBSTACLE_SOURCE_DECISION} from '../src/mining/shardsTaxObstacleAttribution';
const start='2037-01-01T00:00:00.000Z',duration=PHASE_E_POLICY.seekerIsland.operatingTermSec*1000;
const at=(ms:number)=>new Date(Date.parse(start)+ms).toISOString(),key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const id=(n:number)=>`ab000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const flags={sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false};
const V1=PHASE_E_HARVESTER.v1;
function fixture(){
 const snapshot={version:1,termId:id(1),startsAt:start,endsAt:at(duration),source:{kind:'solana_auction_round',genesisHash:key(201),programId:key(202),auctionConfig:key(203),round:'1'},
  spots:Array.from({length:PHASE_E_POLICY.seekerIsland.totalSpots},(_,spotId)=>({spotId,ownerWallet:spotId<2?key(204):null,auctionAccount:key(spotId+1),
   settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))};
 const term={version:1,purpose:'historical_shards_attribution',snapshot,termHash:hashExpeditionTermSnapshot(snapshot),completedAt:at(1000),
  completedSlot:String(99+PHASE_E_POLICY.seekerIsland.totalSpots),deployment:{programDataAddress:key(205),programDataSha256:'cd'.repeat(32),deployedSlot:'99',upgradeAuthority:key(206) as string|null},
  finality:{commitment:'finalized',contextSlot:String(101+PHASE_E_POLICY.seekerIsland.totalSpots),observedAt:at(duration+1000)},operatingAdmissionAuthorized:false};
 return {version:1,job:{jobId:id(2),baseId:id(3),obstacleId:id(4),capturedAt:start,scheduledFinishAt:at(10000),finishesAt:at(10000),gross:7n,evidenceSha256:'ef'.repeat(32)},
  accelerations:[] as {key:string;kind:'item'|'gems';acceptedAt:string;beforeFinishAt:string;afterFinishAt:string;evidenceSha256:string}[],
  custody:{status:'confirmed',baseId:id(3),wallet:key(207),startsAt:start,endsAt:null as string|null,evidenceSha256:'12'.repeat(32)},term,processedAt:at(duration+2000)};
}
function source(evidence=fixture()){
 const sourceKey=`obstacle-reward:${evidence.job.jobId}`;
 return {version:1,kind:'obstacle_reward',key:sourceKey,wallet:evidence.custody.wallet,baseId:evidence.job.baseId,gross:evidence.job.gross,
  earning:{kind:'instant',at:evidence.job.finishesAt},authority:{classification:'new_earning',decisionRef:SHARDS_OBSTACLE_SOURCE_DECISION,evidenceSha256:hashShardsObstacleSourceEvidence(evidence)},
  ledger:{transactionId:id(10),idempotencyKey:sourceKey}};
}
const carry=(wallet=key(207)):ShardsTaxCarry=>({wallet,currency:'SHARDS',lineage:SHARDS_TAX_LINEAGE,sequence:0n,value:0n});
function attributed(evidence=fixture(),before=carry()){
 const original=source(evidence),result=evaluateShardsObstacleTaxAttribution({source:original,evidence,carry:before});
 expect(result).toMatchObject({status:'attributed',...flags});if(result.status!=='attributed')throw Error('expected fixture attribution');return {receipt:result.receipt,original};
}
function frozen(value:unknown):void{if(value&&typeof value==='object'){expect(Object.isFrozen(value)).toBe(true);for(const child of Object.values(value))frozen(child);}}
function reorder(value:unknown):unknown{if(Array.isArray(value))return value.map(reorder);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)]));return value;}

describe('historical obstacle SHARDS attribution without issuer authority',()=>{
 it('attributes after expiry while preserving the genuine original earning and late observation',()=>{
  const f=fixture(),{receipt,original}=attributed(f),tax=f.job.gross*BigInt(V1.islandPoolBps)/BigInt(V1.taxBasisPoints);
  expect(receipt).toMatchObject({version:2,source:original,term:f.term,termHash:f.term.termHash,historicalCertificateHash:hashHistoricalShardsTermCertificate(f.term),
   net:f.job.gross-tax,tax,pool:{termId:f.term.snapshot.termId,termHash:f.term.termHash,winnerCount:2,amount:tax,disposition:'original_winning_spots'},...flags});
  expect(receipt.carryAfter).toEqual({...carry(),sequence:1n,value:f.job.gross*BigInt(V1.islandPoolBps)%BigInt(V1.taxBasisPoints)});
  expect(replayShardsObstacleTaxAttribution(receipt,original,f)).toEqual(receipt);frozen(receipt);
 });
 it('retains tax in a positively verified zero-winner original pool while missing authority holds the carry',()=>{
  const f=fixture();f.term.snapshot.spots.forEach(spot=>{spot.ownerWallet=null;});f.term.termHash=hashExpeditionTermSnapshot(f.term.snapshot);
  const {receipt,original}=attributed(f);expect(receipt.pool).toMatchObject({winnerCount:0,disposition:'held_zero_winners',amount:receipt.tax});
  expect(evaluateShardsObstacleTaxAttribution({source:original,evidence:{...f,term:null},carry:carry()})).toEqual({status:'held',reason:'TERM_AUTHORITY_REQUIRED',carry:carry(),receipt:null,...flags});
 });
 it('binds every historical certificate field even when the shared snapshot hash and pool are unchanged',()=>{
  const f=fixture(),{receipt,original}=attributed(f);
  for(const term of [{...f.term,completedAt:at(2000)},{...f.term,deployment:{...f.term.deployment,programDataSha256:'34'.repeat(32)}},
   {...f.term,finality:{...f.term.finality,observedAt:at(duration+1500)}}]){
   expect(term.termHash).toBe(f.term.termHash);expect(hashHistoricalShardsTermCertificate(term)).not.toBe(receipt.historicalCertificateHash);
   expect(()=>replayShardsObstacleTaxAttribution({...receipt,term,historicalCertificateHash:hashHistoricalShardsTermCertificate(term)},original,f)).toThrow();
  }
 });
 it('keeps later observations in distinct evidence identities without splitting the common original tax pool',()=>{
  const a=fixture(),b=structuredClone(a);b.term.finality.observedAt=at(duration+1500);
  const first=attributed(a),second=attributed(b);expect(second.receipt.pool).toEqual(first.receipt.pool);
  expect(second.receipt.historicalCertificateHash).not.toBe(first.receipt.historicalCertificateHash);
  expect(second.original.authority.evidenceSha256).not.toBe(first.original.authority.evidenceSha256);
  expect(()=>replayShardsObstacleTaxAttribution(first.receipt,second.original,b)).toThrow();
 });
 it('canonicalizes reordered JSONB object fields without losing complete certificate or source binding',()=>{
  const f=fixture(),{receipt,original}=attributed(f);
  expect(serializeHistoricalShardsTermCertificate(reorder(f.term))).toBe(serializeHistoricalShardsTermCertificate(f.term));
  expect(hashShardsObstacleSourceEvidence(reorder(f))).toBe(original.authority.evidenceSha256);
  expect(replayShardsObstacleTaxAttribution(reorder(receipt),reorder(original),reorder(f))).toEqual(receipt);
 });
 // D-153.196 (owner, 2026-09-29; 8cd3fda6a): daily-cache rewards are untaxed, so a new cache can no longer be the
 // third taxed earning in this chain. The carry still has to thread exactly through Mine -> historical obstacle -> Mine,
 // and an exempt cache claimed in between must be held without advancing or consuming that carry.
 it('preserves one wallet carry across Mine, obstacle and later Mine earnings while an exempt cache leaves it untouched',()=>{
  const f=fixture();f.term.finality.observedAt=f.term.completedAt;
  const generic=(kind:'physical_mine'|'daily_cache',gross:bigint,before:ShardsTaxCarry,n:number)=>evaluateShardsTaxAttribution({source:{...source(f),kind,key:`fixture:${n}`,gross,earning:{kind:'instant',at:at(n)},
    authority:{classification:'new_earning',decisionRef:'fixture:accepted-source',evidenceSha256:'56'.repeat(32)},ledger:{transactionId:id(n),idempotencyKey:`fixture:${n}`}},
    term:{snapshot:f.term.snapshot,finality:f.term.finality},carry:before});
  const mineAt=(gross:bigint,before:ShardsTaxCarry,n:number)=>{
   const result=generic('physical_mine',gross,before,n);
   if(result.status!=='attributed')throw Error('expected independent Mine fixture');return result.receipt;
  };
  const mine=mineAt(3n,carry(),2000),obstacle=attributed(f,mine.carryAfter).receipt;
  expect(generic('daily_cache',3n,obstacle.carryAfter,11000)).toMatchObject({status:'held',reason:'SOURCE_TAX_EXEMPT',carry:obstacle.carryAfter,receipt:null});
  const later=mineAt(3n,obstacle.carryAfter,12000);
  const total=mine.source.gross+obstacle.source.gross+later.source.gross;
  expect(later.carryAfter.sequence).toBe(3n);expect(mine.tax+obstacle.tax+later.tax).toBe(total*BigInt(V1.islandPoolBps)/BigInt(V1.taxBasisPoints));
  expect(later.carryAfter.value).toBe(total*BigInt(V1.islandPoolBps)%BigInt(V1.taxBasisPoints));
 });
 it('retains exact bigint quantities above Number precision and refuses storage or sequence overflow',()=>{
  for(const gross of [9_007_199_254_740_993n,RAW_RESOURCE_STORAGE_MAX]){
   const f=fixture();f.job.gross=gross;const {receipt,original}=attributed(f);
   expect(receipt.net+receipt.tax).toBe(gross);expect(replayShardsObstacleTaxAttribution(receipt,original,f)).toEqual(receipt);
  }
  const f=fixture(),original=source(f);
  expect(()=>evaluateShardsObstacleTaxAttribution({source:original,evidence:f,carry:{...carry(),sequence:RAW_RESOURCE_STORAGE_MAX}})).toThrow();
  for(const gross of [7, '7',RAW_RESOURCE_STORAGE_MAX+1n])expect(()=>hashShardsObstacleSourceEvidence({...f,job:{...f.job,gross}})).toThrow();
 });
 it('re-evaluates raw evidence rather than accepting a caller supplied consistent status',()=>{
  const f=fixture(),original=source(f);
  expect(evaluateShardsObstacleTaxAttribution({source:original,evidence:{...f,accelerations:null},carry:carry()})).toMatchObject({status:'held',reason:'SCHEDULE_UNRESOLVED',carry:carry(),...flags});
  expect(()=>evaluateShardsObstacleTaxAttribution({source:original,evidence:evaluateObstacleEarningEvidence(f),carry:carry()})).toThrow();
  expect(()=>replayShardsObstacleTaxAttribution(attributed(f).receipt,original,{...f,custody:{status:'unresolved'}})).toThrow();
 });
 it('replays frozen economics after current tax tuning but refuses a new receipt on the old lineage',()=>{
  const f=fixture(),{receipt,original}=attributed(f),old=PHASE_E_POLICY.taxes.resources.islandPoolBps;
  Reflect.set(PHASE_E_POLICY.taxes.resources,'islandPoolBps',old+1);
  try{expect(replayShardsObstacleTaxAttribution(receipt,original,f)).toEqual(receipt);
   expect(()=>evaluateShardsObstacleTaxAttribution({source:original,evidence:f,carry:carry()})).toThrow('current policy');
  }finally{Reflect.set(PHASE_E_POLICY.taxes.resources,'islandPoolBps',old);}
 });
 it('binds exact source kind, original wallet/base/job/time/gross, decision and ledger key',()=>{
  const f=fixture(),original=source(f);
  for(const change of [{kind:'daily_cache'},{key:`obstacle-reward:${id(99)}`},{wallet:key(208)},{baseId:id(9)},{gross:8n},
   {earning:{kind:'instant',at:at(9000)}},{ledger:{...original.ledger,idempotencyKey:'other:key'}},
   {authority:{...original.authority,decisionRef:'caller-approved'}},{authority:{...original.authority,evidenceSha256:'78'.repeat(32)}}])
   expect(()=>evaluateShardsObstacleTaxAttribution({source:{...original,...change},evidence:f,carry:carry()})).toThrow();
 });
 it('binds job, custody, acceleration and processing evidence beyond the source amount fields',()=>{
  const f=fixture(),{receipt,original}=attributed(f);
  for(const evidence of [{...f,job:{...f.job,evidenceSha256:'90'.repeat(32)}},{...f,custody:{...f.custody,evidenceSha256:'90'.repeat(32)}},{...f,processedAt:at(duration+3000)},
   {...f,job:{...f.job,scheduledFinishAt:at(20000)},accelerations:[{key:id(20),kind:'item',acceptedAt:at(5000),beforeFinishAt:at(20000),afterFinishAt:at(10000),evidenceSha256:'90'.repeat(32)}]}]){
   expect(hashShardsObstacleSourceEvidence(evidence)).not.toBe(original.authority.evidenceSha256);
   expect(()=>replayShardsObstacleTaxAttribution(receipt,original,evidence)).toThrow();
  }
 });
 it('rejects altered receipt arithmetic, policy, historical hashes and authority fields',()=>{
  const f=fixture(),{receipt,original}=attributed(f);
  for(const change of [{version:1},{net:receipt.net+1n},{tax:receipt.tax+1n},{carryAfter:{...receipt.carryAfter,value:0n}},
   {policy:{...receipt.policy,islandPoolBps:0}},{historicalCertificateHash:'00'.repeat(32)},{termHash:'00'.repeat(32)},
   {pool:{...receipt.pool,amount:receipt.tax+1n}},{sourceVerified:true},{postingAuthorized:true},{payoutAuthorized:true},{operatingAdmissionAuthorized:true}])
   expect(()=>replayShardsObstacleTaxAttribution({...receipt,...change},original,f)).toThrow();
 });
 it('refuses getters, symbols and extra fields without executing evidence getters',()=>{
  const f=fixture(),original=source(f),{receipt}=attributed(f);let called=0;
  const earning=Object.defineProperty({},'kind',{enumerable:true,get(){called++;return 'instant';}});
  for(const input of [{source:{...original,earning},evidence:f,carry:carry()},{source:{...original,[Symbol('authority')]:true},evidence:f,carry:carry()},
   {source:original,evidence:{...f,approved:true},carry:carry()},{source:original,evidence:f,carry:{...carry(),approved:true}},
   {source:original,evidence:f,carry:carry(),approved:true},{source:original,evidence:Object.defineProperty({...f},'hiddenAuthority',{value:true}),carry:carry()}])expect(()=>evaluateShardsObstacleTaxAttribution(input)).toThrow();
  expect(()=>replayShardsObstacleTaxAttribution({...receipt,approved:true},original,f)).toThrow();expect(called).toBe(0);
 });
 it('returns detached deeply frozen evidence and preserves an earlier valid observation without backdating it',()=>{
  const f=fixture();f.term.finality.observedAt=f.term.completedAt;const before=structuredClone(f),{receipt,original}=attributed(f),replayed=replayShardsObstacleTaxAttribution(receipt,original,f);
  expect(receipt.term.finality.observedAt).toBe(at(1000));expect(f).toEqual(before);frozen(receipt);frozen(replayed);
  f.job.gross=99n;f.custody.wallet=key(209);f.term.deployment.programDataSha256='98'.repeat(32);
  expect(receipt).toEqual(replayed);expect(receipt.term).toEqual(before.term);
 });
 it('leaves the generic obstacle source-policy hold intact even after dedicated pure attribution succeeds',()=>{
  const f=fixture(),{original}=attributed(f),before=carry();
  // D-153.196 (owner, 2026-09-29; 8cd3fda6a): the generic hold reason for obstacle rewards is now the owner's tax
  // exemption, not an unresolved policy. What must not change: the generic path still issues no receipt and keeps the carry.
  expect(evaluateShardsTaxAttribution({source:original,term:{snapshot:f.term.snapshot,finality:f.term.finality},carry:before}))
   .toMatchObject({status:'held',reason:'SOURCE_TAX_EXEMPT',carry:before,receipt:null,sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});
 });
});
