/** D181 private source store. HTTP commands never supply source proofs or clocks. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_CHARTER_ADMISSION} from '@shardkeep/shared';
import {copyCharterLockOriginal,verifyCharterLockQuote,verifyCharterLockPacket,lockCandidate,type CharterLockOriginal} from '@shardkeep/chain/charter-lock-preparation';
import {verifyCharterLockSignedWire} from '@shardkeep/chain/charter-lock-wire';
import {verifyCharterLockCancellation} from '@shardkeep/chain/charter-lock-cancellation';
import type {Db,DbTx} from './client';
import type {SaleDomain} from './charterSales';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const address=z.string().min(32).max(44).refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&!p.equals(PublicKey.default);}catch{return false;}});
const hash=z.string().length(64).regex(/^[0-9a-f]+$/),natural=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<=(1n<<64n)-1n);
const domainSchema=z.object({genesisHash:address,economyProgram:address,craftProgram:address,treasury:address}).strict();
const operationSchema=z.object({version:z.literal(1),original:z.unknown(),operationTerms:z.record(z.string(),z.unknown()),entryId:uuid,
 status:z.enum(['draft','issuing','prepared','signed','completed','cancelled']),attempt:z.object({id:uuid,candidateHex:z.string().length(322).regex(/^[0-9a-f]+$/),policySigner:address,quote:z.unknown()}).strict().nullable(),
 preparation:z.object({policySignatureHex:z.string().length(128).regex(/^[0-9a-f]+$/),packet:z.unknown()}).strict().nullable(),
 signed:z.object({signedTransactionHex:z.string().min(132).max(2464).regex(/^(?:[0-9a-f]{2})+$/),signature:z.string().min(64).max(88),wireSha256:hash,messageSha256:hash}).strict().nullable(),
 terminal:z.object({id:uuid,outcome:z.enum(['completed','cancelled']),record:z.unknown()}).strict().nullable(),
 inventory:z.object({version:z.literal(1),revision:z.enum(['0','1']),count:z.union([z.literal(0),z.literal(1)]),messages:z.array(z.string().length(322).regex(/^[0-9a-f]+$/)).max(1)}).strict()}).strict();
export type TournamentOperationState=Omit<z.infer<typeof operationSchema>,'original'>&{original:CharterLockOriginal};
const entrySchema=z.object({version:z.literal(1),id:uuid,eventId:uuid,clanId:uuid,leader:address,epochId:uuid,lockId:uuid,roster:z.array(address),
 status:z.enum(['pending','entered','nonparticipating','released','cancelled']),set:z.unknown(),clear:z.unknown().nullable()}).strict();
export type TournamentEntryState=Omit<z.infer<typeof entrySchema>,'set'|'clear'>&{set:TournamentOperationState;clear:TournamentOperationState|null};
function fail(suffix:string,status=503):never{throw new HttpError(status,'Tournament source is unavailable; retain the original operation','CLAN_CHARTER_TOURNAMENT_'+suffix);}
function translate(error:unknown):never{
 if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_TOURNAMENT_'))throw error;
 let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){
  if('code'in cause&&['55P03','40P01'].includes(String(cause.code)))return fail('BUSY',409);
  if('code'in cause&&cause.code==='23505')return fail('CONFLICT',409);
  if('message'in cause&&typeof cause.message==='string'&&/^CLAN_CHARTER_TOURNAMENT_[A-Z_]+$/.test(cause.message)){
   const suffix=cause.message.slice('CLAN_CHARTER_TOURNAMENT_'.length);return fail(suffix,suffix==='NOT_FOUND'?404:['CONFLICT','BUSY','FENCED','WINDOW','PENDING'].includes(suffix)?409:503);
  }cause='cause'in cause?cause.cause:undefined;
 }return fail('HELD');
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const json=(value:unknown)=>JSON.stringify(value);
/** PostgreSQL jsonb text orders UTF-8 keys by byte length then byte value. */
function jsonb(value:unknown):string{
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isSafeInteger(value))return fail('TERMS');return String(value);}
 if(Array.isArray(value))return '['+value.map(jsonb).join(', ')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key=>JSON.stringify(key)+': '+jsonb((value as Record<string,unknown>)[key])).join(', ')+'}';
 return fail('TERMS');
}
function identity(actor:string,id?:string){if(!address.safeParse(actor).success||(id!==undefined&&!uuid.safeParse(id).success))return fail('INPUT',400);}
export function tournamentLockOriginal(state:TournamentOperationState):CharterLockOriginal{return copyCharterLockOriginal(state.original);}
function quoteFor(state:TournamentOperationState,input:unknown){const q=verifyCharterLockQuote(input);
 if(!isDeepStrictEqual(q.packetInput.original,state.original))return fail('HELD');
 if(state.attempt&&(state.attempt.candidateHex!==q.packetInput.candidateHex||state.attempt.policySigner!==q.packetInput.policySigner))return fail('HELD');return q;
}
function preparationFor(state:TournamentOperationState,input:unknown){
 if(!state.attempt)return fail('HELD');const p=operationSchema.shape.preparation.unwrap().parse(input),q=quoteFor(state,state.attempt.quote);
 return {policySignatureHex:p.policySignatureHex,packet:verifyCharterLockPacket({...q.packetInput,policySignatureHex:p.policySignatureHex},p.packet)};
}
function wireFor(state:TournamentOperationState,input:unknown){
 if(!state.preparation)return fail('HELD');const p=operationSchema.shape.signed.unwrap().parse(input),packet=preparationFor(state,state.preparation).packet;
 const w=verifyCharterLockSignedWire({leader:new PublicKey(state.original.operation.leader),intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:Buffer.from(p.signedTransactionHex,'hex')});
 if(w.signature!==p.signature||w.wireSha256!==p.wireSha256||w.messageSha256!==p.messageSha256)return fail('HELD');return p;
}
const slot=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const evidenceSchema=z.object({version:z.literal(1),original:z.unknown(),signature:z.string().min(64).max(88),slot,observedSlot:slot,
 priorRevision:slot,revision:slot,action:z.enum(['set','clear']),lockId:uuid,leader:address,feeLamports:natural,rentLamports:natural,
 wireSha256:hash,messageSha256:hash,finalizedTransitionObserved:z.literal(true),currentStateMatchesResult:z.boolean(),entryAuthorized:z.literal(false),fenceReleaseAuthorized:z.literal(false)}).strict();
