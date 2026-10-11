/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../../../state/store';
import { useWorkshop } from '../../../lib/workshop/useWorkshop';
import { useOrdinaryCrafting } from '../../../lib/ordinaryCrafting/useOrdinaryCrafting';
import { view as ordinaryView, identity, id, start } from '../../../lib/ordinaryCrafting/fixtures.test-support';
import {useBuildingActivityAccess} from '../../../lib/phaseEActivity/access';
import { view as ingotView, start as ingotStart } from '../../../lib/workshop/fixtures.test-support';
import type { BaseFeatureProps } from '../featureRegistry';
import WorkshopPanel from './WorkshopPanel';
import { craftFeatures } from './features';
import { ORDINARY_CRAFTING_PANEL } from '../../../lib/phaseEActivity/panelIds';

vi.mock('../../../lib/phaseEActivity/access',()=>({useBuildingActivityAccess:vi.fn(()=>true)}));
vi.mock('../../../lib/workshop/useWorkshop', () => ({ useWorkshop: vi.fn() }));
vi.mock('../../../lib/ordinaryCrafting/useOrdinaryCrafting', () => ({ useOrdinaryCrafting: vi.fn() }));
let host: HTMLDivElement, root: Root, props: BaseFeatureProps;
let ordinary: ReturnType<typeof useOrdinaryCrafting>, ingots: ReturnType<typeof useWorkshop>;
let controller: { beginStart: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const render = () => act(async () => root.render(<WorkshopPanel {...props} />));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false);
  controller = { beginStart: vi.fn(async () => undefined), confirm: vi.fn(async () => undefined), open: vi.fn(async () => undefined) };
  vi.mocked(useBuildingActivityAccess).mockReturnValue(true);
  props = { actionsEnabled:true, panel: { kind: 'craft', featureId: 'craft.workshop' }, onClose: vi.fn(), session: { dispatch: vi.fn((_kind, action) => { action(); return true; }), setDismissPolicy: vi.fn(() => () => undefined) } };
  const state = { loaded: true, busy: false, journal: null, review: null, error: null };
  ordinary = { state, actionsAllowed: true, snapshot: { view: ordinaryView(), balances: { keep: '0', shards: '10000', keepRate: 1 }, workshopLevel: 1, enabled: true }, refreshError: null, run: vi.fn(action => { void action(controller as never); }), refresh: vi.fn(), dismiss: vi.fn(), finish: vi.fn() };
  ingots = { state: { ...state }, actionsAllowed: true, snapshot: { view: ingotView(), balances: { keep: '0', shards: '10000', keepRate: 1 }, enabled: true }, refreshError: null, run: vi.fn(), refresh: vi.fn(), dismiss: vi.fn() };
  // No ready ingot takes precedence in this test's initial REFINE tab.
  ingots.snapshot!.view.jobs = [];
  vi.mocked(useOrdinaryCrafting).mockImplementation(enabled => ({...ordinary,actionsAllowed:enabled&&ordinary.actionsAllowed})); vi.mocked(useWorkshop).mockImplementation(enabled => ({...ingots,actionsAllowed:enabled&&ingots.actionsAllowed}));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('mount and refresh do not submit or confirm a command', async () => {
  await render(); expect(controller.beginStart).not.toHaveBeenCalled(); expect(controller.confirm).not.toHaveBeenCalled();
  await act(async () => button('REFRESH')!.click()); expect(ordinary.refresh).toHaveBeenCalled(); expect(controller.confirm).not.toHaveBeenCalled();
});
it('review and confirmation remain separate explicit actions with the original recipe', async () => {
  await render();
  const choice = host.querySelector<HTMLButtonElement>('[data-recipe-id="refine_frostglass"]')!;
  await act(async () => choice.click()); await act(async () => button('REVIEW REFINING')!.click());
  expect(controller.beginStart).toHaveBeenCalledWith(id(1), 'refine_frostglass', 1); expect(controller.confirm).not.toHaveBeenCalled();
  ordinary.state = { ...ordinary.state, journal: { version: 1, identity, revision: 1, archives: [], operation: { command: start, attemptRevision: null, proof: null, refusal: null } }, review: { command: start, view: ordinary.snapshot!.view } };
  await render(); await act(async () => button('CONFIRM REFINING')!.click());
  expect(controller.confirm).toHaveBeenCalledOnce(); expect(props.session.dispatch).toHaveBeenCalledWith('mutate', expect.any(Function));
});
it('saved uncertain outcomes keep CHECK available and never implicitly resend', async () => {
  ordinary.state = { ...ordinary.state, journal: { version: 1, identity, revision: 2, archives: [], operation: { command: start, attemptRevision: 2, proof: null, refusal: null } } };
  await render(); expect(host.textContent).toContain('outcome is being checked');
  await act(async () => button('CHECK ORIGINAL RECEIPT')!.click());
  expect(controller.open).toHaveBeenCalledOnce(); expect(controller.confirm).not.toHaveBeenCalled();
});
it('a denied panel session cannot invoke the original controller', async () => {
  props.session.dispatch = vi.fn(() => false); await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-recipe-id="refine_frostglass"]')!.click());
  await act(async () => button('REVIEW REFINING')!.click()); expect(controller.beginStart).not.toHaveBeenCalled();
});
it('ingot review preserves the server recipe version in the original request', async () => {
  const beginStart = vi.fn(async () => undefined);
  ingots.run = vi.fn(action => { void action({ beginStart } as never); });
  await render(); await act(async () => button('INGOTS')!.click());
  await act(async () => button('REVIEW REFINING')!.click());
  expect(beginStart).toHaveBeenCalledWith(id(1), 1, ingots.snapshot!.view.recipeVersion);
});
it('dismissal while a controller is busy refuses the host continuation', async () => {
  ordinary.state.busy = true; await render();
  const policy = vi.mocked(props.session.setDismissPolicy).mock.calls.at(-1)![0];
  const proceed = vi.fn(() => true), cancel = vi.fn(); policy({ reason: 'close', proceed, cancel });
  expect(cancel).toHaveBeenCalledOnce(); expect(proceed).not.toHaveBeenCalled();
});
it('the feature stays lazy and never registers itself in shared BASE_FEATURES', () => {
  expect(craftFeatures).toHaveLength(1); expect(craftFeatures[0]).toMatchObject({ id: 'craft.workshop', kind: 'craft', size: 'TALL', dismissal: 'controller', readOnly: false });
  expect(typeof craftFeatures[0]!.load).toBe('function');
  expect({kind:craftFeatures[0]!.kind,featureId:craftFeatures[0]!.id}).toEqual(ORDINARY_CRAFTING_PANEL);
  expect(craftFeatures[0]!.canMutate!(props.panel)).toBe(false);
});

