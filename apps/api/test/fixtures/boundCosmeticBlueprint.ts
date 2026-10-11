/** Real-source Blueprint eligibility context: an owned disposable database with
 * starter bases, completed Workshops, explicit raw stock, ACTUAL ordinary crafting
 * jobs started and settled through the production writers, RECORDED stable-base
 * transfers through transferStableBase, a non-owner reader role and superuser
 * proof helpers that exist only to prove refusal. Never imported by production. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {BUILD_COSTS,BuildingType,PHASE_E_ORDINARY_CRAFTING as P} from '@shardkeep/shared';
import {ordinaryCraftingRecipe,type OrdinaryRecipeId} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {eq} from 'drizzle-orm';
import {createDb,type Db} from '../../src/db/client';
import {bases,builderJobs,buildings,craftingStocks,players,resourceStocks} from '../../src/db/schema';
import {transferStableBase} from '../../src/game/baseOwnership';
import {readOrdinaryCrafting,settleDueOrdinaryCrafting,startOrdinaryCrafting,type OrdinaryCraftingCommand} from '../../src/game/ordinaryCrafting';
import {ADMIN_DATABASE_URL} from '../db-url';
import {resourceClaimsDatabase} from './resourceClaimsDatabase';
import {createStarterExpeditionFixture} from './starterExpeditions';

/** Env flags a test stubs to 'true' (vi.stubEnv) before creating this context. */
export const BLUEPRINT_TEST_FLAGS=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','STARTER_FLEET_ENABLED','STARTER_EXPEDITIONS_ENABLED','BASE_CLAIM_V1_ENABLED'] as const;
export const CRAFTING_SOURCE_TABLES=['ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions','resource_stocks','resource_stock_operations','crafting_stocks','bases','base_slots','base_transfers'] as const;
export async function snapshotTables(sql:ReturnType<typeof createDb>['sql'],names:readonly string[]){
 const rows=[];for(const name of names)rows.push(await sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${sql(name)} t`);return JSON.stringify(rows);
}
const key=()=>Keypair.generate().publicKey.toBase58();
export type BaseContext=Awaited<ReturnType<typeof createStarterExpeditionFixture>>;

export async function boundCosmeticBlueprintFixture(){
 const conn=resourceClaimsDatabase();await conn.setup();
 try{
  let now=new Date('2035-01-01T01:00:00.000Z');
  const player=async(wallet=key())=>{await conn.db.insert(players).values({wallet}).onConflictDoNothing();return wallet;};
  /** A starter base controlled by `wallet` with a genuinely completed Workshop. */
  async function ownBase(wallet:string):Promise<BaseContext>{
   await player(wallet);const base=await createStarterExpeditionFixture(conn.db,{wallet,now});
   const [building]=await conn.db.insert(buildings).values({baseId:base.baseId,playerWallet:wallet,type:BuildingType.Workshop,tx:9,ty:2}).returning();
   const completedAt=new Date(now.getTime()-1_000);
   await conn.db.insert(builderJobs).values({baseId:base.baseId,playerWallet:wallet,buildingId:building!.id,kind:'build',startedAt:new Date(completedAt.getTime()-BUILD_COSTS[BuildingType.Workshop].buildSec*1_000),finishesAt:completedAt,completedAt});
   return base;
  }
  const wallet=key(),buyer=await player();const main=await ownBase(wallet);
  /** Explicit disposable opening stock for one recipe batch, never an earned-output bypass. */
  async function seed(baseId:string,recipeId:OrdinaryRecipeId,quantity:number){
   for(const input of ordinaryCraftingRecipe(recipeId,P.v1.recipeVersion,quantity).inputs){
    if(input.kind==='raw')await conn.db.insert(resourceStocks).values({baseId,resourceId:input.itemId,available:BigInt(input.quantity)}).onConflictDoUpdate({target:[resourceStocks.baseId,resourceStocks.resourceId],set:{available:BigInt(input.quantity)}});
    else if(input.kind==='crafting')await conn.db.insert(craftingStocks).values({baseId,itemId:input.itemId,available:BigInt(input.quantity)}).onConflictDoUpdate({target:[craftingStocks.baseId,craftingStocks.itemId],set:{available:BigInt(input.quantity)}});
    else throw Error('fixture does not seed currency inputs');
   }
  }
  /** Real accepted job through the production writer (inputs consumed at start) on the given base (default: the main base). */
  async function start(actor:string,recipeId:OrdinaryRecipeId,quantity=1,base:BaseContext=main){
   await seed(base.baseId,recipeId,quantity);
   const command:OrdinaryCraftingCommand={id:randomUUID(),baseId:base.baseId,recipeId,recipeVersion:P.v1.recipeVersion,quantity};
   return startOrdinaryCrafting(conn.db,actor,command,base.authority,{clock:()=>now});
  }
  /** Real settlement at the job's own deadline through the production settler. */
  async function complete(job:{job:{id:string;baseId:string;readyAt:Date}}){
   now=new Date(Math.max(now.getTime(),job.job.readyAt.getTime()));
   await conn.db.transaction(tx=>settleDueOrdinaryCrafting(tx,job.job.baseId,now));
   const proven=await readOrdinaryCrafting(conn.db,job.job.id);if(!proven?.completion)throw Error('Fixture crafting job was not settled');return proven;
  }
  /** RECORDED stable-base transfer through the production path (deed identity seeded, then transferStableBase). */
  async function transfer(base:BaseContext,from:string,to:string){
   await player(to);const deed=key(),collection=key();
   await conn.db.update(bases).set({deedAssetId:deed,deedMintAssetId:deed,landPaidAt:now}).where(eq(bases.id,base.baseId));
   const at=new Date(now.getTime()+1_000);now=at;
   await transferStableBase(conn.db,base.baseId,from,to,deed,{owner:to,collection,frozen:false,delegate:null,slot:100,observedAtMs:at.getTime()},()=>at);
   const [row]=await conn.db.select().from(bases).where(eq(bases.id,base.baseId));if(row?.ownerWallet!==to)throw Error('Fixture transfer was not recorded');
  }
  const [current]=await conn.sql<{name:string}[]>`select current_database() name`,name=current!.name,roles:string[]=[],readers:ReturnType<typeof createDb>[]=[];
  /** A login role that may SELECT every public table but owns none of them. */
  async function readerRole(){
   const role=`blueprint_reader_${randomUUID().replaceAll('-','').slice(0,12)}`,password=randomUUID();
   await conn.sql.unsafe(`create role ${role} login password '${password}'`);roles.push(role);
   await conn.sql.unsafe(`grant usage on schema public to ${role}; grant select on all tables in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.username=role;url.password=password;url.pathname=`/${name}`;
   const reader=createDb(url.toString(),{max:2});readers.push(reader);return reader;
  }
  async function unguarded<T>(tables:readonly string[],run:()=>Promise<T>):Promise<T>{
   for(const table of tables)await conn.sql.unsafe(`alter table ${table} disable trigger user`);
   try{return await run();}finally{for(const table of tables)await conn.sql.unsafe(`alter table ${table} enable trigger user`);}
  }
  /** SUPERUSER PROOF HELPER: moves a completion receipt in time behind the immutability trigger. */
  const shiftCompletion=(jobId:string,seconds:number)=>unguarded(['ordinary_crafting_completions'],async()=>{await conn.sql`update ordinary_crafting_completions set completed_at=completed_at+make_interval(secs=>${seconds}) where job_id=${jobId}`;});
  /** SUPERUSER PROOF HELPER: a completion receipt for a job that is still pending (half-state), and its removal. */
  const halfState=(jobId:string,at:Date)=>unguarded(['ordinary_crafting_completions'],async()=>{await conn.sql`insert into ordinary_crafting_completions(job_id,custody_wallet,completed_at) values(${jobId},'fixture-half-state',${at.toISOString()})`;});
  const clearHalfState=(jobId:string)=>unguarded(['ordinary_crafting_completions'],async()=>{await conn.sql`delete from ordinary_crafting_completions where job_id=${jobId}`;});
  /** SUPERUSER PROOF HELPER: a job row with a completion receipt but NO input proofs, for an outsider actor. */
  async function fabricate(actor:string){
   const id=randomUUID(),recipe=ordinaryCraftingRecipe('refine_frostglass',P.v1.recipeVersion,1),startedAt=new Date(now.getTime()-120_000),readyAt=new Date(startedAt.getTime()+recipe.durationSec*1000);
   await player(actor);
   await unguarded(['ordinary_crafting_jobs','ordinary_crafting_completions'],async()=>{
    await conn.sql`insert into ordinary_crafting_jobs(id,actor_wallet,base_id,recipe_id,recipe_version,quantity,recipe_snapshot,output_item_id,output_quantity,workshop_id,workshop_completed_job_id,started_at,ready_at,completed_at)
     values(${id},${actor},${main.baseId},'refine_frostglass',${P.v1.recipeVersion},1,${JSON.stringify(recipe)}::jsonb,'frostglass',1,${randomUUID()},${randomUUID()},${startedAt.toISOString()},${readyAt.toISOString()},${readyAt.toISOString()})`;
    await conn.sql`insert into ordinary_crafting_completions(job_id,custody_wallet,completed_at) values(${id},${actor},${readyAt.toISOString()})`;
   });
   return id;
  }
  return {conn,db:conn.db,sql:conn.sql,wallet,buyer,main,baseId:main.baseId,clock:()=>now,advance:(ms:number)=>{now=new Date(now.getTime()+ms);},
   player,ownBase,start,complete,transfer,readerRole,shiftCompletion,halfState,clearHalfState,fabricate,
   async close(){try{for(const r of readers)await r.sql.end();for(const role of roles)await conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`);}finally{await conn.close();}}};
 }catch(error){await conn.close();throw error;}
}
