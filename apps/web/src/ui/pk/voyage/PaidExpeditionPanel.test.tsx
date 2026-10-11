/** @vitest-environment happy-dom */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fmtDur} from '@shardkeep/shared';
import {VoyageTerms} from './VoyageAdapterFrame';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {useApp} from '../../../state/store';
import {useStarterExpedition} from '../../../lib/starterExpedition/useStarterExpedition';
import {usePaidStarterExpeditionView} from '../../../lib/paidStarterExpeditions/usePaidStarterExpeditionView';
import {view,identity,id,start} from '../../../lib/starterExpedition/fixtures.test-support';
import type {BaseFeatureProps} from '../featureRegistry';
import PaidExpeditionPanel from './PaidExpeditionPanel';
import {voyageFeatures} from './features';
vi.mock('../../../lib/starterExpedition/useStarterExpedition',()=>({useStarterExpedition:vi.fn()}));
vi.mock('../../../lib/paidStarterExpeditions/usePaidStarterExpeditionView',()=>({usePaidStarterExpeditionView:vi.fn()}));
let root:Root,host:HTMLDivElement,props:BaseFeatureProps,hook:ReturnType<typeof useStarterExpedition>;
let controller:{beginPaidDeparture:ReturnType<typeof vi.fn>;confirm:ReturnType<typeof vi.fn>;reviewCommand:ReturnType<typeof vi.fn>;open:ReturnType<typeof vi.fn>};
const paidRoute=paidStarterRoutePreview('paid_frostveil');
const command={...start,route:paidRoute,request:{...start.request,routeId:paidRoute.routeId,routeVersion:paidRoute.routeCatalogueVersion,rewardVersion:paidRoute.rewardTableVersion}};
const render=()=>act(async()=>root.render(<PaidExpeditionPanel {...props}/>));
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===label)!;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);
  useApp.getState().setAuth(identity.wallet,true);useApp.getState().setSelectedBaseId(id(1),false);
  controller={beginPaidDeparture:vi.fn(async()=>undefined),confirm:vi.fn(async()=>undefined),reviewCommand:vi.fn(async()=>undefined),open:vi.fn(async()=>undefined)};
  hook={state:{loaded:true,busy:false,journal:null,review:null,error:null},snapshot:{view:view(),balances:{keep:'0',shards:'0',keepRate:1},enabled:true},refreshError:null,actionsAllowed:true,run:vi.fn(action=>{void action(controller as never);}),refresh:vi.fn(),dismiss:vi.fn(),finish:vi.fn()};
  vi.mocked(useStarterExpedition).mockImplementation(enabled=>({...hook,actionsAllowed:enabled&&hook.actionsAllowed}));
  vi.mocked(usePaidStarterExpeditionView).mockReturnValue({view:{wallet:identity.wallet,baseId:id(1),realm:0,serverNow:view().serverNow,authorization:'none',acceptingDepartures:true,route:paidRoute,coverage:{status:'covered',observedAt:view().serverNow,expiresAt:'1999999999'}},loading:false,error:null,refresh:vi.fn()});
  props={actionsEnabled:true,panel:{kind:'voyage',featureId:'voyage.paidExpedition'},onClose:vi.fn(),session:{dispatch:vi.fn((_kind,action)=>{action();return true;}),setDismissPolicy:vi.fn(()=>()=>undefined)}};
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('mount only reads and explicitly says there is no additional departure payment',async()=>{
  await render();expect(controller.beginPaidDeparture).not.toHaveBeenCalled();expect(controller.confirm).not.toHaveBeenCalled();expect(host.textContent).toContain('No additional currency payment');
});
it('review uses the selected realm, then confirmation uses the saved original',async()=>{
  await render();const select=host.querySelector<HTMLSelectElement>('select')!;
  await act(async()=>{select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(button('REVIEW DEPARTURE').disabled).toBe(false);await act(async()=>button('REVIEW DEPARTURE').click());expect(controller.beginPaidDeparture).toHaveBeenCalledWith(id(1),0);expect(controller.confirm).not.toHaveBeenCalled();
  hook.state={...hook.state,journal:{version:1,identity,revision:1,archives:[],operation:{command,attemptRevision:null,proof:null,refusal:null}},review:{command,view:view()}};
  await render();expect(button('CONFIRM DEPARTURE').disabled).toBe(false);await act(async()=>button('CONFIRM DEPARTURE').click());expect(controller.confirm).toHaveBeenCalledOnce();
});
it('an uncertain paid attempt stays GET-only even if an obsolete review is present',async()=>{
  hook.state={...hook.state,journal:{version:1,identity,revision:2,archives:[],operation:{command,attemptRevision:2,proof:null,refusal:null}},review:{command,view:view()}};
  await render();expect(button('CONFIRM DEPARTURE')).toBeUndefined();await act(async()=>button('CHECK ORIGINAL RECEIPT').click());expect(controller.open).toHaveBeenCalledOnce();expect(controller.confirm).not.toHaveBeenCalled();
});
it('a denied host session never reaches the original controller',async()=>{
  props.session.dispatch=vi.fn(()=>false);await render();await act(async()=>button('REFRESH').click());expect(hook.refresh).not.toHaveBeenCalled();
});
it('busy dismissal cancels and idle dismissal clears consent before the host continuation',async()=>{
  hook.state.busy=true;await render();const proceed=vi.fn(()=>true),cancel=vi.fn();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed,cancel});expect(cancel).toHaveBeenCalledOnce();expect(proceed).not.toHaveBeenCalled();
  hook.state={...hook.state,busy:false};await render();vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0]({reason:'close',proceed});expect(hook.dismiss).toHaveBeenCalled();expect(proceed).toHaveBeenCalledOnce();
});
it('the paid feature has the exact reserved id and keeps mutation held pending its live bridge',()=>{
  const feature=voyageFeatures.find(f=>f.id==='voyage.paidExpedition')!;expect(feature).toMatchObject({kind:'voyage',size:'TALL',readOnly:false,dismissal:'controller'});expect(feature.canMutate!(props.panel)).toBe(false);expect(typeof feature.load).toBe('function');
});

