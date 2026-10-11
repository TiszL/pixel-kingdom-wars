/** Actual earned-input journey under fixture term authority. This establishes a
 * concrete current schedule and conservation, not profitability or enjoyable pacing. */
import {randomUUID} from 'node:crypto';
import {BUILD_COSTS,BuildingType,PHASE_E_ORDINARY_CRAFTING,PHASE_E_STARTER_ROUTES} from '@shardkeep/shared';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {ordinaryCraftingRecipe,type OrdinaryRecipeId} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {builderJobs,buildings} from '../src/db/schema';
import {getBaseState} from '../src/game/base';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {readStarterExpeditionReturn} from '../src/game/starterExpeditionReturns';
import {readOrdinaryCrafting,startOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
let conn:ReturnType<typeof resourceClaimsDatabase>;
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2035-01-01T01:00:00Z'));
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','STARTER_FLEET_ENABLED','STARTER_EXPEDITIONS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(flag,'true');
 conn=resourceClaimsDatabase();await conn.setup();
},120000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function snapshot(names:readonly string[]){const rows=[];for(const name of names)rows.push(await conn.sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${conn.sql(name)} t`);return JSON.stringify(rows);}
const economy=()=>snapshot(['resource_stocks','resource_stock_operations','resource_stock_entries','crafting_stocks','ordinary_crafting_jobs','ordinary_crafting_inputs','ordinary_crafting_completions']);
it('earns both realm ingredients, refines them and completes one kit on the original schedule without minting extra inputs',async()=>{
 const f=await createStarterExpeditionFixture(conn.db,{now:new Date()});
 const completedAt=new Date(+f.now-1000),[workshop]=await conn.db.insert(buildings).values({baseId:f.baseId,playerWallet:f.wallet,type:BuildingType.Workshop,tx:12,ty:2}).returning();
 await conn.db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:workshop!.id,kind:'build',startedAt:new Date(+completedAt-BUILD_COSTS.workshop.buildSec*1000),finishesAt:completedAt,completedAt});
 const moneyBefore=await snapshot(['accounts','ledger_transactions','ledger_entries']);
 const version=PHASE_E_ORDINARY_CRAFTING.currentRecipeVersion;
 const kit=ordinaryCraftingRecipe('craft_navigation_kit',version,1);
 const read=(at:Date)=>getBaseState(conn.db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>at);
 const command=(recipeId:OrdinaryRecipeId,quantity=1)=>({id:randomUUID(),baseId:f.baseId,recipeId,recipeVersion:version,quantity});
 const kitCommand=command(kit.recipeId),startAt=new Date(f.now);
 const empty=await economy();await expect(startOrdinaryCrafting(conn.db,f.wallet,kitCommand,f.authority,{clock:()=>f.now})).rejects.toMatchObject({code:'INSUFFICIENT_CRAFTING_STOCK'});expect(await economy()).toBe(empty);
 const savedTrips:NonNullable<Awaited<ReturnType<typeof readStarterExpeditionReturn>>>[]=[];
 const totals=new Map<string,{gross:bigint;net:bigint;tax:bigint;used:bigint}>();let expeditionMs=0,craftingMs=0;
 const refinements=[];
 for(const [routeId,recipeId] of [['common_seeker_reach','refine_prismstone_lens'],['common_frostveil','refine_frostglass']] as const){
  const preview=starterRoutePreview('crownlands',routeId),baseRecipe=ordinaryCraftingRecipe(recipeId,version,1);
  const needed=BigInt(kit.inputs.find(input=>input.itemId===baseRecipe.output.itemId)!.quantity);
  const batches=Number((needed+BigInt(baseRecipe.output.quantity)-1n)/BigInt(baseRecipe.output.quantity));
  const recipe=ordinaryCraftingRecipe(recipeId,version,batches),raw=recipe.inputs[0]!,rawNeeded=BigInt(raw.quantity);
  expect(preview.resourceId).toBe(raw.itemId);
  const trips=Number((rawNeeded+BigInt(preview.netQuantity)-1n)/BigInt(preview.netQuantity));
  const total={gross:0n,net:0n,tax:0n,used:rawNeeded};totals.set(preview.resourceId,total);
  for(let index=0;index<trips;index++){
   const dispatch={...f.command,id:randomUUID(),routeId,routeVersion:preview.routeCatalogueVersion,rewardVersion:preview.rewardTableVersion};
   const accepted=await dispatchStarterExpedition(conn.db,f.wallet,dispatch,f.authority,{reader:f.reader,clock:()=>f.now});
   expect(accepted.returnsAt.getTime()-accepted.departedAt.getTime()).toBe(PHASE_E_STARTER_ROUTES.commonV1.durationSec*1000);
   expect(accepted.routeSnapshot).toMatchObject({access:{kind:'starter_common',policyVersion:PHASE_E_STARTER_ROUTES.commonV1.accessPolicyVersion}});
   await expect(dispatchStarterExpedition(conn.db,f.wallet,{...dispatch,id:randomUUID()},f.authority,{reader:f.reader,clock:()=>f.now})).rejects.toMatchObject({statusCode:409});
   await read(new Date(+accepted.returnsAt-1));expect(await readStarterExpeditionReturn(conn.db,accepted.id)).toBeNull();
   const before=await economy();await expect(startOrdinaryCrafting(conn.db,f.wallet,command(recipeId,batches),f.authority,{clock:()=>f.now})).rejects.toMatchObject({code:'INSUFFICIENT_RAW_STOCK'});expect(await economy()).toBe(before);
   f.now=accepted.returnsAt;vi.setSystemTime(f.now);await read(f.now);
   const proof=(await readStarterExpeditionReturn(conn.db,accepted.id))!;expect(proof.expedition).toEqual(accepted);expect(proof.entries.reduce((sum,e)=>sum+e.delta,0n)).toBe(0n);
   total.gross+=accepted.gross;total.net+=accepted.net;total.tax+=accepted.tax;expeditionMs+=accepted.returnsAt.getTime()-accepted.departedAt.getTime();savedTrips.push(proof);
   expect(await dispatchStarterExpedition(conn.db,f.wallet,dispatch,f.authority,{reader:{readOperatingTerm:async()=>{throw Error('saved trip must not ask a new term');}}})).toEqual(accepted);
  }
  refinements.push(recipe);
 }
 const savedCrafts:NonNullable<Awaited<ReturnType<typeof readOrdinaryCrafting>>>[]=[];
 for(const recipe of [...refinements,kit]){
  const cmd=recipe.recipeId===kit.recipeId?kitCommand:command(recipe.recipeId,recipe.quantity);
  const accepted=await startOrdinaryCrafting(conn.db,f.wallet,cmd,f.authority,{clock:()=>f.now});
  expect(accepted.job.recipeSnapshot).toEqual(recipe);
  expect(accepted.job.readyAt.getTime()-accepted.job.startedAt.getTime()).toBe(recipe.durationSec*1000);
  await expect(startOrdinaryCrafting(conn.db,f.wallet,command(recipe.recipeId,recipe.quantity),f.authority,{clock:()=>f.now})).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
  await read(new Date(+accepted.job.readyAt-1));expect((await readOrdinaryCrafting(conn.db,cmd.id))!.completion).toBeNull();
  f.now=accepted.job.readyAt;vi.setSystemTime(f.now);await read(f.now);craftingMs+=recipe.durationSec*1000;
  const completed=(await readOrdinaryCrafting(conn.db,cmd.id))!;expect(completed.completion).toMatchObject({jobId:cmd.id,custodyWallet:f.wallet,completedAt:f.now});savedCrafts.push(completed);
  expect(await startOrdinaryCrafting(conn.db,f.wallet,cmd,f.authority)).toEqual(completed);
  if(recipe.recipeId===refinements[0]!.recipeId){
   // The kit consumes prismstone first. A missing second ingredient must roll
   // back that available first ingredient, not merely refuse an empty recipe.
   const partial=await economy();await expect(startOrdinaryCrafting(conn.db,f.wallet,kitCommand,f.authority,{clock:()=>f.now})).rejects.toMatchObject({code:'INSUFFICIENT_CRAFTING_STOCK'});expect(await economy()).toBe(partial);
  }
 }
 const final=await read(f.now);
 for(const [resourceId,total] of totals){
  const stock=final.rawStock!.find(s=>s.resourceId===resourceId)!;expect(stock).toMatchObject({available:(total.net-total.used).toString(),reserved:'0'});
  expect(total.gross).toBe(total.tax+total.used+BigInt(stock.available));
 }
 expect(final.craftingStock!.find(s=>s.itemId===kit.output.itemId)).toMatchObject({available:kit.output.quantity,pendingOutput:'0'});
 for(const refined of refinements)expect(final.craftingStock!.find(s=>s.itemId===refined.output.itemId)).toMatchObject({available:(BigInt(refined.output.quantity)-BigInt(kit.inputs.find(i=>i.itemId===refined.output.itemId)!.quantity)).toString(),pendingOutput:'0'});
 expect(+f.now-+startAt).toBe(expeditionMs+craftingMs);expect(final.ordinaryCrafting!.pendingJobs).toEqual([]);
 const beforePause=await economy(),reopened=conn.reopen();
 try{
  vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');
  for(const proof of savedTrips)expect(await readStarterExpeditionReturn(reopened.db,proof.expedition.id)).toEqual(proof);
  for(const proof of savedCrafts)expect(await readOrdinaryCrafting(reopened.db,proof.job.id)).toEqual(proof);
  await getBaseState(reopened.db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now);
  expect(await economy()).toBe(beforePause);expect(await snapshot(['accounts','ledger_transactions','ledger_entries'])).toBe(moneyBefore);
 }finally{await reopened.sql.end();}
},120000);
