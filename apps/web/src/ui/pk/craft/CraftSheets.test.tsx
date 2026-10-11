/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureId, type CommandUi } from '../types';
import { PkHarvesterSheet, PkMarketSheet, PkWorkshopSheet, type CraftFrameUi, type CraftJob, type CraftRecipe } from './CraftSheets';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount());host.remove(); });
const render=async (node:ReactNode)=>{await act(async()=>root.render(node));};
const frame:CraftFrameUi={title:'Workshop',level:null,status:'Snapshot',art:null,hydration:'READY',error:null,submit:'IDLE',authoritativeRefusal:null,savedRequest:false};
const actions=()=>({onClose:vi.fn(),onHistory:vi.fn(),onRetry:vi.fn(),onCheckSaved:vi.fn(),onCommand:vi.fn()});
const command:CommandUi={id:featureId('craft.make'),caption:'CRAFT',icon:'shape:hammer',price:null,primary:true,state:'ENABLED',reason:null,badge:null};
const item={id:'item',name:'DELIVERED-YIELD',icon:'shape:chest',detail:'Yield',amount:'snapshot quantity',tag:null};
const recipe:CraftRecipe={...item,secondsEach:null,ingredients:[],quantity:2,minimum:1,maximum:9,reason:null};
const job=(mode:'AUTO'|'SERVER',receiptId:string|null):CraftJob=>({id:'job',mode,state:'DELIVERED',receiptId,name:'Finished job',icon:'shape:chest',quantity:'snapshot quantity',secondsLeft:null,statusLabel:'Delivered'});
describe('harvester arrival is proven before it is shown',()=>{
  for(const mode of ['AUTO','SERVER'] as const) for(const receiptId of [null,'','   ','proof']) {
    it(`${mode}/${JSON.stringify(receiptId)} gates arrival and delivered rows`,async()=>{
      const onCollection=vi.fn();
      await render(<PkHarvesterSheet frame={frame} actions={actions()} tab="YIELD" yieldItems={[item]} job={job(mode,receiptId)} history={[]}
        primary={null} onTab={vi.fn()} onCollection={onCollection} onReceipt={vi.fn()} />);
      const proven=mode==='AUTO'||receiptId==='proof';
      if(proven){expect(host.textContent).toContain('Your haul arrived');expect(host.textContent).toContain('DELIVERED-YIELD');}
      else{expect(host.textContent).not.toContain('Your haul arrived');expect(host.textContent).not.toContain('DELIVERED-YIELD');expect(host.textContent).not.toContain('Delivered');}
      const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes(mode==='AUTO'?'GOT IT':'VIEW RECEIPT'));
      if(proven){expect(button).toBeDefined();await act(async()=>button!.click());expect(onCollection).toHaveBeenCalledWith('job',mode==='AUTO'?'MARK_SEEN':'CELEBRATE');}
      else expect(button).toBeUndefined();
      expect(host.querySelector('[aria-label="History"]')).toBeNull();
    });
  }
});
it('a saved request wins over refresh failure in the rendered primary',async()=>{
  const a=actions();await render(<PkWorkshopSheet frame={{...frame,hydration:'ERROR',savedRequest:true}} actions={a} tab="REFINE" recipes={[]} selectedRecipe={null}
    job={null} primary={command} onTab={vi.fn()} onRecipe={vi.fn()} onQuantity={vi.fn()} onSource={vi.fn()} onCollection={vi.fn()} />);
  await act(async()=>host.querySelector<HTMLButtonElement>('.pk-primary .pk-btn')!.click());
  expect(a.onCheckSaved).toHaveBeenCalledOnce();expect(a.onRetry).not.toHaveBeenCalled();expect(a.onCommand).not.toHaveBeenCalled();
});
it('the rendered ingot stepper uses every server cap and refuses an unknown cap',async()=>{
  const onQuantity=vi.fn();const props={frame,actions:actions(),tab:'INGOTS' as const,recipes:[item],selectedRecipe:recipe,job:null,primary:command,
    onTab:vi.fn(),onRecipe:vi.fn(),onQuantity,onSource:vi.fn(),onCollection:vi.fn()};
  await render(<PkWorkshopSheet {...props} ingotLimits={{batch:8,daily:2,holding:5}} />);
  const increase=()=>host.querySelector<HTMLButtonElement>('[aria-label="Increase quantity"]')!;
  expect(increase().disabled).toBe(true);expect(host.textContent).toContain('max 2');
  await render(<PkWorkshopSheet {...props} ingotLimits={{batch:8,daily:4,holding:5}} />);
  await act(async()=>increase().click());expect(onQuantity).toHaveBeenCalledWith(3);
  await render(<PkWorkshopSheet {...props} ingotLimits={{batch:8,daily:null,holding:5}} />);
  expect(increase().disabled).toBe(true);expect(host.textContent).toContain('max …');
});
it('equipment does not expose a quantity stepper',async()=>{
  await render(<PkWorkshopSheet frame={frame} actions={actions()} tab="EQUIPMENT" recipes={[item]} selectedRecipe={recipe} job={null} primary={command}
    onTab={vi.fn()} onRecipe={vi.fn()} onQuantity={vi.fn()} onSource={vi.fn()} onCollection={vi.fn()} />);
  expect(host.querySelector('[aria-label="Batch quantity"]')).toBeNull();
});
it('market statuses use player copy and keep submitting selection inert',async()=>{
  const onChoose=vi.fn();const props={frame,actions:actions(),tab:'MY ORDERS' as const,section:'KEEP' as const,items:[item],selected:null,owned:[],primary:null,
    listingNote:null,onTab:vi.fn(),onSection:vi.fn(),onChoose,onOffer:vi.fn(),onOwned:vi.fn()};
  await render(<PkMarketSheet {...props} orders={[{...item,status:'WITHDRAWING',proceeds:null}]} />);
  expect(host.textContent).toContain('Taking your goods back');expect(host.textContent).not.toContain('withdrawing');
  await render(<PkMarketSheet {...props} frame={{...frame,submit:'SENDING'}} tab="BUY" orders={[]} />);
  await act(async()=>host.querySelector<HTMLButtonElement>('.pk-craft__goods-choice')!.click());
  expect(onChoose).not.toHaveBeenCalled();
});

it('craft tabs expose selection and stop keyboard movement while submitting',async()=>{
  const onTab=vi.fn();const props={frame,actions:actions(),tab:'REFINE' as const,recipes:[],selectedRecipe:null,job:null,primary:command,onTab,
    onRecipe:vi.fn(),onQuantity:vi.fn(),onSource:vi.fn(),onCollection:vi.fn()};
  await render(<PkWorkshopSheet {...props} />);
  const tabs=[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];expect(tabs).toHaveLength(4);
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  await act(async()=>{tabs[0]!.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));});
  expect(onTab).toHaveBeenCalledWith('COSMETICS');expect(document.activeElement).toBe(tabs[3]);
  await render(<PkWorkshopSheet {...props} frame={{...frame,submit:'SENDING'}} />);
  expect([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].every(t=>t.disabled)).toBe(true);
});
