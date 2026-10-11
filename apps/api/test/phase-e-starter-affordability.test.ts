/** B4 conservative cache-only schedule: starting grant -> built facilities ->
 * earned Compass. Mine output/quests/mail/obstacles are deliberately unclaimed;
 * this is neither optimal progression nor an assertion of enjoyable pacing. */
import {randomUUID} from 'node:crypto';
import {Keypair,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {and,eq,isNull} from 'drizzle-orm';
import {afterEach,expect,it,vi} from 'vitest';
import {BUILD_COSTS,BuildingType,DAILY_CACHE,ECONOMY,MINING,OBSTACLES,PHASE_E_MINING_PUBLICATION,
 PHASE_E_ORDINARY_CRAFTING as C,PHASE_E_STARTER_ACCESS,UPGRADE_COSTS,UPGRADE_TIMES_SEC} from '@shardkeep/shared';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {ordinaryCraftingRecipe} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer} from './helpers';
import {buildings,builderJobs,obstacles} from '../src/db/schema';
import {ensureStartingBase,placeBuilding,upgradeBuilding,completeDueJobs} from '../src/game/base';
import {assertFreshLockedBaseAuthority,ensureWalletBaseIdentity} from '../src/game/baseOwnership';
import {claimBaseDailyCache} from '../src/game/baseMining';
import {claimRect,footprintOf,overlaps} from '../src/game/footprints';
import {installStarterFleet} from '../src/game/starterFleet';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {dispatchStarterExpedition,type StarterExpeditionCommand} from '../src/game/starterExpeditionDispatch';
import {readStarterExpeditionReturn,settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {readOrdinaryCrafting,startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {ordinaryEquipmentEnvelope,startOrdinaryEquipment} from '../src/game/ordinaryEquipment';

afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('earns facility affordability from untaxed caches, then earns, crafts and recovers one reusable Compass',async()=>{
 const conn=resourceClaimsDatabase();await conn.setup();
 try{
  for(const flag of ['FREE_ONBOARDING','MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','STARTER_FLEET_ENABLED','STARTER_EXPEDITIONS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(flag,'true');
  vi.useFakeTimers({toFake:['Date']});let now=new Date('2020-01-01T01:00:00.000Z');vi.setSystemTime(now);
  const advance=(at:Date)=>{expect(+at).toBeGreaterThanOrEqual(+now);now=at;vi.setSystemTime(now);};
  const {wallet}=await createTestPlayer(conn.db),createdBaseId=await ensureWalletBaseIdentity(conn.db,wallet,{createEmpty:true});if(!createdBaseId)throw Error('Missing starting base');const baseId=createdBaseId;
  const authority={baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
  await ensureStartingBase(conn.db,wallet,baseId,authority.assertAuthority);
  const snapshot=async(names:readonly string[])=>{const result=[];for(const name of names)result.push(await conn.sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${conn.sql(name)} t`);return JSON.stringify(result);};
  const money=()=>snapshot(['accounts','ledger_transactions','ledger_entries']);
  const balance=async()=>BigInt((await conn.sql`select balance::text from accounts where base_id=${baseId} and kind='base_shards'`)[0]!.balance);
  expect(await balance()).toBe(BigInt(ECONOMY.starterShards));
  expect(await conn.sql`select * from resource_stocks`).toEqual([]);expect(await conn.sql`select * from crafting_stocks`).toEqual([]);expect(await conn.sql`select * from ordinary_equipment_stocks`).toEqual([]);
  const originalBuildings=await conn.db.select().from(buildings).where(eq(buildings.baseId,baseId));expect(originalBuildings.map(b=>b.type)).toEqual([BuildingType.Keep]);
  const keep=originalBuildings[0]!;
  // Use actual initial terrain; never clear/seed a tile or buy an expansion.
  async function position(type:BuildingType){
   const bs=await conn.db.select().from(buildings).where(eq(buildings.baseId,baseId)),os=await conn.db.select().from(obstacles).where(and(eq(obstacles.baseId,baseId),isNull(obstacles.clearedAt)));
   const occupied=[...bs.map(b=>({tx:b.tx,ty:b.ty,...footprintOf(b.type as BuildingType)})),...os.map(o=>{const tier=Object.values(OBSTACLES.tiers).find(t=>t.kinds.some(k=>k===o.spriteKey));if(!tier)throw Error('Unknown starting obstacle');return {tx:o.tx,ty:o.ty,fw:tier.sizeTiles,fh:tier.sizeTiles};})];
   const {min,max}=claimRect(0),fp=footprintOf(type);
   for(let ty=min;ty+fp.fh<=max;ty++)for(let tx=min;tx+fp.fw<=max;tx++)if(!occupied.some(o=>overlaps(o,{tx,ty,...fp})))return {tx,ty};
   throw Error('No initial space for required facility');
  }
  async function construct(type:BuildingType,key=randomUUID(),at?:{tx:number;ty:number}){
   const p=at??await position(type),built=await placeBuilding(conn.db,wallet,type,p.tx,p.ty,key,now,baseId,authority);
   const [job]=await conn.db.select().from(builderJobs).where(and(eq(builderJobs.buildingId,built.id),isNull(builderJobs.completedAt)));if(!job)throw Error('No real build job');
   expect(+job.finishesAt-+job.startedAt).toBe(BUILD_COSTS[type as keyof typeof BUILD_COSTS].buildSec*1000);
   advance(job.finishesAt);await completeDueJobs(conn.db,wallet,now,baseId);return built;
  }
  await construct(BuildingType.Mine);
  const cacheStart=new Date(now),dayMs=PHASE_E_MINING_PUBLICATION.daySec*1000;
  const requiredKeep=Math.max(...([BuildingType.Workshop,BuildingType.Lodge,BuildingType.Berth] as const).map(type=>BUILD_COSTS[type].requiresKeepLevel));
  const keepCosts=UPGRADE_COSTS.keep.slice(keep.level-1,requiredKeep-1),keepTimes=UPGRADE_TIMES_SEC.keep.slice(keep.level-1,requiredKeep-1);
  for(const [index,cost]of keepCosts.entries()){
   const before=await balance(),started=await upgradeBuilding(conn.db,wallet,keep.id,randomUUID(),now,{},baseId,authority);if(!started.job)throw Error('Missing real upgrade timer');
   expect(await balance()).toBe(before-BigInt(cost));expect(+started.job.finishesAt-+started.job.startedAt).toBe(keepTimes[index]!*1000);
   advance(started.job.finishesAt);await completeDueJobs(conn.db,wallet,now,baseId);
  }
  expect((await conn.db.select().from(buildings).where(eq(buildings.id,keep.id)))[0]!.level).toBe(requiredKeep);
  let cacheIncome=0n;
  const caches=DAILY_CACHE.consistencyStreakDays;
  for(let day=1;day<=caches;day++){
   if(day>1)advance(new Date(+cacheStart+(day-1)*dayMs));
   const reward=await claimBaseDailyCache(conn.db,wallet,authority,now),amount=BigInt(day*DAILY_CACHE.firstWeekStepShards);
   expect(reward.amount).toBe(amount);cacheIncome+=amount;
   const before=await money();await expect(claimBaseDailyCache(conn.db,wallet,authority,now)).rejects.toThrow('already claimed today');expect(await money()).toBe(before);
  }
  await construct(BuildingType.Workshop);await construct(BuildingType.Lodge);
  const mineCost=BigInt(MINING.MINE_BUILD_KEEP[0]!),upgradeCost=keepCosts.reduce((sum,c)=>sum+BigInt(c),0n),facilityCost=BigInt(BUILD_COSTS.workshop.costShards+BUILD_COSTS.lodge.costShards+BUILD_COSTS.berth.costShards);
  const allCosts=mineCost+upgradeCost+facilityCost,weekIncome=BigInt(ECONOMY.starterShards)+cacheIncome;
  const shortage=allCosts-weekIncome;expect(shortage).toBeGreaterThan(0n);expect(shortage).toBeLessThan(BigInt(DAILY_CACHE.consistentShards));
  expect(await balance()).toBe(BigInt(BUILD_COSTS.berth.costShards)-shortage);
  const berthKey=randomUUID(),berthPosition=await position(BuildingType.Berth),failedBefore=await snapshot(['buildings','builder_jobs','accounts','ledger_transactions','ledger_entries']);
  await expect(placeBuilding(conn.db,wallet,BuildingType.Berth,berthPosition.tx,berthPosition.ty,berthKey,now,baseId,authority)).rejects.toMatchObject({code:'INSUFFICIENT_SHARDS'});
  expect(await snapshot(['buildings','builder_jobs','accounts','ledger_transactions','ledger_entries'])).toBe(failedBefore);
  advance(new Date(+cacheStart+caches*dayMs));const nextCache=await claimBaseDailyCache(conn.db,wallet,authority,now);expect(nextCache.amount).toBe(BigInt(DAILY_CACHE.consistentShards));cacheIncome+=nextCache.amount;
  const berth=await construct(BuildingType.Berth,berthKey,berthPosition),installed=await installStarterFleet(conn.db,wallet,berth.id,authority);
  expect(await installStarterFleet(conn.db,wallet,berth.id,authority)).toEqual(installed);
  expect(await balance()).toBe(BigInt(ECONOMY.starterShards)+cacheIncome-allCosts);
  const credits=await conn.sql`select t.type,sum(e.delta)::text amount from ledger_entries e join ledger_transactions t on t.id=e.txn_id join accounts a on a.id=e.account_id where a.base_id=${baseId} and a.kind='base_shards' and e.delta>0 group by t.type order by t.type`;
  expect(credits).toEqual([{type:'base.starter_grant',amount:String(ECONOMY.starterShards)},{type:'cache.claim',amount:cacheIncome.toString()}]);
  const moneyBeforeTrips=await money();
  // A new encoded, signed fixture term is established after the cache schedule;
  // the first day's observation is never reused eight days later.
  const termDay=now.toISOString().slice(0,10),bank=await createMiningTermFixture({day:termDay,genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey,winners:[]});
  const trips:{command:StarterExpeditionCommand;proof:NonNullable<Awaited<ReturnType<typeof readStarterExpeditionReturn>>>}[]=[],crafts:NonNullable<Awaited<ReturnType<typeof readOrdinaryCrafting>>>[]=[];
  const totals=new Map<string,{gross:bigint;net:bigint;tax:bigint;used:bigint}>(),equipment=ordinaryEquipmentRecipe();
  async function sail(routeId:Parameters<typeof starterRoutePreview>[1],fitting?:StarterExpeditionCommand['fitting']){
   bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);
   const reader=await prefetchExpeditionTermReader(bank.connect,bank.policy),preview=starterRoutePreview(PHASE_E_STARTER_ACCESS.freeHomeRealm,routeId),command:StarterExpeditionCommand={id:randomUUID(),baseId,installationId:installed.installationId,routeId,routeVersion:preview.routeCatalogueVersion,rewardVersion:preview.rewardTableVersion,...fitting?{fitting}:{}};
   const accepted=await dispatchStarterExpedition(conn.db,wallet,command,authority,{reader,clock:()=>now});advance(accepted.returnsAt);await conn.db.transaction(tx=>settleDueStarterExpeditions(tx,baseId,now));
   const proof=(await readStarterExpeditionReturn(conn.db,accepted.id))!;expect(proof.entries.reduce((sum,e)=>sum+e.delta,0n)).toBe(0n);trips.push({command,proof});
   const total=totals.get(accepted.resourceId)??{gross:0n,net:0n,tax:0n,used:0n};total.gross+=accepted.gross;total.net+=accepted.net;total.tax+=accepted.tax;totals.set(accepted.resourceId,total);return accepted;
  }
  for(const [routeId,recipeId]of[['common_seeker_reach','refine_prismstone_lens'],['common_crownlands','refine_crownsteel']] as const){
   const unit=ordinaryCraftingRecipe(recipeId,C.currentRecipeVersion,1),needed=BigInt(equipment.inputs.find(i=>i.itemId===unit.output.itemId)!.quantity),quantity=Number((needed+BigInt(unit.output.quantity)-1n)/BigInt(unit.output.quantity)),recipe=ordinaryCraftingRecipe(recipeId,C.currentRecipeVersion,quantity),raw=recipe.inputs[0]!;
   const preview=starterRoutePreview(PHASE_E_STARTER_ACCESS.freeHomeRealm,routeId),count=Number((BigInt(raw.quantity)+BigInt(preview.netQuantity)-1n)/BigInt(preview.netQuantity));expect(preview.resourceId).toBe(raw.itemId);
   for(let trip=0;trip<count;trip++)await sail(routeId);
   const accepted=await startOrdinaryCrafting(conn.db,wallet,{id:randomUUID(),baseId,recipeId,recipeVersion:C.currentRecipeVersion,quantity},authority,{clock:()=>now});advance(accepted.job.readyAt);await conn.db.transaction(tx=>settleDueOrdinaryCrafting(tx,baseId,now));
   crafts.push((await readOrdinaryCrafting(conn.db,accepted.job.id))!);totals.get(preview.resourceId)!.used+=BigInt(raw.quantity);
  }
  const command={idempotencyKey:randomUUID(),baseId,recipeId:equipment.recipeId,recipeVersion:equipment.recipeVersion,quantity:equipment.quantity},accepted=await startOrdinaryEquipment(conn.db,wallet,command,authority,{clock:()=>now});if(accepted.status!=='accepted')throw Error('Equipment craft not accepted');
  advance(new Date(accepted.receipt.readyAt));await conn.db.transaction(tx=>settleDueOrdinaryCrafting(tx,baseId,now));
  const equipmentStock=()=>conn.sql`select item_id,available::text,reserved::text,pending_output::text from ordinary_equipment_stocks where base_id=${baseId} order by item_id`;
  expect(await equipmentStock()).toEqual([{item_id:equipment.output.itemId,available:equipment.output.quantity,reserved:'0',pending_output:'0'}]);
  if(equipment.output.itemId!=='route_compass')throw Error('Expected the accepted Compass recipe');
  const fitted=await sail('coastal_survey',{itemId:equipment.output.itemId,policyVersion:equipment.recipeVersion});expect(fitted.routeSnapshot.fitting).toBeDefined();expect(await equipmentStock()).toEqual([{item_id:equipment.output.itemId,available:equipment.output.quantity,reserved:'0',pending_output:'0'}]);
  for(const [resourceId,total]of totals){const [stock]=await conn.sql`select available::text,reserved::text from resource_stocks where base_id=${baseId} and resource_id=${resourceId}`;expect(stock).toEqual({available:(total.net-total.used).toString(),reserved:'0'});expect(total.gross).toBe(total.tax+total.used+BigInt(stock!.available));}
  expect(await conn.sql`select item_id,available::text,pending_output::text from crafting_stocks where base_id=${baseId} order by item_id`).toEqual(equipment.inputs.map(i=>({item_id:i.itemId,available:'0',pending_output:'0'})).sort((a,b)=>a.item_id.localeCompare(b.item_id)));
  expect(await money()).toBe(moneyBeforeTrips);
  const receipt=await ordinaryEquipmentEnvelope(conn.db,wallet,command.idempotencyKey),state=await snapshot(['resource_stocks','crafting_stocks','ordinary_equipment_stocks','starter_expeditions','starter_expedition_returns','ordinary_equipment_jobs','ordinary_equipment_completions']),reopened=conn.reopen();
  try{
   for(const flag of ['PHASE_E_BUILDINGS_ENABLED','STARTER_EXPEDITIONS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(flag,'false');
   expect(await ordinaryEquipmentEnvelope(reopened.db,wallet,command.idempotencyKey)).toEqual(receipt);expect(await startOrdinaryEquipment(reopened.db,wallet,command,authority)).toEqual(receipt);
   for(const saved of trips){expect(await readStarterExpeditionReturn(reopened.db,saved.proof.expedition.id)).toEqual(saved.proof);expect(await dispatchStarterExpedition(reopened.db,wallet,saved.command,authority,{reader:{readOperatingTerm:async()=>{throw Error('Original replay must not read a current term');}}})).toEqual(saved.proof.expedition);}
   for(const saved of crafts)expect(await readOrdinaryCrafting(reopened.db,saved.job.id)).toEqual(saved);
   await reopened.db.transaction(tx=>settleDueStarterExpeditions(tx,baseId,now));await reopened.db.transaction(tx=>settleDueOrdinaryCrafting(tx,baseId,now));
   expect(await snapshot(['resource_stocks','crafting_stocks','ordinary_equipment_stocks','starter_expeditions','starter_expedition_returns','ordinary_equipment_jobs','ordinary_equipment_completions'])).toBe(state);expect(await money()).toBe(moneyBeforeTrips);
  }finally{await reopened.sql.end();}
 }finally{await conn.close();}
},120000);
