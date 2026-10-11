/** D194 actual SQL custody. Boundary stock seeds are explicitly adversarial;
 * actual earned/refined and real SPL/client composition is a separate fixture. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {BUILD_COSTS,BuildingType,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as C} from '@shardkeep/shared';
import {ORDINARY_CRAFTING_ITEM_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {RAW_RESOURCE_STORAGE_MAX as MAX} from '@shardkeep/shared/phaseEResources';
import {KeepEquipmentPurchaseSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {buildings,builderJobs,craftingStocks} from '../src/db/schema';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {createKeepEquipmentListing,reserveKeepEquipmentFill,cancelKeepEquipmentListing,readKeepEquipmentListing} from '../src/game/keepEquipmentMarket';
import {listKeepEquipmentOffers,listKeepEquipmentHistory} from '../src/game/keepEquipmentMarketDiscovery';
import {createKeepEquipmentReleases} from '../src/game/keepEquipmentReleases';
import {createKeepEquipmentPayments} from '../src/game/keepEquipmentPayments';
import {startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {startOrdinaryEquipment} from '../src/game/ordinaryEquipment';
import {connectTestDb} from './helpers';
import {TEST_DATABASE_URL} from './db-url';
import {paymentFixture,transferPaymentBase} from './fixtures/keepEquipmentPayments';
const conn=connectTestDb(),db=conn.db;
beforeEach(()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(flag,'true');});
afterEach(()=>vi.unstubAllEnvs());afterAll(()=>conn.sql.end());
async function fixture(itemId:typeof ORDINARY_CRAFTING_ITEM_IDS[number]='frostglass'){
 const f=await paymentFixture(conn);await db.insert(craftingStocks).values({baseId:f.seller.baseId,itemId,available:10n});
 const deps={clock:()=>f.seller.now,assertAdmission:()=>{}},request={idempotencyKey:randomUUID(),baseId:f.seller.baseId,itemId,quantity:'10',unitPriceBaseUnits:f.listing.unitPriceBaseUnits};
 const listing=await createKeepEquipmentListing(db,f.seller.wallet,request,f.seller.authority,deps);
 const fill=async(quantity='2')=>reserveKeepEquipmentFill(db,f.buyer.wallet,{idempotencyKey:randomUUID(),listingId:listing.id,buyerBaseId:f.buyer.baseId,quantity},{buyer:f.buyer.authority,seller:f.seller.authority},deps);
 return {...f,craftListing:listing,craftFill:fill,itemId,marketDeps:deps};
}
const stock=async(base:string,item:string)=>(await conn.sql`select available::text,pending_output::text,market_outgoing::text,market_incoming::text from crafting_stocks where base_id=${base} and item_id=${item}`)[0];
async function workshop(f:Awaited<ReturnType<typeof fixture>>,base=f.seller){
 const [b]=await db.insert(buildings).values({baseId:base.baseId,playerWallet:base.wallet,type:BuildingType.Workshop,tx:9,ty:2}).returning();
 const completedAt=new Date(+base.now-1000);await db.insert(builderJobs).values({baseId:base.baseId,playerWallet:base.wallet,buildingId:b!.id,kind:'build',startedAt:new Date(+completedAt-BUILD_COSTS.workshop.buildSec*1000),finishesAt:completedAt,completedAt});
}
it.each(ORDINARY_CRAFTING_ITEM_IDS)('%s partial custody/cancel/release conserves original units without a parallel inventory',async itemId=>{
 const f=await fixture(itemId),fill=await f.craftFill('3');
 const cancel=await cancelKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),listingId:f.craftListing.id},f.seller.authority,f.marketDeps);expect(cancel.quantity).toBe('7');
 expect(await stock(f.seller.baseId,itemId)).toMatchObject({available:'7',market_outgoing:'3'});expect(await stock(f.buyer.baseId,itemId)).toMatchObject({available:'0',market_incoming:'3'});
 const release=createKeepEquipmentReleases(db),receipts=await Promise.all([release.release(f.buyer.wallet,fill.id),release.release(f.buyer.wallet,fill.id)]);expect(receipts[0]).toEqual(receipts[1]);
 expect(await stock(f.seller.baseId,itemId)).toMatchObject({available:'10',market_outgoing:'0'});expect(await stock(f.buyer.baseId,itemId)).toMatchObject({available:'0',market_incoming:'0'});
 expect(await readKeepEquipmentListing(db,f.craftListing.id)).toMatchObject({availableQuantity:'0',reservedQuantity:'3',cancelledQuantity:'7'});
 expect(KeepEquipmentPurchaseSchema.parse(await createKeepEquipmentPayments(db).read(f.buyer.wallet,fill.id))).toMatchObject({status:'released',fill:{itemId},release:{reason:'never_prepared'}});
});
it('retains real signed payment bindings and delivers crafting stock once after both base transfers, even providerlessly on replay',async()=>{
 const f=await fixture('prismstone_lens'),fill=await f.craftFill('3'),prepared=await f.payments.prepare(f.buyer.wallet,fill.id);f.controls.preparation=prepared.preparation;
 const wire=f.sign(prepared.preparation!);f.controls.wire=wire;await f.payments.retainSigned(f.buyer.wallet,fill.id,wire);
 await transferPaymentBase(conn,f.seller);await transferPaymentBase(conn,f.buyer);f.controls.paused=true;
 const results=await Promise.all([f.payments.recover(f.buyer.wallet,fill.id),f.payments.recover(f.buyer.wallet,fill.id)]);expect(results[0]).toEqual(results[1]);expect(results[0]).toMatchObject({status:'delivered',delivery:{buyerBaseId:f.buyer.baseId,itemId:'prismstone_lens',quantity:'3'}});
 expect(await stock(f.buyer.baseId,f.itemId)).toMatchObject({available:'3',market_incoming:'0'});expect(await stock(f.seller.baseId,f.itemId)).toMatchObject({available:'0',market_outgoing:'7'});
 expect(await createKeepEquipmentPayments(db).recover(f.buyer.wallet,fill.id)).toEqual(results[0]);
 await expect(createKeepEquipmentReleases(db).release(f.buyer.wallet,fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_DELIVERED'});
});
it('holds prepared without wire and cannot redirect a never-prepared release after both base transfers',async()=>{
 const f=await fixture(),prepared=await f.craftFill('2'),unprepared=await f.craftFill('3');await f.payments.prepare(f.buyer.wallet,prepared.id);
 await transferPaymentBase(conn,f.seller);await transferPaymentBase(conn,f.buyer);
 const release=createKeepEquipmentReleases(db);await expect(release.release(f.buyer.wallet,prepared.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_PREPARED'});
 await release.release(f.buyer.wallet,unprepared.id);expect(await stock(f.seller.baseId,f.itemId)).toMatchObject({available:'3',market_outgoing:'7'});expect(await stock(f.buyer.baseId,f.itemId)).toMatchObject({available:'0',market_incoming:'2'});
});
it('two concurrent partial fills cannot over-reserve and a losing insert leaves no phantom incoming hold',async()=>{
 const f=await fixture();const rows=await Promise.allSettled([f.craftFill('7'),f.craftFill('7')]);expect(rows.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(await stock(f.buyer.baseId,f.itemId)).toMatchObject({market_incoming:'7'});
});
it('all four capacity terms protect incoming admission and outgoing returns from overflow',async()=>{
 const f=await fixture();await conn.sql`insert into crafting_stocks(base_id,item_id,available,pending_output) values(${f.buyer.baseId},${f.itemId},${(MAX-2n).toString()}::bigint,1)`;
 const fill=await f.craftFill('1');await expect(f.craftFill('1')).rejects.toMatchObject({code:'KEEP_EQUIPMENT_MARKET_CAPACITY'});
 await expect(conn.sql`update crafting_stocks set pending_output=2 where base_id=${f.buyer.baseId} and item_id=${f.itemId}`).rejects.toThrow('crafting_market_capacity_ck');
 await conn.sql`update crafting_stocks set available=${(MAX-10n).toString()}::bigint where base_id=${f.seller.baseId} and item_id=${f.itemId}`;
 await expect(conn.sql`update crafting_stocks set pending_output=1 where base_id=${f.seller.baseId} and item_id=${f.itemId}`).rejects.toThrow('crafting_market_capacity_ck');
 await createKeepEquipmentReleases(db).release(f.buyer.wallet,fill.id);expect(await stock(f.seller.baseId,f.itemId)).toMatchObject({available:(MAX-9n).toString(),market_outgoing:'9'});
});
it('raw hold tampering, identity mutation, premature constraint checks and ignored inserts cannot create stock',async()=>{
 const f=await fixture(),fill=await f.craftFill('2');
 for(const statement of [sql`update crafting_stocks set market_outgoing=0 where base_id=${f.seller.baseId} and item_id=${f.itemId}`,sql`update crafting_stocks set market_incoming=0 where base_id=${f.buyer.baseId} and item_id=${f.itemId}`,sql`update crafting_stocks set item_id='crownsteel' where base_id=${f.seller.baseId} and item_id=${f.itemId}`,sql`delete from crafting_stocks where base_id=${f.seller.baseId} and item_id=${f.itemId}`])await expect(db.execute(statement)).rejects.toThrow();
 await expect(db.transaction(async tx=>{await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`update crafting_stocks set market_outgoing=9 where base_id=${f.seller.baseId} and item_id=${f.itemId}`);})).rejects.toThrow();
 await conn.sql`insert into keep_equipment_fill_releases(fill_id,reason) values(${fill.id},'never_prepared') on conflict do nothing`;
 await conn.sql`insert into keep_equipment_fill_releases(fill_id,reason) values(${fill.id},'never_prepared') on conflict do nothing`;
 expect(await stock(f.seller.baseId,f.itemId)).toMatchObject({available:'2',market_outgoing:'8'});
 await expect(db.transaction(async tx=>{await tx.execute(sql`set transaction isolation level repeatable read`);await tx.execute(sql`insert into keep_equipment_listings(id,seller_wallet,seller_base_id,item_id,quantity,unit_price_base_units) values(${randomUUID()},${f.seller.wallet},${f.seller.baseId},${f.itemId},1,1000000)`);})).rejects.toThrow();
});
it('sell versus actual equipment craft consumes available refined units at most once',async()=>{
 const f=await fixture('prismstone_lens');await workshop(f);await cancelKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),listingId:f.craftListing.id},f.seller.authority,f.marketDeps);
 await conn.sql`update crafting_stocks set available=2 where base_id=${f.seller.baseId} and item_id=${f.itemId}`;await db.insert(craftingStocks).values({baseId:f.seller.baseId,itemId:'crownsteel',available:2n});
 const results=await Promise.allSettled([createKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),baseId:f.seller.baseId,itemId:f.itemId,quantity:'2',unitPriceBaseUnits:f.listing.unitPriceBaseUnits},f.seller.authority,f.marketDeps),startOrdinaryEquipment(db,f.seller.wallet,{idempotencyKey:randomUUID(),baseId:f.seller.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1},f.seller.authority,{clock:()=>f.seller.now})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const remaining=await stock(f.seller.baseId,f.itemId);expect(BigInt(remaining!.available)+BigInt(remaining!.market_outgoing)).toBeLessThanOrEqual(2n);
});
it('navigation craft output start includes incoming holds, while existing pending completion preserves the reserved capacity',async()=>{
 const f=await fixture('navigation_kit');await workshop(f,f.buyer);await db.insert(craftingStocks).values([{baseId:f.buyer.baseId,itemId:'prismstone_lens',available:1n},{baseId:f.buyer.baseId,itemId:'frostglass',available:1n}]);
 await conn.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.buyer.baseId},'navigation_kit',${(MAX-1n).toString()}::bigint)`;
 const job=await startOrdinaryCrafting(db,f.buyer.wallet,{id:randomUUID(),baseId:f.buyer.baseId,recipeId:'craft_navigation_kit',recipeVersion:1,quantity:1},f.buyer.authority,{clock:()=>f.buyer.now});
 await expect(f.craftFill('1')).rejects.toMatchObject({code:'KEEP_EQUIPMENT_MARKET_CAPACITY'});
 await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.buyer.baseId,job.job.readyAt));expect(await stock(f.buyer.baseId,f.itemId)).toMatchObject({available:MAX.toString(),pending_output:'0'});
 await conn.sql`update crafting_stocks set available=available-1 where base_id=${f.buyer.baseId} and item_id=${f.itemId}`;await f.craftFill('1');
 await expect(startOrdinaryCrafting(db,f.buyer.wallet,{id:randomUUID(),baseId:f.buyer.baseId,recipeId:'craft_navigation_kit',recipeVersion:1,quantity:1},f.buyer.authority,{clock:()=>job.job.readyAt})).rejects.toMatchObject({code:'CRAFTING_STORAGE_FULL'});
});
it('filters catalogue and category before pagination, keeping old stock kinds out of both history and offers',async()=>{
 const f=await fixture('navigation_kit');await conn.sql`update crafting_stocks set available=100 where base_id=${f.seller.baseId} and item_id=${f.itemId}`;
 await conn.sql`insert into ordinary_equipment_stocks(base_id,item_id,available) values(${f.seller.baseId},'survey_lens',1)`;
 const old=await createKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),baseId:f.seller.baseId,itemId:'survey_lens',quantity:'1',unitPriceBaseUnits:f.listing.unitPriceBaseUnits},f.seller.authority,{...f.marketDeps,clock:()=>new Date('2050-01-01T00:00:00Z')});
 for(let n=0;n<C.pageSize+1;n++)await createKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),baseId:f.seller.baseId,itemId:f.itemId,quantity:'1',unitPriceBaseUnits:f.listing.unitPriceBaseUnits},f.seller.authority,{...f.marketDeps,clock:()=>new Date(Date.parse('2050-01-02T00:00:00Z')+n)});
 const v1=await listKeepEquipmentOffers(db,{});expect(v1.items[0]!.id).toBe(old.id);expect(v1.items.every(i=>['route_compass','survey_lens'].includes(i.itemId))).toBe(true);
 const v2=await listKeepEquipmentOffers(db,{catalogueVersion:'2',category:'items',itemId:'navigation_kit'});expect(v2.items).toHaveLength(C.pageSize);expect(v2.nextCursor).not.toBeNull();expect(v2.items.every(i=>i.itemId==='navigation_kit')).toBe(true);
 const history=await listKeepEquipmentHistory(db,f.seller.wallet,{});expect(history.items.every(i=>['route_compass','survey_lens'].includes(i.itemId))).toBe(true);
 const later=await listKeepEquipmentHistory(db,f.seller.wallet,{catalogueVersion:'2',category:'items',itemId:'navigation_kit'});expect(later.items).toHaveLength(C.pageSize);expect(later.nextCursor).not.toBeNull();
});
it('a refused 0249 downgrade and the current journal replay preserve current holds and originals, and rollback restores every stock effect',async()=>{
 const f=await fixture(),fill=await f.craftFill(),before=await stock(f.buyer.baseId,f.itemId),held=await stock(f.seller.baseId,f.itemId),migration=readFileSync(new URL('../drizzle/0249_keep_fragment_market.sql',import.meta.url),'utf8');
 // 0249 was the newest market migration when this case was written. 0253 added
 // crystal_fragment_stocks.mining_pending and 0254-0283 replaced the Divine
 // fragment source, so re-running 0249 now reinstalls its old source and guard
 // bodies; its own 0249-era seal sees the evolved catalog and refuses the whole
 // transaction (the rule keep-fragment-market and mining-funded-v2 already pin).
 // A refused downgrade must leave the holds exact and the current source intact.
 await expect(conn.sql.begin(async tx=>{await tx.unsafe(migration);})).rejects.toMatchObject({code:'P0001',message:'DIVINE_FRAGMENT_SOURCE'});
 expect(await stock(f.buyer.baseId,f.itemId)).toEqual(before);expect(await stock(f.seller.baseId,f.itemId)).toEqual(held);await conn.sql`select public.shardkeep_divine_fragment_source()`;
 // The deploy runner never re-applies journaled SQL: replaying the current
 // journal verifies the applied history, applies nothing and keeps every hold.
 await runMigrations(db);expect(await stock(f.buyer.baseId,f.itemId)).toEqual(before);expect(await stock(f.seller.baseId,f.itemId)).toEqual(held);await conn.sql`select public.shardkeep_divine_fragment_source()`;
 await expect(db.transaction(async tx=>{await tx.execute(sql`insert into keep_equipment_fill_releases(fill_id,reason) values(${fill.id},'never_prepared')`);throw Error('rollback original');})).rejects.toThrow('rollback original');expect(await stock(f.buyer.baseId,f.itemId)).toEqual(before);
});
it('even a granted non-owner role cannot create listings or release original crafting custody',async()=>{
 const f=await fixture(),fill=await f.craftFill(),role='craft_market_'+randomUUID().replaceAll('-',''),password=randomUUID();let low:ReturnType<typeof createDb>|undefined;
 await conn.sql.unsafe(`create role ${role} login password '${password}'`);
 try{await conn.sql.unsafe(`grant usage on schema public to ${role};grant select on all tables in schema public to ${role};grant insert on keep_equipment_listings,keep_equipment_fill_releases to ${role};grant update on crafting_stocks to ${role}`);
  const u=new URL(TEST_DATABASE_URL);u.username=role;u.password=password;low=createDb(u.toString(),{max:1});
  await expect(low.sql`insert into keep_equipment_fill_releases(fill_id,reason) values(${fill.id},'never_prepared')`).rejects.toMatchObject({code:'42501'});
  await expect(low.sql`update crafting_stocks set market_outgoing=0 where base_id=${f.seller.baseId} and item_id=${f.itemId}`).rejects.toThrow();
  expect(await stock(f.seller.baseId,f.itemId)).toMatchObject({market_outgoing:'10'});
 }finally{await low?.sql.end();await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
it('exact failed retained wire releases crafting custody once and keeps its signature permanently consumed',async()=>{
 const f=await fixture('navigation_kit'),fill=await f.craftFill('2'),state=await f.payments.prepare(f.buyer.wallet,fill.id);f.controls.preparation=state.preparation;
 const wire=f.sign(state.preparation!);f.controls.wire=wire;const signed=await f.payments.retainSigned(f.buyer.wallet,fill.id,wire);
 const failed=(connect:typeof f.deps.finalityConnect[number])=>(signal:AbortSignal)=>{const r=connect(signal);return {...r,getTransaction:async(...args:Parameters<typeof r.getTransaction>)=>{const tx=await r.getTransaction(...args);if(!tx)return null;tx.meta!.err={InstructionError:[0,'InvalidArgument']};tx.meta!.postBalances=tx.meta!.preBalances.map((v,i)=>v-(i===0?tx.meta!.fee:0));tx.meta!.postTokenBalances=structuredClone(tx.meta!.preTokenBalances!);tx.meta!.innerInstructions=[];return tx;}};};
 const failureConnect=[failed(f.deps.finalityConnect[0]),failed(f.deps.finalityConnect[1])] as const;
 const release=createKeepEquipmentReleases(db,{trust:f.trust,failureConnect:failureConnect!});const result=await release.release(f.buyer.wallet,fill.id);expect(result).toMatchObject({reason:'finalized_failed',signature:signed.wire!.signature});
 expect(await release.release(f.buyer.wallet,fill.id)).toEqual(result);expect(await stock(f.seller.baseId,f.itemId)).toMatchObject({available:'2',market_outgoing:'8'});expect(await stock(f.buyer.baseId,f.itemId)).toMatchObject({available:'0',market_incoming:'0'});
 expect(await conn.sql`select consumer_id from payment_signature_claims where signature=${signed.wire!.signature}`).toEqual([{consumer_id:fill.id}]);expect((await f.payments.recover(f.buyer.wallet,fill.id)).status).toBe('released');
});

it('legacy stock writers preserve actual market holds without private reads or callable definer authority',async()=>{
 const f=await fixture(),fill=await f.craftFill('2'),role='craft_stock_'+randomUUID().replaceAll('-',''),password=randomUUID();let low:ReturnType<typeof createDb>|undefined;
 const beforeSeller=await stock(f.seller.baseId,f.itemId),beforeBuyer=await stock(f.buyer.baseId,f.itemId);
 await conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to ${role};grant select,insert,update,delete on crafting_stocks to ${role};grant select on deed_economy_cutover_state to ${role}`);
  const u=new URL(TEST_DATABASE_URL);u.username=role;u.password=password;low=createDb(u.toString(),{max:1});
  await low.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.seller.baseId},'thornsilk',2)`;
  await low.sql`update crafting_stocks set available=1 where base_id=${f.seller.baseId} and item_id='thornsilk'`;
  await low.sql`delete from crafting_stocks where base_id=${f.seller.baseId} and item_id='thornsilk'`;
  expect(await stock(f.seller.baseId,'thornsilk')).toBeUndefined();
  // A legitimate old writer keeps both projected reservations intact. Private
  // market rows must stay unreadable while the trigger validates those holds.
  await low.sql`update crafting_stocks set available=available where base_id in(${f.seller.baseId},${f.buyer.baseId}) and item_id=${f.itemId}`;
  await expect(low.sql`update crafting_stocks set market_outgoing=0 where base_id=${f.seller.baseId} and item_id=${f.itemId}`).rejects.toThrow('CRAFTING_MARKET_HOLD_CONSERVATION');
  await expect(low.sql`update crafting_stocks set market_incoming=0 where base_id=${f.buyer.baseId} and item_id=${f.itemId}`).rejects.toThrow('CRAFTING_MARKET_HOLD_CONSERVATION');
  await expect(low.sql`delete from crafting_stocks where base_id=${f.seller.baseId} and item_id=${f.itemId}`).rejects.toThrow('CRAFTING_MARKET_IMMUTABLE');
  for(const table of ['keep_equipment_listings','keep_equipment_fills','keep_equipment_listing_cancellations','keep_equipment_deliveries','keep_equipment_fill_releases'])await expect(low.sql.unsafe(`select * from public.${table}`)).rejects.toMatchObject({code:'42501'});
  await expect(low.sql`select public.shardkeep_crafting_market_stock_guard()`).rejects.toMatchObject({code:'42501'});
  expect(await stock(f.seller.baseId,f.itemId)).toEqual(beforeSeller);expect(await stock(f.buyer.baseId,f.itemId)).toEqual(beforeBuyer);
  expect(await readKeepEquipmentListing(db,f.craftListing.id)).toMatchObject({reservedQuantity:fill.quantity});
  // Even an owner-created trigger cannot redirect the definer to a substitute.
  await conn.sql`create table copied_crafting_market_stock(like public.crafting_stocks including all)`;
  await conn.sql`create trigger crafting_market_stock_guard after insert on copied_crafting_market_stock for each row execute function public.shardkeep_crafting_market_stock_guard()`;
  await expect(conn.sql`insert into copied_crafting_market_stock(base_id,item_id) values(${f.seller.baseId},${f.itemId})`).rejects.toThrow('CRAFTING_MARKET_TRIGGER');
  await conn.sql`create trigger crafting_market_stock_no_truncate after truncate on copied_crafting_market_stock for each statement execute function public.shardkeep_crafting_market_stock_guard()`;
  await expect(conn.sql`truncate copied_crafting_market_stock`).rejects.toThrow('CRAFTING_MARKET_TRIGGER');
  const authority=()=>conn.sql`select p.proowner=c.relowner same_owner,p.prosecdef,p.proconfig,p.proacl::text acl,has_function_privilege('public',p.oid,'execute') public_execute from pg_proc p cross join pg_class c where p.oid='public.shardkeep_crafting_market_stock_guard()'::regprocedure and c.oid='public.crafting_stocks'::regclass`;
  const original=await authority();expect(original).toMatchObject([{same_owner:true,prosecdef:true,proconfig:['search_path=pg_catalog, public, pg_temp'],public_execute:false}]);
  const listing=await readKeepEquipmentListing(db,f.craftListing.id),migration=readFileSync(new URL('../drizzle/0250_crafting_market_legacy_role.sql',import.meta.url),'utf8');
  for(let pass=0;pass<2;pass++)await conn.sql.begin(async tx=>{await tx.unsafe(migration);});
  expect(await authority()).toEqual(original);expect(await readKeepEquipmentListing(db,f.craftListing.id)).toEqual(listing);
  expect(await stock(f.seller.baseId,f.itemId)).toEqual(beforeSeller);expect(await stock(f.buyer.baseId,f.itemId)).toEqual(beforeBuyer);
 }finally{await low?.sql.end();await conn.sql`drop table if exists copied_crafting_market_stock`;await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
