/** Refined stock is an explicit custody-boundary fixture; Crystal Fragments are
 * genuinely earned by the existing Divine source. Root composition separately
 * proves actual refined earning and actual SBF; these bank fixtures do not. */
import {randomUUID,randomBytes} from 'node:crypto';
import {PublicKey,Keypair} from '@solana/web3.js';
import {and,eq} from 'drizzle-orm';
import {describe,it,expect,vi} from 'vitest';
import {BUILD_COSTS,BuildingType,PHASE_E_KEEP_EQUIPMENT_MARKET} from '@shardkeep/shared';
import {PHASE_E_VEHICLE_FAMILY_IDS} from '@shardkeep/shared/phaseEVehicles';
import {vehicleCraftRecipe,vehicleRecipeCanonical} from '@shardkeep/shared/phaseEVehicleRecipes';
import {normalizeVehicleIssuanceOriginal} from '@shardkeep/chain/vehicle-issuance-evidence';
import {createVehicleIssuanceTerminalReader} from '@shardkeep/chain/vehicle-issuance-terminal';
import {vehicleTermsHash,vehicleTermsBytes,vehicleVrfRequest,vehicleKeccak} from '@shardkeep/chain/vehicle-issuance-protocol';
import {vehicleIssuanceTerminalFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuanceTerminal';
import {createVehicleCraftMaterials,vehicleCraftMaterialHash,type VehicleCraftMaterialRecord} from '../src/game/vehicleCraftMaterials';
import {createVehicleIssuanceAcquisitions} from '../src/game/vehicleIssuanceAcquisitions';
import {buildings,builderJobs,craftingStocks} from '../src/db/schema';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {createKeepEquipmentListing,cancelKeepEquipmentListing} from '../src/game/keepEquipmentMarket';
import {reserveMiningContribution,abortMiningContributions} from '../src/game/miningContributions';
import {startOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {withDivineFragmentFixture} from './fixtures/divineFragments';
import {SEAL_BOUND_DIVINE_FIXTURE_CASE_MS} from './sealLatencyBudgets';
type F=Parameters<Parameters<typeof withDivineFragmentFixture>[0]>[0];
async function fixture(f:F){
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(flag,'true');
 await f.fragments.enroll(f.event.id);await f.play();await f.settle();await f.fragments.deliver(f.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId:f.baseId});
 const now=new Date(),[workshop]=await f.db.select().from(buildings).where(and(eq(buildings.baseId,f.baseId),eq(buildings.type,BuildingType.Workshop)));
 const completedAt=new Date(+now-1000);const [job]=await f.db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:workshop!.id,kind:'build',startedAt:new Date(+completedAt-BUILD_COSTS.workshop.buildSec*1000),finishesAt:completedAt,completedAt}).returning();
 const recipe=vehicleCraftRecipe('survey_balloon',1);for(const input of recipe.inputs)if(input.kind==='refined')await f.db.insert(craftingStocks).values({baseId:f.baseId,itemId:input.itemId,available:BigInt(input.quantity)}).onConflictDoUpdate({target:[craftingStocks.baseId,craftingStocks.itemId],set:{available:BigInt(input.quantity)}});
 const bank=vehicleIssuanceTerminalFixture('won',{rootId:randomBytes(16).toString('hex')}),{originalHash:_old,...o}=bank.original;
 const template=normalizeVehicleIssuanceOriginal({...o,buyer:f.wallet}),command={idempotencyKey:randomUUID(),baseId:f.baseId,family:recipe.family,tier:recipe.tier,recipeVersion:recipe.recipeVersion};
 const authority={baseId:f.baseId,assertAuthority:async()=>{}};
 const service=createVehicleCraftMaterials(f.db,{loadTemplate:async()=>template});
 const stocks=()=>f.sql`select item_id,available::text from crafting_stocks where base_id=${f.baseId} order by item_id`;
 return {recipe,template,command,authority,service,stocks,workshop:workshop!,job:job!};
}
async function terminal(saved:VehicleCraftMaterialRecord,outcome:'won'|'lost'){
 const b=vehicleIssuanceTerminalFixture(outcome,{rootId:saved.original.rootId}),o=saved.original,terms=vehicleTermsHash(o),request=vehicleKeccak(vehicleVrfRequest(o.rootId,o.attemptId,terms)),buyer=new PublicKey(o.buyer).toBuffer();
 buyer.copy(b.rows[7]!.data,41);buyer.copy(b.rows[8]!.data,73);buyer.copy(b.rows[9]!.data,25);
 vehicleTermsBytes(o.terms).copy(b.rows[8]!.data,185);Buffer.from(terms,'hex').copy(b.rows[7]!.data,137);Buffer.from(terms,'hex').copy(b.rows[8]!.data,393);Buffer.from(terms,'hex').copy(b.rows[9]!.data,121);request.copy(b.rows[8]!.data,425);
 return createVehicleIssuanceTerminalReader(()=>b.rpc,b.trust,async()=>o)(o.rootId);
}
const run=(callback:(f:F,x:Awaited<ReturnType<typeof fixture>>)=>Promise<void>)=>withDivineFragmentFixture(async f=>{try{await callback(f,await fixture(f));}finally{vi.unstubAllEnvs();}});
describe('private original vehicle material custody',()=>{
 it.each(['won','lost'] as const)('reserves exact leaves before exposing nonce and consumes authenticated paid %s once, with paused offline replay',outcome=>run(async(f,x)=>{
  const before=await x.stocks(),[fragments]=await f.sql`select available from crystal_fragment_stocks where base_id=${f.baseId}`;
  const preview=await x.service.quote(f.wallet,{family:x.recipe.family,tier:x.recipe.tier,recipeVersion:x.recipe.recipeVersion});expect(preview.materialReservationAuthorized).toBe(false);expect(await x.stocks()).toEqual(before);
  const held=await x.service.reserve(f.wallet,x.command,x.authority);expect(held.status).toBe('held');expect(held.nonce).toMatch(/^[0-9a-f]{64}$/);expect(held.materialHash).not.toBe(x.template.terms.materialHash);expect(held.materialHash).toBe(vehicleCraftMaterialHash({actorWallet:f.wallet,baseId:f.baseId,rootId:held.original.rootId,attemptId:held.original.attemptId,nonce:held.nonce,recipeHash:held.recipeHash,recipe:held.recipe}));
  expect(await x.stocks()).toEqual(before.map(row=>x.recipe.inputs.some(input=>input.kind==='refined'&&input.itemId===row.item_id)?{...row,available:'0'}:row));const [after]=await f.sql`select available from crystal_fragment_stocks where base_id=${f.baseId}`;expect(BigInt(fragments!.available)-BigInt(after!.available)).toBe(BigInt(x.recipe.inputs.find(i=>i.kind==='fragment')!.quantity));
  expect(await createVehicleIssuanceAcquisitions(f.db).loadOriginal(held.original.rootId)).toEqual(held.original);
  const proof=await terminal(held,outcome),settler=createVehicleCraftMaterials(f.db,{readFinalizedResult:async()=>proof});const [a,b]=await Promise.all([settler.settle(f.wallet,x.command.idempotencyKey),settler.settle(f.wallet,x.command.idempotencyKey)]);expect(a).toEqual(b);expect(a).toMatchObject({status:'consumed',terminal:{proof:{outcome,paid:true,minted:false}}});
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');expect(await x.service.reserve(f.wallet,x.command,x.authority)).toEqual(a);expect(await x.service.settle(f.wallet,x.command.idempotencyKey)).toEqual(a);expect(await f.sql`select * from vehicle_craft_material_terminals where reservation_id=${held.id}`).toHaveLength(1);
 }),SEAL_BOUND_DIVINE_FIXTURE_CASE_MS);
 it('same-key races debit once; crafting, market and mining cannot spend held material',()=>run(async(f,x)=>{
  const [a,b]=await Promise.all([x.service.reserve(f.wallet,x.command,x.authority),x.service.reserve(f.wallet,x.command,x.authority)]);expect(a).toEqual(b);
  await expect(x.service.reserve(f.wallet,{...x.command,idempotencyKey:randomUUID()},x.authority)).rejects.toThrow();
  await expect(startOrdinaryCrafting(f.db,f.wallet,{id:randomUUID(),baseId:f.baseId,recipeId:'craft_navigation_kit',recipeVersion:1,quantity:1},x.authority)).rejects.toMatchObject({code:'INSUFFICIENT_CRAFTING_STOCK'});
  // Declared local deed identity permits normal market admission; it neither
  // grants inventory nor substitutes for root's finalized-chain composition.
  await f.sql`update bases set deed_asset_id=${Keypair.generate().publicKey.toBase58()},land_paid_at=clock_timestamp() where id=${f.baseId}`;
  const deps={assertAdmission:()=>{}},price=String(PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits),day=new Date().toISOString().slice(0,10);
  const list=(itemId:string,quantity:string)=>createKeepEquipmentListing(f.db,f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,itemId,quantity,unitPriceBaseUnits:price},x.authority,deps);
  const mine=(resourceId:'prismstone_lens'|'crystal_fragment',quantity:string)=>reserveMiningContribution(f.db,f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,expectedDay:day,policyVersion:2,lines:[{resourceId,quantity}]},x.authority);
  const [stock]=await f.sql`select available::text from crystal_fragment_stocks where base_id=${f.baseId}`;
  const heldFragments=BigInt(x.recipe.inputs.find(i=>i.kind==='fragment')!.quantity),overAvailable=String(BigInt(stock!.available)+heldFragments);
  await expect(list('prismstone_lens','1')).rejects.toMatchObject({code:'KEEP_EQUIPMENT_MARKET_STOCK'});
  await expect(list('crystal_fragment',overAvailable)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_MARKET_STOCK'});
  await expect(mine('prismstone_lens','1')).rejects.toMatchObject({code:'INSUFFICIENT_MINING_RESOURCES'});
  await expect(mine('crystal_fragment',overAvailable)).rejects.toMatchObject({code:'INSUFFICIENT_MINING_RESOURCES'});
  // Unheld, genuinely earned fragments still move through both consumers and
  // return exactly; the vehicle reservation must remain held throughout.
  const listing=await list('crystal_fragment','1');
  await cancelKeepEquipmentListing(f.db,f.wallet,{idempotencyKey:randomUUID(),listingId:listing.id},x.authority,deps);
  const contribution=await mine('crystal_fragment','1');expect(contribution.status).toBe('accepted');
  await abortMiningContributions(f.db,{epochId:contribution.receipt!.epochId,decisionKey:randomUUID(),reason:'isolated custody conservation check'});
  expect((await f.sql`select available::text from crystal_fragment_stocks where base_id=${f.baseId}`)[0]).toEqual(stock);
  expect((await x.service.read(f.wallet,x.command.idempotencyKey))!.status).toBe('held');
  await expect(x.service.reserve(f.wallet,{...x.command,tier:2},x.authority)).rejects.toMatchObject({code:'VEHICLE_MATERIAL_CONFLICT'});
  expect(await x.service.read(f.buyer,x.command.idempotencyKey)).toBeNull();
  expect(await f.sql`select * from vehicle_craft_material_reservations where actor_wallet=${f.wallet}`).toHaveLength(1);
 }),SEAL_BOUND_DIVINE_FIXTURE_CASE_MS);
 it('last missing refined ingredient rolls back fragment debit, prior refined debits, nonce, original and reservation',()=>run(async(f,x)=>{
  const last=x.recipe.inputs.at(-1)!;await f.sql`update crafting_stocks set available=0 where base_id=${f.baseId} and item_id=${last.itemId}`;
  const before=await x.stocks(),fragments=await f.sql`select * from crystal_fragment_stocks where base_id=${f.baseId}`;
  await expect(x.service.reserve(f.wallet,x.command,x.authority)).rejects.toMatchObject({cause:{message:'VEHICLE_MATERIAL_STOCK'}});expect(await x.stocks()).toEqual(before);expect(await f.sql`select * from crystal_fragment_stocks where base_id=${f.baseId}`).toEqual(fragments);
  expect(await createVehicleIssuanceAcquisitions(f.db).loadOriginal(x.template.rootId)).toBeNull();expect(await f.sql`select id from vehicle_craft_material_reservations where actor_wallet=${f.wallet}`).toHaveLength(0);
 }),SEAL_BOUND_DIVINE_FIXTURE_CASE_MS);
 it('unknown, unpaid or mismatched outcomes stay held; legacy originals cannot acquire retrospective custody',()=>run(async(f,x)=>{
  await createVehicleIssuanceAcquisitions(f.db).saveOriginal(x.template);const before=await x.stocks();await expect(x.service.reserve(f.wallet,x.command,x.authority)).rejects.toMatchObject({cause:{message:'VEHICLE_MATERIAL_EXISTING_ORIGINAL'}});expect(await x.stocks()).toEqual(before);
  const b=vehicleIssuanceTerminalFixture('won',{rootId:randomBytes(16).toString('hex')}),{originalHash:_h,...t}=b.original;
  const service=createVehicleCraftMaterials(f.db,{loadTemplate:async()=>normalizeVehicleIssuanceOriginal({...t,buyer:f.wallet})});const held=await service.reserve(f.wallet,x.command,x.authority);await expect(service.settle(f.wallet,x.command.idempotencyKey)).rejects.toMatchObject({code:'VEHICLE_MATERIAL_HELD'});
  const good=await terminal(held,'won');for(const extra of [{paid:false},{outcome:'lost'},{rootId:x.template.rootId},{originalHash:'0'.repeat(64)}])await expect(createVehicleCraftMaterials(f.db,{readFinalizedResult:async()=>({...good,...extra}) as typeof good}).settle(f.wallet,x.command.idempotencyKey)).rejects.toMatchObject({code:'VEHICLE_MATERIAL_HELD'});
  expect((await service.read(f.wallet,x.command.idempotencyKey))!.status).toBe('held');
 }),SEAL_BOUND_DIVINE_FIXTURE_CASE_MS);
 it('owner SQL cannot change recipes, omit atomic original completion, mutate journals or forge a terminal binding',()=>run(async(f,x)=>{
  for(const family of PHASE_E_VEHICLE_FAMILY_IDS)for(const tier of [1,2,3,4]){const v=await x.service.quote(f.wallet,{family,tier,recipeVersion:1});await f.sql`insert into vehicle_craft_recipe_policies(recipe_hash,canonical) values(${v.recipeHash},${vehicleRecipeCanonical(v.recipe)})`; }
  const preview=await x.service.quote(f.wallet,{family:x.recipe.family,tier:x.recipe.tier,recipeVersion:1});
  await expect(f.sql`insert into vehicle_craft_recipe_policies(recipe_hash,canonical) values(${preview.recipeHash},${vehicleRecipeCanonical({...x.recipe})+' '})`).rejects.toThrow('VEHICLE_MATERIAL_RECIPE');
  await expect(f.sql.begin('isolation level repeatable read',tx=>tx`insert into vehicle_craft_recipe_policies(recipe_hash,canonical) values(${preview.recipeHash},${vehicleRecipeCanonical(x.recipe)}) on conflict do nothing`)).rejects.toThrow('DIVINE_FRAGMENT_OWNER_ISOLATION');
  const originalStocks=await x.stocks();await expect(f.sql.begin(async tx=>{await tx`insert into vehicle_craft_material_reservations(actor_wallet,idempotency_key,base_id,root_id,attempt_id,permit_id,asset_id,recipe_hash,workshop_id,workshop_job_id) values(${f.wallet},${x.command.idempotencyKey},${f.baseId},${x.template.rootId},${x.template.attemptId},${x.template.permitId},${x.template.identity.assetId},${preview.recipeHash},${x.workshop.id},${x.job.id})`;})).rejects.toThrow();expect(await x.stocks()).toEqual(originalStocks);
  const held=await x.service.reserve(f.wallet,x.command,x.authority);
  for(const table of ['vehicle_craft_material_reservations','vehicle_craft_material_lines'])for(const command of [`delete from ${table}`,`truncate ${table} cascade`])await expect(f.sql.unsafe(command)).rejects.toThrow('VEHICLE_MATERIAL_IMMUTABLE');
  await expect(f.sql`insert into vehicle_craft_material_terminals(reservation_id,outcome,proof) values(${held.id},'won','{}')`).rejects.toThrow('VEHICLE_MATERIAL_TERMINAL');
  await expect(f.db.transaction(async tx=>createVehicleCraftMaterials(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_MATERIAL_TOP_LEVEL'});
 }),SEAL_BOUND_DIVINE_FIXTURE_CASE_MS);
 it('non-owner SQL remains denied after accidental grants and forged trigger attachment',()=>run(async(f,x)=>{
  await x.service.reserve(f.wallet,x.command,x.authority);const role='vehicle_material_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{const [name]=await f.sql`select current_database() name`;await f.sql.unsafe(`grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name!.name;url.username=role;url.password=password;runtime=createDb(url.toString());await expect(runtime.sql`select * from vehicle_craft_material_reservations`).rejects.toMatchObject({code:'42501'});
   await f.sql.unsafe(`grant all on all tables in schema public to ${role};grant execute on all functions in schema public to ${role}`);
   await expect(createVehicleCraftMaterials(runtime.db).read(f.wallet,x.command.idempotencyKey)).rejects.toMatchObject({cause:{message:'DIVINE_FRAGMENT_OWNER_ISOLATION'}});
   await expect(runtime.sql`insert into vehicle_craft_recipe_policies(recipe_hash,canonical) values(${'0'.repeat(64)},'{}')`).rejects.toThrow('DIVINE_FRAGMENT_OWNER_ISOLATION');
   await expect(runtime.sql.begin(async tx=>{await tx`create temporary table fake(recipe_hash text,canonical text)`;await tx`create trigger fake_guard before insert on fake for each row execute function public.shardkeep_vehicle_material_guard()`;await tx`insert into fake values('x','{}')`;})).rejects.toThrow('VEHICLE_MATERIAL_IMMUTABLE');
  }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),SEAL_BOUND_DIVINE_FIXTURE_CASE_MS);
});
