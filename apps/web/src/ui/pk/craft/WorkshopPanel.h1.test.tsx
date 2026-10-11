/** @vitest-environment happy-dom
 * H1 consumer: real grant, original ordinary hook/controller/IndexedDB journal.
 * Synthetic transport only; tests are authored/unrun for Cedar3.
 */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {configureBasePanels,useApp,type BaseStateDto} from '../../../state/store';
import {hasBuildingActivityAccess,requestOrdinaryCraftingPanel} from '../../../lib/phaseEActivity/access';
import {ORDINARY_CRAFTING_PANEL} from '../../../lib/phaseEActivity/panelIds';
import type {OrdinaryCraftingPorts} from '../../../lib/ordinaryCrafting/controller';
import * as ordinary from '../../../lib/ordinaryCrafting/fixtures.test-support';
import {useWorkshop} from '../../../lib/workshop/useWorkshop';
import {createBaseFeatureRegistry,type BaseFeatureProps} from '../featureRegistry';
import WorkshopPanel from './WorkshopPanel';
import {craftFeatures} from './features';

type Input={lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}};
const probe=vi.hoisted(()=>({makePorts:null as unknown as (input:Input)=>OrdinaryCraftingPorts}));
vi.mock('../../../lib/mutationGate',()=>({mutationGate:{subscribe:()=>()=>undefined,getSnapshot:()=>true}}));
vi.mock('../../../lib/ordinaryCrafting/browser',()=>({ordinaryCraftingIdentity:(wallet:string)=>({origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet}),createOrdinaryCraftingBrowserPorts:(input:Input)=>probe.makePorts(input)}));
vi.mock('../../../lib/ordinaryCrafting/snapshot',()=>({refreshOrdinaryCraftingSnapshot:vi.fn(async()=>({view:ordinary.view(),balances:{keep:'0',shards:'10000',keepRate:1},workshopLevel:1,enabled:true}))}));
vi.mock('../../../lib/workshop/useWorkshop',()=>({useWorkshop:vi.fn()}));

