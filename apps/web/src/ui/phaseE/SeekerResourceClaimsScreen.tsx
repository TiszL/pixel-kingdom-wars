import {useEffect,useRef} from 'react';
import {PHASE_E_RAW_RESOURCES} from '@shardkeep/shared/phaseEResources';
import {useSeekerResourceClaims} from '../../lib/seekerResourceClaims/useSeekerResourceClaims';
import {useApp} from '../../state/store';
import {Btn,fmtN} from '../primitives';
import {EconomyPanel} from './EconomyPanel';
const controls={minHeight:44,width:'100%'};
const termDate=(value:string)=>new Date(value).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});
export function SeekerResourceClaimsScreen({actionsEnabled,onClose}:{actionsEnabled:boolean;onClose:()=>void}):React.JSX.Element{
 const baseId=useApp(s=>s.selectedBaseId),directory=useApp(s=>s.baseDirectory),reviewNode=useRef<HTMLElement>(null);
 const {state,snapshot,refreshError,actionsAllowed,run,refresh,finish,dismiss}=useSeekerResourceClaims(actionsEnabled);
 const op=state.journal?.operation,receipt=op?.proof?.receipt,review=state.review,view=state.view;
 const baseName=(id:string)=>{const slot=directory?.bases.find(row=>row.id===id)?.slot;return slot?'Kingdom '+slot:id===baseId?'Selected kingdom':'Original kingdom';};
 const close=()=>{dismiss();onClose();};
 useEffect(()=>{if(review){reviewNode.current?.focus({preventScroll:true});reviewNode.current?.scrollIntoView?.({block:'start'});}},[review]);
 return <EconomyPanel title="Island Resource Shares" eyebrow="SEEKER ISLAND · WINNING SPOTS" onClose={close} error={state.error||refreshError}>
  <p>Collect the raw resources earned by your winning spots. Earlier terms remain yours after the spot changes hands. SHARDS are claimed separately.</p>
  {!state.loaded&&<p role="status">Loading earned shares and saved receipts…</p>}
  {state.busy&&<p role="status" aria-live="polite">Checking your shares and kingdom stock…</p>}
  {!actionsAllowed||view&&!view.claimsEnabled?<p role="status">New claims are paused. Saved receipts remain available.</p>:null}
  {!baseId?<p>Select a kingdom before reviewing a new claim.</p>:<p>Receiving stores: <strong>{baseName(baseId)}</strong></p>}
  {!op&&<section aria-label="Earned resource shares"><h3>Your winning spots</h3>
   {!view?<p>Earned shares unavailable.</p>:view.status==='unavailable'?<p>Resource history is temporarily unavailable. Refresh later; your earned shares remain saved.</p>:<>
    {!view.rows.length&&<p>No earned shares on this page.</p>}
    <div className="sk-economy-grid">{view.rows.map(row=><section className="sk-equipment-card" key={`${row.termId}:${row.spotId}:${row.resourceId}`}>
     <p className="sk-equipment-eyebrow">SPOT {row.spotId+1}</p><h3>{PHASE_E_RAW_RESOURCES[row.resourceId].name}</h3>
     <p>{termDate(row.startsAt)} – {termDate(row.endsAt)} · UTC</p>
     <div className="sk-economy-hero"><div><span>READY TO COLLECT</span><strong>{fmtN(row.dueQuantity)}</strong><span>{PHASE_E_RAW_RESOURCES[row.resourceId].name}</span></div></div>
     <p>Already claimed: {fmtN(row.claimedTotal)}</p>
     <Btn style={controls} disabled={state.busy||!!op||!actionsAllowed||!view.claimsEnabled||!baseId||row.dueQuantity==='0'} onClick={()=>baseId&&run(c=>c.beginClaim(baseId,row))}>REVIEW RESOURCE CLAIM</Btn>
     <details><summary>Term totals</summary><p>Cumulative entitlement: {fmtN(row.cumulativeTotal)}. Includes the {fmtN(row.claimedTotal)} already claimed; only {fmtN(row.dueQuantity)} remains available.</p><p>Term reference: {row.termId}</p></details>
    </section>)}</div>
    {view.nextCursor&&<Btn style={controls} variant="sec" disabled={state.busy} onClick={()=>run(c=>c.loadPage(view.nextCursor))}>NEXT TERMS</Btn>}
   </>}
  </section>}
  {op&&<section className="sk-equipment-card" aria-label="Saved resource claim"><h3>{receipt?'RESOURCE CLAIM COMPLETE':op.attemptRevision!==null?'CHECK ORIGINAL CLAIM':'SAVED CLAIM DRAFT'}</h3>
   <p>{PHASE_E_RAW_RESOURCES[op.command.request.resourceId].name} · Spot {op.command.request.spotId+1}</p>
   <p>Receiving stores: {baseName(op.command.request.baseId)}</p>
   {op.command.request.baseId!==baseId&&<p role="status">This claim belongs to another kingdom. Its destination stays fixed; select the original kingdom before reviewing or refreshing its stock.</p>}
   {receipt?<><div className="sk-economy-hero"><div><span>DELIVERED BY THIS CLAIM</span><strong>{fmtN(receipt.quantity)}</strong><span>{PHASE_E_RAW_RESOURCES[receipt.resourceId].name}</span></div></div><p>Delivered: {fmtN(receipt.quantity)} {PHASE_E_RAW_RESOURCES[receipt.resourceId].name}.</p><p>This receipt records a past delivery. Current stock is refreshed separately.</p>
    <Btn style={controls} disabled={state.busy} onClick={finish}>REFRESH STOCK & SAVE RECEIPT</Btn></>:<>
    {op.attemptRevision!==null?<p>The outcome is still unknown. Check the original receipt before making another claim.</p>:<>
     {review?<section ref={reviewNode} tabIndex={-1} className="sk-equipment-card sk-equipment-review" aria-label="Confirm resource claim"><h3>Review resource delivery</h3><p>Collect <strong>{fmtN(review.row.dueQuantity)} {PHASE_E_RAW_RESOURCES[review.row.resourceId].name}</strong> into {baseName(op.command.request.baseId)}.</p>
      <p>Spot {review.row.spotId+1} · {termDate(review.row.startsAt)} – {termDate(review.row.endsAt)} · UTC</p><p>{fmtN(review.row.claimedTotal)} already claimed from this term. This claim collects only the amount still available.</p>
      <Btn style={controls} disabled={state.busy||!actionsAllowed||op.command.request.baseId!==baseId||!view?.claimsEnabled} onClick={()=>run(c=>c.confirm())}>CONFIRM RESOURCE CLAIM</Btn>
      <Btn style={controls} variant="sec" onClick={dismiss}>CANCEL REVIEW</Btn></section>:<Btn style={controls} disabled={state.busy||!actionsAllowed||op.command.request.baseId!==baseId||!view?.claimsEnabled} onClick={()=>run(c=>c.reviewCommand())}>REVIEW SAVED CLAIM</Btn>}
     <Btn style={controls} variant="sec" disabled={state.busy} onClick={()=>run(c=>c.abandonDraft())}>ARCHIVE UNUSED DRAFT</Btn>
    </>}
   </>}
   <Btn style={controls} variant="sec" disabled={state.busy} onClick={()=>run(c=>c.checkOriginal())}>CHECK ORIGINAL RECEIPT</Btn>
   <details><summary>Original claim details</summary><p>Destination kingdom: {op.command.request.baseId}</p><p>Term: {op.command.request.termId}</p><p>Request: {op.command.request.idempotencyKey}</p>{receipt&&<p>Cumulative amount claimed: {fmtN(receipt.cumulativeTotal)}. Previously claimed: {fmtN(receipt.previousTotal)}.</p>}</details>
  </section>}
  {snapshot&&<details><summary>Current kingdom stock</summary><section aria-label="Current raw resource stock"><p>Current server observation for {baseId?baseName(baseId):'the selected kingdom'}. Claim receipts do not set these balances.</p>{snapshot.view.rawStock.map(row=><p key={row.resourceId}>{PHASE_E_RAW_RESOURCES[row.resourceId].name}: {fmtN(row.available)} available, {fmtN(row.reserved)} reserved</p>)}</section></details>}
  {!!state.journal?.archives.length&&<details><summary>Resource claim history ({state.journal.archives.length})</summary>{state.journal.archives.map(row=><section className="sk-equipment-card" key={row.operation.command.request.idempotencyKey}>
   <p>{PHASE_E_RAW_RESOURCES[row.operation.command.request.resourceId].name}: {row.operation.proof?.receipt?`${fmtN(row.operation.proof.receipt.quantity)} delivered`:'Unused draft'}</p><p>Spot {row.operation.command.request.spotId+1} · {baseName(row.operation.command.request.baseId)}</p>
   <Btn style={controls} variant="sec" disabled={state.busy} onClick={()=>run(c=>c.checkArchived(row.operation.command.request.idempotencyKey))}>CHECK SAVED RECEIPT</Btn></section>)}</details>}
  <Btn style={controls} variant="sec" disabled={state.busy} onClick={refresh}>REFRESH ALL TERMS & RECEIPTS</Btn>
  <Btn style={controls} variant="sec" onClick={close}>CLOSE RESOURCE SHARES</Btn>
 </EconomyPanel>;
}
