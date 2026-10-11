/** @vitest-environment happy-dom */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FleetJourneyEvent} from '@shardkeep/shared/fleetJourneyPresentation';
import {VoyageTerms,voyageName} from './VoyageAdapterFrame';
import {fmtDur,PHASE_E_VEHICLES} from '@shardkeep/shared';
import compassVector from '../../../../../../packages/shared/testFixtures/ordinaryEquipment.json';
import {StarterExpeditionViewSchema} from '@shardkeep/shared/starterExpeditionApi';
import {VehicleRoutesSchema} from '@shardkeep/shared/vehicleClientApi';
import {applyEquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import vector from '../../../../../../packages/shared/testFixtures/surveyLens.json';
import {OrdinaryEquipmentViewV2Schema} from '@shardkeep/shared/ordinaryEquipmentApi';
import {useApp} from '../../../state/store';
import {useCompass} from '../../../lib/routeCompass/useCompass';
import {EMPTY} from '../../../lib/routeCompass/controller';
import {parseCompassCommand} from '../../../lib/routeCompass/journal';
import type {BaseFeatureProps} from '../featureRegistry';
import CompassPanel from './CompassPanel';
const events=vi.hoisted(()=>({journey:null as null|((event:FleetJourneyEvent)=>void)}));
vi.mock('../../../lib/events',()=>({bus:{on:(_kind:string,listener:(event:FleetJourneyEvent)=>void)=>{events.journey=listener;return()=>{events.journey=null;};},emit:vi.fn()}}));
vi.mock('../../../lib/routeCompass/useCompass',()=>({useCompass:vi.fn()}));
let host:HTMLDivElement,root:Root,props:BaseFeatureProps,hook:ReturnType<typeof useCompass>;
let controller:{begin:ReturnType<typeof vi.fn>;recover:ReturnType<typeof vi.fn>;load:ReturnType<typeof vi.fn>;collect:ReturnType<typeof vi.fn>;ports:{capture:ReturnType<typeof vi.fn>};getSnapshot:ReturnType<typeof vi.fn>};
const render=()=>act(async()=>root.render(<CompassPanel {...props}/>));
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);
  useApp.getState().setAuth(vector.view.wallet,true);useApp.getState().setSelectedBaseId(vector.view.baseId,false);
  controller={begin:vi.fn(async()=>undefined),recover:vi.fn(async()=>undefined),load:vi.fn(async()=>undefined),collect:vi.fn(async()=>undefined),ports:{capture:vi.fn(()=>()=>undefined)},getSnapshot:vi.fn(()=>hook.state)};
  const equipment=OrdinaryEquipmentViewV2Schema.parse(vector.view);
  equipment.pendingJobs=[];equipment.equipmentStock=equipment.equipmentStock.map(stock=>({...stock,pendingOutput:'0'}));
  equipment.craftingStock=equipment.craftingStock.map(stock=>{
    const have=equipment.recipes.flatMap(recipe=>recipe.inputs).filter(input=>input.itemId===stock.itemId).reduce((sum,input)=>sum+BigInt(input.quantity),0n);
    // Protected crafting stock has available/pendingOutput, not raw reserved/total.
    return {...stock,available:String(have)};
  });
  hook={state:{...EMPTY,loaded:true,equipment},actionsAllowed:true,run:vi.fn(action=>{void action(controller as never);}),chooseFitting:vi.fn(),clearPaidPreview:vi.fn(),dismiss:vi.fn()};
  vi.mocked(useCompass).mockImplementation(enabled=>({...hook,actionsAllowed:enabled&&hook.actionsAllowed}));
  props={actionsEnabled:true,panel:{kind:'voyage',featureId:'voyage.compass'},onClose:vi.fn(),session:{dispatch:vi.fn((_kind,action)=>{action();return true;}),setDismissPolicy:vi.fn(()=>()=>undefined)}};
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('mount and refresh never craft or confirm',async()=>{await render();expect(controller.begin).not.toHaveBeenCalled();expect(controller.recover).not.toHaveBeenCalled();await act(async()=>button('REFRESH').click());expect(controller.load).toHaveBeenCalled();expect(controller.begin).not.toHaveBeenCalled();});
it('review saves the exact visible recipe and confirmation reuses its saved key',async()=>{
  await render();await act(async()=>button('REVIEW ROUTE COMPASS').click());expect(controller.begin).toHaveBeenCalledOnce();expect(controller.recover).not.toHaveBeenCalled();
  const command=parseCompassCommand(controller.begin.mock.calls[0]![0]);const identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:vector.view.wallet};
  hook.state={...hook.state,selected:command.request.idempotencyKey,journal:{version:1,identity,revision:1,archives:[],operation:{command,attemptRevision:null,proof:null,refusal:null}}};
  await render();await act(async()=>button('CONFIRM CRAFT').click());expect(controller.recover).toHaveBeenCalledWith(command.request.idempotencyKey,true);expect(controller.begin).toHaveBeenCalledOnce();
});
it('saved uncertain outcomes keep GET recovery reachable while new actions are paused',async()=>{
  const quote=hook.state.equipment!.recipes[0]!,key='00000000-0000-4000-8000-000000000099';
  const command=parseCompassCommand({kind:'craft',request:{idempotencyKey:key,baseId:vector.view.baseId,recipeId:quote.recipeId,recipeVersion:quote.recipeVersion,quantity:quote.quantity},quote});
  hook.actionsAllowed=false;hook.state={...hook.state,selected:key,journal:{version:1,identity:{origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet:vector.view.wallet},revision:2,archives:[],operation:{command,attemptRevision:2,proof:null,refusal:null}}};
  await render();await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledWith(key);expect(controller.begin).not.toHaveBeenCalled();expect(button('CLOSE UNUSED REQUEST')).toBeUndefined();
});
it('a denied panel session prevents original-controller invocation',async()=>{props.session.dispatch=vi.fn(()=>false);await render();await act(async()=>button('REVIEW ROUTE COMPASS').click());expect(controller.begin).not.toHaveBeenCalled();});
it('busy dismissal cannot invoke the host continuation',async()=>{
  hook.state={...hook.state,busy:true};await render();const proceed=vi.fn(()=>true),cancel=vi.fn();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed,cancel});expect(cancel).toHaveBeenCalledOnce();expect(proceed).not.toHaveBeenCalled();
});

