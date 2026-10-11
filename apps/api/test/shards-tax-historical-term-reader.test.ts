/** Real chain verification over signed fixture bytes; no live-chain authority. */
import {createHash,randomUUID} from 'node:crypto';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {OBSTACLES,PHASE_E_POLICY} from '@shardkeep/shared';
import type {ReviewedSeekerTermPolicy,SeekerTermRpc} from '@shardkeep/chain/seeker-terms';
import {seekerAuctionPda,seekerTermPda} from '@shardkeep/chain/seeker-auction-protocol';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {prefetchHistoricalShardsTerm} from '../src/mining/shardsTaxHistoricalTermReader';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {hashExpeditionTermSnapshot} from '../src/game/expeditionTerms';
import {evaluateObstacleEarningEvidence} from '../src/mining/shardsTaxObstacleEvidence';

const day='2035-01-01',completedAt=day+'T00:00:00.000Z',completedMs=Date.parse(completedAt);
const duration=PHASE_E_POLICY.seekerIsland.operatingTermSec*1000;
const iso=(offset:number)=>new Date(completedMs+offset).toISOString();
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
async function fixture(zero=false,expired=true){
 const owner=Keypair.generate().publicKey;
 const f=await createMiningTermFixture({day,genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey,
  winners:zero?[]:[{spotId:0,wallet:owner},{spotId:PHASE_E_POLICY.seekerIsland.kingSpots,wallet:owner}]});
 const observedAt=iso(expired?duration+1250:1250);
 f.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(Date.parse(observedAt)/1000)),32);
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(observedAt));
 return {...f,owner,observedAt};
}
function obstacle(term:Awaited<ReturnType<typeof prefetchHistoricalShardsTerm>>,earnedAt=iso(1000)){
 const baseId=randomUUID();return {version:1,job:{jobId:randomUUID(),baseId,obstacleId:randomUUID(),capturedAt:iso(-1),scheduledFinishAt:earnedAt,
  finishesAt:earnedAt,gross:BigInt(OBSTACLES.clearRewardShards),evidenceSha256:'ab'.repeat(32)},accelerations:[],
  custody:{status:'confirmed',baseId,wallet:term.snapshot.spots.find(s=>s.ownerWallet!==null)?.ownerWallet??Keypair.generate().publicKey.toBase58(),
   startsAt:iso(-1),endsAt:null,evidenceSha256:'cd'.repeat(32)},term,processedAt:term.finality.observedAt};
}

const policyKeys=['programId','config','mint','prizeOwner','prizeAta','genesisHash'] as const;
function copyPolicy(policy:ReviewedSeekerTermPolicy):ReviewedSeekerTermPolicy{
 return {...policy,...Object.fromEntries(policyKeys.map(field=>[field,new PublicKey(policy[field].toBytes())])),deployment:{...policy.deployment}};
}
function assertDeepFrozen(value:unknown):void{
 if(value===null||typeof value!=='object')return;
 expect(Object.isFrozen(value)).toBe(true);for(const child of Object.values(value))assertDeepFrozen(child);
}

