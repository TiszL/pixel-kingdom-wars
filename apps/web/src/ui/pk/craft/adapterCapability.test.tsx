/** @vitest-environment happy-dom
 * Real original hooks/controllers/journals; synthetic transport only. Cedar3 runs.
 * No wallet, API or network request is made by this fixture.
 */
import {act,type ComponentType} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {useApp} from '../../../state/store';
import {useWorkshop} from '../../../lib/workshop/useWorkshop';
import {useOrdinaryCrafting} from '../../../lib/ordinaryCrafting/useOrdinaryCrafting';
import {useStarterExpedition} from '../../../lib/starterExpedition/useStarterExpedition';
import type {WorkshopPorts} from '../../../lib/workshop/controller';
import type {OrdinaryCraftingPorts} from '../../../lib/ordinaryCrafting/controller';
import type {StarterExpeditionPorts} from '../../../lib/starterExpedition/controller';
import * as ingot from '../../../lib/workshop/fixtures.test-support';
import * as ordinary from '../../../lib/ordinaryCrafting/fixtures.test-support';
import * as starter from '../../../lib/starterExpedition/fixtures.test-support';

type Kind='ingots'|'ordinary'|'paid';
type Input={lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}};
const probe=vi.hoisted(()=>({makePorts:null as unknown as (kind:Kind,input:Input)=>unknown}));
vi.mock('../../../lib/mutationGate',()=>({mutationGate:{subscribe:()=>()=>undefined,getSnapshot:()=>true}}));
vi.mock('../../../lib/workshop/browser',()=>({workshopIdentity:(wallet:string)=>({origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet}),createWorkshopBrowserPorts:(input:Input)=>probe.makePorts('ingots',input)}));
vi.mock('../../../lib/ordinaryCrafting/browser',()=>({ordinaryCraftingIdentity:(wallet:string)=>({origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet}),createOrdinaryCraftingBrowserPorts:(input:Input)=>probe.makePorts('ordinary',input)}));
vi.mock('../../../lib/starterExpedition/browser',()=>({starterExpeditionIdentity:(wallet:string)=>({origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet}),createStarterExpeditionBrowserPorts:(input:Input)=>probe.makePorts('paid',input)}));
vi.mock('../../../lib/workshop/snapshot',()=>({refreshWorkshopSnapshot:vi.fn(async()=>null)}));
vi.mock('../../../lib/ordinaryCrafting/snapshot',()=>({refreshOrdinaryCraftingSnapshot:vi.fn(async()=>null)}));
vi.mock('../../../lib/starterExpedition/snapshot',()=>({refreshStarterExpeditionSnapshot:vi.fn(async()=>null)}));
// Poll outside a long-lived act: each attempt flushes queued React updates
// before inspecting rendered state; the original idle/consent assertions remain.
const waitForRendered=(assertion:()=>void)=>vi.waitFor(async()=>{await act(async()=>{});assertion();});
let observed:{state:{loaded:boolean;busy:boolean;review:unknown};begin:()=>void;confirm:()=>void};
function Ingots({enabled}:{enabled:boolean}){const original=useWorkshop(enabled);observed={state:original.state,begin:()=>original.run(c=>c.beginStart(ingot.id(1),1,ingot.view().recipeVersion)),confirm:()=>original.run(c=>c.confirm())};return null;}
function Ordinary({enabled}:{enabled:boolean}){const original=useOrdinaryCrafting(enabled);observed={state:original.state,begin:()=>original.run(c=>c.beginStart(ordinary.id(1),ordinary.start.request.recipeId,1)),confirm:()=>original.run(c=>c.confirm())};return null;}
function Paid({enabled}:{enabled:boolean}){const original=useStarterExpedition(enabled);observed={state:original.state,begin:()=>original.run(c=>c.beginPaidDeparture(starter.id(1),0)),confirm:()=>original.run(c=>c.confirm())};return null;}
const components:Record<Kind,ComponentType<{enabled:boolean}>>={ingots:Ingots,ordinary:Ordinary,paid:Paid};
let root:Root,host:HTMLDivElement,enqueued:ReturnType<typeof vi.fn<()=>void>>,entered:ReturnType<typeof starter.deferred>,release:ReturnType<typeof starter.deferred>,completed:ReturnType<typeof starter.deferred>;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  useApp.getState().setAuth(starter.identity.wallet,true);useApp.getState().setSelectedBaseId(starter.id(1),false);
  enqueued=vi.fn();entered=starter.deferred();release=starter.deferred();completed=starter.deferred();
  const paidRoute=paidStarterRoutePreview('paid_frostveil');
  const paidCommand={...starter.start,route:paidRoute,request:{...starter.start.request,routeId:paidRoute.routeId,routeVersion:paidRoute.routeCatalogueVersion,rewardVersion:paidRoute.rewardTableVersion}};
  probe.makePorts=(kind,input)=>{
    const common={capture:(baseId?:string)=>{
      const epoch=input.lifecycle().epoch;
      return ()=>{const page=input.lifecycle();if(!page.active||!page.visible||page.epoch!==epoch||baseId!==undefined&&!page.actionsEnabled)throw new Error('Host capability or original lifecycle changed');};
    },lock:async<T,>(_name:string,run:()=>Promise<T>)=>run(),key:()=>kind==='ingots'?ingot.start.request.idempotencyKey:starter.id(2)};
    const enqueue=async(guard:()=>void)=>{entered.resolve();await release.promise;try{guard();enqueued();}finally{completed.resolve();}};
    if(kind==='ingots')return {...common,clock:()=>({elapsed:0,wall:0}),get:async(path,guard)=>{guard();return path.includes('/by-key/')?ingot.proof(ingot.start):ingot.view();},post:async(_path,_body,guard)=>{await enqueue(guard);return ingot.proof(ingot.start,true);}} satisfies WorkshopPorts;
    if(kind==='ordinary')return {...common,get:async(path,guard)=>{guard();return path.startsWith('/base?')?ordinary.base():ordinary.view();},getProof:async(request,guard,retain)=>{guard();const proof=ordinary.proof({...ordinary.start,request});await retain(proof);return proof;},post:async(_request,guard,retain)=>{await enqueue(guard);const proof=ordinary.proof(ordinary.start,true);await retain(proof);return proof;}} satisfies OrdinaryCraftingPorts;
    return {...common,get:async(path,guard)=>{guard();return path.includes('/paid-route?')?{wallet:starter.identity.wallet,baseId:starter.id(1),realm:0,serverNow:starter.now,authorization:'none',acceptingDepartures:true,route:paidRoute,coverage:{status:'covered',observedAt:starter.now,expiresAt:'1999999999'}}:starter.view();},getProof:async(request,guard,retain)=>{guard();const proof=starter.proof({...paidCommand,request});await retain(proof);return proof;},post:async(_request,guard,retain)=>{await enqueue(guard);const proof=starter.proof(paidCommand,true);await retain(proof);return proof;}} satisfies StarterExpeditionPorts;
  };
});
afterEach(async()=>{release.resolve();await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe.each(['ingots','ordinary','paid'] as const)('%s original mid-action capability',kind=>{
  it('the unchanged original path enqueues exactly once while its capability stays live',async()=>{
    const Hook=components[kind];await act(async()=>root.render(<Hook enabled/>));
    await waitForRendered(()=>expect(observed.state).toMatchObject({loaded:true,busy:false}));
    await act(async()=>observed.begin());
    await waitForRendered(()=>{expect(observed.state.busy).toBe(false);expect(observed.state.review).not.toBeNull();});
    await act(async()=>{observed.confirm();await entered.promise;});
    expect(enqueued).not.toHaveBeenCalled();
    await act(async()=>{release.resolve();await completed.promise;});
    expect(enqueued).toHaveBeenCalledOnce();
  });
  it('revocation reaches the existing lifecycle and prevents a waiting POST enqueue',async()=>{
    const Hook=components[kind];await act(async()=>root.render(<Hook enabled/>));
    await waitForRendered(()=>expect(observed.state).toMatchObject({loaded:true,busy:false}));
    await act(async()=>observed.begin());
    await waitForRendered(()=>{expect(observed.state.busy).toBe(false);expect(observed.state.review).not.toBeNull();});
    await act(async()=>{observed.confirm();await entered.promise;});
    await act(async()=>root.render(<Hook enabled={false}/>));
    await act(async()=>{release.resolve();await completed.promise;});
    expect(enqueued).not.toHaveBeenCalled();expect(observed.state.review).toBeNull();
  });
});
