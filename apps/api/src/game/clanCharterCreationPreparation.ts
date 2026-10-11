/** D153.166 private original-only kind5 issuance and unsigned v0 preparation.
 * API/DB is trusted entitlement authority; the typed issuer independently
 * enforces current chain policy only. No route, live key or relay is mounted.
 * Committed attempt is the single first-dispatch linearization point. Reopened
 * attempts use lookup only, including crash-before-call and null lookup. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { BASE_OWNERSHIP, PHASE_E_CHARTER_ADMISSION, PHASE_E_CHARTER_PREPARATION } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildCharterCreationPacket, verifyCharterCreationPacket, createCharterCreationQuoteReader,
 verifyCharterCreationQuote } from '@shardkeep/chain/charter-creation-preparation';
import type { CharterCreationQuote, CharterCreationQuoteOptions, CharterCreationQuoteRpc, CharterCreationPacket } from '@shardkeep/chain/charter-creation-preparation';
import { phaseECharterEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { createCharterCreationPolicyAdmission, type CharterCreationPolicyAdmission } from './clanCharterCreationPolicyAdmission';
import { lockStablePrerequisiteBase } from './stableBasePrerequisites';
export interface CharterIssueRequest {readonly kind:'charter-registration-v1';readonly requestId:string;readonly message:Uint8Array}
export interface CharterIssueReceipt {readonly requestId:string;readonly publicKey:string;readonly message:Uint8Array;readonly signature:Uint8Array}
/** Application-owned, independently chain-policy-gated kind5 service. No funding
 * authority is inferred from this interface. lookup never signs or renews. */
export interface TypedCharterIssuer {
 issueOnce(request:CharterIssueRequest,signal:AbortSignal):Promise<CharterIssueReceipt>;
 lookup(requestId:string,signal:AbortSignal):Promise<CharterIssueReceipt|null>;
}
export interface CharterCreationPreparationOptions {
 readonly chain:(CharterCreationQuoteOptions & {readonly connect:(signal:AbortSignal)=>CharterCreationQuoteRpc})|null;
 readonly issuer:TypedCharterIssuer|null; readonly monotonicNow?:()=>number; readonly timeoutMs?:number;
}
export interface CharterCreationPreparationState {
 readonly version:1; readonly admission:CharterCreationPolicyAdmission;
 readonly attempt:Readonly<{id:string;policySigner:string;candidateHex:string;quote:CharterCreationQuote}>;
 readonly preparation:Readonly<{policySignatureHex:string;packet:CharterCreationPacket}>|null;
 readonly signingAuthorized:false; readonly relayAuthorized:false; readonly mintAuthorized:false;
 readonly paymentAuthorized:false; readonly activationAuthorized:false; readonly refundAuthorized:false;
}
const uuid=z.string().length(36).pipe(z.uuid());
const address=z.string().min(32).max(44).refine(v=>{try{const p=new PublicKey(v);return !p.equals(PublicKey.default)&&p.toBase58()===v;}catch{return false;}});
const boundedTime=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const messageHex=z.string().length(322).regex(/^[0-9a-f]+$/);
const artifactSchema=z.object({policySignatureHex:z.string().length(128).regex(/^[0-9a-f]+$/),packet:z.unknown()}).strict();
const attemptSchema=z.object({version:z.literal(1),admission:z.unknown(),attempt:z.object({id:uuid,policySigner:address,candidateHex:messageHex,quote:z.unknown()}).strict(),
 timing:z.object({startedMs:boundedTime,recordSampleMs:boundedTime,elapsedMs:boundedTime}).strict()}).strict();
const envelopeSchema=z.object({policy:z.unknown().nullable(),state:z.enum(['reserved','activated','cancelled_unpaid','refunded']),
 attempt:z.unknown().nullable(),preparation:z.unknown().nullable()}).strict();
