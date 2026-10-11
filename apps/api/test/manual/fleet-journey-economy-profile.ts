/** Opt-in manual fixture only. Importing this module performs no work. */
import { BUILD_COSTS, FORGE_INGOT, PHASE_E_BUILDINGS, PLAYTEST } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { bootstrapSystemAccounts, postTransaction } from '../../src/ledger';
import { fundGemsRewardBudget, grantWelcomeGems } from '../../src/game/gemsGrants';
import { rewardBaseShards } from '../../src/game/baseEconomy';

const stages=['gems','forge','harvesters','awning'] as const;
export type EconomyStage=typeof stages[number];
export type FixtureProfile={name:'fleet-journey';through:null}|{name:'phase-e-economy';through:EconomyStage};

/** Parent supplies the pinned owned-stack configuration. Never discover or fall
 * back to another database; this repeats the supervisor's endpoint boundary. */
export function ownedFixtureEndpoints(admin:unknown,target:unknown,redis:unknown,sha256:unknown) {
  const parse=(raw:unknown,code:string)=>{try {
    if(typeof raw!=='string'||raw.length>4096||/\s/.test(raw))throw Error();
    const url=new URL(raw);if(url.hostname!=='127.0.0.1'||!url.port||Number(url.port)<1024||Number(url.port)>65535||url.search||url.hash)throw Error();
    return url;
  }catch{throw Error(code);}};
  const a=parse(admin,'OWNED_STACK_POSTGRES'),b=parse(target,'OWNED_STACK_POSTGRES'),r=parse(redis,'OWNED_STACK_REDIS');
  if(!['postgres:','postgresql:'].includes(a.protocol)||a.protocol!==b.protocol||[5433,55492].includes(Number(a.port))||[5433,55492].includes(Number(b.port))||a.pathname!=='/postgres'||b.pathname!=='/shardkeep_test'||!a.username||a.port!==b.port||a.username!==b.username||a.password!==b.password)throw Error('OWNED_STACK_POSTGRES');
  if(r.protocol!=='redis:'||!/^\/[0-9]+$/.test(r.pathname))throw Error('OWNED_STACK_REDIS');
  if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw Error('OWNED_STACK_IDENTITY');
  return {adminUrl:a,redisUrl:String(redis),publicRedis:`redis://${r.hostname}:${r.port}${r.pathname}`,sha256};
}

/** Add only the five Build 2 screen reads. No headers, body, raw error or
 * arbitrary query value is copied. Existing fleet/Wake logging stays separate. */
export function economyReadMetadata(profile:FixtureProfile,method:string,rawUrl:string,status:number,serverNow:string) {
  if(profile.name!=='phase-e-economy'||method!=='GET'||!rawUrl.startsWith('/')||rawUrl.startsWith('//'))return null;
  const url=new URL(rawUrl,'http://fixture.invalid');
  if(!['/gems','/workshop','/balances','/harvesters','/bound-cosmetics'].includes(url.pathname))return null;
  const base=url.searchParams.get('baseId');
  const suffix=base!==null&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(base)?'?baseId='+base:'';
  return {method,path:url.pathname+suffix,status,created:null,serverNow};
}

export function parseFixtureProfile(argv:readonly string[]):FixtureProfile {
  const option=(name:string)=>{
    if(argv.some(arg=>arg.startsWith(name+'='))||argv.filter(arg=>arg===name).length>1)throw Error('E2_PROFILE_REFUSED');
    const index=argv.indexOf(name);if(index<0)return null;
    const value=argv[index+1];if(!value||value.startsWith('--'))throw Error('E2_PROFILE_REFUSED');return value;
  };
  const profile=option('--profile')??'fleet-journey',through=option('--economy-through');
  if(profile==='fleet-journey'&&through===null)return {name:profile,through:null};
  if(profile!=='phase-e-economy'||through!==null&&!stages.includes(through as EconomyStage))throw Error('E2_PROFILE_REFUSED');
  return {name:profile,through:(through??'awning') as EconomyStage};
}
export const includesEconomyStage=(profile:FixtureProfile,stage:EconomyStage)=>
  profile.name==='phase-e-economy'&&profile.through!==null&&stages.indexOf(profile.through)>=stages.indexOf(stage);
export const economyKeepLevel=(profile:FixtureProfile)=>includesEconomyStage(profile,'harvesters')
  ?BUILD_COSTS.harvester.requiresKeepLevel:1;

/** A reviewable cumulative frontier permits a→b→c checks in separate starts.
 * This never changes config defaults or enables wallet buy/mining/chain work. */