function evidenceFor(state:TournamentOperationState,input:unknown){
 if(!state.signed)return fail('HELD');const e=evidenceSchema.parse(input),o=state.original.operation;
 if(!isDeepStrictEqual(copyCharterLockOriginal(e.original),state.original)||e.signature!==state.signed.signature||e.wireSha256!==state.signed.wireSha256
  ||e.messageSha256!==state.signed.messageSha256||e.priorRevision!==o.expectedRevision||e.revision!==o.expectedRevision+1||e.action!==o.action||e.lockId!==o.lockId||e.leader!==o.leader||e.observedSlot<e.slot)return fail('HELD');return e;
}
function cancellationFor(state:TournamentOperationState,input:unknown){const p=verifyCharterLockCancellation(input);
 if(!isDeepStrictEqual(p.original,state.original)||!isDeepStrictEqual(p.inventory,state.inventory))return fail('HELD');return p;
}
function operation(value:unknown,actor:string,id?:string):TournamentOperationState{
 const parsed=operationSchema.parse(value),original=copyCharterLockOriginal(parsed.original),state={...parsed,original};
 if(original.operation.leader!==actor||(id!==undefined&&original.operation.id!==id))return fail('NOT_FOUND',404);
 const terms=state.operationTerms,o=original.operation;
 if(Object.keys(terms).sort().join(' ')!=='action clanId clearance domain entryId epochId event eventId expectedRevision fenceId leader lockId operationId roster version'
  ||terms.version!==1||terms.entryId!==state.entryId||terms.fenceId!==state.entryId||terms.eventId!==o.eventId||terms.clanId!==original.creation.clanId
  ||terms.leader!==o.leader||terms.lockId!==o.lockId||terms.operationId!==o.id||terms.action!==o.action||terms.expectedRevision!==o.expectedRevision
  ||createHash('sha256').update('SHARDKEEP_CHARTER_TOURNAMENT_LOCK_TERMS_V1'+jsonb(terms)).digest('hex')!==o.termsHash)return fail('TERMS');
 if(state.inventory.count!==state.inventory.messages.length||state.inventory.revision!==String(state.inventory.count)
  ||state.status!==(state.terminal?.outcome??(state.signed?'signed':state.preparation?'prepared':state.attempt?'issuing':'draft')))return fail('HELD');
 if(state.attempt){quoteFor(state,state.attempt.quote);lockCandidate(original,state.attempt.candidateHex);if(state.inventory.count!==1||state.inventory.messages[0]!==state.attempt.candidateHex)return fail('HELD');}
 else if(state.preparation||state.signed||state.inventory.count!==0)return fail('HELD');
 if(state.preparation)preparationFor(state,state.preparation);if(state.signed)wireFor(state,state.signed);
 if(state.terminal){if(state.terminal.outcome==='completed')evidenceFor(state,state.terminal.record);else cancellationFor(state,state.terminal.record);}
 return freeze(state);
}
function entry(value:unknown,actor:string,id?:string):TournamentEntryState{
 const v=entrySchema.parse(value);if(v.leader!==actor||(id!==undefined&&v.id!==id))return fail('NOT_FOUND',404);
 const set=operation(v.set,actor),clear=v.clear===null?null:operation(v.clear,actor);
 if(set.entryId!==v.id||set.original.operation.action!=='set'||set.original.operation.eventId!==v.eventId||set.original.creation.clanId!==v.clanId
  ||set.original.operation.lockId!==v.lockId||!isDeepStrictEqual(set.operationTerms.roster,v.roster)
  ||(clear&&(clear.entryId!==v.id||clear.original.operation.action!=='clear')))return fail('HELD');return freeze({...v,set,clear});
}
export function createCharterTournamentsStore(db:Db,options:{clock?:()=>Date}={}){
 if('rollback'in db)return fail('TOP_LEVEL');const clock=options.clock??(()=>new Date());
 function now(){const value=clock();if(!(value instanceof Date)||!Number.isFinite(value.getTime()))return fail('CLOCK');return value.toISOString();}
 async function transact<T>(fn:(tx:DbTx)=>Promise<T>):Promise<T>{try{return await db.transaction(fn,{isolationLevel:'read committed'});}catch(error){return translate(error);}}
 async function readIn(tx:DbTx,actor:string,id:string){const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_read(${actor},${id}::uuid) value`);return operation(r?.value,actor,id);}
 async function readOperation(actor:string,id:string){identity(actor,id);return transact(tx=>readIn(tx,actor,id));}
 async function readEntry(actor:string,id:string){identity(actor,id);return transact(async tx=>{const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_entry_read(${actor},${id}::uuid) value`);return entry(r?.value,actor,id);});}
 async function entryByKey(actor:string,key:string){identity(actor,key);return transact(async tx=>{
  const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_entry_read(${actor},id) value from public.charter_tournament_entries where leader=${actor} and idempotency_key=${key}::uuid`);
  return r?entry(r.value,actor):null;
 });}
 async function initializeEpoch(input:SaleDomain){const domain=domainSchema.parse(input);if(!phaseECharterEnabled())return fail('DISABLED');return transact(async tx=>{
  const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_epoch(${json(domain)}::jsonb) value`);
  return freeze(z.object({version:z.literal(1),id:uuid,ordinaryEpochId:uuid,domain:domainSchema}).strict().parse(r?.value));
 });}
 async function createEntry(actor:string,input:{eventId:string;clanId:string;idempotencyKey:string}){
  identity(actor);const p=z.object({eventId:uuid,clanId:uuid,idempotencyKey:uuid}).strict().parse(input);
  return transact(async tx=>{const [saved]=await tx.execute<{id:string;event_id:string;clan_id:string}>(sql`select id,event_id,clan_id from public.charter_tournament_entries where leader=${actor} and idempotency_key=${p.idempotencyKey}::uuid`);
   if(saved&&(saved.event_id!==p.eventId||saved.clan_id!==p.clanId))return fail('CONFLICT',409);if(!saved&&!phaseECharterEnabled())return fail('DISABLED');
   const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_enter(${actor},${p.eventId}::uuid,${p.clanId}::uuid,${p.idempotencyKey}::uuid,${now()}::timestamptz) value`);
   const result=entry(r?.value,actor);if(!saved&&!phaseECharterEnabled())return fail('DISABLED');return result;
  });
 }
 async function createClear(actor:string,id:string,key:string){identity(actor,id);if(!uuid.safeParse(key).success)return fail('INPUT',400);
  return transact(async tx=>{const [saved]=await tx.execute<{id:string}>(sql`select id from public.charter_tournament_operations where entry_id=${id}::uuid and idempotency_key=${key}::uuid`);
   if(!saved&&!phaseECharterEnabled())return fail('DISABLED');const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_clear(${actor},${id}::uuid,${key}::uuid,${now()}::timestamptz) value`);
   const result=operation(r?.value,actor);if(!saved&&!phaseECharterEnabled())return fail('DISABLED');return result;
  });
 }
 async function record(actor:string,id:string,kind:string,value:unknown){return transact(async tx=>{const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_record(${actor},${id}::uuid,${kind},${json(value)}::jsonb,${now()}::timestamptz) value`);return operation(r?.value,actor,id);});}
 async function beginAttempt(actor:string,id:string,input:unknown,timing:{elapsedMs:number}){
  const started=performance.now();
  const saved=await readOperation(actor,id);if(saved.terminal||saved.attempt)return saved;if(!phaseECharterEnabled())return fail('DISABLED');
  try{const quote=quoteFor(saved,input),p=z.object({elapsedMs:z.number().finite().nonnegative().max(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)}).strict().parse(timing);
   let previous=p.elapsedMs;const elapsed=()=>{const value=performance.now()-started+p.elapsedMs;
    if(!Number.isFinite(value)||value<previous||value>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');previous=value;return value;};elapsed();
   return await transact(async tx=>{
    const current=await readIn(tx,actor,id);if(current.terminal||current.attempt)return current;
    if(!phaseECharterEnabled())return fail('DISABLED');quoteFor(current,quote);
    const [r]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_tournament_record(${actor},${id}::uuid,'attempt',${json({quote,elapsedMs:elapsed()})}::jsonb,${now()}::timestamptz) value`);
    const result=operation(r?.value,actor,id);elapsed();if(!phaseECharterEnabled())return fail('DISABLED');return result;
   });}catch(error){return translate(error);}
 }
 async function retainPreparation(actor:string,id:string,attemptId:string,input:{policySignatureHex:string;packet:unknown}){
  const saved=await readOperation(actor,id);if(saved.terminal)return saved;if(saved.attempt?.id!==attemptId)return fail('HELD');
  try{return await record(actor,id,'preparation',preparationFor(saved,input));}catch(error){return translate(error);}
 }
 async function retainSigned(actor:string,id:string,input:{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string}){
  const saved=await readOperation(actor,id);if(saved.terminal)return saved;try{return await record(actor,id,'wire',wireFor(saved,input));}catch(error){return translate(error);}
 }
 async function complete(actor:string,id:string,input:unknown){const saved=await readOperation(actor,id);if(saved.terminal)return saved;
  try{return await record(actor,id,'completed',evidenceFor(saved,input));}catch(error){return translate(error);}
 }
 async function cancel(actor:string,id:string,input:unknown){const saved=await readOperation(actor,id);if(saved.terminal)return saved;
  try{return await record(actor,id,'cancelled',cancellationFor(saved,input));}catch(error){return translate(error);}
 }
 return Object.freeze({initializeEpoch,createEntry,readEntry,entryByKey,createClear,readOperation,beginAttempt,retainPreparation,retainSigned,complete,cancel});
}
export type CharterTournamentsStore=ReturnType<typeof createCharterTournamentsStore>;
