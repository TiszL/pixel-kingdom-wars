import {describe,expect,expectTypeOf,it} from 'vitest';
import * as c from './craftNativeLogic';
import type {RecipeUi,WorkshopRefineUi,WorkshopIngotsUi,WorkshopStyleUi,HarvesterYieldUi,WorkshopToolsUi,CraftHydration,SubmitUi} from './craftNativeModels';
import type {MarketBuyUi,MarketSellUi,MoneyStage} from './marketLogic';

// Ported native test examples, not game policy. Production mappers use the original server snapshots.
const now=1_000_000_000;
const items=Object.fromEntries([
  ['frost_quartz','Frost Quartz','Frostveil harvester',null],
  ['frostglass','Frostglass','Refine here','refine_frostglass'],
  ['heartwood_beams','Heartwood Beams','Refine here, from logs','refine_beams'],
  ['thornsilk','Thornsilk','Refine here, from fibre','refine_thornsilk'],
  ['expedition_kit','Expedition Kit','Craft here',null],
].map(([itemId,name,source,makeHereRecipeId])=>[itemId!,{itemId:itemId!,name:name!,source:source!,makeHereRecipeId:makeHereRecipeId??null,icon:`craft:inv_${itemId}`} ]));
const frostglass:RecipeUi={recipeId:'refine_frostglass',recipeVersion:'1',group:'REFINE',outputItemId:'frostglass',outputPerUnit:1n,inputs:[{kind:'RAW',itemId:'frost_quartz',perUnit:4n}],secondsPerUnit:90,usedFor:'For kits.',locked:null};
const expedition:RecipeUi={recipeId:'kit_expedition',recipeVersion:'1',group:'KIT',outputItemId:'expedition_kit',outputPerUnit:1n,inputs:[{kind:'CRAFTING',itemId:'heartwood_beams',perUnit:2n},{kind:'CRAFTING',itemId:'thornsilk',perUnit:1n},{kind:'SHARDS',itemId:'shards',perUnit:600n}],secondsPerUnit:240,usedFor:'Packs a longer trip.',locked:null};
const embercore:RecipeUi={...frostglass,recipeId:'refine_embercore',outputItemId:'embercore',inputs:[{kind:'RAW',itemId:'ember_nodules',perUnit:4n}],secondsPerUnit:150,locked:{line:'Unlocks at Workshop 3',requirement:'Workshop 3'}};
const refine:WorkshopRefineUi={recipes:[frostglass,expedition,embercore],stock:{frost_quartz:{available:36n},frostglass:{available:14n},heartwood_beams:{available:0n},thornsilk:{available:2n}},maxBatch:10,acceptingJobs:true,pendingJobs:[],actionsAllowed:true,selectedRecipeId:'refine_frostglass',quantity:6,savedOperation:null,hydration:'READY',submit:{stage:'IDLE'},items,shards:40_943n,benchCapacity:1};
const ingots:WorkshopIngotsUi={inventory:{held:8n,pending:0n},allowance:{daily:{used:12n,cap:20n,remaining:8n},holding:{held:8n,pending:0n,cap:30n,remaining:22n},resetsAtMs:now+22_800_000},shardsPerIngot:2_000n,batch:{size:8n},job:null,shards:40_943n,actionsAllowed:true,saved:null,quantity:4,secondsPerIngot:30,hydration:'READY',submit:{stage:'IDLE'}};
const style:WorkshopStyleUi={awning:{tiers:[1,2,3,4].map(tier=>({tier,recipeId:`a${tier}`,requiredMarketLevel:tier,inputs:[],durationSec:3_600,owned:tier<=2,craftable:tier===3})),appliedTier:1,previewVerified:true},wake:{owned:true,shown:false,recipe:null},marketLevel:2,job:null,saved:null,hydration:'READY',submit:{stage:'IDLE'},actionsAllowed:true,acceptingJobs:true};
const harvest:HarvesterYieldUi={realmId:'crownlands',artKey:'crownlands',resourceId:'crown_iron_ore',level:2,tier:2,policy:{grossPerCadence:12n,cadenceSec:21_600},interval:{state:'RUNNING',startedAtMs:now-1_000,nextHaulAtMs:now+7_800_000},arrived:{unseenQuantity:0n,lastAt:null},todayArrived:36n,stock:{available:48n},nextLevelDelta:'+4 per haul at Lv 3',upgradeCost:{currency:'SHARDS',amount:'24,000',status:'OK'},actionsAllowed:true,saved:null,hydration:'READY',submit:{stage:'IDLE'},complete:true};

