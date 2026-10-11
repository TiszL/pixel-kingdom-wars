/** Actual account and signature verification; transport evidence is injected. */
import {Keypair} from '@solana/web3.js';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {describe,expect,it,vi} from 'vitest';
import {readFinalizedHistoricalSeekerTermAt,type SeekerTermRpc} from './seekerTerms';
import {createMiningTermFixture} from './testFixtures/miningZeroWinnerTerm';
const earnedAt=BigInt(Date.parse('2035-01-01T00:00:00.000Z'));
const fixture=()=>createMiningTermFixture({day:'2035-01-01',programId:Keypair.generate().publicKey,genesisHash:Keypair.generate().publicKey});

describe('one bounded historical calendar discovery and verification attempt',()=>{
 it('carries the preliminary finalized context floor into the complete verifier',async()=>{
  const f=await fixture(),reads:number[]=[],rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   expect(options).toMatchObject({commitment:'finalized'});
   reads.push(typeof options==='object'?options.minContextSlot??-1:-1);
   const response=await f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
   return {...response,context:{slot:2000+reads.length}};
  }};
  await readFinalizedHistoricalSeekerTermAt(()=>rpc,f.policy,earnedAt);
  expect(reads).toEqual([0,2001,2002,2003,2004]);
 });
 it('refuses a regressing core bank after discovery instead of restarting at a lower slot',async()=>{
  const f=await fixture();let reads=0;
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   const result=await f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
   if(reads++>0){expect(options).toMatchObject({minContextSlot:2000});result.context.slot=1999;}
   return result;
  }};
  await expect(readFinalizedHistoricalSeekerTermAt(()=>rpc,f.policy,earnedAt)).rejects.toThrow();expect(reads).toBe(2);
 });
 it.each(['discovery','verification'] as const)('cancels a stalled %s read with the same connection and deadline',async stage=>{
  const f=await fixture();let reads=0,signal:AbortSignal|undefined;
  const rpc:SeekerTermRpc={...f.rpc,getMultipleAccountsInfoAndContext:async(addresses,options)=>{
   reads++;if(reads===(stage==='discovery'?1:3))return new Promise(()=>{});
   return f.rpc.getMultipleAccountsInfoAndContext(addresses,options);
  }};
  const connect=vi.fn((value:AbortSignal)=>{signal=value;return rpc;});
  await expect(readFinalizedHistoricalSeekerTermAt(connect,f.policy,earnedAt,{deadlineMs:10})).rejects.toThrow();
  expect(connect).toHaveBeenCalledTimes(1);expect(signal!.aborted).toBe(true);expect(reads).toBe(stage==='discovery'?1:3);
 });
 it('copies supplied settlement hints before awaiting discovery without treating hints as proof',async()=>{
  const f=await fixture(),hints=new Map([...f.bodies.keys()].map((signature,index)=>[index,signature]));
  const getSignaturesForAddress=vi.fn(f.rpc.getSignaturesForAddress);
  let enter!:()=>void,release!:()=>void,first=true;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const rpc:SeekerTermRpc={...f.rpc,getSignaturesForAddress,getGenesisHash:async()=>{
   if(first){first=false;enter();await gate;}return f.rpc.getGenesisHash();
  }};
  const pending=readFinalizedHistoricalSeekerTermAt(()=>rpc,f.policy,earnedAt,{settlementSignatures:hints});
  await entered;hints.clear();hints.set(0,'invalid');release();
  const result=await pending;expect(result.auctions).toHaveLength(PHASE_E_POLICY.seekerIsland.totalSpots);expect(getSignaturesForAddress).not.toHaveBeenCalled();
  await expect(readFinalizedHistoricalSeekerTermAt(f.connect,f.policy,earnedAt,{settlementSignatures:hints})).rejects.toThrow();
 });
});
