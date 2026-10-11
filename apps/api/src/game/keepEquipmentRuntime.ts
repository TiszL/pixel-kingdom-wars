/** Process-owned KEEP payment sources. Distinct operator-reviewed provider
 * identities are required; URL differences alone never prove independence. */
import {Connection,PublicKey} from '@solana/web3.js';
import {createKeepEquipmentPaymentPreparationReader,type KeepEquipmentPaymentPreparationRpc,type KeepEquipmentPaymentPreparationTrust} from '@shardkeep/chain/keep-equipment-payment-preparation';
import type {KeepEquipmentPaymentRpc} from '@shardkeep/chain/keep-equipment-payment';
import {resolveSolanaRpcUrl} from '../config';
import type {KeepEquipmentPaymentDependencies} from './keepEquipmentPayments';
import type {KeepEquipmentReleaseDependencies} from './keepEquipmentReleases';

export interface KeepEquipmentRuntimeConfiguration {
 readonly trust:KeepEquipmentPaymentPreparationTrust;
 readonly readRpcUrls:readonly[string,string];
 readonly readProviders:readonly[string,string];
 readonly broadcastRpcUrl?:string;
 readonly nodeEnv?:'production'|'development'|'test';
}
export interface KeepEquipmentRuntimeSources {
 readonly payments:Omit<KeepEquipmentPaymentDependencies,'assertAdmission'>;
 readonly releases:KeepEquipmentReleaseDependencies;
}
// Operational response limit: four small SPL accounts or one bounded payment
// transaction. This rail reads no ProgramData/large block history.
const MAX_BYTES=1024*1024,TIMEOUT_MS=30_000;
export function createKeepEquipmentRuntime(input?:KeepEquipmentRuntimeConfiguration|null){
 if(input==null)return null;
 const policy=input.trust;
 if(!policy||!Array.isArray(input.readRpcUrls)||input.readRpcUrls.length!==2||!Array.isArray(input.readProviders)||input.readProviders.length!==2||!Array.isArray(policy.providerIds)||policy.providerIds.length!==2)throw Error('KEEP market requires complete independent source trust');
 const address=(value:string)=>{const key=new PublicKey(value);if(key.equals(PublicKey.default)||key.toBase58()!==value)throw Error('Invalid KEEP market identity');return key.toBase58();};
 const trust:KeepEquipmentPaymentPreparationTrust=Object.freeze({expectedGenesisHash:address(policy.expectedGenesisHash),expectedKeepMint:address(policy.expectedKeepMint),
  providerIds:Object.freeze([...policy.providerIds]) as readonly[string,string],minContextSlot:policy.minContextSlot,deadlineMs:policy.deadlineMs,transactionVersion:policy.transactionVersion,
  maxFeeLamports:policy.maxFeeLamports,maxPriorityFeeLamports:policy.maxPriorityFeeLamports,maxComputeUnitLimit:policy.maxComputeUnitLimit});
 if(trust.providerIds.some((id,index)=>typeof id!=='string'||id.trim()!==id||id.length===0||id!==input.readProviders[index])||trust.providerIds[0]===trust.providerIds[1])throw Error('KEEP market requires distinct reviewed provider identities');
 const endpoint=(value:string)=>{
  if(typeof value!=='string'||!value.trim())throw Error('KEEP market requires explicit RPC URLs');
  const url=new URL(resolveSolanaRpcUrl(value,input.nodeEnv??'production'));
  if(url.username||url.password)throw Error('KEEP market RPC URLs cannot contain user credentials');
  url.hostname=url.hostname.toLowerCase().replace(/\.$/,'');return url;
 };
 const urls=input.readRpcUrls.map(endpoint),loopback=(url:URL)=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(urls[0]!.href===urls[1]!.href||urls[0]!.hostname===urls[1]!.hostname&&!(['test','development'].includes(input.nodeEnv??'production')&&urls.every(loopback)))throw Error('KEEP market readers require distinct endpoints');
 const readUrls=urls.map(url=>url.href),broadcastUrl=input.broadcastRpcUrl===undefined?null:endpoint(input.broadcastRpcUrl).href,lifetime=new AbortController();
 function connection(url:string,caller:AbortSignal){
  const signal=AbortSignal.any([caller,lifetime.signal,AbortSignal.timeout(Math.min(trust.deadlineMs,TIMEOUT_MS))]);signal.throwIfAborted();
  const rpc=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(request,init)=>{
   signal.throwIfAborted();const response=await fetch(request,{...init,signal,redirect:'error'});
   if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw Error('KEEP market RPC unavailable');}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
   try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>MAX_BYTES)throw Error('KEEP market RPC exceeds work bound');chunks.push(next.value);}}
   catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   signal.throwIfAborted();const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
   return new Response(Buffer.concat(chunks),{status:response.status,headers});
  }});
  const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{signal.throwIfAborted();const result=await operation();signal.throwIfAborted();return result;};
  return {rpc,read};
 }
 const preparationConnect=Object.freeze(readUrls.map(url=>(signal:AbortSignal):KeepEquipmentPaymentPreparationRpc=>{
  const {rpc,read}=connection(url,signal);
  return Object.freeze<KeepEquipmentPaymentPreparationRpc>({getGenesisHash:()=>read(()=>rpc.getGenesisHash()),getSlot:commitment=>read(()=>rpc.getSlot(commitment)),
   getMultipleAccountsInfoAndContext:(keys,options)=>{const addresses=keys.map(key=>new PublicKey(key.toBytes())),settings={...options};return read(()=>rpc.getMultipleAccountsInfoAndContext(addresses,settings));},
   getMinimumBalanceForRentExemption:(bytes,commitment)=>read(()=>rpc.getMinimumBalanceForRentExemption(bytes,commitment)),
   getLatestBlockhashAndContext:options=>read(()=>rpc.getLatestBlockhashAndContext({...options})),
   getFeeForMessage:(message,commitment)=>read(()=>rpc.getFeeForMessage(message,commitment)),
   isBlockhashValid:(hash,options)=>read(()=>rpc.isBlockhashValid(hash,{...options})),getBlockHeight:options=>read(()=>rpc.getBlockHeight({...options})),
  });
 })) as readonly[(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc,(signal:AbortSignal)=>KeepEquipmentPaymentPreparationRpc];
 // Reuse the canonical complete trust validation before exposing any connector;
 // construction performs no RPC and grants no signing or payment authority.
 createKeepEquipmentPaymentPreparationReader(preparationConnect,trust);
 const finalityConnect=Object.freeze(readUrls.map(url=>(signal:AbortSignal):KeepEquipmentPaymentRpc=>{
  const {rpc,read}=connection(url,signal);return Object.freeze<KeepEquipmentPaymentRpc>({getGenesisHash:()=>read(()=>rpc.getGenesisHash()),getSlot:commitment=>read(()=>rpc.getSlot(commitment)),
   getTransaction:(signature,options)=>read(()=>rpc.getTransaction(signature,{...options})),});
 })) as readonly[(signal:AbortSignal)=>KeepEquipmentPaymentRpc,(signal:AbortSignal)=>KeepEquipmentPaymentRpc];
 const broadcastConnect:KeepEquipmentPaymentDependencies['broadcastConnect']=broadcastUrl===null?undefined:(signal)=>{
  const {rpc,read}=connection(broadcastUrl,signal);return Object.freeze({getGenesisHash:()=>read(()=>rpc.getGenesisHash()),getSlot:commitment=>read(()=>rpc.getSlot(commitment)),
   sendRawTransaction:(bytes,options)=>{
    if(!(bytes instanceof Uint8Array)||bytes.length>1232||options.skipPreflight!==false||options.preflightCommitment!=='finalized'||options.maxRetries!==0||!Number.isSafeInteger(options.minContextSlot)||options.minContextSlot<trust.minContextSlot)throw Error('KEEP market relay requires bounded original bytes and finalized preflight');
    const wire=Uint8Array.from(bytes),settings={...options};return read(()=>rpc.sendRawTransaction(wire,settings));
   },
  });
 };
 const sources:KeepEquipmentRuntimeSources=Object.freeze({payments:Object.freeze({trust,preparationConnect,finalityConnect,...(broadcastConnect?{broadcastConnect}:{})}),releases:Object.freeze({trust,failureConnect:finalityConnect})});
 return Object.freeze({sources,close:()=>lifetime.abort()});
}
