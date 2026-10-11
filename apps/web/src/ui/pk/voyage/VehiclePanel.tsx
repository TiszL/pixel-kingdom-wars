import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {vehicleOriginalDestination} from '@shardkeep/shared/vehicleClientApi';
import type {AdvancedExpeditionSnapshot} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {useApp} from '../../../state/store';
import {useVehicle} from '../../../lib/vehicles/useVehicle';
import {useStarterExpedition} from '../../../lib/starterExpedition/useStarterExpedition';
import {vehicleKey,terminal} from '../../../lib/vehicles/journal';
import type {BaseFeatureProps} from '../featureRegistry';
import type {SealUi} from '../types';
import {PkSeal} from '../Seal';
import {PkSecondaryButton} from '../Button';
import {formatUnits} from '../craft/marketLogic';
import {VoyageAdapterFrame,VoyageTerms,voyageName} from './VoyageAdapterFrame';
import {vehicleDeparture,vehicleOperationStage,vehicleServiceOptions,vehicleSnapshot,vehicleDepartureHold,vehicleReservationHeld,vehicleCanRetryOriginal} from './vehicleAdapter';
import VehicleCraftBody from './VehicleCraftBody';
import './VehiclePanel.css';

type Page='FLEET'|'CRAFT'|'INSTALL'|'SERVICE'|'HISTORY';
/** New body; unchanged owners retain keys, CAS journals, signing and transports. */
export default function VehiclePanel({session,onClose,actionsEnabled:hostActionsEnabled}:BaseFeatureProps):React.JSX.Element {
  // Required host capability; untyped omissions must never invoke a hook default of true.
  const actionsEnabled=hostActionsEnabled===true;
 const wallet=useApp(s=>s.wallet),baseId=useApp(s=>s.selectedBaseId),baseEpoch=useApp(s=>s.baseSelectionEpoch),base=useApp(s=>s.base);
 // No signing trust source has been granted. Never construct trust in a panel.
 const original=useVehicle(actionsEnabled,null),stockOwner=useStarterExpedition(false),{state}=original;
 const [page,setPage]=useState<Page>('FLEET'),[assetId,setAsset]=useState(''),[berthId,setBerth]=useState(''),[dispatchHeld,setDispatchHeld]=useState(false);
 const [review,setReview]=useState<{baseId:string;installationId:string;route:AdvancedExpeditionSnapshot}|null>(null);
 const busy=!state.loaded||state.busy,busyNow=useRef(state.busy);busyNow.current=state.busy;
 useLayoutEffect(()=>session.setDismissPolicy(request=>{if(busyNow.current){request.cancel?.();return;}setReview(null);original.dismiss();request.proceed();}),[session,original.dismiss]);
 useEffect(()=>{setReview(null);setAsset('');setBerth('');original.dismiss();},[wallet,baseId,baseEpoch]);
 useEffect(()=>{setReview(null);setDispatchHeld(false);},[original.actionsAllowed,state.routes]);
 const recover=(action:()=>void)=>{if(!busy)session.dispatch('recover',action);};
 const mutate=(action:()=>void)=>{if(!busy&&original.actionsAllowed){const accepted=session.dispatch('mutate',action);setDispatchHeld(!accepted);}};
 const snapshot=vehicleSnapshot(state,wallet,baseId,stockOwner.snapshot?.view??null),{fleet,routes,assets}=snapshot;
 const operations=[...(state.journal?.pending??[]),...(state.journal?.archive??[])],op=operations.find(value=>vehicleKey(value.command)===state.selected),active=!!op&&!!state.journal?.pending.includes(op);
 const pendingOperations=state.journal?.pending??[];
 const client=op?.original&&'kind'in op.original?op.original:null,expedition=op?.original&&!('kind'in op.original)?op.original:null,destination=client?vehicleOriginalDestination(client):null;
 const candidate=assets?.items.find(item=>item.identity.assetId===assetId)?.identity??null;
 const ownedBase=!!baseId&&base?.baseId===baseId&&base.player.wallet===wallet,berths=ownedBase?base.buildings.filter(b=>b.type==='berth'&&!b.underConstruction):[];
 const mayStart=!busy&&original.actionsAllowed;
 const installationHeld=vehicleReservationHeld(pendingOperations,{assetId,...(baseId?{baseId}:{}),berthId});
 const chosen=review?fleet?.vehicles.find(value=>value.installationId===review.installationId)??null:null;
 const reviewHold=vehicleDepartureHold(pendingOperations,fleet,baseId,chosen?.installationId??null);
 const departure=vehicleDeparture({snapshot,vehicle:chosen,route:review?.route??null,ordersAllowed:original.actionsAllowed,pending:reviewHold.kind==='CHECK',holdReason:reviewHold.kind==='HELD'?reviewHold.reason:null,checkReason:reviewHold.reason,busy,error:state.error});
 const burn=useMemo<SealUi|null>(()=>{
  if(!active||!op||!client||terminal(op)||op.signingStarted||op.signed||!client.record.preparation||!state.reviewed||state.reviewed.messageSha256!==client.record.preparation.messageSha256)return null;
  const nft=client.kind==='installation'?client.record.reservation.identity:client.record.intent.identity;
  return {title:'REVIEW ORIGINAL BURN',lines:[`${voyageName(nft.family)} · tier ${nft.tier}. The NFT is permanently burned when the original transaction completes.`,`Original kingdom ${destination!.baseId}; original berth ${destination!.berthId}. Completion cannot be redirected.`,`Current network fee only. This quote is not a payment or completion receipt.`,'Wallet approval and delivery remain unavailable until the original signing authority is bound.'],price:{currency:'SOL',amount:formatUnits(BigInt(state.reviewed.networkFeeLamports),9,9),status:'OK'},confirmLabel:'APPROVE BURN IN WALLET',armedAtMs:Date.now()};
 },[active,op,client,state.reviewed]);
 // Mandatory shared Seal predicate: held until a reviewed original live accessor
 // AND signing-trust binding exist. No render-derived boolean can replace them.
 const canConfirmBurn=()=>false;
 const selectedNode=useRef<HTMLElement>(null);useEffect(()=>{selectedNode.current?.focus();},[state.selected,review]);
 const refresh=()=>recover(()=>{original.run(controller=>baseId?controller.fleet(baseId):controller.load());stockOwner.refresh();});
 return <><VoyageAdapterFrame title="Advanced vehicles" status="Fleet, workshop & original outcomes" busy={busy} error={state.error??stockOwner.refreshError} onClose={onClose} onRefresh={refresh} onHistory={()=>setPage('HISTORY')}>
  <nav className="pk-voyage-adapter__actions" aria-label="Vehicle sections">{(['FLEET','CRAFT','INSTALL','SERVICE','HISTORY'] as const).map(tab=><PkSecondaryButton key={tab} label={tab} enabled={!busy} onClick={()=>setPage(tab)}/>)}</nav>
  {!original.actionsAllowed||dispatchHeld?<p role="status">New actions are paused. Original outcomes and actual returns remain available.</p>:null}
  <p role="status">Wallet approval and delivery are unavailable. You can still check saved outcomes.</p>
  {review?<section ref={selectedNode} tabIndex={-1} className="pk-voyage-adapter__review" aria-label="Departure review"><h3>Review this departure</h3><VoyageTerms route={review.route}/><p>Departure consumes the listed supplies. Uses change only after an actual return.</p>
   {departure.look.reason?<p>{departure.look.reason}</p>:null}<div className="pk-voyage-adapter__actions"><PkSecondaryButton label="CONFIRM DEPARTURE" enabled={departure.intent==='SEND'&&review.baseId===baseId} onClick={()=>{
    if(departure.intent!=='SEND'||review.baseId!==baseId)return;mutate(()=>{original.run(controller=>controller.begin('expedition',{baseId:review.baseId,installationId:review.installationId,routeId:review.route.routeId,policyVersion:review.route.policyVersion}));setReview(null);});
   }}/><PkSecondaryButton label="BACK TO ROUTES" enabled={!busy} onClick={()=>setReview(null)}/></div></section>:null}
  {operations.length?<section aria-label="Saved vehicle requests"><h3>Original requests</h3>{operations.map(value=><PkSecondaryButton key={vehicleKey(value.command)} label={`OPEN ${value.command.kind.toUpperCase()} · ${vehicleOperationStage(value)}`} enabled={!busy} onClick={()=>recover(()=>original.run(async controller=>controller.select(vehicleKey(value.command))))}/>)}</section>:null}
  {op?<section ref={review?undefined:selectedNode} tabIndex={-1} className="pk-voyage-adapter__review" aria-label="Original vehicle consent"><h3>{voyageName(op.command.kind)} · {vehicleOperationStage(op).toLowerCase()}</h3>
   {!op.original?<p>The original outcome is unknown. Check this saved request before trying it again.</p>:null}
   {client?<><p>The NFT is permanently burned when the original transaction completes. Preparing or signing does not complete installation or service.</p><p>Completion stays with kingdom {destination!.baseId} and its saved berth even after ownership changes. The original burn cannot be redirected or cancelled.</p>
    {client.kind==='service'?<p>{client.record.intent.state.operation==='upgrade'?'Upgrade keeps the existing use allowance; it does not restore uses.':'Restoration renews exhausted uses without changing tier.'}</p>:null}
    {client.burnReceipt?<p>Final network fee: {formatUnits(BigInt(client.burnReceipt.feeLamports),9,9)} SOL. Asset account refund: {formatUnits(BigInt(client.burnReceipt.assetRefundLamports),9,9)} SOL.</p>:null}</>:null}
   {expedition?.receipt?<><VoyageTerms route={expedition.receipt.route}/><p>{expedition.return?'Original return confirmed.':'Awaiting an actual server return. Elapsed time does not replenish uses.'}</p></>:null}
   <details><summary>Original identities</summary><p>Request: {op.command.key}</p>{destination?<p>Kingdom: {destination.baseId} · Berth: {destination.berthId}</p>:null}{client?<p>NFT: {client.kind==='installation'?client.record.reservation.identity.assetId:client.record.intent.identity.assetId}</p>:null}{expedition?.receipt?<p>Kingdom: {expedition.receipt.request.baseId} · Installation: {expedition.receipt.installationId}</p>:null}</details>
   {active&&vehicleCanRetryOriginal(op)&&op.command.kind==='expedition'?<p>RETRY checks the original outcome and, if still unknown, sends the same saved departure now.</p>:null}
   {active?<div className="pk-voyage-adapter__actions"><PkSecondaryButton label="CHECK ORIGINAL OUTCOME" enabled={!busy} onClick={()=>recover(()=>original.run(controller=>controller.recover()))}/>
    {vehicleCanRetryOriginal(op)?<PkSecondaryButton label="RETRY SAME SAVED REQUEST" enabled={!busy&&original.actionsAllowed&&!dispatchHeld} onClick={()=>mutate(()=>original.run(controller=>controller.recover(true)))}/>:null}
    {client&&!terminal(op)&&!op.observedTerminal?<>
     {!client.record.preparation?<PkSecondaryButton label="PREPARE ORIGINAL BURN" enabled={!busy&&original.actionsAllowed} onClick={()=>mutate(()=>original.run(controller=>controller.prepare()))}/>:null}
     {client.record.preparation&&!op.signingStarted&&!op.signed&&!state.reviewed?<PkSecondaryButton label="REVIEW ORIGINAL BURN" enabled={false} onClick={()=>undefined}/>:null}
     {op.signingStarted&&!op.signed?<p>Approval started. Keep the saved original and check its outcome; no replacement signature is requested.</p>:null}
     {op.signed?<PkSecondaryButton label="UPLOAD SAVED SIGNATURE" enabled={!busy} onClick={()=>recover(()=>original.run(controller=>controller.upload()))}/>:null}
     {client.record.signed?<PkSecondaryButton label="DELIVER SAVED TRANSACTION" enabled={false} onClick={()=>undefined}/>:null}
    </>:null}
    {terminal(op)&&op.observedTerminal?<PkSecondaryButton label="ARCHIVE VERIFIED ORIGINAL" enabled={!busy} onClick={()=>recover(()=>original.run(controller=>controller.archive()))}/>:null}
   </div>:null}
  </section>:null}
  {page==='CRAFT'?<VehicleCraftBody actionsEnabled={original.actionsAllowed} busy={busy} session={session} onInstall={()=>setPage('INSTALL')}/>:null}
  {page==='INSTALL'||page==='SERVICE'?<section aria-label="Vehicle NFT selection"><h3>Choose the original NFT</h3><p>{page==='INSTALL'?'Reserve a permanent installation at a completed berth. Reservation does not burn the NFT.':'Service requires the same family and current tier. Upgrade preserves uses; restoration requires exhaustion.'}</p>
   <PkSecondaryButton label="CHECK MY CANDIDATES" enabled={!busy&&original.actionsAllowed} onClick={()=>mutate(()=>original.run(controller=>controller.assets()))}/>
   {!assets?<p>Candidate ownership and family are unknown until the original server check.</p>:assets.items.length===0?<p>No candidates were returned on this page.</p>:assets.items.map((item,index)=><PkSecondaryButton key={item.identity.assetId} label={`${voyageName(item.identity.family).toUpperCase()} · TIER ${item.identity.tier} · CANDIDATE ${index+1}`} enabled={!busy} onClick={()=>setAsset(item.identity.assetId)}/>)}
   {assets?.nextCursor?<PkSecondaryButton label="NEXT CANDIDATE PAGE" enabled={!busy&&original.actionsAllowed} onClick={()=>mutate(()=>original.run(controller=>controller.assets(assets.nextCursor!)))}/>:null}
   <p>{candidate?`${voyageName(candidate.family)} · tier ${candidate.tier} selected.`:'Choose a verified candidate before reserving service.'}</p><details><summary>NFT identity and provenance</summary><p>Owner-attested registration is not mint provenance. The original controller checks ownership again.</p><label>NFT address<input aria-label="NFT address" value={assetId} disabled={busy} onChange={event=>setAsset(event.target.value)}/></label></details>
   {page==='INSTALL'?<><label>Completed berth<select aria-label="Completed berth" value={berthId} disabled={busy} onChange={event=>setBerth(event.target.value)}><option value="">Choose a berth</option>{berths.map((berth,index)=><option key={berth.id} value={berth.id}>Berth {index+1}</option>)}</select></label>
    {!ownedBase?<p>Refresh a kingdom you own before choosing its permanent berth.</p>:berths.length===0?<p>Complete a berth in this kingdom first.</p>:null}
    <PkSecondaryButton label="RESERVE ORIGINAL INSTALLATION" enabled={mayStart&&!installationHeld&&ownedBase&&!!assetId&&berths.some(berth=>berth.id===berthId)} onClick={()=>{if(mayStart&&!installationHeld&&ownedBase&&assetId&&berths.some(berth=>berth.id===berthId))mutate(()=>original.run(controller=>controller.begin('installation',{baseId,berthId,assetId})));}}/></>:null}
  </section>:null}
  {page==='FLEET'||page==='SERVICE'?<section aria-label="Current advanced fleet"><h3>{page==='SERVICE'?'Upgrade or restore uses':'Fleet and routes'}</h3><PkSecondaryButton label="COLLECT ACTUAL RETURNS" enabled={!busy&&!!baseId} onClick={()=>{if(baseId)recover(()=>original.run(controller=>controller.collect(baseId)));}}/>
   {!fleet?<p>Refresh the selected kingdom fleet and original stock to check availability.</p>:fleet.vehicles.length===0?<p>No advanced vehicle is installed in this kingdom.</p>:fleet.vehicles.map(vehicle=>{const service=vehicleServiceOptions(vehicle,candidate),serviceHeld=vehicleReservationHeld(pendingOperations,{assetId,installationId:vehicle.installationId});return <article key={vehicle.installationId}><h3>{voyageName(vehicle.family)} · tier {vehicle.tier}</h3><p>{vehicle.away?'At sea':vehicle.pendingService?'Service is being checked':`${vehicle.remainingUses} uses left`} · {BigInt(vehicle.completedTotal).toLocaleString('en-US')} lifetime returns.</p>
    {page==='SERVICE'?<><p>The matching NFT is permanently burned. Its original destination remains fixed.</p><div className="pk-voyage-adapter__actions"><PkSecondaryButton label="RESERVE UPGRADE" enabled={mayStart&&!serviceHeld&&service.upgrade} onClick={()=>{if(mayStart&&!serviceHeld&&service.upgrade)mutate(()=>original.run(controller=>controller.begin('service',{installationId:vehicle.installationId,assetId,operation:'upgrade'})));}}/><PkSecondaryButton label="RESERVE USE RESTORATION" enabled={mayStart&&!serviceHeld&&service.restore} onClick={()=>{if(mayStart&&!serviceHeld&&service.restore)mutate(()=>original.run(controller=>controller.begin('service',{installationId:vehicle.installationId,assetId,operation:'restore_uses'})));}}/></div></>:
     (routes?.items.find(item=>item.installationId===vehicle.installationId)?.previews??[]).map(route=>{const hold=vehicleDepartureHold(pendingOperations,fleet,baseId,vehicle.installationId),model=vehicleDeparture({snapshot,vehicle,route,ordersAllowed:original.actionsAllowed,pending:hold.kind==='CHECK',holdReason:hold.kind==='HELD'?hold.reason:null,checkReason:hold.reason,busy,error:state.error});return <section key={route.routeId}><VoyageTerms route={route}/>
      {model.look.reason?<p>{model.look.reason}</p>:null}<dl aria-label="Current departure stock">{model.supplies.map(supply=><div key={supply.resourceId}><dt>{voyageName(supply.resourceId)}</dt><dd>{supply.available===null?'unknown':BigInt(supply.available).toLocaleString('en-US')} / {BigInt(supply.quantity).toLocaleString('en-US')} available / needed</dd></div>)}</dl>
      <PkSecondaryButton label="REVIEW DEPARTURE" enabled={model.intent==='SEND'} onClick={()=>{if(baseId&&model.intent==='SEND')mutate(()=>setReview({baseId,installationId:vehicle.installationId,route}));}}/>
     </section>;})}
   </article>;})}
  </section>:null}
  {page==='HISTORY'?<section aria-label="Vehicle server history"><h3>Original activity</h3><PkSecondaryButton label="REFRESH ORIGINAL HISTORY" enabled={!busy} onClick={()=>recover(()=>original.run(controller=>controller.activity()))}/>
   {state.activity?.wallet===wallet?state.activity.items.map(item=><PkSecondaryButton key={`${item.kind}:${item.id}`} label={`${voyageName(item.kind).toUpperCase()} · ${item.status.toUpperCase()}`} enabled={!busy} onClick={()=>recover(()=>original.run(controller=>controller.open(item)))}/>):<p>Server activity is unavailable. Device originals remain above.</p>}
   {state.activity?.wallet===wallet&&state.activity.nextCursor?<PkSecondaryButton label="NEXT HISTORY PAGE" enabled={!busy} onClick={()=>recover(()=>original.run(controller=>controller.activity(state.activity!.nextCursor!)))}/>:null}
  </section>:null}
 </VoyageAdapterFrame><PkSeal ui={burn} canConfirm={canConfirmBurn} onConfirm={()=>{if(canConfirmBurn())mutate(()=>original.run(controller=>controller.sign()));}} onCancel={()=>original.dismiss()}/></>;
}
