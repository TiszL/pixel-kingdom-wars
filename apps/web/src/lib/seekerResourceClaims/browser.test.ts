/** @vitest-environment happy-dom */
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {api} from '../api';
import {mutationGate} from '../mutationGate';
import {createSeekerResourceClaimsBrowserPorts,seekerResourceClaimsIdentity} from './browser';
import {seekerResourceClaimOriginal} from './transport';
import {command,id,identity} from './fixtures.test-support';
vi.mock('./transport',()=>({seekerResourceClaimOriginal:vi.fn()}));
vi.mock('../mutationGate',()=>({mutationGate:{getSnapshot:vi.fn(()=>true)}}));
beforeEach(()=>{vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);vi.spyOn(authCookies,'current').mockReturnValue(true);vi.mocked(mutationGate.getSnapshot).mockReturnValue(true);vi.mocked(seekerResourceClaimOriginal).mockReset();});
afterEach(()=>{vi.restoreAllMocks();useApp.getState().setAuth(null);});
function setup(){useApp.getState().setAuth(identity.wallet,true);useApp.getState().setSelectedBaseId(id(1),false);const page={active:true,visible:true,epoch:0,actionsEnabled:true};const ports=createSeekerResourceClaimsBrowserPorts({identity:seekerResourceClaimsIdentity(identity.wallet),lifecycle:()=>page});return {ports,page};}
it('blocks new actions on pause, base selection ABA and cookie replacement while recovery ignores destination',()=>{const {ports,page}=setup(),action=ports.capture(id(1)),history=ports.capture();page.actionsEnabled=false;expect(action).toThrow();expect(history).not.toThrow();page.actionsEnabled=true;useApp.getState().setSelectedBaseId(id(9),false);useApp.getState().setSelectedBaseId(id(1),false);expect(action).toThrow();expect(history).not.toThrow();vi.mocked(authCookies.current).mockReturnValue(false);expect(history).toThrow();});
it('rejects foreign origin/server, wallet replacement and retired views',()=>{const {ports,page}=setup(),guard=ports.capture();page.epoch++;expect(guard).toThrow();const other=createSeekerResourceClaimsBrowserPorts({identity:{...seekerResourceClaimsIdentity(identity.wallet),api:'https://elsewhere.test'},lifecycle:()=>page});expect(()=>other.capture()).toThrow();const fresh=ports.capture();useApp.setState({wallet:'So11111111111111111111111111111111111111112'});expect(fresh).toThrow();});
it('uses private no-store GET and passes owned retention through exact original transports',async()=>{const {ports,page}=setup();const get=vi.spyOn(api,'getPrivate').mockResolvedValue({} as never),guard=ports.capture(),retain=vi.fn(async()=>undefined);await ports.get('/seeker/resource-claims',guard);expect(get).toHaveBeenCalledOnce();await ports.getProof(command.request,guard,retain);await ports.post(command.request,guard,retain);expect(vi.mocked(seekerResourceClaimOriginal).mock.calls.map(([v])=>[v.method,v.request,v.retain])).toEqual([['GET',command.request,retain],['POST',command.request,retain]]);const owned=vi.mocked(seekerResourceClaimOriginal).mock.calls[1]![0];page.active=false;await owned.retain({wallet:identity.wallet,receipt:null});expect(retain).toHaveBeenCalledOnce();expect(owned.isCurrent).toThrow();});