it('uses the live host capability and fails closed for an older host without it',async()=>{
  await render();expect(useCompass).toHaveBeenLastCalledWith(true);
  props={...props,actionsEnabled:false};await render();expect(useCompass).toHaveBeenLastCalledWith(false);expect(button('REVIEW ROUTE COMPASS').disabled).toBe(true);
  const missingCapability={panel:props.panel,onClose:props.onClose,session:props.session};
  await act(async()=>{
    // @ts-expect-error H-2 requires the live host capability; deliberately probe an untyped omission.
    root.render(<CompassPanel {...missingCapability}/>);
  });expect(useCompass).toHaveBeenLastCalledWith(false);
});
it('uses shared duration labels for original recipe review',async()=>{
  await render();expect(host.textContent).toContain(fmtDur(hook.state.equipment!.recipes[0]!.durationSec));expect(host.textContent).not.toContain('seconds');
});
it('keeps review and confirmation as mutate while receipt recovery remains recover',async()=>{
  props.session.dispatch=vi.fn((kind,action)=>{if(kind==='mutate')return false;action();return true;});await render();
  await act(async()=>button('REVIEW ROUTE COMPASS').click());expect(controller.begin).not.toHaveBeenCalled();expect(host.textContent).toContain('New actions are paused');
  const quote=hook.state.equipment!.recipes[0]!,key='00000000-0000-4000-8000-000000000099';
  const command=parseCompassCommand({kind:'craft',request:{idempotencyKey:key,baseId:vector.view.baseId,recipeId:quote.recipeId,recipeVersion:quote.recipeVersion,quantity:quote.quantity},quote});
  hook.state={...hook.state,selected:key,journal:{version:1,identity:{origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet:vector.view.wallet},revision:1,archives:[],operation:{command,attemptRevision:null,proof:null,refusal:null}}};
  await render();await act(async()=>button('CONFIRM CRAFT').click());expect(controller.recover).not.toHaveBeenCalled();
  await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith(key);
});