describe('explicit original historical SHARDS term prefetch',()=>{
 it('verifies expired winning auctions and preserves actual observation, completion, slots and reviewed deployment',async()=>{
  const f=await fixture(),term=await prefetchHistoricalShardsTerm(f.connect,f.policy);
  expect(term).toMatchObject({version:1,purpose:'historical_shards_attribution',completedAt,
   completedSlot:String(Math.max(...[...f.bodies.values()].map(body=>body.slot))),
   deployment:{...f.policy.deployment,deployedSlot:f.programData.readBigUInt64LE(4).toString()},
   finality:{commitment:'finalized',contextSlot:'2000',observedAt:f.observedAt},operatingAdmissionAuthorized:false});
  expect(term.snapshot.spots.filter(s=>s.ownerWallet===f.owner.toBase58())).toHaveLength(2);
  expect(term.termHash).toBe(hashExpeditionTermSnapshot(term.snapshot));expect(Date.parse(term.finality.observedAt)).toBeGreaterThan(Date.parse(term.snapshot.endsAt));
  expect(evaluateObstacleEarningEvidence(obstacle(term))).toMatchObject({status:'consistent',sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false,
   evidence:{earnedAt:iso(1000),winnerCount:2,poolDisposition:'original_winning_spots'}});
 });
 it('preserves verified all-unsold history as known zero, while absent authority remains held',async()=>{
  const f=await fixture(true),term=await prefetchHistoricalShardsTerm(f.connect,f.policy),input=obstacle(term);
  expect(term.snapshot.spots).toHaveLength(PHASE_E_POLICY.seekerIsland.totalSpots);
  expect(term.snapshot.spots.every(s=>s.ownerWallet===null)).toBe(true);
  expect(evaluateObstacleEarningEvidence(input)).toMatchObject({status:'consistent',evidence:{winnerCount:0,poolDisposition:'held_zero_winners'}});
  expect(evaluateObstacleEarningEvidence({...input,term:null})).toMatchObject({status:'held',reason:'TERM_AUTHORITY_REQUIRED',evidence:null});
 });
 it('uses the same canonical snapshot, UUID and hash as the current expedition reader within its active interval',async()=>{
  const f=await fixture(false,false),historical=await prefetchHistoricalShardsTerm(f.connect,f.policy);
  const current=await (await prefetchExpeditionTermReader(f.connect,f.policy)).readOperatingTerm(f.observedAt);
  expect(current).not.toBeNull();expect(historical.snapshot).toEqual(current!.snapshot);
  expect(historical.termHash).toBe(hashExpeditionTermSnapshot(current!.snapshot));
  expect(historical.snapshot.termId).toBe(current!.snapshot.termId);
  expect(historical.finality).toEqual(current!.finality);
 });
 it('requires the explicitly reviewed original round instead of substituting an available current round',async()=>{
  const f=await fixture();
  await expect(prefetchHistoricalShardsTerm(f.connect,{...f.policy,round:1n})).rejects.toThrow();
  const original=await prefetchHistoricalShardsTerm(f.connect,f.policy);
  expect(original.snapshot.source.round).toBe('0');
 });
 it('copies every source PublicKey, original round and deployment pin before its first await',async()=>{
  const f=await fixture(),policy=copyPolicy(f.policy),originalDeployment={...policy.deployment};
  const source={kind:'solana_auction_round',genesisHash:policy.genesisHash.toBase58(),programId:policy.programId.toBase58(),
   auctionConfig:policy.config.toBase58(),round:policy.round.toString()};
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  let first=true;
  const rpc:SeekerTermRpc={...f.rpc,getGenesisHash:async()=>{if(first){first=false;enter();await gate;}return f.rpc.getGenesisHash();}};
  const pending=prefetchHistoricalShardsTerm(()=>rpc,policy);
  await entered;
  try {
   // Mutate the underlying BN too: new PublicKey(existingPublicKey) would retain it.
   for(const field of policyKeys){const words=(Reflect.get(policy[field],'_bn') as {words:number[]}).words;words[0]=words[0]!^1;}
   Reflect.set(policy,'round',1n);Reflect.set(policy,'stateProvenance','unreviewed-retained-state');
   Reflect.set(policy.deployment,'programDataAddress',Keypair.generate().publicKey.toBase58());
   Reflect.set(policy.deployment,'programDataSha256','ef'.repeat(32));Reflect.set(policy.deployment,'upgradeAuthority',null);
  } finally {release();}
  const result=await pending;
  expect(result.snapshot.source).toEqual(source);
  expect(result.deployment).toEqual({...originalDeployment,deployedSlot:f.programData.readBigUInt64LE(4).toString()});
 });
 it.each(['term account','deployment binary','RPC genesis'] as const)('rejects actual %s changes during the verification bracket',async change=>{
  const f=await fixture(),policy=copyPolicy(f.policy);let changed=false;
  const originalGetTransaction=f.rpc.getTransaction;
  const rpc:SeekerTermRpc={...f.rpc,
   getGenesisHash:async()=>change==='RPC genesis'&&changed?Keypair.generate().publicKey.toBase58():f.rpc.getGenesisHash(),
   getTransaction:(async(signature:string)=>{
    if(!changed){changed=true;
     if(change==='term account'){
      const bytes=f.store.get(seekerTermPda(f.policy.programId,f.policy.config,f.policy.round).toBase58())!.data;
      bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
     }
     if(change==='deployment binary'){
      const bytes=f.store.get(f.programDataAddress.toBase58())!.data;bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
      // Changing the caller's pin cannot legitimize an RPC binary swap mid-read.
      Reflect.set(policy.deployment,'programDataSha256',createHash('sha256').update(bytes).digest('hex'));
     }
    }
    return originalGetTransaction(signature,{maxSupportedTransactionVersion:0,commitment:'finalized'});
   }) as SeekerTermRpc['getTransaction']};
  await expect(prefetchHistoricalShardsTerm(()=>rpc,policy)).rejects.toThrow();expect(changed).toBe(true);
 });
 it.each(['missing auction','missing settlement','failed settlement','invalid signature'] as const)(
  'rejects %s rather than manufacturing zero winners or partial evidence',async missing=>{
   const f=await fixture(true),[signature,body]=[...f.bodies.entries()][0]!;
   if(missing==='missing auction')f.store.delete(seekerAuctionPda(f.policy.programId,f.policy.config,0,f.policy.round).toBase58());
   if(missing==='missing settlement')f.bodies.delete(signature);
   if(missing==='failed settlement')body.meta!.err={InstructionError:[0,'InvalidArgument']};
   if(missing==='invalid signature')body.transaction.signatures[0]=Keypair.generate().publicKey.toBase58();
   await expect(prefetchHistoricalShardsTerm(f.connect,f.policy)).rejects.toThrow();
  });
 it('keeps late observation intact and rejects an earning before original completion, even inside the original interval',async()=>{
  const f=await fixture(),term=await prefetchHistoricalShardsTerm(f.connect,f.policy),input=obstacle(term,iso(-1));
  input.job.capturedAt=iso(-1000);input.custody.startsAt=iso(-1000);
  expect(Date.parse(input.job.finishesAt)).toBeGreaterThan(Date.parse(term.snapshot.startsAt));
  expect(evaluateObstacleEarningEvidence(input)).toMatchObject({status:'held',reason:'TERM_NOT_COMPLETE_AT_EARNING',evidence:null});
  const atCompletion={...input,job:{...input.job,scheduledFinishAt:completedAt,finishesAt:completedAt}};
  expect(evaluateObstacleEarningEvidence(atCompletion)).toMatchObject({status:'consistent',evidence:{earnedAt:completedAt,
   term:{completedAt,finality:{observedAt:f.observedAt}}}});
  const atEnd={...input,job:{...input.job,scheduledFinishAt:term.snapshot.endsAt,finishesAt:term.snapshot.endsAt}};
  expect(evaluateObstacleEarningEvidence(atEnd)).toMatchObject({status:'held',reason:'ORIGINAL_TERM_REQUIRED'});
  expect(term.finality.observedAt).toBe(f.observedAt);
 });
 it('returns only detached deeply frozen certificate fields, with deterministic repeat verification',async()=>{
  const f=await fixture(),first=await prefetchHistoricalShardsTerm(f.connect,f.policy),saved=JSON.stringify(first);
  const second=await prefetchHistoricalShardsTerm(f.connect,f.policy);expect(second).toEqual(first);expect(second).not.toBe(first);
  expect(Object.keys(first).sort()).toEqual(['version','purpose','snapshot','termHash','completedAt','completedSlot','deployment','finality','operatingAdmissionAuthorized'].sort());
  assertDeepFrozen(first);
  f.store.clear();f.bodies.clear();Reflect.set(f.policy.deployment,'programDataSha256','ff'.repeat(32));
  expect(JSON.stringify(first)).toBe(saved);
  expect(()=>Reflect.set(first.snapshot.spots[0]!,'ownerWallet',Keypair.generate().publicKey.toBase58())).not.toThrow();
  expect(JSON.stringify(first)).toBe(saved);expect(first.operatingAdmissionAuthorized).toBe(false);
 });

});
