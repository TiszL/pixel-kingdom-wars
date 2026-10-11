// @vitest-environment happy-dom
import {webcrypto} from 'node:crypto';
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {migrationFixture} from '../../lib/charterMigration/testFixture';
import {MigrationJournalStore} from '../../lib/charterMigration/journal';
import {browserMigrationIdentity} from '../../lib/charterMigration/browser';
import {requestMigration} from '../../lib/charterMigration/transport';
import {CharterMigrationScreen} from './CharterMigrationScreen';
import {CharterEntry} from './CharterEntry';
import {CharterScreen} from './CharterScreen';
import {api} from '../../lib/api';
const mocks=vi.hoisted(()=>({wallet:{publicKey:null as unknown,signVersionedTransaction:vi.fn(),signMessage:null,sendTransaction:vi.fn(),isEmbedded:false},connection:{getGenesisHash:vi.fn(),getBlockHeight:vi.fn()}}));
vi.mock('../../auth/useGameWallet',()=>({useGameWallet:()=>mocks.wallet}));vi.mock('@solana/wallet-adapter-react',()=>({useConnection:()=>({connection:mocks.connection})}));
vi.mock('../../lib/charterMigration/transport',()=>({requestMigration:vi.fn()}));
vi.mock('../../lib/charter/transport',()=>({charterActivity:vi.fn(async()=>{throw Error('Activity unavailable');}),requestCharter:vi.fn(async()=>{throw Error('No Charter mutation expected');})}));
let host:HTMLDivElement,root:Root,f:Awaited<ReturnType<typeof migrationFixture>>,value:Awaited<ReturnType<typeof migrationFixture>>['migration'];
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
async function click(text:string){expect(button(text)?.disabled).toBe(false);await act(async()=>button(text)!.click());await until(()=>expect(host.querySelector('.sk-retirement-progress')).toBeNull());}
async function stored(){const s=new MigrationJournalStore(browserMigrationIdentity(f.actor));try{return await s.read();}finally{await s.close();}}
async function seed(){const s=new MigrationJournalStore(browserMigrationIdentity(f.actor));try{await s.begin(value.request);await s.retain(value);}finally{await s.close();}}
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_n:string,_o:unknown,run:(v:object)=>Promise<unknown>)=>run({})}});
 vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
 f=await migrationFixture();value=structuredClone(f.migration);mocks.wallet.publicKey=f.creator.publicKey;mocks.wallet.signVersionedTransaction.mockReset().mockImplementation(async tx=>{tx.sign([f.creator]);return tx;});mocks.wallet.sendTransaction.mockReset();
 mocks.connection.getGenesisHash.mockReset().mockResolvedValue(f.trust.deployment.expectedGenesisHash);mocks.connection.getBlockHeight.mockReset().mockResolvedValue(1);useApp.getState().setAuth(f.actor,true);useApp.getState().setScreen('bases');
 vi.mocked(requestMigration).mockReset().mockImplementation(async input=>{input.isCurrent();if(input.request.action==='signed'){const j=await stored();value={...value,status:'signed',wire:j.signed!};}await input.retain(value);input.isCurrent();return value;});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('preserves the existing clan and shows no repeat SHARDS charge before any wallet approval',async()=>{
 value={...value,status:'pending',signing:null};await seed();await act(async()=>root.render(<CharterMigrationScreen clanId={value.original.clanId} actionsEnabled trust={f.trust} onClose={()=>undefined}/>));
 await until(()=>expect(button('Prepare wallet review')?.disabled).toBe(false));expect(host.textContent).toContain('217 SHARDS');expect(host.textContent).toContain('No repeat payment');expect(host.textContent).toContain('does not distribute the chest');expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
 value=structuredClone(f.migration);await click('Prepare wallet review');expect(host.textContent).toContain('Collectible creation');expect(button('Review exact approval')?.disabled).toBe(true);
});
it('requires exact-cost consent then signs once and submits only the saved registration on StrictMode',async()=>{
 await seed();await act(async()=>root.render(<StrictMode><CharterMigrationScreen clanId={value.original.clanId} actionsEnabled trust={f.trust} onClose={()=>undefined}/></StrictMode>));
 await until(()=>expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(false));expect(vi.mocked(requestMigration).mock.calls.every(([i])=>i.request.action==='read')).toBe(true);expect(button('Review exact approval')!.disabled).toBe(true);
 await act(async()=>host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await click('Review exact approval');await until(()=>expect(button('Approve Charter in wallet')?.disabled).toBe(false));await click('Approve Charter in wallet');await until(()=>expect(button('Submit saved transaction')?.disabled).toBe(false));await click('Submit saved transaction');
 expect(mocks.wallet.signVersionedTransaction).toHaveBeenCalledOnce();expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled();value={...value,status:'controlled',terminal:{id:value.id,outcome:'controlled'}};await click('Check outcome');await until(()=>expect(host.textContent).toContain('Your Charter is ready'));expect(host.textContent).toContain('217 SHARDS');
});
it('opens an existing request by ID without creating or replacing a migration',async()=>{
 await act(async()=>root.render(<CharterMigrationScreen clanId={null} requestId={value.id} actionsEnabled={false} onClose={()=>undefined}/>));await until(()=>expect(button('Cancel request')?.disabled).toBe(false));expect(vi.mocked(requestMigration).mock.calls.every(([i])=>i.request.action==='read'&&i.request.key===value.id)).toBe(true);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('keeps cached clan history and original checks available when paused and offline',async()=>{
 await seed();vi.mocked(requestMigration).mockRejectedValue(Error('Provider unavailable'));await act(async()=>root.render(<CharterMigrationScreen clanId={null} actionsEnabled={false} onClose={()=>undefined}/>));await until(()=>expect(button('Cancel request')?.disabled).toBe(false));expect(host.textContent).toContain(value.snapshot.clan.name);expect(host.textContent).toContain('Provider unavailable');expect(button('Review exact approval')?.disabled).toBe(true);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('discovers migration-only recovery through the ordinary Charter entry while paused',async()=>{
 await seed();vi.spyOn(api,'getPrivate').mockRejectedValue(Error('Activity unavailable'));vi.mocked(requestMigration).mockRejectedValue(Error('Provider unavailable'));await act(async()=>root.render(<CharterEntry actionsEnabled={false}/>));
 await until(()=>expect(button('CHARTERS & HISTORY')).toBeDefined());await click('CHARTERS & HISTORY');await until(()=>expect(button('History')).toBeDefined());await click('History');await until(()=>expect(button('SAVED CLAN REQUEST & RECEIPTS')?.disabled).toBe(false));await click('SAVED CLAN REQUEST & RECEIPTS');await until(()=>expect(button('Cancel request')?.disabled).toBe(false));expect(host.textContent).toContain(value.snapshot.clan.name);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('discovers a landless current leader without requiring funded creation history',async()=>{
 useApp.setState({selectedBaseId:null});vi.spyOn(api,'getPrivate').mockImplementation(async path=>{if(path!=='/clans/charter/migrations/activity')throw Error('No funded history');return {version:1,actor:f.actor,newActions:true,currentClan:{...value.snapshot.clan,authority:'legacy',migrationId:null},items:[]};});
 await act(async()=>root.render(<CharterScreen actionsEnabled trust={f.trust} onClose={()=>undefined}/>));await until(()=>expect(button('REVIEW EXISTING CLAN')?.disabled).toBe(false));await click('REVIEW EXISTING CLAN');await until(()=>expect(button('Review existing clan')?.disabled).toBe(false));expect(vi.mocked(requestMigration).mock.calls).toHaveLength(0);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
