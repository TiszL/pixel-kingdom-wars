/** Prospective originals only. Reading a trip never consults today's preference,
 * original actor's current kingdom, entitlement or selected appearance. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {BoundCosmeticWakeReadSchema,type BoundCosmeticWakeRead} from '@shardkeep/shared/boundCosmeticWake';
import type {DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';

const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const unavailable=()=>new HttpError(503,'Original expedition appearance is temporarily unavailable','BOUND_COSMETIC_WAKE_ORIGINAL_UNAVAILABLE');
function sourceUnavailable(error:unknown):boolean{
 let current=error;
 for(let depth=0;depth<8&&current&&typeof current==='object';depth++){
  if('code'in current&&(current.code==='42P01'||current.code==='42883'
   ||(current.code==='P0001'&&'message'in current&&current.message==='BOUND_COSMETIC_WAKE_SOURCE')))return true;
  current='cause'in current?current.cause:null;
 }
 return false;
}
/** Both request and owner connections use the same narrow reader capability.
 * It returns the stored capture, or SQL NULL for genuine pre-capture history. */
async function originalFields(db:DbOrTx,kind:'starter'|'advanced',expeditionId:string):Promise<{boundCosmeticWake?:BoundCosmeticWakeRead}>{
 Uuid.parse(expeditionId);
 const signature=kind==='starter'?'public.shardkeep_bound_cosmetic_starter_wake(uuid)':'public.shardkeep_bound_cosmetic_advanced_wake(uuid)';
 const [capability]=await db.execute<{ready:boolean}>(sql`select to_regprocedure(${signature}) is not null ready`);
 if(!capability?.ready)throw unavailable();
 const [row]=await db.execute<{visual:unknown}>(kind==='starter'
  ?sql`select public.shardkeep_bound_cosmetic_starter_wake(${expeditionId}::uuid) visual`
  :sql`select public.shardkeep_bound_cosmetic_advanced_wake(${expeditionId}::uuid) visual`);
 // SQL NULL is an original without a capture, never a claimed ordinary Wake.
 if(row?.visual===null)return {};
 const parsed=BoundCosmeticWakeReadSchema.safeParse(row?.visual);
 if(!parsed.success)throw unavailable();
 return {boundCosmeticWake:parsed.data};
}

export async function boundCosmeticWakeFields(db:DbOrTx,kind:'starter'|'advanced',expeditionId:string):Promise<{boundCosmeticWake?:BoundCosmeticWakeRead}>{
 // Roll back the reader savepoint before projecting a known source outage;
 // the surrounding current-owner transaction must remain usable for its fences.
 try{return await db.transaction(tx=>boundCosmeticOriginalWakeFields(tx,kind,expeditionId));}catch(error){
  if(error instanceof HttpError&&error.code==='BOUND_COSMETIC_WAKE_ORIGINAL_UNAVAILABLE')return {boundCosmeticWake:{state:'unavailable',visual:null}};
  throw error;
 }
}

/** Original-actor history is authenticated by its caller. A failed observation must
 * fail the read, not return a different immutable receipt to a saved journal. */
export async function boundCosmeticOriginalWakeFields(db:DbOrTx,kind:'starter'|'advanced',expeditionId:string){
 try{return await originalFields(db,kind,expeditionId);}catch(error){
  if(sourceUnavailable(error))throw unavailable();
  throw error;
 }
}
