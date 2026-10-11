/** Private enrolled-clan retirement storage. Finality comes from the bound
 * chain readers; SQL independently authenticates the original source/effects. */
import {isDeepStrictEqual} from 'node:util';
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_CHARTER_ADMISSION} from '@shardkeep/shared';
import {copyCharterRetirementOriginal,verifyCharterRetirementQuote,verifyCharterRetirementPacket,type CharterRetirementOriginal,type CharterRetirementQuote} from '@shardkeep/chain/charter-retirement-preparation';
import {verifyCharterRetirementSignedWire} from '@shardkeep/chain/charter-retirement-wire';
import {verifyCharterRetirementCancellation} from '@shardkeep/chain/charter-retirement-cancellation';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from './client';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
export interface RetirementState {
 readonly version:1;readonly original:CharterRetirementOriginal;readonly status:'cleared'|'issuing'|'prepared'|'signed'|'completed'|'cancelled';readonly source:unknown;
 readonly memberPayment:Readonly<{id:string;totalShards:string}>;
 readonly attempt:null|Readonly<{id:string;candidateHex:string;policySigner:string;quote:unknown}>;
 readonly preparation:null|Readonly<{policySignatureHex:string;packet:unknown}>;
 readonly signed:null|Readonly<{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string}>;
 readonly terminal:null|Readonly<{id:string;outcome:'completed'|'cancelled';record:unknown}>;
 readonly inventory:Readonly<{version:1;revision:string;count:number;messages:readonly string[]}>;
}
export interface ClanCharterRetirementsStore {
 create(actor:string,input:{fenceId:string;idempotencyKey:string}):Promise<RetirementState>;
 read(actor:string,id:string):Promise<RetirementState>;
 beginAttempt(actor:string,id:string,quote:unknown,timing:{elapsedMs:number}):Promise<RetirementState>;
 retainPreparation(actor:string,id:string,attemptId:string,input:{policySignatureHex:string;packet:unknown}):Promise<RetirementState>;
 retainSigned(actor:string,id:string,input:{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string}):Promise<RetirementState>;
 complete(actor:string,id:string,evidence:unknown):Promise<RetirementState>;
 cancel(actor:string,id:string,observation:unknown):Promise<RetirementState>;
}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),hash=z.string().regex(/^[0-9a-f]{64}$/),address=z.string().min(32).max(44).refine(v=>{try{const key=new PublicKey(v);return key.toBase58()===v&&!key.equals(PublicKey.default);}catch{return false;}});
const natural=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<=(1n<<64n)-1n),message=z.string().regex(/^[0-9a-f]{322}$/);
const preparationSchema=z.object({policySignatureHex:z.string().regex(/^[0-9a-f]{128}$/),packet:z.unknown()}).strict();
const signedSchema=z.object({signedTransactionHex:z.string().min(260).max(2464).regex(/^(?:[0-9a-f]{2})+$/),signature:z.string().min(64).max(88),wireSha256:hash,messageSha256:hash}).strict();
const stateSchema=z.object({version:z.literal(1),original:z.unknown(),status:z.enum(['cleared','issuing','prepared','signed','completed','cancelled']),source:z.unknown(),
 memberPayment:z.object({id:uuid,totalShards:natural}).strict(),attempt:z.object({id:uuid,candidateHex:message,policySigner:address,quote:z.unknown()}).strict().nullable(),
 preparation:preparationSchema.nullable(),signed:signedSchema.nullable(),terminal:z.object({id:uuid,outcome:z.enum(['completed','cancelled']),record:z.unknown()}).strict().nullable(),inventory:z.object({version:z.literal(1),revision:z.enum(['0','1']),count:z.number().int().min(0).max(1),messages:z.array(message).max(1)}).strict()}).strict();
