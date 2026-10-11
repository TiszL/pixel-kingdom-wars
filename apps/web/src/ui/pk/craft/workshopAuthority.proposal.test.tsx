/** @vitest-environment happy-dom
 * Proposal contract: Cedar3 runs only after applying the separately reviewed
 * two-hook patch. The live lib files deliberately do not implement this yet.
 */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useApp} from '../../../state/store';
import {useWorkshop} from '../../../lib/workshop/useWorkshop';
import {useOrdinaryCrafting} from '../../../lib/ordinaryCrafting/useOrdinaryCrafting';
const probe=vi.hoisted(()=>({state:{loaded:true,busy:false,journal:null,review:null,error:null},gate:true,opens:vi.fn(async()=>undefined),refreshes:vi.fn(async()=>null),closes:vi.fn(async()=>undefined),dismisses:vi.fn()}));
vi.mock('../../../lib/mutationGate',()=>({mutationGate:{subscribe:()=>()=>undefined,getSnapshot:()=>probe.gate}}));
vi.mock('../../../lib/workshop/controller',()=>({WorkshopController:class {snapshot=()=>probe.state;subscribe=()=>()=>undefined;open=probe.opens;dismiss=probe.dismisses;}}));
vi.mock('../../../lib/ordinaryCrafting/controller',()=>({OrdinaryCraftingController:class {snapshot=()=>probe.state;subscribe=()=>()=>undefined;open=probe.opens;dismiss=probe.dismisses;}}));
vi.mock('../../../lib/workshop/journal',()=>({WorkshopJournalStore:class {identity={wallet:'wallet'};close=probe.closes;}}));
vi.mock('../../../lib/ordinaryCrafting/journal',()=>({OrdinaryCraftingJournalStore:class {identity={wallet:'wallet'};close=probe.closes;}}));
vi.mock('../../../lib/workshop/browser',()=>({workshopIdentity:(wallet:string)=>({wallet}),createWorkshopBrowserPorts:()=>({})}));
vi.mock('../../../lib/ordinaryCrafting/browser',()=>({ordinaryCraftingIdentity:(wallet:string)=>({wallet}),createOrdinaryCraftingBrowserPorts:()=>({})}));
vi.mock('../../../lib/workshop/snapshot',()=>({refreshWorkshopSnapshot:probe.refreshes}));
vi.mock('../../../lib/ordinaryCrafting/snapshot',()=>({refreshOrdinaryCraftingSnapshot:probe.refreshes}));
type Authority=Readonly<{state:Readonly<{loaded:boolean;busy:boolean}>;lifecycleEpoch:number;actionsAllowed:true}>;
type WithProposal={readAuthority:(isCurrentPanel?:()=>boolean)=>Authority|null};
let root:Root,host:HTMLDivElement,observed:(ReturnType<typeof useWorkshop>|ReturnType<typeof useOrdinaryCrafting>)&WithProposal,unmounted:boolean;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);probe.state={loaded:true,busy:false,journal:null,review:null,error:null};probe.gate=true;vi.clearAllMocks();
  host=document.createElement('div');document.body.append(host);root=createRoot(host);unmounted=false;
  useApp.getState().setAuth('11111111111111111111111111111111',true);useApp.getState().setSelectedBaseId('00000000-0000-4000-8000-000000000001',false);
});
afterEach(async()=>{if(!unmounted)await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe.each([['Workshop',useWorkshop],['OrdinaryCrafting',useOrdinaryCrafting]] as const)('%s proposed live authority',(_name,useOriginal)=>{
  // Stable component identity keeps the same original owner during capability changes.
  function Hook({actionsEnabled}:{actionsEnabled:boolean}){observed=useOriginal(actionsEnabled) as typeof observed;return null;}
  const mount=async(actionsEnabled=true)=>{await act(async()=>root.render(<Hook actionsEnabled={actionsEnabled}/>));};
  it('reads the actual controller synchronously without a request or journal operation',async()=>{
    await mount();const opens=probe.opens.mock.calls.length,refreshes=probe.refreshes.mock.calls.length,closes=probe.closes.mock.calls.length;
    expect(observed.readAuthority(()=>true)).toMatchObject({state:{loaded:true,busy:false},actionsAllowed:true});
    expect(probe.opens).toHaveBeenCalledTimes(opens);expect(probe.refreshes).toHaveBeenCalledTimes(refreshes);expect(probe.closes).toHaveBeenCalledTimes(closes);
  });
  it('is ineligible when no original controller exists',async()=>{useApp.getState().setAuth(null,false);await mount();expect(observed.readAuthority(()=>true)).toBeNull();});
  it('is ineligible when the original controller is not loaded or became busy before a render',async()=>{
    await mount();probe.state={...probe.state,loaded:false};expect(observed.readAuthority(()=>true)).toBeNull();
    probe.state={...probe.state,loaded:true,busy:true};expect(observed.readAuthority(()=>true)).toBeNull();
  });
  it('requires a current panel and refuses a missing or throwing panel guard',async()=>{
    await mount();expect(observed.readAuthority()).toBeNull();expect(observed.readAuthority(()=>false)).toBeNull();expect(observed.readAuthority(()=>{throw Error('stale');})).toBeNull();
  });
  it('rejects a stale wallet/base generation before React can rerender',async()=>{
    await mount();const read=observed.readAuthority;
    await act(async()=>{useApp.setState({baseSelectionEpoch:useApp.getState().baseSelectionEpoch+1});expect(read(()=>true)).toBeNull();});
    await act(async()=>{useApp.setState({wallet:'22222222222222222222222222222222'});expect(read(()=>true)).toBeNull();});
  });
  it('checks the live mutation gate and the explicit hook permission',async()=>{
    await mount();probe.gate=false;expect(observed.readAuthority(()=>true)).toBeNull();probe.gate=true;
    await mount(false);expect(observed.readAuthority(()=>true)).toBeNull();
  });
  it('rejects hidden and suspended lifetimes without opening anything',async()=>{
    await mount();vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');expect(observed.readAuthority(()=>true)).toBeNull();
    await act(async()=>document.dispatchEvent(new Event('freeze')));expect(observed.readAuthority(()=>true)).toBeNull();
  });
  it('rejects a closed owner even through a previously retained accessor',async()=>{
    await mount();const read=observed.readAuthority;await act(async()=>root.unmount());unmounted=true;expect(read(()=>true)).toBeNull();expect(probe.closes).toHaveBeenCalled();
  });
  it('covers the original hook pending window even before controller busy is published',async()=>{
    await mount();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
    await act(async()=>{observed.run(async()=>pending);expect(observed.readAuthority(()=>true)).toBeNull();});
    await act(async()=>release());expect(observed.readAuthority(()=>true)).not.toBeNull();
  });
  it('preserves the existing refresh and dismiss hooks',async()=>{
    await mount();const opens=probe.opens.mock.calls.length;await act(async()=>observed.refresh());expect(probe.opens.mock.calls.length).toBeGreaterThan(opens);
    await act(async()=>observed.dismiss());expect(probe.dismisses).toHaveBeenCalled();
  });
  it('changes only the wallet on a fresh mounted owner',async()=>{
    await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
    await act(async()=>{useApp.setState({wallet:'22222222222222222222222222222222'});expect(read(()=>true)).toBeNull();});
  });
  it('checks live authentication before React cleanup can mask the guard',async()=>{
    await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
    await act(async()=>{useApp.setState({authed:false});expect(read(()=>true)).toBeNull();});
  });
  it('checks a changed screen before any owner cleanup',async()=>{
    await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
    await act(async()=>{useApp.setState({screen:useApp.getState().screen==='base'?'map':'base'});expect(read(()=>true)).toBeNull();});
  });
  it('rejects a frozen lifecycle while document visibility remains unchanged',async()=>{
    await mount();expect(document.visibilityState).not.toBe('hidden');expect(observed.readAuthority(()=>true)).not.toBeNull();
    await act(async()=>document.dispatchEvent(new Event('freeze')));
    expect(document.visibilityState).not.toBe('hidden');expect(observed.readAuthority(()=>true)).toBeNull();
  });
  it('a retained allowed accessor observes a revoked capability after pending has drained',async()=>{
    await mount();const read=observed.readAuthority;expect(read(()=>true)).not.toBeNull();
    await mount(false);expect(observed.state.busy).toBe(false);
    expect(probe.state).toMatchObject({loaded:true,busy:false});expect(probe.gate).toBe(true);expect(read(()=>true)).toBeNull();
    await mount(true);expect(observed.readAuthority(()=>true)).not.toBeNull();
  });
  it('rejects an inactive owner while close is still waiting for its pending action',async()=>{
    await mount();let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});const read=observed.readAuthority;
    await act(async()=>observed.run(async()=>pending));await act(async()=>root.unmount());unmounted=true;
    expect(probe.closes).not.toHaveBeenCalled();expect(read(()=>true)).toBeNull();
    await act(async()=>release());expect(probe.closes).toHaveBeenCalled();expect(read(()=>true)).toBeNull();
  });
  it('requires a literal true panel guard and rejects truthy asynchronous results',async()=>{
    await mount();expect(observed.readAuthority(()=>Promise.resolve(false) as unknown as boolean)).toBeNull();
    expect(observed.readAuthority(()=>({}) as unknown as boolean)).toBeNull();expect(observed.readAuthority(()=>true)).not.toBeNull();
  });

});