describe('CraftLogic native parity — authored, unrun',()=>{
  // Money honesty (DESIGN-SYSTEM §9): a count the server has not given is "…", never 0 and never "enough".
  it('unknown counts render as an ellipsis and are neither OK nor short',()=>{
    expect(c.groupDigits(null)).toBe('…');
    const unknown=c.ingredientLines(frostglass.inputs,6,refine.stock,items,false);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({count:'…/24',ok:false,short:false});
    expect(c.recipeTiles({...refine,hydration:'LOADING'},'REFINE').every(t=>t.tile.count==='…')).toBe(true);
  });
  it('D-070 shared durations override the native mockup clock wording',()=>{
    expect([540,90,3600,null].map(c.craftDuration)).toEqual(['9m','1m 30s','1h','…']);
    expect([228,7800,21600,93600].map(c.timeLeft)).toEqual(['3m 48s','2h 10m','6h','1d 2h']);
    expect([21600,5400].map(c.shortDuration)).toEqual(['6h','1h 30m']);
  });
  // SPEC §2.3: only the server says a job is done; the clock rounds up so it never reads 0 early.
  it('a countdown never claims done before the server does',()=>{
    expect(c.secondsLeft(now+1,now)).toBe(1);expect(c.secondsLeft(now-5000,now)).toBe(0);
    expect(c.countdownText(c.secondsLeft(now-5000,now))).toBe(c.CHECKING_TEXT);
    expect(c.countdownText(null)).toBe('…');expect(c.secondsLeft(now+10000,now,10000)).toBe(0);
  });
  it('job progress follows the server clock and steps per minute under reduced motion',()=>{
    expect(c.jobProgress(0,1000,null,500)).toBeCloseTo(.5);
    expect(c.jobProgress(null,120000,120,90000,0,60000)).toBeCloseTo(.5);
    expect(c.jobProgress(null,1000,null,500)).toBeNull();
  });
  it('steppers clamp to the server limits',()=>{
    expect(c.stepQuantity(10,1,1,10)).toBe(10);expect(c.stepQuantity(1,-1,1,10)).toBe(1);
    expect(c.clampQuantity(5,1,0)).toBe(1);
    expect(c.ingotCastMax(8n,3n,22n)).toBe(3n);expect(c.ingotCastMax(8n,0n,22n)).toBe(0n);expect(c.ingotCastMax(8n,null,22n)).toBeNull();
  });
  // SPEC §2.1: a Shards input is never a row; it is the cost pill, and only a known, lower balance makes it SHORT.
  it('shards inputs become the cost pill and are short only on a known lower balance',()=>{
    expect(c.ingredientLines(expedition.inputs,2,refine.stock,items).map(l=>l.itemId)).toEqual(['heartwood_beams','thornsilk']);
    expect(c.shardsCost(expedition.inputs,2)).toBe(1200n);expect(c.shardsPrice(1200n,1000n)?.status).toBe('SHORT');
    expect(c.shardsPrice(1200n,null)?.status).toBe('OK');expect(c.shardsPrice(c.shardsCost(frostglass.inputs,2),0n)).toBeNull();
  });
  // SPEC §2.2: a missing ingredient turns the primary off with a reason; it never starts, and GO selects the recipe here.
  it('a missing ingredient blocks the start and points to where it is made',()=>{
    const short={...refine,selectedRecipeId:'kit_expedition',quantity:2};
    expect(c.refinePrimary(short,now)).toMatchObject({state:'DISABLED',action:'SHAKE',label:'CRAFT 2',reason:'Need 4 more Heartwood Beams. Tap GO.',price:{amount:'1,200'}});
    expect(c.refineLines(short).find(l=>l.short)?.goRecipeId).toBe('refine_beams');
    expect(c.recipeTiles(short,'KIT')[0]?.tile.state).toBe('SELECTED');
  });
  it('a ready recipe starts with its time and the selected tile gets the rim',()=>{
    expect(c.refinePrimary(refine,now)).toMatchObject({label:'REFINE 6',sub:'takes 9m',action:'START'});
    expect(c.recipeTiles(refine,'REFINE')[0]?.tile).toMatchObject({state:'SELECTED',count:'x14'});
  });
  it('a full bench is busy with its countdown and a free queue slot starts again',()=>{
    const working={...refine,pendingJobs:[{jobId:'j1',recipeId:'refine_frostglass',quantity:6n,readyAtMs:now+228000}]};
    expect(c.refinePrimary(working,now)).toMatchObject({state:'BUSY',label:'Bench busy · 3m 48s'});
    expect(c.refinePrimary({...working,benchCapacity:2},now)?.action).toBe('START');
    expect(c.slotLine(1,1)).toBe('1 of 1 slot');expect(c.slotLine(1,2)).toBe('1 of 2 slots');
  });
  it('pauses, locks, loading and errors each explain themselves',()=>{
    expect(c.refinePrimary({...refine,actionsAllowed:false},now)?.reason).toBe('Orders are paused on this base');
    expect(c.refinePrimary({...refine,acceptingJobs:false},now)?.reason).toBe('New refining is paused');
    expect(c.refinePrimary({...refine,selectedRecipeId:'refine_embercore'},now)).toMatchObject({state:'LOCKED',label:'Workshop 3'});
    expect(c.refinePrimary({...refine,hydration:'LOADING'},now)).toMatchObject({state:'BUSY',label:'Checking stock'});
    expect(c.refinePrimary({...refine,hydration:'ERROR'},now)?.action).toBe('RETRY');expect(c.refinePrimary({...refine,recipes:[]},now)).toBeNull();
  });
  // Design correction 7: an uncertain result is "being checked" and keeps the recovery; only a refusal says nothing was spent.
  it('an uncertain request is being checked and never claims nothing was spent',()=>{
    expect(c.refinePrimary({...refine,submit:{stage:'CHECKING'},savedOperation:{opId:'op'}},now)).toMatchObject({state:'BUSY',label:'Being checked'});
    expect(c.submitNotice({stage:'CHECKING'})).not.toContain('Nothing was spent');expect(c.submitNotice({stage:'REFUSED'})).toContain('Nothing was spent');
    expect(c.submitNotice({stage:'SENDING'})).toBeNull();expect(c.refinePrimary({...refine,savedOperation:{opId:'op'}},now)?.state).toBe('DISABLED');
  });
  // SPEC §2.5: Forge Ingots use a real collect; the moss COLLECTED (after the receipt) cannot be tapped twice.
  it('ingots collect through the receipt sequence and cannot collect twice',()=>{
    const ready={...ingots,job:{jobId:'j',ingots:4n,readyAtMs:now-1,state:'READY' as const}};
    expect(c.ingotsPrimary(ready,now)).toMatchObject({label:'COLLECT 4',action:'COLLECT',badge:c.READY_BADGE});
    expect(c.ingotsPrimary({...ready,collect:'COLLECTED'},now)).toMatchObject({verb:'MOSS',action:'NONE'});
    expect(c.ingotsPrimary({...ingots,collect:'FAILED'},now).action).toBe('COLLECT');
  });
  // A price still being checked is navigation into the review, not a refusal (design correction 7).
  it('ingot casting respects today’s cap, the holding room and the Shards balance',()=>{
    expect(c.ingotsPrimary(ingots,now)).toMatchObject({label:'CAST 4',price:{amount:'8,000'},sub:'takes 2m'});
    expect(c.ingotsPrimary({...ingots,allowance:{...ingots.allowance,daily:{used:20n,cap:20n,remaining:0n}}},now).reason).toBe("Today's 20 are cast. Resets in 6h 20m.");
    expect(c.ingotsPrimary({...ingots,allowance:{...ingots.allowance,holding:{held:30n,pending:0n,cap:30n,remaining:0n}}},now).reason).toBe('Holding room is full. Smelt some at the Gold Forge.');
    expect(c.ingotsPrimary({...ingots,shards:100n},now).action).toBe('NEED_MORE');
    expect(c.ingotsPrimary({...ingots,shardsPerIngot:null},now)).toMatchObject({price:{status:'CHECKING'},action:'START'});
    expect(c.ingotQuantity({...ingots,quantity:9,allowance:{...ingots.allowance,daily:{used:17n,cap:20n,remaining:3n}}})).toBe(3);
  });
  // SPEC §2.7: an owned look is free to show or hide (green confirm / stone), never a gold job.
  it('awning tiers craft, show, hide or lock by ownership and Market level',()=>{
    expect(c.defaultAwningTier(style.awning)).toBe(3);expect(c.stylePrimary(style,now)?.label).toBe('CRAFT AWNING III');
    expect(c.awningTag(style.awning.tiers[0]!,1)).toEqual(['ON','GREEN']);expect(c.awningTag(style.awning.tiers[3]!,1)).toEqual(['MKT 4','STONE']);
    expect(c.stylePrimary({...style,selectedTier:2},now)).toMatchObject({action:'SHOW',verb:'GREEN'});
    expect(c.stylePrimary({...style,selectedTier:1},now)?.action).toBe('HIDE');expect(c.stylePrimary({...style,selectedTier:2,marketLevel:1},now)?.state).toBe('LOCKED');
    expect(c.stylePrimary({...style,awning:{...style.awning,previewVerified:false}},now)?.reason).toBe('Preview unavailable. Crafting is held.');expect(c.stylePrimary({...style,wakeSelected:true},now)).toBeNull();
  });
  // SPEC 0.2: hauls are delivered by the server; COLLECT is a client-only acknowledgement, so it works on a read-only base.
  it('an arrived haul is acknowledged client-side even on a read-only base',()=>{
    const arrived={...harvest,arrived:{unseenQuantity:12n,lastAt:'now'},actionsAllowed:false,interval:{...harvest.interval,nextHaulAtMs:now+21600000}};
    expect(c.harvesterPrimary(arrived)).toMatchObject({label:'COLLECT 12',action:'COLLECT'});
    expect(c.harvesterNote(arrived,now)).toBe('Next haul in 6h.');expect(c.harvesterLive(arrived,now,null)?.text).toBe('12 ore arrived');
  });
  it('harvester upgrade follows its price and hides at max level',()=>{
    expect(c.harvesterPrimary(harvest)).toMatchObject({action:'UPGRADE',verb:'GREEN'});
    expect(c.harvesterPrimary({...harvest,upgradeCost:{currency:'SHARDS',amount:'24,000',status:'SHORT'}})?.action).toBe('NEED_MORE');
    expect(c.harvesterPrimary({...harvest,upgradeCost:{currency:'SHARDS',amount:null,status:'CHECKING'}})?.action).toBe('UPGRADE');
    expect(c.harvesterPrimary({...harvest,upgradeCost:{currency:'SHARDS',amount:null,status:'UNAVAILABLE'}})?.state).toBe('DISABLED');
    expect(c.harvesterPrimary({...harvest,upgradeCost:null,nextLevelDelta:null})).toBeNull();expect(c.harvesterPrimary({...harvest,complete:false})?.state).toBe('LOCKED');
    expect(c.harvesterPrimary({...harvest,interval:{state:'ENDED',startedAtMs:null,nextHaulAtMs:null}})?.label).toBe('START AGAIN');
    expect(c.harvesterLive(harvest,now,null)).toMatchObject({text:'Next haul',accent:'2h 10m'});
  });
  it('default tabs follow the SPEC priority and only offer available tabs',()=>{
    const all=['REFINE','INGOTS','EQUIPMENT','COSMETICS'];
    expect(c.workshopDefaultTab(true,'EQUIPMENT','COSMETICS',all)).toBe('INGOTS');expect(c.workshopDefaultTab(false,'EQUIPMENT','COSMETICS',all)).toBe('EQUIPMENT');
    expect(c.workshopDefaultTab(false,null,'COSMETICS',all)).toBe('COSMETICS');expect(c.workshopDefaultTab(true,null,null,['REFINE'])).toBe('REFINE');
    expect(c.marketDefaultTab(true,['BUY','MY ORDERS'])).toBe('MY ORDERS');expect(c.marketDefaultTab(false,['BUY','MY ORDERS'])).toBe('BUY');
  });
  // SPEC 0.1: four tabs fit only with ≤ 6-glyph labels; the registry ids stay unchanged.
  it('stacked tab labels fit and keep the registry ids',()=>{
    expect(c.workshopTabs(true).map(t=>t.id)).toEqual(['REFINE','INGOTS','EQUIPMENT','COSMETICS']);
    expect([...c.workshopTabs(),...c.marketTabs()].every(t=>t.label.length<=6)).toBe(true);
    expect(c.workshopTabs(true).find(t=>t.id==='INGOTS')?.badge).toBeTruthy();expect(c.marketTabs().map(t=>t.id)).toEqual(['BUY','SELL','MY ORDERS','COLLECTION']);
  });
  // SPEC §4.1 mismatch: art comes from the server's art key, never from guessing; unknown items never borrow art.
  it('art names come from exact keys and unknown items get the question glyph',()=>{
    expect(c.catalogueKey('CrownIronOre')).toBe('crown_iron_ore');expect(c.catalogueKey('crown-iron-ore')).toBe('crown_iron_ore');
    expect(c.craftItemIcon('PrismstoneLens')).toBe('craft:inv_prismstone_lens');expect(c.craftItemIcon('navigation_kit')).toBe('ui:navigation-kit');expect(c.craftItemIcon('mystery_ore')).toBe('shape:unknown');
    expect(c.harvesterSprite('solana-reach',2,'IDLE')).toBeNull();expect(c.harvesterSprite('seeker-reach',9,'READY')).toBe('craft:harv_seeker_reach_t4_ready');expect(c.workshopSprite(null,'WORKING')).toBe('craft:workshop_t1_working');
  });
  it('atlas frames land on the authored grid',()=>{
    expect(c.atlasFrameOrigin(c.CraftAtlases.workshopWorking(2),4)).toEqual([116,116]);expect(c.atlasFrameOrigin(c.CraftAtlases.workshopWorking(2),9)).toEqual([2,2]);
    expect(c.atlasFrameOrigin(c.CraftAtlases.ingotReady,8)).toEqual([512,0]);expect(c.loopFrame(500,6,8)).toBe(3);
  });
  it('invalid numeric quantities stay unknown and fractional quantities truncate before integer conversion',()=>{
    expect(c.ingredientLines(frostglass.inputs,2.9,refine.stock,items)[0]?.need).toBe(8n);
    expect(c.shardsCost(expedition.inputs,2.9)).toBe(1200n);
    expect(c.ingotsPrimary({...ingots,quantity:2.9},now).price?.amount).toBe('4,000');
    for(const quantity of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
      expect(c.ingredientLines(frostglass.inputs,quantity,refine.stock,items)[0]).toMatchObject({need:null,count:'36/…',ok:false,short:false});
      expect(c.shardsCost(expedition.inputs,quantity)).toBeNull();
      expect(c.ingotsPrimary({...ingots,quantity},now)).toMatchObject({state:'DISABLED',action:'SHAKE',price:{status:'CHECKING'}});
    }
    for(const duration of [null,-1,NaN,Infinity])expect(c.craftDuration(duration)).toBe('…');
    expect(c.shortDuration(93_661)).toBe('1d 2h');
  });

  it('server and controller gate fields cannot be omitted by a typed adapter',()=>{
    type Common={hydration:CraftHydration;submit:SubmitUi};
    expectTypeOf<Pick<WorkshopRefineUi,keyof Common>>().toEqualTypeOf<Common>();
    expectTypeOf<Pick<WorkshopIngotsUi,keyof Common>>().toEqualTypeOf<Common>();
    expectTypeOf<Pick<WorkshopToolsUi,keyof Common|'actionsAllowed'|'acceptingJobs'>>().toEqualTypeOf<{hydration:CraftHydration;submit:SubmitUi;actionsAllowed:boolean;acceptingJobs:boolean}>();
    expectTypeOf<Pick<WorkshopStyleUi,keyof Common|'actionsAllowed'|'acceptingJobs'>>().toEqualTypeOf<{hydration:CraftHydration;submit:SubmitUi;actionsAllowed:boolean;acceptingJobs:boolean}>();
    expectTypeOf<Pick<HarvesterYieldUi,keyof Common|'complete'>>().toEqualTypeOf<{hydration:CraftHydration;submit:SubmitUi;complete:boolean}>();
    expectTypeOf<Pick<MarketBuyUi,'hydration'|'money'>>().toEqualTypeOf<{hydration:CraftHydration;money:MoneyStage}>();
    expectTypeOf<Pick<MarketSellUi,keyof Common>>().toEqualTypeOf<Common>();
  });

});