const fail=(suffix:string,status=503):never=>{throw new HttpError(status,'Charter retirement is unavailable','CLAN_CHARTER_RETIREMENT_'+suffix);};
function translate(error:unknown):never{
 if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_RETIREMENT_'))throw error;
 let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){
  if('code'in cause&&['55P03','40P01'].includes(String(cause.code)))return fail('BUSY',409);
  if('code'in cause&&cause.code==='23505')return fail('CONFLICT',409);
  if('code'in cause&&cause.code==='42501')return fail('OWNER');
  if('message'in cause&&typeof cause.message==='string'&&/^CLAN_CHARTER_RETIREMENT_[A-Z_]+$/.test(cause.message)){const suffix=cause.message.slice('CLAN_CHARTER_RETIREMENT_'.length);return fail(suffix,suffix==='NOT_FOUND'?404:503);}
  cause='cause'in cause?cause.cause:undefined;
 }return fail('HELD');
}
function identity(actor:string,id?:string){if(!address.safeParse(actor).success||(id!==undefined&&!uuid.safeParse(id).success))return fail('INPUT',400);}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function quoteFor(state:RetirementState,value:unknown):CharterRetirementQuote{
 const quote=verifyCharterRetirementQuote(value);if(!isDeepStrictEqual(quote.packetInput.original,state.original))return fail('HELD');
 if(state.attempt&&(quote.packetInput.candidateHex!==state.attempt.candidateHex||quote.packetInput.policySigner!==state.attempt.policySigner))return fail('HELD');return quote;
}
function preparationFor(state:RetirementState,input:unknown){
 if(!state.attempt)return fail('HELD');const value=preparationSchema.parse(input),quote=quoteFor(state,state.attempt.quote);
 return {policySignatureHex:value.policySignatureHex,packet:verifyCharterRetirementPacket({...quote.packetInput,policySignatureHex:value.policySignatureHex},value.packet)};
}
function wireFor(state:RetirementState,input:unknown){
 if(!state.preparation)return fail('HELD');const value=signedSchema.parse(input),packet=preparationFor(state,state.preparation).packet;
 const signed=verifyCharterRetirementSignedWire({leader:new PublicKey(state.original.retirement.leader),intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:Buffer.from(value.signedTransactionHex,'hex')});
 if(value.signature!==signed.signature||value.wireSha256!==signed.wireSha256||value.messageSha256!==signed.messageSha256)return fail('HELD');return value;
}
const revision=z.number().int().min(0).max(4294967295),slot=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receiptSchema=z.object({retirementId:uuid,fenceId:uuid,clanId:uuid,charter:address,asset:address,leader:address,priorRevision:revision,revision,clearanceHash:hash,permitId:z.string().regex(/^[0-9a-f]{32}$/),acceptedAt:natural.refine(v=>v!=='0')}).strict();
const evidenceSchema=z.object({version:z.literal(1),original:z.unknown(),signature:z.string().min(64).max(88),slot,observedSlot:slot,priorRevision:revision,revision,retirementId:uuid,clanId:uuid,leader:address,
 receipt:receiptSchema,receiptSha256:hash,feeLamports:natural,rentLamports:natural,wireSha256:hash,messageSha256:hash,finalizedTransitionObserved:z.literal(true),currentStateMatchesResult:z.literal(true),retirementAuthorized:z.literal(false),fenceReleaseAuthorized:z.literal(false)}).strict();
