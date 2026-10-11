/** Unmounted account presentation. Intent callbacks belong to existing controllers/OverlayHost. */
import { useId, type ReactNode } from 'react';
import { PkPlate, PkPlateFrame } from '../Plate';
import { PkPrimaryButton, PkSecondaryButton, PkQuietButton, PkTag } from '../Button';
import { PkPriceChip } from '../PriceChip';
import { commandDrawState } from '../kitLogic';
import type { CommandState, PriceUi, Verb } from '../types';
import { primaryTap, addKingdomSub, kingdomsMode, historyLine, landPaymentLine, titleConnectLabel, titleConnectStage, landGatePrimary, settleLook, shortAddress, nameSaveEnabled, canUnlink, memberPowers, sortMembers, faucetLook, unknown, type ClanRole, type FaucetState } from './AccountLogic';
import './AccountSheets.css';
export interface AccountIntent { id:string; kind:'navigate'|'review'|'recover'|'action'|'explain'|'need-more'|'confirm'; reason?:string }
export interface AccountAction { id:string; label:string; state:CommandState; kind:AccountIntent['kind']; reason?:string|null; sub?:string|null; price?:PriceUi|null; verb?:Verb }
export interface AccountRow { id:string; title:string; sub?:string|null; value?:string|null; tag?:string|null; price?:PriceUi|null; action?:AccountAction; art?:ReactNode }
export interface AccountSheetProps { screen:string; title?:string; rows:AccountRow[]; primary?:AccountAction|null; tabs?:string[]; tab?:string; onTab?:(tab:string)=>void; onIntent:(intent:AccountIntent)=>void; onClose?:()=>void; onHistory?:()=>void; children?:ReactNode; note?:string|null; load?:'LOADING'|'READY'|'ERROR'|'STALE'; asOf?:string|null }
function Action({action,onIntent}:{action:AccountAction;onIntent:AccountSheetProps['onIntent']}) {
 const state=commandDrawState({state:action.state,price:action.price??null});
 const reason=action.reason??(action.price?.status==='UNAVAILABLE'?'Price unavailable right now':null);
 const tap=()=>{const route=primaryTap({state,reason});if(route==='IGNORE')return;onIntent({id:action.id,kind:route==='NEED_MORE'?'need-more':route==='EXPLAIN'?'explain':action.kind,...(route==='EXPLAIN'?{reason:reason!}:{})});};
 return <PkPrimaryButton {...action} state={state} reason={reason} onClick={tap} onPrice={state==='SHORT'&&action.price?.status==='SHORT'?tap:null}/>;
}
export function AccountSheet({screen,title,rows,primary,tabs,tab,onTab,onIntent,onClose,onHistory,children,note,load='READY',asOf}:AccountSheetProps) {
 return <PkPlateFrame ui={{title:title??screen.replaceAll('_',' '),history:!!onHistory}} {...(onClose?{onClose}:{})} {...(onHistory?{onHistory}:{})} className="pk-account" footer={primary?<Action action={primary} onIntent={onIntent}/>:undefined}>
  {tabs?<nav className="pk-account__tabs" aria-label={`${title??screen} sections`}>{tabs.map(t=><button type="button" key={t} aria-pressed={t===tab} onClick={()=>onTab?.(t)}>{t}</button>)}</nav>:null}
  {load==='LOADING'?<p role="status">{rows.length?'Refreshing…':'Loading…'}</p>:null}
  {load==='ERROR'?<div role="alert"><p>Unable to load. {rows.length?'Your last view is kept.':''}</p><PkSecondaryButton label="RETRY" onClick={()=>onIntent({id:screen,kind:'recover'})}/></div>:null}
  {load==='STALE'?<p role="status">As of {unknown(asOf)}</p>:null}
  {note?<p className="pk-t-body">{note}</p>:null}{children}
  <div className="pk-account__rows" data-kept={load==='ERROR'&&rows.length>0||undefined}>{rows.map(row=><PkPlate key={row.id} kind="CREAM" className="pk-account__row">
   {row.art?<div className="pk-account__art">{row.art}</div>:null}<div className="pk-account__copy"><h3>{row.title}</h3>{row.sub?<p>{row.sub}</p>:null}{row.value!==undefined?<strong>{unknown(row.value)}</strong>:null}</div>
   {row.tag?<PkTag text={row.tag} verb="STONE"/>:null}{row.price?<PkPriceChip ui={row.price}/>:null}{row.action?<Action action={row.action} onIntent={onIntent}/>:null}
  </PkPlate>)}</div>
 </PkPlateFrame>;
}
const PROVIDER_COPY:Readonly<Record<string,string>>={WALLET:'Wallet',EMAIL:'Email',GOOGLE:'Google',APPLE:'Apple'};
const ROLE_COPY:Record<ClanRole,string>={LEADER:'Captain',ELDER:'Elder',MEMBER:'Member'};
export const PROFILE_TABS=['PROFILE','KINGDOMS','WALLET','ACCOUNT'];
export function ProfileCard(p:Omit<AccountSheetProps,'screen'>){return <AccountSheet {...p} screen="PROFILE" tabs={PROFILE_TABS}/>;}
export interface KingdomSummary {landless:boolean;count:number;additionalLandPrice:(PriceUi & {currency:'SOL'})|null}
/** Summary wording is provisional v4 copy, now pinned by regression cases; full Android layout parity is still open. */
export function ProfileKingdomsTab({summary,...p}:Omit<AccountSheetProps,'screen'> & {summary?:KingdomSummary}){
 const mode=summary?kingdomsMode(summary.landless,summary.count):null;
 return <AccountSheet {...p} screen="KINGDOMS">{mode?<p data-kingdom-summary>{mode==='LANDLESS'?'Choose a realm to start your kingdom.':mode==='ONE'?'Your kingdom':'Your kingdoms'}</p>:null}{summary?.additionalLandPrice&&mode!=='LANDLESS'?<p>{addKingdomSub(summary.additionalLandPrice)}</p>:null}{p.children}</AccountSheet>;
}
export function ProfileWalletTab({history,onHistory,...p}:Omit<AccountSheetProps,'screen'> & {address:string|null;history?:{needs:number|null;done:number|null}}){return <AccountSheet {...p} {...(!history&&onHistory?{onHistory}:{})} screen="WALLET"><div className="pk-account__wallet"><strong>{shortAddress(p.address)}</strong><PkSecondaryButton label="COPY ADDRESS" enabled={!!p.address} onClick={()=>p.onIntent({id:'wallet.address',kind:'action'})}/></div>{history?<div><p>{historyLine(history.needs,history.done)}</p>{onHistory?<PkQuietButton label="HISTORY" onParchment onClick={onHistory}/>:null}</div>:null}{p.children}</AccountSheet>;}
export function ProfileAccountTab({draft,saved,saving,linked,onName,...p}:Omit<AccountSheetProps,'screen'> & {draft:string;saved:string;saving:boolean;linked:Record<string,boolean>;onName:(name:string)=>void}) {
 const id=useId();return <AccountSheet {...p} screen="ACCOUNT"><label htmlFor={id}>NAME</label><input id={id} value={draft} onChange={e=>onName(e.target.value)} disabled={saving}/><PkSecondaryButton label="SAVE" enabled={nameSaveEnabled(draft,saved,saving)} onClick={()=>p.onIntent({id:'account.name',kind:'action'})}/>
  <h3>SIGN-IN METHODS</h3>{Object.entries(linked).map(([provider,isLinked])=><div className="pk-account__provider" key={provider}><span>{PROVIDER_COPY[provider]??'Sign-in method'}</span><PkSecondaryButton label={isLinked?'UNLINK':'LINK'} enabled={!isLinked||canUnlink(linked,provider)} onClick={()=>p.onIntent({id:provider,kind:isLinked?'confirm':'action'})}/>{isLinked&&!canUnlink(linked,provider)?<small>Keep at least one way to sign in.</small>:null}</div>)}
  <PkSecondaryButton label="2-STEP CODE" onClick={()=>p.onIntent({id:'security.totp',kind:'navigate'})}/><PkSecondaryButton label="BACKUP CODES" onClick={()=>p.onIntent({id:'security.backup',kind:'navigate'})}/><PkSecondaryButton label="SIGN OUT" verb="RED" onClick={()=>p.onIntent({id:'account.signout',kind:'confirm'})}/>
 </AccountSheet>;
}
export function LandGateCard({walletLinked,alreadyOwned,serverOffReason,...p}:Omit<AccountSheetProps,'screen'|'primary'> & {walletLinked:boolean;alreadyOwned:boolean;serverOffReason:string|null}){const a=landGatePrimary(walletLinked,alreadyOwned,serverOffReason);return <AccountSheet {...p} screen="CLAIM YOUR LAND" primary={{...a,id:walletLinked?'land.realm':'wallet.connect',kind:'navigate'}}/>;}
export interface RealmTile {id:string;name:string;lock:'NONE'|'FULL'|'SKR_UNLOCK';sub:string;art?:ReactNode}
export interface LandPaymentContent {outcome:'IN_FLIGHT'|'CHECKING'|'REFUSED';reason:string|null}
export function RealmPickerSheet({realms,selected,price,payment,primary,onSelect,...p}:Omit<AccountSheetProps,'screen'|'rows'> & {realms:RealmTile[];selected:string|null;price:PriceUi;payment?:LandPaymentContent;onSelect:(id:string)=>void}) {
 const paymentCopy=payment?landPaymentLine(payment.outcome,payment.reason):null;
 const realm=realms.find(x=>x.id===selected);const a=settleLook(realm?.name??null,realm?.lock??null,price);
 const offeredPrimary:AccountAction|null=primary===undefined?{...a,id:selected??'realm',kind:'review',price}:primary;
 const paymentPending=payment?.outcome==='IN_FLIGHT'||payment?.outcome==='CHECKING';
 const displayedPrimary:AccountAction|null=paymentPending&&offeredPrimary?{...offeredPrimary,state:'BUSY'}:offeredPrimary;
 return <AccountSheet {...p} screen="CHOOSE REALM" rows={[]} primary={displayedPrimary}>{paymentCopy?<p data-land-payment role={payment?.outcome==='REFUSED'?'alert':'status'}>{paymentCopy}</p>:null}<div className="pk-account__grid">{realms.map(r=><button type="button" key={r.id} aria-pressed={selected===r.id} onClick={()=>onSelect(r.id)}>{r.art}<strong>{r.name}</strong><span>{r.lock==='FULL'?'FULL':r.lock==='SKR_UNLOCK'?'SKR unlock':r.sub}</span></button>)}</div></AccountSheet>;
}
export function SuppliesSheet(p:Omit<AccountSheetProps,'screen'>){return <AccountSheet {...p} screen="SUPPLIES" tabs={['SHIELDS','BUILDERS','ENERGY','BOOSTS']}/>;}
export function ClanFinderSheet(p:Omit<AccountSheetProps,'screen'>){return <AccountSheet {...p} screen="FIND A CLAN" tabs={['FIND','CREATE']}/>;}
export function ClanCharterTab(p:Omit<AccountSheetProps,'screen'>){return <AccountSheet {...p} screen="CHARTER"/>;}
export function ClanTourneyTab(p:Omit<AccountSheetProps,'screen'>){return <AccountSheet {...p} screen="TOURNEY"/>;}
export interface ClanMember {id:string;name:string;role:ClanRole;isYou:boolean;online:boolean;trophies:number|null;wins:number|null}
export function ClanMembersTab({members,role,sort,onSort,...p}:Omit<AccountSheetProps,'screen'|'rows'> & {members:ClanMember[];role:ClanRole;sort:'TROPHIES'|'WINS'|'ONLINE';onSort:(s:'TROPHIES'|'WINS'|'ONLINE')=>void}) {
 return <AccountSheet {...p} screen="MEMBERS" tabs={['TROPHIES','WINS','ONLINE']} tab={sort} onTab={t=>onSort(t as typeof sort)} rows={[]}>{sortMembers(members,sort).map(m=>{const powers=memberPowers(role,m);return <PkPlate key={m.id} kind="CREAM" className="pk-account__row"><h3>{m.name}{m.isYou?' · YOU':''}</h3><span>{ROLE_COPY[m.role]} · {m.trophies??'…'} trophies · {m.wins??'…'} wins</span>{powers.canPromote?<PkSecondaryButton label="PROMOTE" onClick={()=>p.onIntent({id:m.id,kind:'confirm'})}/>:null}{powers.canKick?<PkSecondaryButton label="REMOVE" verb="RED" onClick={()=>p.onIntent({id:`remove:${m.id}`,kind:'confirm'})}/>:null}</PkPlate>;})}</AccountSheet>;
}
export function FaucetCard({ui,network,onIntent}:{ui:FaucetState;network:'devnet'|'mainnet'|'unknown';onIntent:AccountSheetProps['onIntent']}) {
 const x=faucetLook(ui);if(!x||network!=='devnet')return null;
 const a:AccountAction|null=x.button==='NONE'?null:{id:'faucet',label:x.button==='GET_LAND'?'GET LAND':x.button==='RECHECK'?'CHECK AGAIN':x.button==='BUSY'?'Claiming':`CLAIM ${unknown(ui.amount)}`,kind:x.button==='RECHECK'?'recover':x.button==='GET_LAND'?'navigate':'review',state:x.button==='BUSY'?'BUSY':'ENABLED',sub:x.button==='CLAIM'?'You pay the small network fee':null};
 return <AccountSheet screen="DAILY TEST SKR" rows={[]} primary={a} onIntent={onIntent}><PkTag text="DEVNET" verb="STONE"/><h3>{x.headline}</h3><p>{x.line}</p></AccountSheet>;
}
/** The parent owns the onboarding/auth state and recovery. No wallet implementation is embedded here. */
export interface TitleConnection {lastPlayer:string|null;busy:'WALLET_CHECK'|'WALLET_SENDING'|'SOCIAL'|null}
/** When connect is supplied it owns the primary; its provisional labels are regression-pinned, not full parity. */
export function TitleScreen({connect,...p}:Omit<AccountSheetProps,'screen'> & {connect?:TitleConnection}){
 const stage=connect?titleConnectStage(connect.busy):null;
 const label=stage==='CHECK_WALLET'?'CHECK WALLET':stage==='SENDING'?'SENDING':titleConnectLabel(connect?.lastPlayer??null);
 const primary:AccountAction|null=connect?{id:'title.connect',label,state:connect.busy?'BUSY':'ENABLED',kind:'navigate'}:p.primary??null;
 return <AccountSheet {...p} screen="PIXEL KINGDOM WARS" primary={primary}/>;
}
export function TutorialCoach(p:Omit<AccountSheetProps,'screen'>){return <AccountSheet {...p} screen="YOUR KINGDOM"/>;}
export function LandDoneCard({receiptId,...p}:Omit<AccountSheetProps,'screen'> & {receiptId:string|null}){return receiptId?.trim()?<AccountSheet {...p} screen="YOUR LAND"/>:null;}
