/** Private owner composition. HTTP receives closed commands/views; saved
 * actor receipts survive a pause or unavailable payment/deed providers. */
import {PHASE_E_KEEP_EQUIPMENT_MARKET,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import {keepMarketCatalogueIds,KeepEquipmentStockQuerySchema,KeepEquipmentMarketListingRequestSchema,KeepEquipmentMarketFillRequestSchema,KeepEquipmentMarketCancelRequestSchema,KeepEquipmentPurchaseSchema,KeepEquipmentListingSchema,KeepEquipmentCancellationSchema,KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryQuerySchema,KeepEquipmentStockViewSchema,KeepEquipmentMarketPolicySchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {sql} from 'drizzle-orm';
import type {z} from 'zod';
import type {Db} from '../db/client';
import {keepEquipmentMarketEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {requireFreshBaseAuthority,assertFreshLockedBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import type {StableBaseMutationContext} from './stableBasePrerequisites';
import {createKeepEquipmentListing,reserveKeepEquipmentFill,cancelKeepEquipmentListing,readKeepEquipmentListing,readOwnedKeepEquipmentFill,readOwnedKeepEquipmentCancellation} from './keepEquipmentMarket';
import {createKeepEquipmentPayments,type KeepEquipmentPaymentDependencies} from './keepEquipmentPayments';
import {createKeepEquipmentReleases,type KeepEquipmentReleaseDependencies} from './keepEquipmentReleases';
import {listKeepEquipmentOffers,listKeepEquipmentHistory} from './keepEquipmentMarketDiscovery';
import {settleDueOrdinaryCrafting} from './ordinaryCrafting';

export interface KeepEquipmentMarketSources {
 finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null;
 payments?:Omit<KeepEquipmentPaymentDependencies,'assertAdmission'>;
 releases?:KeepEquipmentReleaseDependencies;
}
const missing=():never=>{throw new HttpError(404,'Equipment market record not found','KEEP_EQUIPMENT_MARKET_NOT_FOUND');};
function admission(){if(!keepEquipmentMarketEnabled())throw new HttpError(503,'Equipment market is paused','KEEP_EQUIPMENT_MARKET_DISABLED');}
export function keepEquipmentMarketPolicy(){return KeepEquipmentMarketPolicySchema.parse({version:PHASE_E_KEEP_EQUIPMENT_MARKET.policyVersion,decimals:TOKEN.decimals,minFillBaseUnits:PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits.toString(),sellerBps:PHASE_E_POLICY.taxes.keepMarket.sellerBps,basisPoints:PHASE_E_POLICY.basisPoints,reviewMaxAgeMs:PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs});}
export function createKeepEquipmentMarketProvider(db:Db,sources:KeepEquipmentMarketSources={}){
 if('rollback'in db)throw Error('Equipment market provider requires a top-level owner connection');
 const reader=sources.finalizedDeedReader??null,collection=sources.deedCollection??null;
 const payments=createKeepEquipmentPayments(db,{...sources.payments,assertAdmission:admission}),releases=createKeepEquipmentReleases(db,sources.releases);
 const context=(baseId:string):StableBaseMutationContext=>({baseId,assertAuthority:async(tx,w,b)=>{await assertFreshLockedBaseAuthority(tx,w,b);}});
 async function refresh(wallet:string,baseId:string){admission();await requireFreshBaseAuthority(db,wallet,baseId,reader,collection);}
 return Object.freeze({
  stock:async(wallet:string,raw:z.infer<typeof KeepEquipmentStockQuerySchema>)=>{
   const {baseId,catalogueVersion}=KeepEquipmentStockQuerySchema.parse(raw);await refresh(wallet,baseId);
   return db.transaction(async tx=>{
    await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
    const [base]=await tx.execute(sql`select id from bases where id=${baseId} and owner_wallet=${wallet} and status='active' for update`);
    const [slot]=await tx.execute(sql`select base_id from base_slots where base_id=${baseId} and wallet=${wallet} and active for update`);
    if(!base||!slot)missing();await assertFreshLockedBaseAuthority(tx,wallet,baseId);const at=new Date();await settleDueOrdinaryCrafting(tx,baseId,at);
    const rows=await tx.execute<{item_id:string;available:string;reserved:string;pending_output:string;market_outgoing:string;market_incoming:string}>(sql`select item_id,available::text,reserved::text,pending_output::text,market_outgoing::text,market_incoming::text from ordinary_equipment_stocks where base_id=${baseId}`);
    if(catalogueVersion)rows.push(...await tx.execute<{item_id:string;available:string;reserved:string;pending_output:string;market_outgoing:string;market_incoming:string}>(sql`select item_id,available::text,'0'::text reserved,pending_output::text,market_outgoing::text,market_incoming::text from crafting_stocks where base_id=${baseId}`));
    if(catalogueVersion==='3'||catalogueVersion==='4'){await tx.execute(sql`select public.shardkeep_divine_fragment_source()`);rows.push(...await tx.execute<{item_id:string;available:string;reserved:string;pending_output:string;market_outgoing:string;market_incoming:string}>(sql`select 'crystal_fragment'::text item_id,available::text,'0'::text reserved,'0'::text pending_output,market_outgoing::text,market_incoming::text from crystal_fragment_stocks where base_id=${baseId}`));}
    await assertFreshLockedBaseAuthority(tx,wallet,baseId);admission();
    return KeepEquipmentStockViewSchema.parse({baseId,wallet,serverNow:at.toISOString(),policy:keepEquipmentMarketPolicy(),...(catalogueVersion?{catalogueVersion:Number(catalogueVersion)}:{}),
     items:keepMarketCatalogueIds(catalogueVersion).map(itemId=>{const r=rows.find(row=>row.item_id===itemId);return {itemId,available:r?.available??'0',reserved:r?.reserved??'0',pendingOutput:r?.pending_output??'0',marketOutgoing:r?.market_outgoing??'0',marketIncoming:r?.market_incoming??'0'};})});
   });
  },
  offers:(raw:z.infer<typeof KeepEquipmentListingsQuerySchema>)=>{const q=KeepEquipmentListingsQuerySchema.parse(raw);admission();return listKeepEquipmentOffers(db,q);},
  history:(wallet:string,raw:z.infer<typeof KeepEquipmentHistoryQuerySchema>)=>listKeepEquipmentHistory(db,wallet,raw),
  listing:async(id:string)=>KeepEquipmentListingSchema.parse(await readKeepEquipmentListing(db,id)??missing()),
  cancellation:async(wallet:string,id:string)=>KeepEquipmentCancellationSchema.parse(await readOwnedKeepEquipmentCancellation(db,wallet,id)??missing()),
  list:async(wallet:string,raw:z.infer<typeof KeepEquipmentMarketListingRequestSchema>)=>{
   const body=KeepEquipmentMarketListingRequestSchema.parse(raw);
   if(!await readKeepEquipmentListing(db,body.idempotencyKey))await refresh(wallet,body.baseId);
   return KeepEquipmentListingSchema.parse(await createKeepEquipmentListing(db,wallet,body,context(body.baseId),{assertAdmission:admission}));
  },
  fill:async(wallet:string,raw:z.infer<typeof KeepEquipmentMarketFillRequestSchema>)=>{
   const body=KeepEquipmentMarketFillRequestSchema.parse(raw),offer=await readKeepEquipmentListing(db,body.listingId)??missing();
   if(!await readOwnedKeepEquipmentFill(db,wallet,body.idempotencyKey)){
    await refresh(wallet,body.buyerBaseId);await refresh(offer.sellerWallet,offer.sellerBaseId);
   }
   const fill=await reserveKeepEquipmentFill(db,wallet,body,{buyer:context(body.buyerBaseId),seller:context(offer.sellerBaseId)},{assertAdmission:admission});
   return KeepEquipmentPurchaseSchema.parse(await payments.read(wallet,fill.id));
  },
  cancel:async(wallet:string,raw:z.infer<typeof KeepEquipmentMarketCancelRequestSchema>)=>{
   const body=KeepEquipmentMarketCancelRequestSchema.parse(raw),offer=await readKeepEquipmentListing(db,body.listingId)??missing();
   if(!await readOwnedKeepEquipmentCancellation(db,wallet,body.idempotencyKey))await refresh(wallet,offer.sellerBaseId);
   return KeepEquipmentCancellationSchema.parse(await cancelKeepEquipmentListing(db,wallet,body,context(offer.sellerBaseId),{assertAdmission:admission}));
  },
  read:async(wallet:string,id:string)=>KeepEquipmentPurchaseSchema.parse(await payments.read(wallet,id)),
  release:async(wallet:string,id:string)=>{await releases.release(wallet,id);return KeepEquipmentPurchaseSchema.parse(await payments.read(wallet,id));},
  prepare:async(wallet:string,id:string)=>KeepEquipmentPurchaseSchema.parse(await payments.prepare(wallet,id)),
  recover:async(wallet:string,id:string)=>KeepEquipmentPurchaseSchema.parse(await payments.recover(wallet,id)),
  review:payments.review,
  deliver:payments.deliver,
  retainSigned:async(wallet:string,id:string,bytes:Uint8Array)=>KeepEquipmentPurchaseSchema.parse(await payments.retainSigned(wallet,id,bytes)),
 });
}
export type KeepEquipmentMarketProvider=ReturnType<typeof createKeepEquipmentMarketProvider>;
