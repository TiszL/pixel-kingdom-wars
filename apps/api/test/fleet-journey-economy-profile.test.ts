/** Author-only E2 tests. No listener, database, process or chain fixture. */
import { describe, expect, it } from 'vitest';
import { BUILD_COSTS, FORGE_INGOT, PHASE_E_BUILDINGS, PLAYTEST } from '@shardkeep/shared';
import { gemsEnabled, gemsWalletBuyEnabled, devnetWelcomeGemsEnabled, forgeIngotsEnabled,
  harvestersEnabled, phaseEMiningEnabled, keepEquipmentMarketEnabled } from '../src/config';
import { economyFlags, economyKeepLevel, parseFixtureProfile, assertWelcomeLedger, checkEconomyStartup,
  ownedFixtureEndpoints, economyReadMetadata,
  type StartupProof, type WelcomeLedgerRow } from './manual/fleet-journey-economy-profile';

const wallet='fixture-wallet',baseId='fixture-base',harvesterId='fixture-harvester';

describe('Build 2 owned endpoints and additive read metadata',()=>{
  const endpoints=()=>({admin:'postgres://test:test@127.0.0.1:55470/postgres',target:'postgres://test:test@127.0.0.1:55470/shardkeep_test',redis:'redis://127.0.0.1:6397/0',sha256:'a'.repeat(64)});
  it('accepts explicit matching local stack endpoints only',()=>{
    const x=endpoints();expect(ownedFixtureEndpoints(x.admin,x.target,x.redis,x.sha256).redisUrl).toBe(x.redis);
  });
  it.each(['55492','5433'])('refuses excluded Postgres port %s independently of Python',(port)=>{
    const x=endpoints();expect(()=>ownedFixtureEndpoints(x.admin.replace('55470',port),x.target.replace('55470',port),x.redis,x.sha256)).toThrow('OWNED_STACK_POSTGRES');
  });
  it('refuses foreign/mismatched endpoints and missing identity without echoing credentials',()=>{
    const x=endpoints();
    for(const args of [[x.admin.replace('127.0.0.1','foreign'),x.target,x.redis,x.sha256],[x.admin,x.target.replace('55470','55471'),x.redis,x.sha256],[x.admin,x.target,'redis://127.0.0.1:9',x.sha256],[x.admin,x.target,x.redis,'']])
      expect(()=>ownedFixtureEndpoints(args[0],args[1],args[2],args[3])).toThrow(/^OWNED_STACK_/);
  });
  it.each(['/gems','/workshop','/balances','/harvesters','/bound-cosmetics'])('records only the added GET read %s',(path)=>{
    const row=economyReadMetadata({name:'phase-e-economy',through:'awning'},'GET',path,200,'synthetic');
    expect(row).toEqual({method:'GET',path,status:200,created:null,serverNow:'synthetic'});
  });
  it('leaves default profile, POSTs and existing Wake/equipment capture to the old logger',()=>{
    for(const [profile,method,path] of [[{name:'fleet-journey',through:null},'GET','/gems'],[{name:'phase-e-economy',through:'awning'},'POST','/workshop/jobs'],[{name:'phase-e-economy',through:'awning'},'GET','/bound-cosmetics/wakes/v1/workshop'],[{name:'phase-e-economy',through:'awning'},'GET','/ordinary-equipment']] as const)
      expect(economyReadMetadata(profile,method,path,200,'synthetic')).toBeNull();
  });
  it('retains non-2xx read status and only a valid baseId, never arbitrary query secrets',()=>{
    const base='11111111-1111-4111-8111-111111111111';
    const row=economyReadMetadata({name:'phase-e-economy',through:'awning'},'GET','/balances?baseId='+base+'&token=SYNTHETIC_SECRET',503,'synthetic');
    expect(row?.path).toBe('/balances?baseId='+base);expect(row?.status).toBe(503);expect(JSON.stringify(row)).not.toContain('SYNTHETIC_SECRET');
    expect(economyReadMetadata({name:'phase-e-economy',through:'awning'},'GET','/balances?baseId=SYNTHETIC_SECRET',400,'synthetic')?.path).toBe('/balances');
  });
});
const amount=BigInt(PLAYTEST.welcomeGems),at='2026-10-02T00:00:00.000Z';
const closed={GEMS_ENABLED:'false',DEVNET_WELCOME_GEMS_ENABLED:'false',FORGE_INGOTS_ENABLED:'false',
  HARVESTERS_ENABLED:'false',PHASE_E_MINING_ENABLED:'false',GEMS_WALLET_BUY_ENABLED:'false',
  KEEP_EQUIPMENT_MARKET_ENABLED:'false',MINING_CLAIM_ORDERED_ENABLED:'false'} as const;