const fitted=()=>parseCompassCommand({kind:'starter',request:vector.starterEnvelope.receipt.request,quote:vector.starterEnvelope.receipt.route});
const saveFitted=()=>{const command=fitted();hook.state={...hook.state,selected:command.request.idempotencyKey,journal:{version:1,identity:{origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet:vector.view.wallet},revision:1,archives:[],operation:{command,attemptRevision:null,proof:null,refusal:null}}};return command;};
const journey=():FleetJourneyEvent=>({version:1,kind:'departure',baseId:vector.view.baseId,berthId:vector.starterView.installation!.berthId,installationId:vector.starterEnvelope.receipt.installationId,expeditionId:vector.starterEnvelope.receipt.request.idempotencyKey,at:vector.starterEnvelope.receipt.departedAt,vehicle:{family:'starter'},wake:{state:'legacy',visual:null}});
it('only a freshly confirmed matching departure closes after the original action becomes idle',async()=>{
  saveFitted();let finish!:()=>void;controller.recover.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();
  await act(async()=>button('CONFIRM FITTED DEPARTURE').click());hook.state={...hook.state,busy:true};await render();
  await act(async()=>events.journey?.({...journey(),installationId:'different'}));expect(props.onClose).not.toHaveBeenCalled();
  await act(async()=>events.journey?.(journey()));expect(props.onClose).not.toHaveBeenCalled();
  await act(async()=>finish());hook.state={...hook.state,busy:false};await render();expect(props.onClose).toHaveBeenCalledOnce();
  await act(async()=>events.journey?.(journey()));expect(props.onClose).toHaveBeenCalledOnce();
});
it('receipt recovery never arms journey dismissal even across a complete busy cycle',async()=>{
  saveFitted();let finish!:()=>void;controller.recover.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();
  await act(async()=>button('CHECK ORIGINAL OUTCOME').click());hook.state={...hook.state,busy:true};await render();await act(async()=>events.journey?.(journey()));
  await act(async()=>finish());hook.state={...hook.state,busy:false};await render();expect(props.onClose).not.toHaveBeenCalled();expect(controller.ports.capture).not.toHaveBeenCalled();
});
it('a stale original guard cannot close after a confirmed action completes',async()=>{
  saveFitted();controller.ports.capture.mockReturnValue(()=>{throw new Error('base changed');});
  let finish!:()=>void;controller.recover.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();await act(async()=>button('CONFIRM FITTED DEPARTURE').click());
  hook.state={...hook.state,busy:true};await render();await act(async()=>events.journey?.(journey()));await act(async()=>finish());hook.state={...hook.state,busy:false};await render();expect(props.onClose).not.toHaveBeenCalled();
});
it('a mismatched-only departure never closes at idle',async()=>{
  saveFitted();let finish!:()=>void;controller.recover.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();await act(async()=>button('CONFIRM FITTED DEPARTURE').click());
  hook.state={...hook.state,busy:true};await render();await act(async()=>events.journey?.({...journey(),installationId:'different'}));await act(async()=>finish());hook.state={...hook.state,busy:false};await render();expect(props.onClose).not.toHaveBeenCalled();
});
it('checks the original guard again when a matching departure becomes idle',async()=>{
  saveFitted();const guard=vi.fn(()=>undefined);controller.ports.capture.mockReturnValue(guard);let finish!:()=>void;
  controller.recover.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();await act(async()=>button('CONFIRM FITTED DEPARTURE').click());
  hook.state={...hook.state,busy:true};await render();await act(async()=>events.journey?.(journey()));expect(guard).toHaveBeenCalledOnce();
  guard.mockImplementation(()=>{throw Error('stale while finishing');});await act(async()=>finish());hook.state={...hook.state,busy:false};await render();expect(guard).toHaveBeenCalledTimes(2);expect(props.onClose).not.toHaveBeenCalled();
});
it('visible event followed by hidden idle cannot close the sheet',async()=>{
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  saveFitted();let finish!:()=>void;controller.recover.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();await act(async()=>button('CONFIRM FITTED DEPARTURE').click());
  hook.state={...hook.state,busy:true};await render();await act(async()=>events.journey?.(journey()));
  visibility.mockReturnValue('hidden');await act(async()=>finish());hook.state={...hook.state,busy:false};await render();expect(props.onClose).not.toHaveBeenCalled();
});
it('hidden event followed by visible idle never arms a later close',async()=>{
  const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  saveFitted();let finish!:()=>void;controller.recover.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));await render();await act(async()=>button('CONFIRM FITTED DEPARTURE').click());
  hook.state={...hook.state,busy:true};await render();visibility.mockReturnValue('hidden');await act(async()=>events.journey?.(journey()));
  visibility.mockReturnValue('visible');await act(async()=>finish());hook.state={...hook.state,busy:false};await render();expect(props.onClose).not.toHaveBeenCalled();
});
it('shows original unfitted comparison and exact advanced supplies without computing rewards',async()=>{
  const route=vector.advancedEnvelope.receipt.route;await act(async()=>root.render(<VoyageTerms route={route}/>));
  expect(host.textContent).toContain('Without equipment');expect(host.textContent).toContain(fmtDur(route.fitting.originalDurationSec));
  expect(host.textContent).toContain(`Supplies used at departure: ${BigInt(route.supplies[0]!.quantity).toLocaleString('en-US')} ${voyageName(route.supplies[0]!.resourceId)}`);expect(host.textContent).toContain('The fitted tool travels with the journey and is unavailable until its return is collected.');
  expect(host.textContent).toContain(BigInt(route.fitting.originalNetQuantity).toLocaleString('en-US'));
});

