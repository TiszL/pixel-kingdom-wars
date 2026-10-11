/** @vitest-environment happy-dom
 * Allocated UNAPPLIED Vehicle accessor proposal (87ac7014).
 * Actual hook, synthetic controller/lifetime probes; no trust fixture, signer,
 * network, IndexedDB, key, signature or genuine chain evidence is constructed.
 */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,expectTypeOf,it,vi} from 'vitest';
import {useApp} from '../../../state/store';
import {useVehicle} from '../../../lib/vehicles/useVehicle';
import type {VehicleState} from '../../../lib/vehicles/controller';
import type {VehicleSigningTrust} from '../../../lib/vehicles/signing';
const probe=vi.hoisted(()=>({
 state:{loaded:true,busy:false,journal:null,activity:null,assets:null,fleet:null,routes:null,selected:null,reviewed:null,error:null} as VehicleState,
 gate:true,connection:{},loads:vi.fn(async()=>undefined),closes:vi.fn(async()=>undefined),dismisses:vi.fn(),controllers:vi.fn(),stores:vi.fn(),ports:vi.fn(),
}));
vi.mock('@solana/wallet-adapter-react',()=>({useConnection:()=>({connection:probe.connection})}));
vi.mock('../../../auth/useGameWallet',()=>({useGameWallet:()=>({publicKey:null,signVersionedTransaction:undefined})}));
vi.mock('../../../lib/mutationGate',()=>({mutationGate:{subscribe:()=>()=>undefined,getSnapshot:()=>probe.gate}}));
vi.mock('../../../lib/vehicles/controller',()=>({VehicleController:class {
 constructor(){probe.controllers();}getSnapshot=()=>probe.state;subscribe=()=>()=>undefined;load=probe.loads;dismiss=probe.dismisses;
}}));
vi.mock('../../../lib/vehicles/journal',()=>({VehicleJournalStore:class {constructor(){probe.stores();}identity={wallet:'probe-only'};close=probe.closes;}}));
vi.mock('../../../lib/vehicles/browser',()=>({browserVehicleIdentity:(wallet:string)=>({wallet}),createVehicleBrowserPorts:()=>{probe.ports();return {};}}));
type Authority=Readonly<{state:Readonly<VehicleState>;lifecycleEpoch:number;actionsAllowed:true}>;
type WithProposal={readAuthority:(isCurrentPanel?:()=>boolean)=>Authority|null};
let root:Root,host:HTMLDivElement,observed:ReturnType<typeof useVehicle>&WithProposal,unmounted:boolean,duringRender:(()=>void)|null;
function Hook({actionsEnabled}:{actionsEnabled:boolean}){observed=useVehicle(actionsEnabled,null) as typeof observed;duringRender?.();return null;}
const mount=async(actionsEnabled=true)=>{await act(async()=>root.render(<Hook actionsEnabled={actionsEnabled}/>));};
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);probe.state={loaded:true,busy:false,journal:null,activity:null,assets:null,fleet:null,routes:null,selected:null,reviewed:null,error:null};probe.gate=true;probe.connection={};vi.clearAllMocks();
 host=document.createElement('div');document.body.append(host);root=createRoot(host);unmounted=false;duringRender=null;
 useApp.getState().setAuth('11111111111111111111111111111111',true);useApp.getState().setSelectedBaseId('00000000-0000-4000-8000-000000000001',false);
});
afterEach(async()=>{if(!unmounted)await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('Vehicle original live authority proposal — authored, unrun',()=>{
 it('reads live controller state with a frozen wrapper and no request, factory, storage or dismiss side effect',async()=>{
  await mount();const counts=[probe.loads,probe.stores,probe.controllers,probe.ports,probe.closes,probe.dismisses].map(fn=>fn.mock.calls.length);
  const authority=observed.readAuthority(()=>true);expect(authority).toMatchObject({state:{loaded:true,busy:false},actionsAllowed:true});expect(authority?.state).toBe(probe.state);expect(Object.isFrozen(authority)).toBe(true);
  expect([probe.loads,probe.stores,probe.controllers,probe.ports,probe.closes,probe.dismisses].map(fn=>fn.mock.calls.length)).toEqual(counts);
 });
 it('does not fabricate a controller during the initial render',async()=>{
  let first=true;duringRender=()=>{if(!first)return;first=false;expect(observed.readAuthority(()=>true)).toBeNull();expect(probe.controllers).not.toHaveBeenCalled();expect(probe.stores).not.toHaveBeenCalled();};
  await mount();expect(observed.readAuthority(()=>true)).not.toBeNull();
 });
 it('has no authority without an authenticated original owner',async()=>{
  useApp.getState().setAuth(null,false);await mount();expect(observed.readAuthority(()=>true)).toBeNull();expect(probe.controllers).not.toHaveBeenCalled();
 });
 it('reads loaded and busy directly before the hook rerenders',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
  probe.state={...probe.state,loaded:false};expect(read(()=>true)).toBeNull();probe.state={...probe.state,loaded:true,busy:true};expect(read(()=>true)).toBeNull();
  probe.state={...probe.state,busy:false,error:'fresh observation'};expect(read(()=>true)?.state).toBe(probe.state);
 });
 it('requires literal synchronous true and refuses absent, false, throwing, Promise and truthy-object guards',async()=>{
  await mount();expect(observed.readAuthority()).toBeNull();expect(observed.readAuthority(()=>false)).toBeNull();expect(observed.readAuthority(()=>{throw Error('stale');})).toBeNull();
  expect(observed.readAuthority(()=>Promise.resolve(false) as unknown as boolean)).toBeNull();expect(observed.readAuthority(()=>({}) as unknown as boolean)).toBeNull();expect(observed.readAuthority(()=>true)).not.toBeNull();
 });
 it('rejects a same-base selection generation change before React rerender',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
  await act(async()=>{useApp.setState({baseSelectionEpoch:useApp.getState().baseSelectionEpoch+1});expect(read(()=>true)).toBeNull();});
 });
 it('rejects selected kingdom changes independently of the generation field',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
  await act(async()=>{useApp.setState({selectedBaseId:'00000000-0000-4000-8000-000000000002'});expect(read(()=>true)).toBeNull();});
 });
 it('rejects wallet changes before original owner cleanup',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
  await act(async()=>{useApp.setState({wallet:'22222222222222222222222222222222'});expect(read(()=>true)).toBeNull();});
 });
 it('rejects live authentication loss before cleanup',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
  await act(async()=>{useApp.setState({authed:false});expect(read(()=>true)).toBeNull();});
 });
 it('rejects screen changes before cleanup can hide the lifetime',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
  await act(async()=>{useApp.setState({screen:useApp.getState().screen==='base'?'map':'base'});expect(read(()=>true)).toBeNull();});
 });
 it('reads the mutation gate live without a rendered notification',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();probe.gate=false;expect(read(()=>true)).toBeNull();probe.gate=true;expect(read(()=>true)).not.toBeNull();
 });
 it('retained allowed and denied accessors both respect capability generations',async()=>{
  await mount();const allowed=observed.readAuthority;expect(allowed(()=>true)).not.toBeNull();await mount(false);const denied=observed.readAuthority;
  expect(probe.state.busy).toBe(false);expect(probe.gate).toBe(true);expect(allowed(()=>true)).toBeNull();expect(denied(()=>true)).toBeNull();
  await mount(true);expect(observed.readAuthority(()=>true)).not.toBeNull();expect(denied(()=>true)).toBeNull();
 });
 it('rejects hidden documents without relying on a visibility event',async()=>{
  await mount();expect(observed.readAuthority(()=>true)).not.toBeNull();vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');expect(observed.readAuthority(()=>true)).toBeNull();
 });
 it('rejects frozen lifetimes even when the document still reports visible',async()=>{
  await mount();expect(observed.readAuthority(()=>true)).not.toBeNull();await act(async()=>document.dispatchEvent(new Event('freeze')));
  expect(document.visibilityState).not.toBe('hidden');expect(observed.readAuthority(()=>true)).toBeNull();await act(async()=>document.dispatchEvent(new Event('resume')));expect(observed.readAuthority(()=>true)).not.toBeNull();
 });
 it('rejects a retained accessor after original owner closure',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();await act(async()=>root.unmount());unmounted=true;
  expect(probe.closes).toHaveBeenCalledOnce();expect(read(()=>true)).toBeNull();
 });
 it('sees the synchronous hook pending window before controller busy is published',async()=>{
  await mount();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  await act(async()=>{observed.run(async()=>pending);expect(probe.state.busy).toBe(false);expect(observed.readAuthority(()=>true)).toBeNull();});
  await act(async()=>release());expect(observed.readAuthority(()=>true)).not.toBeNull();
 });
 it('refuses an inactive owner while close awaits its original pending operation',async()=>{
  await mount();const read=observed.readAuthority;let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  await act(async()=>observed.run(async()=>pending));await act(async()=>root.unmount());unmounted=true;expect(probe.closes).not.toHaveBeenCalled();expect(read(()=>true)).toBeNull();
  await act(async()=>release());expect(probe.closes).toHaveBeenCalledOnce();expect(read(()=>true)).toBeNull();
 });
 it('preserves original run, dismiss and refresh ownership and advances its lifetime epoch',async()=>{
  await mount();const before=observed.readAuthority(()=>true)!,dismisses=probe.dismisses.mock.calls.length,loads=probe.loads.mock.calls.length,action=vi.fn(async()=>undefined);
  await act(async()=>observed.run(action));expect(action).toHaveBeenCalledOnce();await act(async()=>observed.dismiss());
  expect(probe.dismisses).toHaveBeenCalledTimes(dismisses+1);expect(probe.loads.mock.calls.length).toBeGreaterThan(loads);expect(observed.readAuthority(()=>true)!.lifecycleEpoch).toBeGreaterThan(before.lifecycleEpoch);expect(probe.controllers).toHaveBeenCalledOnce();
 });
 it('refuses a prior connection owner during render before its effect cleanup',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();const closed=probe.closes.mock.calls.length;let checked=false;
  probe.connection={};duringRender=()=>{if(checked)return;checked=true;expect(probe.closes).toHaveBeenCalledTimes(closed);expect(read(()=>true)).toBeNull();};
  await mount();expect(checked).toBe(true);expect(observed.readAuthority(()=>true)).not.toBeNull();expect(probe.controllers).toHaveBeenCalledTimes(2);
 });
 it('samples live gate after the panel predicate instead of trusting an earlier read',async()=>{
  await mount();expect(observed.readAuthority(()=>{probe.gate=false;return true;})).toBeNull();probe.gate=true;expect(observed.readAuthority(()=>true)).not.toBeNull();
 });
 it('rechecks the captured base generation after the synchronous panel predicate',async()=>{
  await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
  await act(async()=>{expect(read(()=>{useApp.setState({baseSelectionEpoch:useApp.getState().baseSelectionEpoch+1});return true;})).toBeNull();});
 });
 it('does not turn action eligibility or caller input typing into signing trust',async()=>{
  await mount();expect(observed.readAuthority(()=>true)).not.toBeNull();expect(observed.signingAllowed).toBe(false);
  expectTypeOf<Parameters<typeof useVehicle>[1]>().toEqualTypeOf<VehicleSigningTrust|null|undefined>();
  expectTypeOf<keyof VehicleSigningTrust>().toEqualTypeOf<'version'|'revision'|'core'|'operationalPolicyVersion'>();
  expectTypeOf<keyof VehicleSigningTrust['core']>().toEqualTypeOf<'expectedGenesisHash'|'reviewedDeploymentSlot'|'reviewedProgramDataSha256'|'upgradeAuthority'>();
 });
});