const rows=():WelcomeLedgerRow[]=>[
  {kind:'gems_reward_budget',currency:'KEEP',delta:String(-amount),ownerWallet:null,baseId:null},
  {kind:'emission_pool',currency:'KEEP',delta:String(amount),ownerWallet:null,baseId:null},
  {kind:'gems_mint',currency:'GEMS',delta:String(-amount),ownerWallet:null,baseId:null},
  {kind:'player_gems',currency:'GEMS',delta:String(amount),ownerWallet:wallet,baseId:null},
];
const starterInstallationId='fixture-starter',starterBerthId='fixture-berth',goldForgeId='fixture-gold-forge';
function inWorldBase() {
  return {baseId,player:{wallet,keepLevel:BUILD_COSTS.harvester.requiresKeepLevel as number},
    visualContext:{version:1,realmId:'crownlands',artVersion:2,groundRevision:4},
    features:{phaseEBuildings:{version:1,enabledTypes:[...PHASE_E_BUILDINGS.types] as string[]},phaseEArt:{version:1,enabled:true}},
    buildings:[{id:'keep',type:'keep',level:BUILD_COSTS.harvester.requiresKeepLevel,underConstruction:false},
      {id:goldForgeId,type:'goldforge',level:1,underConstruction:false},
      ...PHASE_E_BUILDINGS.types.map(type=>({id:type==='berth'?starterBerthId:type==='harvester'?harvesterId:'fixture-'+type,
        type:type as string,level:1,underConstruction:false}))],
    starterFleet:{installation:{installationId:starterInstallationId,berthId:starterBerthId}}};
}
function harness(overrides:Record<string,unknown>={}) {
  const calls:string[]=[],proofs:StartupProof[]=[];
  const payloads:Record<string,unknown>={
    '/native/capabilities':{phaseEArt:{version:1,enabled:true},economy:{gems:{enabled:true,sources:['ledger-keep']},workshop:{enabled:true}}},
    ['/base?baseId='+baseId]:inWorldBase(),
    '/gems':{features:{gems:{version:1,receipts:1,exactConsent:1}},gems:String(amount),sources:['ledger-keep']},
    ['/workshop?baseId='+baseId]:{features:{workshop:{version:1,receipts:1,allowance:1}},acceptingJobs:true,level:1,inventory:{baseId}},
    ['/balances?baseId='+baseId]:{shards:String(FORGE_INGOT.shardsPerIngot)},
    ['/harvesters?baseId='+baseId]:{wallet,baseId,features:{harvesters:{version:1,receipts:1}},acceptingSelections:true,home:{source:'deed_location',realmId:'crownlands'},
      facilities:[{baseId,harvesterId}],rawStock:[{resourceId:'crown_iron_ore',available:'1000'}]},
    ['/bound-cosmetics?baseId='+baseId]:{wallet,applicationReady:false,acceptingJobs:false,selectedBase:{baseId,state:'available',markets:[{buildingId:'market'}]}},
    ...overrides,
  };
  return {calls,proofs,get:async(path:string)=>{calls.push(path);if(!(path in payloads))throw Error('unexpected route');return payloads[path];},
    record:(proof:StartupProof)=>{proofs.push(proof);},now:()=>at};
}
const economy=(through='awning')=>parseFixtureProfile(['--profile','phase-e-economy','--economy-through',through]);
const identity={wallet,baseId,harvesterId,welcome:assertWelcomeLedger(wallet,rows()),
  inWorld:{starterInstallationId,starterBerthId,goldForgeId,nativePresentation:true}};

