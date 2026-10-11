/** D153.181 authenticated tournament lock workflow. SQL owns participation and
 * obligations; chain readers verify the original exact transaction only. */
import {PublicKey} from '@solana/web3.js';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {z} from 'zod';
import {boundedLockWork,buildCharterLockPacket,verifyCharterLockPacket,verifyCharterLockQuote,createCharterLockQuoteReader,type CharterLockQuoteOptions,type CharterLockQuoteRpc} from '@shardkeep/chain/charter-lock-preparation';
import {createCharterLockEvidenceReader,type CharterLockRpc} from '@shardkeep/chain/charter-lock-evidence';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import {createCharterLockCancellationReader} from '@shardkeep/chain/charter-lock-cancellation';
import {verifyCharterLockSignedWire} from '@shardkeep/chain/charter-lock-wire';
import {createCharterTournamentsStore,tournamentLockOriginal,type TournamentOperationState} from '../db/charterTournaments';
import type {Db} from '../db/client';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {createCharterTournamentDelivery,type CharterTournamentDeliveryOptions} from './clanCharterTournamentDelivery';
export const TournamentUuid=z.uuid().refine(v=>v===v.toLowerCase());
const address=z.string().min(32).max(44).refine(v=>{try{const key=new PublicKey(v);return key.toBase58()===v&&!key.equals(PublicKey.default);}catch{return false;}});
export const TournamentEntryRequest=z.object({eventId:TournamentUuid,clanId:TournamentUuid,idempotencyKey:TournamentUuid}).strict();
export const TournamentClearRequest=z.object({idempotencyKey:TournamentUuid}).strict();
export interface CharterLockIssueRequest {readonly kind:'charter-lock-v1';readonly requestId:string;readonly message:Uint8Array}
export interface CharterLockIssueReceipt {readonly requestId:string;readonly publicKey:string;readonly message:Uint8Array;readonly signature:Uint8Array}
export interface TypedCharterLockIssuer {issueOnce(request:CharterLockIssueRequest,signal:AbortSignal):Promise<CharterLockIssueReceipt>;lookup(requestId:string,signal:AbortSignal):Promise<CharterLockIssueReceipt|null>}
export interface CharterTournamentsOptions {
 readonly chain?:(CharterLockQuoteOptions&{connect:(signal:AbortSignal)=>CharterLockQuoteRpc&CharterLockRpc})|null;
 readonly recovery?:Readonly<{connect:(signal:AbortSignal)=>CharterLockRpc;trust:CharterCreationEvidenceTrust}>|null;
 readonly issuer?:TypedCharterLockIssuer|null;readonly delivery?:CharterTournamentDeliveryOptions|null;
 readonly clock?:()=>Date;readonly monotonicNow?:()=>number;readonly timeoutMs?:number;
}
const noAuthority={signingAuthorized:false,relayAuthorized:false,entryAuthorized:false,fenceReleaseAuthorized:false} as const;
function fail(suffix:string,status=503,id?:string):never{throw new HttpError(status,'Tournament operation is held; keep its original identity','CLAN_CHARTER_TOURNAMENT_'+suffix,id?{operationId:id,...noAuthority}:undefined);}
function translate(error:unknown,id?:string):never{if(error instanceof HttpError)throw error;return fail('HELD',503,id);}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
export function tournamentOperationQuote(state:TournamentOperationState){
 if(!state.attempt)return fail('HELD');const quote=verifyCharterLockQuote(state.attempt.quote);
 if(!isDeepStrictEqual(quote.packetInput.original,tournamentLockOriginal(state))||quote.packetInput.candidateHex!==state.attempt.candidateHex||quote.packetInput.policySigner!==state.attempt.policySigner)return fail('HELD');return quote;
}
export function tournamentOperationPacket(state:TournamentOperationState){if(!state.preparation)return fail('HELD');return verifyCharterLockPacket({...tournamentOperationQuote(state).packetInput,policySignatureHex:state.preparation.policySignatureHex},state.preparation.packet);}
/** Full authenticated original is needed by independent client reconstruction.
 * No issuer secret or private key is present. Retained signatures are immutable. */