it.each(['common','paid_realm'] as const)('retries only the same saved %s Compass departure; held and foreign requests stay disabled',async(kind)=>{
  let saved=saveFitted();if(kind==='paid_realm'){const fitting={itemId:'route_compass' as const,policyVersion:1 as const},quote=applyEquipmentFitting(paidStarterRoutePreview('paid_frostveil'),fitting);saved=parseCompassCommand({kind:'starter',request:{...saved.request,routeId:quote.routeId,routeVersion:quote.routeCatalogueVersion,rewardVersion:quote.rewardTableVersion,fitting},quote});hook.state={...hook.state,fitting,journal:{...hook.state.journal!,operation:{...hook.state.journal!.operation!,command:saved}}};}hook.state={...hook.state,journal:{...hook.state.journal!,operation:{...hook.state.journal!.operation!,attemptRevision:2}}};await render();
  expect(button('RETRY SAME SAVED REQUEST').disabled).toBe(false);await act(async()=>button('RETRY SAME SAVED REQUEST').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith(saved.request.idempotencyKey,true);expect(controller.begin).not.toHaveBeenCalled();
  hook.actionsAllowed=false;await render();expect(button('RETRY SAME SAVED REQUEST').disabled).toBe(true);
  hook.actionsAllowed=true;useApp.getState().setSelectedBaseId('00000000-0000-4000-8000-000000000099',false);await render();expect(button('RETRY SAME SAVED REQUEST').disabled).toBe(true);
});
it('collects actual returns as recovery during a pause without admitting new departures',async()=>{
  hook.actionsAllowed=false;props.session.dispatch=vi.fn((kind,action)=>{if(kind==='mutate')return false;action();return true;});await render();await act(async()=>button('EXPEDITIONS').click());
  expect(button('COLLECT ACTUAL RETURNS').disabled).toBe(false);await act(async()=>button('COLLECT ACTUAL RETURNS').click());expect(controller.collect).toHaveBeenCalledExactlyOnceWith(vector.view.baseId);expect(props.session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));expect(controller.begin).not.toHaveBeenCalled();
});
it('unknown equipment stays visibly unknown rather than claiming empty stock',async()=>{
  hook.state={...hook.state,equipment:null};await render();await act(async()=>button('EXPEDITIONS').click());expect(host.textContent).toContain('Equipment stock is unknown');expect(host.textContent).not.toContain('No selected fitting is currently available');
});
it('a non-selected original kingdom cannot confirm an unattempted departure',async()=>{
  saveFitted();useApp.getState().setSelectedBaseId('00000000-0000-4000-8000-000000000099',false);await render();expect(button('CONFIRM FITTED DEPARTURE').disabled).toBe(true);
  await act(async()=>button('CONFIRM FITTED DEPARTURE').click());expect(controller.recover).not.toHaveBeenCalled();
});
it('clears the refused-dispatch notice after original Compass capability changes',async()=>{
  props.session.dispatch=vi.fn(()=>false);await render();expect(button('REVIEW ROUTE COMPASS').disabled).toBe(false);await act(async()=>button('REVIEW ROUTE COMPASS').click());expect(host.textContent).toContain('New actions are paused');
  hook.actionsAllowed=false;await render();hook.actionsAllowed=true;await render();expect(host.textContent).not.toContain('New actions are paused');
});

