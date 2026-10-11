/** D153.176 private authenticated ordinary sales. No runtime mount or relay. */
import {PublicKey} from '@solana/web3.js';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {z} from 'zod';
import {boundedTransferWork,buildCharterTransferPacket,verifyCharterTransferPacket,verifyCharterTransferQuote,createCharterTransferQuoteReader,copyCharterTransferOriginal,transferCandidate,transferParts,type CharterTransferPacket,type CharterTransferQuoteOptions,type CharterTransferOriginal} from '@shardkeep/chain/charter-transfer-preparation';
import {createCharterTransferEvidenceReader,type CharterTransferRpc} from '@shardkeep/chain/charter-transfer-evidence';
import {createCharterTransferCancellationReader} from '@shardkeep/chain/charter-transfer-cancellation';
import {verifyCharterTransferSignedWire,CharterTransferWireError} from '@shardkeep/chain/charter-transfer-wire';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import type {CharterTransferQuoteRpc} from '@shardkeep/chain/charter-transfer-preparation';
import type {Db} from '../db/client';
import {createClanCharterSalesStore,type SaleDomain,type SaleState} from '../db/charterSales';
import type {FinalizedDeedReader} from './baseOwnership';
import {createClanCharterMemberSettlement} from './clanCharterMemberSettlement';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
export const CharterSaleUuid=z.uuid().refine(v=>v===v.toLowerCase());
const address=z.string().min(32).max(44).refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&!p.equals(PublicKey.default);}catch{return false;}});
export const CharterSaleDraftSchema=z.object({clanId:CharterSaleUuid,buyer:address,priceLamports:z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v=>BigInt(v)<=(1n<<64n)-1n),sellerLeaves:z.boolean(),idempotencyKey:CharterSaleUuid}).strict();
export const CharterSaleAcceptanceSchema=z.object({termsHash:z.string().length(64).regex(/^[0-9a-f]+$/),buyerBaseId:CharterSaleUuid}).strict();
export interface CharterSaleIssueRequest {readonly kind:'charter-transfer-v1';readonly requestId:string;readonly message:Uint8Array}
export interface CharterSaleIssueReceipt {readonly requestId:string;readonly publicKey:string;readonly message:Uint8Array;readonly signature:Uint8Array}
export interface TypedCharterSaleIssuer {issueOnce(request:CharterSaleIssueRequest,signal:AbortSignal):Promise<CharterSaleIssueReceipt>;lookup(requestId:string,signal:AbortSignal):Promise<CharterSaleIssueReceipt|null>}
export interface CharterSalesOptions {
 readonly newSaleDomain?:SaleDomain|null;
 readonly chain?:(CharterTransferQuoteOptions&{connect:(signal:AbortSignal)=>CharterTransferQuoteRpc&CharterTransferRpc})|null;
 readonly recovery?:Readonly<{connect:(signal:AbortSignal)=>CharterTransferRpc;trust:CharterCreationEvidenceTrust}>|null;
 readonly issuer?:TypedCharterSaleIssuer|null;readonly finalizedDeedReader?:FinalizedDeedReader|null;readonly deedCollection?:string|null;
 readonly monotonicNow?:()=>number;readonly timeoutMs?:number;
}
export interface CharterSaleView {
 readonly version:1;readonly id:string;readonly status:string;readonly original:Readonly<{clanId:string;seller:string;buyer:string;priceLamports:string;sellerLeaves:boolean;termsHash:string;expectedRevision:number}>;
 readonly acceptance:Readonly<{buyerBaseId:string;acceptedAt:string}>|null;readonly memberPayment:Readonly<{id:string;totalShards:string}>|null;
 readonly preparation:Readonly<{packet:CharterTransferPacket;costs:Readonly<{priceLamports:string;sellerLamports:string;royaltyLamports:string;networkFeeLamports:string;rentLamports:string;totalLamports:string}>}>|null;
 readonly signed:Readonly<{signature:string;wireSha256:string;messageSha256:string}>|null;readonly terminal:Readonly<{id:string;outcome:'completed'|'cancelled'}>|null;
 readonly signingAuthorized:false;readonly relayAuthorized:false;readonly transferAuthorized:false;readonly fenceReleaseAuthorized:false;
}
const noAuthority={signingAuthorized:false,relayAuthorized:false,transferAuthorized:false,fenceReleaseAuthorized:false} as const;
function fail(suffix:string,status=503,id?:string):never{throw new HttpError(status,'Charter sale is unavailable; keep the original sale','CLAN_CHARTER_SALE_'+suffix,id?{saleId:id,status:'held',...noAuthority}:undefined);}
function translate(error:unknown,id?:string):never{if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_SALE_'))throw error;if(error instanceof CharterTransferWireError)return fail('SIGNED_INPUT',400);return fail('HELD',503,id);}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function original(state:SaleState):CharterTransferOriginal{
 const s=state.original;if(!state.fenceId||state.fenceId!==s.fenceId)return fail('HELD');
 return copyCharterTransferOriginal({creation:s.creation,sale:{id:s.id,fenceId:state.fenceId,seller:s.seller,buyer:s.buyer,treasury:s.domain.treasury,expectedRevision:s.expectedRevision,priceLamports:s.priceLamports,termsHash:s.termsHash}});
}
function quoteFor(state:SaleState){
 if(!state.attempt)return fail('HELD');const quote=verifyCharterTransferQuote(state.attempt.quote);
 if(!isDeepStrictEqual(quote.packetInput.original,original(state))||quote.packetInput.candidateHex!==state.attempt.candidateHex||quote.packetInput.policySigner!==state.attempt.policySigner)return fail('HELD');return quote;
}
function packetFor(state:SaleState){const quote=quoteFor(state);if(!state.preparation)return fail('HELD');return verifyCharterTransferPacket({...quote.packetInput,policySignatureHex:state.preparation.policySignatureHex},state.preparation.packet);}
export function charterSaleView(state:SaleState):CharterSaleView{
 const s=state.original;let preparation:CharterSaleView['preparation']=null;
 if(state.attempt){const quote=quoteFor(state);if(state.preparation){const packet=packetFor(state),{allocations:_allocations,...costs}=quote.costs;preparation={packet,costs};}}
 if(state.signed&&!preparation)return fail('HELD');
 return freeze({version:1,id:s.id,status:state.status,original:{clanId:s.clanId,seller:s.seller,buyer:s.buyer,priceLamports:s.priceLamports,sellerLeaves:s.sellerLeaves,termsHash:s.termsHash,expectedRevision:s.expectedRevision},
  acceptance:state.acceptance?{buyerBaseId:state.acceptance.buyerBaseId,acceptedAt:state.acceptance.acceptedAt}:null,memberPayment:state.memberPayment,preparation,
  signed:state.signed?{signature:state.signed.signature,wireSha256:state.signed.wireSha256,messageSha256:state.signed.messageSha256}:null,terminal:state.terminal?{id:state.terminal.id,outcome:state.terminal.outcome}:null,...noAuthority});
}
type AuthenticatedOriginal={actor:string;state:SaleState};
const view=charterSaleView;
function contextState(id:string,context:AuthenticatedOriginal){
 if(!context||context.state.original.id!==id||![context.state.original.seller,context.state.original.buyer].includes(context.actor))return fail('NOT_FOUND',404);
 return context.state;
}
export function createClanCharterSales(db:Db,options:CharterSalesOptions={}){
 if('rollback'in db)return fail('TOP_LEVEL');
 const store=createClanCharterSalesStore(db,{finalizedDeedReader:options.finalizedDeedReader??null,deedCollection:options.deedCollection??null}),members=createClanCharterMemberSettlement(db,{finalizedDeedReader:options.finalizedDeedReader??null,deedCollection:options.deedCollection??null});
 let domain:SaleDomain|null=null,chain:CharterSalesOptions['chain']=null,issuer:TypedCharterSaleIssuer|null=null,invalid=false;
 try{domain=options.newSaleDomain?structuredClone(options.newSaleDomain):null;if(options.chain){const {connect,...pins}=options.chain;chain={...structuredClone(pins),connect:connect.bind(options.chain)};}if(options.issuer)issuer={issueOnce:options.issuer.issueOnce.bind(options.issuer),lookup:options.issuer.lookup.bind(options.issuer)};}catch{invalid=true;}
 let recovery:CharterSalesOptions['recovery'];
 try{if(options.recovery!==undefined)recovery=options.recovery===null?null:{trust:structuredClone(options.recovery.trust),connect:options.recovery.connect.bind(options.recovery)};}catch{invalid=true;recovery=null;}
 const now=options.monotonicNow??(()=>performance.now()),timeout=options.timeoutMs??PHASE_E_CHARTER_PREPARATION.timeoutMs,external=boundedTransferWork(timeout);
 let quoteReader:ReturnType<typeof createCharterTransferQuoteReader>|undefined,evidenceReader:ReturnType<typeof createCharterTransferEvidenceReader<AuthenticatedOriginal>>|undefined,cancellationReader:ReturnType<typeof createCharterTransferCancellationReader<AuthenticatedOriginal>>|undefined;
 function configured(){if(!chain||invalid)return fail('CONFIGURATION');return chain;}
 function configuredRecovery(){const source=recovery===undefined?chain:recovery;if(!source||invalid)return fail('CONFIGURATION');return source;}
 function currentQuote(){if(!quoteReader){const {connect,...pins}=configured();quoteReader=createCharterTransferQuoteReader(connect,pins);}return quoteReader;}
 function finality(){if(!evidenceReader){const c=configuredRecovery();evidenceReader=createCharterTransferEvidenceReader<AuthenticatedOriginal>(c.connect,c.trust,async(id,context)=>{
  const state=contextState(id,context);if(!state.signed||!state.attempt||!state.preparation)return null;
  if(!isDeepStrictEqual(c.trust,quoteFor(state).observation.source.programs))return fail('CONFIGURATION');
  const originalValue=original(state),{domain,terms}=transferParts(originalValue),permit=transferCandidate(originalValue,state.attempt.candidateHex),packet=packetFor(state);
  return {domain,terms,permit,policySigner:new PublicKey(state.attempt.policySigner),preparedMessage:Buffer.from(packet.messageHex,'hex'),signedTransaction:Buffer.from(state.signed.signedTransactionHex,'hex')};
 });}return evidenceReader;}
 function cancellation(){if(!cancellationReader){const c=configuredRecovery();cancellationReader=createCharterTransferCancellationReader<AuthenticatedOriginal>(c.connect,c.trust,async(id,context)=>{
  const state=contextState(id,context);if(state.attempt&&!isDeepStrictEqual(c.trust,quoteFor(state).observation.source.programs))return fail('CONFIGURATION');
  // Drafts have no retained quote. The protected terminal writer still requires
  // these observed deployment pins to equal the immutable genuine birth pins.
  return {original:original(state),inventory:state.inventory};
 });}return cancellationReader;}
 async function saved(actor:string,id:string){if(!address.safeParse(actor).success||!CharterSaleUuid.safeParse(id).success)return fail('INPUT',400);return store.read(actor,id);}
 function receipt(state:SaleState,value:unknown){
  const parsed=z.object({requestId:CharterSaleUuid,publicKey:address,message:z.instanceof(Uint8Array),signature:z.instanceof(Uint8Array)}).strict().parse(value);
  if(!state.attempt||parsed.message.length!==161||parsed.signature.length!==64||parsed.requestId!==state.attempt.id||parsed.publicKey!==state.attempt.policySigner||Buffer.from(parsed.message).toString('hex')!==state.attempt.candidateHex)return fail('ISSUER');
  const policySignatureHex=Buffer.from(parsed.signature).toString('hex'),packet=buildCharterTransferPacket({...quoteFor(state).packetInput,policySignatureHex});return {policySignatureHex,packet};
 }
 async function recoverAttempt(actor:string,state:SaleState){
  if(state.terminal||state.preparation||!state.attempt||!issuer)return state;
  const lookup=issuer.lookup,value=await external((call,signal)=>call(()=>lookup(state.attempt!.id,signal)));
  return value===null?state:store.retainPreparation(actor,state.original.id,state.attempt.id,receipt(state,value));
 }
 async function read(actor:string,id:string){try{return view(await saved(actor,id));}catch(error){return translate(error);}}
 async function create(actor:string,raw:unknown){const input=CharterSaleDraftSchema.safeParse(raw);if(!input.success)return fail('INPUT',400);try{return view(await store.create(actor,input.data,domain));}catch(error){return translate(error);}}
 async function accept(actor:string,id:string,raw:unknown){const input=CharterSaleAcceptanceSchema.safeParse(raw);if(!input.success)return fail('INPUT',400);try{await saved(actor,id);return view(await store.accept(actor,id,input.data));}catch(error){return translate(error,id);}}
 async function paid(actor:string,state:SaleState){
  if(state.terminal||state.memberPayment)return state;if(!state.acceptance||!state.fenceId||!phaseECharterEnabled())return fail('HELD');
  await members.settle(state.original.seller,state.fenceId);return saved(actor,state.original.id);
 }
 async function payMembers(actor:string,id:string){try{return view(await paid(actor,await saved(actor,id)));}catch(error){return translate(error,id);}}
 async function recoverPreparation(actor:string,id:string){try{return view(await recoverAttempt(actor,await saved(actor,id)));}catch(error){return translate(error,id);}}
 async function prepare(actor:string,id:string){try{
  let state=await saved(actor,id);if(state.terminal||state.preparation)return view(state);if(state.attempt)return view(await recoverAttempt(actor,state));
  if(!phaseECharterEnabled()||!issuer)return fail('HELD');const quoteService=currentQuote();state=await paid(actor,state);
  const started=now();if(!Number.isFinite(started)||started<0)return fail('STALE');let previous=started;
  const elapsed=()=>{const current=now();if(!Number.isFinite(current)||current<previous||current-started>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');previous=current;return current-started;};
  const quote=await quoteService(original(state),randomBytes(16));elapsed();if(!phaseECharterEnabled())return fail('HELD');
  const committed=await store.beginAttempt(actor,id,quote,{elapsedMs:elapsed()});
  // A fresh random permit distinguishes this committed winner from a racing
  // proposal. Every pre-existing or losing attempt is permanently lookup-only.
  if(committed.attempt?.candidateHex!==quote.packetInput.candidateHex)return view(await recoverAttempt(actor,committed));
  if(committed.preparation||committed.terminal)return view(committed);elapsed();if(!phaseECharterEnabled())return fail('HELD');
  const issue=issuer.issueOnce,value=await external((call,signal)=>call(()=>{elapsed();if(!phaseECharterEnabled())return fail('HELD');return issue({kind:'charter-transfer-v1',requestId:committed.attempt!.id,message:Buffer.from(committed.attempt!.candidateHex,'hex')},signal);}));
  return view(await store.retainPreparation(actor,id,committed.attempt!.id,receipt(committed,value)));
 }catch(error){return translate(error,id);}}
 async function retainSigned(actor:string,id:string,bytes:Uint8Array){try{
  const state=await saved(actor,id);if(!(bytes instanceof Uint8Array)||bytes.length<=129||bytes.length>1232)return fail('SIGNED_INPUT',400);
  const wire=verifyCharterTransferSignedWire({intentBytes:Buffer.from(packetFor(state).messageHex,'hex'),signedTransaction:Uint8Array.from(bytes),buyer:new PublicKey(state.original.buyer),seller:new PublicKey(state.original.seller)});
  return view(await store.retainSigned(actor,id,{signedTransactionHex:Buffer.from(wire.signedTransaction).toString('hex'),signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256}));
 }catch(error){return translate(error,id);}}
 async function recover(actor:string,id:string){try{
  const state=await saved(actor,id);if(state.terminal)return view(state);const context=freeze({actor,state:structuredClone(state)});
  if(state.signed){let evidence:Awaited<ReturnType<ReturnType<typeof finality>>>|undefined;try{evidence=await finality()(id,context);}catch{/* Expiry still requires an independent complete original bank proof. */}
   if(evidence)return view(await store.complete(actor,id,evidence));}
  const observation=await cancellation()(id,context);if(observation.outcome!=='absent-after-expiry')return fail('HELD');return view(await store.cancel(actor,id,observation));
 }catch(error){return translate(error,id);}}
 return Object.freeze({create,read,accept,payMembers,prepare,recoverPreparation,retainSigned,recover,cancel:recover});
}
export type CharterSalesProvider=ReturnType<typeof createClanCharterSales>;
