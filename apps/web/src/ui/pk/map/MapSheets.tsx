/** P7 map content only. The existing scene and F2ab host own map/camera/lifecycle/Back. */
import { useId, type ReactNode } from 'react';
import { PkPlate, PkPlateFrame } from '../Plate';
import { PkPrimaryButton, PkSecondaryButton, PkTag } from '../Button';
import { PkPriceChip } from '../PriceChip';
import { commandDrawState } from '../kitLogic';
import type { CommandState, PriceUi, Verb } from '../types';
import { spotLayout, phaseHeadline, bidderName, countdownCopy, rewardsTabOf, reachLayout, licenceAction, permitTileTap, rewardsIntro, termAction, archipelagoPrimary, deliverState, trialPrimaryState, type AuctionPhase, type SpotState, type ReachStatus, type ReachPrimary, type LicenceState, type RewardsTab } from './MapLogic';
import './MapSheets.css';
const SPOT_COPY:Record<SpotState,string>={NOT_OPEN:'Opens soon',LIVE:'Live bidding',YOU_LEAD:'You lead',OUTBID:'You were outbid',KING:'Your winning spot',CLOSED:'Blocked this term',LICENCE_LATER:'Licence draw opens later'};
const PERMIT_COPY:Record<PermitRealm['state'],string>={OPEN:'Available',HOME:'Home realm',NOT_SOLD:'Not sold here',COVERED:'Covered'};
const REWARD_COPY:Record<RewardTerm['state'],string>={READY:'Ready to claim',CHECKING:'Being checked',CLAIMED:'Sent',NONE:'No rewards yet'};
export interface MapIntent {id:string;kind:'navigate'|'review'|'recover'|'explain'|'need-more';reason?:string}
export interface MapAction {id:string;label:string;kind:MapIntent['kind'];state:CommandState;reason?:string|null;price?:PriceUi|null;verb?:Verb;sub?:string|null}
export interface MapRow {id:string;title:string;sub?:string|null;value?:string|null;tag?:string|null;art?:ReactNode;action?:MapAction}
export interface MapSheetProps {title?:string;rows:MapRow[];onIntent:(intent:MapIntent)=>void;onClose?:()=>void;onHistory?:()=>void;children?:ReactNode;primary?:MapAction|null;note?:string|null;testData?:boolean;loading?:boolean}
function Primary({action,onIntent}:{action:MapAction;onIntent:MapSheetProps['onIntent']}){
 const state=commandDrawState({state:action.state,price:action.price??null});
 const reason=action.reason??(action.price?.status==='UNAVAILABLE'?'Price unavailable right now':null);
 const tap=()=>{
 if(state==='BUSY')return;if(state==='DISABLED'||state==='LOCKED'){if(reason)onIntent({id:action.id,kind:'explain',reason});return;}
 onIntent({id:action.id,kind:state==='SHORT'?'need-more':action.kind});
 };
 return <PkPrimaryButton {...action} state={state} reason={reason} onClick={tap} onPrice={state==='SHORT'&&action.price?.status==='SHORT'?tap:null}/>;}
export function MapSheet({title='MAP',rows,onIntent,onClose,onHistory,children,primary,note,testData,loading}:MapSheetProps){return <PkPlateFrame ui={{title,history:!!onHistory}} className="pk-map-sheet" {...(onClose?{onClose}:{})} {...(onHistory?{onHistory}:{})} footer={primary?<Primary action={primary} onIntent={onIntent}/>:undefined}>
 {testData?<PkTag text="TEST DATA" verb="STONE"/>:null}{loading?<p role="status">Loading…</p>:null}{note?<p>{note}</p>:null}{children}
 <div className="pk-map-sheet__rows">{rows.map(row=><PkPlate key={row.id} kind="CREAM" className="pk-map-sheet__row">{row.art}<div><h3>{row.title}</h3>{row.sub?<p>{row.sub}</p>:null}{row.value!==undefined?<strong>{row.value?.trim()||'…'}</strong>:null}</div>{row.tag?<PkTag text={testData&&row.tag.startsWith('LIVE')?'TEST DATA':row.tag} verb="STONE"/>:null}{row.action?<Primary action={row.action} onIntent={onIntent}/>:null}</PkPlate>)}</div>
 </PkPlateFrame>;}