it('passes the live host capability to both hooks and requires the ordinary building grant',async()=>{
  await render();expect(useWorkshop).toHaveBeenLastCalledWith(true);expect(useOrdinaryCrafting).toHaveBeenLastCalledWith(true);
  vi.mocked(useBuildingActivityAccess).mockReturnValue(false);await render();expect(useWorkshop).toHaveBeenLastCalledWith(true);expect(useOrdinaryCrafting).toHaveBeenLastCalledWith(false);
  props={...props,actionsEnabled:false};await render();expect(useWorkshop).toHaveBeenLastCalledWith(false);expect(useOrdinaryCrafting).toHaveBeenLastCalledWith(false);
  vi.mocked(useBuildingActivityAccess).mockReturnValue(true);await render();expect(useWorkshop).toHaveBeenLastCalledWith(false);expect(useOrdinaryCrafting).toHaveBeenLastCalledWith(false);
  const missingCapability={panel:props.panel,onClose:props.onClose,session:props.session};
  await act(async()=>{
    // @ts-expect-error H-2 requires the live host capability; deliberately probe an untyped omission.
    root.render(<WorkshopPanel {...missingCapability}/>);
  });expect(useWorkshop).toHaveBeenLastCalledWith(false);expect(useOrdinaryCrafting).toHaveBeenLastCalledWith(false);
});
it('routes each saved action through the permission of its original owner',async()=>{
  ordinary.actionsAllowed=false;ordinary.state={...ordinary.state,journal:{version:1,identity,revision:1,archives:[],operation:{command:start,attemptRevision:null,proof:null,refusal:null}}};
  const confirm=vi.fn(async()=>undefined);ingots.run=vi.fn(action=>{void action({confirm} as never);});
  ingots.state={...ingots.state,journal:{version:1,identity,revision:1,archives:[],operation:{command:ingotStart,attempted:false,proof:null,refusal:null}},review:{command:ingotStart,view:ingots.snapshot!.view}};
  await render();await act(async()=>button('CONFIRM REFINING')!.click());expect(confirm).toHaveBeenCalledOnce();expect(controller.confirm).not.toHaveBeenCalled();
});
it('keeps refining mutation held while allowing original receipt recovery by dispatch kind',async()=>{
  props.session.dispatch=vi.fn((kind,action)=>{if(kind==='mutate')return false;action();return true;});
  await render();await act(async()=>host.querySelector<HTMLButtonElement>('[data-recipe-id="refine_frostglass"]')!.click());
  await act(async()=>button('REVIEW REFINING')!.click());expect(controller.beginStart).not.toHaveBeenCalled();expect(host.textContent).toContain('Orders are paused');
  ordinary.state={...ordinary.state,journal:{version:1,identity,revision:1,archives:[],operation:{command:start,attemptRevision:null,proof:null,refusal:null}},review:{command:start,view:ordinary.snapshot!.view}};
  await render();expect(button('CONFIRM REFINING')!.disabled).toBe(false);await act(async()=>button('CONFIRM REFINING')!.click());expect(controller.confirm).not.toHaveBeenCalled();
  await act(async()=>button('CHECK ORIGINAL RECEIPT')!.click());expect(controller.open).toHaveBeenCalledOnce();
});

it('the ordinary review remains owned by ordinary crafting while the held INGOTS tab is selected',async()=>{
  ingots.actionsAllowed=false;ingots.snapshot!.view.jobs=ingotView().jobs;
  await render();expect(button('INGOTS')!.getAttribute('aria-selected')).toBe('true');
  ordinary.state={...ordinary.state,journal:{version:1,identity,revision:1,archives:[],operation:{command:start,attemptRevision:null,proof:null,refusal:null}},review:{command:start,view:ordinary.snapshot!.view}};
  await render();expect(button('INGOTS')!.getAttribute('aria-selected')).toBe('true');expect(button('CONFIRM REFINING')!.disabled).toBe(false);
  await act(async()=>button('CONFIRM REFINING')!.click());expect(controller.confirm).toHaveBeenCalledOnce();expect(ingots.run).not.toHaveBeenCalled();
});
it('drops the refused-dispatch notice after original hook capability changes',async()=>{
  props.session.dispatch=vi.fn(()=>false);await render();await act(async()=>host.querySelector<HTMLButtonElement>('[data-recipe-id="refine_frostglass"]')!.click());expect(button('REVIEW REFINING')!.disabled).toBe(false);await act(async()=>button('REVIEW REFINING')!.click());expect(host.textContent).toContain('Orders are paused');
  ordinary.actionsAllowed=false;await render();ordinary.actionsAllowed=true;await render();expect(host.textContent).not.toContain('Orders are paused');
});