export function economyFlags<T extends Record<string,'true'|'false'>>(profile:FixtureProfile,base:T):{[K in keyof T]:'true'|'false'} {
  const flags={...base};
  if(profile.name==='fleet-journey')return flags;
  for(const name of ['PHASE_E_MINING_ENABLED','GEMS_WALLET_BUY_ENABLED','KEEP_EQUIPMENT_MARKET_ENABLED','MINING_CLAIM_ORDERED_ENABLED','GEMS_ENABLED','DEVNET_WELCOME_GEMS_ENABLED','FORGE_INGOTS_ENABLED','HARVESTERS_ENABLED'])
    if(base[name]!=='false')throw Error('E2_CLOSED_FLAG');
  // Fixture-only: Gold Forge presence must not open the legacy custodial route.
  // Ordinary Forge Ingots retain their independent canonical stage gate.
  const enabled:Record<string,'true'|'false'>={FORGE_ENABLED:'false',GEMS_ENABLED:'true',DEVNET_WELCOME_GEMS_ENABLED:'true',
    ...(includesEconomyStage(profile,'forge')?{FORGE_INGOTS_ENABLED:'true'}:{}),
    ...(includesEconomyStage(profile,'harvesters')?{HARVESTERS_ENABLED:'true'}:{})};
  return {...flags,...enabled};
}

/** One canonical Forge price, journaled only in this disposable run's database.
 * The startup balance read independently proves spendability before READY. */
export async function seedEconomyForge(db:Db,baseId:string,runId:string) {
  if(process.env['NODE_ENV']!=='test'||process.env['SOLANA_CLUSTER']!=='devnet'
    ||process.env['FORGE_INGOTS_ENABLED']!=='true'||!/^[0-9a-f]{32}$/.test(runId)
    ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(baseId))throw Error('E2_FORGE_SEED_REFUSED');
  return db.transaction(async tx=>{
    const [database]=await tx.execute<{name:string}>(sql`select current_database() name`);
    if(database?.name!=='fleet_journey_'+runId+'_test')throw Error('E2_FORGE_SEED_REFUSED');
    const posted=await rewardBaseShards(tx,baseId,BigInt(FORGE_INGOT.shardsPerIngot),
      'fixture.economy.forge-input','fixture:economy:forge:'+runId,{fixture:true,runId});
    if(posted.duplicate)throw Error('E2_FORGE_SEED_REFUSED');
    return posted;
  });
}

export interface WelcomeLedgerRow extends Record<string,unknown> {kind:string;currency:string;delta:string;ownerWallet:string|null;baseId:string|null}
export interface WelcomeProof {wallet:string;gems:string;entryCount:4}
export function assertWelcomeLedger(wallet:string,rows:readonly WelcomeLedgerRow[]):WelcomeProof {
  const gems=BigInt(PLAYTEST.welcomeGems),expected=[
    ['gems_reward_budget','KEEP',String(-gems),null],['emission_pool','KEEP',String(gems),null],
    ['gems_mint','GEMS',String(-gems),null],['player_gems','GEMS',String(gems),wallet],
  ];
  if(rows.length!==4||expected.some(([kind,currency,delta,owner])=>rows.filter(row=>row.kind===kind&&row.currency===currency
    &&row.delta===delta&&row.ownerWallet===owner&&row.baseId===null).length!==1))throw Error('E2_WELCOME_LEDGER_REFUSED');
  return {wallet,gems:String(gems),entryCount:4};
}

/** Same fixture-only journal chain as existing fundedMining fixtures: declared
 * KEEP genesis input → emission pool → reward budget → normal welcome grant.
 * Each entry is produced by the normal ledger; no balance UPDATE or fake Gems. */
export async function seedEconomyWelcome(db:Db,wallet:string,runId:string) {
  if(process.env['NODE_ENV']!=='test'||process.env['SOLANA_CLUSTER']!=='devnet'
    ||process.env['GEMS_ENABLED']!=='true'||process.env['DEVNET_WELCOME_GEMS_ENABLED']!=='true'
    ||!/^[0-9a-f]{32}$/.test(runId))throw Error('E2_WELCOME_SEED_REFUSED');
  return db.transaction(async tx=>{
    const [database]=await tx.execute<{name:string}>(sql`select current_database() name`);
    if(database?.name!=='fleet_journey_'+runId+'_test')throw Error('E2_WELCOME_SEED_REFUSED');
    const sys=await bootstrapSystemAccounts(tx),gems=BigInt(PLAYTEST.welcomeGems);
    const input=await postTransaction(tx,{idempotencyKey:'fixture:economy:welcome:'+runId,type:'fixture.economy.welcome-input',
      entries:[{account:sys.keep_genesis,delta:-gems},{account:sys.emission_pool,delta:gems}],metadata:{fixture:true,runId,wallet}});
    const budget=await fundGemsRewardBudget(tx,gems,'fixture-economy:'+runId,{fixture:true,runId,wallet});
    const grant=await grantWelcomeGems(tx,wallet);
    if(input.duplicate||budget.duplicate||grant.duplicate)throw Error('E2_WELCOME_SEED_REFUSED');
    const rows=await tx.execute<WelcomeLedgerRow>(sql`select a.kind,a.currency,e.delta::text delta,
      a.owner_wallet as "ownerWallet",a.base_id as "baseId" from ledger_entries e
      join accounts a on a.id=e.account_id where e.txn_id=${grant.transaction.id}::uuid`);
    return {...assertWelcomeLedger(wallet,rows),fixtureInputId:input.transaction.id,budgetId:budget.transaction.id,
      grantId:grant.transaction.id,provenance:'synthetic disposable-fixture KEEP input; normal backed welcome grant'};
  });
}

