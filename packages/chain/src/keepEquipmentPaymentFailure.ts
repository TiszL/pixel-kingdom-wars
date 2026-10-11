/** Positive failure evidence for one immutable KEEP packet. Missing history,
 * expiry, logs or a rejected success proof never authorize release/replacement. */
import {createHash} from 'node:crypto';
import {Message,MessageV0,PACKET_DATA_SIZE,PublicKey,type VersionedTransactionResponse} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import bs58 from 'bs58';
import {buildKeepEquipmentPaymentMessage,type KeepEquipmentPaymentOriginal,type KeepEquipmentPaymentLimits} from './keepEquipmentPayment';
import type {KeepEquipmentPaymentPreparationTrust} from './keepEquipmentPaymentPreparation';
import type {KeepEquipmentPaymentCurrentInput} from './keepEquipmentPaymentCurrent';
import {verifyKeepEquipmentPaymentSignedWire} from './keepEquipmentPaymentWire';
import {isFailedSolanaExecution} from './solanaFailedExecution';

export interface KeepEquipmentPaymentFailureRpc {
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>;
}
export interface KeepEquipmentPaymentFailureInput extends KeepEquipmentPaymentCurrentInput {
 readonly signedTransaction:Uint8Array;readonly signature:string;readonly wireSha256:string;
}
export class KeepEquipmentPaymentFailureError extends Error {
 readonly paymentAuthorized=false;readonly signingAuthorized=false;readonly broadcastAuthorized=false;readonly deliveryAuthorized=false;
 readonly fenceReleaseAuthorized=false;readonly unpaidProven=false;
 constructor(readonly code:string){super(`KEEP payment failure observation held: ${code}`);this.name='KeepEquipmentPaymentFailureError';}
}
const U64=(1n<<64n)-1n;
function need(v:unknown,code:string):asserts v{if(!v)throw new KeepEquipmentPaymentFailureError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function address(v:unknown,code='INPUT'){need(typeof v==='string'&&v.length>=32&&v.length<=44,code);try{const k=new PublicKey(v);need(k.toBase58()===v,code);return k;}catch{throw new KeepEquipmentPaymentFailureError(code);}}
function fields(v:unknown,required:string,optional=''){
 need(v&&typeof v==='object'&&!Array.isArray(v),'INPUT');const names=required.split(' '),allowed=[...names,...optional.split(' ').filter(Boolean)];
 need(names.every(k=>Object.hasOwn(v,k))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&allowed.includes(k)),'INPUT');
}
function dense(v:unknown,max:number):v is unknown[]{return Array.isArray(v)&&v.length<=max&&Reflect.ownKeys(v).length===v.length+1&&Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean);}
function key(v:unknown){need(v instanceof PublicKey,'MESSAGE');const bytes=v.toBytes();need(bytes instanceof Uint8Array&&bytes.length===32,'MESSAGE');return new PublicKey(bytes);}
type FailedError=string|number|ReadonlyArray<FailedError>|{readonly[key:string]:FailedError};
function errorCopy(v:unknown,depth=0):FailedError {
 need(depth<=4,'FAILURE');if(typeof v==='string'){need(v.length<=256,'FAILURE');return v;}if(safe(v))return v;
 if(Array.isArray(v)){need(dense(v,2),'FAILURE');return Object.freeze(v.map(x=>errorCopy(x,depth+1)));}
 need(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===1,'FAILURE');const name=Reflect.ownKeys(v)[0];need(typeof name==='string'&&name.length<=64,'FAILURE');
 return Object.freeze({[name]:errorCopy((v as Record<string,unknown>)[name],depth+1)});
}
/** Rebuild a bounded RPC message without calling its serialize()/toJSON(). */
function ownedMessage(raw:VersionedTransactionResponse,intent:Uint8Array,version:'legacy'|0,signature:string){
 const m=raw.transaction.message;need(m&&m.version===version&&(raw.version===version||version==='legacy'&&raw.version===undefined),'MESSAGE');
 const keys=version==='legacy'?(m as Message).accountKeys:(m as MessageV0).staticAccountKeys;
 need(dense(keys,16)&&keys.length>0,'MESSAGE');const ownedKeys=keys.map(key),count=keys.length;
 need(new Set(ownedKeys.map(k=>k.toBase58())).size===count,'MESSAGE');
 const h=m.header;need(h&&h.numRequiredSignatures===1&&h.numReadonlySignedAccounts===0&&safe(h.numReadonlyUnsignedAccounts)&&h.numReadonlyUnsignedAccounts<count,'MESSAGE');
 const header={numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:h.numReadonlyUnsignedAccounts};
 const recentBlockhash=address(m.recentBlockhash,'MESSAGE').toBase58();let rebuilt:Message|MessageV0;
 const index=(v:unknown)=>{need(safe(v)&&v<count,'MESSAGE');return v;};
 if(version==='legacy'){
  const rows=(m as Message).instructions;need(dense(rows,4)&&rows.length>=3,'MESSAGE');
  const instructions=rows.map(ix=>{need(ix&&dense(ix.accounts,6)&&typeof ix.data==='string'&&ix.data.length<=176,'MESSAGE');const bytes=bs58.decode(ix.data);need(bytes.length<=128&&bs58.encode(bytes)===ix.data,'MESSAGE');return {programIdIndex:index(ix.programIdIndex),accounts:ix.accounts.map(index),data:ix.data};});
  rebuilt=new Message({header,accountKeys:ownedKeys,recentBlockhash,instructions});
 }else{
  const rows=(m as MessageV0).compiledInstructions;need(dense(rows,4)&&rows.length>=3&&dense((m as MessageV0).addressTableLookups,0),'MESSAGE');
  const compiledInstructions=rows.map(ix=>{need(ix&&dense(ix.accountKeyIndexes,6)&&ix.data instanceof Uint8Array&&ix.data.length<=128,'MESSAGE');return {programIdIndex:index(ix.programIdIndex),accountKeyIndexes:ix.accountKeyIndexes.map(index),data:Uint8Array.from(ix.data)};});
  rebuilt=new MessageV0({header,staticAccountKeys:ownedKeys,recentBlockhash,compiledInstructions,addressTableLookups:[]});
 }
 need(Buffer.from(rebuilt.serialize()).equals(Buffer.from(intent)),'MESSAGE');
 need(dense(raw.transaction.signatures,1)&&raw.transaction.signatures.length===1&&raw.transaction.signatures[0]===signature,'SIGNATURE');
 return {keys:Object.freeze(ownedKeys.map(k=>k.toBase58())),instructions:rebuilt.compiledInstructions.length};
}
function tokenRows(raw:unknown,keys:readonly string[],original:KeepEquipmentPaymentOriginal,buyerAta:string,sellerAta:string){
 need(dense(raw,2)&&raw.length>0,'TOKEN_BALANCE');const seen=new Set<number>();
 const rows=raw.map(value=>{
  need(value&&typeof value==='object','TOKEN_BALANCE');const r=value as NonNullable<NonNullable<VersionedTransactionResponse['meta']>['preTokenBalances']>[number];
  need(safe(r.accountIndex)&&r.accountIndex<keys.length&&!seen.has(r.accountIndex),'TOKEN_BALANCE');seen.add(r.accountIndex);
  const owner=keys[r.accountIndex]===buyerAta?original.buyer:keys[r.accountIndex]===sellerAta?original.seller:null;
  need(owner&&r.owner===owner&&r.mint===original.keepMint&&r.programId===TOKEN_PROGRAM_ID.toBase58(),'TOKEN_BALANCE');const u=r.uiTokenAmount;
  need(u&&u.decimals===TOKEN.decimals&&typeof u.amount==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(u.amount)&&BigInt(u.amount)<=U64,'TOKEN_BALANCE');
  return Object.freeze({accountIndex:r.accountIndex,mint:original.keepMint,owner,programId:TOKEN_PROGRAM_ID.toBase58(),decimals:TOKEN.decimals,amount:u.amount});
 }).sort((a,b)=>a.accountIndex-b.accountIndex);
 need(seen.has(keys.indexOf(buyerAta))&&(original.sellerAtaExists?seen.has(keys.indexOf(sellerAta)):true),'TOKEN_BALANCE');return Object.freeze(rows);
}
function failed(raw:VersionedTransactionResponse|null,intent:Uint8Array,version:'legacy'|0,signature:string,original:KeepEquipmentPaymentOriginal,buyerAta:string,sellerAta:string){
 need(raw&&raw.meta&&raw.transaction,'UNAVAILABLE');need(safe(raw.slot)&&raw.slot>0&&safe(raw.blockTime),'TRANSACTION');
 const {keys,instructions}=ownedMessage(raw,intent,version,signature),meta=raw.meta;
 need(isFailedSolanaExecution(meta.err,instructions,keys.length),'FAILURE');const error=errorCopy(meta.err);
 need(meta.loadedAddresses===undefined||meta.loadedAddresses&&dense(meta.loadedAddresses.writable,0)&&dense(meta.loadedAddresses.readonly,0),'LOOKUP');
 need(safe(meta.fee)&&dense(meta.preBalances,keys.length)&&dense(meta.postBalances,keys.length)&&meta.preBalances.length===keys.length&&meta.postBalances.length===keys.length&&meta.preBalances.every(safe)&&meta.postBalances.every(safe),'LAMPORTS');
 const before=Object.freeze([...meta.preBalances]),after=Object.freeze([...meta.postBalances]);
 need(before.every((n,i)=>BigInt(n)-BigInt(after[i]!)===(i===0?BigInt(meta.fee):0n)),'LAMPORTS');
 const tokens=meta.preTokenBalances===undefined&&meta.postTokenBalances===undefined?null:(()=>{
  const before=tokenRows(meta.preTokenBalances,keys,original,buyerAta,sellerAta),after=tokenRows(meta.postTokenBalances,keys,original,buyerAta,sellerAta);
  need(JSON.stringify(before)===JSON.stringify(after),'TOKEN_BALANCE');return before;
 })();
 // Actual historical fees can exceed the saved quote. Failure is a fee-only
 // rollback fact, never a successful-payment proof or fee-limit exception.
 const evidence=Object.freeze({slot:raw.slot,blockTime:raw.blockTime,error,feeLamports:String(meta.fee),resolvedKeys:keys,lamportsBefore:before,lamportsAfter:after,tokenBalances:tokens});
 return Object.freeze({...evidence,evidenceSha256:hash(Buffer.from(JSON.stringify(evidence)))});
}

