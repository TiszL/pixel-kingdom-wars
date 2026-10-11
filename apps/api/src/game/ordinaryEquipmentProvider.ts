import type {BoundCosmeticCollection} from './boundCosmeticCollection';
/** Private owner composition. HTTP receives only wallet-scoped commands/views;
 * original receipts remain readable across pause, transfer and missing RPC. */
import {sql} from 'drizzle-orm';
import {OrdinaryEquipmentRequestSchema,type OrdinaryEquipmentRequest} from '@shardkeep/shared/ordinaryEquipmentApi';
import type {Db} from '../db/client';
import {multiBaseEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {ordinaryEquipmentEnvelope,readOrdinaryEquipmentView,startOrdinaryEquipment} from './ordinaryEquipment';
import {settleDueOrdinaryCrafting} from './ordinaryCrafting';
import {settleDueStarterExpeditions} from './starterExpeditionReturns';
import {settleDueAdvancedExpeditions} from './advancedExpeditionReturns';

export function createOrdinaryEquipmentProvider(db:Db,ownership:{finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null;cosmeticCollection?:BoundCosmeticCollection|null}={}){
 if('rollback' in db)throw Error('Equipment provider requires a top-level owner connection');
 const reader=ownership.finalizedDeedReader??null,collection=ownership.deedCollection??null;
 async function prefetch(wallet:string,baseId:string){
  if(!multiBaseEnabled())throw new HttpError(409,'An explicit stable base is required','BASE_ID_REQUIRED');
  await requireFreshBaseAuthority(db,wallet,baseId,reader,collection);
 }
 return Object.freeze({
  read:(wallet:string,key:string)=>ordinaryEquipmentEnvelope(db,wallet,key),
  start:async(wallet:string,raw:OrdinaryEquipmentRequest)=>{
   const request=OrdinaryEquipmentRequestSchema.parse(raw),old=await ordinaryEquipmentEnvelope(db,wallet,request.idempotencyKey);
   if(old.status!=='accepted'){await prefetch(wallet,request.baseId);await ownership.cosmeticCollection?.collectForBaseRead(wallet,request.baseId);}
   return startOrdinaryEquipment(db,wallet,request,{baseId:request.baseId,assertAuthority:async(tx,w,b)=>{await assertFreshLockedBaseAuthority(tx,w,b);}});
  },
  view:async(wallet:string,baseId:string,catalogueVersion:1|2=1)=>{
   await prefetch(wallet,baseId);
   return db.transaction(async tx=>{
    await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
    const [base]=await tx.execute(sql`select id from bases where id=${baseId} and owner_wallet=${wallet} and status='active' for update`);
    const [slot]=await tx.execute(sql`select base_id from base_slots where base_id=${baseId} and wallet=${wallet} and active for update`);
    if(!base||!slot)throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');
    await assertFreshLockedBaseAuthority(tx,wallet,baseId);const at=new Date();
    await settleDueOrdinaryCrafting(tx,baseId,at);await settleDueStarterExpeditions(tx,baseId,at);await settleDueAdvancedExpeditions(tx,baseId,at);
    const view=await readOrdinaryEquipmentView(tx,wallet,baseId,at,catalogueVersion);
    await assertFreshLockedBaseAuthority(tx,wallet,baseId);return view;
   });
  },
 });
}
export type OrdinaryEquipmentProvider=ReturnType<typeof createOrdinaryEquipmentProvider>;
