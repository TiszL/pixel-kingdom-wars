// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {buildPhaseECatalogue} from '@shardkeep/shared/phaseE';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import {api} from '../../lib/api';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {hasMiningTaxClaimRecovery} from '../../lib/miningTaxClaims/journal';
import {MiningTaxClaimsEntry} from './MiningTaxClaimsEntry';
vi.mock('../../lib/miningTaxClaims/journal',()=>({hasMiningTaxClaimRecovery:vi.fn()}));
vi.mock('../../lib/miningTaxClaims/browser',()=>({miningTaxClaimIdentity:(wallet:string)=>({origin:'https://game.example',api:'https://api.example',cluster:'devnet',wallet})}));
vi.mock('./MiningTaxClaimsScreen',()=>({MiningTaxClaimsScreen:(props:{actionsEnabled:boolean;trust:unknown;recoveryTrust:unknown})=><p role="dialog">{JSON.stringify(props)}</p>}));
let root:Root,host:HTMLDivElement;
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
const render=async()=>{await act(async()=>root.render(<MiningTaxClaimsEntry actionsEnabled={false}/>));};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);useApp.getState().setAuth(fixtures.combined.wallet,true);useApp.getState().setScreen('bases');vi.mocked(hasMiningTaxClaimRecovery).mockReset().mockResolvedValue(false);vi.spyOn(api,'getPrivate').mockRejectedValue(Error('paused'));host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('leaves the flag-off screen unchanged when there is no saved history or catalogue',async()=>{await render();await until(()=>expect(api.getPrivate).toHaveBeenCalled());expect(host.querySelector('button')).toBeNull();});
it.each(['saved','unavailable'])('keeps %s storage discoverable while paused without manufacturing pins',async mode=>{if(mode==='saved')vi.mocked(hasMiningTaxClaimRecovery).mockResolvedValue(true);else vi.mocked(hasMiningTaxClaimRecovery).mockRejectedValue(Error('storage unavailable'));await render();await until(()=>expect(host.textContent).toContain('KEEP TAX & HISTORY'));await act(async()=>host.querySelector('button')!.click());await until(()=>expect(host.querySelector('[role=dialog]')).not.toBeNull());expect(host.textContent).toContain('"trust":null');expect(host.textContent).toContain('"recoveryTrust":null');expect(host.textContent).toContain('"actionsEnabled":false');});
it('catalogue discovery supplies no signing trust or action capability',async()=>{vi.mocked(api.getPrivate).mockResolvedValue(buildPhaseECatalogue() as never);await render();await until(()=>expect(host.textContent).toContain('KEEP TAX CLAIMS'));await act(async()=>host.querySelector('button')!.click());await until(()=>expect(host.textContent).toContain('"trust":null'));});
it('discards late discovery after cookie generation changes',async()=>{let release!:(v:boolean)=>void;vi.mocked(hasMiningTaxClaimRecovery).mockImplementation(()=>new Promise(r=>{release=r;}));let generation=true;vi.spyOn(authCookies,'current').mockImplementation(()=>generation);await render();await until(()=>expect(hasMiningTaxClaimRecovery).toHaveBeenCalled());generation=false;await act(async()=>release(true));expect(host.querySelector('button')).toBeNull();});
it('hides the previous wallet entry immediately when the actor changes',async()=>{vi.mocked(hasMiningTaxClaimRecovery).mockResolvedValue(true);await render();await until(()=>expect(host.querySelector('button')).not.toBeNull());vi.mocked(hasMiningTaxClaimRecovery).mockResolvedValue(false);await act(async()=>useApp.getState().setAuth(fixtures.combined.preparation!.identity.keepMint,true));expect(host.querySelector('button')).toBeNull();});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
