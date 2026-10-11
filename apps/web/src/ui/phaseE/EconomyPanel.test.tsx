/** @vitest-environment happy-dom */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EconomyPanel} from './EconomyPanel';
let host:HTMLDivElement,root:Root,opener:HTMLButtonElement;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);opener=document.createElement('button');document.body.append(opener);opener.focus();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();opener.remove();vi.unstubAllGlobals();});
it('keeps keyboard navigation within the dialog, excluding collapsed payment details, and restores the opener',async()=>{
 const close=vi.fn();await act(async()=>root.render(<EconomyPanel title="Payment" eyebrow="Gems" onClose={close}><button>Review</button><details><summary>Original payment</summary><a href="#proof">Hidden proof</a></details></EconomyPanel>));
 const dialog=host.querySelector('[role=dialog]')!,summary=host.querySelector('summary')!,first=host.querySelector('button')!;
 expect(document.activeElement).toBe(dialog);
 await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})));
 expect(document.activeElement).toBe(summary);
 await act(async()=>summary.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));
 expect(document.activeElement).toBe(first);
 await act(async()=>first.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
 expect(close).toHaveBeenCalledOnce();
 await act(async()=>root.render(null));expect(document.activeElement).toBe(opener);
});
it('takes the player to a new error instead of leaving it outside the scrolled view',async()=>{
 const render=(error?:string)=>root.render(<EconomyPanel title="Workshop" eyebrow="Refine" onClose={()=>undefined} error={error??null}><button>Collect</button></EconomyPanel>);
 await act(async()=>render());host.querySelector('button')!.focus();await act(async()=>render('The saved receipt is unavailable. Check again.'));
 expect(document.activeElement).toBe(host.querySelector('[role=alert]'));
});