describe('explicit fixture profile and staged flags',()=>{
  it('retains the original default and leaves the supplied flags untouched',()=>{
    const profile=parseFixtureProfile([]);expect(profile).toEqual({name:'fleet-journey',through:null});
    expect(economyFlags(profile,closed)).toEqual(closed);expect(closed.GEMS_ENABLED).toBe('false');
    expect(economyFlags(profile,closed)).not.toHaveProperty('FORGE_ENABLED');
    const inherited={...closed,FORGE_ENABLED:'true'} as const;
    expect(economyFlags(profile,inherited)).toEqual(inherited);
  });
  it('enables only Gems and welcome aid in stage a',()=>{
    expect(economyFlags(economy('gems'),closed)).toEqual({...closed,FORGE_ENABLED:'false',GEMS_ENABLED:'true',DEVNET_WELCOME_GEMS_ENABLED:'true'});
  });
  it('adds only Forge in stage b',()=>{
    expect(economyFlags(economy('forge'),closed)).toEqual({...closed,FORGE_ENABLED:'false',GEMS_ENABLED:'true',DEVNET_WELCOME_GEMS_ENABLED:'true',FORGE_INGOTS_ENABLED:'true'});
  });
  it('adds only Harvesters in stage c and no further flags for the Awning probe',()=>{
    const expected={...closed,FORGE_ENABLED:'false',GEMS_ENABLED:'true',DEVNET_WELCOME_GEMS_ENABLED:'true',FORGE_INGOTS_ENABLED:'true',HARVESTERS_ENABLED:'true'};
    expect(economyFlags(economy('harvesters'),closed)).toEqual(expected);
    expect(economyFlags(economy(),closed)).toEqual(expected);
  });
  it.each(['gems','forge','harvesters','awning'])('closes only legacy custodial Forge in economy stage %s',through=>{
    // A Gold Forge building and ordinary Forge Ingots never authorize the old
    // custodial KEEP forging route. An inherited true must not reopen it.
    const inherited={...closed,MULTI_BASE_ENABLED:'true',PHASE_E_BUILDINGS_ENABLED:'true',FORGE_ENABLED:'true'} as const;
    const flags=economyFlags(economy(through),inherited);
    expect(flags.FORGE_ENABLED).toBe('false');
    expect(forgeIngotsEnabled(flags)).toBe(through!=='gems');
    expect(inherited.FORGE_ENABLED).toBe('true');
  });
  it.each([['--profile'],['--profile','other'],['--profile','phase-e-economy','--profile','fleet-journey'],
    ['--economy-through','gems'],['--profile','phase-e-economy','--economy-through','mining'],
    ['--profile=phase-e-economy'],['--profile','phase-e-economy','--economy-through','gems','--economy-through','forge']].map(args=>({args})))('refuses ambiguous or widened selection $args',({args})=>{
    expect(()=>parseFixtureProfile(args)).toThrow('E2_PROFILE_REFUSED');
  });
  it('does not allow a pre-enabled money-adjacent family to enter the profile',()=>{
    expect(()=>economyFlags(economy(),{...closed,PHASE_E_MINING_ENABLED:'true'})).toThrow('E2_CLOSED_FLAG');
    expect(()=>economyFlags(economy(),{...closed,GEMS_WALLET_BUY_ENABLED:'true'})).toThrow('E2_CLOSED_FLAG');
  });
  it('refuses pre-enabled equipment market or ordered mining claims',()=>{
    for(const name of ['KEEP_EQUIPMENT_MARKET_ENABLED','MINING_CLAIM_ORDERED_ENABLED'])
      expect(()=>economyFlags(economy(),{...closed,[name]:'true'})).toThrow('E2_CLOSED_FLAG');
  });
  it('uses the canonical Harvester Keep gate only for the Harvester frontier',()=>{
    expect(economyKeepLevel(parseFixtureProfile([]))).toBe(1);
    for(const through of ['gems','forge'])expect(economyKeepLevel(economy(through))).toBe(1);
    for(const through of ['harvesters','awning'])expect(economyKeepLevel(economy(through))).toBe(BUILD_COSTS.harvester.requiresKeepLevel);
  });
  it('keeps production defaults dark using the actual config predicates',()=>{
    for(const predicate of [gemsEnabled,gemsWalletBuyEnabled,devnetWelcomeGemsEnabled,forgeIngotsEnabled,harvestersEnabled,phaseEMiningEnabled,keepEquipmentMarketEnabled])
      expect(predicate({})).toBe(false);
  });
  it.each(['gems','forge','harvesters','awning'])('actual config admits only the %s frontier',through=>{
    const flags=economyFlags(economy(through),{...closed,MULTI_BASE_ENABLED:'true',PHASE_E_BUILDINGS_ENABLED:'true'});
    expect(gemsEnabled(flags)).toBe(true);expect(devnetWelcomeGemsEnabled(flags)).toBe(true);
    expect(forgeIngotsEnabled(flags)).toBe(through!=='gems');
    expect(harvestersEnabled(flags)).toBe(through==='harvesters'||through==='awning');
    expect(phaseEMiningEnabled(flags)).toBe(false);expect(gemsWalletBuyEnabled(flags)).toBe(false);
    expect(keepEquipmentMarketEnabled(flags)).toBe(false);expect(flags.MINING_CLAIM_ORDERED_ENABLED).toBe('false');
  });
});
describe('journaled welcome grant evidence',()=>{
  it('accepts the exact four-entry KEEP-backed welcome amount',()=>expect(assertWelcomeLedger(wallet,rows())).toEqual({wallet,gems:String(amount),entryCount:4}));
  it.each(['owner','amount','currency','base','extra','missing'])('refuses altered %s evidence',kind=>{
    const altered=rows();
    if(kind==='owner')altered[3]!.ownerWallet='other';
    if(kind==='amount')altered[3]!.delta='1';
    if(kind==='currency')altered[0]!.currency='GEMS';
    if(kind==='base')altered[3]!.baseId=baseId;
    if(kind==='extra')altered.push({...altered[0]!});
    if(kind==='missing')altered.pop();
    expect(()=>assertWelcomeLedger(wallet,altered)).toThrow('E2_WELCOME_LEDGER_REFUSED');
  });
});
describe('separate authenticated startup checks',()=>{
  it('makes no economy read for the default profile',async()=>{
    const h=harness();await checkEconomyStartup(parseFixtureProfile([]),identity,h);expect(h.calls).toEqual([]);
  });
  it('runs exact ordered GET endpoints and records an honest Awning hold',async()=>{
    const h=harness();await checkEconomyStartup(economy(),identity,h);
    expect(h.calls).toEqual(['/native/capabilities','/gems','/workshop?baseId='+baseId,'/balances?baseId='+baseId,'/base?baseId='+baseId,'/harvesters?baseId='+baseId,'/bound-cosmetics?baseId='+baseId]);
    expect(h.proofs.map(p=>[p.feature,p.status,p.observedAt])).toEqual([
      ['gems','passed',at],['forge','passed',at],['harvesters','passed',at],['awning','held',at]]);
    expect(h.proofs.find(p=>p.feature==='harvesters')?.detail).toContain('synthetic fixture term');
    expect(h.proofs.find(p=>p.feature==='harvesters')?.detail).toContain('completed Gold Forge');
  });
  it('stops at the requested single-family frontier',async()=>{
    const h=harness();await checkEconomyStartup(economy('gems'),identity,h);expect(h.calls).toEqual(['/native/capabilities','/gems']);
  });
  it('refuses Gems advertisements without the actual receipt/consent contract',async()=>{
    const h=harness({'/gems':{features:{gems:{supported:true}},gems:String(amount),sources:['ledger-keep']}});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
    expect(h.proofs.at(-1)?.status).toBe('failed');expect(h.calls).toHaveLength(2);
  });
  it.each([undefined,0,'0','-1','05000',String(amount-1n),String(amount+1n)])('refuses Gems balance differing from the actual backed grant: %s',async gems=>{
    const h=harness({'/gems':{features:{gems:{version:1,receipts:1,exactConsent:1}},gems,sources:['ledger-keep']}});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
    expect(h.calls).toEqual(['/native/capabilities','/gems']);
    expect(h.proofs.at(-1)?.status).toBe('failed');
  });
  it('refuses an unexpected wallet-buy source',async()=>{
    const h=harness({'/gems':{features:{gems:{version:1,receipts:1,exactConsent:1}},gems:String(amount),sources:['ledger-keep','wallet-keep']}});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
  });
  it('refuses mismatched fixture-wallet grant proof before any request',async()=>{
    const h=harness();await expect(checkEconomyStartup(economy(),{...identity,welcome:{...identity.welcome,wallet:'other'}},h)).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');expect(h.calls).toEqual([]);
  });
  it('refuses a missing or foreign Workshop independently',async()=>{
    const h=harness({['/workshop?baseId='+baseId]:{acceptingJobs:true,level:1,inventory:{baseId:'other'}}});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_FORGE_STARTUP_REFUSED');
    expect(h.proofs.map(p=>p.status)).toEqual(['passed','failed']);
  });
  it.each([undefined,0,'0','-1','01','1.5','1e6',String(BigInt(FORGE_INGOT.shardsPerIngot)-1n)])('refuses missing, malformed or insufficient base SHARDS: %s',async shards=>{
    const h=harness({['/balances?baseId='+baseId]:{shards}});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_FORGE_STARTUP_REFUSED');
    expect(h.calls.at(-1)).toBe('/balances?baseId='+baseId);
    expect(h.proofs.map(p=>p.status)).toEqual(['passed','failed']);
  });
  it('admits exact integer SHARDS above the canonical price without Number rounding',async()=>{
    const h=harness({['/balances?baseId='+baseId]:{shards:'9007199254740993'}});
    await checkEconomyStartup(economy('forge'),identity,h);
    expect(h.proofs.at(-1)?.status).toBe('passed');expect(h.calls).toHaveLength(4);
  });
  it.each(['provider','facility','stock','home'])('refuses missing Harvester %s',async kind=>{
    const payload={wallet,baseId,features:{harvesters:{version:1,receipts:1}},acceptingSelections:kind!=='provider',home:kind==='home'?null:{source:'deed_location',realmId:'crownlands'},
      facilities:kind==='facility'?[]:[{baseId,harvesterId}],rawStock:kind==='stock'?[]:[{resourceId:'crown_iron_ore',available:'1000'}]};
    const h=harness({['/harvesters?baseId='+baseId]:payload});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
    expect(h.proofs.at(-1)?.feature).toBe('harvesters');
  });
  it('never treats a failing Awning route as an art hold or retries it',async()=>{
    const h=harness(),get=h.get;h.get=async path=>{if(path.startsWith('/bound-cosmetics')){h.calls.push(path);throw Error('private response detail');}return get(path);};
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_AWNING_STARTUP_REFUSED');
    expect(h.calls).toHaveLength(7);expect(h.proofs.at(-1)?.status).toBe('failed');expect(JSON.stringify(h.proofs)).not.toContain('private response detail');
  });
  it('reports Awning ready only from the normal same-wallet/base view',async()=>{
    const h=harness({['/bound-cosmetics?baseId='+baseId]:{wallet,applicationReady:true,acceptingJobs:true,selectedBase:{baseId,state:'available',markets:[{buildingId:'market'}]}}});
    await checkEconomyStartup(economy(),identity,h);expect(h.proofs.at(-1)?.status).toBe('passed');
  });
  it('refuses a foreign Awning view',async()=>{
    const h=harness({['/bound-cosmetics?baseId='+baseId]:{wallet:'other',applicationReady:false,acceptingJobs:false,selectedBase:{baseId,state:'available',markets:[{buildingId:'market'}]}}});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_AWNING_STARTUP_REFUSED');
  });
});

