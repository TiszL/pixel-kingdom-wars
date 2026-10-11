import {useEffect,useRef,type CSSProperties} from 'react';
import {useSeekerShardsClaims} from '../../lib/seekerShardsClaims/useSeekerShardsClaims';
import {useApp} from '../../state/store';
import {Btn,COLORS as C,Icon,ModalWrap,fmtN} from '../primitives';
import {hudChipStyle,hudStripStyle} from '../hudChrome';
import './seekerShardsClaims.css';

const termDate=(value:string)=>new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});
export function SeekerShardsClaimsScreen({actionsEnabled,onClose}:{actionsEnabled:boolean;onClose:()=>void}):React.JSX.Element{
 const baseId=useApp(s=>s.selectedBaseId),directory=useApp(s=>s.baseDirectory),dialog=useRef<HTMLDivElement>(null),reviewNode=useRef<HTMLElement>(null),alert=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{const previous=document.activeElement;dialog.current?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 const {state,snapshot,refreshError,actionsAllowed,run,refresh,finish,dismiss}=useSeekerShardsClaims(actionsEnabled);
 const op=state.journal?.operation,receipt=op?.proof?.receipt,review=state.review,view=state.view;
 const baseName=(id:string)=>{const slot=directory?.bases.find(row=>row.id===id)?.slot;return slot?'Kingdom '+slot:id===baseId?'Selected kingdom':'Original kingdom';};
 const close=()=>{dismiss();onClose();};
 useEffect(()=>{if(review){reviewNode.current?.focus({preventScroll:true});reviewNode.current?.scrollIntoView?.({block:'start'});}},[review]);
 useEffect(()=>{if(state.error||refreshError)alert.current?.focus();},[state.error,refreshError]);
 return <ModalWrap onBackdrop={close} width={620}><div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Seeker SHARDS shares" className="sk-shards-panel" style={Object.fromEntries(Object.entries(C).map(([key,value])=>[`--sk-${key}`,value])) as CSSProperties} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();close();}
  if(event.key==='Tab'){const controls=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),summary,a[href],[tabindex="0"]')].filter(node=>{const closed=node.closest('details:not([open])');return !closed||node===closed.querySelector(':scope > summary');});const first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();return;}if(event.shiftKey&&(document.activeElement===first||document.activeElement===event.currentTarget)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
 }}>
  <header className="sk-shards-banner" style={hudStripStyle()}>
   <span className="sk-shards-emblem" style={hudChipStyle()}><Icon name="shard" size={40}/></span>
   <div><span className="sk-shards-eyebrow">SEEKER ISLAND</span><h2>The Seeker’s Treasury</h2><p>Your winning spots. Your earned SHARDS.</p></div>
   <button type="button" className="interactive sk-shards-close" onClick={close} aria-label="Close SHARDS shares"><Icon name="close" size={22}/></button>
  </header>
  <div className="sk-shards-content">
   <p className="sk-shards-intro">Your share of Mine earnings belongs to you—even after a spot changes hands.</p>
   <div className="sk-shards-balance" style={hudChipStyle()} aria-label="Current SHARDS balance">
    <Icon name="shard" size={28}/><div style={{minWidth:0,overflowWrap:'anywhere'}}><span>{baseId?baseName(baseId):'SELECT A KINGDOM'}</span><strong>{snapshot?fmtN(snapshot.balances.shards):'—'} <small>SHARDS</small></strong></div>
    <span className="sk-shards-balance-note">{snapshot?'Current balance':'Awaiting refresh'}</span>
   </div>
   {(state.error||refreshError)&&<p ref={alert} tabIndex={-1} className="sk-shards-notice" role="alert">{state.error||refreshError}</p>}
   {!state.loaded&&<p role="status" className="sk-shards-notice">Loading earned shares and saved receipts…</p>}
   {state.busy&&<p role="status" aria-live="polite" className="sk-shards-notice">Checking your shares and kingdom balance…</p>}
   {!actionsAllowed||view&&!view.claimsEnabled?<p className="sk-shards-notice" role="status">New claims are paused. Saved receipts remain available.</p>:null}
   {!baseId&&<p className="sk-shards-notice">Select a kingdom before reviewing a new claim.</p>}
   <section aria-label="Earned SHARDS shares">
    <h3 className="sk-shards-section-title"><Icon name="trophy" size={20}/> YOUR WINNING SPOTS</h3>
    {!view?<p className="sk-shards-empty">Earned shares unavailable.</p>:view.status==='unavailable'?<p className="sk-shards-notice">SHARDS history is temporarily unavailable. Refresh later; your earned shares remain saved.</p>:<>
     {!view.rows.length&&<p className="sk-shards-empty">No earned shares on this page.</p>}
     <div className="sk-shards-spots">{view.rows.map(row=><section className="sk-shards-card" key={`${row.termId}:${row.spotId}`}>
      <div className="sk-shards-card-heading"><span>SPOT {row.spotId+1}</span><small>{termDate(row.startsAt)} – {termDate(row.endsAt)} · UTC</small></div>
      <div className="sk-shards-amount" style={{flexWrap:'wrap'}}><Icon name="shard" size={28}/><strong style={{minWidth:0,overflowWrap:'anywhere'}}>{fmtN(row.dueQuantity)}</strong><span>SHARDS<br/><small>ready to collect</small></span></div>
      <p>Already claimed <strong>{fmtN(row.claimedTotal)}</strong></p><details><summary style={{minHeight:44,display:'flex',alignItems:'center'}}>Term totals</summary><p>Cumulative entitlement: {fmtN(row.cumulativeTotal)} SHARDS. Includes earlier claims; only {fmtN(row.dueQuantity)} remains available.</p></details>
      <Btn fontSize={18} disabled={state.busy||!!op||!actionsAllowed||!view.claimsEnabled||!baseId||row.dueQuantity==='0'} onClick={()=>baseId&&run(c=>c.beginClaim(baseId,row))}>REVIEW SHARDS CLAIM</Btn>
     </section>)}</div>
     {view.nextCursor&&<Btn variant="sec" disabled={state.busy} onClick={()=>run(c=>c.loadPage(view.nextCursor))}>NEXT TERMS</Btn>}
    </>}
   </section>
   {op&&<section className="sk-shards-saved" aria-label="Saved SHARDS claim">
    <h3><Icon name={receipt?'shield':'quest'} size={24}/>{receipt?'SHARDS CLAIM COMPLETE':op.attemptRevision!==null?'CHECK ORIGINAL CLAIM':'SAVED CLAIM DRAFT'}</h3>
    <p>Spot {op.command.request.spotId+1} · {baseName(op.command.request.baseId)}</p>
    {op.command.request.baseId!==baseId&&<p role="status">This claim belongs to another kingdom. Its destination stays fixed; select the original kingdom before reviewing or refreshing its balance.</p>}
    <details className="sk-shards-reference"><summary style={{minHeight:44}}>Claim details</summary><p>Destination kingdom: {op.command.request.baseId}</p><p>Request: {op.command.request.idempotencyKey}</p></details>
    {receipt?<><p className="sk-shards-delivered">Delivered: {fmtN(receipt.quantity)} SHARDS.</p><p>This receipt records a past delivery. Your current balance is refreshed separately.</p>
     <Btn disabled={state.busy} onClick={finish}>REFRESH BALANCE & SAVE RECEIPT</Btn></>:<>
     {op.attemptRevision!==null?<p>The outcome is still unknown. Check the original receipt before making another claim.</p>:<>
      {review?<section ref={reviewNode} tabIndex={-1} className="sk-shards-confirm" aria-label="Confirm SHARDS claim"><h3>Review SHARDS delivery</h3><p>Collect <strong>{fmtN(review.row.dueQuantity)} SHARDS</strong> into {baseName(op.command.request.baseId)}.</p><p>Spot {review.row.spotId+1} · {termDate(review.row.startsAt)} – {termDate(review.row.endsAt)} · UTC</p><p>{fmtN(review.row.claimedTotal)} already claimed from this term. This claim collects only the amount still available.</p>
       <Btn disabled={state.busy||!actionsAllowed||op.command.request.baseId!==baseId||!view?.claimsEnabled} onClick={()=>run(c=>c.confirm())}>CONFIRM SHARDS CLAIM</Btn>
       <Btn variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn></section>:<Btn disabled={state.busy||!actionsAllowed||op.command.request.baseId!==baseId||!view?.claimsEnabled} onClick={()=>run(c=>c.reviewCommand())}>REVIEW SAVED CLAIM</Btn>}
      <Btn variant="sec" disabled={state.busy} onClick={()=>run(c=>c.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>
     </>}
    </>}
    <Btn variant="sec" disabled={state.busy} onClick={()=>run(c=>c.checkOriginal())}>CHECK ORIGINAL RECEIPT</Btn>
   </section>}
   {!!state.journal?.archives.length&&<details className="sk-shards-history"><summary>SHARDS claim history ({state.journal.archives.length})</summary>{state.journal.archives.map(row=><section key={row.operation.command.request.idempotencyKey}>
    <p>Spot {row.operation.command.request.spotId+1} · {row.operation.proof?.receipt?`${fmtN(row.operation.proof.receipt.quantity)} SHARDS delivered`:'Unused draft'}</p>
    <Btn variant="sec" disabled={state.busy} onClick={()=>run(c=>c.checkArchived(row.operation.command.request.idempotencyKey))}>CHECK SAVED RECEIPT</Btn></section>)}</details>}
   <footer className="sk-shards-footer"><Btn variant="sec" disabled={state.busy} aria-busy={state.busy} onClick={refresh}>{state.busy?'CHECKING TREASURY…':'REFRESH ALL TERMS & RECEIPTS'}</Btn><Btn variant="ghost" onClick={close} style={{color:C.text}}>CLOSE SHARDS SHARES</Btn></footer>
  </div>
 </div></ModalWrap>;
}
