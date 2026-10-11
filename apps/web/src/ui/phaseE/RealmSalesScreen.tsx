import {useEffect,useRef,useState} from 'react';
import {LAMPORTS_PER_SOL} from '@solana/web3.js';
import {PHASE_E_POLICY,fmtDur} from '@shardkeep/shared';
import {REALM_SALE_REALMS} from '@shardkeep/shared/realmSaleOfferApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {useRealmSales} from '../../lib/realmSales/useRealmSales';
import {useRealmSaleSelection} from '../../lib/realmSales/useRealmSaleSelection';
import {realmSaleIdentity} from '../../lib/realmSales/browser';
import {RealmSaleJournalStore,type RealmSaleOperation,type RealmSaleJournal} from '../../lib/realmSales/journal';
import type {RealmSaleSigningTrust} from '../../lib/realmSales/signing';
import type {RealmSaleFailureTrust} from '../../lib/realmSales/failure';
import {explorerUrl} from '../../lib/cluster';
import {Btn,Icon,COLORS as C} from '../primitives';
import {EconomyPanel} from './EconomyPanel';
const controls={minHeight:44,width:'100%'},selectStyle={...controls,boxSizing:'border-box' as const,display:'block',margin:'8px 0',padding:10,font:'inherit',color:C.text,background:C.surface,border:`2px solid ${C.border}`},P=PHASE_E_POLICY.seekerIsland;
function sol(value:string|number){const n=BigInt(value),scale=BigInt(LAMPORTS_PER_SOL),fraction=(n%scale).toString().padStart(String(LAMPORTS_PER_SOL).length-1,'0').replace(/0+$/,'');return `${n/scale}${fraction?`.${fraction}`:''}`;}
function time(seconds:string){const ms=BigInt(seconds)*1000n;return ms<=8640000000000000n?new Date(Number(ms)).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}):`${seconds} chain seconds`;}
const realmName=(index:number)=>REALM_SALE_REALMS[index]?.name??'Unavailable realm';
function refusalReason(code:string){return code==='INSUFFICIENT_SOL'?'Your wallet did not have enough SOL for the purchase and transaction costs.':code==='PHASE_E_DISABLED'?'New realm purchases were paused.':'The purchase request was invalid.';}
function Receipt({operation:op}:{operation:RealmSaleOperation}){
 const receipt=op.settlement?.value,failure=op.failure?.value;return <>
  {failure&&<section className="sk-equipment-card" aria-label="Failed purchase receipt"><strong>PURCHASE FAILED</strong><p>No permit was purchased. This attempt used no sale quota and charged no purchase price or account rent.</p><p>Network fee charged: {sol(failure.receipt.feeLamports)} SOL.</p><p>Your signed purchase and the game server’s bound failure receipt stay in history. Saving it does not start another purchase.</p></section>}
  {op.prepareRefusal&&op.refusalConfirmedAbsent&&<><strong>DECLINED REQUEST ARCHIVED</strong><p>{refusalReason(op.prepareRefusal.code)}</p>
   <p>The server’s saved preparation and purchase records were absent when this declined request was archived. No paid receipt was verified.</p>
   <p>Spot {op.request.spot+1} · {realmName(op.request.realm)}</p><details><summary>Original declined request</summary><p>Request: {op.request.idempotencyKey}</p></details></>}
  {receipt&&<><strong>PURCHASE RECEIPT VERIFIED</strong><p>Historical purchase receipt attested by the game server and bound to your original signed purchase. Current expedition access is checked separately.</p>
   <p>{realmName(receipt.purchase.realm)} · Coverage from {time(receipt.purchase.coverageStart)} to {time(receipt.purchase.expiresAt)}.</p>
   <p>Purchase debit: {sol(receipt.receipt.buyerNetPaymentLamports)} SOL · Network fee: {sol(receipt.receipt.feeLamports)} SOL · Account rent: {sol(receipt.receipt.actualRentLamports)} SOL.</p></>}
  {op.signed&&<details><summary>Transaction record</summary><p>Original transaction: <a href={explorerUrl('tx',op.signed.signature)} target="_blank" rel="noopener noreferrer">{op.signed.signature}</a></p></details>}
 </>;
}
function OriginalCosts({operation:op}:{operation:RealmSaleOperation}){
 const preparation=op.preparation;if(!preparation)return null;
 return <section aria-label="Original purchase costs"><div className="sk-economy-hero"><div><span>ORIGINAL WALLET DEBIT LIMIT</span><strong>{sol(preparation.quote.requiredLamports)} SOL</strong><span>Spot {op.request.spot+1} · {realmName(op.request.realm)}</span></div></div>
  <dl className="sk-economy-values"><div><dt>Purchase price</dt><dd>{sol(P.permitPriceLamports)} SOL</dd></div><div><dt>Purchase wallet debit</dt><dd>{sol(preparation.quote.paymentDebitLamports)} SOL</dd></div>
   <div><dt>Network fee limit</dt><dd>{sol(preparation.quote.feeLamports)} SOL</dd></div><div><dt>Account rent limit</dt><dd>{sol(preparation.quote.rentLamports)} SOL</dd></div></dl>
  <p>Original consent expires: {time(preparation.terms.validUntil)}. Actual fees and rent may be lower.</p>
  <details><summary>Original recipients and request</summary><p>Seller: {preparation.terms.seller}</p><p>Developer: {preparation.terms.developer}</p><p>Request: {op.request.idempotencyKey}</p><p>Original expiry (chain seconds): {preparation.terms.validUntil}</p></details>
 </section>;
}
export function RealmSalesScreen({actionsEnabled,onClose,trust=null,failureTrust=null}:{actionsEnabled:boolean;onClose():void;trust?:RealmSaleSigningTrust|null;failureTrust?:RealmSaleFailureTrust|null}):React.JSX.Element{
 const wallet=useApp(s=>s.wallet),screen=useApp(s=>s.screen),{state,actionsAllowed,run,dismiss}=useRealmSales(actionsEnabled,trust,failureTrust);
 const [spot,setSpot]=useState(0),[realm,setRealm]=useState(0),current=useRealmSaleSelection({spot,realm}),reviewNode=useRef<HTMLElement>(null);
 const [history,setHistory]=useState<{wallet:string;row:RealmSaleJournal|null;busy:boolean;error:string|null}|null>(null),lifetime=useRef({active:true,wallet,screen});
 lifetime.current.wallet=wallet;lifetime.current.screen=screen;
 useEffect(()=>{lifetime.current.active=true;return()=>{lifetime.current.active=false;};},[]);
 const op=state.journal?.operation,preparation=op?.preparation,disabled=!state.loaded||state.busy,offer=current.offer?.status==='available'?current.offer.offer:null;
 const refusalEligible=!!op?.prepareRefusal&&!preparation&&!op.signingStarted&&!op.signed&&!op.submitAttempted&&!op.settlementObserved&&!op.settlement&&!state.settlementHeld;
 const close=()=>{dismiss();onClose();};
 useEffect(()=>{if(state.review){reviewNode.current?.focus({preventScroll:true});reviewNode.current?.scrollIntoView?.({block:'start'});}},[state.review]);
 async function openHistory(key:string){
  if(!wallet||history?.wallet===wallet&&history.busy)return;const actor=wallet,view=screen,generation=authCookies.captureGeneration();
  const valid=()=>lifetime.current.active&&lifetime.current.wallet===actor&&lifetime.current.screen===view&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===actor;
  setHistory({wallet:actor,row:null,busy:true,error:null});const store=new RealmSaleJournalStore(realmSaleIdentity(actor),globalThis.indexedDB,'pkw-realm-sale-v1',failureTrust);
  try{const row=await store.archived(key);if(!row)throw Error('Saved purchase history is unavailable.');if(valid())setHistory({wallet:actor,row,busy:false,error:null});}
  catch(error){if(valid())setHistory({wallet:actor,row:null,busy:false,error:error instanceof Error?error.message:'Saved purchase history is unavailable.'});}
  finally{await store.close().catch(()=>undefined);}
 }
 const archived=history?.wallet===wallet?history:null;
 const offerPanel=<section className="sk-equipment-card" aria-label="Selected realm offer"><h3>Choose an expedition permit</h3>
   <div className="sk-economy-grid"><label>Selling spot<select aria-label="Selling spot" style={selectStyle} value={spot} disabled={state.busy} onChange={e=>setSpot(Number(e.target.value))}>{Array.from({length:P.totalSpots},(_,index)=><option key={index} value={index}>Spot {index+1}</option>)}</select></label>
   <label>Destination realm<select aria-label="Destination realm" style={selectStyle} value={realm} disabled={state.busy} onChange={e=>setRealm(Number(e.target.value))}>{REALM_SALE_REALMS.map(r=><option key={r.index} value={r.index}>{r.name}</option>)}</select></label></div>
   <div className="sk-economy-hero"><div><span>Spot {spot+1} · {realmName(realm)}</span><strong>{offer?`${sol(offer.priceLamports)} SOL`:current.loading?'Checking offer…':'Offer unavailable'}</strong><span>{offer?`${fmtDur(offer.durationSec)} realm permit`:current.loading?'Reading current price and quota':'No price or quota confirmed'}</span></div></div>
   {current.loading&&<p role="status">Checking the selected offer and coverage…</p>}
   {offer?<p>Estimated wallet debit: <strong>{sol(offer.requiredLamports)} SOL</strong>, including the network fee and account rent. This preview reserves no sale or price.</p>
    :current.loading?null:current.offer?.status==='blocked'?<p role="status">{({PAUSED:'New realm purchases are paused.',UNSOLD:'This spot has no operating seller.',REALM:'This spot cannot sell access to the selected realm.',NO_QUOTA:'This spot has no sales remaining for the observed UTC day.',INSUFFICIENT_SOL:'Your wallet has insufficient SOL for this purchase and transaction costs.'})[current.offer.reason]}</p>
    :<p>The selected offer is unavailable. No price or quota has been confirmed.</p>}
   {!op&&<Btn style={controls} disabled={disabled||!actionsAllowed||current.loading||!offer} onClick={()=>run(c=>c.begin(spot,realm))}>PREPARE PURCHASE</Btn>}
   <section aria-label="Observed realm coverage"><h3>Current permit coverage</h3>{current.coverage?.status==='observed'?<p>{current.coverage.coverage.active?`Paid coverage observed through ${time(current.coverage.coverage.expiresAt!)}.`:current.coverage.coverage.expiresAt===null?'No current paid coverage was observed for this realm.':`Paid coverage expired at ${time(current.coverage.coverage.expiresAt)}.`} Current expedition access is checked separately.</p>:<p>Current coverage is unavailable. This does not mean you have no permit.</p>}</section>
   {offer&&<details><summary>Current offer costs and selling spot</summary><p>Purchase price: {sol(offer.priceLamports)} SOL · Seller: {sol(offer.sellerLamports)} SOL · Developer: {sol(offer.developerLamports)} SOL.</p>
    <p>Current fee estimate: {sol(offer.feeLamports)} SOL · Account rent estimate: {sol(offer.rentLamports)} SOL · Wallet debit estimate: {sol(offer.requiredLamports)} SOL.</p>
    <p>{offer.quotaRemaining} sales remain for this spot in the observed UTC day. This is an observation, not a reserved sale.</p><p>Seller: {offer.seller}</p><p>Developer: {offer.developer}</p></details>}
   <Btn style={controls} variant="sec" disabled={current.loading} onClick={current.refresh}>REFRESH SELECTED OFFER</Btn>
  </section>;
 return <EconomyPanel title="Realm Access" eyebrow="SEEKER ISLAND · EXPEDITION PERMITS" icon={<Icon name="quest" size={30}/>} onClose={close} error={state.error??current.error}>
  <p>A paid permit covers one realm for {fmtDur(P.permitDurationSec)}. You still need an eligible base, vehicle and route. Home access and common starter routes remain free.</p>
  {!actionsAllowed&&<p role="status">New purchase actions are unavailable. Saved purchases can still be checked.</p>}
  {!state.loaded&&<p role="status">Loading saved purchases…</p>}
  {state.busy&&<p role="status">Checking your purchase or waiting for wallet approval…</p>}
  {!op&&offerPanel}
  {op&&<section className="sk-equipment-card" aria-label="Saved realm purchase">
   <h3>Original permit · {realmName(op.request.realm)}</h3><p>Saved selling spot {op.request.spot+1} · Prepare → review → wallet approval → submit → check receipt</p>
   {!op.settlement&&!op.failure&&(op.prepareRefusal?<><strong>PREPARATION DECLINED</strong><p>{refusalReason(op.prepareRefusal.code)}</p><p>{refusalEligible?'Check the original saved records before archiving this declined request. Archiving will not start another purchase.':'Saved purchase evidence conflicts with this declined request. Keep it for recovery.'}</p></>:<p>{state.settlementHeld?'A saved outcome needs verification. Keep this purchase for recovery.':op.signed?'Your exact signed purchase is saved. Payment is not confirmed.':op.signingStarted?'Wallet approval started. Keep the original purchase and check its saved outcome.':preparation?'Review the original SOL limits before wallet approval.':'The original preparation request is saved. Check for its result.'}</p>)}
   <Receipt operation={op}/>
   {preparation&&!state.review&&<details><summary>Original purchase limits & recipients</summary><OriginalCosts operation={op}/></details>}
   {state.review&&!op.prepareRefusal&&!op.signingStarted&&!op.signed&&!op.settlement&&<section className="sk-equipment-card sk-equipment-review" ref={reviewNode} tabIndex={-1} aria-label="Approve original purchase"><h3>Review the saved permit</h3><OriginalCosts operation={op}/><p>Approve only this reviewed purchase in your wallet. Approval saves a signature; submission is a separate action.</p><Btn style={controls} disabled={disabled||!actionsAllowed} onClick={()=>run(c=>c.sign())}>APPROVE IN WALLET</Btn><Btn style={controls} variant="sec" disabled={state.busy} onClick={dismiss}>CANCEL REVIEW</Btn></section>}
   {preparation&&!op.prepareRefusal&&!state.review&&!op.signingStarted&&!op.signed&&!op.settlement&&!state.settlementHeld&&<Btn style={controls} disabled={disabled||!actionsAllowed} onClick={()=>run(c=>c.review())}>REVIEW ORIGINAL PURCHASE</Btn>}
   {op.signed&&!op.submitAttempted&&!op.settlement&&!state.settlementHeld&&<Btn style={controls} disabled={disabled||!actionsAllowed} onClick={()=>run(c=>c.submit())}>SUBMIT SAVED PURCHASE</Btn>}
   <Btn style={controls} variant="sec" disabled={disabled} onClick={()=>run(c=>c.check())}>CHECK ORIGINAL PURCHASE</Btn>
   {refusalEligible&&<Btn style={controls} disabled={disabled} onClick={()=>run(c=>c.archiveRefusal())}>CHECK &amp; ARCHIVE DECLINED REQUEST</Btn>}
   {op.failure&&!op.settlementObserved&&<Btn style={controls} disabled={disabled} onClick={()=>run(c=>c.archiveFailed())}>CHECK &amp; SAVE FAILED RECEIPT</Btn>}
   {op.settlement&&!op.failureObserved&&<Btn style={controls} disabled={disabled} onClick={()=>run(c=>c.archive())}>ARCHIVE VERIFIED PURCHASE</Btn>}
  </section>}
  {op&&<details><summary>Explore other realm offers</summary>{offerPanel}</details>}
  {state.journal?.lastArchivedKey&&<Btn style={controls} variant="sec" disabled={archived?.busy??false} onClick={()=>void openHistory(state.journal!.lastArchivedKey!)}>OPEN PURCHASE HISTORY</Btn>}
  {archived&&<section className="sk-equipment-card" aria-label="Historical realm purchase">{archived.busy&&<p role="status">Reading one saved purchase…</p>}{archived.error&&<p role="alert">{archived.error}</p>}{archived.row?.operation&&<><Receipt operation={archived.row.operation}/>{archived.row.lastArchivedKey&&<Btn style={controls} variant="sec" onClick={()=>void openHistory(archived.row!.lastArchivedKey!)}>OLDER PURCHASE</Btn>}</>}</section>}
  <Btn style={controls} variant="sec" onClick={close}>CLOSE</Btn>
 </EconomyPanel>;
}
