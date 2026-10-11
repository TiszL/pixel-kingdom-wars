/** @vitest-environment happy-dom */
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {api} from '../../lib/api';
import {useApp} from '../../state/store';
import {PhaseERegistration} from './PhaseERegistration';
let host:HTMLDivElement,root:Root;
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();},{timeout:15000});
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',undefined);vi.spyOn(api,'get').mockRejectedValue(Error('offline'));vi.spyOn(api,'getPrivate').mockRejectedValue(Error('offline'));useApp.getState().setAuth('11111111111111111111111111111111',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();useApp.getState().setAuth(null);});
it('saved recovery entries share a flow layout instead of overlapping absolute HUD coordinates',async()=>{
 await act(async()=>root.render(<PhaseERegistration screen="bases" inBase={false} authed actionsEnabled={false}/>));
 await until(()=>expect(host.textContent).toContain('KEEP TAX & HISTORY'));
 await until(()=>expect(host.textContent).toContain('SEEKER SHARES & HISTORY'));
 const actions=[...host.querySelectorAll('button')].filter(b=>b.textContent?.includes('HISTORY'));
 expect(actions.length).toBeGreaterThanOrEqual(4);
 expect(actions.every(b=>b.style.position!=='absolute')).toBe(true);
 const toggle=host.querySelector<HTMLButtonElement>('[aria-controls="phase-e-actions"]')!;
 expect(toggle).not.toBeNull();expect(toggle.getAttribute('aria-expanded')).toBe('false');
 await act(async()=>toggle.click());expect(toggle.getAttribute('aria-expanded')).toBe('true');
 expect(host.querySelector<HTMLElement>('#phase-e-actions')!.hidden).toBe(false);
 await act(async()=>toggle.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 expect(toggle.getAttribute('aria-expanded')).toBe('false');
});
it('no authenticated Phase E menu is mounted outside its assigned game screens',async()=>{
 await act(async()=>root.render(<PhaseERegistration screen="bases" inBase={false} authed={false} actionsEnabled={false}/>));
 expect(host.querySelector('nav')).toBeNull();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