// Actual fixture reads must agree before READY; no synthetic body is written by these tests.
describe('IW5 in-world fixture startup proof',()=>{
  it.each(PHASE_E_BUILDINGS.types)('refuses missing completed %s',async type=>{
    const view=inWorldBase();view.buildings=view.buildings.filter(b=>b.type!==type);
    const h=harness({['/base?baseId='+baseId]:view});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
    expect(h.calls.at(-1)).toBe('/base?baseId='+baseId);
  });
  it.each(PHASE_E_BUILDINGS.types)('refuses unfinished %s',async type=>{
    const view=inWorldBase();view.buildings.find(b=>b.type===type)!.underConstruction=true;
    const h=harness({['/base?baseId='+baseId]:view});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
  });
  it.each(['wallet','base','keep-projection','keep-building','keep-unfinished','starter','starter-berth','harvester-id'])('refuses mismatched %s',async kind=>{
    const view=inWorldBase();
    if(kind==='wallet')view.player.wallet='other';
    if(kind==='base')view.baseId='other';
    if(kind==='keep-projection')view.player.keepLevel=1;
    if(kind==='keep-building')view.buildings[0]!.level=1;
    if(kind==='keep-unfinished')view.buildings[0]!.underConstruction=true;
    if(kind==='starter')view.starterFleet.installation.installationId='other';
    if(kind==='starter-berth')view.starterFleet.installation.berthId='other';
    if(kind==='harvester-id')view.buildings.find(b=>b.type==='harvester')!.id='other';
    const h=harness({['/base?baseId='+baseId]:view});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
  });
  // Object cases preserve the array as one value; it.each spreads array rows.
  it.each([{types:[]},{types:['berth']},{types:['workshop','lodge','market','harvester','harvester']},
    {types:[...PHASE_E_BUILDINGS.types].reverse()}])('refuses incomplete, duplicated or reordered discovery $types',async({types})=>{
    const view=inWorldBase();view.features.phaseEBuildings.enabledTypes=types;
    await expect(checkEconomyStartup(economy(),identity,harness({['/base?baseId='+baseId]:view}))).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
  });
  it.each(['missing','unfinished','wrong-id','zero-level'])('refuses an unproved Gold Forge: %s',async kind=>{
    const view=inWorldBase(),goldForge=view.buildings.find(b=>b.type==='goldforge')!;
    if(kind==='missing')view.buildings=view.buildings.filter(b=>b.type!=='goldforge');
    if(kind==='unfinished')goldForge.underConstruction=true;
    if(kind==='wrong-id')goldForge.id='other';
    if(kind==='zero-level')goldForge.level=0;
    const h=harness({['/base?baseId='+baseId]:view});
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
    expect(h.calls.at(-1)).toBe('/base?baseId='+baseId);
    expect(h.proofs.at(-1)?.status).toBe('failed');
  });
  it('refuses a missing seeded Gold Forge identity even when another is completed',async()=>{
    const h=harness();
    await expect(checkEconomyStartup(economy(),{...identity,inWorld:{...identity.inWorld,goldForgeId:null}},h)).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
    expect(h.calls.at(-1)).toBe('/base?baseId='+baseId);
  });
  it.each(['capability','base-art','ground-v5'])('refuses native presentation mismatch %s',async kind=>{
    const view=inWorldBase(),overrides:Record<string,unknown>={};
    if(kind==='base-art')view.features.phaseEArt.enabled=false;
    if(kind==='ground-v5')view.visualContext.groundRevision=5;
    if(kind==='capability')overrides['/native/capabilities']={phaseEArt:{version:1,enabled:false},economy:{gems:{enabled:true,sources:['ledger-keep']},workshop:{enabled:true}}};
    overrides['/base?baseId='+baseId]=view;
    await expect(checkEconomyStartup(economy(),identity,harness(overrides))).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
  });
  it('does not require the private native overlay in an ordinary browser fixture',async()=>{
    const view=inWorldBase();view.visualContext.groundRevision=5;
    const {phaseEArt:_removed,...features}=view.features;
    const h=harness({['/base?baseId='+baseId]:{...view,features},
      '/native/capabilities':{economy:{gems:{enabled:true,sources:['ledger-keep']},workshop:{enabled:true}}}});
    await checkEconomyStartup(economy(),{...identity,inWorld:{...identity.inWorld,nativePresentation:false}},h);
    expect(h.proofs.find(p=>p.feature==='harvesters')?.status).toBe('passed');
  });
  it('records a fixed refusal without copying a failing base-read error or retrying',async()=>{
    const h=harness(),read=h.get;h.get=async path=>{if(path==='/base?baseId='+baseId){h.calls.push(path);throw Error('SYNTHETIC_PRIVATE_BODY');}return read(path);};
    await expect(checkEconomyStartup(economy(),identity,h)).rejects.toThrow('E2_HARVESTERS_STARTUP_REFUSED');
    expect(h.calls.filter(path=>path==='/base?baseId='+baseId)).toHaveLength(1);
    expect(JSON.stringify(h.proofs)).not.toContain('SYNTHETIC_PRIVATE_BODY');
  });
});