export function tournamentOperationView(state:TournamentOperationState){
 if(state.attempt)tournamentOperationQuote(state);if(state.preparation)tournamentOperationPacket(state);
 return freeze({...structuredClone(state),...noAuthority});
}
type OriginalContext={actor:string;state:TournamentOperationState};
function contextState(id:string,context:OriginalContext){if(!context||context.state.original.operation.id!==id||context.actor!==context.state.original.operation.leader)return fail('NOT_FOUND',404);return context.state;}
export function createClanCharterTournaments(db:Db,options:CharterTournamentsOptions={}){
 if('rollback'in db)return fail('TOP_LEVEL');const store=createCharterTournamentsStore(db,options.clock?{clock:options.clock}:{});
 let chain:CharterTournamentsOptions['chain']=null,issuer:TypedCharterLockIssuer|null=null,invalid=false;
 try{if(options.chain){const {connect,...pins}=options.chain;chain={...structuredClone(pins),connect:connect.bind(options.chain)};}if(options.issuer)issuer={issueOnce:options.issuer.issueOnce.bind(options.issuer),lookup:options.issuer.lookup.bind(options.issuer)};}catch{invalid=true;}
 let recovery:CharterTournamentsOptions['recovery'];
 try{if(options.recovery!==undefined)recovery=options.recovery===null?null:{trust:structuredClone(options.recovery.trust),connect:options.recovery.connect.bind(options.recovery)};}catch{invalid=true;recovery=null;}
 const now=options.monotonicNow??(()=>performance.now()),timeout=options.timeoutMs??PHASE_E_CHARTER_PREPARATION.timeoutMs,external=boundedLockWork(timeout);
 let quoteReader:ReturnType<typeof createCharterLockQuoteReader>|undefined,evidenceReader:ReturnType<typeof createCharterLockEvidenceReader<OriginalContext>>|undefined,cancellationReader:ReturnType<typeof createCharterLockCancellationReader<OriginalContext>>|undefined;
 function configured(){if(!chain||invalid)return fail('CONFIGURATION');return chain;}
 function configuredRecovery(){const source=recovery===undefined?chain:recovery;if(!source||invalid)return fail('CONFIGURATION');return source;}
 function currentQuote(){if(!quoteReader){const {connect,...pins}=configured();quoteReader=createCharterLockQuoteReader(connect,pins);}return quoteReader;}
 function finality(){if(!evidenceReader){const c=configuredRecovery();evidenceReader=createCharterLockEvidenceReader<OriginalContext>(c.connect,c.trust,async(id,context)=>{
  const state=contextState(id,context);if(!state.signed||!state.preparation)return null;const quote=tournamentOperationQuote(state);
  if(!isDeepStrictEqual(c.trust,quote.observation.source.programs))return fail('CONFIGURATION');
  return {packetInput:{...quote.packetInput,policySignatureHex:state.preparation.policySignatureHex},signedTransactionHex:state.signed.signedTransactionHex};
 },{deadlineMs:timeout});}return evidenceReader;}
 function cancellation(){if(!cancellationReader){const c=configuredRecovery();cancellationReader=createCharterLockCancellationReader<OriginalContext>(c.connect,c.trust,async(id,context)=>{
  const state=contextState(id,context);if(state.attempt&&!isDeepStrictEqual(c.trust,tournamentOperationQuote(state).observation.source.programs))return fail('CONFIGURATION');
  return {original:tournamentLockOriginal(state),inventory:state.inventory};
 },{deadlineMs:timeout});}return cancellationReader;}
 async function saved(actor:string,id:string){if(!address.safeParse(actor).success||!TournamentUuid.safeParse(id).success)return fail('INPUT',400);return store.readOperation(actor,id);}
 function receipt(state:TournamentOperationState,value:unknown){
  const r=z.object({requestId:TournamentUuid,publicKey:address,message:z.instanceof(Uint8Array),signature:z.instanceof(Uint8Array)}).strict().parse(value);
  if(!state.attempt||r.message.length!==161||r.signature.length!==64||r.requestId!==state.attempt.id||r.publicKey!==state.attempt.policySigner||Buffer.from(r.message).toString('hex')!==state.attempt.candidateHex)return fail('ISSUER');
  const policySignatureHex=Buffer.from(r.signature).toString('hex');return {policySignatureHex,packet:buildCharterLockPacket({...tournamentOperationQuote(state).packetInput,policySignatureHex})};
 }
 async function recoverAttempt(actor:string,state:TournamentOperationState){
  if(state.terminal||state.preparation||!state.attempt||!issuer)return state;
  const lookup=issuer.lookup,value=await external((call,signal)=>call(()=>lookup(state.attempt!.id,signal)));
  return value===null?state:store.retainPreparation(actor,state.original.operation.id,state.attempt.id,receipt(state,value));
 }
 async function createEntry(actor:string,raw:unknown){const input=TournamentEntryRequest.safeParse(raw);if(!input.success)return fail('INPUT',400);try{return freeze(await store.createEntry(actor,input.data));}catch(error){return translate(error);}}
 async function readEntry(actor:string,id:string){try{return freeze(await store.readEntry(actor,id));}catch(error){return translate(error);}}
 async function createClear(actor:string,id:string,raw:unknown){const input=TournamentClearRequest.safeParse(raw);if(!input.success)return fail('INPUT',400);try{return tournamentOperationView(await store.createClear(actor,id,input.data.idempotencyKey));}catch(error){return translate(error);}}
 async function readOperation(actor:string,id:string){try{return tournamentOperationView(await saved(actor,id));}catch(error){return translate(error);}}
 async function recoverPreparation(actor:string,id:string){try{return tournamentOperationView(await recoverAttempt(actor,await saved(actor,id)));}catch(error){return translate(error,id);}}
 async function prepare(actor:string,id:string){try{
  const state=await saved(actor,id);if(state.terminal||state.preparation)return tournamentOperationView(state);if(state.attempt)return tournamentOperationView(await recoverAttempt(actor,state));
  if(!phaseECharterEnabled()||!issuer)return fail('HELD');const quoteService=currentQuote(),started=now();if(!Number.isFinite(started)||started<0)return fail('STALE');let previous=started;
  const elapsed=()=>{const current=now();if(!Number.isFinite(current)||current<previous||current-started>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');previous=current;return current-started;};
  const quote=await quoteService(tournamentLockOriginal(state),randomBytes(16));elapsed();if(!phaseECharterEnabled())return fail('HELD');
  const committed=await store.beginAttempt(actor,id,quote,{elapsedMs:elapsed()});
  // Only this committed new candidate may issue. All earlier/racing proposals
  // recover through lookup; an uncertain response never creates a new permit.
  if(committed.attempt?.candidateHex!==quote.packetInput.candidateHex)return tournamentOperationView(await recoverAttempt(actor,committed));
  if(committed.preparation||committed.terminal)return tournamentOperationView(committed);elapsed();if(!phaseECharterEnabled())return fail('HELD');
  const issue=issuer.issueOnce,value=await external((call,signal)=>call(()=>{elapsed();if(!phaseECharterEnabled())return fail('HELD');return issue({kind:'charter-lock-v1',requestId:committed.attempt!.id,message:Buffer.from(committed.attempt!.candidateHex,'hex')},signal);}));
  return tournamentOperationView(await store.retainPreparation(actor,id,committed.attempt!.id,receipt(committed,value)));
 }catch(error){return translate(error,id);}}
 async function retainSigned(actor:string,id:string,bytes:Uint8Array){try{
  const state=await saved(actor,id);if(!(bytes instanceof Uint8Array)||bytes.length<=65||bytes.length>1232)return fail('SIGNED_INPUT',400);
  let wire:ReturnType<typeof verifyCharterLockSignedWire>;try{wire=verifyCharterLockSignedWire({intentBytes:Buffer.from(tournamentOperationPacket(state).messageHex,'hex'),signedTransaction:Uint8Array.from(bytes),leader:new PublicKey(state.original.operation.leader)});}catch{return fail('SIGNED_INPUT',400);}
  return tournamentOperationView(await store.retainSigned(actor,id,{signedTransactionHex:Buffer.from(wire.signedTransaction).toString('hex'),signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256}));
 }catch(error){return translate(error,id);}}
 async function recover(actor:string,id:string){try{
  const state=await saved(actor,id);if(state.terminal)return tournamentOperationView(state);const context=freeze({actor,state:structuredClone(state)});
  if(state.signed){let evidence:Awaited<ReturnType<ReturnType<typeof finality>>>|undefined;try{evidence=await finality()(id,context);}catch{/* Cancellation still needs an independent strict original bank proof. */}
   if(evidence)return tournamentOperationView(await store.complete(actor,id,evidence));}
  return tournamentOperationView(await store.cancel(actor,id,await cancellation()(id,context)));
 }catch(error){return translate(error,id);}}
 const deliver=createCharterTournamentDelivery(saved,options.delivery??null);
 return Object.freeze({createEntry,readEntry,createClear,readOperation,prepare,recoverPreparation,retainSigned,recover,cancel:recover,deliver});
}
export type CharterTournamentProvider=ReturnType<typeof createClanCharterTournaments>;
