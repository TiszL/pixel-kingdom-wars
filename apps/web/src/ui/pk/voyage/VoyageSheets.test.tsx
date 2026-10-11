/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureId, type CommandUi } from '../types';
import { PkBerthInstallSheet, PkBerthSheet, PkRoutePickerSheet, PkVoyageCollectionSheet, type VoyageFrameUi, type VoyageVehicle } from './VoyageSheets';
let host:HTMLDivElement,root:Root;
beforeEach(()=>{
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const render=async(node:ReactNode)=>{await act(async()=>root.render(node));};
const frame:VoyageFrameUi={title:'Lodge',level:null,status:'Snapshot',art:null,loading:false,error:null};
const actions=()=>({onClose:vi.fn(),onHistory:vi.fn(),onRetry:vi.fn(),onCheckSaved:vi.fn(),onCommand:vi.fn()});
const primary:CommandUi={id:featureId('berth.install'),caption:'REVIEW INSTALL',icon:'shape:anchor',price:null,primary:true,state:'ENABLED',reason:null,badge:null};
describe('voyage collection gates the rendered claims',()=>{
  for(const receiptId of [null,'','   ','proof']) for(const state of ['CHECKING','FAILED','COLLECTED'] as const){
    it(`${state}/${JSON.stringify(receiptId)} requires a nonempty receipt`,async()=>{
      const a=actions();const onDone=vi.fn();await render(<PkVoyageCollectionSheet frame={frame} actions={a} state={state} receiptId={receiptId}
        rewards={[{id:'item',name:'REWARD-CLAIM',icon:'shape:chest',quantity:'reward quantity'}]} onDone={onDone} />);
      const proven=state==='COLLECTED'&&receiptId==='proof';
      if(proven){expect(host.textContent).toContain('EXPEDITION BACK');expect(host.textContent).toContain('REWARD-CLAIM');}
      else{expect(host.textContent).not.toContain('EXPEDITION BACK');expect(host.textContent).not.toContain('REWARD-CLAIM');}
      await act(async()=>host.querySelector<HTMLButtonElement>('.pk-primary .pk-btn')!.click());
      if(proven){expect(onDone).toHaveBeenCalledOnce();expect(a.onCheckSaved).not.toHaveBeenCalled();}
      else{expect(onDone).not.toHaveBeenCalled();expect(a.onCheckSaved).toHaveBeenCalledOnce();}
    });
  }
});
describe('the actual voyage review footer owns the tested intent guard',()=>{
  for(const [stage,authoritative,expected] of [
    ['IDLE',false,'OPEN'],['ARMED',false,'OPEN'],['ERROR',false,'CHECK'],['ERROR',true,'OPEN'],
    ['CHECK_WALLET',false,null],['SENDING',false,null],['SENT',false,null],
  ] as const){
    it(`${stage}/${authoritative} does not bypass review or recovery`,async()=>{
      const a=actions();await render(<PkBerthInstallSheet frame={{...frame,operation:{stage,authoritative}}} actions={a} walletVehicles={[]} selected={null}
        primary={primary} pending={false} busy={false} walletLinked onChoose={vi.fn()} onLinkWallet={vi.fn()} />);
      await act(async()=>host.querySelector<HTMLButtonElement>('.pk-primary .pk-btn')!.click());
      if(expected==='CHECK'){expect(a.onCheckSaved).toHaveBeenCalledOnce();expect(a.onCommand).not.toHaveBeenCalled();}
      else if(expected==='OPEN'){expect(a.onCommand).toHaveBeenCalledWith(primary,'OPEN');expect(a.onCheckSaved).not.toHaveBeenCalled();}
      else{expect(a.onCommand).not.toHaveBeenCalled();expect(a.onCheckSaved).not.toHaveBeenCalled();}
    });
  }
});
it('every route state has player wording, never a lowercased enum dump',async()=>{
  const a=actions();const common={routeId:'route',name:'Island',realm:'Realm',icon:'shape:anchor',grade:1,access:'HOME',myTrip:null,permitReason:null,
    gradeLabel:'Grade',yieldLabel:'Yield',durationSeconds:null,note:''};
  for(const [route,tier,selected,raw,copy] of [
    [common,1,null,'available','Choose this island'],[common,1,'route','selected','Your destination'],
    [common,null,null,'locked tier','A stronger vehicle is needed'],
    [{...common,access:'PAID_REALM',permitReason:'Unavailable'},1,null,'locked permit','A permit is needed'],
    [{...common,myTrip:{state:'READY'}},1,null,'my trip back','Back at the Lodge'],
    [{...common,myTrip:{state:'AT_SEA'}},1,null,'my trip away','Your voyage is at sea'],
  ] as const){
    await render(<PkRoutePickerSheet frame={frame} actions={a} routes={[route]} tier={tier} selected={selected} filter="ALL" onFilter={vi.fn()} onRoute={vi.fn()} />);
    expect(host.textContent).toContain(copy);expect(host.textContent).not.toContain(raw);
  }
});
it('unavailable vehicles name their destination instead of printing enum values',async()=>{
  const vehicle:VoyageVehicle={id:'v',name:'Boat',icon:'shape:anchor',tierLabel:'Tier',tripsLabel:'Trips',note:'',family:'CARGO_CUTTER',status:'WORN_OUT',installationId:'v',tripsLeft:0,maxGrade:1};
  await render(<PkBerthSheet frame={frame} actions={actions()} tab="FLEET" vehicles={[vehicle]} selected={null} service={[]} selectedService={null}
    primary={null} pending={false} busy={false} onTab={vi.fn()} onVehicle={vi.fn()} onService={vi.fn()} onInstall={vi.fn()} />);
  expect(host.textContent).toContain('Restore trips at the Berth');expect(host.textContent).not.toContain('worn out');
});

it('voyage tabs expose selection and wrap keyboard focus',async()=>{
  const onTab=vi.fn();await render(<PkBerthSheet frame={frame} actions={actions()} tab="FLEET" vehicles={[]} selected={null} service={[]} selectedService={null}
    primary={null} pending={false} busy={false} onTab={onTab} onVehicle={vi.fn()} onService={vi.fn()} onInstall={vi.fn()} />);
  const tabs=[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];expect(tabs).toHaveLength(2);
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  await act(async()=>{tabs[0]!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));});
  expect(onTab).toHaveBeenCalledWith('SERVICE');expect(document.activeElement).toBe(tabs[1]);
});
