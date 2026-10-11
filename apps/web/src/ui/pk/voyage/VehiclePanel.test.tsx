/** @vitest-environment happy-dom */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useApp,type BaseStateDto} from '../../../state/store';
import {useVehicle} from '../../../lib/vehicles/useVehicle';
import {useStarterExpedition} from '../../../lib/starterExpedition/useStarterExpedition';
import {emptyVehicleState} from '../../../lib/vehicles/controller';
import {vehicleKey} from '../../../lib/vehicles/journal';
import type {BaseFeatureProps} from '../featureRegistry';
import type {PkSealProps} from '../Seal';
import {identity,id,vehicle,route,stock,preparedOperation,expeditionOperation,reservedServiceOperation} from './vehiclePresentation.test-support';
import VehiclePanel from './VehiclePanel';
import {voyageFeatures} from './features';
vi.mock('../../../lib/vehicles/useVehicle',()=>({useVehicle:vi.fn()}));
vi.mock('../../../lib/starterExpedition/useStarterExpedition',()=>({useStarterExpedition:vi.fn()}));
vi.mock('./VehicleCraftBody',()=>({default:()=>null}));
const seal=vi.hoisted(()=>({props:null as PkSealProps|null}));
vi.mock('../Seal',()=>({PkSeal:(props:PkSealProps)=>{seal.props=props;return props.ui?<div aria-label="Held original burn">{props.ui.lines.join(' ')} {props.ui.price.amount}</div>:null;}}));
let host:HTMLDivElement,root:Root,props:BaseFeatureProps,hook:ReturnType<typeof useVehicle>,supplies:ReturnType<typeof useStarterExpedition>;
let controller:{begin:ReturnType<typeof vi.fn>;recover:ReturnType<typeof vi.fn>;load:ReturnType<typeof vi.fn>;fleet:ReturnType<typeof vi.fn>;collect:ReturnType<typeof vi.fn>;sign:ReturnType<typeof vi.fn>;deliver:ReturnType<typeof vi.fn>;select:ReturnType<typeof vi.fn>;prepare:ReturnType<typeof vi.fn>;review:ReturnType<typeof vi.fn>;archive:ReturnType<typeof vi.fn>;upload:ReturnType<typeof vi.fn>};
const render=()=>act(async()=>root.render(<VehiclePanel {...props}/>));
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!;
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);seal.props=null;
 useApp.getState().setAuth(identity.wallet,true);useApp.getState().setSelectedBaseId(id(1),false);
 controller={begin:vi.fn(async()=>undefined),recover:vi.fn(async()=>undefined),load:vi.fn(async()=>undefined),fleet:vi.fn(async()=>undefined),collect:vi.fn(async()=>undefined),sign:vi.fn(async()=>undefined),deliver:vi.fn(async()=>undefined),select:vi.fn(),prepare:vi.fn(async()=>undefined),review:vi.fn(async()=>undefined),archive:vi.fn(async()=>undefined),upload:vi.fn(async()=>undefined)};
 hook={state:{...emptyVehicleState(),loaded:true,fleet:{version:1,wallet:identity.wallet,baseId:id(1),serverNow:'2035-01-01T00:00:00.000Z',acceptingNewActions:true,vehicles:[vehicle]},routes:{version:1,wallet:identity.wallet,baseId:id(1),items:[{installationId:vehicle.installationId,previews:[route]}]}},actionsAllowed:true,signingAllowed:false,run:vi.fn(action=>{void action(controller as never);}),dismiss:vi.fn()};
 supplies={state:{loaded:true,busy:false,journal:null,review:null,error:null},snapshot:{view:stock(),balances:{keep:'0',shards:'0',keepRate:1},enabled:true},refreshError:null,actionsAllowed:false,run:vi.fn(),refresh:vi.fn(),dismiss:vi.fn(),finish:vi.fn()};
 vi.mocked(useVehicle).mockImplementation(enabled=>({...hook,actionsAllowed:enabled&&hook.actionsAllowed}));vi.mocked(useStarterExpedition).mockImplementation(()=>supplies);
 props={actionsEnabled:true,panel:{kind:'voyage',featureId:'voyage.vehicle'},onClose:vi.fn(),session:{dispatch:vi.fn((_kind,action)=>{action();return true;}),setDismissPolicy:vi.fn(()=>()=>undefined)}};
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('mount reads existing hooks without creating, signing or delivering a vehicle request',async()=>{
 await render();expect(useVehicle).toHaveBeenLastCalledWith(true,null);expect(useStarterExpedition).toHaveBeenLastCalledWith(false);
 expect(controller.begin).not.toHaveBeenCalled();expect(controller.sign).not.toHaveBeenCalled();expect(controller.deliver).not.toHaveBeenCalled();
 expect(voyageFeatures.find(f=>f.id==='voyage.vehicle')?.canMutate?.(props.panel)).toBe(false);
});
it('reviews exact observed terms before the original controller creates a departure key',async()=>{
 await render();expect(button('REVIEW DEPARTURE').disabled).toBe(false);await act(async()=>button('REVIEW DEPARTURE').click());expect(controller.begin).not.toHaveBeenCalled();
 expect(host.textContent).toContain('Supplies used at departure');expect(button('CONFIRM DEPARTURE').disabled).toBe(false);await act(async()=>button('CONFIRM DEPARTURE').click());
 expect(controller.begin).toHaveBeenCalledExactlyOnceWith('expedition',{baseId:id(1),installationId:vehicle.installationId,routeId:route.routeId,policyVersion:route.policyVersion});
});
it('denied mutation dispatch cannot review or create while actual return settlement stays recoverable',async()=>{
 props.session.dispatch=vi.fn((kind,action)=>{if(kind==='mutate')return false;action();return true;});await render();expect(button('REVIEW DEPARTURE').disabled).toBe(false);await act(async()=>button('REVIEW DEPARTURE').click());expect(button('CONFIRM DEPARTURE')).toBeUndefined();expect(host.textContent).toContain('New actions are paused');
 await act(async()=>button('COLLECT ACTUAL RETURNS').click());expect(controller.collect).toHaveBeenCalledWith(id(1));expect(controller.begin).not.toHaveBeenCalled();expect(props.session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));
});
it('capability or kingdom changes clear the local review and a missing required capability still fails closed at runtime',async()=>{
 await render();await act(async()=>button('REVIEW DEPARTURE').click());props.actionsEnabled=false;await render();expect(button('CONFIRM DEPARTURE')).toBeUndefined();expect(useVehicle).toHaveBeenLastCalledWith(false,null);
 props.actionsEnabled=true;await render();await act(async()=>button('REVIEW DEPARTURE').click());useApp.getState().setSelectedBaseId(id(99),false);await render();expect(button('CONFIRM DEPARTURE')).toBeUndefined();
 const missingCapability={panel:props.panel,onClose:props.onClose,session:props.session};
  await act(async()=>{
    // @ts-expect-error H-2 requires the live host capability; deliberately probe an untyped omission.
    root.render(<VehiclePanel {...missingCapability}/>);
  });expect(useVehicle).toHaveBeenLastCalledWith(false,null);
});
it('an uncertain saved request and refresh error expose CHECK with no second departure',async()=>{
 const op=expeditionOperation('missing');hook.state={...hook.state,error:'response lost',selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(button('REVIEW DEPARTURE').disabled).toBe(true);await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledWith();expect(controller.begin).not.toHaveBeenCalled();expect(host.textContent).not.toContain('Nothing was sent');
});
it('burn review uses the shared Seal with exact original fee and no signing authority',async()=>{
 const op=preparedOperation();hook.state={...hook.state,selected:vehicleKey(op.command),reviewed:{messageSha256:'b'.repeat(64),networkFeeLamports:'9007199254740993'},journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(seal.props?.ui?.price.amount).toBe('9007199.254740993');expect(seal.props?.ui?.lines.join(' ')).toContain('permanently burned');expect(seal.props?.ui?.lines.join(' ')).toContain(id(1));expect(seal.props?.canConfirm()).toBe(false);
 await act(async()=>seal.props?.onConfirm());expect(controller.sign).not.toHaveBeenCalled();expect(controller.deliver).not.toHaveBeenCalled();
});
it('missing stock and missing installed vehicle never acquire enabled SEND from a native look',async()=>{
 supplies.snapshot=null;await render();expect(button('REVIEW DEPARTURE').disabled).toBe(true);expect(host.textContent).toContain('Stock is unknown');
 hook.state={...hook.state,fleet:{...hook.state.fleet!,vehicles:[]}};await render();expect(button('REVIEW DEPARTURE')).toBeUndefined();expect(controller.begin).not.toHaveBeenCalled();
});
it('busy dismissal cancels; idle dismissal clears original consent before the host continues',async()=>{
 hook.state={...hook.state,busy:true};await render();const proceed=vi.fn(()=>true),cancel=vi.fn();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed,cancel});expect(cancel).toHaveBeenCalledOnce();expect(proceed).not.toHaveBeenCalled();
 hook.state={...hook.state,busy:false};await render();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed});expect(hook.dismiss).toHaveBeenCalled();expect(proceed).toHaveBeenCalledOnce();
});