const building={id:'h1-workshop',type:'workshop',level:1,tx:1,ty:1,underConstruction:false};
// Test-only registration admits navigation; production craftFeatures stays held.
const registry=()=>createBaseFeatureRegistry(craftFeatures);
let root:Root,host:HTMLDivElement,props:BaseFeatureProps,configured:ReturnType<typeof registry>;
let entered:ReturnType<typeof ordinary.deferred>,release:ReturnType<typeof ordinary.deferred>,completed:ReturnType<typeof ordinary.deferred>;
let enqueued:ReturnType<typeof vi.fn<(request:unknown)=>void>>,denied:ReturnType<typeof vi.fn<()=>void>>,created:ReturnType<typeof vi.fn<()=>void>>,readProof:ReturnType<typeof vi.fn<(request:unknown)=>void>>;
const button=(label:string)=>[...host.querySelectorAll('button')].find(node=>node.textContent?.trim()===label);
const render=()=>act(async()=>root.render(<WorkshopPanel {...props}/>));
// Poll outside a long-lived act: each attempt flushes queued React updates
// before inspecting rendered state; the original idle/consent assertions remain.
const waitForRendered=(assertion:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});assertion();});
const idle=()=>waitForRendered(()=>expect(button('REFRESH')?.disabled).toBe(false));
function openGrant(){
 const settled=vi.fn();requestOrdinaryCraftingPanel(building.id).onSettled(settled);
 expect(settled).toHaveBeenCalledExactlyOnceWith({status:'fulfilled',value:{outcome:'opened'}});
 expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
 props={...props,panel:useApp.getState().basePanel!};
}
async function review(){
 openGrant();await render();await idle();
 await act(async()=>host.querySelector<HTMLButtonElement>('[data-recipe-id="refine_frostglass"]')!.click());
 expect(button('REVIEW REFINING')!.disabled).toBe(false);
 await act(async()=>button('REVIEW REFINING')!.click());
 await waitForRendered(()=>expect(button('CONFIRM REFINING')?.disabled).toBe(false));
 expect(created).toHaveBeenCalledOnce();expect(enqueued).not.toHaveBeenCalled();
}
async function revoke(kind:'grant'|'host'){
 const before=useApp.getState();
 if(kind==='grant'){
  // No root.render, base-id subscription update, owner unmount, or hook mock.
  // Only the library's external-store grant notification can update this panel.
  await act(async()=>useApp.setState({selectedBuildingId:null}));
  expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  await act(async()=>useApp.setState({selectedBuildingId:building.id}));
  expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
 }else{
  configureBasePanels(configured,false);
  // N2: configureBasePanels with the same registry leaves the grant untouched.
  expect(useApp.getState()).toBe(before);
  expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
  props={...props,actionsEnabled:false};await render();
 }
 expect(useApp.getState().wallet).toBe(before.wallet);
 expect(useApp.getState().selectedBaseId).toBe(before.selectedBaseId);
 expect(useApp.getState().baseSelectionEpoch).toBe(before.baseSelectionEpoch);
 expect(useApp.getState().basePanel).toBe(before.basePanel);
 expect(created).toHaveBeenCalledOnce();
 expect(host.textContent).toContain('Orders are paused');
}
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
 vi.stubEnv('VITE_PHASE_E_WEB_ENABLED','1');
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 useApp.getState().setAuth(null);
 useApp.setState({authed:true,wallet:ordinary.identity.wallet,selectedBaseId:ordinary.id(1),baseSelectionEpoch:7,base:{baseId:ordinary.id(1),buildings:[building]} as BaseStateDto,screen:'base',basePanel:null,selectedBuildingId:building.id,placing:null});
 configured=registry();configureBasePanels(configured,true);
 props={actionsEnabled:true,panel:{...ORDINARY_CRAFTING_PANEL,buildingId:building.id},onClose:vi.fn(),session:{dispatch:vi.fn((_kind,action)=>{action();return true;}),setDismissPolicy:vi.fn(()=>()=>undefined)}};
 vi.mocked(useWorkshop).mockReturnValue({state:{loaded:true,busy:false,journal:null,review:null,error:null},actionsAllowed:false,snapshot:null,refreshError:null,run:vi.fn(),refresh:vi.fn(),dismiss:vi.fn()});
 entered=ordinary.deferred();release=ordinary.deferred();completed=ordinary.deferred();
 enqueued=vi.fn();denied=vi.fn();created=vi.fn();readProof=vi.fn();
 probe.makePorts=input=>{
  created();
  return {
   capture:(baseId?:string)=>{const epoch=input.lifecycle().epoch;return ()=>{const page=input.lifecycle();if(!page.active||!page.visible||page.epoch!==epoch||baseId!==undefined&&!page.actionsEnabled)throw new Error('Original lifecycle or capability changed');};},
   lock:async<T,>(_name:string,run:()=>Promise<T>)=>run(),key:()=>ordinary.id(2),
   get:async(path,guard)=>{guard();return path.startsWith('/base?')?ordinary.base():ordinary.view();},
   getProof:async(request,guard,retain)=>{guard();readProof(request);const proof=ordinary.proof({...ordinary.start,request});await retain(proof);return proof;},
   post:async(request,guard,retain)=>{entered.resolve();await release.promise;try{try{guard();}catch(error){denied();throw error;}enqueued(request);const proof=ordinary.proof({...ordinary.start,request},true);await retain(proof);return proof;}finally{completed.resolve();}},
  } satisfies OrdinaryCraftingPorts;
 };
});
afterEach(async()=>{
 release.resolve();await act(async()=>root.unmount());host.remove();useApp.getState().setAuth(null);configureBasePanels({},false);
 vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
});
it('a valid host capability AND minted grant reaches the one original POST path after explicit confirmation',async()=>{
 await review();await act(async()=>{button('CONFIRM REFINING')!.click();await entered.promise;});
 await act(async()=>{release.resolve();await completed.promise;});
 expect(enqueued).toHaveBeenCalledExactlyOnceWith(ordinary.start.request);expect(denied).not.toHaveBeenCalled();
 expect(created).toHaveBeenCalledOnce();expect(props.session.dispatch).toHaveBeenCalledWith('mutate',expect.any(Function));
});
it('direct destination restoration without a grant cannot begin an ordinary command',async()=>{
 useApp.setState({basePanel:props.panel});await render();await idle();
 expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
 await act(async()=>host.querySelector<HTMLButtonElement>('[data-recipe-id="refine_frostglass"]')!.click());
 // The PK kit's DISABLED primary stays tappable to explain its reason (Chunky: `disabled` only while BUSY, aria-disabled
 // when explaining), so `.disabled` is never true here; pin the refusal the kit's way (as BuildingInfoSheet.test does).
 expect(button('REVIEW REFINING')!.getAttribute('aria-disabled')).toBe('true');
 await act(async()=>button('REVIEW REFINING')!.click());
 expect(props.session.dispatch).not.toHaveBeenCalledWith('mutate',expect.any(Function));expect(enqueued).not.toHaveBeenCalled();
});
describe.each(['grant','host'] as const)('retained Workshop owner loses %s',kind=>{
 it('dismisses existing consent while preserving original receipt recovery',async()=>{
  await review();await revoke(kind);await idle();
  expect(button('CONFIRM REFINING')).toBeUndefined();expect(button('REVIEW ORIGINAL REQUEST')!.disabled).toBe(true);
  expect(button('CHECK ORIGINAL RECEIPT')!.disabled).toBe(false);readProof.mockClear();
  await act(async()=>button('CHECK ORIGINAL RECEIPT')!.click());await idle();
  expect(readProof).toHaveBeenCalledWith(ordinary.start.request);expect(props.session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));
  expect(enqueued).not.toHaveBeenCalled();expect(created).toHaveBeenCalledOnce();
 });
 it('refuses transport enqueue when capability is lost during the original pre-POST await',async()=>{
  await review();await act(async()=>{button('CONFIRM REFINING')!.click();await entered.promise;});
  await revoke(kind);await act(async()=>{release.resolve();await completed.promise;});
  expect(denied).toHaveBeenCalledOnce();expect(enqueued).not.toHaveBeenCalled();
  expect(button('CONFIRM REFINING')).toBeUndefined();expect(created).toHaveBeenCalledOnce();
 });
});
