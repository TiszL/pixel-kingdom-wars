/** Original retirement preparation. The workflow separately owns exact delivery
 * and terminal reconciliation; retained consent alone grants no such authority. */
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {boundedRetirementWork,buildCharterRetirementPacket,copyCharterRetirementOriginal,createCharterRetirementQuoter,
 verifyCharterRetirementPacket,verifyCharterRetirementQuote,type CharterRetirementPacket,type CharterRetirementQuoteOptions,type CharterRetirementQuoteRpc} from '@shardkeep/chain/charter-retirement-preparation';
import {verifyCharterRetirementSignedWire} from '@shardkeep/chain/charter-retirement-wire';
import type {Db} from '../db/client';
import {createClanCharterRetirementsStore} from '../db/charterRetirements';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';

type State=Awaited<ReturnType<ReturnType<typeof createClanCharterRetirementsStore>['read']>>;
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const address=z.string().refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&!p.equals(PublicKey.default);}catch{return false;}});
export const CharterRetirementCreateSchema=z.object({fenceId:uuid,idempotencyKey:uuid}).strict();
export interface CharterRetirementIssueRequest {readonly kind:'charter-retirement-v1';readonly requestId:string;readonly message:Uint8Array}
export interface CharterRetirementIssueReceipt {readonly requestId:string;readonly publicKey:string;readonly message:Uint8Array;readonly signature:Uint8Array}
export interface TypedCharterRetirementIssuer {
 issueOnce(request:CharterRetirementIssueRequest,signal:AbortSignal):Promise<CharterRetirementIssueReceipt>;
 lookup(requestId:string,signal:AbortSignal):Promise<CharterRetirementIssueReceipt|null>;
}
export interface CharterRetirementPreparationOptions {
 readonly chain?:(CharterRetirementQuoteOptions&{connect:(signal:AbortSignal)=>CharterRetirementQuoteRpc})|null;
 readonly issuer?:TypedCharterRetirementIssuer|null;readonly monotonicNow?:()=>number;readonly timeoutMs?:number;
}
const noAuthority={signingAuthorized:false,relayAuthorized:false,retirementAuthorized:false,fenceReleaseAuthorized:false} as const;
function fail(suffix:string,status=503,id?:string):never {throw new HttpError(status,'Charter retirement preparation is unavailable; keep the original request','CLAN_CHARTER_RETIREMENT_'+suffix,id?{retirementId:id,status:'held',...noAuthority}:undefined);}
function translate(error:unknown,id?:string):never {if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_RETIREMENT_'))throw error;return fail('HELD',503,id);}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export function retirementOperationQuote(state:State){
 if(!state.attempt)return fail('HELD');const quote=verifyCharterRetirementQuote(state.attempt.quote);
 if(!isDeepStrictEqual(quote.packetInput.original,copyCharterRetirementOriginal(state.original))||quote.packetInput.candidateHex!==state.attempt.candidateHex||quote.packetInput.policySigner!==state.attempt.policySigner)return fail('HELD');return quote;
}
export function retirementOperationPacket(state:State){if(!state.preparation)return fail('HELD');return verifyCharterRetirementPacket({...retirementOperationQuote(state).packetInput,policySignatureHex:state.preparation.policySignatureHex},state.preparation.packet);}
export function charterRetirementPreparationView(state:State){
 const original=copyCharterRetirementOriginal(state.original);let preparation:null|{packet:CharterRetirementPacket;costs:{networkFeeLamports:string;rentLamports:string;totalLamports:string}}=null;
 if(state.preparation){const quote=retirementOperationQuote(state);preparation={packet:retirementOperationPacket(state),costs:{networkFeeLamports:quote.costs.networkFeeLamports,rentLamports:quote.costs.rentLamports,totalLamports:quote.costs.totalLamports}};}
 if(state.signed&&!preparation)return fail('HELD');
 return freeze({version:1 as const,id:original.retirement.id,status:state.status,original:original.retirement,memberPayment:state.memberPayment,preparation,
  signed:state.signed?{signature:state.signed.signature,wireSha256:state.signed.wireSha256,messageSha256:state.signed.messageSha256}:null,terminal:state.terminal?{id:state.terminal.id,outcome:state.terminal.outcome}:null,...noAuthority});
}
export function createClanCharterRetirementPreparation(db:Db,options:CharterRetirementPreparationOptions={}){
 if('rollback'in db)return fail('TOP_LEVEL');const store=createClanCharterRetirementsStore(db);
 let chain:CharterRetirementPreparationOptions['chain']=null,issuer:TypedCharterRetirementIssuer|null=null,invalid=false;
 try{if(options.chain){const {connect,...pins}=options.chain;chain={...structuredClone(pins),connect:connect.bind(options.chain)};}if(options.issuer)issuer={issueOnce:options.issuer.issueOnce.bind(options.issuer),lookup:options.issuer.lookup.bind(options.issuer)};}catch{invalid=true;}
 const now=options.monotonicNow??(()=>performance.now()),external=boundedRetirementWork(options.timeoutMs??PHASE_E_CHARTER_PREPARATION.timeoutMs);
 let quoter:ReturnType<typeof createCharterRetirementQuoter>|undefined;
 function quoteService(){if(!chain||invalid)return fail('CONFIGURATION');if(!quoter){const {connect,...pins}=chain;quoter=createCharterRetirementQuoter(connect,pins);}return quoter;}
 async function saved(actor:string,id:string){if(!address.safeParse(actor).success||!uuid.safeParse(id).success)return fail('INPUT',400);return store.read(actor,id);}
 function receipt(state:State,value:unknown){
  const parsed=z.object({requestId:uuid,publicKey:address,message:z.instanceof(Uint8Array),signature:z.instanceof(Uint8Array)}).strict().parse(value);
  if(!state.attempt||parsed.message.length!==161||parsed.signature.length!==64||parsed.requestId!==state.attempt.id||parsed.publicKey!==state.attempt.policySigner||Buffer.from(parsed.message).toString('hex')!==state.attempt.candidateHex)return fail('ISSUER');
  const policySignatureHex=Buffer.from(parsed.signature).toString('hex'),packet=buildCharterRetirementPacket({...retirementOperationQuote(state).packetInput,policySignatureHex});return {policySignatureHex,packet};
 }
 async function recoverAttempt(actor:string,state:State){
  if(state.terminal||state.preparation||!state.attempt||!issuer)return state;const lookup=issuer.lookup;
  const value=await external((call,signal)=>call(()=>lookup(state.attempt!.id,signal)));
  return value===null?state:store.retainPreparation(actor,state.original.retirement.id,state.attempt.id,receipt(state,value));
 }
 async function create(actor:string,raw:unknown){const input=CharterRetirementCreateSchema.safeParse(raw);if(!input.success||!address.safeParse(actor).success)return fail('INPUT',400);
  try{return charterRetirementPreparationView(await store.create(actor,input.data));}catch(error){return translate(error);}}
 async function read(actor:string,id:string){try{return charterRetirementPreparationView(await saved(actor,id));}catch(error){return translate(error);}}
 async function recoverPreparation(actor:string,id:string){try{return charterRetirementPreparationView(await recoverAttempt(actor,await saved(actor,id)));}catch(error){return translate(error,id);}}
 async function prepare(actor:string,id:string){try{
  const state=await saved(actor,id);if(state.terminal||state.preparation)return charterRetirementPreparationView(state);if(state.attempt)return charterRetirementPreparationView(await recoverAttempt(actor,state));
  if(!phaseECharterEnabled()||!issuer||invalid)return fail('HELD');const quoteReader=quoteService();
  const started=now();if(!Number.isFinite(started)||started<0)return fail('STALE');let previous=started;
  const elapsed=()=>{const current=now();if(!Number.isFinite(current)||current<previous||current-started>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');previous=current;return current-started;};
  const quote=await quoteReader(copyCharterRetirementOriginal(state.original),randomBytes(16));elapsed();if(!phaseECharterEnabled())return fail('HELD');
  const committed=await store.beginAttempt(actor,id,quote,{elapsedMs:elapsed()});
  // Only the winning fresh candidate may issue. Every original/uncertain or
  // losing race stays lookup-only, even when no receipt can yet be found.
  if(committed.attempt?.candidateHex!==quote.packetInput.candidateHex)return charterRetirementPreparationView(await recoverAttempt(actor,committed));
  if(committed.terminal||committed.preparation)return charterRetirementPreparationView(committed);elapsed();if(!phaseECharterEnabled())return fail('HELD');
  const issue=issuer.issueOnce,value=await external((call,signal)=>call(()=>{elapsed();if(!phaseECharterEnabled())return fail('HELD');return issue({kind:'charter-retirement-v1',requestId:committed.attempt!.id,message:Buffer.from(committed.attempt!.candidateHex,'hex')},signal);}));
  return charterRetirementPreparationView(await store.retainPreparation(actor,id,committed.attempt!.id,receipt(committed,value)));
 }catch(error){return translate(error,id);}}
 async function retainSigned(actor:string,id:string,bytes:Uint8Array){try{
  const state=await saved(actor,id);if(!(bytes instanceof Uint8Array)||bytes.length<=129||bytes.length>1232)return fail('SIGNED_INPUT',400);
  const wire=verifyCharterRetirementSignedWire({intentBytes:Buffer.from(retirementOperationPacket(state).messageHex,'hex'),signedTransaction:Uint8Array.from(bytes),leader:new PublicKey(state.original.retirement.leader)});
  return charterRetirementPreparationView(await store.retainSigned(actor,id,{signedTransactionHex:Buffer.from(wire.signedTransaction).toString('hex'),signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256}));
 }catch(error){return translate(error,id);}}
 return Object.freeze({create,read,prepare,recoverPreparation,retainSigned});
}
