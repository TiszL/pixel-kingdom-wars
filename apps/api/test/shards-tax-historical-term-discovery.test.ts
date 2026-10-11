/** Original calendar discovery over real account bytes and signed settlement fixtures. */
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import type {ReviewedSeekerTermPolicy,SeekerTermRpc} from '@shardkeep/chain/seeker-terms';
import {seekerAuctionPda,seekerTermPda} from '@shardkeep/chain/seeker-auction-protocol';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {prefetchHistoricalShardsTermAt} from '../src/mining/shardsTaxHistoricalTermDiscovery';

const duration=PHASE_E_POLICY.seekerIsland.operatingTermSec,grace=BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec);
const first=BigInt(Date.parse('2035-01-01T00:00:00.000Z')/1000)-grace;
const iso=(seconds:bigint)=>new Date(Number(seconds)*1000).toISOString();
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(round=7n,zero=false){
 const startsAt=first+round*BigInt(duration),owner=Keypair.generate().publicKey;
 const f=await createMiningTermFixture({day:iso(startsAt+grace).slice(0,10),round,firstOperatingStart:first,
  programId:Keypair.generate().publicKey,genesisHash:Keypair.generate().publicKey,winners:zero?[]:[{spotId:0,wallet:owner}]});
 const observedAt=iso(startsAt+BigInt(duration)+100n);
 f.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Date.parse(observedAt)/1000),32);
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(observedAt));
 const {round:ignored,...sourcePolicy}=f.policy;void ignored;
 return {...f,sourcePolicy,owner,startsAt,observedAt};
}
async function pair(){
 const old=await fixture(),nextStarts=old.startsAt+BigInt(duration),newOwner=Keypair.generate().publicKey;
 const newer=await createMiningTermFixture({day:iso(nextStarts+grace).slice(0,10),round:old.policy.round+1n,firstOperatingStart:first,
  programId:old.policy.programId,genesisHash:old.policy.genesisHash,mint:old.policy.mint,prizeOwner:old.policy.prizeOwner,
  programData:old.programData,programDataAddress:old.programDataAddress,upgradeAuthority:old.upgradeAuthority,
  winners:[{spotId:0,wallet:newOwner}]});
 expect(newer.store.get(old.policy.config.toBase58())!.data).toEqual(old.store.get(old.policy.config.toBase58())!.data);
 for(const [address,row]of newer.store)old.store.set(address,row);
 for(const [signature,body]of newer.bodies)old.bodies.set(signature,body);
 const observedAt=iso(nextStarts+BigInt(duration)+100n);
 old.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Date.parse(observedAt)/1000),32);
 vi.setSystemTime(new Date(observedAt));
 const rpc:SeekerTermRpc={...old.rpc,getSignaturesForAddress:async(address,options,commitment)=>{
  const rows=await old.rpc.getSignaturesForAddress(address,options,commitment);
  return rows.length?rows:newer.rpc.getSignaturesForAddress(address,options,commitment);
 }};
 return {...old,rpc,connect:(_signal:AbortSignal)=>rpc,nextStarts,newOwner,observedAt};
}

