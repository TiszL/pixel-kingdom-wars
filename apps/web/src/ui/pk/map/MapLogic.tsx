/** Android MapLogic/MapR2Logic parity; amounts and cutover countdowns come from callers. */
import type { CommandState, MoneyStage, PriceStatus } from '../types';
export type AuctionPhase='OPEN'|'OPENS_AT'|'OPERATING'|'SERVER_OFF';
export type SpotState='NOT_OPEN'|'LIVE'|'YOU_LEAD'|'OUTBID'|'KING'|'CLOSED'|'LICENCE_LATER';
export type LicenceState='NONE'|'OPEN'|'DRAWN'|'MINE'|'OCCUPIED';
export type ReachStatus='AVAILABLE'|'UNLOCKED_BY_ME'|'UNLOCKED_BY_OTHER'|'CLAIMED'|'OFF';
export type RewardsTab='MATERIALS'|'SHARDS'|'REALMS_CUT';
export function phaseHeadline(phase:AuctionPhase|null){return phase===null?'…':({OPEN:'BIDDING OPEN',OPENS_AT:'BIDDING OPENS',OPERATING:'OPERATING',SERVER_OFF:'Not open on this server yet'} as const)[phase];}
export function spotLayout(state:SpotState,phase:AuctionPhase|null,loading:boolean,hasPermit:boolean){
 const empty={bidCards:false,heldRow:false,stepper:false,claimTiles:false,primary:'NONE',footnote:false,offLine:false};
 if(phase==='SERVER_OFF')return {...empty,offLine:true};
 if(loading||phase===null)return {...empty,bidCards:true,primary:'CHECKING'};
 if(state==='NOT_OPEN')return {...empty,bidCards:true,primary:'LOCKED_OPENS',footnote:true};
 if(state==='LIVE'||state==='YOU_LEAD')return {...empty,bidCards:true,stepper:true,primary:'BID',footnote:true};
 if(state==='OUTBID')return {...empty,heldRow:true,stepper:true,primary:'BID',footnote:true};
 if(state==='KING')return {...empty,claimTiles:true,primary:'CLAIM'};
 return {...empty,primary:hasPermit?'PERMIT':'NONE'};
}
export function bidderName(name:string|null){return name?.trim()||'a Seeker player';}
export function countdownCopy(island:'SEEKER'|'SOLANA',phase:AuctionPhase|null,licence:LicenceState|null,time:string|null){
 if(island==='SEEKER')return phase==='SERVER_OFF'?null:{label:phase==='OPENS_AT'?'Bidding opens':phase==='OPERATING'?'Operating · next auction in':'Bids close in',time:time??'…'};
 return licence==='OPEN'?{label:'Draw closes in',time:time??'…'}:{label:!licence||licence==='NONE'?'Licence draw opens later':'Next draw opens later',time:null};
}
export function licenceAction(state:LicenceState|null,entered:boolean|null,closes:string|null,claim:boolean){return !state||state==='NONE'?{primary:'LOCKED',reason:'Licence draw opens later'}:state==='OPEN'?{primary:entered?'ENTERED':'ENTER',reason:entered?`Drawn in ${closes??'…'}`:null}:state==='MINE'?{primary:claim?'CLAIM':'NONE',reason:null}:state==='OCCUPIED'?{primary:'LOCKED',reason:'Next draw opens later'}:{primary:'NONE',reason:null};}
export type ReachPrimary='NONE'|'UNLOCK'|'GET_SKR'|'GET_LAND'|'BUY_BASE';
export interface ReachLayout {primary:ReachPrimary;info:boolean;cards:boolean;line:string|null}
export function reachLayout(status:ReachStatus,deed:boolean|null,short:boolean):ReachLayout{
 if(status==='OFF')return {primary:'NONE',info:false,cards:false,line:'Seeker tiles are not open on this server yet'};
 if(status==='UNLOCKED_BY_OTHER'||status==='CLAIMED')return {primary:'NONE',info:true,cards:false,line:'Held by another kingdom'};
 if(status==='UNLOCKED_BY_ME')return {primary:'BUY_BASE',info:true,cards:false,line:'This tile is held for you. Buy the base on it whenever you are ready.'};
 return {primary:deed===false?'GET_LAND':short?'GET_SKR':'UNLOCK',info:true,cards:true,line:null};
}
export function permitTileTap(state:'OPEN'|'HOME'|'NOT_SOLD'|'COVERED'){return state==='HOME'?'HOME':state==='NOT_SOLD'?'NOT_SOLD':'SELECT';}
export function permitSealCanArm(price:PriceStatus,stage:MoneyStage){return (price==='OK'||price==='SERVER_ZERO')&&(stage==='READY'||stage==='FAILED');}
export function rewardsTabOf(id:string|null):RewardsTab{return id==='SHARDS'||id==='REALMS_CUT'?id:'MATERIALS';}
export function rewardsIntro(tab:RewardsTab){return tab==='MATERIALS'?'Materials your winning spots earned. They go into a kingdom you own.':tab==='SHARDS'?'Shards your winning spots earned. They go into a kingdom you own.':"Each realm's cut of the permits your spots sold. Paid in KEEP to your wallet.";}
export function termAction(state:'READY'|'CHECKING'|'CLAIMED'|'NONE'){return state==='READY'?'CLAIM':state==='CHECKING'?'RECOVER':'NONE';}
export function deliverState(given:CommandState,recovery:boolean):CommandState{return recovery&&given==='ENABLED'?'DISABLED':given;}
export const trialPrimaryState=deliverState;
export function archipelagoPrimary(hasLodge:boolean,known:boolean){return !known?'NONE':hasLodge?'SEND':'BUILD_LODGE';}
