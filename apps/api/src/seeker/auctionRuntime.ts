/** Reviewed deployment and registry pins. Construction reads no key material,
 * performs no RPC, and never starts a crank; the worker owns that capability. */
import { isAbsolute } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import type { Config } from '../config';
import type { SeekerAuctionReadSource } from './auctionReadModel';
const TIMEOUT_MS=30_000,MAX_RPC_BYTES=32*1024*1024;
/** Structural subset of the content pipeline P5's registry; the registry loader owns its schema. */
export interface SeekerAuctionRegistry {readonly cluster:string;readonly skrMint?:string;readonly skrDecimals?:number}
function need(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(`Seeker auction runtime: ${message}`);}
function address(value:string):string {const p=new PublicKey(value);need(p.toBase58()===value&&!p.equals(PublicKey.default),'invalid identity');return value;}
export function createSeekerAuctionRuntime(config:Config,registry:SeekerAuctionRegistry|null) {
 const pins=[config.SEEKER_AUCTION_PROGRAM_ID,config.SEEKER_AUCTION_DEPLOYMENT_SLOT,config.SEEKER_AUCTION_PROGRAM_DATA_SHA256,
  config.SEEKER_AUCTION_UPGRADE_AUTHORITY,config.SEEKER_AUCTION_MINT,config.SEEKER_AUCTION_PRIZE_OWNER,config.SEEKER_AUCTION_STATE_PROVENANCE];
 if(pins.every(v=>v===undefined)&&config.PHASE_E_SEEKER_AUCTION_ENABLED!=='true'&&config.SEEKER_AUCTION_CRANK_ENABLED!=='true')return null;
 need(pins.every(v=>v!==undefined),'complete reviewed pins required');
 need(registry&&registry.cluster===config.SOLANA_CLUSTER&&typeof registry.skrMint==='string'&&Number.isSafeInteger(registry.skrDecimals)
  &&registry.skrDecimals!>=0&&registry.skrDecimals!<=19,'complete registry SKR identity required');
 need(address(registry.skrMint)===address(config.SEEKER_AUCTION_MINT!),'mint differs from registry');
 need(Number.isSafeInteger(config.SEEKER_AUCTION_DEPLOYMENT_SLOT)&&config.SEEKER_AUCTION_DEPLOYMENT_SLOT!>=0
  &&/^[0-9a-f]{64}$/.test(config.SEEKER_AUCTION_PROGRAM_DATA_SHA256!)&&config.SEEKER_AUCTION_STATE_PROVENANCE==='fresh-reviewed-deployment','invalid deployment pins');
 if(config.SEEKER_AUCTION_CRANK_ENABLED==='true') {
  need(config.SEEKER_AUCTION_CRANK_PUBKEY&&config.SEEKER_AUCTION_CRANK_KEYPAIR_FILE&&isAbsolute(config.SEEKER_AUCTION_CRANK_KEYPAIR_FILE),'worker identity and absolute keypair-file path required');
  address(config.SEEKER_AUCTION_CRANK_PUBKEY);
 }
 const trust:SeekerAuctionReadSource['trust']=Object.freeze({programId:address(config.SEEKER_AUCTION_PROGRAM_ID!),
  genesisHash:SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER],mint:registry.skrMint,decimals:registry.skrDecimals!,
  prizeOwner:address(config.SEEKER_AUCTION_PRIZE_OWNER!),deploymentSlot:config.SEEKER_AUCTION_DEPLOYMENT_SLOT!,
  programDataSha256:config.SEEKER_AUCTION_PROGRAM_DATA_SHA256!,upgradeAuthority:config.SEEKER_AUCTION_UPGRADE_AUTHORITY==='none'?null:address(config.SEEKER_AUCTION_UPGRADE_AUTHORITY!),
  stateProvenance:'fresh-reviewed-deployment'});
 // K-night-08: an optional dedicated endpoint for this source only; unset keeps the primary.
 const endpoint=new URL(config.SEEKER_AUCTION_RPC_URL??config.SOLANA_RPC_URL);need(['http:','https:'].includes(endpoint.protocol)&&!endpoint.hash,'RPC endpoint');
 const url=endpoint.toString(),lifetime=new AbortController();
 const connect=(caller:AbortSignal)=>{
  const active=AbortSignal.any([caller,lifetime.signal]);active.throwIfAborted();
  return new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>{
   const signal=AbortSignal.any([active,AbortSignal.timeout(TIMEOUT_MS)]);signal.throwIfAborted();
   const response=await fetch(input,{...init,signal,redirect:'error'});
   if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw Error('Seeker auction RPC unavailable');}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;
    if(length>MAX_RPC_BYTES)throw Error('Seeker auction RPC exceeds work bound');chunks.push(chunk.value);}}
   catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
   signal.throwIfAborted();const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
   return new Response(Buffer.concat(chunks),{status:response.status,headers});
  }});
 };
 return Object.freeze({source:Object.freeze({connect,trust}),close:()=>lifetime.abort()});
}
