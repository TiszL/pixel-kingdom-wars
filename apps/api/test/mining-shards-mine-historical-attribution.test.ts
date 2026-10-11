/** A recovered Mine source is tied to its original units and historical term. */
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,expect,it} from 'vitest';
import {PHASE_E_HARVESTER,PHASE_E_POLICY} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {hashExpeditionTermSnapshot} from '../src/game/expeditionTerms';
import {SHARDS_TAX_LINEAGE} from '../src/mining/shardsTaxAttribution';
import {attributeHistoricalMineTax,replayHistoricalMineTax,hashHistoricalMineTaxEvidence,HISTORICAL_MINE_SOURCE_DECISION} from '../src/mining/shardsTaxMineHistoricalAttribution';
const start='2037-01-01T00:00:00.000Z',duration=PHASE_E_POLICY.seekerIsland.operatingTermSec*1000;
const at=(ms:number)=>new Date(Date.parse(start)+ms).toISOString(),key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const id=(n:number)=>`ac000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
 const snapshot={version:1,termId:id(1),startsAt:start,endsAt:at(duration),source:{kind:'solana_auction_round',genesisHash:key(201),programId:key(202),auctionConfig:key(203),round:'1'},
  spots:Array.from({length:PHASE_E_POLICY.seekerIsland.totalSpots},(_,spotId)=>({spotId,ownerWallet:spotId<2?key(204):null,auctionAccount:key(spotId+1),
   settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))};
 const term={version:1,purpose:'historical_shards_attribution',snapshot,termHash:hashExpeditionTermSnapshot(snapshot),completedAt:at(1000),
  completedSlot:String(99+PHASE_E_POLICY.seekerIsland.totalSpots),deployment:{programDataAddress:key(205),programDataSha256:'cd'.repeat(32),deployedSlot:'99',upgradeAuthority:key(206)},
  finality:{commitment:'finalized',contextSlot:String(101+PHASE_E_POLICY.seekerIsland.totalSpots),observedAt:at(duration+1000)},operatingAdmissionAuthorized:false};
 const original={parentId:id(2),childId:id(3),mineId:id(4),baseId:id(5),wallet:key(207),recoveryHash:'12'.repeat(32),custodyHash:'34'.repeat(32),
  sourceKey:`mine-recovered:${id(2)}:u2`,anchorAt:start,quota:'86400',firstUnit:'2',lastUnit:'8',gross:'7',startsAt:at(2000),endsAt:at(8000),resolvedAt:at(duration+2000)};
 const carry={wallet:original.wallet,currency:'SHARDS',lineage:SHARDS_TAX_LINEAGE,sequence:0n,value:0n};
 return {term,original,carry};
}
function source(f=fixture(),gross=7n){return {version:1,kind:'physical_mine',key:f.original.sourceKey+':fixture:collect',wallet:f.original.wallet,baseId:f.original.baseId,gross,
 earning:{kind:'interval',startsAt:f.original.startsAt,endsAt:new Date(Date.parse(f.original.endsAt)+1).toISOString()},
 authority:{classification:'new_earning',decisionRef:HISTORICAL_MINE_SOURCE_DECISION,evidenceSha256:hashHistoricalMineTaxEvidence(f.original,f.term)},
 ledger:{transactionId:id(9),idempotencyKey:'fixture:collect'}};}
const receipt=(f=fixture(),gross=7n)=>attributeHistoricalMineTax({source:source(f,gross),original:f.original,term:f.term,carry:f.carry});
const replay=(r:unknown,f=fixture(),gross=7n)=>replayHistoricalMineTax(r,source(f,gross),f.original,f.term);
function frozen(v:unknown):void{if(v&&typeof v==='object'){expect(Object.isFrozen(v)).toBe(true);for(const child of Object.values(v))frozen(child);}}
function reorder(v:unknown):unknown{if(Array.isArray(v))return v.map(reorder);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)]));return v;}
describe('historical Mine receipt integrity',()=>{
 it('preserves earning, completion and actual late observation independently after expiry',()=>{
  const f=fixture(),r=receipt(f),v=PHASE_E_HARVESTER.v1;
  expect(r).toMatchObject({version:2,purpose:'historical_physical_mine',term:f.term,net:7n-7n*BigInt(v.islandPoolBps)/BigInt(v.taxBasisPoints),
   sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
  expect(r.source.earning).toEqual(source(f).earning);expect(replay(r,f)).toEqual(r);frozen(r);
 });
 it('supports a partial delivery from one fully attributed child without minting its remaining quantity',()=>{
  const f=fixture(),r=receipt(f,3n);expect(r.net+r.tax).toBe(3n);expect(replay(r,f,3n)).toEqual(r);
  expect(()=>receipt(f,8n)).toThrow();expect(()=>receipt(f,0n)).toThrow();
 });
 it('keeps a positively verified zero-winner term distinct from unavailable authority',()=>{
  const f=fixture();f.term.snapshot.spots.forEach(s=>{s.ownerWallet=null;});f.term.termHash=hashExpeditionTermSnapshot(f.term.snapshot);
  expect(receipt(f).pool).toMatchObject({winnerCount:0,disposition:'held_zero_winners'});
  expect(()=>attributeHistoricalMineTax({...f,source:source(f),term:null})).toThrow();
 });
 it.each(['anchor','quota','first','last','gross','source key','self parent'] as const)('rejects inconsistent original %s',kind=>{
  const f=fixture();if(kind==='anchor')f.original.anchorAt=at(1);if(kind==='quota')f.original.quota='172800';if(kind==='first')f.original.firstUnit='3';
  if(kind==='last')f.original.lastUnit='9';if(kind==='gross')f.original.gross='6';if(kind==='source key')f.original.sourceKey='unrelated';if(kind==='self parent')f.original.parentId=f.original.childId;
  expect(()=>receipt(f)).toThrow();
 });
 it.each(['term starts','term ends','completion','future observation'] as const)('refuses %s outside original eligibility',kind=>{
  const f=fixture();if(kind==='term starts'){f.term.snapshot.startsAt=at(3000);f.term.snapshot.endsAt=at(duration+3000);f.term.completedAt=at(3000);}
  if(kind==='term ends'){f.term.snapshot.startsAt=at(-duration+8000);f.term.snapshot.endsAt=at(8000);}
  if(kind==='completion')f.term.completedAt=at(3000);if(kind==='future observation')f.term.finality.observedAt=at(duration+3000);
  f.term.termHash=hashExpeditionTermSnapshot(f.term.snapshot);expect(()=>receipt(f)).toThrow();
 });
 it('binds complete certificates and recovery evidence even while the common pool hash stays unchanged',()=>{
  const f=fixture(),r=receipt(f);
  for(const changed of [{...f,term:{...f.term,completedAt:at(1500)}},{...f,term:{...f.term,deployment:{...f.term.deployment,programDataSha256:'56'.repeat(32)}}},
   {...f,original:{...f.original,recoveryHash:'56'.repeat(32)}},{...f,original:{...f.original,custodyHash:'56'.repeat(32)}},{...f,original:{...f.original,childId:id(20)}}]){
   expect(changed.term.termHash).toBe(f.term.termHash);expect(()=>replay(r,changed)).toThrow();
  }
 });
 it('binds the exact child, original actor and delivered amount rather than accepting a saved receipt as authority',()=>{
  const f=fixture(),s=source(f),r=receipt(f);
  for(const change of [{kind:'daily_cache'},{wallet:key(208)},{baseId:id(6)},{gross:8n},{key:'other'},
   {authority:{...s.authority,decisionRef:'caller-approved'}},{authority:{...s.authority,evidenceSha256:'00'.repeat(32)}}])
   expect(()=>attributeHistoricalMineTax({...f,source:{...s,...change}})).toThrow();
  for(const change of [{net:r.net+1n},{tax:r.tax+1n},{carryAfter:{...r.carryAfter,sequence:5n}},{historicalCertificateHash:'00'.repeat(32)},
   {sourceVerified:true},{postingAuthorized:true},{payoutAuthorized:true},{operatingAdmissionAuthorized:true},{purpose:'historical_obstacle'}])expect(()=>replay({...r,...change},f)).toThrow();
 });
 it('replays normalized JSONB order and frozen economics after tuning while new attribution refuses',()=>{
  const f=fixture(),r=receipt(f),old=PHASE_E_POLICY.taxes.resources.islandPoolBps;
  expect(replayHistoricalMineTax(reorder(r),reorder(source(f)),reorder(f.original),reorder(f.term))).toEqual(r);
  Reflect.set(PHASE_E_POLICY.taxes.resources,'islandPoolBps',old+1);
  try{expect(replay(r,f)).toEqual(r);expect(()=>receipt(f)).toThrow();}finally{Reflect.set(PHASE_E_POLICY.taxes.resources,'islandPoolBps',old);}
 });
 it('preserves the original shared wallet carry and refuses sequence overflow',()=>{
  const f=fixture();f.carry.sequence=12n;f.carry.value=BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints)-1n;
  const r=receipt(f),n=7n*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)+f.carry.value;
  expect(r.carryAfter).toMatchObject({sequence:13n,value:n%BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints)});
  f.carry.sequence=RAW_RESOURCE_STORAGE_MAX;expect(()=>receipt(f)).toThrow();
 });
 it('rejects accessors, hidden authority and extra fields without invoking getters',()=>{
  const f=fixture();let called=0;const original=Object.defineProperty({...f.original},'quota',{enumerable:true,get(){called++;return '86400';}});
  expect(()=>attributeHistoricalMineTax({...f,original,source:source(f)})).toThrow();
  expect(()=>attributeHistoricalMineTax({...f,source:source(f),approved:true})).toThrow();
  expect(()=>attributeHistoricalMineTax({...f,original:{...f.original,[Symbol('authority')]:true},source:source(f)})).toThrow();expect(called).toBe(0);
 });
});
