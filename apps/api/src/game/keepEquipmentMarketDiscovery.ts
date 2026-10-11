/** Bounded read-only market discovery. Exact actor receipts remain the
 * authority for retry; browsing never reserves or refreshes deed authority. */
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as policy} from '@shardkeep/shared';
import {keepMarketCatalogueIds,keepMarketCategory,KeepEquipmentListingPageSchema,KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryPageSchema,KeepEquipmentHistoryQuerySchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';
import {readKeepEquipmentListing} from './keepEquipmentMarket';

function selectedItems(q:{catalogueVersion?:'2'|'3'|'4'|undefined;category?:'resources'|'items'|undefined;itemId?:string|undefined}){
 return keepMarketCatalogueIds(q.catalogueVersion).filter(id=>(!q.category||keepMarketCategory(id)===q.category)&&(!q.itemId||q.itemId===id));
}
export async function listKeepEquipmentOffers(db:Db,raw:unknown){
 const q=KeepEquipmentListingsQuerySchema.parse(raw);
 const rows=await db.execute<{id:string}>(sql`select l.id from keep_equipment_listings l
  where l.item_id in (${sql.join(selectedItems(q).map(id=>sql`${id}`),sql`,`)})
   and ${q.before?sql`(date_trunc('milliseconds',l.created_at),l.id)<(${q.before}::timestamptz,${q.beforeId}::uuid)`:sql`true`}
   and not exists(select 1 from keep_equipment_listing_cancellations c where c.listing_id=l.id)
   and l.quantity::numeric>coalesce((select sum(f.quantity::numeric) from keep_equipment_fills f where f.listing_id=l.id),0)
  order by date_trunc('milliseconds',l.created_at) desc,l.id desc limit ${policy.pageSize+1}`);
 const selected=rows.slice(0,policy.pageSize),items=await Promise.all(selected.map(async row=>(await readKeepEquipmentListing(db,row.id))!));
 const last=items.at(-1);
 return KeepEquipmentListingPageSchema.parse({items,nextCursor:rows.length>policy.pageSize&&last?{before:last.createdAt,beforeId:last.id}:null});
}
export async function listKeepEquipmentHistory(db:Db,wallet:string,raw:unknown){
 const q=KeepEquipmentHistoryQuerySchema.parse(raw);
 const rows=await db.execute<{kind:'listing'|'fill'|'cancellation';id:string;base_id:string;item_id:string;created_at:Date}>(sql`
  with activity as(
   select 'listing'::text kind,id,seller_base_id base_id,item_id,created_at from keep_equipment_listings where seller_wallet=${wallet}
   union all select 'fill',f.id,f.buyer_base_id,l.item_id,f.created_at from keep_equipment_fills f join keep_equipment_listings l on l.id=f.listing_id where f.buyer_wallet=${wallet}
   union all select 'cancellation',c.id,l.seller_base_id,l.item_id,c.created_at from keep_equipment_listing_cancellations c join keep_equipment_listings l on l.id=c.listing_id where c.actor_wallet=${wallet}
  ) select * from activity where item_id in (${sql.join(selectedItems(q).map(id=>sql`${id}`),sql`,`)}) and ${q.before?sql`(date_trunc('milliseconds',created_at),id,kind)<(${q.before}::timestamptz,${q.beforeId}::uuid,${q.beforeKind})`:sql`true`}
  order by date_trunc('milliseconds',created_at) desc,id desc,kind desc limit ${policy.pageSize+1}`);
 const items=rows.slice(0,policy.pageSize).map(r=>({kind:r.kind,id:r.id,baseId:r.base_id,itemId:r.item_id,createdAt:new Date(r.created_at).toISOString()})),last=items.at(-1);
 return KeepEquipmentHistoryPageSchema.parse({wallet,items,nextCursor:rows.length>policy.pageSize&&last?{before:last.createdAt,beforeId:last.id,beforeKind:last.kind}:null});
}
