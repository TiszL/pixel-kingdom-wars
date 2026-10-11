/** Complete presentation port of CraftLogic.kt. Does not authorize or dispatch an operation.
 * Native gate order is retained here for parity; production adapters keep the stronger,
 * accepted recovery-first craftGate and the original controller/session authority.
 */
import {fmtDur} from '../../../lib/duration';
import type {AwningTierUi,AwningUi,BadgeUi,BenchJobUi,CommandState,CraftAtlas,CraftHeaderUi,CraftHydration,CraftItemUi,CraftLiveUi,CraftPrimaryUi,CraftWellUi,HarvesterYieldUi,PriceUi,PrimaryAction,RecipeInputUi,RecipeUi,SavedOpUi,StockUi,SubmitUi,TabUi,Verb,WorkshopIngotsUi,WorkshopRefineUi,WorkshopSheetUi,WorkshopStyleUi,WorkshopToolsUi} from './craftNativeModels';
export {workshopDefaultTab} from './craftLogic';
export const CHECKING_TEXT='Checking…';
export const groupDigits=(value:bigint|null):string=>value===null?'…':value.toLocaleString('en-US');
/** Owner D-070 overrides native mockup duration wording, including countdowns. */
export const craftDuration=(seconds:number|null):string=>seconds===null||!Number.isFinite(seconds)||seconds<0?'…':fmtDur(seconds);
export const timeLeft=craftDuration;
export const shortDuration=craftDuration;
/** Representation guard, never a policy default. Fractional UI inputs truncate. */
export function safeWholeBigInt(value:number|null):bigint|null {
  if(value===null)return null;
  const whole=Math.trunc(value);
  return Number.isSafeInteger(whole)?BigInt(whole):null;
}
export const secondsLeft=(readyAtMs:number|null,nowMs:number,serverOffsetMs=0):number|null=>readyAtMs===null?null:Math.max(0,Math.ceil((readyAtMs-nowMs-serverOffsetMs)/1000));
export const countdownText=(seconds:number|null):string=>seconds===null?'…':seconds<=0?CHECKING_TEXT:timeLeft(seconds);
export function jobProgress(startedAtMs:number|null,readyAtMs:number|null,totalSec:number|null,nowMs:number,serverOffsetMs=0,stepMs=1):number|null {
  if(readyAtMs===null)return null;
  const start=startedAtMs??(totalSec===null?null:readyAtMs-totalSec*1000);
  if(start===null)return null;
  const raw=nowMs+serverOffsetMs;
  const now=stepMs>1?Math.floor(raw/stepMs)*stepMs:raw;
  return readyAtMs<=start?1:Math.min(1,Math.max(0,(now-start)/(readyAtMs-start)));
}
export const slotLine=(used:number,capacity:number)=>`${used} of ${capacity} slot${capacity===1?'':'s'}`;
export const romanTier=(tier:number)=>({1:'I',2:'II',3:'III',4:'IV',5:'V'} as Record<number,string>)[tier]??String(tier);
export const clampQuantity=(current:number,min:number,max:number)=>Math.min(Math.max(min,max),Math.max(min,current));
export const stepQuantity=(current:number,delta:number,min:number,max:number)=>clampQuantity(current+delta,min,max);
export const stepLongQuantity=(current:bigint,delta:bigint,min:bigint,max:bigint)=>clampBigInt(current+delta,min,max<min?min:max);
export const clampBigInt=(n:bigint,min:bigint,max:bigint)=>n<min?min:n>max?max:n;
export function ingotCastMax(batch:bigint|null,daily:bigint|null,holding:bigint|null):bigint|null {
  if(batch===null||daily===null||holding===null)return null;
  const min=batch<daily?batch:daily;
  return clampBigInt(min<holding?min:holding,0n,min<0n?0n:min);
}
export interface IngredientLine {itemId:string;icon:string;name:string;source:string;have:bigint|null;need:bigint|null;missing:bigint|null;goRecipeId:string|null;count:string;ok:boolean;short:boolean}
export function ingredientLines(inputs:readonly RecipeInputUi[],quantity:number,stock:Readonly<Record<string,StockUi>>,items:Readonly<Record<string,CraftItemUi>>,countsKnown=true):IngredientLine[] {
  const whole=safeWholeBigInt(quantity),qty=whole===null?null:whole<1n?1n:whole;
  return inputs.filter(input=>input.kind!=='SHARDS').map(input=>{
    const item=items[input.itemId];
    const need=qty===null?null:input.perUnit*qty;
    const have=countsKnown?stock[input.itemId]?.available??null:null;
    const missing=have===null||need===null?null:need>have?need-have:0n;
    return {itemId:input.itemId,icon:item?.icon??craftItemIcon(input.itemId),name:item?.name??input.itemId,source:item?.source??'',have,need,missing,goRecipeId:item?.makeHereRecipeId??null,count:`${groupDigits(have)}/${groupDigits(need)}`,ok:missing===0n,short:missing!==null&&missing>0n};
  });
}
export function shardsCost(inputs:readonly RecipeInputUi[],quantity:number):bigint|null {
  const shards=inputs.filter(input=>input.kind==='SHARDS'),whole=safeWholeBigInt(quantity);
  return shards.length&&whole!==null?shards.reduce((sum,input)=>sum+input.perUnit*(whole<1n?1n:whole),0n):null;
}
export const shardsPrice=(cost:bigint|null,balance:bigint|null):PriceUi|null=>cost===null?null:{currency:'SHARDS',amount:groupDigits(cost),status:balance!==null&&balance<cost?'SHORT':'OK'};
export function shortReason(lines:readonly IngredientLine[]):string|null {
  const line=lines.find(item=>item.short);
  return line?`Need ${groupDigits(line.missing)} more ${line.name}. Tap GO.`:null;
}
export const READY_BADGE:BadgeUi={text:'!',tone:'READY',description:'Ready to collect'};
export function primary(label:string,sub:string|null,state:CommandState,verb:Verb,reason:string|null,price:PriceUi|null,action:PrimaryAction,badge:BadgeUi|null=null):CraftPrimaryUi {
  return {label,sub,state,verb,reason,price,action,badge};
}
export const busyPrimary=(label:string)=>primary(label,null,'BUSY','STONE',null,null,'NONE');
export const offPrimary=(label:string,sub:string|null,reason:string,price:PriceUi|null=null)=>primary(label,sub,'DISABLED','GOLD',reason,price,'SHAKE');
export const lockedPrimary=(label:string,reason:string|null)=>primary(label,null,'LOCKED','CHARCOAL',reason,null,'SHAKE');
export function pricedPrimary(label:string,sub:string|null,price:PriceUi|null,verb:Verb,action:PrimaryAction):CraftPrimaryUi {
  if(price?.status==='SHORT')return primary(label,sub,'SHORT',verb,null,price,'NEED_MORE');
  if(price?.status==='UNAVAILABLE')return primary(label,sub,'DISABLED',verb,'The price is unavailable right now.',price,'SHAKE');
  return primary(label,sub,'ENABLED',verb,null,price,action);
}
export function commonGate(hydration:CraftHydration,submit:SubmitUi,saved:SavedOpUi|null,label:string,sub:string|null,loadingLabel=CHECKING_TEXT):CraftPrimaryUi|null {
  if(hydration==='LOADING')return busyPrimary(loadingLabel);
  if(hydration==='ERROR')return primary('Try again',null,'ENABLED','STONE',null,null,'RETRY');
  if(submit.stage==='SENDING')return busyPrimary(submit.busyLabel??'Starting');
  if(submit.stage==='CHECKING')return busyPrimary('Being checked');
  return saved?offPrimary(label,sub,'Check the request from earlier first.'):null;
}
export function submitNotice(submit:SubmitUi):string|null {
  return submit.stage==='CHECKING'?'The answer got lost. It is being checked; wait before starting another.':submit.stage==='REFUSED'?submit.message??'The server refused it. Nothing was spent.':null;
}
export const pausedReason=(actionsAllowed:boolean,acceptingJobs:boolean,work='refining')=>!actionsAllowed?'Orders are paused on this base':!acceptingJobs?`New ${work} is paused`:null;
export function benchBusy(jobs:readonly BenchJobUi[],capacity:number,acceptingJobs:boolean,nowMs:number,serverOffsetMs=0):CraftPrimaryUi|null {
  const job=jobs.reduce<BenchJobUi|null>((first,next)=>!first||next.readyAtMs<first.readyAtMs?next:first,null);
  if(!job||(acceptingJobs&&capacity>jobs.length))return null;
  return busyPrimary(`Bench busy · ${countdownText(secondsLeft(job.readyAtMs,nowMs,serverOffsetMs))}`);
}
export const selectedRecipe=(ui:WorkshopRefineUi)=>ui.recipes.find(recipe=>recipe.recipeId===ui.selectedRecipeId)??ui.recipes[0]??null;
export const refineLabel=(recipe:RecipeUi,quantity:number)=>`${recipe.group==='KIT'?'CRAFT':'REFINE'} ${quantity}`;
export const refineQuantity=(ui:WorkshopRefineUi)=>{const quantity=safeWholeBigInt(ui.quantity);return quantity===null?NaN:clampQuantity(Number(quantity),1,ui.maxBatch);};
export function refineLines(ui:WorkshopRefineUi):IngredientLine[] {
  const recipe=selectedRecipe(ui);
  return recipe?ingredientLines(recipe.inputs,refineQuantity(ui),ui.stock,ui.items??{},ui.hydration!=='LOADING'):[];
}
export function refinePrimary(ui:WorkshopRefineUi,nowMs:number):CraftPrimaryUi|null {
  const recipe=selectedRecipe(ui);if(!recipe)return null;
  const qty=refineQuantity(ui),quantityKnown=safeWholeBigInt(qty)!==null;
  const label=quantityKnown?refineLabel(recipe,qty):`${recipe.group==='KIT'?'CRAFT':'REFINE'} …`,sub=quantityKnown?`takes ${craftDuration(recipe.secondsPerUnit===null?null:recipe.secondsPerUnit*qty)}`:null;
  const gate=commonGate(ui.hydration,ui.submit,ui.savedOperation,label,sub,'Checking stock')??benchBusy(ui.pendingJobs,ui.benchCapacity,ui.acceptingJobs,nowMs,ui.serverOffsetMs);
  if(gate)return gate;
  if(!quantityKnown)return offPrimary(label,null,'The quantity is unavailable right now.');
  const paused=pausedReason(ui.actionsAllowed,ui.acceptingJobs);if(paused)return offPrimary(label,sub,paused);
  if(recipe.locked)return lockedPrimary(recipe.locked.requirement,recipe.locked.line);
  const price=shardsPrice(shardsCost(recipe.inputs,qty),ui.shards??null),short=shortReason(refineLines(ui));
  return short?offPrimary(label,sub,short,price):pricedPrimary(label,sub,price,'GOLD','START');
}
/** KitLogic tile-count formatting, using integers through every truncation. */
export function tileCount(value:bigint|null):string {
  if(value===null)return '…';if(value<0n)return `-${tileCount(-value)}`;
  const scaled=(unit:bigint,suffix:string)=>{const t=value/(unit/10n);return `${t/10n}${t%10n?'.'+String(t%10n):''}${suffix}`;};
  return value<1000n?String(value):value<10000n?scaled(1000n,'K'):value<1000000n?`${value/1000n}K`:value<10000000n?scaled(1000000n,'M'):value<1000000000n?`${value/1000000n}M`:`${value/1000000000n}B`;
}
export function recipeTiles(ui:WorkshopRefineUi,group:RecipeUi['group']) {
  const selected=selectedRecipe(ui),missing=new Set(refineLines(ui).filter(line=>line.short).map(line=>line.itemId));
  return ui.recipes.filter(recipe=>recipe.group===group).map(recipe=>{
    const item=ui.items?.[recipe.outputItemId],held=ui.hydration==='LOADING'?null:ui.stock[recipe.outputItemId]?.available??null;
    const isMissing=missing.has(recipe.outputItemId),state=recipe.recipeId===selected?.recipeId?'SELECTED':isMissing?'MISSING':'OWNED';
    const count=held===null?'…':`${isMissing?'':'x'}${tileCount(held)}`,name=item?.name??recipe.outputItemId;
    const description=[`${name}, ${held===null?'count unknown':`${held} held`}`,state==='SELECTED'?'selected':null,recipe.locked?.line].filter(Boolean).join(', ');
    return {tile:{id:recipe.recipeId,icon:item?.icon??craftItemIcon(recipe.outputItemId),count,description,state},locked:recipe.locked!==null};
  });
}
export function refineWells(ui:WorkshopRefineUi):[CraftWellUi|null,CraftWellUi|null] {
  const recipe=selectedRecipe(ui);if(!recipe)return [null,null];
  const working=ui.pendingJobs.length>0,first=refineLines(ui)[0],icon=first?.icon??(recipe.inputs.some(input=>input.kind==='SHARDS')?'shards':null);
  const input=icon?{icon,alpha:working ? .35 : first?.short ? .45 : 1,description:`Input: ${first?.name??'Shards'}`}:null;
  const item=ui.items?.[recipe.outputItemId];
  return [input,{icon:item?.icon??craftItemIcon(recipe.outputItemId),alpha:working ? .5 : 1,description:`Output: ${item?.name??recipe.outputItemId}`}];
}
export const ingotQuantityMax=(ui:WorkshopIngotsUi)=>ingotCastMax(ui.batch.size,ui.allowance.daily.remaining,ui.allowance.holding.remaining);
export function ingotQuantity(ui:WorkshopIngotsUi):number {
  // Int.MAX_VALUE is a native numeric representation boundary, not game policy.
  const max=ingotQuantityMax(ui)??1n;
  const quantity=safeWholeBigInt(ui.quantity);
  return quantity===null?NaN:clampQuantity(Number(quantity),1,Number(max>2147483647n?2147483647n:max));
}
export function ingotsPrimary(ui:WorkshopIngotsUi,nowMs:number):CraftPrimaryUi {
  if(ui.collect==='COLLECTING')return busyPrimary('Collecting');
  if(ui.collect==='COLLECTED')return primary('COLLECTED',null,'ENABLED','MOSS',null,null,'NONE');
  if(ui.collect==='FAILED')return primary('RETRY','Forge Ingots','ENABLED','RED',null,null,'COLLECT');
  const job=ui.job;if(job?.state==='COLLECTING')return busyPrimary('Collecting');
  const qty=ingotQuantity(ui),label=`CAST ${safeWholeBigInt(qty)===null?'…':qty}`,sub=`takes ${craftDuration(ui.secondsPerIngot===null?null:ui.secondsPerIngot*qty)}`;
  const gate=commonGate(ui.hydration,ui.submit,ui.saved,label,sub);if(gate)return gate;
  if(job?.state==='READY')return primary(`COLLECT ${groupDigits(job.ingots)}`,'Forge Ingots','ENABLED','GOLD',null,null,'COLLECT',READY_BADGE);
  if(job?.state==='RUNNING')return busyPrimary(`Casting · ${countdownText(secondsLeft(job.readyAtMs,nowMs,ui.serverOffsetMs))}`);
  const whole=safeWholeBigInt(qty);
  const price:PriceUi=ui.shardsPerIngot===null||whole===null?{currency:'SHARDS',amount:null,status:'CHECKING'}:shardsPrice(ui.shardsPerIngot*whole,ui.shards)!;
  if(whole===null)return offPrimary('CAST …',null,'The quantity is unavailable right now.',price);
  if(!ui.actionsAllowed)return offPrimary(label,sub,'Orders are paused on this base',price);
  if(ui.allowance.daily.remaining===0n)return offPrimary(label,sub,`Today's ${groupDigits(ui.allowance.daily.cap)} are cast. Resets in ${timeLeft(secondsLeft(ui.allowance.resetsAtMs,nowMs,ui.serverOffsetMs))}.`,price);
  if(ui.allowance.holding.remaining===0n)return offPrimary(label,sub,'Holding room is full. Smelt some at the Gold Forge.',price);
  return pricedPrimary(label,sub,price,'GOLD','START');
}
export const selectedTool=(ui:WorkshopToolsUi)=>ui.recipes.find(recipe=>recipe.recipeId===ui.selectedRecipeId)??ui.recipes[0]??null;
export function toolLines(ui:WorkshopToolsUi):IngredientLine[] {
  const tool=selectedTool(ui);return tool?ingredientLines(tool.inputs,1,ui.stock??{},ui.items??{},ui.hydration!=='LOADING'):[];
}
export function toolsPrimary(ui:WorkshopToolsUi,nowMs:number):CraftPrimaryUi|null {
  const tool=selectedTool(ui);if(!tool)return null;
  const label=`CRAFT ${tool.shortName}`,sub=`takes ${craftDuration(tool.durationSec)}`;
  const gate=commonGate(ui.hydration,ui.submit,ui.saved,label,sub)??benchBusy(ui.job?[ui.job]:[],1,ui.acceptingJobs,nowMs,ui.serverOffsetMs);if(gate)return gate;
  const paused=pausedReason(ui.actionsAllowed,ui.acceptingJobs,'crafting');if(paused)return offPrimary(label,sub,paused);
  if(tool.locked)return lockedPrimary(tool.locked.requirement,tool.locked.line);
  const price=shardsPrice(shardsCost(tool.inputs,1),ui.shards??null),short=shortReason(toolLines(ui));
  return short?offPrimary(label,sub,short,price):pricedPrimary(label,sub,price,'GOLD','START');
}
export function travelSummary(ui:WorkshopToolsUi,nowMs:number):[string,string]|null {
  const first=ui.travelling[0];if(!first)return null;
  const name=ui.recipes.find(recipe=>recipe.itemId===first.itemId)?.shortName.toLowerCase()??'tool';
  const line=ui.travelling.length===1?`1 ${name} is out on a trip`:`${ui.travelling.length} tools are out on a trip`;
  const soonest=ui.travelling.reduce((time,tool)=>Math.min(time,tool.returnsAtMs),first.returnsAtMs);
  return [line,`Back at the Lodge in ${timeLeft(secondsLeft(soonest,nowMs,ui.serverOffsetMs))}`];
}
export const awningTierState=(tier:AwningTierUi,appliedTier:number|null)=>tier.owned&&appliedTier===tier.tier?'APPLIED':tier.owned?'OWNED':tier.craftable?'CRAFTABLE':'LOCKED';
export function awningTag(tier:AwningTierUi,appliedTier:number|null):[string,Verb] {
  switch(awningTierState(tier,appliedTier)){case 'APPLIED':return ['ON','GREEN'];case 'OWNED':return ['OWNED','STONE'];case 'CRAFTABLE':return ['CRAFT','GOLD'];case 'LOCKED':return [`MKT ${tier.requiredMarketLevel}`,'STONE'];}
}
export const defaultAwningTier=(awning:AwningUi)=>awning.tiers.find(t=>t.craftable&&!t.owned)?.tier??awning.appliedTier??awning.tiers[0]?.tier??null;
export const selectedAwning=(ui:WorkshopStyleUi)=>ui.awning.tiers.find(t=>t.tier===(ui.selectedTier??defaultAwningTier(ui.awning)))??ui.awning.tiers[0]??null;
export function styleLines(ui:WorkshopStyleUi):IngredientLine[] {
  const inputs=ui.wakeSelected?ui.wake.recipe?.inputs??[]:selectedAwning(ui)?.inputs??[];
  return ingredientLines(inputs,1,ui.stock??{},ui.items??{},ui.hydration!=='LOADING');
}
export function stylePrimary(ui:WorkshopStyleUi,nowMs:number):CraftPrimaryUi|null {
  if(ui.wakeSelected){const recipe=ui.wake.recipe;if(ui.wake.owned||!recipe)return null;return craftablePrimary(ui,'CRAFT WAKE',`takes ${craftDuration(recipe.durationSec)} · once`,recipe.inputs,nowMs);}
  const tier=selectedAwning(ui);if(!tier)return null;
  const label=`CRAFT AWNING ${romanTier(tier.tier)}`,sub=`takes ${craftDuration(tier.durationSec)} · once`;
  const gate=commonGate(ui.hydration,ui.submit,ui.saved,label,sub);if(gate)return gate;
  if(!ui.awning.previewVerified)return offPrimary(label,sub,'Preview unavailable. Crafting is held.');
  const needs=`Market ${tier.requiredMarketLevel}`,low=ui.marketLevel===null||ui.marketLevel<tier.requiredMarketLevel;
  switch(awningTierState(tier,ui.awning.appliedTier)){
    case 'APPLIED':return primary('HIDE','free','ENABLED','STONE',null,null,'HIDE');
    case 'OWNED':return low?lockedPrimary(needs,tier.lockReason?.line??`Shows on a level ${tier.requiredMarketLevel} Market.`):primary('SHOW ON MARKET','free','ENABLED','GREEN',null,null,'SHOW');
    case 'LOCKED':return lockedPrimary(needs,tier.lockReason?.line??null);
    case 'CRAFTABLE':return craftablePrimary(ui,label,sub,tier.inputs,nowMs);
  }
}
function craftablePrimary(ui:WorkshopStyleUi,label:string,sub:string,inputs:readonly RecipeInputUi[],nowMs:number):CraftPrimaryUi {
  const gate=commonGate(ui.hydration,ui.submit,ui.saved,label,sub)??benchBusy(ui.job?[ui.job]:[],1,ui.acceptingJobs,nowMs,ui.serverOffsetMs);if(gate)return gate;
  const paused=pausedReason(ui.actionsAllowed,ui.acceptingJobs,'crafting');if(paused)return offPrimary(label,sub,paused);
  const price=shardsPrice(shardsCost(inputs,1),ui.shards??null),short=shortReason(styleLines(ui));
  return short?offPrimary(label,sub,short,price):pricedPrimary(label,sub,price,'GOLD','START');
}
export function harvesterPrimary(ui:HarvesterYieldUi):CraftPrimaryUi|null {
  if(ui.complete===false)return lockedPrimary('Finish building first',null);
  if(ui.arrived.unseenQuantity>0n)return primary(`COLLECT ${groupDigits(ui.arrived.unseenQuantity)}`,'already safe in your stores','ENABLED','GOLD',null,null,'COLLECT',READY_BADGE);
  if(ui.interval.state!=='RUNNING'){
    const label=ui.interval.state==='ENDED'?'START AGAIN':'START';
    return commonGate(ui.hydration,ui.submit,ui.saved,label,null)??(!ui.actionsAllowed?offPrimary(label,null,'Orders are paused on this base'):primary(label,null,'ENABLED','GOLD',null,null,'START'));
  }
  if(ui.upgradeCost===null)return null;
  return commonGate(ui.hydration,ui.submit,ui.saved,'UPGRADE',ui.nextLevelDelta)??(!ui.actionsAllowed?offPrimary('UPGRADE',ui.nextLevelDelta,'Orders are paused on this base',ui.upgradeCost):pricedPrimary('UPGRADE',ui.nextLevelDelta,ui.upgradeCost,'GREEN','UPGRADE'));
}
export const harvesterNote=(ui:HarvesterYieldUi,nowMs:number)=>ui.arrived.unseenQuantity>0n?`Next haul in ${timeLeft(secondsLeft(ui.interval.nextHaulAtMs,nowMs,ui.serverOffsetMs))}.`:ui.interval.state==='RUNNING'?'Hauls arrive on their own. Nothing to tap.':'This starts a new interval. Earned units stay owed to their kingdom.';
export const workshopHeader=(tier:number|null,state:BenchSprite):CraftHeaderUi=>({sprite:workshopSprite(tier,state),loop:state==='WORKING'?CraftAtlases.workshopWorking(tier):null,loopFps:8});
export const marketHeader=(tier:number|null,appliedAwningTier:number|null):CraftHeaderUi=>appliedAwningTier!==null?{sprite:awningSprite(appliedAwningTier),loop:null,loopFps:8}:{sprite:marketSprite(tier),loop:CraftAtlases.marketWorking(tier),loopFps:6};
const live=(icon:string,text:string,accent:string|null=null,ready=false):CraftLiveUi=>({icon,text,accent,ready,description:[text,accent].filter(Boolean).join(' ')});
export function workshopLive(ui:WorkshopSheetUi,nowMs:number):CraftLiveUi {
  const ingots=ui.ingots,job=ingots?.job;
  if(job?.state==='READY')return live('ui:ready-status',`${groupDigits(job.ingots)} ingots ready`,null,true);
  const refine=ui.refine,refineJob=refine?.pendingJobs.reduce<BenchJobUi|null>((first,next)=>!first||next.readyAtMs<first.readyAtMs?next:first,null);
  if(refine&&refineJob)return live('timer','Refining ·',countdownText(secondsLeft(refineJob.readyAtMs,nowMs,refine.serverOffsetMs)));
  if(ingots&&job?.state==='RUNNING')return live('timer','Casting ·',countdownText(secondsLeft(job.readyAtMs,nowMs,ingots.serverOffsetMs)));
  const craftJob=ui.tools?.job??ui.style?.job;
  if(craftJob)return live('timer','Crafting ·',countdownText(secondsLeft(craftJob.readyAtMs,nowMs,ui.tools?.job?ui.tools.serverOffsetMs:ui.style?.serverOffsetMs)));
  return ui.frame.live??live('ui:ready-status','Free to work');
}
export const harvesterLive=(ui:HarvesterYieldUi,nowMs:number,fallback:CraftLiveUi|null)=>ui.arrived.unseenQuantity>0n?live('ui:ready-status',`${groupDigits(ui.arrived.unseenQuantity)} ${ui.arrivedNoun??'ore'} arrived`,null,true):ui.interval.state==='RUNNING'?live('timer','Next haul',timeLeft(secondsLeft(ui.interval.nextHaulAtMs,nowMs,ui.serverOffsetMs))):fallback;
export const WorkshopTab={REFINE:'REFINE',INGOTS:'INGOTS',EQUIPMENT:'EQUIPMENT',COSMETICS:'COSMETICS'} as const;
export const MarketTab={BUY:'BUY',SELL:'SELL',ORDERS:'MY ORDERS',OWNED:'COLLECTION'} as const;
export const HarvesterTab={YIELD:'YIELD',HISTORY:'HISTORY'} as const;
const tab=(id:string,icon:string,label:string,badge:BadgeUi|null=null):TabUi=>({id,icon,label,badge,disabled:false});
/** Boolean first is the web call signature; available/unseen preserve the native filters. */
export function workshopTabs(ingotsReady=false,available:readonly string[]=Object.values(WorkshopTab),unseenTab:string|null=null):TabUi[] {
  return [tab('REFINE','ui:workshop-menu','REFINE'),tab('INGOTS','craft:inv_forge_ingot','INGOTS'),tab('EQUIPMENT','craft:item_route_compass','TOOLS'),tab('COSMETICS','craft:item_awning','STYLE')].filter(t=>available.includes(t.id)).map(t=>({...t,badge:(t.id==='INGOTS'&&ingotsReady)||t.id===unseenTab?READY_BADGE:null}));
}
export const marketTabs=(sold=false):TabUi[]=>[tab('BUY','ui:market-menu','BUY'),tab('SELL','craft:ingot_crate','SELL'),tab('MY ORDERS','ui:queue-status','ORDERS',sold?{text:'!',tone:'READY',description:'A lot sold'}:null),tab('COLLECTION','itm_deed_earth','OWNED')];
export const harvesterTabs=():TabUi[]=>[tab('YIELD','ui:harvester-menu','YIELD'),tab('HISTORY','replay','HISTORY')];
export function marketDefaultTab(sold:boolean,available:readonly string[]):string {const tabs=available.length?available:['BUY'];return sold&&tabs.includes('MY ORDERS')?'MY ORDERS':tabs.includes('BUY')?'BUY':tabs[0]!;}
export const catalogueKey=(id:string)=>id.trim().replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[- ]/g,'_').toLowerCase();
const inventoryArt=new Set(['frost_quartz','frostglass','heartwood_logs','heartwood_beams','sunstone_rubble','sunstone_blocks','crown_iron_ore','crownsteel','rough_prism','prismstone_lens','storm_ore','stormalloy','thorn_fibre','thornsilk','ember_nodules','embercore','forge_ingot']);
const namedArt:Readonly<Record<string,string>>={navigation_kit:'ui:navigation-kit',climate_kit:'ui:climate-kit',expedition_kit:'ui:expedition-kit',crystal_fragments:'ui:crystal-fragments',renown:'ui:renown',exp:'ui:exp',route_compass:'craft:item_route_compass',survey_lens:'craft:item_survey_lens',aurora_wake:'craft:item_aurora_wake',artisan_market_awning:'craft:item_awning',market_awning:'craft:item_awning',shards:'shards',shard:'shards',gems:'gem',gem:'gem',keep:'keep',sol:'sol',land_deed:'itm_deed_earth',deed:'itm_deed_earth'};
export function craftItemIcon(id:string):string {const key=catalogueKey(id);return inventoryArt.has(key)?`craft:inv_${key}`:namedArt[key]??'shape:unknown';}
/** These bounds and frame counts describe bundled art, not game balance. */
export const artTier=(tier:number|null)=>clampQuantity(tier??1,1,4);
export type BenchSprite='IDLE'|'WORKING'|'READY'|'UPGRADING';
export const workshopSprite=(tier:number|null,state:BenchSprite)=>`craft:workshop_t${artTier(tier)}_${state==='UPGRADING'?'construction':state.toLowerCase()}`;
export const marketSprite=(tier:number|null)=>`craft:market_t${artTier(tier)}_idle`;
export const awningSprite=(tier:number|null)=>`craft:awning_t${artTier(tier)}`;
export const HARVESTER_ART_KEYS=new Set(['crownlands','frostveil','elderwood','sunscar','stormcairn','thornwake','cinderfall','seeker-reach']);
export const harvesterSprite=(key:string|null,tier:number|null,state:'IDLE'|'READY'|'CONSTRUCTION')=>key!==null&&HARVESTER_ART_KEYS.has(key)?`craft:harv_${key.replace(/-/g,'_')}_t${artTier(tier)}_${state.toLowerCase()}`:null;
export function atlasFrameOrigin(atlas:CraftAtlas,index:number):[number,number] {
  const frames=Math.max(1,atlas.frames),i=((index%frames)+frames)%frames,columns=Math.max(1,atlas.columns),origin=atlas.origin??0,stride=atlas.stride??atlas.cell;
  return [origin+(i%columns)*stride,origin+Math.floor(i/columns)*stride];
}
export const loopFrame=(elapsedMs:number,fps:number,frames:number)=>fps<=0||frames<=0||elapsedMs<0?0:Math.floor(elapsedMs*fps/1000)%frames;
export const CraftAtlases={
  workshopWorking:(tier:number|null):CraftAtlas=>({art:`craft:workshop_t${artTier(tier)}_working_loop`,frames:9,cell:112,columns:3,origin:2,stride:114}),
  marketWorking:(tier:number|null):CraftAtlas=>({art:`craft:market_t${artTier(tier)}_working`,frames:8,cell:112,columns:8}),
  ingotCasting:{art:'craft:fx_ingot_casting',frames:8,cell:64,columns:8},ingotReady:{art:'craft:fx_ingot_ready',frames:9,cell:64,columns:9},
  craftSuccess:{art:'craft:fx_craft_success',frames:8,cell:64,columns:8},rewardClaim:{art:'craft:fx_reward_claim',frames:8,cell:64,columns:8},
} satisfies Record<string,CraftAtlas|((tier:number|null)=>CraftAtlas)>;
