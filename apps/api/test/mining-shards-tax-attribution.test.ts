import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,it,expect} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {splitResourceEarnings} from '@shardkeep/shared/phaseEResourceTax';
import {evaluateShardsTaxAttribution,replayShardsTaxAttribution,SHARDS_TAX_LINEAGE} from '../src/mining/shardsTaxAttribution';
const exemptRewards=['campaign_first_three_star','legacy_campaign_first_three_star','quest_reward','quest_daily_bonus','mail_reward_reserve','daily_cache','legacy_daily_cache','obstacle_reward','league_weekly_cache'] as const;
const nonEarningAllocations=['starter_grant','starter_topup','development_funding'] as const;
const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58(),start='2035-01-01T00:00:00.000Z';
function term(at=start,zero=false){return {snapshot:{version:1,termId:randomUUID(),startsAt:at,endsAt:new Date(Date.parse(at)+PHASE_E_POLICY.seekerIsland.operatingTermSec*1000).toISOString(),source:{kind:'solana_auction_round',genesisHash:key(201),programId:key(202),auctionConfig:key(203),round:'1'},spots:Array.from({length:PHASE_E_POLICY.seekerIsland.totalSpots},(_,spotId)=>({spotId,ownerWallet:zero||spotId>1?null:key(204),auctionAccount:key(spotId+1),settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))},finality:{commitment:'finalized',contextSlot:'200',observedAt:at}};}
function fixture(){return {source:{version:1,kind:'physical_mine',key:'mine:test:segment:1',wallet:key(205),baseId:randomUUID(),gross:1n,earning:{kind:'instant',at:start},authority:{classification:'new_earning',decisionRef:'fixture:explicit-original-earning-semantics',evidenceSha256:'cd'.repeat(32)},ledger:{transactionId:randomUUID(),idempotencyKey:'source:test:1'}},term:term(),carry:{wallet:key(205),currency:'SHARDS',lineage:SHARDS_TAX_LINEAGE,sequence:0n,value:0n}};}
function attributed(f=fixture()){const r=evaluateShardsTaxAttribution(f);expect(r.status).toBe('attributed');if(r.status!=='attributed')throw Error('held');return r;}
describe('isolated SHARDS original-source attribution, never source authentication',()=>{
 it('splits only the explicit gross and freezes original source/term/ledger without authorizing posting',()=>{
  const f=fixture();f.source.gross=100n;const r=attributed(f);expect(r.receipt).toMatchObject({source:f.source,net:80n,tax:20n,carryBefore:f.carry,carryAfter:{...f.carry,sequence:1n,value:0n},pool:{termId:f.term.snapshot.termId,winnerCount:2,amount:20n,disposition:'original_winning_spots'},sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});expect(Object.isFrozen(r.receipt.source.earning)).toBe(true);
 });
 it('continues one wallet/SHARDS/lineage carry through different sources, bases, midnight and term',()=>{
  const f=fixture();f.source.gross=4n;const a=attributed(f);const next=fixture();next.source.kind='physical_mine';next.source.key='cache:test:next';next.source.earning.at=f.term.snapshot.endsAt;next.term=term(f.term.snapshot.endsAt);next.carry={...a.receipt.carryAfter};const b=attributed(next);
  expect(a.receipt.tax).toBe(0n);expect(b.receipt.tax).toBe(1n);expect(b.receipt.carryAfter.value).toBe(0n);expect(b.receipt.pool.termId).toBe(next.term.snapshot.termId);expect(b.receipt.pool.termId).not.toBe(f.term.snapshot.termId);expect(b.receipt.source.baseId).not.toBe(a.receipt.source.baseId);
 });
 it('retains known-zero tax in its original term without losing fractional carry or inventing a claimant',()=>{
  const f=fixture();f.term=term(start,true);f.source.gross=7n;f.carry.value=8000n;const r=attributed(f);expect(r.receipt.pool).toMatchObject({winnerCount:0,amount:2n,disposition:'held_zero_winners'});expect(r.receipt.carryAfter.value).toBe(2000n);
 });
 it('holds missing/partial term authority even for zero gross without advancing carry',()=>{
  const f=fixture();f.source.gross=0n;for(const term of [null,undefined]){const r=evaluateShardsTaxAttribution({...f,term});expect(r).toMatchObject({status:'held',reason:'TERM_AUTHORITY_REQUIRED',carry:f.carry,receipt:null});}expect(()=>evaluateShardsTaxAttribution({...f,term:{...f.term,snapshot:{...f.term.snapshot,spots:[]}}})).toThrow();
 });
 it('keeps legacy Mine output held without independently settled earning authority',()=>{
  const f=fixture();for(const authority of [null,{classification:'unresolved'}])expect(evaluateShardsTaxAttribution({...f,source:{...f.source,kind:'legacy_mine',authority}})).toMatchObject({status:'held',reason:'SOURCE_AUTHORITY_REQUIRED',carry:f.carry,receipt:null});
  expect(evaluateShardsTaxAttribution({...f,source:{...f.source,kind:'legacy_mine'}})).toMatchObject({status:'held',reason:'SOURCE_POLICY_UNRESOLVED',carry:f.carry,receipt:null});
 });
 it.each(nonEarningAllocations)('does not turn %s into gameplay earnings or consume carry, even with caller-supplied authority',kind=>{
  const f=fixture();f.source.gross=100n;f.carry={...f.carry,sequence:7n,value:9000n};
  const before=structuredClone(f);
  for(const authority of [null,{classification:'unresolved'},f.source.authority])for(const term of [null,f.term]){
   const r=evaluateShardsTaxAttribution({...f,source:{...f.source,kind,authority},term});
   expect(r).toEqual({status:'held',reason:'NOT_NEW_EARNING',carry:before.carry,receipt:null,sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});
  }
  expect(f).toEqual(before);
 });
 it.each(nonEarningAllocations)('rejects a fabricated historical tax receipt for %s without rewriting the original source',kind=>{
  const f=fixture();f.source.gross=100n;const saved=structuredClone(attributed(f).receipt);
  const forged={...saved,source:{...saved.source,kind}},before=structuredClone(forged);
  expect(()=>replayShardsTaxAttribution(forged,forged.source)).toThrow('original source classification');
  expect(forged).toEqual(before);
 });
 // Owner exemption supersedes the former campaign candidate and unresolved
 // quest/mail classification; caller authority cannot opt a reward into tax.
 it.each(exemptRewards)('exempts %s before caller authority or term requirements and leaves carry untouched',kind=>{
  const f=fixture();f.source.gross=100n;f.carry={...f.carry,sequence:7n,value:9000n};
  const before=structuredClone(f.carry);
  for(const authority of [null,{classification:'unresolved'},f.source.authority])for(const term of [null,f.term]){
   const r=evaluateShardsTaxAttribution({...f,source:{...f.source,kind,authority},term});
   expect(r).toEqual({status:'held',reason:'SOURCE_TAX_EXEMPT',carry:before,receipt:null,sourceVerified:false,postingAuthorized:false,payoutAuthorized:false});
  }
  expect(f.carry).toEqual(before);
 });
 it.each(exemptRewards.filter(kind=>kind!=='daily_cache'))('rejects a forged taxed %s receipt even when its arithmetic and caller authority are valid',kind=>{
  const f=fixture();f.source.gross=100n;f.carry.value=9000n;const saved=structuredClone(attributed(f).receipt);
  const forged={...saved,source:{...saved.source,kind}};
  expect(()=>replayShardsTaxAttribution(forged,forged.source)).toThrow('original source classification');
 });
 it('does not let exempt rewards consume the fractional carry between accepted Mine earnings',()=>{
  const first=fixture();first.source.gross=4n;const mine=attributed(first).receipt;
  expect(mine.carryAfter.value).toBe(8000n);
  for(const kind of exemptRewards){const r=evaluateShardsTaxAttribution({...fixture(),source:{...fixture().source,kind,gross:999n},carry:mine.carryAfter});
   expect(r).toMatchObject({status:'held',reason:'SOURCE_TAX_EXEMPT',carry:mine.carryAfter,receipt:null});}
  const next=fixture();next.source.kind='physical_mine';next.carry={...mine.carryAfter};const cache=attributed(next).receipt;
  expect(cache.tax).toBe(1n);expect(cache.carryAfter).toEqual({...mine.carryAfter,sequence:2n,value:0n});
 });
 it('never taxes conversions, receipts, existing raid balance, refunds or cutover movement',()=>{
  const f=fixture();for(const kind of ['gems_conversion','keep_conversion','existing_value_transfer','refund','mail_claim','mail_expiry','tax_receipt','custody_cutover']){const r=evaluateShardsTaxAttribution({...f,source:{...f.source,kind}});expect(r).toMatchObject({status:'held',reason:'NOT_NEW_EARNING',carry:f.carry,receipt:null});}
 });
 it('checks half-open earning instants and requires an interval wholly inside its original term',()=>{
  const f=fixture();expect(attributed(f).status).toBe('attributed');for(const at of [f.term.snapshot.endsAt,new Date(Date.parse(start)-1).toISOString()])expect(()=>evaluateShardsTaxAttribution({...f,source:{...f.source,earning:{kind:'instant',at}}})).toThrow();
  const interval={kind:'interval',startsAt:start,endsAt:f.term.snapshot.endsAt};expect(evaluateShardsTaxAttribution({...f,source:{...f.source,earning:interval}}).status).toBe('attributed');
  for(const patch of [{startsAt:interval.endsAt},{endsAt:new Date(Date.parse(interval.endsAt)+1).toISOString()},{startsAt:new Date(Date.parse(start)-1).toISOString()}])expect(()=>evaluateShardsTaxAttribution({...f,source:{...f.source,earning:{...interval,...patch}}})).toThrow();
 });
 it('requires finality observation at original earning authority time, never later payout time',()=>{
  const f=fixture();f.term.finality.observedAt=new Date(Date.parse(start)+1).toISOString();expect(()=>evaluateShardsTaxAttribution(f)).toThrow();
 });
 it('rejects owner, currency or policy carry substitution and explicit overflow without partial output',()=>{
  const f=fixture();for(const patch of [{wallet:key(206)},{currency:'KEEP'},{lineage:'changed'},{sequence:RAW_RESOURCE_STORAGE_MAX},{value:BigInt(PHASE_E_POLICY.basisPoints)},{value:-1n}])expect(()=>evaluateShardsTaxAttribution({...f,carry:{...f.carry,...patch}})).toThrow();for(const gross of [-1n,RAW_RESOURCE_STORAGE_MAX+1n,1,'1'])expect(()=>evaluateShardsTaxAttribution({...f,source:{...f.source,gross}})).toThrow();
 });
 it('matches the established amount kernel at int64 limits and preserves carry for zero gross',()=>{
  for(const gross of [0n,1n,9_007_199_254_740_993n,RAW_RESOURCE_STORAGE_MAX]){const f=fixture();f.source.gross=gross;f.carry.value=9999n;const r=attributed(f),s=splitResourceEarnings(gross,f.carry.value);expect({gross:r.receipt.source.gross,net:r.receipt.net,tax:r.receipt.tax,nextCarry:r.receipt.carryAfter.value}).toEqual(s);}
 });
 it('retains frozen v1 cache receipts while refusing new cache attribution',()=>{
  const f=fixture();f.source.gross=100n;const saved=structuredClone(attributed(f).receipt);
  const historical={...saved,source:{...saved.source,kind:'daily_cache'}};
  expect(replayShardsTaxAttribution(historical,historical.source)).toEqual(historical);
  expect(evaluateShardsTaxAttribution({...f,source:historical.source,term:null})).toMatchObject({status:'held',reason:'SOURCE_TAX_EXEMPT',carry:f.carry});
 });
 it('replays the exact original receipt without today’s carry, owner, winners or clock',()=>{
  const f=fixture(),r=attributed(f),saved=structuredClone(r.receipt);f.term.snapshot.spots.forEach(s=>s.ownerWallet=key(207));f.carry.value=9000n;expect(replayShardsTaxAttribution(saved,f.source)).toEqual(saved);expect(replayShardsTaxAttribution({...saved,policy:Object.fromEntries(Object.entries(saved.policy).reverse())},f.source)).toEqual(saved);
  for(const patch of [{wallet:key(208)},{baseId:randomUUID()},{key:'other'},{gross:2n},{ledger:{...f.source.ledger,transactionId:randomUUID()}},{earning:{kind:'instant',at:new Date(Date.parse(start)+1).toISOString()}}])expect(()=>replayShardsTaxAttribution(saved,{...f.source,...patch})).toThrow();
 });
 it('audits stored math, term identity, frozen policy and linked carry on every replay',()=>{
  const r=attributed();for(const change of [(v:typeof r.receipt)=>{v.net+=1n;},(v:typeof r.receipt)=>{v.tax+=1n;},(v:typeof r.receipt)=>{v.carryAfter.value+=1n;},(v:typeof r.receipt)=>{v.carryAfter.sequence+=1n;},(v:typeof r.receipt)=>{v.pool.termId=randomUUID();},(v:typeof r.receipt)=>{v.termHash='ab'.repeat(32);},(v:typeof r.receipt)=>{(v.policy as {islandPoolBps:number}).islandPoolBps++;}]){const copy=structuredClone(r.receipt);change(copy);expect(()=>replayShardsTaxAttribution(copy,copy.source)).toThrow();}
 });
 it('owns nested inputs and rejects extra authority and unknown source kinds',()=>{
  const f=fixture(),r=attributed(f),saved=structuredClone(r.receipt);f.source.authority.evidenceSha256='ef'.repeat(32);f.term.snapshot.spots[0]!.ownerWallet=key(209);expect(r.receipt).toEqual(saved);
  for(const input of [{...fixture(),postingAuthorized:true},{...fixture(),source:{...fixture().source,kind:'arbitrary_mint'}},{...fixture(),source:{...fixture().source,[Symbol('authority')]:true}}])expect(()=>evaluateShardsTaxAttribution(input)).toThrow();
 });
});