it('an accepted at-sea expedition holds another vehicle in the same kingdom per corrected server rule',async()=>{
 const travelling={...vehicle,installationId:id(20),away:true};
 const op=expeditionOperation('accepted',travelling.installationId);
 hook.state={...hook.state,journal:{version:1,identity,revision:1,pending:[op],archive:[]},fleet:{...hook.state.fleet!,vehicles:[travelling,vehicle]}};
 // 7fa67390 explicitly withdraws the earlier A/B SEND premise; this is the ordered correction.
 await render();expect(button('REVIEW DEPARTURE').disabled).toBe(true);expect(host.textContent).toContain('An expedition is still recorded for this kingdom. Use COLLECT ACTUAL RETURNS or CHECK ORIGINAL OUTCOME before another departure.');expect(host.textContent).not.toContain('Your departure is being checked');
});
it('a prepared installation leaves unrelated departures available and never calls them uncertain',async()=>{
 hook.state={...hook.state,journal:{version:1,identity,revision:1,pending:[preparedOperation()],archive:[]}};
 await render();expect(button('REVIEW DEPARTURE').disabled).toBe(false);expect(host.textContent).not.toContain('departure is being checked');
});
it('a retained unknown envelope shows checking and holds its kingdom despite a refresh error',async()=>{
 const op=expeditionOperation('unknown');hook.state={...hook.state,error:'response lost',selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(host.textContent).toContain('Expedition · checking');expect(host.textContent).toContain('A saved expedition request for this kingdom is being checked. Use CHECK ORIGINAL OUTCOME before another departure.');expect(host.textContent).not.toContain('Your departure is being checked');expect(host.textContent).not.toContain('at_sea');expect(button('REVIEW DEPARTURE').disabled).toBe(true);
 await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledWith();expect(controller.begin).not.toHaveBeenCalled();
});
it('an outstanding reservation still prevents reserving that asset a second time',async()=>{
 // A different completed berth isolates the same-asset hold from the original berth hold.
 const op=preparedOperation();hook.state={...hook.state,journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 useApp.getState().setBase({baseId:id(1),player:{wallet:identity.wallet},buildings:[{id:id(77),type:'berth',underConstruction:false}]} as unknown as BaseStateDto);
 await render();await act(async()=>button('INSTALL').click());
 const input=host.querySelector<HTMLInputElement>('[aria-label="NFT address"]')!,select=host.querySelector<HTMLSelectElement>('[aria-label="Completed berth"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,identity.wallet);input.dispatchEvent(new Event('input',{bubbles:true}));select.value=id(77);select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(button('RESERVE ORIGINAL INSTALLATION').disabled).toBe(true);await act(async()=>button('RESERVE ORIGINAL INSTALLATION').click());expect(controller.begin).not.toHaveBeenCalled();
 hook.state={...hook.state,journal:{...hook.state.journal!,pending:[]}};await render();expect(button('RESERVE ORIGINAL INSTALLATION').disabled).toBe(false);
});
it.each(['missing','unknown'] as const)('same saved request retry for %s calls only original recover true and stops on dispatch or capability refusal',async status=>{
 const op=expeditionOperation(status),selected=vehicleKey(op.command);hook.state={...hook.state,selected,journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(host.querySelector('[aria-label="Original vehicle consent"]')?.textContent).toContain('RETRY checks the original outcome and, if still unknown, sends the same saved departure now.');
 const consent=host.querySelector('[aria-label="Original vehicle consent"]')!,explanation=[...consent.querySelectorAll('p')].find(p=>p.textContent?.startsWith('RETRY checks'))!;
 const actions=button('RETRY SAME SAVED REQUEST').closest('.pk-voyage-adapter__actions')!;
 expect(explanation.parentElement).toBe(consent);expect(actions.parentElement).toBe(consent);expect(explanation.nextElementSibling).toBe(actions);
 expect(button('RETRY SAME SAVED REQUEST').disabled).toBe(false);await act(async()=>button('RETRY SAME SAVED REQUEST').click());
 expect(controller.recover).toHaveBeenCalledExactlyOnceWith(true);expect(controller.begin).not.toHaveBeenCalled();expect(controller.select).not.toHaveBeenCalled();expect(hook.state.selected).toBe(selected);
 props.session.dispatch=vi.fn(()=>false);await render();await act(async()=>button('RETRY SAME SAVED REQUEST').click());expect(controller.recover).toHaveBeenCalledTimes(1);expect(button('RETRY SAME SAVED REQUEST').disabled).toBe(true);
 props.actionsEnabled=false;await render();expect(button('RETRY SAME SAVED REQUEST').disabled).toBe(true);expect(controller.begin).not.toHaveBeenCalled();
});
it('two immediate confirm taps invoke one begin through the original hook pending coalescing contract',async()=>{
 let pending=false,release!:()=>void;const completion=new Promise<void>(resolve=>{release=resolve;});controller.begin.mockImplementation(()=>completion);
 // This probe models useVehicle.invoke's synchronous pending guard; it is not proof of the real hook.
 hook.run=vi.fn(action=>{if(pending)return;pending=true;void Promise.resolve(action(controller as never)).finally(()=>{pending=false;});});
 await render();await act(async()=>button('REVIEW DEPARTURE').click());const confirm=button('CONFIRM DEPARTURE');expect(confirm.disabled).toBe(false);
 await act(async()=>{confirm.click();confirm.click();});expect(controller.begin).toHaveBeenCalledExactlyOnceWith('expedition',{baseId:id(1),installationId:vehicle.installationId,routeId:route.routeId,policyVersion:route.policyVersion});await act(async()=>release());
});

it('a history-opened request with unknown scope holds every vehicle and CHECK never starts a new key',async()=>{
 const op=expeditionOperation('missing');op.command={...op.command,request:null};
 hook.state={...hook.state,selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(button('REVIEW DEPARTURE').disabled).toBe(true);expect(host.textContent).toContain('A saved vehicle request has no known kingdom yet. Use CHECK ORIGINAL OUTCOME before any departure.');
 await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith();expect(controller.begin).not.toHaveBeenCalled();expect(button('RETRY SAME SAVED REQUEST')).toBeUndefined();
});
it('service reservations stay disabled while this installation has a saved flight on a stale docked fleet',async()=>{
 const op=expeditionOperation('accepted');hook.state={...hook.state,journal:{version:1,identity,revision:1,pending:[op],archive:[]},assets:{version:2,wallet:identity.wallet,items:[{identity:{assetId:identity.wallet,collection:identity.wallet,family:vehicle.family,tier:vehicle.tier},observedSlot:1,provenance:{kind:'owner_attested'}}],nextCursor:null}};
 await render();await act(async()=>button('SERVICE').click());await act(async()=>button('SURVEY BALLOON · TIER 1 · CANDIDATE 1').click());
 expect(button('RESERVE UPGRADE').disabled).toBe(true);await act(async()=>button('RESERVE UPGRADE').click());expect(controller.begin).not.toHaveBeenCalled();
 hook.state={...hook.state,journal:{...hook.state.journal!,pending:[]}};await render();expect(button('RESERVE UPGRADE').disabled).toBe(false);
});

it.each([
 ['accepted','An expedition is still recorded for this kingdom. Use COLLECT ACTUAL RETURNS or CHECK ORIGINAL OUTCOME before another departure.'],
 ['unknown','A saved expedition request for this kingdom is being checked. Use CHECK ORIGINAL OUTCOME before another departure.'],
] as const)('an open departure review holds CONFIRM when a %s journal original appears without replacing routes',async(status,reason)=>{
 await render();await act(async()=>button('REVIEW DEPARTURE').click());expect(button('CONFIRM DEPARTURE').disabled).toBe(false);
 const routes=hook.state.routes,op=expeditionOperation(status);
 // CHECK/load can refresh the journal without changing the route identity. COLLECT cannot isolate this path.
 hook.state={...hook.state,journal:{version:1,identity,revision:1,pending:[op],archive:[]}};await render();
 expect(hook.state.routes).toBe(routes);expect(button('CONFIRM DEPARTURE').disabled).toBe(true);
 expect(host.querySelector('[aria-label="Departure review"]')?.textContent).toContain(reason);
 await act(async()=>button('CONFIRM DEPARTURE').click());expect(controller.begin).not.toHaveBeenCalled();
});

// D153.362 accepts the lane wording; these cases retain every original action hold.
it('a reserved service states that CHECK observes its state and cannot release its departure hold',async()=>{
 const op=reservedServiceOperation();hook.state={...hook.state,selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(host.textContent).toContain('This vehicle has a saved service reservation. It cannot depart until that service is completed. Use CHECK ORIGINAL OUTCOME to see its state.');expect(button('REVIEW DEPARTURE').disabled).toBe(true);
 await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith();expect(button('REVIEW DEPARTURE').disabled).toBe(true);expect(controller.begin).not.toHaveBeenCalled();expect(controller.sign).not.toHaveBeenCalled();
});
it('an unresolved service may retry its saved request without being described as a departure',async()=>{
 const op={...reservedServiceOperation(),original:null};hook.state={...hook.state,selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(host.textContent).not.toContain('sends the same saved departure now');expect(button('RETRY SAME SAVED REQUEST').disabled).toBe(false);
 await act(async()=>button('RETRY SAME SAVED REQUEST').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith(true);expect(controller.begin).not.toHaveBeenCalled();
});
it('a history-only unknown expedition shows CHECK without promising an unavailable saved departure retry',async()=>{
 const op=expeditionOperation('unknown');op.command={...op.command,request:null};hook.state={...hook.state,selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}};
 await render();expect(host.textContent).toContain('A saved vehicle request has no known kingdom yet. Use CHECK ORIGINAL OUTCOME before any departure.');expect(host.textContent).not.toContain('sends the same saved departure now');expect(button('RETRY SAME SAVED REQUEST')).toBeUndefined();
 await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith();expect(controller.begin).not.toHaveBeenCalled();
});

it('journal load failure keeps actions disabled but allows original dismissal to close the panel',async()=>{
 hook.state={...hook.state,loaded:false,busy:false,error:'Journal storage unavailable'};await render();
 expect(button('REFRESH').disabled).toBe(true);expect(button('REVIEW DEPARTURE').disabled).toBe(true);
 const proceed=vi.fn(()=>true),cancel=vi.fn();const before=vi.mocked(hook.dismiss).mock.calls.length;
 vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed,cancel});
 expect(cancel).not.toHaveBeenCalled();expect(proceed).toHaveBeenCalledOnce();expect(hook.dismiss).toHaveBeenCalledTimes(before+1);
 await act(async()=>button('REVIEW DEPARTURE').click());expect(controller.begin).not.toHaveBeenCalled();
});
