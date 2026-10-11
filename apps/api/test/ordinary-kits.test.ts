/** D153.208 real SQL/ledger conversion. Synthetic custody/facility and boundary
 * material seeds below do not claim earned provenance; the source fixture does. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {Keypair} from '@solana/web3.js';
import Fastify from 'fastify';
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {BUILD_COSTS,BuildingType,PHASE_E_ORDINARY_CRAFTING_V2 as P,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as M} from '@shardkeep/shared';
import {ORDINARY_RECIPE_IDS,ORDINARY_RECIPE_IDS_V2,ordinaryCraftingRecipe,type OrdinaryRecipeId} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {OrdinaryCraftingViewSchema} from '@shardkeep/shared/ordinaryCraftingApi';
import {RAW_RESOURCE_STORAGE_MAX as MAX} from '@shardkeep/shared/phaseEResources';
import {bases,baseSlots,buildings,builderJobs,craftingStocks,ordinaryCraftingInputs,ordinaryCraftingJobs} from '../src/db/schema';
import {HttpError} from '../src/lib/errors';
import {getBaseState} from '../src/game/base';
import {getBaseShardBalance,rewardBaseShards,spendBaseShards} from '../src/game/baseEconomy';
import {startOrdinaryCrafting,readOrdinaryCrafting,settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {readOrdinaryCraftingEnvelope} from '../src/game/ordinaryCraftingView';
import {registerOrdinaryCraftingRoutes} from '../src/game/ordinaryCraftingRoutes';
import {createKeepEquipmentListing,reserveKeepEquipmentFill,cancelKeepEquipmentListing} from '../src/game/keepEquipmentMarket';
import {listKeepEquipmentOffers,listKeepEquipmentHistory} from '../src/game/keepEquipmentMarketDiscovery';
import {createKeepEquipmentMarketProvider} from '../src/game/keepEquipmentMarketProvider';
import {createKeepEquipmentReleases} from '../src/game/keepEquipmentReleases';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {paymentFixture,transferPaymentBase} from './fixtures/keepEquipmentPayments';
import {ordinaryKitsSource} from './fixtures/ordinaryKitsSource';
const conn=resourceClaimsDatabase(),db=conn.db;
beforeAll(()=>conn.setup(),120000);afterAll(()=>conn.close());
beforeEach(()=>{for(const key of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','KEEP_EQUIPMENT_MARKET_ENABLED'])vi.stubEnv(key,'true');});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(recipe:OrdinaryRecipeId='craft_expedition_kit',quantity=1,shards=true){
 const f=await createStarterExpeditionFixture(db,{now:new Date()});
 const [b]=await db.insert(buildings).values({baseId:f.baseId,playerWallet:f.wallet,type:BuildingType.Workshop,tx:9,ty:2}).returning();
 const completedAt=new Date(+f.now-1000);await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:b!.id,kind:'build',startedAt:new Date(+completedAt-BUILD_COSTS.workshop.buildSec*1000),finishesAt:completedAt,completedAt});
 const snapshot=ordinaryCraftingRecipe(recipe,2,quantity);for(const i of snapshot.inputs){if(i.kind==='crafting')await db.insert(craftingStocks).values({baseId:f.baseId,itemId:i.itemId,available:BigInt(i.quantity)});if(i.kind==='shards'&&shards)await rewardBaseShards(db,f.baseId,BigInt(i.quantity),'ordinary-kits.fixture-earning',randomUUID());}
 const command={id:randomUUID(),baseId:f.baseId,recipeId:recipe,recipeVersion:2,quantity};
 return {...f,command,snapshot,start:(id=command.id)=>startOrdinaryCrafting(db,f.wallet,{...command,id},f.authority,{clock:()=>f.now})};
}
const stock=(baseId:string,itemId:string)=>db.query.craftingStocks.findFirst({where:and(eq(craftingStocks.baseId,baseId),eq(craftingStocks.itemId,itemId))});
const finish=(baseId:string,at:Date)=>db.transaction(tx=>settleDueOrdinaryCrafting(tx,baseId,at));
it('pins exact old and new immutable SQL recipes including maximum batch and SHARDS ingredient',()=>{
 const old=readFileSync(new URL('../drizzle/0147_ordinary_crafting.sql',import.meta.url),'utf8'),next=readFileSync(new URL('../drizzle/0267_ordinary_kits.sql',import.meta.url),'utf8');
 for(const id of ORDINARY_RECIPE_IDS)expect(old).toContain(JSON.stringify(ordinaryCraftingRecipe(id,1,1)));
 for(const id of ORDINARY_RECIPE_IDS_V2)expect(next).toContain(JSON.stringify(ordinaryCraftingRecipe(id,2,1)));
 expect(next).toContain(`NEW.quantity NOT BETWEEN 1 AND ${P.maxBatch}`);
});
it.each(['craft_climate_kit','craft_expedition_kit'] as const)('%s q10 consumes exact original inputs and once-only original-base output',async recipe=>{
 const f=await fixture(recipe,P.maxBatch),proof=await f.start();expect(proof.job.recipeSnapshot).toEqual(f.snapshot);
 for(const i of f.snapshot.inputs)if(i.kind==='crafting')expect((await stock(f.baseId,i.itemId))!.available).toBe(0n);
 expect((await stock(f.baseId,f.snapshot.output.itemId))!).toMatchObject({available:0n,pendingOutput:BigInt(f.snapshot.output.quantity)});
 const ledger=await conn.sql`select t.*,e.delta::text,a.kind,a.currency,a.base_id from ordinary_crafting_inputs i join ledger_transactions t on t.id=i.shards_ledger_txn_id join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id where i.job_id=${proof.job.id}`;
 if(recipe==='craft_expedition_kit'){expect(ledger).toHaveLength(2);expect(ledger.map(x=>x.kind).sort()).toEqual(['base_shards','shard_burn']);expect(await getBaseShardBalance(db,f.baseId)).toBe(0n);}else expect(ledger).toHaveLength(0);
 await finish(f.baseId,proof.job.readyAt);expect(await finish(f.baseId,proof.job.readyAt)).toEqual([]);expect(await f.start()).toMatchObject({job:{id:proof.job.id},completion:{custodyWallet:f.wallet}});
 expect((await stock(f.baseId,f.snapshot.output.itemId))!).toMatchObject({available:BigInt(f.snapshot.output.quantity),pendingOutput:0n});
});
it('missing final SHARDS rolls back already deducted material, job, output and ledger; no ingredient becomes a fee',async()=>{
 const f=await fixture('craft_expedition_kit',1,false),before=await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId));
 await expect(f.start()).rejects.toMatchObject({code:'ledger.insufficient_funds'});
 expect(await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId))).toEqual(before);expect(await readOrdinaryCrafting(db,f.command.id)).toBeNull();
 expect(await conn.sql`select id from ledger_transactions where idempotency_key=${`ordinary-crafting:${f.command.id}:shards`}`).toEqual([]);
});
it('identical concurrent commands share one debit and distinct commands cannot spend one material twice',async()=>{
 const f=await fixture();const same=await Promise.all([f.start(),f.start()]);expect(same[0]).toEqual(same[1]);
 await expect(f.start(randomUUID())).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
 expect(await conn.sql`select id from ledger_transactions where idempotency_key=${`ordinary-crafting:${f.command.id}:shards`}`).toHaveLength(1);
});
it('changed recipe1 identities cannot admit a new kit and unsupported versions retain an explicit refusal',async()=>{
 const f=await fixture();for(const version of [1,3])await expect(startOrdinaryCrafting(db,f.wallet,{...f.command,recipeVersion:version},f.authority)).rejects.toMatchObject({code:'ORDINARY_RECIPE_CHANGED'});
 expect(await readOrdinaryCrafting(db,f.command.id)).toBeNull();
});
it('pending original and SHARDS proof survive pause, new custody, lost response and cold database reopen',async()=>{
 const f=await fixture(),proof=await f.start(),newWallet=Keypair.generate().publicKey.toBase58();await conn.sql`insert into players(wallet) values(${newWallet})`;
 await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:newWallet,status:'inactive'}).where(eq(bases.id,f.baseId));});
 vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');const reopened=conn.reopen();try{expect(await startOrdinaryCrafting(reopened.db,f.wallet,f.command,f.authority)).toEqual(proof);}finally{await reopened.sql.end();}
 await finish(f.baseId,proof.job.readyAt);expect((await readOrdinaryCrafting(db,f.command.id))!.completion!.custodyWallet).toBe(newWallet);expect(await getBaseShardBalance(db,f.baseId)).toBe(0n);
});
it('no unbound, replayed or modified SHARDS ledger proof can create a kit',async()=>{
 const f=await fixture();await expect(spendBaseShards(db,f.baseId,1n,'ordinary.crafting.shards',`ordinary-crafting:${randomUUID()}:shards`,{})).rejects.toThrow('ORDINARY_CRAFTING_SHARDS_UNBOUND');
 const p=await f.start(),ledger=p.inputs.find(i=>i.kind==='shards')!;
 await expect(db.update(ordinaryCraftingInputs).set({quantity:1n}).where(eq(ordinaryCraftingInputs.jobId,p.job.id))).rejects.toMatchObject({cause:{code:'23514'}});
 await expect(conn.sql`update ledger_transactions set metadata='{}'::jsonb where id=${ledger.shardsLedgerTxnId!}`).rejects.toThrow();
 await expect(db.delete(ordinaryCraftingInputs).where(eq(ordinaryCraftingInputs.jobId,p.job.id))).rejects.toMatchObject({cause:{code:'23514'}});
 expect(await readOrdinaryCrafting(db,p.job.id)).toEqual(p);
});
it('old explicit discovery refuses a pending v2 job while generic base stays usable and v2 shows SHARDS',async()=>{
 const f=await fixture(),proof=await f.start();
 await expect(getBaseState(db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now,1)).rejects.toMatchObject({code:'ORDINARY_CRAFTING_CLIENT_UPDATE_REQUIRED'});
 const generic=await getBaseState(db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now);expect(generic.craftingStock).toHaveLength(9);expect(generic).not.toHaveProperty('ordinaryCrafting');
 const modern=await getBaseState(db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now,2);expect(modern.craftingStock).toHaveLength(11);expect(modern.craftingShardsAvailable).toBe('0');expect(modern.ordinaryCrafting!.pendingJobs[0]!.jobId).toBe(proof.job.id);
});
it('catalogue HTTP opt-in preserves exact old shape and authoritative selected-base SHARDS',async()=>{
 const f=await fixture(),app=Fastify();app.decorate('authenticate',async(req: {wallet:string})=>{req.wallet=f.wallet;});app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof HttpError?error.statusCode:500).send({code:(error as HttpError).code}));registerOrdinaryCraftingRoutes(app,db);await app.ready();
 try{const old=await app.inject({url:`/ordinary-crafting?baseId=${f.baseId}`}),newer=await app.inject({url:`/ordinary-crafting?baseId=${f.baseId}&catalogueVersion=2`});expect(old.statusCode).toBe(200);expect(newer.statusCode).toBe(200);expect(old.json()).not.toHaveProperty('catalogueVersion');expect(old.json()).not.toHaveProperty('shardsAvailable');expect(OrdinaryCraftingViewSchema.parse(old.json()).recipes).toHaveLength(9);expect(OrdinaryCraftingViewSchema.parse(newer.json())).toMatchObject({catalogueVersion:2,shardsAvailable:String(P.expeditionKit.shardsPerOutput)});
  await f.start();expect((await app.inject({url:`/ordinary-crafting?baseId=${f.baseId}`})).json()).toMatchObject({code:'ORDINARY_CRAFTING_CLIENT_UPDATE_REQUIRED'});
 }finally{await app.close();}
});
it('even a granted non-owner cannot insert an ingredient posting',async()=>{
 const role='ordinary_kits_'+randomUUID().replaceAll('-','');await conn.sql.unsafe(`create role ${role} nosuperuser nocreatedb nocreaterole noinherit`);
 try{await expect(conn.sql.begin(async tx=>{
  await tx.unsafe(`grant usage on schema public to ${role};grant select on ledger_transactions,ordinary_crafting_jobs to ${role};grant insert on ledger_transactions to ${role};set local role ${role}`);
  await tx`insert into ledger_transactions(idempotency_key,type) values(${`ordinary-crafting:${randomUUID()}:shards`},'ordinary.crafting.shards')`;
 })).rejects.toMatchObject({code:'42501'});
 }finally{await conn.sql.unsafe(`drop role ${role}`);}
});
it('earned common raw -> refining -> untaxed daily cache SHARDS -> both kits -> exact HTTP original replay',async()=>{
 const f=await ordinaryKitsSource(conn);expect(f.shardsBefore).toBe(f.cache.amount);
 expect(await getBaseShardBalance(db,f.seller.baseId)).toBe(f.shardsBefore-BigInt(P.expeditionKit.shardsPerOutput*2));
 for(const id of ['climate_kit','expedition_kit'])expect((await stock(f.seller.baseId,id))!).toMatchObject({available:2n,pendingOutput:0n});
 const app=Fastify();app.decorate('authenticate',async(req:{wallet:string})=>{req.wallet=f.seller.wallet;});registerOrdinaryCraftingRoutes(app,db,{market:{finalizedDeedReader:f.deedReader,deedCollection:f.collection}});await app.ready();
 try{const view=await app.inject({url:`/ordinary-crafting?baseId=${f.seller.baseId}&catalogueVersion=2`}),legacy=await app.inject({url:`/ordinary-crafting?baseId=${f.seller.baseId}`});expect(view.statusCode).toBe(200);expect(legacy.statusCode).toBe(200);OrdinaryCraftingViewSchema.parse(view.json());
  const receipts=await Promise.all(f.receipts.map(p=>readOrdinaryCraftingEnvelope(db,f.seller.wallet,p.job.id)));
  writeFileSync('/tmp/ordinary-kits-http-pair.json',JSON.stringify({scope:'actual earned common-route raw, real refining, untaxed cache ledger, kit conversion and authenticated HTTP; fixture facilities/deed/term authority',view:view.json(),legacy:legacy.json(),receipts,cache:{amount:f.cache.amount.toString()},shardsBefore:f.shardsBefore.toString()},null,2));
 }finally{await app.close();}
},60000);
async function marketFixture(itemId:'climate_kit'|'expedition_kit'='climate_kit'){
 const f=await paymentFixture(conn);await db.insert(craftingStocks).values({baseId:f.seller.baseId,itemId,available:BigInt(M.pageSize+3)});
 const deps={clock:()=>f.seller.now,assertAdmission:()=>undefined};const request={idempotencyKey:randomUUID(),baseId:f.seller.baseId,itemId,quantity:'2',unitPriceBaseUnits:f.listing.unitPriceBaseUnits};
 return {...f,itemId,deps,request};
}
it.each(['climate_kit','expedition_kit'] as const)('%s shares original partial KEEP custody, cancel and providerless release',async itemId=>{
 const f=await marketFixture(itemId),listing=await createKeepEquipmentListing(db,f.seller.wallet,f.request,f.seller.authority,f.deps);
 const fill=await reserveKeepEquipmentFill(db,f.buyer.wallet,{idempotencyKey:randomUUID(),listingId:listing.id,buyerBaseId:f.buyer.baseId,quantity:'1'},{buyer:f.buyer.authority,seller:f.seller.authority},f.deps);
 await cancelKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),listingId:listing.id},f.seller.authority,f.deps);
 await transferPaymentBase(conn,f.seller);await transferPaymentBase(conn,f.buyer);const release=createKeepEquipmentReleases(db);const original=await release.release(f.buyer.wallet,fill.id);expect(await release.release(f.buyer.wallet,fill.id)).toEqual(original);
 expect((await stock(f.seller.baseId,itemId))!).toMatchObject({available:BigInt(M.pageSize+3),marketOutgoing:0n});expect((await stock(f.buyer.baseId,itemId))!).toMatchObject({available:0n,marketIncoming:0n});
});
it('version4 item filter runs before pagination; old omitted/2/3 stay frozen and stock4 contains14',async()=>{
 const f=await marketFixture();for(let i=0;i<M.pageSize+1;i++)await createKeepEquipmentListing(db,f.seller.wallet,{...f.request,idempotencyKey:randomUUID(),quantity:'1'},f.seller.authority,f.deps);
 for(const q of [{},{catalogueVersion:'2'},{catalogueVersion:'3'}])expect((await listKeepEquipmentOffers(db,q)).items.some(i=>i.itemId==='climate_kit')).toBe(false);
 const offers=await listKeepEquipmentOffers(db,{catalogueVersion:'4',category:'items',itemId:'climate_kit'});expect(offers.items).toHaveLength(M.pageSize);expect(offers.nextCursor).not.toBeNull();expect(offers.items.every(i=>i.itemId==='climate_kit')).toBe(true);
 expect((await listKeepEquipmentHistory(db,f.seller.wallet,{catalogueVersion:'3'})).items.some(i=>i.itemId==='climate_kit')).toBe(false);
 expect((await listKeepEquipmentHistory(db,f.seller.wallet,{catalogueVersion:'4',itemId:'climate_kit'})).items).toHaveLength(M.pageSize);
 const provider=createKeepEquipmentMarketProvider(db,{finalizedDeedReader:async()=>({owner:f.seller.wallet,collection:f.seller.collection,frozen:false,delegate:null,slot:101}),deedCollection:f.seller.collection});
 for(const [catalogueVersion,count] of [[undefined,2],['2',11],['3',12],['4',14]] as const){const view=await provider.stock(f.seller.wallet,{baseId:f.seller.baseId,...(catalogueVersion?{catalogueVersion}:{})});expect(view.items).toHaveLength(count);}
});
it('kit pending output and incoming market capacity cannot overbook int64 storage',async()=>{
 const f=await fixture('craft_climate_kit'),market=await marketFixture();await db.insert(craftingStocks).values({baseId:f.baseId,itemId:'climate_kit',available:MAX});await expect(f.start()).rejects.toMatchObject({code:'CRAFTING_STORAGE_FULL'});
 await db.update(craftingStocks).set({available:MAX-1n}).where(and(eq(craftingStocks.baseId,f.baseId),eq(craftingStocks.itemId,'climate_kit')));const proof=await f.start();await finish(f.baseId,proof.job.readyAt);expect((await stock(f.baseId,'climate_kit'))!.available).toBe(MAX);
 const listing=await createKeepEquipmentListing(db,market.seller.wallet,market.request,market.seller.authority,market.deps);await db.insert(craftingStocks).values({baseId:market.buyer.baseId,itemId:'climate_kit',available:MAX});
 await expect(reserveKeepEquipmentFill(db,market.buyer.wallet,{idempotencyKey:randomUUID(),listingId:listing.id,buyerBaseId:market.buyer.baseId,quantity:'1'},{buyer:market.buyer.authority,seller:market.seller.authority},market.deps)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_MARKET_CAPACITY'});
});

it.each(['amount','wallet','base','type','position'] as const)('SQL rejects a %s-mismatched ledger even when a caller supplies a full recipe',async mismatch=>{
 const f=await fixture(),other=await fixture(),reference=await f.start();await finish(f.baseId,reference.job.readyAt);
 await rewardBaseShards(db,f.baseId,BigInt(P.expeditionKit.shardsPerOutput),'ordinary-kits.fixture-earning',randomUUID());
 const id=randomUUID(),quantity=BigInt(P.expeditionKit.shardsPerOutput),position=reference.inputs.find(i=>i.kind==='shards')!.position;
 await expect(db.transaction(async tx=>{
  const posted=await spendBaseShards(tx,mismatch==='base'?other.baseId:f.baseId,mismatch==='amount'?quantity-1n:quantity,mismatch==='type'?'wrong.ingredient':'ordinary.crafting.shards',`ordinary-crafting:${id}:shards`,{jobId:id,wallet:mismatch==='wallet'?other.wallet:f.wallet,position:mismatch==='position'?position-1:position,quantity:quantity.toString()});
  await tx.insert(ordinaryCraftingJobs).values({...reference.job,id,completedAt:null});
  for(const input of reference.inputs)await tx.insert(ordinaryCraftingInputs).values({...input,jobId:id,shardsLedgerTxnId:input.kind==='shards'?posted.transaction.id:null});
 })).rejects.toThrow('ORDINARY_CRAFTING_SHARDS_PROOF');
 expect(await readOrdinaryCrafting(db,id)).toBeNull();expect(await getBaseShardBalance(db,f.baseId)).toBe(quantity);
});
it('a forged v2 job is refused for a granted runtime role without changing source ACLs',async()=>{
 const f=await fixture(),p=await f.start(),role='ordinary_job_'+randomUUID().replaceAll('-','');await conn.sql.unsafe(`create role ${role} nosuperuser noinherit`);
 // 2026-10-10 (CI 37503885235): 0278 (bound cosmetics, 409b2aff0) added the SECURITY DEFINER
 // bound_cosmetic_workshop_guard, which sorts before the crafting guard and refuses any job on a base with an
 // unfinished one (P0001 BOUND_COSMETIC_WORKSHOP_BUSY). Finish the original first so the forged copy reaches
 // the privilege boundary this case is about: a granted runtime role still gets 42501, never a job.
 await finish(f.baseId,p.job.readyAt);
 try{await expect(conn.sql.begin(async tx=>{await tx.unsafe(`grant usage on schema public to ${role};grant select,insert on ordinary_crafting_jobs to ${role};set local role ${role}`);
  await tx`insert into ordinary_crafting_jobs select ${randomUUID()}::uuid,actor_wallet,base_id,recipe_id,recipe_version,quantity,recipe_snapshot,output_item_id,output_quantity,workshop_id,workshop_completed_job_id,started_at,ready_at,completed_at from ordinary_crafting_jobs where id=${p.job.id}`;
 })).rejects.toMatchObject({code:'42501'});
 }finally{await conn.sql.unsafe(`drop role ${role}`);}
});
it('listing versus a new kit ingredient serializes to one consumption',async()=>{
 const market=await marketFixture(),f=market.seller;
 const [b]=await db.insert(buildings).values({baseId:f.baseId,playerWallet:f.wallet,type:BuildingType.Workshop,tx:9,ty:2}).returning();const completedAt=new Date(+f.now-1000);await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:b!.id,kind:'build',startedAt:new Date(+completedAt-BUILD_COSTS.workshop.buildSec*1000),finishesAt:completedAt,completedAt});
 await db.insert(craftingStocks).values([{baseId:f.baseId,itemId:'sunstone_blocks',available:1n},{baseId:f.baseId,itemId:'embercore',available:1n}]);
 const results=await Promise.allSettled([createKeepEquipmentListing(db,f.wallet,{...market.request,idempotencyKey:randomUUID(),itemId:'sunstone_blocks',quantity:'1'},f.authority,market.deps),startOrdinaryCrafting(db,f.wallet,{id:randomUUID(),baseId:f.baseId,recipeId:'craft_climate_kit',recipeVersion:2,quantity:1},f.authority,{clock:()=>f.now})]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await stock(f.baseId,'sunstone_blocks'))!.available).toBe(0n);
});