export function SeekerPanel({phase,countdown,...p}:MapSheetProps & {phase:AuctionPhase|null;countdown:string|null}) {const clock=countdown===null||p.loading||phase===null?null:countdownCopy('SEEKER',phase,null,countdown);return <MapSheet {...p} title="SEEKER ISLAND"><h3>{phaseHeadline(phase)}</h3>{clock?<p>{clock.label}{clock.time!==null?` ${clock.time}`:''}</p>:null}</MapSheet>;}
export function SeekerSpotSheet({state,phase,loading,hasPermit=false,spotLabel='…',countdown=null,leader,bid,held,bidState='DISABLED',bidReason='Waiting for auction terms',onBidStep,recoveryPending=false,...p}:MapSheetProps & {state:SpotState;phase:AuctionPhase|null;loading:boolean;hasPermit?:boolean;spotLabel?:string;countdown?:string|null;leader?:{name:string|null;price:PriceUi|null};bid?:PriceUi;held?:PriceUi;bidState?:CommandState;bidReason?:string;onBidStep?:(direction:'less'|'more')=>void;recoveryPending?:boolean}) {
 const layout=spotLayout(state,phase,loading,hasPermit);
 const clock=countdown===null||loading||phase===null||state==='NOT_OPEN'&&phase!=='OPENS_AT'?null:countdownCopy('SEEKER',phase,null,countdown);
 const drawnBidState=commandDrawState({state:bidState,price:bid??null});
 const canStep=!!onBidStep&&(drawnBidState==='ENABLED'||drawnBidState==='SHORT');
 let a:MapAction|null=null;
 if(layout.primary==='CHECKING')a={id:'spot',label:'CHECKING',state:'BUSY',kind:'review'};
 if(layout.primary==='LOCKED_OPENS')a={id:'spot',label:'BIDDING NOT OPEN',state:'LOCKED',reason:'Bidding is not open yet',kind:'review'};
 if(layout.primary==='BID')a={id:'spot',label:state==='LIVE'?'BID':'RAISE TO',state:bidState,reason:bidReason,price:bid??null,kind:'review'};
 if(layout.primary==='CLAIM')a={id:'spot.rewards',label:'CLAIM',state:'ENABLED',kind:'navigate'};
 if(layout.primary==='PERMIT')a={id:'spot.permit',label:'BUY REALM PERMIT',state:'ENABLED',kind:'navigate'};
 // The controller supplies only authorized original-scope saved recovery (GET-only; never repost).
 if(recoveryPending)a={id:'spot.saved',label:'CHECK SAVED RECEIPT',state:'ENABLED',kind:'recover'};
 return <MapSheet {...p} loading={loading} title={`SEEKER SPOT ${spotLabel}`} primary={a} note={layout.offLine?'Auctions are not open on this server yet':p.note??null}>
  {!layout.offLine?<PkTag text={p.testData&&state==='LIVE'?'TEST DATA':SPOT_COPY[state]} verb={p.testData?'STONE':state==='OUTBID'?'RED':'STONE'}/>:null}
  {clock?<p>{clock.label}{clock.time!==null?` ${clock.time}`:''}</p>:null}
  {!loading&&phase!==null&&(layout.bidCards||layout.heldRow)&&leader?<PkPlate kind="CREAM"><div data-spot-leader className="pk-map-sheet__quote"><h3>TOP BID</h3><strong>{bidderName(leader.name)}</strong>{leader.price?<PkPriceChip ui={leader.price}/>:<span>…</span>}</div></PkPlate>:null}
  {layout.heldRow&&held?<div><h3>YOUR HELD BID</h3><PkPriceChip ui={held}/></div>:null}
  {layout.bidCards?<div className="pk-map-sheet__quote"><h3>NEXT BID</h3>{bid?<PkPriceChip ui={bid}/>:<span>…</span>}</div>:null}
  {layout.stepper&&!recoveryPending?<div className="pk-map-sheet__stepper"><PkSecondaryButton label="LESS" enabled={canStep} onClick={()=>onBidStep?.('less')}/><span>{!bid||bid.status==='CHECKING'?'…':bid.status==='UNAVAILABLE'?'—':bid.status==='SERVER_ZERO'?'FREE':bid.amount??'…'}</span><PkSecondaryButton label="MORE" enabled={canStep} onClick={()=>onBidStep?.('more')}/></div>:null}
  {recoveryPending?<p role="status">This request may already be accepted. Check its outcome.</p>:null}{layout.footnote?<p>Your wallet shows the terms before you sign.</p>:null}
 </MapSheet>;
}
export function SolanaWorkshopSheet({licence,entered,closesIn,hasClaim,...p}:MapSheetProps & {licence:LicenceState|null;entered:boolean|null;closesIn:string|null;hasClaim:boolean}) {const a=licenceAction(licence,entered,closesIn,hasClaim);const clock=countdownCopy('SOLANA',null,licence,closesIn);return <MapSheet {...p} title="SOLANA WORKSHOP" primary={a.primary==='NONE'?null:{id:'licence',label:a.primary==='ENTERED'?'ENTERED':a.primary==='CLAIM'?'CLAIM':'ENTER DRAW',state:a.primary==='ENTERED'?'DISABLED':a.primary==='ENTER'||a.primary==='CLAIM'?'ENABLED':'LOCKED',verb:a.primary==='ENTERED'?'STONE':'GOLD',reason:a.reason,kind:'review'}}>{a.primary==='NONE'&&a.reason?<p>{a.reason}</p>:null}{clock&&clock.label!==a.reason&&!(licence==='OPEN'&&entered===true)?<p>{clock.label}{clock.time!==null?` ${clock.time}`:''}</p>:null}</MapSheet>;}
export function SolanaPublicWorkshopSheet(p:MapSheetProps){return <MapSheet {...p} title="PUBLIC WORKSHOP"/>;}
export function ReachTileSheet({status,hasDeed,short,...p}:MapSheetProps & {status:ReachStatus;hasDeed:boolean|null;short:boolean}) {const x=reachLayout(status,hasDeed,short);const names:Record<Exclude<ReachPrimary,'NONE'>,string>={UNLOCK:'UNLOCK TILE',GET_SKR:'GET SKR',GET_LAND:'GET LAND',BUY_BASE:'BUY BASE HERE'};return <MapSheet {...p} title="SOLANA REACH" note={x.line} primary={x.primary==='NONE'?null:{id:'reach',label:names[x.primary],state:'ENABLED',kind:x.primary==='UNLOCK'?'review':'navigate',verb:x.primary==='GET_SKR'||x.primary==='GET_LAND'?'BLUE':'GOLD'}} rows={x.cards?p.rows:[]}/>;}
export interface PermitRealm {id:string;name:string;state:'OPEN'|'HOME'|'NOT_SOLD'|'COVERED';coveredUntil:string|null}
export function RealmPermitSheet({realms,selected,onSelect,...p}:MapSheetProps & {realms:PermitRealm[];selected:string|null;onSelect:(id:string)=>void}){return <MapSheet {...p} title="REALM PERMIT"><div className="pk-map-sheet__grid">{realms.map(r=><button type="button" key={r.id} aria-pressed={r.id===selected} aria-disabled={r.state==='HOME'||r.state==='NOT_SOLD'} onClick={()=>{const action=permitTileTap(r.state);if(action==='SELECT')onSelect(r.id);else p.onIntent({id:r.id,kind:'explain',reason:action==='HOME'?'Your home realm needs no permit':'Not sold at this spot'});}}><strong>{r.name}</strong><span>{r.state==='COVERED'?`TO ${r.coveredUntil??'…'}`:PERMIT_COPY[r.state]}</span></button>)}</div></MapSheet>;}
export interface RewardTerm {id:string;title:string;amount:string|null;state:'READY'|'CHECKING'|'CLAIMED'|'NONE'}
export function IslandRewardsSheet({tab,onTab,terms,kingdom,kingdomMissing,...p}:MapSheetProps & {tab:string|null;onTab:(tab:RewardsTab)=>void;terms:RewardTerm[];kingdom:string|null;kingdomMissing:boolean}){
 const selectedTab=rewardsTabOf(tab);const tabs:RewardsTab[]=['MATERIALS','SHARDS','REALMS_CUT'];return <MapSheet {...p} title="ISLAND REWARDS" note={rewardsIntro(selectedTab)}><nav className="pk-map-sheet__tabs" aria-label="Reward type">{tabs.map(t=><button type="button" key={t} aria-pressed={selectedTab===t} onClick={()=>onTab(t)}>{t==='REALMS_CUT'?"REALM'S CUT":t}</button>)}</nav>{selectedTab!=='REALMS_CUT'?<p>INTO {kingdom??'…'} {kingdomMissing?'· Choose a kingdom you own':''}</p>:null}{terms.map(t=>{const action=termAction(t.state);return <PkPlate kind="CREAM" key={t.id} className="pk-map-sheet__row"><h3>{t.title}</h3><strong>{t.amount??'…'}</strong><PkTag text={REWARD_COPY[t.state]} verb="STONE"/>{action!=='NONE'?<PkSecondaryButton label={action==='RECOVER'?'CHECK SAVED RECEIPT':'CLAIM'} enabled={action==='RECOVER'||selectedTab==='REALMS_CUT'||!kingdomMissing&&!!kingdom} onClick={()=>p.onIntent({id:t.id,kind:action==='RECOVER'?'recover':'review'})}/>:null}</PkPlate>;})}</MapSheet>;
}
function recoveryRows(rows:MapRow[],pending:boolean,guard:(state:CommandState,pending:boolean)=>CommandState):MapRow[]{
 return pending?rows.map(row=>row.action?.kind==='review'?{...row,action:{...row.action,state:guard(row.action.state,pending),reason:row.action.reason??'Check the saved request first.'}}:row):rows;
}
export function DivinePanel(p:MapSheetProps){return <MapSheet {...p} title="DIVINE ISLE"/>;}
export function DivineTrialsSheet({attemptChecking,...p}:MapSheetProps & {attemptChecking:boolean}){return <MapSheet {...p} title="SOLO TRIALS" rows={recoveryRows(p.rows,attemptChecking,trialPrimaryState)} primary={attemptChecking?{id:'trials',label:'CHECK SAVED ATTEMPT',state:'ENABLED',kind:'recover'}:p.primary??null} note={attemptChecking?'Your attempt is being checked.':p.note??null}/>;}
export function DivineFragmentsSheet({recoveryPending,...p}:MapSheetProps & {recoveryPending:boolean}){return <MapSheet {...p} title="FRAGMENTS" rows={recoveryRows(p.rows,recoveryPending,deliverState)} primary={recoveryPending?{id:'fragments',label:'CHECK SAVED RECEIPT',state:'ENABLED',kind:'recover'}:p.primary??null} note={recoveryPending?'This request may already be accepted. Check its outcome.':p.note??null}/>;}
export function ArchipelagoPanel({hasLodge,routeKnown,...p}:MapSheetProps & {hasLodge:boolean;routeKnown:boolean}){const a=archipelagoPrimary(hasLodge,routeKnown);return <MapSheet {...p} title="ARCHIPELAGO" primary={a==='NONE'?null:{id:'lodge',label:a==='SEND'?'SEND EXPEDITION':'BUILD A LODGE',state:'ENABLED',kind:'navigate',verb:a==='SEND'?'GOLD':'GREEN'}}/>;}
export function MapSearchDrawer({query,onQuery,...p}:MapSheetProps & {query:string;onQuery:(q:string)=>void}){const id=useId();return <MapSheet {...p} title="FIND A KINGDOM"><label htmlFor={id}>Kingdom name</label><input id={id} value={query} onChange={e=>onQuery(e.target.value)}/></MapSheet>;}
