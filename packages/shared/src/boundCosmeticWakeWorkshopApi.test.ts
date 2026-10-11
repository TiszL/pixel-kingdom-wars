import {expect,it} from 'vitest';
import {BoundCosmeticWakeWorkshopViewSchema as View,BoundCosmeticWakePreferenceSnapshotSchema as Preference} from './boundCosmeticWakeWorkshopApi';
import {boundCosmeticRecipe} from './phaseEBoundCosmetics';
import {ORDINARY_CRAFTING_ITEM_IDS_V2} from './phaseEOrdinaryCrafting';
const wallet='So11111111111111111111111111111111111111112',id='10000000-0000-4000-8000-000000000001',at='2026-09-29T00:00:00.000Z';
const recipe=boundCosmeticRecipe('craft_aurora_wake_v1',1),appearance={version:1,outputId:'aurora_wake',sourceId:'auroraWake',sourceManifestSha256:'a'.repeat(64),sourceIndexSha256:'b'.repeat(64),bindingSha256:'c'.repeat(64)};
const off={enabled:false,revision:'0',visual:{state:'available',visual:{version:1,wake:null}}};
const view=()=>({version:1,wallet,serverNow:at,applicationReady:false,acceptingJobs:false,blueprint:{state:'not-earned',proof:null},recipe:{recipe,appearance},original:null,preference:off,selectedBase:null});
const base=()=>({state:'available',baseId:id,craftingStock:ORDINARY_CRAFTING_ITEM_IDS_V2.map(itemId=>({itemId,available:'0',pendingOutput:'0'})),workshops:[],lodges:[],queue:[]});
it('opts into only Aurora with strict account-scoped preference and independent nullable base',()=>{
 expect(View.parse(view()).selectedBase).toBeNull();expect(View.safeParse({...view(),selectedBase:base()}).success).toBe(true);
 for(const v of [{...view(),version:2},{...view(),acceptingJobs:true},{...view(),recipe:{recipe:boundCosmeticRecipe('craft_artisan_market_awning_t1_v1',1),appearance}},{...view(),recipe:{recipe,appearance:{...appearance,outputId:'artisan_market_awning_t1'}}},{...view(),preference:{...off,baseId:id}},{...view(),originals:[]}])expect(View.safeParse(v).success).toBe(false);
});
it('rejects incomplete stock, leaked unavailable stock, due queue and future or duplicate facilities',()=>{
 const facility={buildingId:id,level:1,completedAt:at},job={kind:'cosmetic',jobId:id,recipe,startedAt:at,readyAt:new Date(Date.parse(at)+recipe.durationSec*1000).toISOString()};
 expect(View.safeParse({...view(),selectedBase:{...base(),lodges:[facility],queue:[job]}}).success).toBe(true);
 for(const b of [{...base(),craftingStock:[]},{state:'unavailable',baseId:id,reason:'BASE_NOT_OWNED',craftingStock:[]},{...base(),workshops:[facility],lodges:[facility]},{...base(),lodges:[{...facility,completedAt:job.readyAt}]},{...base(),markets:[]}])expect(View.safeParse({...view(),selectedBase:b}).success).toBe(false);
 expect(View.safeParse({...view(),serverNow:job.readyAt,selectedBase:{...base(),queue:[job]}}).success).toBe(false);
});
it('binds a selected appearance to the actual completed original, wallet and observation time',()=>{
 const readyAt=new Date(Date.parse(at)+recipe.durationSec*1000).toISOString(),proof={blueprintId:recipe.blueprintId,jobId:id,baseId:id,actorWallet:wallet,completedAt:at};
 const original={version:1,wallet,idempotencyKey:id,serverNow:readyAt,status:'accepted',completion:{completedAt:readyAt},receipt:{wallet,jobId:id,request:{idempotencyKey:id,baseId:id,recipeId:recipe.recipeId,recipeVersion:1,appearanceBindingSha256:appearance.bindingSha256},recipe,appearance,blueprint:proof,startedAt:at,readyAt}};
 const complete={...view(),serverNow:readyAt,original,preference:{enabled:true,revision:'1',visual:{state:'available',visual:{version:1,wake:appearance}}}};
 expect(View.safeParse(complete).success).toBe(true);
 for(const v of [{...complete,original:null},{...complete,original:{...original,completion:null}},{...complete,original:{...original,wallet:'11111111111111111111111111111112'}},{...complete,serverNow:at},{...complete,blueprint:{state:'eligible',proof:{...proof,completedAt:'2026-10-01T00:00:00.000Z'}}}])expect(View.safeParse(v).success).toBe(false);
});
it('preserves canonical revision zero/off, signed bounds and explicit unavailable selection',()=>{
 expect(Preference.safeParse(off).success).toBe(true);expect(Preference.safeParse({enabled:true,revision:'9223372036854775807',visual:{state:'unavailable',visual:null}}).success).toBe(true);
 for(const v of [{...off,enabled:true},{...off,revision:'01'},{...off,revision:0},{...off,revision:'9223372036854775808'},{...off,revision:'1\n'}])expect(Preference.safeParse(v).success).toBe(false);
});