/** Only privately installed connectors/pins are accepted. The request must be
 * loaded from immutable server preparation AND signed-wire storage. */
export function createKeepEquipmentPaymentFailureReader(connect:readonly[(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc,(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc],input:KeepEquipmentPaymentPreparationTrust){
 need(input&&typeof input==='object'&&Array.isArray(connect)&&connect.length===2&&connect.every(c=>typeof c==='function'),'INPUT');
 const expectedGenesisHash=address(input.expectedGenesisHash).toBase58(),expectedKeepMint=address(input.expectedKeepMint).toBase58(),minContextSlot=input.minContextSlot,deadlineMs=input.deadlineMs,transactionVersion=input.transactionVersion;
 need(Array.isArray(input.providerIds)&&input.providerIds.length===2,'INPUT');const providerIds=Object.freeze([...input.providerIds]);
 need(providerIds.every(v=>typeof v==='string'&&v.length>0&&v.length<=128)&&providerIds[0]!==providerIds[1]&&safe(minContextSlot)&&safe(deadlineMs)&&deadlineMs>0&&deadlineMs<=60_000&&(transactionVersion==='legacy'||transactionVersion===0),'INPUT');
 const limits:Readonly<KeepEquipmentPaymentLimits>=Object.freeze({maxFeeLamports:input.maxFeeLamports,maxPriorityFeeLamports:input.maxPriorityFeeLamports,maxComputeUnitLimit:input.maxComputeUnitLimit});
 need(typeof limits.maxFeeLamports==='bigint'&&limits.maxFeeLamports>=0n&&limits.maxFeeLamports<=U64&&typeof limits.maxPriorityFeeLamports==='bigint'&&limits.maxPriorityFeeLamports>=0n&&limits.maxPriorityFeeLamports<=limits.maxFeeLamports&&safe(limits.maxComputeUnitLimit)&&limits.maxComputeUnitLimit>0&&limits.maxComputeUnitLimit<=1_400_000,'INPUT');
 const connectors=[...connect];let pending=0;
 return async(saved:KeepEquipmentPaymentFailureInput)=>{
  let original:Readonly<KeepEquipmentPaymentOriginal>,bytes:Uint8Array,signed:ReturnType<typeof verifyKeepEquipmentPaymentSignedWire>,floor:number,buyerAta:string,sellerAta:string;
  try{
   fields(saved,'original messageBytes messageSha256 blockhash lastValidBlockHeight minContextSlot signedTransaction signature wireSha256');const o=saved.original;fields(o,'reservationId buyer seller keepMint totalBaseUnits sellerAtaExists','sellerAtaRentCapLamports');
   original=Object.freeze({reservationId:o.reservationId,buyer:o.buyer,seller:o.seller,keepMint:o.keepMint,totalBaseUnits:o.totalBaseUnits,sellerAtaExists:o.sellerAtaExists,...(o.sellerAtaRentCapLamports!==undefined?{sellerAtaRentCapLamports:o.sellerAtaRentCapLamports}:{})});
   need(original.keepMint===expectedKeepMint&&saved.messageBytes instanceof Uint8Array&&saved.messageBytes.length>0&&saved.messageBytes.length<=PACKET_DATA_SIZE-65,'INPUT');bytes=Uint8Array.from(saved.messageBytes);
   need(safe(saved.minContextSlot)&&safe(saved.lastValidBlockHeight)&&saved.lastValidBlockHeight>0&&typeof saved.messageSha256==='string'&&/^[0-9a-f]{64}$/.test(saved.messageSha256)&&typeof saved.wireSha256==='string'&&/^[0-9a-f]{64}$/.test(saved.wireSha256),'INPUT');floor=Math.max(minContextSlot,saved.minContextSlot);
   const built=buildKeepEquipmentPaymentMessage(original,limits,address(saved.blockhash).toBase58(),transactionVersion);buyerAta=built.buyerAta;sellerAta=built.sellerAta;
   need(hash(bytes)===saved.messageSha256&&built.messageSha256===saved.messageSha256&&Buffer.from(built.messageBytes).equals(Buffer.from(bytes)),'MESSAGE');
   signed=verifyKeepEquipmentPaymentSignedWire({preparedMessageBytes:bytes,signedTransaction:saved.signedTransaction,buyer:address(original.buyer)});
   need(signed.signature===saved.signature&&signed.wireSha256===saved.wireSha256&&signed.messageSha256===saved.messageSha256&&signed.version===transactionVersion,'SIGNATURE');
  }catch(error){if(error instanceof KeepEquipmentPaymentFailureError)throw error;throw new KeepEquipmentPaymentFailureError('INPUT');}
  need(pending<4,'BUSY');pending++;const controller=new AbortController(),requests=new Set<Promise<unknown>>();let timer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>need(!controller.signal.aborted,'DEADLINE');
  async function call<T,R=T>(operation:()=>Promise<T>,copy:(raw:T)=>R=(raw=>raw as unknown as R)){
   active();const request=Promise.resolve().then(()=>{active();return operation();});requests.add(request);
   try{const raw=await request;active();return copy(raw);}finally{requests.delete(request);}
  }
  const work=(async()=>{
   const observations=await Promise.all(connectors.map(async open=>{
    active();const raw=open(controller.signal),names=['getGenesisHash','getSlot','getTransaction'] as const;need(raw&&names.every(name=>typeof raw[name]==='function'),'UNAVAILABLE');
    const rpc=Object.freeze(Object.fromEntries(names.map(name=>[name,raw[name].bind(raw)]))) as unknown as KeepEquipmentPaymentFailureRpc;
    need(await call(()=>rpc.getGenesisHash())===expectedGenesisHash,'GENESIS');const openingSlot=await call(()=>rpc.getSlot('finalized'));need(safe(openingSlot)&&openingSlot>=floor,'CONTEXT');
    const evidence=await call(()=>rpc.getTransaction(signed.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}),value=>failed(value,bytes,transactionVersion,signed.signature,original,buyerAta,sellerAta));
    need(evidence.slot>=floor,'CONTEXT');const closingSlot=await call(()=>rpc.getSlot('finalized'));need(safe(closingSlot)&&closingSlot>=Math.max(evidence.slot,openingSlot),'CONTEXT');need(await call(()=>rpc.getGenesisHash())===expectedGenesisHash,'GENESIS');
    return {evidence,observation:Object.freeze({openingSlot,closingSlot})};
   }));
   active();const first=observations[0]!,second=observations[1]!;need(first.evidence.evidenceSha256===second.evidence.evidenceSha256,'PROVIDER_MISMATCH');
   return Object.freeze({version:1 as const,outcome:'failed' as const,reservationId:original.reservationId,buyer:original.buyer,seller:original.seller,keepMint:original.keepMint,totalBaseUnits:original.totalBaseUnits.toString(),
    signature:signed.signature,messageSha256:signed.messageSha256,wireSha256:signed.wireSha256,transactionVersion,...first.evidence,
    rentLamports:'0' as const,paidKeepBaseUnits:'0' as const,expectedGenesisHash,providerIds,minContextSlot:floor,observations:Object.freeze(observations.map(v=>v.observation)),finalizedAgreement:true as const,
    paymentAuthorized:false as const,signingAuthorized:false as const,broadcastAuthorized:false as const,deliveryAuthorized:false as const,fenceReleaseAuthorized:false as const,unpaidProven:false as const});
  })().catch(error=>{controller.abort();throw error;});
  const drain=async()=>{await Promise.allSettled([...requests]);pending--;};void work.then(drain,drain);
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new KeepEquipmentPaymentFailureError('DEADLINE'));},deadlineMs);})]);}
  catch(error){if(error instanceof KeepEquipmentPaymentFailureError)throw error;throw new KeepEquipmentPaymentFailureError('UNAVAILABLE');}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
export type KeepEquipmentPaymentFailureObservation=Awaited<ReturnType<ReturnType<typeof createKeepEquipmentPaymentFailureReader>>>;
