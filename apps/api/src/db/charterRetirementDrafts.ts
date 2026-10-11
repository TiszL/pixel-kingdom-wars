/** Durable retirement review before destination resolution or member payout. */
import {PublicKey} from '@solana/web3.js';
import {CharterRetirementRequestSchema} from '@shardkeep/shared/charterRetirementApi';
import {CLANS} from '@shardkeep/shared';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from './client';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const address=z.string().refine(v=>{try{const k=new PublicKey(v);return k.toBase58()===v&&!k.equals(PublicKey.default);}catch{return false;}});
const amount=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<(1n<<64n));
const schema=z.object({version:z.literal(1),id:uuid,actor:address,request:CharterRetirementRequestSchema,
 clan:z.object({id:uuid,name:z.string().min(CLANS.nameMinLen).max(CLANS.nameMaxLen),tag:z.string().min(CLANS.tagMinLen).max(CLANS.tagMaxLen)}).strict(),
 fenceId:uuid,totalShards:amount,shares:z.array(z.object({wallet:address,shards:amount}).strict()).min(1).max(CLANS.rosterCap),
 memberPayment:z.object({id:uuid,totalShards:amount}).strict().nullable(),retirementId:uuid.nullable(),cancelled:z.boolean(),
}).strict().refine(v=>v.clan.id===v.request.clanId&&v.shares.reduce((n,s)=>n+BigInt(s.shards),0n)===BigInt(v.totalShards)
 &&v.shares.some(s=>s.wallet===v.actor)&&v.shares.every((s,i)=>i===0||s.wallet>v.shares[i-1]!.wallet)
 &&(!v.memberPayment||v.memberPayment.totalShards===v.totalShards)&&(!v.retirementId||v.memberPayment&&!v.cancelled));
export type RetirementDraftState=z.infer<typeof schema>;
const fail=(suffix:string,status=503):never=>{throw new HttpError(status,'Charter dissolution is unavailable','CLAN_CHARTER_RETIREMENT_DRAFT_'+suffix);};
function identity(actor:string,id?:string){if(!address.safeParse(actor).success||id!==undefined&&!uuid.safeParse(id).success)return fail('INPUT',400);}
function translate(error:unknown):never{
 if(error instanceof HttpError)throw error;let cause=error;
 for(let n=0;n<8&&cause&&typeof cause==='object';n++){
  if('code'in cause){if(['55P03','40P01'].includes(String(cause.code)))return fail('BUSY',409);if(cause.code==='23505')return fail('CONFLICT',409);if(cause.code==='42501')return fail('OWNER');}
  if('message'in cause&&typeof cause.message==='string'&&/^CLAN_CHARTER_RETIREMENT_DRAFT_[A-Z_]+$/.test(cause.message)){const suffix=cause.message.slice('CLAN_CHARTER_RETIREMENT_DRAFT_'.length);return fail(suffix,suffix==='NOT_FOUND'?404:suffix==='CONFLICT'?409:503);}
  cause='cause'in cause?cause.cause:undefined;
 }return fail('HELD');
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function parsed(value:unknown,actor:string,id?:string){const state=schema.parse(value);if(state.actor!==actor||id!==undefined&&state.id!==id)return fail('NOT_FOUND',404);return freeze(state);}
async function readIn(tx:DbTx,actor:string,id:string){const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_retirement_draft_read(${actor},${id}::uuid) value`);return parsed(row?.value,actor,id);}
async function byKeyIn(tx:DbTx,actor:string,key:string){
 await tx.execute(sql`select public.shardkeep_charter_retirement_owner(),public.shardkeep_charter_retirement_source()`);
 const [row]=await tx.execute<{id:string}>(sql`select id from public.charter_retirement_drafts where actor=${actor} and idempotency_key=${key}::uuid`);return row?readIn(tx,actor,row.id):null;
}
export function createClanCharterRetirementDraftsStore(db:Db){
 if('rollback'in db)return fail('TOP_LEVEL');
 async function read(actor:string,id:string){identity(actor,id);try{return await db.transaction(tx=>readIn(tx,actor,id),{isolationLevel:'read committed'});}catch(error){return translate(error);}}
 async function readByKey(actor:string,key:string){identity(actor,key);try{return await db.transaction(tx=>byKeyIn(tx,actor,key),{isolationLevel:'read committed'});}catch(error){return translate(error);}}
 async function create(actor:string,input:z.input<typeof CharterRetirementRequestSchema>){
  identity(actor);const request=CharterRetirementRequestSchema.safeParse(input);if(!request.success)return fail('INPUT',400);
  try{return await db.transaction(async tx=>{
   const prior=await byKeyIn(tx,actor,request.data.idempotencyKey);if(prior){if(prior.clan.id!==request.data.clanId)return fail('CONFLICT',409);return prior;}
   if(!phaseECharterEnabled())return fail('DISABLED');
   const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_retirement_draft_create(${actor},${request.data.clanId}::uuid,${request.data.idempotencyKey}::uuid) value`);
   if(!phaseECharterEnabled())return fail('DISABLED');return parsed(row?.value,actor);
  },{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 async function cancel(actor:string,id:string){identity(actor,id);try{return await db.transaction(async tx=>{
  const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_retirement_draft_cancel(${actor},${id}::uuid) value`);return parsed(row?.value,actor,id);
 },{isolationLevel:'read committed'});}catch(error){return translate(error);}}
 return Object.freeze({create,read,readByKey,cancel});
}
