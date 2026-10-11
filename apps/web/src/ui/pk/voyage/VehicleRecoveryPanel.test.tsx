/** @vitest-environment happy-dom
 * 87ac7014 recovery-only feature proposal. AUTHORED/UNRUN.
 * No signing trust, wire, keypair or real chain evidence is created.
 */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useApp} from '../../../state/store';
import {useVehicle} from '../../../lib/vehicles/useVehicle';
import {emptyVehicleState} from '../../../lib/vehicles/controller';
import {vehicleKey} from '../../../lib/vehicles/journal';
import {createPanelSession} from '../panelSession';
import type {BaseFeatureProps} from '../featureRegistry';
import {identity,id,expeditionOperation,reservedServiceOperation} from './vehiclePresentation.test-support';
import VehicleRecoveryPanel from './VehicleRecoveryPanel';
import {vehicleRecoveryFeature} from './vehicleRecoveryFeature';
vi.mock('../../../lib/vehicles/useVehicle',()=>({useVehicle:vi.fn()}));
let host:HTMLDivElement,root:Root,props:BaseFeatureProps,hook:ReturnType<typeof useVehicle>&{readAuthority?:()=>never};
const forbidden=['begin','prepare','review','sign','deliver','upload','collect','archive','assets','fleet'] as const;
type Method=typeof forbidden[number]|'select'|'load'|'recover'|'activity'|'open';
let controller:Record<Method,ReturnType<typeof vi.fn>>;
const button=(label:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label)!;
const render=()=>act(async()=>root.render(<VehicleRecoveryPanel {...props}/>));
const historyItem=()=>({kind:'expedition' as const,id:id(10),idempotencyKey:id(10),baseId:id(1),createdAt:'2035-01-01T00:00:00.000Z',status:'accepted' as const});
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.clearAllMocks();
 useApp.getState().setAuth(identity.wallet,true);useApp.getState().setSelectedBaseId(id(1),false);
 controller=Object.fromEntries([...forbidden,'select','load','recover','activity','open'].map(name=>[name,vi.fn(async()=>undefined)])) as typeof controller;
 const op=expeditionOperation('unknown');
 hook={state:{...emptyVehicleState(),loaded:true,selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}},actionsAllowed:false,signingAllowed:false,run:vi.fn(action=>{void action(controller as never);}),dismiss:vi.fn()};
 vi.mocked(useVehicle).mockImplementation(()=>hook);
 props={actionsEnabled:true,panel:{kind:'voyage',featureId:'voyage.vehicle'},onClose:vi.fn(),session:{dispatch:vi.fn((_kind,action)=>{action();return true;}),setDismissPolicy:vi.fn(()=>()=>undefined)}};
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('has an explicit recovery-only feature contract and no mutation authority for any host capability',async()=>{
 expect(vehicleRecoveryFeature).toMatchObject({id:'voyage.vehicle',kind:'voyage',readOnly:true,dismissal:'controller'});expect(vehicleRecoveryFeature.canMutate?.(props.panel)).toBe(false);expect(vehicleRecoveryFeature.canRecover?.(props.panel)).toBe(true);
 expect(vehicleRecoveryFeature.canRecover?.({...props.panel,featureId:'voyage.compass'})).toBe(false);expect((await vehicleRecoveryFeature.load()).default).toBe(VehicleRecoveryPanel);
 await render();expect(useVehicle).toHaveBeenLastCalledWith(false,null);props.actionsEnabled=false;await render();expect(useVehicle).toHaveBeenLastCalledWith(false,null);expect(hook.run).not.toHaveBeenCalled();
});
it('checks an uncertain saved original during a pause or refresh failure without retrying a POST',async()=>{
 props.actionsEnabled=false;hook.state={...hook.state,error:'response lost'};await render();expect(host.textContent).toContain('Expedition · checking');expect(button('CHECK ORIGINAL OUTCOME').disabled).toBe(false);
 await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith();expect(props.session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));for(const method of forbidden)expect(controller[method]).not.toHaveBeenCalled();
});
it('session refusal reports stale recovery admission and invokes no controller method',async()=>{
 props.session.dispatch=vi.fn(()=>false);await render();await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(hook.run).not.toHaveBeenCalled();expect(host.textContent).toContain('This vehicle panel is no longer current. Close it and reopen Vehicle history.');
});
it('reads device originals by the exact existing key and discovers history by the exact server item',async()=>{
 const item=historyItem();hook.state={...hook.state,activity:{version:1,wallet:identity.wallet,items:[item],nextCursor:'next-page'}};await render();
 await act(async()=>button('OPEN EXPEDITION · CHECKING').click());expect(controller.select).toHaveBeenCalledExactlyOnceWith(hook.state.selected);
 await act(async()=>button('OPEN HISTORY EXPEDITION · ACCEPTED').click());expect(controller.open).toHaveBeenCalledExactlyOnceWith(item);
 await act(async()=>button('NEXT HISTORY PAGE').click());expect(controller.activity).toHaveBeenCalledExactlyOnceWith('next-page');expect(controller.begin).not.toHaveBeenCalled();
});
it('refresh and history use only the original reader methods',async()=>{
 await render();await act(async()=>button('REFRESH').click());expect(controller.load).toHaveBeenCalledExactlyOnceWith();
 await act(async()=>button('REFRESH ORIGINAL HISTORY').click());expect(controller.activity).toHaveBeenCalledExactlyOnceWith();expect(props.session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));
});
it('never exposes action buttons even if a mocked original claims mutation or signing authority',async()=>{
 const op=reservedServiceOperation();hook={...hook,actionsAllowed:true,signingAllowed:true,readAuthority:vi.fn(()=>{throw Error('Recovery must not consult mutation authority');}),state:{...hook.state,selected:vehicleKey(op.command),journal:{version:1,identity,revision:1,pending:[op],archive:[]}}};
 await render();const labels=[...host.querySelectorAll('button')].map(b=>b.textContent??'');expect(labels.some(label=>/^(?:CONFIRM|BURN|SIGN|DELIVER|RESERVE|RETRY|COLLECT|ARCHIVE|PREPARE|UPLOAD|REVIEW|INSTALL|DEPART|SEND)(?:\s|$)/.test(label))).toBe(false);
 await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith();expect(hook.readAuthority).not.toHaveBeenCalled();for(const method of forbidden)expect(controller[method]).not.toHaveBeenCalled();
});
it('does not expose a foreign wallet journal or history through a stale hook render',async()=>{
 hook.state={...hook.state,journal:{...hook.state.journal!,identity:{...identity,wallet:'foreign'}},activity:{version:1,wallet:'foreign',items:[historyItem()],nextCursor:'foreign-cursor'}};await render();
 expect(host.querySelector('[aria-label="Saved vehicle requests"]')).toBeNull();expect(button('CHECK ORIGINAL OUTCOME')).toBeUndefined();expect(button('OPEN HISTORY EXPEDITION · ACCEPTED')).toBeUndefined();expect(button('NEXT HISTORY PAGE')).toBeUndefined();expect(hook.run).not.toHaveBeenCalled();
});
it('requires live authentication for its feature and recovery callback',async()=>{
 await render();await act(async()=>useApp.setState({authed:false}));expect(vehicleRecoveryFeature.canRecover?.(props.panel)).toBe(false);await render();
 expect(button('CHECK ORIGINAL OUTCOME')).toBeUndefined();expect(host.textContent).toContain('Sign in to check your saved vehicle requests.');await act(async()=>button('REFRESH').click());expect(hook.run).not.toHaveBeenCalled();
});
it('busy dismissal is refused while idle dismissal clears the original review before proceeding',async()=>{
 hook.state={...hook.state,busy:true};await render();const proceed=vi.fn(()=>true),cancel=vi.fn();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed,cancel});expect(cancel).toHaveBeenCalledOnce();expect(proceed).not.toHaveBeenCalled();
 hook.state={...hook.state,busy:false};await render();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed});expect(hook.dismiss).toHaveBeenCalledOnce();expect(proceed).toHaveBeenCalledOnce();
});
it('the actual host session admits recovery while denying mutate and refuses a retired panel',async()=>{
 const session=createPanelSession({panel:props.panel,controlled:true,isCurrent:()=>true,canMutate:()=>false,canRecover:()=>true});const retire=session.mount();props.session=session;await render();
 await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledExactlyOnceWith();const mutation=vi.fn();expect(session.dispatch('mutate',mutation)).toBe(false);expect(mutation).not.toHaveBeenCalled();
 retire();await act(async()=>button('CHECK ORIGINAL OUTCOME').click());expect(controller.recover).toHaveBeenCalledTimes(1);expect(host.textContent).toContain('This vehicle panel is no longer current.');
});
it('an archived original remains readable without introducing archive, retry or payment actions',async()=>{
 const op=hook.state.journal!.pending[0]!;hook.state={...hook.state,journal:{...hook.state.journal!,pending:[],archive:[op]}};await render();
 expect(host.textContent).toContain('Original request');expect(button('OPEN EXPEDITION · CHECKING')).toBeDefined();expect(button('CHECK ORIGINAL OUTCOME')).toBeUndefined();expect(button('ARCHIVE VERIFIED ORIGINAL')).toBeUndefined();expect(controller.archive).not.toHaveBeenCalled();
});