it('admits every offered departure review only through mutate',async()=>{
  const fitting={itemId:'route_compass' as const,policyVersion:1 as const};
  const route=applyEquipmentFitting(paidStarterRoutePreview('paid_frostveil'),fitting);
  const installationId=vector.advancedView.items[0]!.installationId;
  // A departure is offered only with the fitted item in stock (CompassPanel `available`); surveyLens.json ships
  // route_compass at 0, so this case stocks one fitting (night 2026-10-06: the review was disabled).
  hook.state={...hook.state,fitting,starter:StarterExpeditionViewSchema.parse(compassVector.starterView),
    equipment:{...hook.state.equipment!,equipmentStock:hook.state.equipment!.equipmentStock.map(stock=>stock.itemId===fitting.itemId?{...stock,available:'1'}:stock)},
    paid:{wallet:vector.view.wallet,baseId:vector.view.baseId,realm:0,serverNow:vector.view.serverNow,authorization:'none',acceptingDepartures:true,route,coverage:{status:'covered',observedAt:vector.view.serverNow,expiresAt:'1999999999'}},
    fleet:{version:1,wallet:vector.view.wallet,baseId:vector.view.baseId,serverNow:vector.view.serverNow,acceptingNewActions:true,vehicles:[{installationId,berthId:vector.starterView.installation.berthId,family:'survey_balloon',tier:1,revision:1,completedTotal:'0',allowanceStart:'0',remainingUses:PHASE_E_VEHICLES.completedUsesPerInstall,away:false,pendingService:false}]},
    routes:VehicleRoutesSchema.parse(compassVector.advancedView)};
  props.session.dispatch=vi.fn((kind,action)=>{if(kind==='mutate')return false;action();return true;});await render();await act(async()=>button('EXPEDITIONS').click());
  const select=host.querySelector<HTMLSelectElement>('[aria-label="Paid destination"]')!;await act(async()=>{select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));});
  for(const label of ['REVIEW FITTED DEPARTURE','REVIEW PAID FITTED DEPARTURE','REVIEW ADVANCED DEPARTURE']){expect(button(label).disabled).toBe(false);await act(async()=>button(label).click());}
  expect(controller.begin).not.toHaveBeenCalled();expect(props.session.dispatch).toHaveBeenCalledWith('mutate',expect.any(Function));
});

it('builds its rich-stock fixture in the protected crafting schema without raw-stock fields',()=>{
 expect(OrdinaryEquipmentViewV2Schema.safeParse(hook.state.equipment).success).toBe(true);
 for(const stock of hook.state.equipment!.craftingStock){
  expect(stock).not.toHaveProperty('reserved');expect(stock).not.toHaveProperty('total');
  expect(typeof stock.pendingOutput).toBe('string');
 }
});