describe('historical SHARDS term discovery by original earning time',()=>{
 it('discovers a nonzero original round and authenticates its actual completed historical term',async()=>{
  const f=await fixture(),earnedAt=iso(f.startsAt+grace+1n);
  const result=await prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,earnedAt);
  expect(result.snapshot.source.round).toBe('7');expect(result.snapshot.startsAt).toBe(iso(f.startsAt));
  expect(result.snapshot.spots[0]!.ownerWallet).toBe(f.owner.toBase58());
  expect(result.completedAt).toBe(iso(f.startsAt+grace));expect(result.finality.observedAt).toBe(f.observedAt);
  expect(result.operatingAdmissionAuthorized).toBe(false);expect(Object.isFrozen(result)).toBe(true);
 });
 it('selects original versus newer ownership on one immutable config at the exact half-open millisecond boundary',async()=>{
  const f=await pair(),policyWithUnrelatedCurrentRound={...f.sourcePolicy,round:99n};
  const before=new Date(Number(f.nextStarts)*1000-1).toISOString();
  const old=await prefetchHistoricalShardsTermAt(f.connect,policyWithUnrelatedCurrentRound,before);
  let nextCandidateRead=false;const nextAddress=seekerTermPda(f.policy.programId,f.policy.config,8n);
  const boundaryRpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,config)=>{
   if(addresses.some(address=>address.equals(nextAddress)))nextCandidateRead=true;
   return f.rpc.getMultipleAccountsInfoAndContext(addresses,config);
  }};
  // Permissionless settlements complete only after grace. At the boundary the
  // new round is selected but cannot authorize earning before its completion.
  await expect(prefetchHistoricalShardsTermAt(()=>boundaryRpc,policyWithUnrelatedCurrentRound,iso(f.nextStarts))).rejects.toThrow();
  expect(nextCandidateRead).toBe(true);
  const next=await prefetchHistoricalShardsTermAt(f.connect,policyWithUnrelatedCurrentRound,iso(f.nextStarts+grace));
  expect(old.snapshot.source.round).toBe('7');expect(old.snapshot.spots[0]!.ownerWallet).toBe(f.owner.toBase58());
  expect(next.snapshot.source.round).toBe('8');expect(next.snapshot.spots[0]!.ownerWallet).toBe(f.newOwner.toBase58());
  expect(old.snapshot.endsAt).toBe(next.snapshot.startsAt);expect(old.snapshot.termId).not.toBe(next.snapshot.termId);
  expect(next.completedAt).toBe(iso(f.nextStarts+grace));
 });
 it('refuses an earning before the original calendar without querying a fallback current round',async()=>{
  const f=await fixture(),transactions=vi.spyOn(f.rpc,'getTransaction');
  await expect(prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,new Date(Number(first)*1000-1).toISOString())).rejects.toThrow();
  expect(transactions).not.toHaveBeenCalled();
 });
 it('requires completion at the original earning time even when the earning is inside the term',async()=>{
  const f=await createMiningTermFixture({day:'2035-01-01',round:3n,programId:Keypair.generate().publicKey,genesisHash:Keypair.generate().publicKey});
  const {round:ignored,...policy}=f.policy;void ignored;
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2035-01-02T00:00:00.000Z'));
  await expect(prefetchHistoricalShardsTermAt(f.connect,policy,'2034-12-31T23:59:59.999Z')).rejects.toThrow();
  const result=await prefetchHistoricalShardsTermAt(f.connect,policy,'2035-01-01T00:00:00.000Z');
  expect(result.snapshot.source.round).toBe('3');expect(result.completedAt).toBe('2035-01-01T00:00:00.000Z');
 });
 it('uses the actual finalized Clock to reject even one future millisecond rather than trusting observedAt',async()=>{
  const f=await fixture(),clock=f.startsAt+grace+1n;
  f.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(clock,32);
  await expect(prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,new Date(Number(clock)*1000+1).toISOString())).rejects.toThrow();
  expect((await prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,iso(clock))).snapshot.source.round).toBe('7');
 });
 it('rechecks actual Clock after the full verifier awaits settlement proof',async()=>{
  const f=await fixture(),get=f.rpc.getTransaction;let changed=false;
  const rpc:SeekerTermRpc={...f.rpc,getTransaction:(async(signature:string)=>{
   changed=true;f.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(f.startsAt+grace,32);
   return get(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  }) as SeekerTermRpc['getTransaction']};
  await expect(prefetchHistoricalShardsTermAt(()=>rpc,f.sourcePolicy,iso(f.startsAt+grace+1n))).rejects.toThrow();expect(changed).toBe(true);
 });
 it.each(['missing original term','missing original auction','invalid original signature'] as const)(
  'holds %s even though a complete newer term is available on the same config',async missing=>{
   const f=await pair();
   if(missing==='missing original term')f.store.delete(seekerTermPda(f.policy.programId,f.policy.config,7n).toBase58());
   if(missing==='missing original auction')f.store.delete(seekerAuctionPda(f.policy.programId,f.policy.config,0,7n).toBase58());
   if(missing==='invalid original signature')[...f.bodies.values()][0]!.transaction.signatures[0]=Keypair.generate().publicKey.toBase58();
   await expect(prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,iso(f.startsAt+grace+1n))).rejects.toThrow();
   expect((await prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,iso(f.nextStarts+grace+1n))).snapshot.source.round).toBe('8');
  });
 it('authenticates every unsold auction before preserving a known-zero historical result',async()=>{
  const f=await fixture(4n,true),term=await prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,iso(f.startsAt+grace));
  expect(term.snapshot.spots).toHaveLength(PHASE_E_POLICY.seekerIsland.totalSpots);
  expect(term.snapshot.spots.every(spot=>spot.ownerWallet===null)).toBe(true);
  f.bodies.clear();await expect(prefetchHistoricalShardsTermAt(f.connect,f.sourcePolicy,iso(f.startsAt+grace))).rejects.toThrow();
 });
 it('does not authorize a real but wrong term selected by a forged first calendar hint',async()=>{
  const f=await pair(),hint=await createMiningTermFixture({day:iso(f.startsAt+grace).slice(0,10),round:8n,
   firstOperatingStart:first-BigInt(duration),programId:f.policy.programId,genesisHash:f.policy.genesisHash,
   mint:f.policy.mint,prizeOwner:f.policy.prizeOwner});
  const forged=hint.store.get(f.policy.config.toBase58())!.data;let hinted=false;
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,config)=>{
   const response=await f.rpc.getMultipleAccountsInfoAndContext(addresses,config);
   if(!hinted){const index=addresses.findIndex(address=>address.equals(f.policy.config));if(index>=0){
    hinted=true;response.value[index]={...response.value[index]!,data:Buffer.from(forged)};
   }}return response;
  }};
  await expect(prefetchHistoricalShardsTermAt(()=>rpc,f.sourcePolicy,iso(f.startsAt+grace+1n))).rejects.toThrow();expect(hinted).toBe(true);
 });
 it('rejects an immutable calendar changing during original settlement verification',async()=>{
  const f=await fixture(),get=f.rpc.getTransaction;let changed=false;
  const rpc:SeekerTermRpc={...f.rpc,getTransaction:(async(signature:string)=>{
   if(!changed){changed=true;const row=f.store.get(f.policy.config.toBase58())!;row.data[row.data.length-1]=row.data[row.data.length-1]!^1;}
   return get(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  }) as SeekerTermRpc['getTransaction']};
  await expect(prefetchHistoricalShardsTermAt(()=>rpc,f.sourcePolicy,iso(f.startsAt+grace+1n))).rejects.toThrow();expect(changed).toBe(true);
 });
 it('copies source key bytes and deployment pins before a suspended RPC discovery',async()=>{
  const f=await fixture(),keys=['programId','config','mint','prizeOwner','prizeAta','genesisHash'] as const;
  const policy={...f.sourcePolicy,...Object.fromEntries(keys.map(k=>[k,new PublicKey(f.sourcePolicy[k].toBytes())])),deployment:{...f.sourcePolicy.deployment}} as Omit<ReviewedSeekerTermPolicy,'round'>;
  let enter!:()=>void,release!:()=>void,firstRead=true;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const rpc:SeekerTermRpc={...f.rpc,getGenesisHash:async()=>{if(firstRead){firstRead=false;enter();await gate;}return f.rpc.getGenesisHash();}};
  const pending=prefetchHistoricalShardsTermAt(()=>rpc,policy,iso(f.startsAt+grace+1n));await entered;
  try{for(const k of keys){const words=(Reflect.get(policy[k],'_bn') as {words:number[]}).words;words[0]=words[0]!^1;}
   Reflect.set(policy.deployment,'programDataSha256','ab'.repeat(32));Reflect.set(policy,'stateProvenance','unreviewed-retained-state');
  }finally{release();}
  const result=await pending;expect(result.snapshot.source.programId).toBe(f.policy.programId.toBase58());
  expect(result.deployment.programDataSha256).toBe(f.policy.deployment.programDataSha256);expect(result.snapshot.source.round).toBe('7');
 });
 it('bounds stalled discovery and aborts the supplied transport',async()=>{
  const f=await fixture();let signal:AbortSignal|undefined;
  await expect(prefetchHistoricalShardsTermAt(s=>{signal=s;return {...f.rpc,getGenesisHash:()=>new Promise(()=>{})};},f.sourcePolicy,iso(f.startsAt),{deadlineMs:10})).rejects.toThrow();
  expect(signal?.aborted).toBe(true);
 });
 it('requires a canonical UTC millisecond earning instant before attempting discovery',async()=>{
  const f=await fixture(),connect=vi.fn(f.connect),valid=iso(f.startsAt);
  for(const invalid of [valid.replace('.000Z','Z'),valid.replace('Z','+00:00'),'2035-02-30T00:00:00.000Z'])
   await expect(prefetchHistoricalShardsTermAt(connect,f.sourcePolicy,invalid)).rejects.toThrow();
  expect(connect).not.toHaveBeenCalled();
 });
});