it('keeps every departure review and confirm behind mutate while GET recovery remains available',async()=>{
  props.session.dispatch=vi.fn((kind,action)=>{if(kind==='mutate')return false;action();return true;});
  await render();const select=host.querySelector<HTMLSelectElement>('select')!;
  await act(async()=>{select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(button('REVIEW DEPARTURE').disabled).toBe(false);await act(async()=>button('REVIEW DEPARTURE').click());expect(controller.beginPaidDeparture).not.toHaveBeenCalled();expect(host.textContent).toContain('New departures are paused');
  hook.state={...hook.state,journal:{version:1,identity,revision:1,archives:[],operation:{command,attemptRevision:null,proof:null,refusal:null}},review:null};
  await render();expect(button('REVIEW ORIGINAL').disabled).toBe(false);await act(async()=>button('REVIEW ORIGINAL').click());expect(controller.reviewCommand).not.toHaveBeenCalled();
  hook.state={...hook.state,review:{command,view:view()}};await render();expect(button('CONFIRM DEPARTURE').disabled).toBe(false);await act(async()=>button('CONFIRM DEPARTURE').click());expect(controller.confirm).not.toHaveBeenCalled();
  await act(async()=>button('CHECK ORIGINAL RECEIPT').click());expect(controller.open).toHaveBeenCalledOnce();
  expect(props.session.dispatch).toHaveBeenCalledWith('mutate',expect.any(Function));expect(props.session.dispatch).toHaveBeenCalledWith('recover',expect.any(Function));
});
it('never confirms a draft from a non-selected original kingdom',async()=>{
  hook.state={...hook.state,journal:{version:1,identity,revision:1,archives:[],operation:{command,attemptRevision:null,proof:null,refusal:null}},review:{command,view:view()}};
  useApp.getState().setSelectedBaseId(id(9),false);await render();expect(button('CONFIRM DEPARTURE').disabled).toBe(true);
  await act(async()=>button('CONFIRM DEPARTURE').click());expect(controller.confirm).not.toHaveBeenCalled();
  await act(async()=>button('CHECK ORIGINAL RECEIPT').click());expect(controller.open).toHaveBeenCalledOnce();
});
it('a destination change clears original consent and changes the advisory epoch',async()=>{
  await render();const select=host.querySelector<HTMLSelectElement>('select')!;
  await act(async()=>{select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(hook.dismiss).toHaveBeenCalledOnce();expect(usePaidStarterExpeditionView).toHaveBeenLastCalledWith(id(1),0,1);
  await act(async()=>{select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(hook.dismiss).toHaveBeenCalledTimes(2);expect(usePaidStarterExpeditionView).toHaveBeenLastCalledWith(id(1),1,2);expect(controller.confirm).not.toHaveBeenCalled();
});
it('renders shared duration, fitting, original versions and exact companion cargo',async()=>{
  const route={...paidRoute,durationSec:93_661,routeCatalogueVersion:7,rewardTableVersion:8,fitting:{itemId:'survey_lens',policyVersion:9},secondaryOutput:{resourceId:'frost_quartz',grossQuantity:'9007199254740995',islandPoolQuantity:'2',netQuantity:'9007199254740993'}};
  await act(async()=>root.render(<VoyageTerms route={route}/>));
  expect(host.textContent).toContain(fmtDur(route.durationSec));expect(host.textContent).not.toContain('seconds');
  expect(host.textContent).toContain('Survey Lens');expect(host.textContent).toContain('Fitting policy 9');expect(host.textContent).toContain('Route version 7');expect(host.textContent).toContain('Reward version 8');
  expect(host.querySelector('[aria-label="Companion cargo"]')?.textContent).toContain('9,007,199,254,740,993');
  await act(async()=>root.render(<VoyageTerms route={paidRoute}/>));expect(host.querySelector('[aria-label="Companion cargo"]')).toBeNull();
});
it('passes live host capability to the original hook and denies an omitted capability',async()=>{
  await render();expect(useStarterExpedition).toHaveBeenLastCalledWith(true);
  props={...props,actionsEnabled:false};await render();expect(useStarterExpedition).toHaveBeenLastCalledWith(false);expect(host.textContent).toContain('New departures are paused');
  const missingCapability={panel:props.panel,onClose:props.onClose,session:props.session};
  await act(async()=>{
    // @ts-expect-error H-2 requires the live host capability; deliberately probe an untyped omission.
    root.render(<PaidExpeditionPanel {...missingCapability}/>);
  });expect(useStarterExpedition).toHaveBeenLastCalledWith(false);
});

it('does not report policyVersion as a missing route catalogue version',async()=>{
  const {routeCatalogueVersion:_route,rewardTableVersion:_reward,...route}=paidRoute;
  await act(async()=>root.render(<VoyageTerms route={{...route,policyVersion:17}}/>));
  expect(host.textContent).toContain('Route version unknown');expect(host.textContent).toContain('Reward version unknown');expect(host.textContent).toContain('Route policy 17');expect(host.textContent).not.toContain('Route version 17');
});
it('drops the refused-dispatch notice after original paid capability changes',async()=>{
  // Destination selection is a read; refuse only the mutation under test.
  props.session.dispatch=vi.fn((kind,action)=>{if(kind==='mutate')return false;action();return true;});await render();const select=host.querySelector<HTMLSelectElement>('select')!;
  await act(async()=>{select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(hook.dismiss).toHaveBeenCalledOnce();expect(usePaidStarterExpeditionView).toHaveBeenLastCalledWith(id(1),0,1);
  expect(button('REVIEW DEPARTURE').disabled).toBe(false);await act(async()=>button('REVIEW DEPARTURE').click());expect(host.textContent).toContain('New departures are paused');expect(controller.beginPaidDeparture).not.toHaveBeenCalled();expect(props.session.dispatch).toHaveBeenCalledWith('mutate',expect.any(Function));
  hook.actionsAllowed=false;await render();hook.actionsAllowed=true;await render();expect(host.textContent).not.toContain('New departures are paused');
});
