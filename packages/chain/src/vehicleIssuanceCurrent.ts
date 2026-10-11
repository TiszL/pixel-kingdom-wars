/** Private once-only review/send boundary. A review ticket is process-local;
 * only its owner may persist the dispatch marker before invoking send. */
import {Message,PublicKey} from '@solana/web3.js';
import {copyTrust,fields,safe,type VehicleIssuanceTrust} from './vehicleIssuanceAccounts';
import {verifyVehicleIssuanceQuote,readVehicleIssuanceQuoteBank,calculateVehicleIssuanceQuoteCosts,type VehicleIssuanceQuote,type VehicleIssuanceQuoteRpc} from './vehicleIssuanceQuote';
import {verifyVehicleRequestSignedWire} from './vehicleIssuanceWire';
import {vehicleSha256} from './vehicleIssuanceProtocol';
export interface VehicleIssuanceRequestRef {wallet:string;idempotencyKey:string}
export interface VehicleIssuanceRequestSaved {quote:VehicleIssuanceQuote;signedTransaction:Uint8Array}
export type VehicleIssuanceRequestLoader=(ref:VehicleIssuanceRequestRef)=>Promise<VehicleIssuanceRequestSaved|null>;
export interface VehicleIssuanceCurrentRpc extends Pick<VehicleIssuanceQuoteRpc,'getGenesisHash'|'getSlot'|'getMultipleAccountsInfoAndContext'|'getFeeForMessage'|'getBlockHeight'> {
 isBlockhashValid(blockhash:string,options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:boolean}>;
 getSignatureStatuses(signatures:string[],options:{searchTransactionHistory:true}):Promise<{context:{slot:number};value:unknown[]}>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface VehicleIssuanceCurrentReview {version:1;originalHash:string;signature:string;wireSha256:string;messageSha256:string;slot:number}
export class VehicleIssuanceCurrentError extends Error {
 readonly reservationReleaseAuthorized=false;
 constructor(readonly code:'INPUT'|'SOURCE'|'HELD'|'OBSERVED_TRANSACTION'|'BLOCKHASH'|'COST'|'DEADLINE'|'BUSY'|'UNAVAILABLE'|'SEND_UNCERTAIN'){super(`Vehicle request delivery held: ${code}`);this.name='VehicleIssuanceCurrentError';}
}
export function vehicleRequestNeed(v:unknown,code:VehicleIssuanceCurrentError['code']='INPUT'):asserts v {if(!v)throw new VehicleIssuanceCurrentError(code);}
const need:typeof vehicleRequestNeed=vehicleRequestNeed;
const MAX_MS=60_000,MAX_PENDING=8;
export function copyVehicleRequestRef(value:unknown):VehicleIssuanceRequestRef {
 const r=fields(value,'wallet idempotencyKey');need(typeof r.wallet==='string'&&new PublicKey(r.wallet).toBase58()===r.wallet&&typeof r.idempotencyKey==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.idempotencyKey));return Object.freeze({wallet:r.wallet,idempotencyKey:r.idempotencyKey});
}
export function copyVehicleRequestSaved(value:unknown,ref?:VehicleIssuanceRequestRef){
 const v=fields(value,'quote signedTransaction'),quote=verifyVehicleIssuanceQuote(v.quote);need(v.signedTransaction instanceof Uint8Array&&v.signedTransaction.length<=1232);const signedTransaction=Buffer.from(v.signedTransaction);
 const wire=verifyVehicleRequestSignedWire({original:quote.original,policyAuthority:quote.policyAuthority,policySignature:Buffer.from(quote.policySignatureHex,'hex'),recentBlockhash:quote.blockhash,intentBytes:Buffer.from(quote.messageHex,'hex'),signedTransaction});
 if(ref)need(quote.original.buyer===ref.wallet);return {quote,signedTransaction,wire,fingerprint:vehicleSha256(Buffer.from(JSON.stringify(quote)+'\n'+wire.wireSha256))};
}
/** Lifetime accounting includes underlying RPC/loader promises that ignore abort. */
export function vehicleRequestRunner(options:{deadlineMs?:number}={}){
 const settings=fields(options,'','deadlineMs'),deadline=settings.deadlineMs??MAX_MS;need(safe(deadline)&&deadline>0&&deadline<=MAX_MS);let pending=0;
 return async<T>(work:(context:{call:<R>(fn:()=>Promise<R>)=>Promise<R>;active:()=>void;signal:AbortSignal;deadline:number})=>Promise<T>,signal?:AbortSignal):Promise<T>=>{
  need(!signal?.aborted,'DEADLINE');need(pending<MAX_PENDING,'BUSY');pending++;let done=false,released=false,outstanding=0,timer:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController(),started=performance.now(),active=()=>need(!controller.signal.aborted&&performance.now()-started<deadline,'DEADLINE'),release=()=>{if(done&&outstanding===0&&!released){released=true;pending--;}};
  async function call<R>(fn:()=>Promise<R>):Promise<R>{active();outstanding++;try{const value=await fn();active();return value;}finally{outstanding--;release();}}
  let cancel!:()=>void;const stopped=new Promise<never>((_,reject)=>{cancel=()=>{controller.abort();reject(new VehicleIssuanceCurrentError('DEADLINE'));};signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,deadline);});
  const task=Promise.resolve().then(()=>{active();return work({call,active,signal:controller.signal,deadline});});void task.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([task,stopped]);}catch(e){if(e instanceof VehicleIssuanceCurrentError)throw e;throw new VehicleIssuanceCurrentError('UNAVAILABLE');}
  finally{if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
 };
}
export function createVehicleIssuanceCurrent(connect:(signal:AbortSignal)=>VehicleIssuanceCurrentRpc,inputTrust:VehicleIssuanceTrust,loadSaved:VehicleIssuanceRequestLoader,options:{deadlineMs?:number}={}){
 need(typeof connect==='function'&&typeof loadSaved==='function');const trust=copyTrust(inputTrust),run=vehicleRequestRunner(options),tickets=new WeakMap<VehicleIssuanceCurrentReview,{ref:string;fingerprint:string;created:number}>();
 async function current(ref:VehicleIssuanceRequestRef,ctx:Parameters<Parameters<typeof run>[0]>[0]){
  const {call,active,signal,deadline}=ctx,saved=copyVehicleRequestSaved(await call(()=>loadSaved(ref)),ref),q=saved.quote;
  need(q.original.genesisHash===trust.expectedGenesisHash&&JSON.stringify(q.source.final.admission.source.programs)===JSON.stringify([trust.craft,trust.provider,trust.core]),'SOURCE');
  const rpc=connect(signal);active();
  const unseen=async()=>{const status=await call(()=>rpc.getSignatureStatuses([saved.wire.signature],{searchTransactionHistory:true}));need(status&&safe(status.context?.slot)&&Array.isArray(status.value)&&status.value.length===1,'SOURCE');need(status.value[0]===null,'OBSERVED_TRANSACTION');};
  await unseen();const i={original:q.original,policyAuthority:q.policyAuthority,policySignature:Buffer.from(q.policySignatureHex,'hex')};
  const initial=await readVehicleIssuanceQuoteBank(rpc,trust,i,q.source.closingSlot,ctx);need(BigInt(initial.admission.unixTimestamp)>=BigInt(q.source.final.admission.unixTimestamp),'SOURCE');const fee=await call(()=>rpc.getFeeForMessage(Message.from(Buffer.from(q.messageHex,'hex')),'finalized'));
  need(fee&&safe(fee.context?.slot)&&fee.context.slot>=initial.admission.closingSlot&&safe(fee.value),'COST');
  const final=await readVehicleIssuanceQuoteBank(rpc,trust,i,fee.context.slot,ctx);need(BigInt(final.admission.unixTimestamp)>=BigInt(initial.admission.unixTimestamp),'SOURCE');
  const result=calculateVehicleIssuanceQuoteCosts(q.original,final,String(fee.value),q.costLimits);
  need(BigInt(result.costs.networkFeeLamports)<=BigInt(q.costs.networkFeeLamports)&&BigInt(result.costs.initializationRentLamports)<=BigInt(q.costs.initializationRentLamports)&&BigInt(result.costs.requiredLamports)<=BigInt(q.costs.requiredLamports)&&result.costs.allocations.every((a,j)=>BigInt(a.minimumBalanceLamports)<=BigInt(q.costs.allocations[j]!.minimumBalanceLamports)&&BigInt(a.topUpLamports)<=BigInt(q.costs.allocations[j]!.topUpLamports)),'COST');
  const validity=await call(()=>rpc.isBlockhashValid(q.blockhash,{commitment:'finalized',minContextSlot:final.admission.closingSlot}));need(validity&&safe(validity.context?.slot)&&validity.context.slot>=final.admission.closingSlot&&validity.value===true,'BLOCKHASH');
  const height=await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:validity.context.slot}));need(safe(height)&&height>=q.currentBlockHeight&&height<=q.lastValidBlockHeight,'BLOCKHASH');
  await unseen();const closing=await call(()=>rpc.getSlot('finalized'));need(safe(closing)&&closing>=validity.context.slot,'SOURCE');need(await call(()=>rpc.getGenesisHash())===q.original.genesisHash,'SOURCE');
  // Re-read the closed server graph after asynchronous RPC. It may have paused,
  // settled, or been replaced while work was outstanding.
  const latest=copyVehicleRequestSaved(await call(()=>loadSaved(ref)),ref);need(latest.fingerprint===saved.fingerprint,'HELD');active();return {saved,rpc,slot:closing};
 }
 return {
  async review(value:VehicleIssuanceRequestRef,signal?:AbortSignal):Promise<VehicleIssuanceCurrentReview>{const ref=copyVehicleRequestRef(value);return run(async ctx=>{const {saved,slot}=await current(ref,ctx),review=Object.freeze({version:1 as const,originalHash:saved.quote.originalHash,signature:saved.wire.signature,wireSha256:saved.wire.wireSha256,messageSha256:saved.wire.messageSha256,slot});tickets.set(review,{ref:JSON.stringify(ref),fingerprint:saved.fingerprint,created:performance.now()});return review;},signal);},
  async send(value:VehicleIssuanceRequestRef,review:VehicleIssuanceCurrentReview,signal?:AbortSignal){
   const ref=copyVehicleRequestRef(value),ticket=tickets.get(review);need(ticket&&ticket.ref===JSON.stringify(ref)&&performance.now()-ticket.created<MAX_MS,'HELD');tickets.delete(review);let started=false;
   try{return await run(async ctx=>{const {saved,rpc,slot}=await current(ref,ctx);need(saved.fingerprint===ticket.fingerprint,'HELD');ctx.active();
    const signature=await ctx.call(()=>{started=true;return rpc.sendRawTransaction(Buffer.from(saved.signedTransaction),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:slot});});need(signature===saved.wire.signature,'SEND_UNCERTAIN');
    return Object.freeze({signature,wireSha256:saved.wire.wireSha256,messageSha256:saved.wire.messageSha256});
   },signal);}catch(e){if(started)throw new VehicleIssuanceCurrentError('SEND_UNCERTAIN');throw e;}
  },
 };
}
