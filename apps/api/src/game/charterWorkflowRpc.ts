/** Process-owned Charter transport. Existing validators own all policy/pins;
 * a separate explicit endpoint is required to relay retained wallet bytes. */
import {Connection,MessageV0,PublicKey} from '@solana/web3.js';
import type {CharterCreationEvidenceRpc} from '@shardkeep/chain/charter-creation-evidence';
import type {CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import type {CharterTransferRpc} from '@shardkeep/chain/charter-transfer-evidence';
import type {CharterClientDeliveryRpc} from './clanCharterClientDelivery';
import {resolveSolanaRpcUrl} from '../config';

export interface CharterWorkflowRpcOptions {
 readonly readRpcUrl:string;readonly relayRpcUrl?:string;
 readonly nodeEnv?:'production'|'development'|'test';readonly timeoutMs?:number;
}
// Three reviewed ProgramData accounts can each contain8MiB before base64.
// These are operational response/deadline bounds, never gameplay values.
const MAX_BYTES=36*1024*1024,MAX_TIMEOUT_MS=30_000;
export function createCharterWorkflowRpc(input:CharterWorkflowRpcOptions){
 const endpoint=(value:string)=>{if(typeof value!=='string'||!value.trim())throw Error('Charter RPC requires an explicit endpoint');
  const url=new URL(resolveSolanaRpcUrl(value,input.nodeEnv??'production'));if(url.username||url.password)throw Error('Charter RPC credentials must not be URL userinfo');return url.href;};
 const readUrl=endpoint(input.readRpcUrl),relayUrl=input.relayRpcUrl===undefined?null:endpoint(input.relayRpcUrl),timeout=input.timeoutMs??MAX_TIMEOUT_MS,lifetime=new AbortController();
 if(!Number.isSafeInteger(timeout)||timeout<=0||timeout>MAX_TIMEOUT_MS)throw Error('Invalid Charter RPC deadline');
 const scope=(caller:AbortSignal)=>{const signal=AbortSignal.any([caller,lifetime.signal,AbortSignal.timeout(timeout)]);signal.throwIfAborted();return signal;};
 function connection(url:string,signal:AbortSignal){
  signal.throwIfAborted();const rpc=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(request,init)=>{
   signal.throwIfAborted();const response=await fetch(request,{...init,signal,redirect:'error'});
   if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw Error('Charter RPC unavailable');}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
   try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BYTES)throw Error('Charter RPC response exceeds bound');chunks.push(part.value);}}
   catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   signal.throwIfAborted();const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
   return new Response(Buffer.concat(chunks),{status:response.status,headers});
  }});
  const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{signal.throwIfAborted();const value=await operation();signal.throwIfAborted();return value;};
  const bank=Object.freeze<CharterCreationEvidenceRpc>({getGenesisHash:()=>read(()=>rpc.getGenesisHash()),getSlot:commitment=>read(()=>rpc.getSlot(commitment)),
   getMultipleAccountsInfoAndContext:(addresses,options)=>{const keys=addresses.map(key=>new PublicKey(key.toBytes())),settings={...options};return read(async()=>{
    const result=await rpc.getMultipleAccountsInfoAndContext(keys,settings);return {context:{slot:result.context.slot},value:result.value.map((row,index)=>row?{
     address:keys[index]!,owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)}:null)};
   });},
  });
  const quote=Object.freeze<CharterCreationQuoteRpc>({...bank,
   getAccountInfoAndContext:(address,options)=>{const key=new PublicKey(address.toBytes()),settings={...options};return read(async()=>{
    const result=await rpc.getAccountInfoAndContext(key,settings);return {context:{slot:result.context.slot},value:result.value?{
     owner:new PublicKey(result.value.owner.toBytes()),executable:result.value.executable,data:Buffer.from(result.value.data)}:null};
   });},
   getLatestBlockhashAndContext:options=>{const settings={...options};return read(()=>rpc.getLatestBlockhashAndContext(settings));},
   getFeeForMessage:(message,commitment)=>{const copied=MessageV0.deserialize(message.serialize());return read(()=>rpc.getFeeForMessage(copied,commitment));},
   getMinimumBalanceForRentExemption:(bytes,commitment)=>read(()=>rpc.getMinimumBalanceForRentExemption(bytes,commitment)),
   getBlockHeight:options=>{const settings={...options};return read(()=>rpc.getBlockHeight(settings));},
  });
  return {rpc,read,bank,quote};
 }
 const quoteConnect=(caller:AbortSignal):CharterCreationQuoteRpc=>connection(readUrl,scope(caller)).quote;
 const recoveryConnect=(caller:AbortSignal):CharterTransferRpc=>{const {bank,rpc,read}=connection(readUrl,scope(caller));return Object.freeze<CharterTransferRpc>({...bank,
  getTransaction:(signature,options)=>{const settings={...options};return read(()=>rpc.getTransaction(signature,settings));},
 });};
 const deliveryConnect=relayUrl===null?undefined:(caller:AbortSignal):CharterClientDeliveryRpc=>{
  const signal=scope(caller),source=connection(readUrl,signal),relay=connection(relayUrl,signal);let verifiedGenesis:string|null=null;
  return Object.freeze<CharterClientDeliveryRpc>({...source.quote,
   getGenesisHash:async()=>{verifiedGenesis=null;const [readGenesis,relayGenesis]=await Promise.all([source.bank.getGenesisHash(),relay.bank.getGenesisHash()]);
    if(readGenesis!==relayGenesis)throw Error('Charter relay cluster mismatch');verifiedGenesis=readGenesis;return readGenesis;},
   getSignatureStatuses:(signatures,options)=>{const copied=[...signatures],settings={...options};return source.read(()=>source.rpc.getSignatureStatuses(copied,settings));},
   sendRawTransaction:(bytes,options)=>{
    if(verifiedGenesis===null||!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>1232||options.skipPreflight!==false||options.preflightCommitment!=='finalized'||options.maxRetries!==0||!Number.isSafeInteger(options.minContextSlot)||options.minContextSlot<0)throw Error('Charter relay requires checked cluster and retained wire');
    const wire=Uint8Array.from(bytes),genesis=verifiedGenesis;
    const settings:Parameters<CharterClientDeliveryRpc['sendRawTransaction']>[1]={skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:options.minContextSlot};
    return relay.read(async()=>{if(await relay.bank.getGenesisHash()!==genesis)throw Error('Charter relay cluster changed');signal.throwIfAborted();return relay.rpc.sendRawTransaction(wire,settings);});
   },
  });
 };
 return Object.freeze({quoteConnect,recoveryConnect,...(deliveryConnect?{deliveryConnect}:{}),close:()=>lifetime.abort()});
}
