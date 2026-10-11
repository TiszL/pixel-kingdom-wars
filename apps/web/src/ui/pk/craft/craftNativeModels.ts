/** Presentation-only inputs for the complete CraftLogic/MarketLogic port.
 * Amounts are bigint; clocks/seconds are safe integer numbers supplied by a mapper.
 * No defaults for game policy, prices, capacities, recipes, or balances are invented here.
 * Gate fields are required: adapters must supply current server/controller facts.
 */
export type Currency='SHARDS'|'GEMS'|'KEEP'|'SKR'|'SOL'|'ITEM';
export type Verb='GOLD'|'STONE'|'CHARCOAL'|'MOSS'|'RED'|'GREEN'|'BLUE';
export type CommandState='BUSY'|'DISABLED'|'LOCKED'|'SHORT'|'ENABLED';
export interface PriceUi {currency:Currency;amount:string|null;status:'SHORT'|'UNAVAILABLE'|'CHECKING'|'OK'|'SERVER_ZERO';icon?:string;description?:string}
export interface BadgeUi {text:string;tone:'READY';description:string}
export type PrimaryAction='NONE'|'START'|'RETRY'|'NEED_MORE'|'SHAKE'|'COLLECT'|'SHOW'|'HIDE'|'LINK_WALLET'|'OPEN_ORDERS'|'OPEN_SELL'|'UPGRADE';
export interface CraftPrimaryUi {label:string;sub:string|null;state:CommandState;verb:Verb;reason:string|null;price:PriceUi|null;action:PrimaryAction;badge:BadgeUi|null}
export type CraftHydration='LOADING'|'READY'|'ERROR';
export interface SubmitUi {stage:'IDLE'|'SENDING'|'CHECKING'|'REFUSED';busyLabel?:string;message?:string|null}
export interface SavedOpUi {opId:string}
export interface CraftItemUi {itemId:string;name:string;icon:string;source:string;makeHereRecipeId?:string|null;pluralName?:string;usedFor?:string|null}
export interface RecipeInputUi {kind:'RAW'|'CRAFTING'|'SHARDS';itemId:string;perUnit:bigint}
export interface StockUi {available:bigint|null;reserved?:bigint|null;total?:bigint|null;pendingOutput?:bigint|null}
export interface LockReasonUi {line:string;requirement:string}
export interface RecipeUi {recipeId:string;recipeVersion:string;group:'REFINE'|'KIT';outputItemId:string;outputPerUnit:bigint;inputs:readonly RecipeInputUi[];secondsPerUnit:number|null;usedFor:string;locked:LockReasonUi|null}
export interface BenchJobUi {jobId:string;recipeId:string;quantity:bigint;readyAtMs:number;doneAt?:string;startedAtMs?:number|null}
interface CommonUi {hydration:CraftHydration;submit:SubmitUi;serverOffsetMs?:number;items?:Readonly<Record<string,CraftItemUi>>;shards?:bigint|null}
interface StockCommonUi extends CommonUi {stock?:Readonly<Record<string,StockUi>>}
export interface WorkshopRefineUi extends CommonUi {recipes:readonly RecipeUi[];stock:Readonly<Record<string,StockUi>>;maxBatch:number;acceptingJobs:boolean;pendingJobs:readonly BenchJobUi[];actionsAllowed:boolean;selectedRecipeId:string|null;quantity:number;savedOperation:SavedOpUi|null;benchCapacity:number}
export interface WorkshopIngotsUi extends CommonUi {
  inventory:{held:bigint|null;pending:bigint|null};
  allowance:{daily:{used:bigint|null;cap:bigint|null;remaining:bigint|null};holding:{held:bigint|null;pending:bigint|null;cap:bigint|null;remaining:bigint|null};resetsAtMs:number|null};
  shardsPerIngot:bigint|null;batch:{size:bigint|null};job:{jobId:string;ingots:bigint;readyAtMs:number|null;state:'RUNNING'|'READY'|'COLLECTING'}|null;
  shards:bigint|null;actionsAllowed:boolean;saved:SavedOpUi|null;quantity:number;secondsPerIngot:number|null;collect?:'IDLE'|'COLLECTING'|'COLLECTED'|'FAILED';
}
export interface ToolRecipeUi {recipeId:string;itemId:string;name:string;shortName:string;effect:string;icon:string;inputs:readonly RecipeInputUi[];durationSec:number|null;locked?:LockReasonUi|null}
export interface WorkshopToolsUi extends StockCommonUi {recipes:readonly ToolRecipeUi[];owned:Readonly<Record<string,bigint|null>>;travelling:readonly {itemId:string;returnsAtMs:number;installationId:string}[];job:BenchJobUi|null;acceptingJobs:boolean;saved:SavedOpUi|null;selectedRecipeId?:string|null;actionsAllowed:boolean}
export interface AwningTierUi {tier:number;recipeId:string|null;requiredMarketLevel:number;inputs:readonly RecipeInputUi[];durationSec:number|null;owned:boolean;craftable:boolean;lockReason?:LockReasonUi|null}
export interface AwningUi {tiers:readonly AwningTierUi[];appliedTier:number|null;previewVerified:boolean}
export interface WorkshopStyleUi extends StockCommonUi {awning:AwningUi;wake:{owned:boolean;shown:boolean;recipe:{recipeId:string;inputs:readonly RecipeInputUi[];durationSec:number|null}|null};marketLevel:number|null;job:BenchJobUi|null;saved:SavedOpUi|null;selectedTier?:number|null;wakeSelected?:boolean;actionsAllowed:boolean;acceptingJobs:boolean}
export interface HarvesterYieldUi extends CommonUi {realmId:string;artKey:string|null;resourceId:string;level:number|null;tier:number|null;policy:{grossPerCadence:bigint|null;cadenceSec:number|null};interval:{state:'NONE'|'RUNNING'|'ENDED';startedAtMs:number|null;nextHaulAtMs:number|null};arrived:{unseenQuantity:bigint;lastAt:string|null};todayArrived:bigint|null;stock:StockUi;nextLevelDelta:string|null;upgradeCost:PriceUi|null;actionsAllowed:boolean;saved:SavedOpUi|null;arrivedNoun?:string;complete:boolean}
export interface CraftLiveUi {icon:string;text:string;accent:string|null;ready:boolean;description:string}
export interface WorkshopSheetUi {frame:{live:CraftLiveUi|null};refine?:WorkshopRefineUi|null;ingots?:WorkshopIngotsUi|null;tools?:WorkshopToolsUi|null;style?:WorkshopStyleUi|null}
export interface CraftWellUi {icon:string;alpha:number;description:string}
export interface CraftAtlas {art:string;frames:number;cell:number;columns:number;origin?:number;stride?:number}
export interface CraftHeaderUi {sprite:string|null;loop:CraftAtlas|null;loopFps:number}
export interface TabUi {id:string;icon:string;label:string;badge:BadgeUi|null;disabled:boolean}
export interface CraftReviewUi {title:string;line:string;confirmLabel:string;backLabel:string;sending:boolean}