export interface StartupProof {feature:EconomyStage;status:'passed'|'held'|'failed';observedAt:string;detail:string}
interface StartupIO {get:(path:string)=>Promise<unknown>;record:(proof:StartupProof)=>void;now:()=>string}
type View=Record<string,unknown>;
const object=(value:unknown):View=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as View:{};
const member=(value:unknown,key:string)=>object(value)[key];
const onlyLedger=(value:unknown)=>Array.isArray(value)&&value.length===1&&value[0]==='ledger-keep';

/** Normal authenticated GETs, once per direct route; failures stop the frontier.
 * /base and routes that call getBaseState can settle due state and drain one-shot
 * starter-return events. These checks are not side-effect-free snapshots.
 * Route implementations own schema parsing/authorization. These extra checks
 * bind advertised features to this fixture's actual actor/base/facility/grant. */
export async function checkEconomyStartup(profile:FixtureProfile,identity:{wallet:string;baseId:string;harvesterId:string|null;welcome:WelcomeProof|null;inWorld:{starterInstallationId:string;starterBerthId:string;goldForgeId:string|null;nativePresentation:boolean}},io:StartupIO,expectedCustody:'open'|'fenced'='open'):Promise<void> {
  if(profile.name==='fleet-journey')return;
  const {wallet,baseId,harvesterId,welcome}=identity;
  // The fixture caller binds the actual custody setup; never infer it from a DTO.
  // Open/older fixtures retain the exact ledger source; fenced fixtures require none.
  const expectedSources=(value:unknown)=>expectedCustody==='fenced'
    ?Array.isArray(value)&&value.length===0:expectedCustody==='open'&&onlyLedger(value);
  let capability:View={};
  const check=async(feature:EconomyStage,run:()=>Promise<{status:'passed'|'held';detail:string}>)=>{
    if(!includesEconomyStage(profile,feature))return;
    try {const result=await run();io.record({feature,...result,observedAt:io.now()});}
    catch {io.record({feature,status:'failed',observedAt:io.now(),detail:'Startup prerequisite refused; inspect private response evidence.'});
      throw Error('E2_'+feature.toUpperCase()+'_STARTUP_REFUSED');}
  };
  await check('gems',async()=>{
    if(!welcome||welcome.wallet!==wallet||welcome.gems!==String(PLAYTEST.welcomeGems)||welcome.entryCount!==4)throw Error();
    capability=object(await io.get('/native/capabilities'));
    const view=object(await io.get('/gems')),feature=object(member(view.features,'gems')),
      advertised=object(member(capability.economy,'gems'));
    // The actual contract has version/receipts/exactConsent, NOT a supported bit.
    if(feature.version!==1||feature.receipts!==1||feature.exactConsent!==1||view.gems!==welcome.gems
      ||!expectedSources(view.sources)||advertised.enabled!==true||!expectedSources(advertised.sources))throw Error();
    return {status:'passed',detail:'Exact Gems consent/receipt contract and backed fixture-wallet balance; wallet buy closed.'};
  });
  await check('forge',async()=>{
    const view=object(await io.get('/workshop?baseId='+baseId)),feature=object(member(view.features,'workshop'));
    if(member(member(capability.economy,'workshop'),'enabled')!==true||feature.version!==1||feature.receipts!==1||feature.allowance!==1
      ||view.acceptingJobs!==true||typeof view.level!=='number'||view.level<1||member(view.inventory,'baseId')!==baseId)throw Error();
    // /balances authenticates and resolves this exact owned base; its shards
    // field comes from base_shards, not the legacy player_shards account.
    const balance=object(await io.get('/balances?baseId='+baseId));
    if(typeof balance.shards!=='string'||!/^(0|[1-9][0-9]*)$/.test(balance.shards)
      ||BigInt(balance.shards)<BigInt(FORGE_INGOT.shardsPerIngot))throw Error();
    return {status:'passed',detail:'Normal selected-base Workshop admits Forge Ingot jobs; its base SHARDS cover at least one canonical ingot price. Job completion remains unproved.'};
  });
  await check('harvesters',async()=>{
    // IW5 reuses the existing all-facility economy seed. Prove the normal base
    // response, not a second seed or a hand-written display DTO, before READY.
    // This normal GET can settle due crafting/harvesters and drain one-shot
    // journey events. Its startup proof is not a pre-settlement state snapshot.
    const current=object(await io.get('/base?baseId='+baseId)),player=object(current.player),
      discovery=object(member(current.features,'phaseEBuildings')),
      buildings=Array.isArray(current.buildings)?current.buildings:[],keepLevel=economyKeepLevel(profile);
    const completed=(type:string,id?:string)=>buildings.some(row=>member(row,'type')===type
      &&(id===undefined||member(row,'id')===id)&&member(row,'underConstruction')===false
      &&typeof member(row,'level')==='number'&&Number.isInteger(member(row,'level'))&&(member(row,'level') as number)>=1);
    if(current.baseId!==baseId||player.wallet!==wallet||player.keepLevel!==keepLevel
      ||!buildings.some(row=>member(row,'type')==='keep'&&member(row,'level')===keepLevel&&member(row,'underConstruction')===false)
      ||PHASE_E_BUILDINGS.types.some(type=>!completed(type))||!harvesterId||!completed('harvester',harvesterId)
      ||!completed('berth',identity.inWorld.starterBerthId)||!identity.inWorld.goldForgeId
      ||!completed('goldforge',identity.inWorld.goldForgeId)||discovery.version!==1
      ||!Array.isArray(discovery.enabledTypes)||discovery.enabledTypes.length!==PHASE_E_BUILDINGS.types.length
      ||discovery.enabledTypes.some((type,index)=>type!==PHASE_E_BUILDINGS.types[index]))throw Error();
    const installation=object(member(current.starterFleet,'installation'));
    if(installation.installationId!==identity.inWorld.starterInstallationId
      ||installation.berthId!==identity.inWorld.starterBerthId)throw Error();
    if(identity.inWorld.nativePresentation){
      const art=object(member(current.features,'phaseEArt')),capabilityArt=object(capability.phaseEArt),visual=object(current.visualContext);
      if(art.version!==1||art.enabled!==true||capabilityArt.version!==1||capabilityArt.enabled!==true
        ||visual.version!==1||visual.realmId!=='crownlands'||visual.artVersion!==2||visual.groundRevision!==4)throw Error();
    }
    const view=object(await io.get('/harvesters?baseId='+baseId));
    const feature=object(member(view.features,'harvesters'));
    if(!harvesterId||view.wallet!==wallet||view.baseId!==baseId||view.acceptingSelections!==true
      ||feature.version!==1||feature.receipts!==1
      ||member(view.home,'source')!=='deed_location'||member(view.home,'realmId')!=='crownlands'
      ||!Array.isArray(view.facilities)||!view.facilities.some(row=>member(row,'baseId')===baseId&&member(row,'harvesterId')===harvesterId)
      ||!Array.isArray(view.rawStock)||!view.rawStock.some(row=>member(row,'resourceId')==='crown_iron_ore'
        &&typeof member(row,'available')==='string'&&/^[1-9][0-9]*$/.test(member(row,'available') as string)))throw Error();
    return {status:'passed',detail:'Normal same-wallet/base Keep and all five completed facilities plus the exact seeded completed Gold Forge, exact five-type discovery and original starter identity; same-base completed Harvester, Crownlands raw stock and synthetic fixture term (createMiningTermFixture, same object as the starter provider).'};
  });
  await check('awning',async()=>{
    const view=object(await io.get('/bound-cosmetics?baseId='+baseId));
    if(view.wallet!==wallet||member(view.selectedBase,'baseId')!==baseId||member(view.selectedBase,'state')!=='available'
      ||!Array.isArray(member(view.selectedBase,'markets'))||(member(view.selectedBase,'markets') as unknown[]).length===0||typeof view.applicationReady!=='boolean'
      ||typeof view.acceptingJobs!=='boolean'||view.acceptingJobs!==view.applicationReady)throw Error();
    return view.applicationReady?{status:'passed',detail:'Normal server Awning application readiness; native rendering still unproved.'}
      :{status:'held',detail:'Normal Awning application readiness unavailable (Market art or exact bindings); no override, craft or preference mutation.'};
  });
}
