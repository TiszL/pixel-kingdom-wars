import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {REALM_SALE_REALMS} from '@shardkeep/shared/realmSaleOfferApi';
import {useApp} from '../../../state/store';
import {useStarterExpedition} from '../../../lib/starterExpedition/useStarterExpedition';
import {usePaidStarterExpeditionView} from '../../../lib/paidStarterExpeditions/usePaidStarterExpeditionView';
import type {StarterExpeditionOperation} from '../../../lib/starterExpedition/journal';
import type {BaseFeatureProps} from '../featureRegistry';
import {PkSecondaryButton} from '../Button';
import {VoyageAdapterFrame,VoyageTerms} from './VoyageAdapterFrame';
import {expeditionReceiptStage,isPaidOperation,paidDepartureModel} from './paidExpeditionAdapter';

function OriginalDetails({operation}:{operation:StarterExpeditionOperation}):React.JSX.Element {
  const {command,proof}=operation;
  return <details><summary>Original expedition details</summary><p>Producing kingdom: {command.request.baseId}</p>
    <p>Vehicle: {command.installation.installationId}</p><p>Request: {command.request.idempotencyKey}</p><VoyageTerms route={command.route}/>
    {operation.refusal?<p>Original refusal: {operation.refusal.code}</p>:null}
    {proof?.status==='accepted'?<><p>Departed: {proof.receipt.departedAt} · Due: {proof.receipt.returnsAt}</p>
      <p>{proof.return?`Automatic return observed: ${proof.return.returnedAt}`:'The actual return has not yet been observed.'}</p>
      <p>Historical departure evidence does not grant access to another trip.</p></>:null}
  </details>;
}