const noAuthority={signingAuthorized:false,relayAuthorized:false,mintAuthorized:false,paymentAuthorized:false,activationAuthorized:false,refundAuthorized:false} as const;
const json=(v:unknown)=>JSON.stringify(v,(_key,value:unknown)=>typeof value==='bigint'?value.toString():value);
function fail(code:string):never{throw new HttpError(code==='BUSY'?409:503,'Charter preparation refused','CLAN_CHARTER_PREPARATION_'+code);}
function translate(error:unknown):never{
 if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_PREPARATION_'))throw error;
 let cause=error;
 for(let i=0;i<8&&cause&&typeof cause==='object';i++){
  if('code' in cause&&cause.code==='55P03')return fail('BUSY');
  if('code' in cause&&typeof cause.code==='string'){
   const code=cause.code;
   for(const suffix of ['PAYER','OWNER','READ_COMMITTED','TOP_LEVEL'])if(code==='CLAN_CHARTER_POLICY_'+suffix)return fail(suffix);
   if((code==='P0001'||code==='42501')&&'message' in cause&&typeof cause.message==='string'){
    if(/^CLAN_CHARTER_PREPARATION_[A-Z_]+$/.test(cause.message))return fail(cause.message.slice('CLAN_CHARTER_PREPARATION_'.length));
    for(const suffix of ['PAYER','OWNER','READ_COMMITTED'])if(cause.message==='CLAN_CHARTER_POLICY_'+suffix)return fail(suffix);
   }
  }
  cause='cause' in cause?cause.cause:undefined;
 }
 return fail('HELD');
}
function identity(wallet:string,intent:string){if(!address.safeParse(wallet).success||!uuid.safeParse(intent).success)return fail('INPUT');}
function freeze<T>(v:T):T{if(v!==null&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
function original(admission:CharterCreationPolicyAdmission){
 const c=admission.original.consent;return {creationIntentId:c.creationIntentId,clanId:c.clanId,payer:c.payer,metadata:c.metadata,chain:c.chain,admissionCommitment:admission.admission.commitment};
}
function quoteFor(value:unknown,admission:CharterCreationPolicyAdmission):CharterCreationQuote{
 const quote=verifyCharterCreationQuote(value),p=quote.packetInput;
 if(!isDeepStrictEqual(p.original,original(admission))||p.candidateHex!==admission.candidate.messageHex
  ||p.policySigner!==admission.policy.currentSigner||quote.observation.expectedCurrentSigner!==admission.policy.currentSigner)return fail('HELD');
 return quote;
}
function packetInput(quote:CharterCreationQuote,signature:Uint8Array|null){
 const {candidateHex,...input}=quote.packetInput;return {...input,candidate:Buffer.from(candidateHex,'hex'),policySignature:signature};
}
function retained(value:unknown,preparation:unknown,admission:CharterCreationPolicyAdmission):CharterCreationPreparationState{
 const v=attemptSchema.parse(value);
 if(!isDeepStrictEqual(v.admission,JSON.parse(json(admission)))||v.attempt.candidateHex!==admission.candidate.messageHex
  ||v.attempt.policySigner!==admission.policy.currentSigner||v.timing.recordSampleMs<v.timing.startedMs
  ||v.timing.elapsedMs!==v.timing.recordSampleMs-v.timing.startedMs||v.timing.elapsedMs>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('HELD');
 const quote=quoteFor(v.attempt.quote,admission);
 let artifact:CharterCreationPreparationState['preparation']=null;
 if(preparation!==null){
  const p=artifactSchema.parse(preparation),packet=verifyCharterCreationPacket(packetInput(quote,Buffer.from(p.policySignatureHex,'hex')),p.packet);
  artifact={policySignatureHex:p.policySignatureHex,packet};
 }
 return freeze({version:1,admission,attempt:{...v.attempt,quote},preparation:artifact,...noAuthority});
}
async function currentCustody(tx:DbTx,admission:CharterCreationPolicyAdmission){
 const c=admission.original.consent;
 const [row]=await tx.execute<{value:Record<string,unknown>|null}>(sql`select public.shardkeep_charter_custody_read(${c.funding.baseId}::uuid,${BASE_OWNERSHIP.mutationFreshnessMs}::integer) value`);
 const v=row?.value;
 if(!v||v['authority']!=='current'||v['baseId']!==c.funding.baseId||v['deedAssetId']!==c.funding.deedAssetId
  ||v['ownerWallet']!==c.payer||v['id']!==c.funding.ownershipEpoch.id||v['evidenceCommitment']!==c.funding.ownershipEpoch.evidenceCommitment)return fail('HELD');
}
async function load(tx:DbTx,wallet:string,intent:string,admission:CharterCreationPolicyAdmission|null){
 const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_preparation_read(${wallet},${intent}::uuid) value`);
 if(row?.value===null){if(admission)return fail('HELD');return null;}
 const raw=envelopeSchema.parse(row?.value);
 if(!isDeepStrictEqual(raw.policy,admission===null?null:JSON.parse(json(admission))))return fail('HELD');
 if(raw.attempt===null){if(raw.preparation!==null)return fail('HELD');return {state:raw.state,saved:null};}
 if(!admission)return fail('HELD');
 return {state:raw.state,saved:retained(raw.attempt,raw.preparation,admission)};
}

export function createCharterCreationPreparation(db:Db,options:CharterCreationPreparationOptions){
 if('rollback' in db)return fail('TOP_LEVEL');
 const admissions=createCharterCreationPolicyAdmission(db,{chain:null});
 const time=options.monotonicNow??(()=>performance.now()),timeout=options.timeoutMs??PHASE_E_CHARTER_PREPARATION.timeoutMs;
 if(typeof time!=='function'||!Number.isSafeInteger(timeout)||timeout<=0||timeout>PHASE_E_CHARTER_PREPARATION.timeoutMs)return fail('HELD');
 const configured=options.chain===null?null:{...structuredClone({trust:options.chain.trust,expectedCurrentSigner:options.chain.expectedCurrentSigner,
  lookupTable:options.chain.lookupTable,coreCostProfile:options.chain.coreCostProfile,costLimits:options.chain.costLimits}),connect:options.chain.connect};
 const issue=options.issuer===null?null:options.issuer.issueOnce.bind(options.issuer);
 const lookup=options.issuer===null?null:options.issuer.lookup.bind(options.issuer);
 // Transport construction is deferred until new preparation, so malformed
 // current configuration never prevents coherent original artifact recovery.
 let pendingExternal=0;
 let quoteReader:ReturnType<typeof createCharterCreationQuoteReader>|null=null;
 async function external<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(pendingExternal>=PHASE_E_CHARTER_PREPARATION.maxPending)return fail('BUSY');pendingExternal++;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const work=Promise.resolve().then(()=>operation(controller.signal));
  // An ignored abort still occupies a bounded slot until that work settles.
  void work.then(()=>{pendingExternal--;},()=>{pendingExternal--;});
  try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{
   controller.abort();reject(new HttpError(503,'Charter issuer outcome uncertain','CLAN_CHARTER_PREPARATION_UNCERTAIN'));
  },timeout);})]);}
  catch(error){if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_PREPARATION_'))throw error;return fail('UNCERTAIN');}
  finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
 }
 async function backing(wallet:string,intent:string){
  const admission=await admissions.read(wallet,intent);
  const loaded=await db.transaction(tx=>load(tx,wallet,intent,admission),{isolationLevel:'read committed'});
  return {admission,loaded};
 }
 async function read(wallet:string,intent:string):Promise<CharterCreationPreparationState|null>{
  identity(wallet,intent);try{return (await backing(wallet,intent)).loaded?.saved??null;}catch(error){return translate(error);}
 }
 function receipt(value:unknown,state:CharterCreationPreparationState){
  const v=z.object({requestId:uuid,publicKey:address,message:z.instanceof(Uint8Array),signature:z.instanceof(Uint8Array)}).strict().parse(value);
  if(v.message.byteLength!==161||v.signature.byteLength!==64||v.requestId!==state.attempt.id||v.publicKey!==state.attempt.policySigner)return fail('HELD');
  const bytes=Buffer.from(v.message),signature=Buffer.from(v.signature);
  if(bytes.toString('hex')!==state.attempt.candidateHex)return fail('HELD');
  // Building verifies real Ed25519 over the exact original bytes. The retained
  // quote verifier already recompiled the zero-signature template; both builds
  // use the same original/ALT/blockhash/compute budget and wallet-signature slot.
  const packet=buildCharterCreationPacket(packetInput(state.attempt.quote,signature));
  if(packet.packetBytes!==state.attempt.quote.template.packetBytes)return fail('HELD');
  return freeze({policySignatureHex:signature.toString('hex'),packet});
 }
 async function retain(wallet:string,intent:string,state:CharterCreationPreparationState,value:unknown){
  // Copy/verify all external bytes synchronously before any awaited DB work.
  const artifact=receipt(value,state);
  return db.transaction(async tx=>{
   const current=await load(tx,wallet,intent,state.admission);
   if(!current?.saved||!isDeepStrictEqual(current.saved.attempt,state.attempt))return fail('HELD');
   if(current.saved.preparation)return current.saved;
   await tx.execute(sql`insert into public.charter_creation_preparations(attempt_id,record)
    values(${state.attempt.id}::uuid,${json(artifact)}::jsonb)`);
   const retainedState=(await load(tx,wallet,intent,state.admission))?.saved;
   if(!retainedState?.preparation||!isDeepStrictEqual(retainedState.preparation,artifact))return fail('HELD');
   return retainedState;
  },{isolationLevel:'read committed'});
 }
 async function recoverState(wallet:string,intent:string,state:CharterCreationPreparationState){
  if(state.preparation||!lookup)return state;
  const value=await external(signal=>lookup(state.attempt.id,signal));
  return value===null?state:retain(wallet,intent,state,value);
 }
 async function recover(wallet:string,intent:string):Promise<CharterCreationPreparationState>{
  identity(wallet,intent);
  try{const state=await read(wallet,intent);if(!state)return fail('HELD');return await recoverState(wallet,intent,state);}
  catch(error){return translate(error);}
 }
 async function prepare(wallet:string,intent:string):Promise<CharterCreationPreparationState>{
  identity(wallet,intent);
  try{
   const prior=await backing(wallet,intent);
   if(prior.loaded?.saved)return await recoverState(wallet,intent,prior.loaded.saved);
   if(!prior.admission||prior.loaded?.state!=='reserved'||!configured||!issue||!phaseECharterEnabled())return fail('HELD');
   const admission=prior.admission,c=admission.original.consent;
   if(configured.expectedCurrentSigner!==admission.policy.currentSigner)return fail('HELD');
   const started=time();if(!boundedTime.safeParse(started).success)return fail('STALE');let previous=started;
   const sample=()=>{const now=time();if(!boundedTime.safeParse(now).success||now<previous||now-started>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');previous=now;return now;};
   if(!quoteReader){const {connect,...quoteOptions}=configured;quoteReader=createCharterCreationQuoteReader(connect,quoteOptions);}
   const quote=quoteFor(await quoteReader(original(admission),Buffer.from(admission.candidate.messageHex,'hex')),admission);
   sample();
   const committed=await db.transaction(async tx=>{
    await tx.execute(sql`select public.shardkeep_charter_preparation_owner()`);
    await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
    const base=await lockStablePrerequisiteBase(tx,wallet,{baseId:c.funding.baseId,assertAuthority:locked=>currentCustody(locked,admission)});
    if(!base.landPaidAt||base.deedAssetId!==c.funding.deedAssetId)return fail('HELD');
    const current=await load(tx,wallet,intent,admission);
    if(current?.saved)return {state:current.saved,first:false};
    if(current?.state!=='reserved'||!phaseECharterEnabled())return fail('HELD');
    await currentCustody(tx,admission);const recordSample=sample();
    const attempt={id:randomUUID(),policySigner:admission.policy.currentSigner,candidateHex:admission.candidate.messageHex,quote};
    const record={version:1,admission,attempt,timing:{startedMs:started,recordSampleMs:recordSample,elapsedMs:recordSample-started}};
    retained(JSON.parse(json(record)),null,admission);
    await tx.execute(sql`insert into public.charter_creation_issuance_attempts(id,reservation_id,record)
     values(${attempt.id}::uuid,${c.reservationId}::uuid,${json(record)}::jsonb)`);
    const saved=(await load(tx,wallet,intent,admission))?.saved;
    if(!saved||!isDeepStrictEqual(saved.attempt,attempt))return fail('HELD');
    await currentCustody(tx,admission);if(!phaseECharterEnabled())return fail('HELD');sample();
    return {state:saved,first:true};
   },{isolationLevel:'read committed'});
   if(!committed.first)return await recoverState(wallet,intent,committed.state);
   // Commit completed. Only this continuation may make its first logical call.
   // A delayed/lost continuation leaves an immutable lookup-only obligation;
   // even a null lookup does not authorize retrying issueOnce or reblockhashing.
   sample();if(!phaseECharterEnabled())return fail('HELD');
   const value=await external(signal=>{
    // external schedules its callback: recheck after that microtask boundary,
    // immediately before dispatch, while preserving the committed obligation.
    sample();if(!phaseECharterEnabled())return fail('HELD');
    return issue({kind:'charter-registration-v1',requestId:committed.state.attempt.id,
     message:Buffer.from(committed.state.attempt.candidateHex,'hex')},signal);
   });
   return await retain(wallet,intent,committed.state,value);
  }catch(error){return translate(error);}
 }
 return Object.freeze({prepare,read,recover});
}
