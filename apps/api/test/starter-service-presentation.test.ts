/** Real install/dispatch/return services on the suite's isolated PG16 database.
 * Facility/deed and finalized-term fixtures are explicit, not production provenance.
 * Captures below are serialized getBaseState results, not authenticated HTTP bodies. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Keypair} from '@solana/web3.js';
import {BUILD_COSTS,BuildingType,CAPS} from '@shardkeep/shared';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {bases,baseSlots,builderJobs,buildings,players,resourceStocks,starterExpeditionInflight,starterExpeditionReturns} from '../src/db/schema';
import {getBaseState,placeBuilding} from '../src/game/base';
import {rewardBaseShards} from '../src/game/baseEconomy';
import {assertFreshLockedBaseAuthority,transferStableBase} from '../src/game/baseOwnership';
import {claimRect} from '../src/game/footprints';
import {readStarterExpeditionReturn} from '../src/game/starterExpeditionReturns';
import {installStarterFleet} from '../src/game/starterFleet';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {connectTestDb,createTestPlayer} from './helpers';

const conn=connectTestDb(),db=conn.db;
afterAll(()=>conn.sql.end());
beforeEach(()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','STARTER_EXPEDITIONS_ENABLED','BASE_CLAIM_V1_ENABLED'])vi.stubEnv(flag,'true');});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
type Fixture=Awaited<ReturnType<typeof createStarterExpeditionFixture>>;
const read=(f:Fixture,at=f.now)=>getBaseState(db,f.wallet,at,f.baseId,f.authority.assertAuthority,()=>at);
const presentation=(berthId:string,presence:'occupied'|'away')=>({version:1,berths:[{buildingId:berthId,installation:{family:'starter',presence}}]});
const rollback=new Error('rollback deliberate isolated corruption');

// All impossible source mutations below occur only inside a rolled-back owner
// transaction with local replication disabled. No production guard is changed.
async function corrupt(f:Fixture,mutation:(tx:Parameters<Parameters<typeof db.transaction>[0]>[0])=>Promise<void>,at=f.now){
 await expect(db.transaction(async tx=>{
  await tx.execute(sql`set local session_replication_role=replica`);await mutation(tx);
  await tx.execute(sql`set local session_replication_role=origin`);
  const state=await getBaseState(tx,f.wallet,at,f.baseId,f.authority.assertAuthority,()=>at);
  expect(state.servicePresentation).toBeNull();throw rollback;
 })).rejects.toBe(rollback);
}

describe('authorized starter berth presentation',()=>{
 it('closes every sorted berth including unfinished and level-zero rows, then uses actual paid build completion before install',async()=>{
  const {wallet}=await createTestPlayer(db),claim=claimRect(0),level=BUILD_COSTS.berth.requiresKeepLevel;
  const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:level,builders:CAPS.buildersMax}).returning();const baseId=base!.id;
  await db.insert(baseSlots).values({wallet,baseId,slot:1});
  await db.insert(buildings).values({playerWallet:wallet,baseId,type:BuildingType.Keep,level,tx:claim.min,ty:claim.min});
  const assertAuthority=async(...args:Parameters<typeof assertFreshLockedBaseAuthority>):Promise<void>=>{await assertFreshLockedBaseAuthority(...args);};
  const authority={baseId,assertAuthority};
  await rewardBaseShards(db,baseId,BigInt(BUILD_COSTS.berth.costShards),'test.starter.presentation.place',randomUUID());
  const start=new Date(Date.now()-(BUILD_COSTS.berth.buildSec+1)*1_000);
  const placed=await placeBuilding(db,wallet,BuildingType.Berth,claim.min+4,claim.min,randomUUID(),start,baseId,authority);
  // Extra uninstalled rows exercise snapshot closure only, not placement/cap authority.
  const [zero]=await db.insert(buildings).values({playerWallet:wallet,baseId,type:BuildingType.Berth,level:0,tx:12,ty:12}).returning();
  const before=await getBaseState(db,wallet,start,baseId,authority.assertAuthority,()=>start);
  expect(before.buildings.find(b=>b.id===placed.id)?.underConstruction).toBe(true);
  const empty={version:1,berths:[placed.id,zero!.id].sort().map(buildingId=>({buildingId,installation:null}))};
  expect(before.servicePresentation).toEqual(empty);
  const completed=await getBaseState(db,wallet,new Date(),baseId,authority.assertAuthority);
  expect(completed.buildings.find(b=>b.id===placed.id)?.underConstruction).toBe(false);
  expect(completed.servicePresentation).toEqual(empty);
  const installed=await installStarterFleet(db,wallet,placed.id,authority);
  expect(installed.completedBuildJobId).toBe(completed.starterFleet!.eligibleBerths[0]!.completedBuildJobId);
  const occupied=await getBaseState(db,wallet,new Date(),baseId,authority.assertAuthority);
  expect(occupied.servicePresentation).toEqual({version:1,berths:[placed.id,zero!.id].sort().map(buildingId=>({buildingId,
   installation:buildingId===placed.id?{family:'starter',presence:'occupied'}:null}))});
 });
 it('projects actual occupied, dispatch away and exact-deadline returned states without duplicate settlement',async()=>{
  const f=await createStarterExpeditionFixture(db),occupied=await read(f);expect(occupied.servicePresentation).toEqual(presentation(f.berthId,'occupied'));
  const trip=await f.dispatch(),before=new Date(trip.returnsAt.getTime()-1),away=await read(f,before);
  expect(away.servicePresentation).toEqual(presentation(f.berthId,'away'));expect(await readStarterExpeditionReturn(db,trip.id)).toBeNull();
  const returned=await read(f,trip.returnsAt);expect(returned.servicePresentation).toEqual(presentation(f.berthId,'occupied'));
  expect((await read(f,trip.returnsAt)).servicePresentation).toEqual(returned.servicePresentation);
  expect(await db.select().from(starterExpeditionReturns).where(eq(starterExpeditionReturns.expeditionId,trip.id))).toHaveLength(1);
  expect((await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId,f.baseId),eq(resourceStocks.resourceId,trip.resourceId))))[0]!.available).toBe(trip.net);
  await writeFile('/tmp/starter-service-presentation-primary-pair.json',JSON.stringify({source:{kind:'serialized getBaseState DTO; not HTTP',
   facilities:'existing starterExpeditions fixture completed Berth/Lodge rows; actual installStarterFleet',
   term:'explicit synthetic finalized term reader',transitions:'actual dispatchStarterExpedition and getBaseState deadline settlement',
   sameWallet:f.wallet,sameBase:f.baseId,sameInstallation:f.installationId,tripId:trip.id},occupied,away,returned},(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n');
 });
 it('retains occupied and away observations and accepted returns while new admission is paused',async()=>{
  const f=await createStarterExpeditionFixture(db);vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','false');
  expect((await read(f)).servicePresentation).toEqual(presentation(f.berthId,'occupied'));
  // Direct accepted service fixture supplies its own authority; no public paused POST is claimed.
  const trip=await f.dispatch();expect((await read(f)).servicePresentation).toEqual(presentation(f.berthId,'away'));
  expect((await read(f,trip.returnsAt)).servicePresentation).toEqual(presentation(f.berthId,'occupied'));
 });
 it('keeps the same base away through actual custody transfer and returns to its buyer while refusing the seller',async()=>{
  const f=await createStarterExpeditionFixture(db),trip=await f.dispatch(),buyer=Keypair.generate().publicKey.toBase58();
  await db.insert(players).values({wallet:buyer});
  const deed=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58(),at=new Date(trip.returnsAt.getTime()-1);
  // A real signable fixture buyer is required by custody. Align only Date with
  // the explicit event clock so the following locked ownership read sees fresh evidence.
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);
  // Historical deed identity only; custody itself uses the genuine transfer service.
  await db.update(bases).set({deedAssetId:deed,deedMintAssetId:deed,landPaidAt:f.now}).where(eq(bases.id,f.baseId));
  await transferStableBase(db,f.baseId,f.wallet,buyer,deed,{owner:buyer,collection,frozen:false,delegate:null,slot:100,observedAtMs:at.getTime()},()=>at);
  await expect(read(f,at)).rejects.toMatchObject({code:'BASE_NOT_OWNED'});
  const bought={...f,wallet:buyer};expect((await read(bought,at)).servicePresentation).toEqual(presentation(f.berthId,'away'));
  expect((await read(bought,trip.returnsAt)).servicePresentation).toEqual(presentation(f.berthId,'occupied'));
  expect((await readStarterExpeditionReturn(db,trip.id))!.receipt.custodyWallet).toBe(buyer);
 });
 it('omits the additive presentation from legacy or unprotected reads',async()=>{
  const f=await createStarterExpeditionFixture(db);expect(await getBaseState(db,f.wallet,f.now,f.baseId)).not.toHaveProperty('servicePresentation');
  vi.stubEnv('MULTI_BASE_ENABLED','false');expect(await getBaseState(db,f.wallet,f.now)).not.toHaveProperty('servicePresentation');
 });
 it.each(['foreign-owner','inactive-base','inactive-slot'] as const)('%s cannot receive a protected presentation',async mode=>{
  const f=await createStarterExpeditionFixture(db);
  if(mode==='foreign-owner')f.wallet=(await createTestPlayer(db)).wallet;
  if(mode==='inactive-base')await db.update(bases).set({status:'inactive'}).where(eq(bases.id,f.baseId));
  if(mode==='inactive-slot')await db.update(baseSlots).set({active:false}).where(eq(baseSlots.baseId,f.baseId));
  await expect(read(f)).rejects.toMatchObject({code:'BASE_NOT_OWNED'});
 });
 it('does not turn a missing reservation into an occupied starter, and still propagates due settlement failure',async()=>{
  const f=await createStarterExpeditionFixture(db),trip=await f.dispatch();
  await corrupt(f,async tx=>{await tx.delete(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId,trip.id));});
  await expect(db.transaction(async tx=>{
   await tx.execute(sql`set local session_replication_role=replica`);await tx.delete(starterExpeditionInflight).where(eq(starterExpeditionInflight.expeditionId,trip.id));
   await tx.execute(sql`set local session_replication_role=origin`);
   await getBaseState(tx,f.wallet,trip.returnsAt,f.baseId,f.authority.assertAuthority,()=>trip.returnsAt);
  })).rejects.toThrow('Original expedition vehicle reservation is missing or different');
 });
 it('refuses duplicate unreturned originals instead of selecting an arbitrary presence',async()=>{
  const f=await createStarterExpeditionFixture(db),trip=await f.dispatch();
  await corrupt(f,async tx=>{await tx.execute(sql`insert into public.starter_expeditions select
   (jsonb_populate_record(null::public.starter_expeditions,to_jsonb(e)||jsonb_build_object('id',${randomUUID()}::text))).*
   from public.starter_expeditions e where e.id=${trip.id}`);});
 });
 it('refuses a reservation for a different installation rather than inferring occupied from an empty current flight',async()=>{
  const f=await createStarterExpeditionFixture(db),other=await createStarterExpeditionFixture(db),trip=await f.dispatch();
  await corrupt(f,async tx=>{await tx.update(starterExpeditionInflight).set({installationId:other.installationId}).where(eq(starterExpeditionInflight.expeditionId,trip.id));});
 });
 it('refuses a returned original whose reservation survives instead of displaying away',async()=>{
  const f=await createStarterExpeditionFixture(db),trip=await f.dispatch();await read(f,trip.returnsAt);
  await corrupt(f,async tx=>{await tx.insert(starterExpeditionInflight).values({installationId:f.installationId,expeditionId:trip.id});},trip.returnsAt);
 });
 it('propagates mandatory original berth proof failure without fabricating a presentation',async()=>{
  const f=await createStarterExpeditionFixture(db);
  await expect(db.transaction(async tx=>{
   await tx.execute(sql`set local session_replication_role=replica`);await tx.delete(builderJobs).where(eq(builderJobs.buildingId,f.berthId));
   await tx.execute(sql`set local session_replication_role=origin`);await getBaseState(tx,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now);
  })).rejects.toThrow('Invalid current starter berth proof');
 });
});