/** Original starter journal and paid advisory read; no replacement transport or payment flow. */
export default function PaidExpeditionPanel({session,onClose,actionsEnabled:hostActionsEnabled}:BaseFeatureProps):React.JSX.Element {
  // Required host capability; untyped omissions must never invoke a hook default of true.
  const actionsEnabled=hostActionsEnabled===true;
  const wallet=useApp(state=>state.wallet),baseId=useApp(state=>state.selectedBaseId);
  const original=useStarterExpedition(actionsEnabled);
  const [selection,setSelection]=useState<{realm:number|null;epoch:number}>({realm:null,epoch:0}),[history,setHistory]=useState(false),[dispatchHeld,setDispatchHeld]=useState(false);
  useEffect(()=>{setDispatchHeld(false);},[original.actionsAllowed]);
  const selected=usePaidStarterExpeditionView(baseId,selection.realm,selection.epoch);
  const {state}=original,op=state.journal?.operation,busy=!state.loaded||state.busy;
  const busyNow=useRef(busy);busyNow.current=busy;
  useLayoutEffect(()=>session.setDismissPolicy(request=>{
    if(busyNow.current){request.cancel?.();return;}
    original.dismiss();request.proceed();
  }),[session,original.dismiss]);
  const reviewNode=useRef<HTMLElement>(null);
  const stage=op?expeditionReceiptStage(op):null,accepted=stage==='ACCEPTED'||stage==='RETURNED';
  const review=op&&isPaidOperation(op)&&stage==='DRAFT'?state.review:null;
  useEffect(()=>{reviewNode.current?.focus();},[review]);
  const read=(action:()=>void)=>{if(!busy)session.dispatch('recover',action);};
  const mutate=(action:()=>void)=>{if(!busy&&original.actionsAllowed){const accepted=session.dispatch('mutate',action);setDispatchHeld(!accepted);}};
  const model=paidDepartureModel(original.snapshot,selected.view,wallet,baseId,selection.realm,busy||selected.loading,!!op);
  const originalSelected=!!op&&op.command.request.baseId===baseId;
  const archives=state.journal?.archives.filter(archive=>isPaidOperation(archive.operation))??[];
  const refresh=()=>read(()=>{selected.refresh();original.refresh();});
  const stageText={DRAFT:'Saved unsent draft',CHECKING:'Original departure is being checked',ACCEPTED:'Original departure accepted',RETURNED:'Original return confirmed',REFUSED:'Original request declined'};
  return <VoyageAdapterFrame title="Paid realm expeditions" status="Paid access · no departure fee" busy={busy}
    error={state.error??original.refreshError??selected.error} onClose={onClose} onRefresh={refresh} onHistory={()=>setHistory(value=>!value)}>
    <p>No additional currency payment is required for this departure. Existing paid access is checked again when you depart.</p>
    {!original.actionsAllowed||dispatchHeld?<p role="status">New departures are paused. Original receipts remain available.</p>:null}
    {model.currentView?<section aria-label="Current kingdom fleet"><h3>{model.currentView.flight?'Starter at sea':model.currentView.installation?'Starter at home':'Install a starter at a completed berth'}</h3>
      {!model.currentView.lodgeCompletedAt?<p>Complete a Lodge before departing.</p>:null}
      <dl aria-label="Current kingdom resources">{model.currentView.rawStock.map(stock=><div key={stock.resourceId}><dt>{stock.resourceId.replaceAll('_',' ')}</dt><dd>{BigInt(stock.available).toLocaleString('en-US')}</dd></div>)}</dl>
      {model.currentView.flight?<><VoyageTerms route={model.currentView.flight.route}/><p>Awaiting the actual automatic return to its producing kingdom.</p></>:null}
    </section>:<p>Current kingdom stock and fleet are unavailable. Historical receipts do not show spendable stock.</p>}
    {!op?<section aria-label="New paid realm departure"><label>Destination realm<select aria-label="Expedition destination realm" value={selection.realm??''} disabled={busy} onChange={event=>{
      const realm=event.target.value===''?null:Number(event.target.value);
      read(()=>{original.dismiss();setSelection(old=>({realm,epoch:old.epoch+1}));});
    }}><option value="">Choose a destination</option>{REALM_SALE_REALMS.map(realm=><option key={realm.index} value={realm.index}>{realm.name}</option>)}</select></label>
      {model.route?<VoyageTerms route={model.route}/>:null}
      {model.coverage?.status==='covered'?<p>Coverage observed at {model.coverage.observedAt}. This preview does not reserve departure.</p>:null}
      {model.reason?<p role="status">{model.reason}</p>:null}
      <PkSecondaryButton label="REVIEW DEPARTURE" enabled={model.canReview&&original.actionsAllowed} onClick={()=>{
        if(model.canReview&&baseId&&selection.realm!==null)mutate(()=>original.run(controller=>controller.beginPaidDeparture(baseId,selection.realm!)));
      }}/>
    </section>:<section aria-label="Saved expedition request"><h3>{stageText[stage!]}</h3>
      <p>{stage==='CHECKING'?'This trip may have departed. Check its original receipt; it cannot be sent again.':'The original kingdom, vehicle and route remain saved.'}</p>
      {!isPaidOperation(op)?<p>A HOME or common departure uses this journal. Its original receipt remains available here; continue its review from Starter Expeditions.</p>:null}
      {!originalSelected?<p>Select the original kingdom to review. Receipt checks remain available.</p>:null}
      {review?<section className="pk-voyage-adapter__review" ref={reviewNode} tabIndex={-1} aria-label="Confirm paid departure"><VoyageTerms route={review.command.route}/>
        <p>The starter is unavailable until its automatic return. The departure cannot be cancelled. Cargo returns to its producing kingdom, including after transfer.</p>
        <p>No SOL, KEEP, Gems or SHARDS payment is added for this departure. Current access is checked again.</p>
        <div className="pk-voyage-adapter__actions"><PkSecondaryButton label="CONFIRM DEPARTURE" enabled={!busy&&original.actionsAllowed&&originalSelected} onClick={()=>mutate(()=>original.run(controller=>controller.confirm()))}/>
          <PkSecondaryButton label="CANCEL REVIEW" enabled={!busy} onClick={()=>read(original.dismiss)}/></div>
      </section>:null}
      <div className="pk-voyage-adapter__actions">
        {isPaidOperation(op)&&stage==='DRAFT'&&!review?<PkSecondaryButton label="REVIEW ORIGINAL" enabled={!busy&&original.actionsAllowed&&originalSelected} onClick={()=>mutate(()=>original.run(controller=>controller.reviewCommand()))}/>:null}
        <PkSecondaryButton label="CHECK ORIGINAL RECEIPT" enabled={!busy} onClick={()=>read(()=>original.run(controller=>controller.open()))}/>
        {op.attemptRevision===null&&!accepted?<PkSecondaryButton label="ARCHIVE UNUSED DRAFT" enabled={!busy} onClick={()=>read(()=>original.run(controller=>controller.abandonDraft()))}/>:null}
        {accepted?<PkSecondaryButton label="ARCHIVE ACCEPTED DEPARTURE" enabled={!busy} onClick={()=>read(original.finish)}/>:null}
        {stage==='REFUSED'?<PkSecondaryButton label="ARCHIVE DECLINED REQUEST" enabled={!busy} onClick={()=>read(()=>original.run(controller=>controller.archiveRefusal()))}/>:null}
      </div><OriginalDetails operation={op}/>
    </section>}
    {history?<section aria-label="Paid expedition history"><h3>Original expedition history</h3>{archives.length===0?<p>No paid departures are archived on this device.</p>:null}
      {archives.map(archive=><article key={archive.operation.command.request.idempotencyKey}><p>{archive.reason==='accepted'?'Historical accepted departure':archive.reason==='refused'?'Declined request':'Unused draft'}</p>
        <OriginalDetails operation={archive.operation}/>{archive.reason!=='accepted'&&archive.operation.proof?<p>Acceptance was recovered after archival. Earlier evidence remains saved.</p>:null}
        <PkSecondaryButton label={archive.operation.proof?'CHECK AUTOMATIC RETURN':'CHECK ARCHIVED RECEIPT'} enabled={!busy} onClick={()=>read(()=>original.run(controller=>controller.checkArchived(archive.operation.command.request.idempotencyKey)))}/>
      </article>)}
    </section>:null}
  </VoyageAdapterFrame>;
}