function evidenceFor(state:RetirementState,input:unknown){
 if(!state.signed||!state.attempt)return fail('HELD');const e=evidenceSchema.parse(input),original=copyCharterRetirementOriginal(e.original),r=state.original.retirement,c=state.original.creation.chain;
 const quote=quoteFor(state,state.attempt.quote),permit=Buffer.from(state.attempt.candidateHex,'hex');
 const expected={retirementId:r.id,fenceId:r.fenceId,clanId:r.clanId,charter:c.charter,asset:c.asset,leader:r.leader,priorRevision:r.expectedRevision,revision:r.expectedRevision+1,clearanceHash:r.clearanceHash,permitId:permit.subarray(73,89).toString('hex'),acceptedAt:e.receipt.acceptedAt};
 if(!isDeepStrictEqual(original,state.original)||!isDeepStrictEqual(e.receipt,expected)||e.retirementId!==r.id||e.clanId!==r.clanId||e.leader!==r.leader||e.priorRevision!==r.expectedRevision||e.revision!==r.expectedRevision+1
  ||e.signature!==state.signed.signature||e.wireSha256!==state.signed.wireSha256||e.messageSha256!==state.signed.messageSha256||e.observedSlot<e.slot
  ||BigInt(e.receipt.acceptedAt)>=permit.readBigInt64LE(121)||[quote.observation.source.programs.economy,quote.observation.source.programs.craft,quote.observation.source.programs.core].some(p=>e.slot<=p.reviewedDeploymentSlot))return fail('HELD');
 return freeze({...e,original});
}
function cancellationFor(state:RetirementState,input:unknown){const proof=verifyCharterRetirementCancellation(input);if(!isDeepStrictEqual(proof.original,state.original)||!isDeepStrictEqual(proof.inventory,state.inventory))return fail('HELD');return proof;}
function state(input:unknown,actor:string,id?:string):RetirementState{
 const v=stateSchema.parse(input),original=copyCharterRetirementOriginal(v.original),s={...v,original};
 if(original.retirement.leader!==actor||(id!==undefined&&original.retirement.id!==id))return fail('NOT_FOUND',404);
 if(v.inventory.count!==v.inventory.messages.length||v.inventory.revision!==String(v.inventory.count)||v.status!==(v.terminal?.outcome??(v.signed?'signed':v.preparation?'prepared':v.attempt?'issuing':'cleared')))return fail('HELD');
 if(v.attempt){if(v.inventory.count!==1||v.inventory.messages[0]!==v.attempt.candidateHex)return fail('HELD');quoteFor(s,v.attempt.quote);}
 else if(v.preparation||v.signed||v.inventory.count!==0)return fail('HELD');
 if(v.preparation)preparationFor(s,v.preparation);if(v.signed)wireFor(s,v.signed);if(v.terminal){if(v.terminal.outcome==='completed')evidenceFor(s,v.terminal.record);else cancellationFor(s,v.terminal.record);}return freeze(s);
}
async function readInTransaction(tx:DbTx,actor:string,id:string){const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_retirement_read(${actor},${id}::uuid) value`);return state(row?.value,actor,id);}
export function createClanCharterRetirementsStore(db:Db):ClanCharterRetirementsStore{
 if('rollback'in db)return fail('TOP_LEVEL');
 async function read(actor:string,id:string){identity(actor,id);try{return await db.transaction(tx=>readInTransaction(tx,actor,id),{isolationLevel:'read committed'});}catch(error){return translate(error);}}
 async function create(actor:string,input:{fenceId:string;idempotencyKey:string}){
  identity(actor);const p=z.object({fenceId:uuid,idempotencyKey:uuid}).strict().safeParse(input);if(!p.success)return fail('INPUT',400);
  try{return await db.transaction(async tx=>{
   await tx.execute(sql`select public.shardkeep_charter_retirement_owner(),public.shardkeep_charter_retirement_source()`);
   const [prior]=await tx.execute<{id:string;fence_id:string}>(sql`select id,fence_id from public.charter_retirements where actor=${actor} and idempotency_key=${p.data.idempotencyKey}::uuid`);
   if(prior){if(prior.fence_id!==p.data.fenceId)return fail('CONFLICT',409);return readInTransaction(tx,actor,prior.id);}
   if(!phaseECharterEnabled())return fail('DISABLED');
   const [row]=await tx.execute<{id:string}>(sql`insert into public.charter_retirements(actor,idempotency_key,fence_id) values(${actor},${p.data.idempotencyKey}::uuid,${p.data.fenceId}::uuid) returning id`);
   if(!row)return fail('HELD');if(!phaseECharterEnabled())return fail('DISABLED');return readInTransaction(tx,actor,row.id);
  },{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 async function beginAttempt(actor:string,id:string,input:unknown,timing:{elapsedMs:number}){
  const saved=await read(actor,id);if(saved.terminal||saved.attempt)return saved;if(!phaseECharterEnabled())return fail('DISABLED');
  try{const quote=quoteFor(saved,input),elapsed=z.object({elapsedMs:z.number().finite().nonnegative().max(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)}).strict().parse(timing).elapsedMs,started=performance.now();
   return await db.transaction(async tx=>{
    const current=await readInTransaction(tx,actor,id);if(current.terminal||current.attempt)return current;if(!phaseECharterEnabled())return fail('DISABLED');quoteFor(current,quote);
    const age=performance.now()-started+elapsed;if(!Number.isFinite(age)||age<elapsed||age>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');
    await tx.execute(sql`insert into public.charter_retirement_attempts(retirement_id,record) values(${id}::uuid,${JSON.stringify({quote,elapsedMs:age})}::jsonb)`);
    if(!phaseECharterEnabled())return fail('DISABLED');return readInTransaction(tx,actor,id);
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function retainPreparation(actor:string,id:string,attemptId:string,input:{policySignatureHex:string;packet:unknown}){
  const saved=await read(actor,id);if(saved.terminal)return saved;if(saved.attempt?.id!==attemptId||!uuid.safeParse(attemptId).success)return fail('HELD');
  try{const artifact=preparationFor(saved,input);if(saved.preparation){if(!isDeepStrictEqual(saved.preparation,artifact))return fail('CONFLICT',409);return saved;}
   return await db.transaction(async tx=>{const current=await readInTransaction(tx,actor,id);if(current.terminal)return current;preparationFor(current,artifact);if(current.preparation){if(!isDeepStrictEqual(current.preparation,artifact))return fail('CONFLICT',409);return current;}
    await tx.execute(sql`insert into public.charter_retirement_preparations(retirement_id,record) values(${id}::uuid,${JSON.stringify(artifact)}::jsonb)`);return readInTransaction(tx,actor,id);
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function retainSigned(actor:string,id:string,input:{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string}){
  const saved=await read(actor,id);if(saved.terminal)return saved;try{const artifact=wireFor(saved,input);if(saved.signed){if(!isDeepStrictEqual(saved.signed,artifact))return fail('CONFLICT',409);return saved;}
   return await db.transaction(async tx=>{const current=await readInTransaction(tx,actor,id);if(current.terminal)return current;wireFor(current,artifact);if(current.signed){if(!isDeepStrictEqual(current.signed,artifact))return fail('CONFLICT',409);return current;}
    await tx.execute(sql`insert into public.charter_retirement_wires(retirement_id,record) values(${id}::uuid,${JSON.stringify(artifact)}::jsonb)`);return readInTransaction(tx,actor,id);
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function terminal(actor:string,id:string,outcome:'completed'|'cancelled',input:unknown){
  const saved=await read(actor,id);if(saved.terminal)return saved;try{const check=outcome==='completed'?evidenceFor:cancellationFor,evidence=check(saved,input);
   return await db.transaction(async tx=>{const current=await readInTransaction(tx,actor,id);if(current.terminal)return current;check(current,evidence);
    const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_retirement_terminal(${actor},${id}::uuid,${outcome},${JSON.stringify(evidence)}::jsonb) value`);return state(row?.value,actor,id);
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 return Object.freeze({create,read,beginAttempt,retainPreparation,retainSigned,complete:(actor:string,id:string,evidence:unknown)=>terminal(actor,id,'completed',evidence),cancel:(actor:string,id:string,observation:unknown)=>terminal(actor,id,'cancelled',observation)});
}
