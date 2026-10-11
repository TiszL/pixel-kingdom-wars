/** @vitest-environment happy-dom */
import {act,StrictMode} from 'react';
import {SIM_VERSION} from '@shardkeep/sim';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useApp} from '../../state/store';
import {divineBattleSession,beginDivineBattle,endDivineBattle} from '../../lib/divineTrials/battleSession';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),postRaw:vi.fn(),blocked:null as Promise<void>|null,failed:false}));
vi.mock('../../lib/api',async importOriginal=>{const actual=await importOriginal<typeof import('../../lib/api')>();return {...actual,api:{...actual.api,...mocks}};});
vi.mock('../../auth/useSolPurchase',()=>({useSolPurchase:()=>({purchase:vi.fn(),phase:'idle',error:null})}));
vi.mock('../../auth/useAuth',()=>({useAuth:()=>({signIn:vi.fn(),signingIn:false,error:null})}));
vi.mock('../../auth/useSocialAuth',()=>({useSocialAuth:()=>({signInWithSocial:vi.fn(),signingIn:false,error:null})}));
vi.mock('../../auth/useGameWallet',()=>({useGameWallet:()=>({publicKey:null,sendTransaction:null,signMessage:null})}));
vi.mock('../../auth/useWalletSessionFence',()=>({useWalletSessionFence:()=>undefined}));
vi.mock('../../auth/useSignOut',()=>({useSignOut:()=>vi.fn()}));
vi.mock('./DivineTrialBattle',()=>({DivineTrialBattle:()=> {if(mocks.failed)throw Error('failed trial module');if(mocks.blocked)throw mocks.blocked;return <div>ISOLATED DIVINE BATTLE</div>;}}));
import {RaidUI} from '../RaidUI';
import {PhaseEBattleHost} from './PhaseEBattleHost';
import {raidRecoveryDestination} from '../Overlay';
let root:Root,host:HTMLDivElement;
const wallet='11111111111111111111111111111112',baseId='00000000-0000-4000-8000-000000000002',eventId='00000000-0000-4000-8000-000000000003',attemptId='00000000-0000-4000-8000-000000000004';
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);useApp.getState().setAuth(wallet);useApp.setState({booted:true,screen:'base',selectedBaseId:baseId,base:null,raidTarget:null});mocks.get.mockReset().mockResolvedValue({raids:[]});mocks.post.mockReset();mocks.postRaw.mockReset().mockImplementation(()=>new Promise(()=>{}));mocks.blocked=null;mocks.failed=false;});
afterEach(async()=>{await act(async()=>{const session=divineBattleSession.getSnapshot();if(session)endDivineBattle(session);root.unmount();});host.remove();useApp.getState().setAuth(null);vi.restoreAllMocks();});
it('actual RaidUI has zero API effects under Divine ownership and normal creation still works after safe exit',async()=>{
 let session!:ReturnType<typeof beginDivineBattle>;await act(async()=>{session=beginDivineBattle({wallet,eventId,attemptId});root.render(<StrictMode><PhaseEBattleHost actionsEnabled ordinary={<RaidUI/>}/></StrictMode>);});expect(host.textContent).toContain('ISOLATED DIVINE BATTLE');expect(mocks.get).not.toHaveBeenCalled();expect(mocks.post).not.toHaveBeenCalled();expect(mocks.postRaw).not.toHaveBeenCalled();expect(divineBattleSession.getSnapshot()).toBe(session);
 await act(async()=>endDivineBattle(session));expect(useApp.getState().screen).toBe('base');expect(mocks.postRaw).not.toHaveBeenCalled();await act(async()=>useApp.getState().setScreen('battle'));expect(mocks.postRaw.mock.calls.some(([path])=>path==='/raids')).toBe(true);
});
it('real ordinary recovery performs no reads while Divine owns canvas and cannot retarget after a prior request finishes',async()=>{
 const session=beginDivineBattle({wallet,eventId,attemptId});expect(await raidRecoveryDestination()).toBeNull();expect(mocks.get).not.toHaveBeenCalled();endDivineBattle(session);
 let done!:(v:unknown)=>void;mocks.get.mockImplementation(()=>new Promise(r=>done=r));const pending=raidRecoveryDestination().catch(e=>e);await vi.waitFor(()=>expect(mocks.get).toHaveBeenCalled());const next=beginDivineBattle({wallet,eventId,attemptId});done({raids:[{id:'ordinary',simVersion:SIM_VERSION,attackerBaseId:baseId}]});await pending;expect(useApp.getState().raidTarget).toBeNull();expect(divineBattleSession.getSnapshot()).toBe(next);
});
it('base change exits before remounting ordinary controls; stale token cannot end a new view',async()=>{
 const first=beginDivineBattle({wallet,eventId,attemptId});await act(async()=>root.render(<PhaseEBattleHost actionsEnabled ordinary={<RaidUI/>}/>));await act(async()=>useApp.setState({selectedBaseId:eventId,baseSelectionEpoch:useApp.getState().baseSelectionEpoch+1}));expect(divineBattleSession.getSnapshot()).toBeNull();expect(useApp.getState().screen).toBe('base');expect(mocks.postRaw).not.toHaveBeenCalled();let next!:ReturnType<typeof beginDivineBattle>;await act(async()=>{next=beginDivineBattle({wallet,eventId,attemptId});});endDivineBattle(first);expect(divineBattleSession.getSnapshot()).toBe(next);
});
it.each(['loading','failed'] as const)('keeps ordinary RaidUI excluded when the trial display is %s',async status=>{vi.spyOn(console,'error').mockImplementation(()=>{});mocks.failed=status==='failed';if(status==='loading')mocks.blocked=new Promise(()=>{});beginDivineBattle({wallet,eventId,attemptId});await act(async()=>root.render(<PhaseEBattleHost actionsEnabled ordinary={<RaidUI/>}/>));expect(host.textContent).toContain(status==='loading'?'Opening saved trial':'Trial display could not open');expect(mocks.get).not.toHaveBeenCalled();expect(mocks.postRaw).not.toHaveBeenCalled();await act(async()=>window.dispatchEvent(new Event('pagehide')));expect(useApp.getState().screen).toBe('base');expect(divineBattleSession.getSnapshot()).toBeNull();expect(mocks.postRaw).not.toHaveBeenCalled();});
it('aborts an already-running ordinary base hydration before it can overwrite a new trial',async()=>{
 // Exercise current-simulator hydration; an obsolete fixture is correctly filtered before reading a base.
 const other='00000000-0000-4000-8000-000000000099';let baseReply!:(v:unknown)=>void,balancesReply!:(v:unknown)=>void;
 mocks.get.mockImplementation((path:string)=>path==='/raids/pending'?Promise.resolve({raids:[{id:attemptId,simVersion:SIM_VERSION,attackerBaseId:other}]}):path.startsWith('/base?')?new Promise(r=>baseReply=r):path.startsWith('/balances?')?new Promise(r=>balancesReply=r):Promise.reject(Error(path)));
 const pending=raidRecoveryDestination().catch(e=>e);await vi.waitFor(()=>{expect(baseReply).toBeTypeOf('function');expect(balancesReply).toBeTypeOf('function');});const session=beginDivineBattle({wallet,eventId,attemptId});baseReply({baseId:other});balancesReply({});await pending;expect(useApp.getState().selectedBaseId).toBe(baseId);expect(useApp.getState().raidTarget).toBeNull();expect(divineBattleSession.getSnapshot()).toBe(session);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