describe('custody-bound Gems source advertisements',()=>{
  const sources=(view:unknown,capability:unknown)=>harness({
    '/gems':{features:{gems:{version:1,receipts:1,exactConsent:1}},gems:String(amount),sources:view},
    '/native/capabilities':{phaseEArt:{version:1,enabled:true},economy:{gems:{enabled:true,sources:capability},workshop:{enabled:true}}},
  });
  it('requires exactly empty advertisements on both fenced reads and retains all later checks',async()=>{
    const h=sources([],[]);await checkEconomyStartup(economy(),identity,h,'fenced');
    expect(h.calls).toEqual(['/native/capabilities','/gems','/workshop?baseId='+baseId,'/balances?baseId='+baseId,'/base?baseId='+baseId,'/harvesters?baseId='+baseId,'/bound-cosmetics?baseId='+baseId]);
    expect(h.proofs.map(p=>[p.feature,p.status])).toEqual([['gems','passed'],['forge','passed'],['harvesters','passed'],['awning','held']]);
  });
  it('retains exact ledger-keep for an explicitly open fixture',async()=>{
    const h=sources(['ledger-keep'],['ledger-keep']);await checkEconomyStartup(economy('gems'),identity,h,'open');
    expect(h.calls).toEqual(['/native/capabilities','/gems']);expect(h.proofs.map(p=>p.status)).toEqual(['passed']);
  });
  it('does not infer fenced custody from empty arrays when the caller uses the old default',async()=>{
    const h=sources([],[]);await expect(checkEconomyStartup(economy('gems'),identity,h)).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
    expect(h.proofs.map(p=>p.status)).toEqual(['failed']);
  });
  it.each([
    {label:'fenced view still ledger',custody:'fenced',view:['ledger-keep'],capability:[]},
    {label:'fenced capability still ledger',custody:'fenced',view:[],capability:['ledger-keep']},
    {label:'fenced both still ledger',custody:'fenced',view:['ledger-keep'],capability:['ledger-keep']},
    {label:'fenced view invents wallet source',custody:'fenced',view:['wallet-keep'],capability:[]},
    {label:'fenced capability invents wallet source',custody:'fenced',view:[],capability:['wallet-keep']},
    {label:'fenced missing view sources',custody:'fenced',view:undefined,capability:[]},
    {label:'fenced missing capability sources',custody:'fenced',view:[],capability:undefined},
    {label:'fenced null view sources',custody:'fenced',view:null,capability:[]},
    {label:'fenced null capability sources',custody:'fenced',view:[],capability:null},
    {label:'fenced array-like view sources',custody:'fenced',view:{length:0},capability:[]},
    {label:'fenced array-like capability sources',custody:'fenced',view:[],capability:{length:0}},
    {label:'fenced duplicate ledger sources',custody:'fenced',view:['ledger-keep','ledger-keep'],capability:['ledger-keep','ledger-keep']},
    {label:'open empty view sources',custody:'open',view:[],capability:['ledger-keep']},
    {label:'open empty capability sources',custody:'open',view:['ledger-keep'],capability:[]},
    {label:'open both empty sources',custody:'open',view:[],capability:[]},
    {label:'open capability adds wallet source',custody:'open',view:['ledger-keep'],capability:['ledger-keep','wallet-keep']},
  ] as const)('refuses $label without weakening the other endpoint',async({custody,view,capability})=>{
    const h=sources(view,capability);await expect(checkEconomyStartup(economy(),identity,h,custody)).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
    expect(h.calls).toEqual(['/native/capabilities','/gems']);expect(h.proofs.map(p=>[p.feature,p.status])).toEqual([['gems','failed']]);
  });
  it('still refuses a fenced balance that differs from the backed welcome grant',async()=>{
    const h=sources([],[]),get=h.get;h.get=async path=>path==='/gems'?{features:{gems:{version:1,receipts:1,exactConsent:1}},gems:String(amount+1n),sources:[]}:get(path);
    await expect(checkEconomyStartup(economy('gems'),identity,h,'fenced')).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
    expect(h.proofs.map(p=>p.status)).toEqual(['failed']);
  });
  it('still refuses a disabled fenced capability',async()=>{
    const h=sources([],[]),get=h.get;h.get=async path=>path==='/native/capabilities'?{economy:{gems:{enabled:false,sources:[]}}}:get(path);
    await expect(checkEconomyStartup(economy('gems'),identity,h,'fenced')).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
    expect(h.proofs.map(p=>p.status)).toEqual(['failed']);
  });
  it('still refuses missing fenced receipt and consent versions',async()=>{
    const h=sources([],[]),get=h.get;h.get=async path=>path==='/gems'?{features:{gems:{version:1}},gems:String(amount),sources:[]}:get(path);
    await expect(checkEconomyStartup(economy('gems'),identity,h,'fenced')).rejects.toThrow('E2_GEMS_STARTUP_REFUSED');
    expect(h.proofs.map(p=>p.status)).toEqual(['failed']);
  });
  it('does not let a fenced Gems pass suppress the normal Forge funding refusal',async()=>{
    const h=sources([],[]),get=h.get;h.get=async path=>path==='/balances?baseId='+baseId?{shards:String(BigInt(FORGE_INGOT.shardsPerIngot)-1n)}:get(path);
    await expect(checkEconomyStartup(economy('forge'),identity,h,'fenced')).rejects.toThrow('E2_FORGE_STARTUP_REFUSED');
    expect(h.proofs.map(p=>[p.feature,p.status])).toEqual([['gems','passed'],['forge','failed']]);
  });
});
