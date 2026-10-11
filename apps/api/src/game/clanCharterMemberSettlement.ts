/** D153.172 private members-first payout. No transfer/unlock authority. */
import {BASE_OWNERSHIP} from '@shardkeep/shared';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {phaseECharterEnabled} from '../config';
import {getOrCreateBaseAccount} from '../ledger/accounts';
import {postTransaction} from '../ledger/ledger';
import {requireExactFinalizedOwnedBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
export interface ClanCharterMemberSettlement {
 readonly id:string;readonly fenceId:string;readonly clanId:string;readonly actorWallet:string;
 readonly totalShards:string;readonly ledgerTransactionId:string|null;readonly paidAt:string;
 readonly allocations:readonly Readonly<{wallet:string;shards:string;baseId:string|null;accountId:string|null;entryId:string|null}>[];
 readonly signingAuthorized:false;readonly transferAuthorized:false;readonly fenceReleaseAuthorized:false;
}
export interface ClanCharterMemberSettlementOptions {
 readonly finalizedDeedReader?:FinalizedDeedReader|null;readonly deedCollection?:string|null;
}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),wallet=z.string().min(1).max(128);
const natural=z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<=9223372036854775807n),positive=natural.refine(v=>BigInt(v)>0n);
const share=z.object({wallet,shards:natural}).strict();
const allocated=z.object({wallet,shards:natural,baseId:uuid.nullable(),accountId:uuid.nullable()}).strict()
 .refine(v=>v.shards==='0'?(v.baseId===null&&v.accountId===null):(v.baseId!==null&&v.accountId!==null));
const common={fenceId:uuid,clanId:uuid,actorWallet:wallet,totalShards:natural};
const planSchema=z.object({...common,allocations:z.array(share)}).strict();
const beginSchema=z.object({...common,id:uuid,poolAccountId:uuid,allocations:z.array(allocated)}).strict();
const receiptSchema=z.object({...common,id:uuid,ledgerTransactionId:uuid.nullable(),paidAt:z.iso.datetime(),
 allocations:z.array(z.object({wallet,shards:natural,baseId:uuid.nullable(),accountId:uuid.nullable(),entryId:positive.nullable()}).strict()
  .refine(v=>v.shards==='0'?(v.baseId===null&&v.accountId===null&&v.entryId===null):(v.baseId!==null&&v.accountId!==null&&v.entryId!==null))),
 signingAuthorized:z.literal(false),transferAuthorized:z.literal(false),fenceReleaseAuthorized:z.literal(false)}).strict()
 .refine(v=>(v.totalShards==='0')===(v.ledgerTransactionId===null));
