import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {vehicleOriginalDestination} from '@shardkeep/shared/vehicleClientApi';
import {useApp} from '../../../state/store';
import {useVehicle} from '../../../lib/vehicles/useVehicle';
import type {VehicleController} from '../../../lib/vehicles/controller';
import {vehicleKey} from '../../../lib/vehicles/journal';
import type {BaseFeatureProps} from '../featureRegistry';
import {PkSecondaryButton} from '../Button';
import {VoyageAdapterFrame,voyageName} from './VoyageAdapterFrame';
import {vehicleOperationStage} from './vehicleAdapter';

/** 87ac7014: original reader only. Registration belongs to F2ab's host door. */
export default function VehicleRecoveryPanel({session,onClose}:BaseFeatureProps):React.JSX.Element {
  const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed);
  // Host capability can never enable an action in this recovery-only body.
  const original=useVehicle(false,null),{state}=original;
  const canRead=!!wallet&&authed,busy=canRead&&(!state.loaded||state.busy);
  const busyNow=useRef(busy);busyNow.current=busy;
  // Loading failure disables readers, but only an in-flight action blocks close.
  const dismissBusy=useRef(state.busy);dismissBusy.current=state.busy;
  const [notice,setNotice]=useState<string|null>(null);
  useLayoutEffect(()=>session.setDismissPolicy(request=>{
    if(dismissBusy.current){request.cancel?.();return;}
    original.dismiss();request.proceed();
  }),[session,original.dismiss]);
  const recover=(action:(controller:VehicleController)=>Promise<unknown>):void=>{
    const current=useApp.getState();
    if(busyNow.current||!wallet||!current.authed||current.wallet!==wallet)return;
    const accepted=session.dispatch('recover',()=>original.run(action));
    setNotice(accepted?null:'This vehicle panel is no longer current. Close it and reopen Vehicle history.');
  };
  const journal=canRead&&state.journal?.identity.wallet===wallet?state.journal:null;
  const activity=canRead&&state.activity?.wallet===wallet?state.activity:null;
  const operations=[...(journal?.pending??[]),...(journal?.archive??[])];
  const op=operations.find(value=>vehicleKey(value.command)===state.selected);
  const active=!!op&&!!journal?.pending.includes(op);
  const client=op?.original&&'kind'in op.original?op.original:null;
  const expedition=op?.original&&!('kind'in op.original)?op.original:null;
  const recordedBase=client?vehicleOriginalDestination(client).baseId
    :op?.command.request&&'baseId'in op.command.request?op.command.request.baseId
    :expedition?.receipt?.request.baseId??null;
  const selectedNode=useRef<HTMLElement>(null);
  useEffect(()=>{selectedNode.current?.focus();},[state.selected]);
  return <VoyageAdapterFrame title="Vehicle history" status="Saved requests & original outcomes"
    busy={busy} error={canRead?state.error:null} onClose={onClose}
    onRefresh={()=>recover(controller=>controller.load())}
    onHistory={()=>recover(controller=>controller.activity())}>
    <p role="status">Wallet approval and delivery are unavailable. You can still check saved outcomes.</p>
    {!canRead?<p role="status">Sign in to check your saved vehicle requests.</p>:null}
    {notice?<p role="status">{notice}</p>:null}
    {operations.length?<section aria-label="Saved vehicle requests"><h3>Saved originals on this device</h3>
      {operations.map(value=><PkSecondaryButton key={vehicleKey(value.command)}
        label={`OPEN ${value.command.kind.toUpperCase()} · ${vehicleOperationStage(value)}`} enabled={!busy}
        onClick={()=>recover(async controller=>controller.select(vehicleKey(value.command)))}/>)}
    </section>:canRead&&state.loaded?<p>No saved vehicle requests are available on this device.</p>:null}
    {op?<section ref={selectedNode} tabIndex={-1} className="pk-voyage-adapter__review" aria-label="Original vehicle outcome">
      <h3>{voyageName(op.command.kind)} · {vehicleOperationStage(op).toLowerCase()}</h3>
      {!op.original||expedition?.status==='unknown'?<p>The original outcome is unknown. Keep this saved request and check its outcome.</p>:null}
      {client?<p>Completion stays at the original kingdom and berth. Preparing or signing is not completion.</p>:null}
      {expedition?.return?<p>The original return is confirmed.</p>:expedition?.receipt?<p>Awaiting an actual server return. Elapsed time does not replenish uses.</p>:null}
      <details><summary>Original request</summary><p>Request: {op.command.key}</p>
        <p>Kingdom: {recordedBase??'unknown until the original outcome is checked'}</p>
        {client?<p>Berth: {vehicleOriginalDestination(client).berthId}</p>:null}
      </details>
      {active?<PkSecondaryButton label="CHECK ORIGINAL OUTCOME" enabled={!busy}
        onClick={()=>recover(controller=>controller.recover())}/>:null}
    </section>:null}
    {canRead?<section aria-label="Vehicle server history"><h3>Original server activity</h3>
      <PkSecondaryButton label="REFRESH ORIGINAL HISTORY" enabled={!busy} onClick={()=>recover(controller=>controller.activity())}/>
      {activity?activity.items.map(item=><PkSecondaryButton key={`${item.kind}:${item.id}`}
        label={`OPEN HISTORY ${item.kind.toUpperCase()} · ${item.status.toUpperCase()}`} enabled={!busy}
        onClick={()=>recover(controller=>controller.open(item))}/>):<p>Server history is unavailable. Saved device originals remain above.</p>}
      {activity?.nextCursor?<PkSecondaryButton label="NEXT HISTORY PAGE" enabled={!busy}
        onClick={()=>recover(controller=>controller.activity(activity.nextCursor!))}/>:null}
    </section>:null}
  </VoyageAdapterFrame>;
}