// review ca8c656f: invalid input must never enter an enabled native-looking primary.
it('refine quantity truncates a finite UI amount and rejects unknown quantities',()=>{
  expect(c.refineQuantity({...refine,quantity:2.9})).toBe(2);
  expect(c.refinePrimary({...refine,quantity:2.9},now)).toMatchObject({label:'REFINE 2',action:'START'});
  expect(c.refinePrimary({...refine,quantity:NaN},now)).toMatchObject({label:'REFINE …',state:'DISABLED',reason:'The quantity is unavailable right now.'});
  expect(c.ingotsPrimary({...ingots,quantity:NaN,saved:{opId:'saved'}},now).label).not.toContain('NaN');
});

// review R3-3: invalid quantity must not hide the original in-flight/recovery state.
it('refine checks hydration saved request and bench state before an unknown quantity',()=>{
 const invalid={...refine,quantity:NaN};
 expect(c.refinePrimary({...invalid,savedOperation:{opId:'saved'}},now)).toMatchObject({label:'REFINE …',reason:'Check the request from earlier first.'});
 expect(c.refinePrimary({...invalid,hydration:'LOADING'},now)).toMatchObject({label:'Checking stock',state:'BUSY'});
 expect(c.refinePrimary({...invalid,hydration:'ERROR'},now)).toMatchObject({label:'Try again',action:'RETRY'});
 expect(c.refinePrimary({...invalid,submit:{stage:'SENDING'}},now)).toMatchObject({label:'Starting',state:'BUSY'});
 expect(c.refinePrimary({...invalid,submit:{stage:'CHECKING'}},now)).toMatchObject({label:'Being checked',state:'BUSY'});
 expect(c.refinePrimary({...invalid,pendingJobs:[{jobId:'pending',recipeId:'refine_frostglass',quantity:1n,readyAtMs:now+1000}]},now)).toMatchObject({label:'Bench busy · 1s',state:'BUSY'});
});