const fail=(suffix:string,status=503):never=>{throw new HttpError(status,'Clan member payout is unavailable','CLAN_CHARTER_MEMBER_SETTLEMENT_'+suffix);};
function translate(error:unknown):never{
 if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_MEMBER_SETTLEMENT_'))throw error;
 let cause=error;
 for(let n=0;n<8&&cause&&typeof cause==='object';n++){
  if('code'in cause&&['55P03','40P01'].includes(String(cause.code)))return fail('BUSY',409);
  if('message'in cause&&typeof cause.message==='string'&&/^CLAN_CHARTER_MEMBER_SETTLEMENT_[A-Z_]+$/.test(cause.message)){
   const suffix=cause.message.slice('CLAN_CHARTER_MEMBER_SETTLEMENT_'.length);return fail(suffix,suffix==='NOT_FOUND'?404:suffix==='BUSY'?409:503);
  }
  if('code'in cause&&cause.code==='42501')return fail('OWNER');
  cause='cause'in cause?cause.cause:undefined;
 }
 return fail('HELD');
}
function identity(actor:string,id:string){if(!wallet.safeParse(actor).success||!uuid.safeParse(id).success)return fail('INPUT',400);}
function checkShares(value:{totalShards:string;allocations:readonly {wallet:string;shards:string}[]}){
 if(value.allocations.reduce((total,row)=>total+BigInt(row.shards),0n)!==BigInt(value.totalShards)
  ||value.allocations.some((row,i)=>i>0&&Buffer.compare(Buffer.from(value.allocations[i-1]!.wallet),Buffer.from(row.wallet))>=0))return fail('HELD');
}
function receipt(value:unknown,actor:string,id:string):ClanCharterMemberSettlement|null{
 if(value===null)return null;const v=receiptSchema.parse(value);
 if(v.actorWallet!==actor||v.fenceId!==id)return fail('HELD');checkShares(v);
 return Object.freeze({...v,allocations:Object.freeze(v.allocations.map(row=>Object.freeze(row)))});
}
async function stored(tx:DbTx,actor:string,id:string){
 const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_member_payment_read(${id}::uuid,${actor}) value`);
 return receipt(row?.value,actor,id);
}
export function createClanCharterMemberSettlement(db:Db,options:ClanCharterMemberSettlementOptions={}){
 if('rollback'in db)return fail('TOP_LEVEL');
 // Capture dependencies once. No new destination lookup is used for a paid
 // receipt; later lawful transfers cannot erase an immutable completed payout.
 const reader=options.finalizedDeedReader??null,collection=options.deedCollection??null;
 async function read(actor:string,id:string):Promise<ClanCharterMemberSettlement|null>{
  identity(actor,id);try{return await db.transaction(tx=>stored(tx,actor,id),{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 async function destination(member:string):Promise<{wallet:string;baseId:string}>{
  if(!reader||!collection)return fail('DESTINATION');
  const candidates=await db.execute<{id:string}>(sql`select b.id from public.base_slots s join public.bases b on b.id=s.base_id
   where s.wallet=${member} and s.active and b.owner_wallet=${member} and b.status='active' and b.land_paid_at is not null
    and b.deed_asset_id is not null and not exists(select 1 from public.base_raid_locks r where r.base_id=b.id)
    and not exists(select 1 from public.raids r where r.attacker_base_id=b.id and r.status in('pending_orders','resolving'))
   order by s.slot,b.id`);
  for(const candidate of candidates){
   try{await requireExactFinalizedOwnedBaseAuthority(db,member,candidate.id,reader,collection);return {wallet:member,baseId:candidate.id};}
   catch{/* A different active owned slot may still be a valid destination. */}
  }
  return fail('DESTINATION');
 }
 async function settle(actor:string,id:string):Promise<ClanCharterMemberSettlement>{
  identity(actor,id);
  try{
   const prior=await read(actor,id);if(prior)return prior;
   if(!phaseECharterEnabled())return fail('DISABLED');
   const plan=await db.transaction(async tx=>{
    const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_member_payment_plan(${id}::uuid,${actor}) value`);
    const value=planSchema.parse(row?.value);if(value.actorWallet!==actor||value.fenceId!==id)return fail('HELD');checkShares(value);return value;
   },{isolationLevel:'read committed'});
   // Every external finalized read finishes before the payout transaction.
   // The SQL begin/deferred proof repeats exact ownership under mutation locks.
   const resolved=await Promise.allSettled(plan.allocations.filter(row=>row.shards!=='0').map(row=>destination(row.wallet)));
   if(resolved.some(result=>result.status==='rejected'))return fail('DESTINATION');
   const destinations=resolved.map(result=>(result as PromiseFulfilledResult<{wallet:string;baseId:string}>).value);
   return await db.transaction(async tx=>{
    const replay=await stored(tx,actor,id);if(replay)return replay;
    if(!phaseECharterEnabled())return fail('DISABLED');
    await tx.execute(sql`select set_config('shardkeep.deed_mutation_freshness_ms',${String(BASE_OWNERSHIP.mutationFreshnessMs)},true)`);
    for(const target of destinations)await getOrCreateBaseAccount(tx,target.baseId,'base_shards');
    const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_member_payment_begin(${id}::uuid,${actor},${JSON.stringify(destinations)}::jsonb) value`);
    const payment=beginSchema.parse(row?.value);
    if(payment.actorWallet!==actor||payment.fenceId!==id||payment.clanId!==plan.clanId)return fail('HELD');checkShares(payment);
    const positive=payment.allocations.filter(allocation=>allocation.shards!=='0');
    if(positive.length!==destinations.length||positive.some((allocation,i)=>allocation.wallet!==destinations[i]!.wallet||allocation.baseId!==destinations[i]!.baseId))return fail('HELD');
    const total=BigInt(payment.totalShards);
    if(total>0n){
     const posted=await postTransaction(tx,{idempotencyKey:'clan-charter:member-payment:'+payment.id,type:'clan.charter.member_settlement',
      metadata:{paymentId:payment.id,fenceId:id,clanId:payment.clanId,actorWallet:actor,totalShards:payment.totalShards},
      entries:[{account:payment.poolAccountId,delta:-total},...positive.map(allocation=>({account:allocation.accountId!,delta:BigInt(allocation.shards)}))]});
     if(posted.duplicate)return fail('HELD');
     const changed=await tx.execute(sql`update public.clans set chest_shards=0 where id=${payment.clanId}::uuid and chest_shards>0 returning id`);
     if(changed.length!==1)return fail('HELD');
    }
    if(!phaseECharterEnabled())return fail('DISABLED');
    return (await stored(tx,actor,id))??fail('HELD');
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 return Object.freeze({settle,read});
}
