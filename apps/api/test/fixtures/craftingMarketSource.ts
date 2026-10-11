/** D194 actual common-route earning and ordinary crafting source. Facility,
 * deed and historical term facts are private fixtures; goods are never seeded.
 * Caller owns DB/Date/env lifecycle; this helper starts no external process. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {eq,sql} from 'drizzle-orm';
import {vi} from 'vitest';
import {BUILD_COSTS,BuildingType,PHASE_E_ORDINARY_CRAFTING as C} from '@shardkeep/shared';
import {StarterCommonRouteIdSchema,starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {ORDINARY_REFINED_IDS,ORDINARY_REFINED_INPUTS,ordinaryCraftingRecipe,type OrdinaryRefinedId} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {bases,buildings,builderJobs,players} from '../../src/db/schema';
import {fantasyManifestHash,planFantasyMigration,rehearseFantasyMigration} from '../../src/db/fantasyMigration';
import {assertFreshLockedBaseAuthority,refreshBaseOwnership} from '../../src/game/baseOwnership';
import {startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../../src/game/ordinaryCrafting';
import {startOrdinaryEquipment} from '../../src/game/ordinaryEquipment';
import {dispatchStarterExpedition} from '../../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions,readStarterExpeditionReturn} from '../../src/game/starterExpeditionReturns';
import {createStarterExpeditionFixture} from './starterExpeditions';
import type {connectTestDb} from '../helpers';

type Conn=ReturnType<typeof connectTestDb>;
export async function craftingMarketSource(conn:Conn){
 const db=conn.db,collection=Keypair.generate().publicKey.toBase58(),owners=new Map<string,string>();
 // Real earning and fitting advance about thirty-one hours. Keep all pending
 // equipment completions behind the database clock enforced by0256/0257.
 let now=new Date(vi.getRealSystemTime()-3*24*60*60*1000);
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','STARTER_EXPEDITIONS_ENABLED','KEEP_EQUIPMENT_MARKET_ENABLED'])vi.stubEnv(flag,'true');
 const advance=(value:Date)=>{now=new Date(Math.max(+now,+value));vi.setSystemTime(now);};
 async function actor(){
  const signer=Keypair.generate(),wallet=signer.publicKey.toBase58();await db.insert(players).values({wallet});
  const f=await createStarterExpeditionFixture(db,{wallet,now});
  const [workshop]=await db.insert(buildings).values({baseId:f.baseId,playerWallet:wallet,type:BuildingType.Workshop,tx:9,ty:2}).returning();
  const completed=new Date(+now-1000);await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:wallet,buildingId:workshop!.id,kind:'build',startedAt:new Date(+completed-BUILD_COSTS.workshop.buildSec*1000),finishesAt:completed,completedAt:completed});
  const deed=Keypair.generate().publicKey.toBase58();owners.set(deed,wallet);
  await db.update(bases).set({deedAssetId:deed,landPaidAt:now}).where(eq(bases.id,f.baseId));
  const authority={baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
  return {...f,signer,deed,collection,authority};
 }
 const seller=await actor(),buyer=await actor();
 const deedReader=async(asset:string)=>{const owner=owners.get(asset);if(!owner)return null;return {owner,collection,frozen:false,delegate:null,slot:100};};
 async function refresh(){for(const actor of [seller,buyer]){
  const result=await refreshBaseOwnership(db,actor.baseId,deedReader,collection,now,'crafting-market-source',()=>now);
  if(result!=='owned')throw Error('Private original deed fixture lost authority');
 }}
 await refresh();
 // The paid fixture must have a canonical original home too. Reuse the
 // isolated-test historical migration recipe; never relax dispatch authority.
 const claims=await db.query.fantasyLandClaims.findMany();
 const manifest=planFantasyMigration({snapshotAt:now.toISOString(),active:[seller,buyer].map(actor=>({baseId:actor.baseId,mintId:actor.deed,ownerWallet:actor.wallet})),inactive:[],exclusions:[],unavailableTileIds:claims.filter(claim=>claim.state!=='released').map(claim=>claim.tileId)});
 await rehearseFantasyMigration(db,manifest,fantasyManifestHash(manifest));
 async function refine(item:OrdinaryRefinedId,quantity:number,target=seller){
  const recipe=ordinaryCraftingRecipe(`refine_${item}`,C.currentRecipeVersion,quantity),rawId=ORDINARY_REFINED_INPUTS[item];
  const routeId=StarterCommonRouteIdSchema.options.find(id=>starterRoutePreview('crownlands',id).resourceId===rawId);
  if(!routeId)throw Error('No admitted common route for the original material');
  const route=starterRoutePreview('crownlands',routeId),required=BigInt(recipe.inputs[0]!.quantity);
  const [before]=await db.execute<{available:string}>(sql`select available::text from resource_stocks where base_id=${target.baseId} and resource_id=${rawId}`);
  const needed=required-BigInt(before?.available??'0'),returns=needed>0n?(needed+BigInt(route.netQuantity)-1n)/BigInt(route.netQuantity):0n;
  for(let i=0n;i<returns;i++){
   await refresh();const trip=await dispatchStarterExpedition(db,target.wallet,{...target.command,id:randomUUID(),routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion},target.authority,{reader:target.reader,clock:()=>now});
   advance(trip.returnsAt);await db.transaction(tx=>settleDueStarterExpeditions(tx,target.baseId,now));
   if(!await readStarterExpeditionReturn(db,trip.id))throw Error('Actual raw return is missing');
  }
  await refresh();const job=await startOrdinaryCrafting(db,target.wallet,{id:randomUUID(),baseId:target.baseId,recipeId:`refine_${item}`,recipeVersion:recipe.recipeVersion,quantity},target.authority,{clock:()=>now});
  advance(job.job.readyAt);await db.transaction(tx=>settleDueOrdinaryCrafting(tx,target.baseId,now));
 }
 const compass=ordinaryEquipmentRecipe(),kit=ordinaryCraftingRecipe('craft_navigation_kit',C.currentRecipeVersion,1);
 // One sale-sized surplus of every admitted refined item, plus exact real kit
 // inputs. Partial sale cases can leave remainder without minting test stock.
 for(const item of ORDINARY_REFINED_IDS){const tool=compass.inputs.find(i=>i.itemId===item),input=kit.inputs.find(i=>i.itemId===item);await refine(item,2*Number(tool?.quantity??'1')+Number(input?.quantity??'0'));}
 await refresh();const job=await startOrdinaryCrafting(db,seller.wallet,{id:randomUUID(),baseId:seller.baseId,recipeId:'craft_navigation_kit',recipeVersion:kit.recipeVersion,quantity:1},seller.authority,{clock:()=>now});
 advance(job.job.readyAt);await db.transaction(tx=>settleDueOrdinaryCrafting(tx,seller.baseId,now));await refresh();
 // The buyer earns its other Compass input itself; purchased prismstone_lens
 // must supply the missing input, so the market journey needs one real payment.
 for(const input of compass.inputs)if(input.itemId!=='prismstone_lens')await refine(input.itemId,Number(input.quantity),buyer);
 await refresh();
 async function buyerUsesPurchasedMaterials(){
  await refresh();const result=await startOrdinaryEquipment(db,buyer.wallet,{idempotencyKey:randomUUID(),baseId:buyer.baseId,recipeId:compass.recipeId,recipeVersion:compass.recipeVersion,quantity:1},buyer.authority,{clock:()=>now});
  if(result.status!=='accepted')throw Error('Buyer craft must consume actual delivered stock');
  advance(new Date(result.receipt.readyAt));await db.transaction(tx=>settleDueOrdinaryCrafting(tx,buyer.baseId,now));await refresh();
  const route=starterRoutePreview('crownlands','coastal_survey');const trip=await dispatchStarterExpedition(db,buyer.wallet,{...buyer.command,id:randomUUID(),routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion,fitting:{itemId:'route_compass',policyVersion:1}},buyer.authority,{reader:buyer.reader,clock:()=>now});
  advance(trip.returnsAt);await db.transaction(tx=>settleDueStarterExpeditions(tx,buyer.baseId,now));const returned=await readStarterExpeditionReturn(db,trip.id);
  if(!returned)throw Error('Buyer fitted return is missing');return {craft:result,trip,returned};
 }
 const stock=(baseId:string)=>db.execute<{item_id:string;available:string;pending_output:string;market_outgoing:string;market_incoming:string}>(sql`select item_id,available::text,pending_output::text,market_outgoing::text,market_incoming::text from crafting_stocks where base_id=${baseId} order by item_id`);
 return {conn,db,seller,buyer,collection,owners,deedReader,refresh,advance,clock:()=>new Date(now),stock,buyerUsesPurchasedMaterials,compass};
}
export type CraftingMarketSource=Awaited<ReturnType<typeof craftingMarketSource>>;
