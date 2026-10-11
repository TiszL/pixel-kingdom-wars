/** Pure hub presentation parity. Recovery is a separate intent; server values are never synthesized. */
export type LoadState='LOADING'|'READY'|'STALE'|'ERROR';
export function boardView(load:LoadState,data:boolean){return load==='LOADING'?(data?'REFRESHING':'SKELETON'):load==='STALE'?(data?'STALE':'SKELETON'):load==='ERROR'?(data?'ERROR_KEPT':'ERROR_EMPTY'):'LIVE';}
export function fractionText(done:number|null,total:number|null){return `${done??'…'}/${total??'…'}`;}
export function orderQuests<T extends {state:string}>(rows:T[]):T[]{const rank=(s:string)=>s==='READY'?0:s==='DONE'?2:1;return [...rows].sort((a,b)=>rank(a.state)-rank(b.state));}
export type LetterState='READ'|'CLAIMABLE'|'CLAIMING'|'CHECKING'|'CLAIMED'|'EXPIRED'|'FAILED';
export function letterControls(state:LetterState,rewards:boolean){return {claim:rewards&&['CLAIMABLE','CLAIMING','FAILED'].includes(state),claimBusy:state==='CLAIMING',claimLabel:state==='FAILED'?'RETRY':'CLAIM',archiveEnabled:state!=='CLAIMING'&&state!=='CHECKING',tileAlpha:state==='EXPIRED'?0.45:1,recheck:state==='CHECKING'};}
export function reportUnreadBadge(unread:number|null){return unread===null?'…':unread<=0?null:unread>99?'99+':`${unread}`;}
export function feedbackNeedsDiscardConfirm(title:string,body:string,send:string){return send!=='SENT'&&(!!title.trim()||!!body.trim());}
export interface FeedbackDraft{category:string|null;title:string;body:string;send:'READY'|'SENDING'|'SENT'|'FAILED';titleMax:number|null;bodyMax:number|null}
export function feedbackCanSend(x:FeedbackDraft){return !!x.category&&!!x.title.trim()&&x.send!=='SENDING'&&x.send!=='SENT'&&(x.titleMax===null||x.title.length<=x.titleMax)&&(x.bodyMax===null||x.body.length<=x.bodyMax);}
export function ratedAttacksLabel(done:number|null,needed:number|null){return `ATTACKS ${fractionText(done,needed)}`;}
export interface ChatState{draft:string;canSend:boolean;sending:boolean;tab:string;clanLockedReason:string|null;blockedReason:string|null}
export function chatBlockedReason(x:ChatState){return x.tab==='CLAN'&&x.clanLockedReason?x.clanLockedReason:x.blockedReason;}
export function chatCanSend(x:ChatState){return x.canSend&&!x.sending&&!chatBlockedReason(x)&&!!x.draft.trim();}
export function cacheDays(day:number,days:number|null,claimed:boolean):('CLAIMED'|'TODAY'|'FUTURE')[]|null{if(days===null||days<=0||!Number.isSafeInteger(days))return null;const today=Math.max(1,Math.min(day,days));return Array.from({length:days},(_,i)=>i+1<today||i+1===today&&claimed?'CLAIMED':i+1===today?'TODAY':'FUTURE');}
export type CacheState='READY'|'LOADING'|'CLAIMING'|'CLAIMED'|'CHECKING';
export function cacheClaimLabel(state:CacheState){return state==='CLAIMING'?'Claiming':state==='CLAIMED'?'CLAIMED TODAY':state==='CHECKING'?'RETRY':'CLAIM';}
export function orderReports<T extends {unread:number|null}>(rows:T[]):T[]{// null = unread, count not supplied; retained ahead of read reports.
 return [...rows].sort((a,b)=>Number(!(a.unread===null||a.unread>0))-Number(!(b.unread===null||b.unread>0)));}
export function earningTag(earning:boolean|null,paid:boolean){return paid?'PAID':earning===true?'EARNING':earning===false?'NOT YET':null;}
export function eventShowsJoin(phase:'UPCOMING'|'LIVE'|'CLOSED',joined:boolean){return phase==='LIVE'&&!joined;}
export function gateDismissible(kind:string){return kind==='UPDATE_OPTIONAL';}
