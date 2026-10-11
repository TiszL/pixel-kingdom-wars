/** Dedicated typed Charter issuer transport. No retries, renewal, Db or relay. */
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import type {CharterPolicyIssueRequest} from './charterPolicyIssuer';
import {charterIssuerReceipt,copyCharterIssuerAttempt,type CharterIssuerReceipt} from './charterPolicyIssuerJournal';
import {decodeCharterRegistrationPermit} from '@shardkeep/chain/charter-protocol';
import {encodeCharterPurposePermit} from '@shardkeep/chain/charter-transfer-protocol';
import {encodeCharterRetirementPermit} from '@shardkeep/chain/charter-retirement-protocol';
import {decodeSeekerActionPermit} from '@shardkeep/chain/seeker-auction-protocol';
import {SeekerWithdrawPrepareRequestSchema} from '@shardkeep/shared/seekerAuctionApi';

export const CHARTER_ISSUER_HTTP=Object.freeze({issuePath:'/v1/charters/issue',lookupPath:'/v1/charters/lookup',requestBytes:2048,responseBytes:4096,timeoutMs:30_000} as const);
const uuid=z.uuid().refine(value=>value===value.toLowerCase());
const key=z.string().refine(value=>{try{const parsed=new PublicKey(value);return parsed.toBase58()===value&&!parsed.equals(PublicKey.default);}catch{return false;}});
const hexMessage=z.string().regex(/^[0-9a-f]{322}$/);
const originalWireRequest=z.object({kind:z.enum(['charter-registration-v1','charter-transfer-v1','charter-lock-v1','charter-retirement-v1']),requestId:uuid,messageHex:hexMessage}).strict();
export const CharterIssuerWireRequest=z.union([originalWireRequest,originalWireRequest.extend({kind:z.literal('seeker-auction-open-v1'),auction:SeekerWithdrawPrepareRequestSchema}).strict()]);
export const CharterIssuerWireLookup=z.object({requestId:uuid}).strict();
const wireReceipt=z.object({requestId:uuid,publicKey:key,messageHex:hexMessage,signatureHex:z.string().regex(/^[0-9a-f]{128}$/)}).strict();
export class CharterIssuerTransportError extends Error {constructor(){super('Charter issuer transport unavailable');this.name='CharterIssuerTransportError';}}
export function charterIssuerAuthToken(value:string){if(typeof value!=='string'||!/^[\x21-\x7e]{32,512}$/.test(value))throw new CharterIssuerTransportError();return value;}
export function charterIssuerHttpTimeout(value:number){if(!Number.isSafeInteger(value)||value<=0||value>CHARTER_ISSUER_HTTP.timeoutMs)throw new CharterIssuerTransportError();return value;}
export function decodeCharterIssuerWireRequest(value:unknown):CharterPolicyIssueRequest{
 const wire=CharterIssuerWireRequest.parse(value),message=Buffer.from(wire.messageHex,'hex'),nativeKind=wire.kind==='charter-registration-v1'?5:wire.kind==='charter-transfer-v1'?1:wire.kind==='charter-lock-v1'?6:wire.kind==='seeker-auction-open-v1'?7:9;
 if(message[72]!==nativeKind)throw new CharterIssuerTransportError();
 if(nativeKind===5)decodeCharterRegistrationPermit(message);
 else if(nativeKind===7){if(decodeSeekerActionPermit(message).kind!==7)throw new CharterIssuerTransportError();}
 else if(nativeKind===9){if(!encodeCharterRetirementPermit(new PublicKey(message.subarray(8,40)),new PublicKey(message.subarray(40,72)),new PublicKey(message.subarray(89,121)),
  {permitId:message.subarray(73,89),expiry:message.readBigInt64LE(121)},message.subarray(129)).equals(message))throw new CharterIssuerTransportError();}
 else if(!encodeCharterPurposePermit(new PublicKey(message.subarray(8,40)),new PublicKey(message.subarray(40,72)),nativeKind,new PublicKey(message.subarray(89,121)),
  {permitId:message.subarray(73,89),expiry:message.readBigInt64LE(121)},message.subarray(129)).equals(message))throw new CharterIssuerTransportError();
 return {kind:wire.kind,requestId:wire.requestId,message,...('auction'in wire?{auction:wire.auction}:{})};
}
function inspect(messageHex:string,requestId:string,publicKey:string){
 const bytes=Buffer.from(messageHex,'hex'),kind=bytes[72]===5?'charter-registration-v1':bytes[72]===1?'charter-transfer-v1':bytes[72]===6?'charter-lock-v1':bytes[72]===9?'charter-retirement-v1':bytes[72]===7?'seeker-auction-open-v1':null;
 if(!kind)throw new CharterIssuerTransportError();
 // Receipts contain the original signed message, not untrusted target metadata.
 // Fresh issuance binds the metadata; journal recovery checks its saved target.
 if(kind==='seeker-auction-open-v1'){if(decodeSeekerActionPermit(bytes).kind!==7)throw new CharterIssuerTransportError();return {kind,requestId,publicKey,messageHex} as const;}
 return copyCharterIssuerAttempt({kind,requestId,publicKey,messageHex},{genesisHash:new PublicKey(bytes.subarray(8,40)).toBase58(),economyProgram:new PublicKey(bytes.subarray(40,72)).toBase58()}).attempt;
}
/** Shared exact wire boundary; signature verification remains real Ed25519. */
export function decodeCharterIssuerWireReceipt(value:unknown,requestId:string):CharterIssuerReceipt{
 const parsed=wireReceipt.parse(value);if(parsed.requestId!==requestId)throw new CharterIssuerTransportError();
 const attempt=inspect(parsed.messageHex,parsed.requestId,parsed.publicKey);return charterIssuerReceipt({attempt,signatureHex:parsed.signatureHex})!;
}
export function encodeCharterIssuerWireReceipt(receipt:CharterIssuerReceipt,requestId:string){
 if(!(receipt.message instanceof Uint8Array)||receipt.message.byteLength!==161||!(receipt.signature instanceof Uint8Array)||receipt.signature.byteLength!==64)throw new CharterIssuerTransportError();
 const result=wireReceipt.parse({requestId:receipt.requestId,publicKey:receipt.publicKey,messageHex:Buffer.from(receipt.message).toString('hex'),signatureHex:Buffer.from(receipt.signature).toString('hex')});
 decodeCharterIssuerWireReceipt(result,requestId);return result;
}
export interface CharterPolicyIssuerClientOptions {
 readonly endpoint:string;readonly authToken:string;readonly currentPublicKey:string;
 readonly allowPrivateHttp?:boolean;readonly timeoutMs?:number;
}
export function createCharterPolicyIssuerClient(options:CharterPolicyIssuerClientOptions){
 const token=charterIssuerAuthToken(options.authToken),currentPublicKey=key.parse(options.currentPublicKey),timeout=charterIssuerHttpTimeout(options.timeoutMs??CHARTER_ISSUER_HTTP.timeoutMs);
 let url:URL;try{url=new URL(options.endpoint);}catch{throw new CharterIssuerTransportError();}const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase());
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['http:','https:'].includes(url.protocol)
  ||url.protocol==='http:'&&!(options.allowPrivateHttp===true&&(loopback||url.origin==='http://charter-issuer:3004')))throw new CharterIssuerTransportError();
 const origin=url.origin,lifetime=new AbortController();
 async function request(path:string,body:object,caller:AbortSignal):Promise<unknown>{
  try{
   const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>CHARTER_ISSUER_HTTP.requestBytes)throw new CharterIssuerTransportError();
   const signal=AbortSignal.any([caller,lifetime.signal,AbortSignal.timeout(timeout)]);signal.throwIfAborted();
   const response=await fetch(origin+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:encoded,signal,redirect:'error'});
   if(response.status!==200||!response.body||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel().catch(()=>{});throw new CharterIssuerTransportError();}
   const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
   try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>CHARTER_ISSUER_HTTP.responseBytes)throw new CharterIssuerTransportError();chunks.push(part.value);}}
   catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
   signal.throwIfAborted();return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw new CharterIssuerTransportError();}
 }
 async function issueOnce(input:CharterPolicyIssueRequest,signal:AbortSignal):Promise<CharterIssuerReceipt>{
  try{
   if(!input||Reflect.ownKeys(input).sort().join(' ')!==(input.kind==='seeker-auction-open-v1'?'auction kind message requestId':'kind message requestId')||!(input.message instanceof Uint8Array))throw new CharterIssuerTransportError();
   const wire=CharterIssuerWireRequest.parse({kind:input.kind,requestId:input.requestId,messageHex:Buffer.from(input.message).toString('hex'),
    ...(input.kind==='seeker-auction-open-v1'?{auction:input.auction}:{})});
   decodeCharterIssuerWireRequest(wire);
   const receipt=decodeCharterIssuerWireReceipt(await request(CHARTER_ISSUER_HTTP.issuePath,wire,signal),wire.requestId);
   if(receipt.publicKey!==currentPublicKey||Buffer.from(receipt.message).toString('hex')!==wire.messageHex)throw new CharterIssuerTransportError();return receipt;
  }catch{throw new CharterIssuerTransportError();}
 }
 async function lookup(id:string,signal:AbortSignal):Promise<CharterIssuerReceipt|null>{
  try{const wire=CharterIssuerWireLookup.parse({requestId:id}),value=await request(CHARTER_ISSUER_HTTP.lookupPath,wire,signal);return value===null?null:decodeCharterIssuerWireReceipt(value,wire.requestId);}
  catch{throw new CharterIssuerTransportError();}
 }
 return Object.freeze({issueOnce,lookup,close:()=>lifetime.abort()});
}
