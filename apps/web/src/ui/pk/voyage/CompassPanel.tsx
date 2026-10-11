import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {PHASE_E_ORDINARY_EQUIPMENT,PHASE_E_SURVEY_LENS} from '@shardkeep/shared';
import {fmtDur} from '../../../lib/duration';
import {PHASE_E_RAW_RESOURCE_IDS,type PhaseERawResourceId} from '@shardkeep/shared/phaseEResources';
import type {BaseFeatureProps} from '../featureRegistry';
import {useApp} from '../../../state/store';
import {bus} from '../../../lib/events';
import {useCompass} from '../../../lib/routeCompass/useCompass';
import {paidDestinations} from '../../../lib/routeCompass/paidDestinations';
import type {CompassCommand} from '../../../lib/routeCompass/journal';
import {PkSecondaryButton} from '../Button';
import {VoyageAdapterFrame,VoyageTerms,voyageName} from './VoyageAdapterFrame';
import {compassCraftCommand,compassCraftModel,compassOperationStage,compassSnapshot,compassStarterCommand} from './compassAdapter';

/** Original Compass/Lens controller, same durable keys and immutable quotes. */
export default function CompassPanel({session,onClose,actionsEnabled:hostActionsEnabled}:BaseFeatureProps):React.JSX.Element {
  // Required host capability; untyped omissions must never invoke a hook default of true.
  const actionsEnabled=hostActionsEnabled===true;
  const wallet=useApp(store=>store.wallet),baseId=useApp(store=>store.selectedBaseId),original=useCompass(actionsEnabled),{state}=original;
  const [page,setPage]=useState<'WORKSHOP'|'EXPEDITIONS'|'HISTORY'>('WORKSHOP'),[realm,setRealm]=useState<number|null>(null),[dispatchHeld,setDispatchHeld]=useState(false);
  useEffect(()=>{setDispatchHeld(false);},[original.actionsAllowed]);
  type Departure={command:Exclude<CompassCommand,{kind:'craft'}>;guard:()=>void};
  const departure=useRef<Departure|null>(null),pendingClose=useRef<Departure|null>(null);
  const busy=!state.loaded||state.busy,busyNow=useRef(busy);busyNow.current=busy;
  useLayoutEffect(()=>session.setDismissPolicy(request=>{if(busyNow.current){request.cancel?.();return;}departure.current=null;pendingClose.current=null;original.dismiss();request.proceed();}),[session,original.dismiss]);
  useEffect(()=>{setRealm(null);departure.current=null;pendingClose.current=null;},[baseId,state.fitting]);
  const read=(action:()=>void)=>{if(!busy)session.dispatch('recover',action);};
  const mutate=(action:()=>void)=>{if(!busy&&original.actionsAllowed){const accepted=session.dispatch('mutate',action);setDispatchHeld(!accepted);}};
  const current=compassSnapshot(state,wallet,baseId,realm),e=current.equipment,s=current.starter,f=current.fleet,r=current.routes,paid=current.paid;
  const operations=[...(state.journal?.operation?[state.journal.operation]:[]),...(state.journal?.archives.map(archive=>archive.operation)??[])];
  const op=operations.find(operation=>operation.command.request.idempotencyKey===state.selected),active=!!op&&state.journal?.operation===op;
  const stage=op?compassOperationStage(op):null,unresolved=!!state.journal?.operation&&!state.journal.operation.proof;
  // Only the original producer's fresh event can reveal the canvas. Historical
  // receipt reads never arm this; the host handles dismissal after the action idles.
  useEffect(()=>bus.on('fleet:journey',event=>{
    const armed=departure.current;if(!armed||event.kind!=='departure')return;const command=armed.command;
    if(event.baseId!==command.request.baseId||event.installationId!==command.request.installationId||event.expeditionId!==command.request.idempotencyKey
      ||(command.kind==='starter'?event.vehicle.family!=='starter':event.vehicle.family==='starter'||event.vehicle.family!==command.quote.family||event.vehicle.tier!==command.quote.tier))return;
    try{armed.guard();if(document.visibilityState==='hidden')return;}catch{departure.current=null;return;}
    departure.current=null;pendingClose.current=armed;
  }),[]);
  useEffect(()=>{
    const armed=pendingClose.current;if(busy||!armed)return;pendingClose.current=null;
    try{armed.guard();if(document.visibilityState==='hidden')return;}catch{return;}
    onClose();
  },[busy,state.selected,onClose]);
  const confirm=()=>{
    if(!op||!active||op.proof||op.refusal||baseId!==op.command.request.baseId)return;
    const command=op.command;
    mutate(()=>original.run(async controller=>{
      if(command.kind==='craft'){await controller.recover(command.request.idempotencyKey,true);return;}
      const current=controller.ports.capture(true,command.request.baseId);
      const armed:Departure={command,guard:()=>{current();if(controller.getSnapshot().selected!==command.request.idempotencyKey)throw Error('Equipment review changed.');}};
      departure.current=armed;
      try{await controller.recover(command.request.idempotencyKey,true);}finally{if(departure.current===armed)departure.current=null;}
    }));
  };

  const reviewNode=useRef<HTMLElement>(null);useEffect(()=>{reviewNode.current?.focus();},[state.selected]);
  const stock=e?.equipmentStock.find(item=>item.itemId===state.fitting.itemId),available=!!stock&&BigInt(stock.available)>0n;
  const destinations=paidDestinations(state.fitting),destination=destinations.find(item=>item.realm===realm);
  const mayStart=!busy&&original.actionsAllowed&&!unresolved;
  const starterReady=mayStart&&available&&!!s?.installation&&!!s.lodgeCompletedAt&&s.acceptingDepartures&&!s.flight;
  const begin=(command:CompassCommand|null)=>{if(command)original.run(controller=>controller.begin(command));};
  const starter=(route:NonNullable<typeof s>['routes'][number]|NonNullable<typeof paid>['route'])=>{
    if(s&&starterReady)mutate(()=>begin(compassStarterCommand(s,route,state.fitting,crypto.randomUUID())));
  };
  return <VoyageAdapterFrame title="Expedition equipment" status="Workshop & fleet" busy={busy} error={state.error??state.routeError}
    onClose={onClose} onRefresh={()=>read(()=>original.run(controller=>controller.load(baseId??undefined)))} onHistory={()=>setPage('HISTORY')}>
    <nav className="pk-voyage-adapter__actions" aria-label="Equipment sections">{(['WORKSHOP','EXPEDITIONS','HISTORY'] as const).map(tab=><PkSecondaryButton key={tab} label={tab} enabled={!busy} onClick={()=>setPage(tab)}/>)}</nav>
    {!original.actionsAllowed||dispatchHeld?<p role="status">New actions are paused. Original outcomes remain available.</p>:null}
    {op?<section ref={reviewNode} tabIndex={-1} className="pk-voyage-adapter__review" aria-label="Saved equipment consent"><h3>{stage==='COMPLETED'?'Original outcome confirmed':stage==='ACCEPTED'?'Original request accepted':stage==='REFUSED'?'Original request declined':stage==='CHECKING'?'The original outcome is being checked':'Review the saved request'}</h3>
      {op.command.kind==='craft'?<><p>{op.command.quote.inputs.map(input=>`${input.quantity} ${voyageName(input.itemId)}`).join(' + ')} → {op.command.quote.output.quantity} {voyageName(op.command.quote.output.itemId)}</p><p>{fmtDur(op.command.quote.durationSec)}</p></>:<VoyageTerms route={op.command.quote}/>}
      <p>The equipment and returned cargo stay with the original kingdom, including after transfer.</p>
      {op.refusal?<p>Original refusal: {op.refusal.code}</p>:null}
      {active&&!op.proof&&!op.refusal?<PkSecondaryButton label={op.attemptRevision===null?(op.command.kind==='craft'?'CONFIRM CRAFT':'CONFIRM FITTED DEPARTURE'):'RETRY SAME SAVED REQUEST'} enabled={!busy&&original.actionsAllowed&&baseId===op.command.request.baseId}
        onClick={confirm}/>:null}
      <div className="pk-voyage-adapter__actions"><PkSecondaryButton label="CHECK ORIGINAL OUTCOME" enabled={!busy} onClick={()=>read(()=>original.run(controller=>controller.recover(op.command.request.idempotencyKey)))}/>
        {active&&!op.proof&&(op.attemptRevision===null||op.refusal)?<PkSecondaryButton label="CLOSE UNUSED REQUEST" enabled={!busy} onClick={()=>read(()=>original.run(controller=>controller.abandon(op.command.request.idempotencyKey)))}/>:null}
      </div><details><summary>Original identities</summary><p>Kingdom: {op.command.request.baseId}</p><p>Request: {op.command.request.idempotencyKey}</p></details>
    </section>:null}
    {page==='WORKSHOP'?<section aria-label="Equipment workshop"><p>One reusable tool per journey. Current kingdom stock is separate from historical receipts.</p>
      {!e?<p>Refresh to check this kingdom's equipment and crafting stock.</p>:e.recipes.map(recipe=>{
        const model=compassCraftModel(e,recipe);
        return <article key={recipe.recipeId}><h3>{voyageName(recipe.output.itemId)}</h3><p>{recipe.output.itemId==='survey_lens'?'Bring home a second material.':'Return sooner with lighter cargo.'}</p>
          <p>{model.stock?.available??'…'} ready · {model.stock?.reserved??'…'} travelling · {model.stock?.pendingOutput??'…'} crafting</p>
          <dl>{model.inputs.map(input=><div key={input.itemId}><dt>{voyageName(input.itemId)}</dt><dd>{input.have===null?'…':input.have.toLocaleString('en-US')} / {input.need.toLocaleString('en-US')}</dd></div>)}</dl>
          <p>{fmtDur(recipe.durationSec)} · makes {recipe.output.quantity}</p>{model.reason?<p>{model.reason}</p>:null}
          <PkSecondaryButton label={`REVIEW ${voyageName(recipe.output.itemId).toUpperCase()}`} enabled={mayStart&&model.canCraft} onClick={()=>{if(model.canCraft&&mayStart)mutate(()=>begin(compassCraftCommand(e,recipe.recipeId,crypto.randomUUID())));}}/>
        </article>;
      })}
      {e?.pendingJobs.map(job=><p key={job.jobId}>Crafting {voyageName(job.recipe.output.itemId)} · due {job.readyAt}. Refresh for the actual completion.</p>)}
    </section>:null}
    {page==='EXPEDITIONS'?<section aria-label="Fitted expeditions"><div className="pk-voyage-adapter__actions">
      <PkSecondaryButton label="ROUTE COMPASS" enabled={!busy&&!unresolved} onClick={()=>read(()=>original.chooseFitting({itemId:'route_compass',policyVersion:PHASE_E_ORDINARY_EQUIPMENT.policyVersion}))}/>
      <PkSecondaryButton label="SURVEY LENS" enabled={!busy&&!unresolved} onClick={()=>read(()=>original.chooseFitting({itemId:'survey_lens',policyVersion:PHASE_E_SURVEY_LENS.policyVersion,resourceId:PHASE_E_RAW_RESOURCE_IDS[0]}))}/>
    </div>{state.fitting.itemId==='survey_lens'?<label>Second material<select aria-label="Second material" disabled={busy||unresolved} value={state.fitting.resourceId} onChange={event=>{
      const resourceId=event.target.value as PhaseERawResourceId;if(PHASE_E_RAW_RESOURCE_IDS.includes(resourceId))read(()=>original.chooseFitting({itemId:'survey_lens',policyVersion:PHASE_E_SURVEY_LENS.policyVersion,resourceId}));
    }}>{PHASE_E_RAW_RESOURCE_IDS.map(id=><option key={id} value={id}>{voyageName(id)}</option>)}</select></label>:null}
      {!e?<p>Equipment stock is unknown. Refresh to check the selected fitting.</p>:!available?<p>No selected fitting is currently available. Craft one or collect its actual return.</p>:null}
      <h3>Starter boat</h3>{s?.flight?<p>The starter is away. Refresh for its actual automatic return.</p>:null}
      {s?.routes.map(route=><article key={route.routeId}><VoyageTerms route={route}/><PkSecondaryButton label="REVIEW FITTED DEPARTURE" enabled={starterReady} onClick={()=>starter(route)}/></article>)}
      <label>Paid destination<select aria-label="Paid destination" value={realm??''} disabled={busy||unresolved} onChange={event=>{const value=event.target.value;read(()=>{original.clearPaidPreview();setRealm(value===''?null:Number(value));});}}><option value="">Choose a destination</option>{destinations.map(item=><option key={item.realmId} value={item.realm} disabled={!item.compatible}>{voyageName(item.realmId)}{item.compatible?'':' · already carries this material'}</option>)}</select></label>
      <PkSecondaryButton label="CHECK DESTINATION" enabled={!busy&&!!baseId&&!!destination?.compatible} onClick={()=>{if(baseId&&realm!==null&&destination?.compatible)read(()=>original.run(controller=>controller.paid(baseId,realm)));}}/>
      {paid?<article><VoyageTerms route={paid.route}/><p>{paid.coverage.status==='covered'?'Current destination access is active.':'Current destination access is unavailable.'} No additional departure currency payment.</p><PkSecondaryButton label="REVIEW PAID FITTED DEPARTURE" enabled={starterReady&&paid.acceptingDepartures&&paid.coverage.status==='covered'} onClick={()=>{if(paid.coverage.status==='covered'&&paid.acceptingDepartures)starter(paid.route);}}/></article>:null}
      <h3>Advanced fleet</h3><PkSecondaryButton label="COLLECT ACTUAL RETURNS" enabled={!busy&&!!baseId} onClick={()=>{if(baseId)read(()=>original.run(controller=>controller.collect(baseId)));}}/>
      {f?.vehicles.map(vehicle=><article key={vehicle.installationId}><h3>{voyageName(vehicle.family)} · tier {vehicle.tier}</h3><p>{vehicle.away?'At sea':vehicle.pendingService?'Service pending':`${vehicle.remainingUses} uses left`}</p>
        {r?.items.find(item=>item.installationId===vehicle.installationId)?.previews.map(route=><div key={route.routeId}><VoyageTerms route={route}/><PkSecondaryButton label="REVIEW ADVANCED DEPARTURE" enabled={mayStart&&available&&f.acceptingNewActions&&!vehicle.away&&!vehicle.pendingService&&vehicle.remainingUses>0} onClick={()=>{
          if(!baseId||!mayStart||!available||!f.acceptingNewActions||vehicle.away||vehicle.pendingService||vehicle.remainingUses===0)return;
          mutate(()=>begin({kind:'advanced',request:{idempotencyKey:crypto.randomUUID(),baseId,installationId:vehicle.installationId,routeId:route.routeId,policyVersion:route.policyVersion,fitting:state.fitting},quote:route}));
        }}/></div>)}
      </article>)}
    </section>:null}
    {page==='HISTORY'?<section aria-label="Saved equipment history"><h3>Saved journeys and crafting</h3>{operations.length===0?<p>No requests are saved on this device.</p>:null}
      {operations.map(operation=><article key={operation.command.request.idempotencyKey}><p>{operation.command.kind==='craft'?voyageName(operation.command.quote.output.itemId):voyageName(operation.command.quote.routeId)} · {compassOperationStage(operation).toLowerCase()}</p>
        <PkSecondaryButton label="OPEN ORIGINAL" enabled={!busy} onClick={()=>read(()=>original.run(controller=>controller.select(operation.command.request.idempotencyKey)))}/>
      </article>)}
    </section>:null}
  </VoyageAdapterFrame>;
}
