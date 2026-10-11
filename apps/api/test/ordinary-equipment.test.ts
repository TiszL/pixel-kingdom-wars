/** D153.188 actual earned raw -> refined -> durable stock -> fitted return. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,afterEach,beforeEach,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {BUILD_COSTS,BuildingType,PHASE_E_ORDINARY_CRAFTING as C} from '@shardkeep/shared';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {OrdinaryEquipmentEnvelopeSchema,OrdinaryEquipmentViewSchema} from '@shardkeep/shared/ordinaryEquipmentApi';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {connectTestDb,createTestPlayer} from './helpers';
import {captureLatestBoundary,restoreLatestBoundary} from './fixtures/latestBoundary';
import {bases,baseSlots,buildings,builderJobs,craftingStocks} from '../src/db/schema';
import {startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {ordinaryEquipmentEnvelope,startOrdinaryEquipment,readOrdinaryEquipmentView} from '../src/game/ordinaryEquipment';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions,readStarterExpeditionReturn} from '../src/game/starterExpeditionReturns';
import {starterExpeditionEnvelope} from '../src/game/starterExpeditionView';
const conn=connectTestDb(),db=conn.db,fitting={itemId:'route_compass',policyVersion:1} as const;
beforeEach(()=>{for(const name of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(name,'true');});
afterEach(()=>vi.unstubAllEnvs());afterAll(()=>conn.sql.end());
async function fixture(){
 const f=await createStarterExpeditionFixture(db,{now:new Date(Date.now()-3*86400000)}),at=new Date(+f.now-1000);
 const [workshop]=await db.insert(buildings).values({baseId:f.baseId,playerWallet:f.wallet,type:BuildingType.Workshop,tx:9,ty:2}).returning();
 await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:workshop!.id,kind:'build',startedAt:new Date(+at-BUILD_COSTS.workshop.buildSec*1000),finishesAt:at,completedAt:at});
 const request={idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1} as const;
 return {...f,request};
}
type F=Awaited<ReturnType<typeof fixture>>;
const start=(f:F,request=f.request)=>startOrdinaryEquipment(db,f.wallet,request,f.authority,{clock:()=>f.now});
const settle=(f:F,at=f.now)=>db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,at));
const stock=(f:F)=>db.execute(sql`select available::text,reserved::text,pending_output::text from ordinary_equipment_stocks where base_id=${f.baseId}`);
async function materials(f:F){for(const i of ordinaryEquipmentRecipe().inputs)await db.insert(craftingStocks).values({baseId:f.baseId,itemId:i.itemId,available:BigInt(i.quantity)});}
async function ready(f:F){await materials(f);const p=await start(f);if(p.status!=='accepted')throw Error('fixture');f.now=new Date(p.receipt.readyAt);await settle(f);return p;}
async function fitted(f:F){const preview=starterRoutePreview('crownlands','coastal_survey'),cmd={...f.command,id:randomUUID(),routeId:preview.routeId,routeVersion:preview.routeCatalogueVersion,rewardVersion:preview.rewardTableVersion,fitting};return {cmd,trip:await dispatchStarterExpedition(db,f.wallet,cmd,f.authority,{reader:f.reader,clock:()=>f.now})};}
it('earns both materials on actual common routes, refines, crafts and returns the same reusable tool',async()=>{
 const f=await fixture();
 for(const [routeId,recipeId] of [['common_seeker_reach','refine_prismstone_lens'],['common_crownlands','refine_crownsteel']] as const){
  const r=starterRoutePreview('crownlands',routeId);const need=BigInt(C.v1.refining.rawPerOutput)*BigInt(ordinaryEquipmentRecipe().inputs.find(i=>i.itemId===recipeId.slice(7))!.quantity);
  let earned=0n;while(earned<need){const trip=await dispatchStarterExpedition(db,f.wallet,{...f.command,id:randomUUID(),routeId,routeVersion:r.routeCatalogueVersion,rewardVersion:r.rewardTableVersion},f.authority,{reader:f.reader,clock:()=>f.now});f.now=trip.returnsAt;await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,f.now));earned+=trip.net;}
  const job=await startOrdinaryCrafting(db,f.wallet,{id:randomUUID(),baseId:f.baseId,recipeId,recipeVersion:C.currentRecipeVersion,quantity:Number(need/BigInt(C.v1.refining.rawPerOutput))},f.authority,{clock:()=>f.now});f.now=job.job.readyAt;await settle(f);
 }
 const craft=await start(f);expect(OrdinaryEquipmentEnvelopeSchema.parse(craft).status).toBe('accepted');if(craft.status!=='accepted')throw Error();f.now=new Date(craft.receipt.readyAt);await settle(f);expect(await stock(f)).toEqual([{available:'1',reserved:'0',pending_output:'0'}]);
 const {trip}=await fitted(f);expect(await stock(f)).toEqual([{available:'0',reserved:'1',pending_output:'0'}]);await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,trip.returnsAt));expect(await stock(f)).toEqual([{available:'1',reserved:'0',pending_output:'0'}]);expect((await readStarterExpeditionReturn(db,trip.id))!.entries.reduce((n,e)=>n+e.delta,0n)).toBe(0n);
});
it('serializes exact retry and workshop queues and rolls back insufficient second material',async()=>{
 const f=await fixture();await db.insert(craftingStocks).values({baseId:f.baseId,itemId:'prismstone_lens',available:2n});await expect(start(f)).rejects.toThrow();expect((await db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId)))[0]!.available).toBe(2n);expect(await stock(f)).toEqual([]);
 await db.insert(craftingStocks).values({baseId:f.baseId,itemId:'crownsteel',available:2n});const responses=await Promise.all([start(f),start(f)]);expect(responses[0]!.receipt).toEqual(responses[1]!.receipt);
 await expect(start(f,{...f.request,idempotencyKey:randomUUID()})).rejects.toThrow();await expect(startOrdinaryCrafting(db,f.wallet,{id:randomUUID(),baseId:f.baseId,recipeId:'refine_crownsteel',recipeVersion:1,quantity:1},f.authority,{clock:()=>f.now})).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
});
it('holds a corrupted reservation and leaves cargo and reusable stock atomic on rollback',async()=>{
 const f=await fixture();await ready(f);const {trip}=await fitted(f);
 await db.execute(sql`update ordinary_equipment_stocks set reserved=0 where base_id=${f.baseId}`);
 await expect(db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,trip.returnsAt))).rejects.toThrow();expect(await readStarterExpeditionReturn(db,trip.id)).toBeNull();
 expect(await stock(f)).toEqual([{available:'0',reserved:'0',pending_output:'0'}]);await db.execute(sql`update ordinary_equipment_stocks set reserved=1 where base_id=${f.baseId}`);await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,trip.returnsAt));expect(await stock(f)).toEqual([{available:'1',reserved:'0',pending_output:'0'}]);
});
it('preserves fitting consent through paused exact replay and rejects different fitting',async()=>{
 const f=await fixture();await ready(f);const {cmd,trip}=await fitted(f);vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');
 expect(await dispatchStarterExpedition(db,f.wallet,cmd,f.authority)).toEqual(trip);const {fitting:_,...changed}=cmd;await expect(dispatchStarterExpedition(db,f.wallet,changed,f.authority)).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
 const e=await starterExpeditionEnvelope(db,f.wallet,trip.id);expect(e.status==='accepted'&&e.receipt.request.fitting).toEqual(fitting);
 await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,trip.returnsAt));expect(await stock(f)).toEqual([{available:'1',reserved:'0',pending_output:'0'}]);
});
it.each(['craft','away'] as const)('carries %s stock with stable base while old actor history stays private',async phase=>{
 const f=await fixture();await materials(f);const craft=await start(f);if(craft.status!=='accepted')throw Error();f.now=new Date(craft.receipt.readyAt);let trip:Awaited<ReturnType<typeof fitted>>|undefined;
 if(phase==='away'){await settle(f);trip=await fitted(f);f.now=trip.trip.returnsAt;}
 const buyer=await createTestPlayer(db);await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));});
 vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');await settle(f);if(trip)await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,f.now));expect(await stock(f)).toEqual([{available:'1',reserved:'0',pending_output:'0'}]);expect((await ordinaryEquipmentEnvelope(db,buyer.wallet,f.request.idempotencyKey)).status).toBe('unknown');expect((await ordinaryEquipmentEnvelope(db,f.wallet,f.request.idempotencyKey)).status).toBe('accepted');
 if(trip)expect((await starterExpeditionEnvelope(db,buyer.wallet,trip.trip.id)).status).toBe('unknown');
});
it('retains immutable recipe and terminal evidence through migration replay and forbids forged release',async()=>{
 const f=await fixture();await ready(f);const {trip}=await fitted(f);await expect(db.execute(sql`insert into ordinary_equipment_releases(trip_kind,expedition_id,base_id,return_id) values('starter',${trip.id},${f.baseId},${randomUUID()})`)).rejects.toThrow();
 const boundary=await captureLatestBoundary(conn.sql);
 const before=await stock(f);for(let pass=0;pass<2;pass++)await db.transaction(async tx=>{for(const statement of readFileSync(new URL('../drizzle/0239_ordinary_equipment.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.execute(sql.raw(statement));});expect(await stock(f)).toEqual(before);
 // 0257 holds the downgraded starter guard after 0239 replay. Restore the
 // accepted Lens guard and boundary attributes; never reseal downgraded code.
 await expect(db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,trip.returnsAt))).rejects.toThrow();
 expect(await readStarterExpeditionReturn(db,trip.id)).toBeNull();
 const replay=(file:string)=>db.transaction(async tx=>{for(const statement of readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.execute(sql.raw(statement));});
 // 2026-10-10 (CI 37503885235): the 0240->0256 forward replay no longer reaches the latest boundary. 0278 added the
 // workshop trigger to 0256's sealed relations and 0279 superseded its seal, so 0256 refuses as a downgrade
 // (dd92d0f16) and the replayed bodies stayed installed for the rest of the shard. Restore the exact catalog
 // this test found and prove the newest whole-system seal accepts it; downgraded code is never resealed.
 await replay('0240_survey_lens.sql');await expect(replay('0256_advanced_return_capability.sql')).rejects.toMatchObject({cause:{message:'ADVANCED_RETURN_SOURCE_CHANGED'}});
 await restoreLatestBoundary(conn.sql,boundary);expect(await captureLatestBoundary(conn.sql)).toEqual(boundary);await conn.sql`select public.shardkeep_divine_fragment_source()`;
 await expect(db.execute(sql`delete from ordinary_equipment_reservations where expedition_id=${trip.id}`)).rejects.toThrow();await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,trip.returnsAt));
 const view=await db.transaction(tx=>readOrdinaryEquipmentView(tx,f.wallet,f.baseId,trip.returnsAt));expect(OrdinaryEquipmentViewSchema.parse(view).equipmentStock[0]!.available).toBe('1');
});
