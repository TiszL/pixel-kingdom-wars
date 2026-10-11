/** Genuine current account/settlement verification against injected finalized RPC.
 * The config calendar discovers only a candidate, never a replacement authority. */
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {describe,expect,it,vi} from 'vitest';
import {readFinalizedCurrentSeekerTerm,type ReviewedSeekerSourcePolicy,type SeekerTermRpc} from './seekerTerms';
import {seekerAuctionPda} from './seekerAuctionProtocol';
import {createMiningTermFixture} from './testFixtures/miningZeroWinnerTerm';
const day='2035-01-01',key=()=>Keypair.generate().publicKey;
async function fixture(round=7n){
 const winner=key(),f=await createMiningTermFixture({day,round,programId:key(),genesisHash:key(),winners:[{spotId:0,wallet:winner}]});
 const {round:ignored,...source}=f.policy;void ignored;
 return {...f,source,winner};
}
function end(f:Awaited<ReturnType<typeof fixture>>){const config=f.store.get(f.policy.config.toBase58())!.data;return config.readBigInt64LE(246)+(f.policy.round+1n)*BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec);}

describe('current round discovery preserves complete current-term authority',()=>{
 it.each([0n,7n])('discovers round%s from finalized Clock and verifies all original winning and zero rows',async round=>{
  const f=await fixture(round),reads:number[]=[],addressesSeen:string[][]=[];
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   expect(options).toMatchObject({commitment:'finalized'});reads.push(typeof options==='object'?options.minContextSlot??-1:-1);
   addressesSeen.push(addresses.map(k=>k.toBase58()));const response=await f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
   return {...response,context:{slot:2000+reads.length}};
  }};
  const result=await readFinalizedCurrentSeekerTerm(()=>rpc,f.source);
  expect(addressesSeen[0]).toEqual([f.source.config.toBase58(),SYSVAR_CLOCK_PUBKEY.toBase58()]);
  expect(reads).toEqual([0,2001,2002,2003,2004]);expect(result.source.round).toBe(round);
  expect(result.auctions).toHaveLength(PHASE_E_POLICY.seekerIsland.totalSpots);expect(result.auctions[0]!.winner).toBe(f.winner.toBase58());
  expect(result.auctions.slice(1).every(a=>a.winner===null)).toBe(true);
  expect(result).not.toHaveProperty('operatingAdmissionAuthorized',false);
  expect(Object.isFrozen(result)&&Object.isFrozen(result.auctions)&&Object.isFrozen(result.finality)).toBe(true);
 });
 it.each(['owner','executable','layout','slot','time'] as const)('refuses malformed discovery Clock %s before selecting accounts',async bad=>{
  const f=await fixture(),clock=f.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!;
  if(bad==='owner')clock.owner=key();if(bad==='executable')clock.executable=true;if(bad==='layout')clock.data=Buffer.alloc(39);
  if(bad==='slot')clock.data.writeBigUInt64LE(2001n);if(bad==='time')clock.data.writeBigInt64LE(-1n,32);
  const read=vi.fn(f.rpc.getMultipleAccountsInfoAndContext);
  await expect(readFinalizedCurrentSeekerTerm(()=>({...f.rpc,getMultipleAccountsInfoAndContext:read}),f.source)).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
 });
 it('does not lower the discovery context floor for the complete verifier',async()=>{
  const f=await fixture();let reads=0;
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   const result=await f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
   if(reads++>0){expect(options).toMatchObject({minContextSlot:2000});result.context.slot=1999;}return result;
  }};
  await expect(readFinalizedCurrentSeekerTerm(()=>rpc,f.source)).rejects.toThrow();expect(reads).toBe(2);
 });
 it('refuses an immutable calendar change after selecting its candidate',async()=>{
  const f=await fixture();let reads=0;
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   const result=await f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
   if(reads++===1){const data=result.value[3]!.data;data[0]=data[0]!^1;}return result;
  }};
  await expect(readFinalizedCurrentSeekerTerm(()=>rpc,f.source)).rejects.toThrow();expect(reads).toBe(2);
 });
 it.each([1,3,4])('refuses rollover at read%s without falling back to expired settlement authority',async rolloverRead=>{
  const f=await fixture();let reads=0;
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   const result=await f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
   if(reads++>=rolloverRead){const index=addresses.findIndex(k=>k.equals(SYSVAR_CLOCK_PUBKEY));if(index>=0)result.value[index]!.data.writeBigInt64LE(end(f),32);}return result;
  }};
  await expect(readFinalizedCurrentSeekerTerm(()=>rpc,f.source)).rejects.toThrow();
 });
 it.each(['missing candidate','missing auction','failed settlement'] as const)('never fabricates known zero for %s',async bad=>{
  const f=await fixture();
  if(bad==='missing candidate')f.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(end(f),32);
  if(bad==='missing auction')f.store.delete(seekerAuctionPda(f.policy.programId,f.policy.config,1,f.policy.round).toBase58());
  if(bad==='failed settlement')f.bodies.values().next().value!.meta!.err={InstructionError:[0,'InvalidArgument']};
  await expect(readFinalizedCurrentSeekerTerm(f.connect,f.source)).rejects.toThrow();
 });
 it.each(['discovery','verification'] as const)('uses one abortable connection and deadline for stalled %s',async stage=>{
  const f=await fixture();let reads=0,signal:AbortSignal|undefined;
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   if(++reads===(stage==='discovery'?1:3))return new Promise(()=>{});return f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
  }};
  const connect=vi.fn((value:AbortSignal)=>{signal=value;return rpc;});
  await expect(readFinalizedCurrentSeekerTerm(connect,f.source,{deadlineMs:10})).rejects.toThrow();
  expect(connect).toHaveBeenCalledTimes(1);expect(signal!.aborted).toBe(true);expect(reads).toBe(stage==='discovery'?1:3);
 });
 it('copies source pins and hints before the first await and does not accept a caller fixed round',async()=>{
  const f=await fixture(),policy={...f.source,deployment:{...f.source.deployment},round:999n},hints=new Map([...f.bodies.keys()].map((s,i)=>[i,s]));
  let enter!:()=>void,release!:()=>void,first=true;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
  const history=vi.fn(f.rpc.getSignaturesForAddress),rpc:SeekerTermRpc={...f.rpc,getSignaturesForAddress:history,getGenesisHash:async()=>{if(first){first=false;enter();await gate;}return f.rpc.getGenesisHash();}};
  const pending=readFinalizedCurrentSeekerTerm(()=>rpc,policy,{settlementSignatures:hints});
  await entered;policy.config=new PublicKey(key().toBytes());policy.deployment.programDataSha256='00'.repeat(32);hints.clear();release();
  expect((await pending).source.round).toBe(7n);expect(history).not.toHaveBeenCalled();
  await expect(readFinalizedCurrentSeekerTerm(f.connect,policy as ReviewedSeekerSourcePolicy)).rejects.toThrow();
 });
});
