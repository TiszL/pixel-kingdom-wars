// @vitest-environment happy-dom
import {webcrypto} from 'node:crypto';
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {retirementFixture} from '../../lib/charterRetirement/testFixture';
import {RetirementJournalStore} from '../../lib/charterRetirement/journal';
import {browserRetirementIdentity} from '../../lib/charterRetirement/browser';
import {requestRetirement} from '../../lib/charterRetirement/transport';
import {CharterRetirementScreen} from './CharterRetirementScreen';
import {CharterEntry} from './CharterEntry';
import {api} from '../../lib/api';
const mocks=vi.hoisted(()=>({wallet:{publicKey:null as unknown,signVersionedTransaction:vi.fn(),signMessage:null,sendTransaction:vi.fn(),isEmbedded:false},connection:{getGenesisHash:vi.fn(),getBlockHeight:vi.fn()}}));
vi.mock('../../auth/useGameWallet',()=>({useGameWallet:()=>mocks.wallet}));vi.mock('@solana/wallet-adapter-react',()=>({useConnection:()=>({connection:mocks.connection})}));
vi.mock('../../lib/charterRetirement/transport',()=>({requestRetirement:vi.fn()}));
vi.mock('../../lib/charter/transport',()=>({charterActivity:vi.fn(async()=>{throw Error('Activity unavailable');}),requestCharter:vi.fn(async()=>{throw Error('No Charter mutation expected');})}));
let host:HTMLDivElement,root:Root,f:Awaited<ReturnType<typeof retirementFixture>>,value:Awaited<ReturnType<typeof retirementFixture>>['draft'];
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
async function click(text:string){expect(button(text)?.disabled).toBe(false);await act(async()=>button(text)!.click());await until(()=>expect(host.querySelector('.sk-retirement-progress')).toBeNull());}
async function stored(){const s=new RetirementJournalStore(browserRetirementIdentity(f.actor));try{return await s.read();}finally{await s.close();}}
async function seed(){const s=new RetirementJournalStore(browserRetirementIdentity(f.actor));try{await s.begin(value.request);await s.retain(value);}finally{await s.close();}}
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_n:string,_o:unknown,run:(v:object)=>Promise<unknown>)=>run({})}});
 vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
 f=await retirementFixture();value=structuredClone(f.draft);mocks.wallet.publicKey=f.leader.publicKey;mocks.wallet.signVersionedTransaction.mockReset().mockImplementation(async tx=>{tx.sign([f.leader]);return tx;});mocks.wallet.sendTransaction.mockReset();
 mocks.connection.getGenesisHash.mockReset().mockResolvedValue(f.trust.deployment.expectedGenesisHash);mocks.connection.getBlockHeight.mockReset().mockResolvedValue(1);useApp.getState().setAuth(f.actor,true);useApp.getState().setScreen('bases');
 vi.mocked(requestRetirement).mockReset().mockImplementation(async input=>{input.isCurrent();if(input.request.action==='signed'){const j=await stored();value={...value,operation:{...f.operation,status:'signed',signed:j.signed!}};}await input.retain(value);input.isCurrent();return value;});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('requires explicit payout consent before distributing the captured chest',async()=>{
 value={...value,memberPayment:null,operation:null};await seed();await act(async()=>root.render(<CharterRetirementScreen clanId={f.original.creation.clanId} actionsEnabled trust={f.trust} onClose={()=>undefined}/>));
 await until(()=>expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(false));expect(button('Pay members')!.disabled).toBe(true);expect(host.textContent).toContain('100');
 await act(async()=>host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await click('Pay members');
 expect(vi.mocked(requestRetirement).mock.calls.filter(([i])=>i.request.action==='pay-members')).toHaveLength(1);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('runs exact review, one wallet approval and saved delivery without a mutation on StrictMode mount',async()=>{
 await seed();await act(async()=>root.render(<StrictMode><CharterRetirementScreen clanId={f.original.creation.clanId} actionsEnabled trust={f.trust} onClose={()=>undefined}/></StrictMode>));
 await until(()=>expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(false));expect(vi.mocked(requestRetirement).mock.calls.every(([i])=>i.request.action==='read')).toBe(true);expect(button('Review exact approval')!.disabled).toBe(true);
 await act(async()=>host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await click('Review exact approval');await until(()=>expect(button('Approve dissolution in wallet')?.disabled).toBe(false));await click('Approve dissolution in wallet');
 await until(()=>expect(button('Submit saved transaction')?.disabled).toBe(false));await click('Submit saved transaction');expect(mocks.wallet.signVersionedTransaction).toHaveBeenCalledOnce();expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled();
 value={...value,operation:{...value.operation!,status:'completed',terminal:{id:f.draft.id,outcome:'completed'}}};await click('Check outcome');await until(()=>expect(host.textContent).toContain('Your clan is now dissolved'));expect(button('Approve dissolution in wallet')).toBeUndefined();
});
it('shows cached originals and recovery when new approvals are paused and refresh fails',async()=>{
 await seed();vi.mocked(requestRetirement).mockRejectedValue(Error('Provider unavailable'));await act(async()=>root.render(<CharterRetirementScreen clanId={null} actionsEnabled={false} trust={null} onClose={()=>undefined}/>));
 await until(()=>expect(button('Cancel dissolution')?.disabled).toBe(false));expect(host.textContent).toContain('Seafarers');expect(host.textContent).toContain('Provider unavailable');expect(button('Cancel dissolution')?.disabled).toBe(false);expect(button('Review exact approval')?.disabled).toBe(true);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('discovers a saved dissolution through the normal Charter entry while offline and paused',async()=>{
 await seed();vi.spyOn(api,'getPrivate').mockRejectedValue(Error('Activity unavailable'));vi.mocked(requestRetirement).mockRejectedValue(Error('Provider unavailable'));
 await act(async()=>root.render(<CharterEntry actionsEnabled={false}/>));await until(()=>expect(button('CHARTERS & HISTORY')).toBeDefined());await click('CHARTERS & HISTORY');
 await until(()=>expect(button('Dissolve clan')).toBeDefined());await click('Dissolve clan');await until(()=>expect(button('DISSOLUTION & RECEIPTS')?.disabled).toBe(false));await click('DISSOLUTION & RECEIPTS');
 await until(()=>expect(button('Cancel dissolution')?.disabled).toBe(false));expect(host.textContent).toContain('Seafarers');expect(button('Review exact approval')?.disabled).toBe(true);
 expect(vi.mocked(requestRetirement).mock.calls.every(([input])=>input.request.action==='read')).toBe(true);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