it('journal load failure disables reader actions but does not trap the user behind a dismissal refusal',async()=>{
 hook.state={...hook.state,loaded:false,busy:false,error:'Journal storage unavailable'};await render();
 for(const label of ['REFRESH','REFRESH ORIGINAL HISTORY','OPEN EXPEDITION · CHECKING','CHECK ORIGINAL OUTCOME'])expect(button(label).disabled).toBe(true);
 const proceed=vi.fn(()=>true),cancel=vi.fn();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed,cancel});
 expect(cancel).not.toHaveBeenCalled();expect(proceed).toHaveBeenCalledOnce();expect(hook.dismiss).toHaveBeenCalledOnce();
 // A header history click also cannot escape the unloaded recovery guard.
 const history=host.querySelector<HTMLButtonElement>('[aria-label="Voyage history"]')!;
 await act(async()=>{history.click();button('CHECK ORIGINAL OUTCOME').click();button('REFRESH').click();});
 expect(hook.run).not.toHaveBeenCalled();for(const method of forbidden)expect(controller[method]).not.toHaveBeenCalled();
});
it('clicks every enabled recovery button and reaches only existing reader methods with zero-argument recover',async()=>{
 const item=historyItem();hook={...hook,actionsAllowed:true,signingAllowed:true,readAuthority:vi.fn(()=>{throw Error('No mutation accessor in recovery');}),state:{...hook.state,activity:{version:1,wallet:identity.wallet,items:[item],nextCursor:'next-page'}}};
 await render();const enabled=[...host.querySelectorAll<HTMLButtonElement>('button')].filter(b=>!b.disabled);
 expect(enabled.map(b=>b.textContent?.trim())).toContain('CHECK ORIGINAL OUTCOME');expect(enabled.length).toBeGreaterThan(5);
 for(const control of enabled)await act(async()=>control.click());
 const reached=Object.entries(controller).filter(([,method])=>method.mock.calls.length).map(([name])=>name).sort();
 expect(reached).toEqual(['activity','load','open','recover','select']);expect(controller.recover).toHaveBeenCalledExactlyOnceWith();
 expect(controller.load).toHaveBeenCalledExactlyOnceWith();expect(controller.select).toHaveBeenCalledExactlyOnceWith(hook.state.selected);expect(controller.open).toHaveBeenCalledExactlyOnceWith(item);
 expect(controller.activity.mock.calls).toEqual([[],[],['next-page']]);expect(props.onClose).toHaveBeenCalledOnce();
 expect(vi.mocked(props.session.dispatch).mock.calls.every(([kind])=>kind==='recover')).toBe(true);
 expect(hook.readAuthority).not.toHaveBeenCalled();for(const method of forbidden)expect(controller[method]).not.toHaveBeenCalled();
});
