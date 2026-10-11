/** D153.180 detached consent is private history, never permission to relay.
 * Both original parties approve the same retained message. The second consent
 * and existing full-wire record commit together under the original sale lock. */
import {PublicKey} from '@solana/web3.js';
import {combineCharterTransferContributions,verifyCharterTransferContribution} from '@shardkeep/chain/charter-transfer-contribution';
import {verifyCharterTransferSignedWire} from '@shardkeep/chain/charter-transfer-wire';
import {isDeepStrictEqual} from 'node:util';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from './client';
import {createClanCharterSalesStore,type SaleState} from './charterSales';
import {HttpError} from '../lib/errors';
export interface CharterContribution {readonly wallet:string;readonly attemptId:string;readonly messageSha256:string;readonly signature:string}
export interface CharterContributionInput {readonly attemptId:string;readonly messageSha256:string;readonly signature:string}
const hash=z.string().regex(/^[0-9a-f]{64}$/),signature=z.string().length(88).refine(v=>{const bytes=Buffer.from(v,'base64');return bytes.length===64&&bytes.toString('base64')===v;});
const inputSchema=z.object({attemptId:z.uuid().refine(v=>v===v.toLowerCase()),messageSha256:hash,signature}).strict();
const rowSchema=inputSchema.extend({wallet:z.string().min(32).max(44)}).strict();
const wireSchema=z.object({signedTransactionHex:z.string().max(2464).regex(/^(?:[0-9a-f]{2})+$/),signature:z.string().min(64).max(88),wireSha256:hash,messageSha256:hash}).strict();
function fail(suffix:string,status=503):never{throw new HttpError(status,'Charter sale is unavailable','CLAN_CHARTER_SALE_'+suffix);}
function translate(error:unknown):never{
 if(error instanceof HttpError)throw error;
 let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){
  if('code'in cause&&['55P03','40P01'].includes(String(cause.code)))return fail('BUSY',409);
  if('code'in cause&&cause.code==='23505')return fail('CONFLICT',409);
  if('message'in cause&&typeof cause.message==='string'&&/^CLAN_CHARTER_SALE_[A-Z_]+$/.test(cause.message)){
   const suffix=cause.message.slice('CLAN_CHARTER_SALE_'.length);return fail(suffix,suffix==='NOT_FOUND'?404:suffix==='CONFLICT'?409:503);
  }
  if('code'in cause&&cause.code==='42501')return fail('OWNER');cause='cause'in cause?cause.cause:undefined;
 }
 return fail('HELD');
}
function message(saved:SaleState){
 const packet=saved.preparation?.packet as {messageHex?:unknown}|undefined;
 if(!saved.attempt||!packet||typeof packet.messageHex!=='string')return fail('HELD');
 return {intentBytes:Buffer.from(packet.messageHex,'hex'),buyer:new PublicKey(saved.original.buyer),seller:new PublicKey(saved.original.seller)};
}
function verify(saved:SaleState,wallet:string,value:CharterContributionInput){
 if(value.attemptId!==saved.attempt?.id)return fail('INPUT',400);
 try{const proof=verifyCharterTransferContribution({...message(saved),actor:new PublicKey(wallet),signature:Buffer.from(value.signature,'base64')});
  if(proof.messageSha256!==value.messageSha256)return fail('INPUT',400);
 }catch{return fail('INPUT',400);}
}
function wire(saved:SaleState,value:unknown){
 const parsed=wireSchema.parse(value),verified=verifyCharterTransferSignedWire({...message(saved),signedTransaction:Buffer.from(parsed.signedTransactionHex,'hex')});
 if(parsed.signature!==verified.signature||parsed.messageSha256!==verified.messageSha256||parsed.wireSha256!==verified.wireSha256)return fail('HELD');return parsed;
}
function snapshot(saved:SaleState,value:unknown){
 const outer=z.object({state:z.unknown(),contributions:z.array(rowSchema).max(2)}).strict().parse(value);
 if(!outer.state||typeof outer.state!=='object')return fail('HELD');
 const current=outer.state as SaleState;
 // The old store already checked every original quote and policy signature.
 // Only wire/terminal can advance between that read and our locked snapshot.
 const stable=({status:_status,signed:_signed,terminal:_terminal,...rest}:SaleState)=>rest;
 if(!isDeepStrictEqual(stable(current),stable(saved)))return fail('HELD');
 const signed=current.signed===null?null:wire(saved,current.signed);
 const rows=outer.contributions;
 if(rows.length===2&&!signed)return fail('HELD');
 const seen=new Set<string>();
 for(const row of rows){
  if(seen.has(row.wallet))return fail('HELD');seen.add(row.wallet);
  try{verify(saved,row.wallet,row);}catch{return fail('HELD');}
  if(signed){const index=row.wallet===saved.original.buyer?0:1,bytes=Buffer.from(signed.signedTransactionHex,'hex');
   if(!bytes.subarray(1+index*64,65+index*64).equals(Buffer.from(row.signature,'base64')))return fail('HELD');}
 }
 const ordered=rows.slice().sort((a,b)=>Number(a.wallet===saved.original.seller)-Number(b.wallet===saved.original.seller));
 if(!isDeepStrictEqual(rows,ordered))return fail('HELD');
 return {signed,terminal:current.terminal,rows:ordered.map(v=>Object.freeze({...v}))};
}
async function readLocked(tx:DbTx,actor:string,id:string,saved:SaleState){
 const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_contributions_read(${actor},${id}::uuid) value`);
 return snapshot(saved,row?.value);
}
export function createCharterContributions(db:Db){
 if('rollback'in db)return fail('TOP_LEVEL');const originals=createClanCharterSalesStore(db);
 async function read(actor:string,saleId:string):Promise<CharterContribution[]>{
  const saved=await originals.read(actor,saleId);
  try{return await db.transaction(async tx=>(await readLocked(tx,actor,saleId,saved)).rows,{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 async function retain(actor:string,saleId:string,input:CharterContributionInput):Promise<void>{
  const captured=inputSchema.safeParse(input),saved=await originals.read(actor,saleId);
  if(!captured.success)return fail('INPUT',400);const value=captured.data;
  try{await db.transaction(async tx=>{
   const current=await readLocked(tx,actor,saleId,saved);
   if(current.terminal)return;
   verify(saved,actor,value);
   const prior=current.rows.find(v=>v.wallet===actor);
   if(prior){if(!isDeepStrictEqual(prior,{wallet:actor,...value}))return fail('CONFLICT',409);return;}
   if(current.signed){const index=actor===saved.original.buyer?0:1;
    if(!Buffer.from(current.signed.signedTransactionHex,'hex').subarray(1+index*64,65+index*64).equals(Buffer.from(value.signature,'base64')))return fail('CONFLICT',409);
   }else if(current.rows.length===1){
    const both=[...current.rows,{wallet:actor,...value}],buyer=both.find(v=>v.wallet===saved.original.buyer)!,seller=both.find(v=>v.wallet===saved.original.seller)!;
    const combined=combineCharterTransferContributions({...message(saved),buyerSignature:Buffer.from(buyer.signature,'base64'),sellerSignature:Buffer.from(seller.signature,'base64')});
    const record={signedTransactionHex:Buffer.from(combined.signedTransaction).toString('hex'),signature:combined.signature,wireSha256:combined.wireSha256,messageSha256:combined.messageSha256};
    // Wire first also works with immediate constraint checks: there is never a
    // database statement that exposes two consents and no complete wire.
    await tx.execute(sql`select public.shardkeep_charter_sale_wire(${actor},${saleId}::uuid,${JSON.stringify(record)}::jsonb)`);
   }
   await tx.execute(sql`insert into public.charter_sale_contributions(sale_id,attempt_id,actor_wallet,message_sha256,signature_bytes)
    values(${saleId}::uuid,${value.attemptId}::uuid,${actor},${value.messageSha256},${Buffer.from(value.signature,'base64')})`);
   await readLocked(tx,actor,saleId,saved);
  },{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 return Object.freeze({read,retain});
}
