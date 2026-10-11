/** @vitest-environment happy-dom */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useApp} from '../../state/store';
import {captureBaseBalanceCommit} from '../../state/baseSnapshot';
import {base,directory,funds} from '../workshop/snapshot.test-support';
import {view as stock} from '../ordinaryCrafting/fixtures.test-support';
import {refreshSeekerResourceClaimsSnapshot} from './snapshot';
import type {SeekerResourceClaimsPorts} from './controller';
import {identity,id} from './fixtures.test-support';
let ports:SeekerResourceClaimsPorts;
const read=async(path:string):Promise<unknown>=>{if(path==='/me')return {wallet:identity.wallet};if(path==='/bases')return directory();if(path.startsWith('/base?'))return base();if(path.startsWith('/balances?'))return funds;if(path.startsWith('/ordinary-crafting?'))return stock();throw Error(path);};
beforeEach(()=>{useApp.getState().setAuth(identity.wallet,true);useApp.getState().setSelectedBaseId(id(1),false);useApp.getState().setBalances({...funds,shards:'999'});ports={get:vi.fn(read),getProof:vi.fn(),post:vi.fn(),capture:()=>()=>undefined,lock:async(_n,f)=>f(),key:()=>id(2)};});
afterEach(()=>{useApp.getState().setAuth(null);vi.restoreAllMocks();});
it('publishes current base and balances with separately read raw stock, never historical receipt stock',async()=>{const result=await refreshSeekerResourceClaimsSnapshot(identity,ports,()=>undefined,id(1));expect(result?.view.rawStock).toEqual(stock().rawStock);expect(useApp.getState().balances).toEqual(funds);expect(vi.mocked(ports.get).mock.calls.map(([p])=>p)).toEqual(['/me','/bases',`/base?baseId=${id(1)}`,`/balances?baseId=${id(1)}`,`/ordinary-crafting?baseId=${id(1)}&catalogueVersion=2`,'/me','/bases']);expect(ports.getProof).not.toHaveBeenCalled();});
it.each(['foreign','baseABA','ownership'])('refuses %s changes during raw stock refresh',async bad=>{let count=0;ports.get=vi.fn(async p=>{if(p.startsWith('/ordinary-crafting?')){if(bad==='foreign')return {...stock(),wallet:'So11111111111111111111111111111111111111112'};if(bad==='baseABA'){useApp.getState().setSelectedBaseId(id(9),false);useApp.getState().setSelectedBaseId(id(1),false);}}if(p==='/bases'&&++count===2&&bad==='ownership')return {...directory(),bases:[]};return read(p);});await expect(refreshSeekerResourceClaimsSnapshot(identity,ports)).rejects.toThrow();expect(useApp.getState().balances?.shards).toBe('999');});
it('a newer balance snapshot defeats stale hydration without overwriting current stock',async()=>{ports.get=vi.fn(async p=>{if(p.startsWith('/ordinary-crafting?'))captureBaseBalanceCommit(id(1))({...funds,shards:'80000'});return read(p);});await expect(refreshSeekerResourceClaimsSnapshot(identity,ports)).rejects.toThrow();expect(useApp.getState().balances?.shards).toBe('80000');});
it('saved receipt for a transferred original never hydrates a different selected kingdom',async()=>{useApp.getState().setSelectedBaseId(id(9),false);ports.get=vi.fn(async p=>p==='/bases'?{...directory(),bases:[{id:id(9),status:'active',slot:1}]}:read(p));expect(await refreshSeekerResourceClaimsSnapshot(identity,ports,()=>undefined,id(1))).toBeNull();expect(ports.get).toHaveBeenCalledTimes(2);});
