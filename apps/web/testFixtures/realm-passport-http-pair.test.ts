// @vitest-environment happy-dom
/** Unmodified bytes from realm-passport-pair.test.ts normal authenticated API.
 * Source fixture banks are local evidence; no live chain or release claim. */
import {afterEach,expect,it,vi} from 'vitest';
import {readPassportCurrent,readPassportExpeditions,readPassportInclusions} from '../src/lib/realmPassport/transport';
import pairs from './realm-passport-http-pair.test.json';
const locks={request:async(_key:string,_options:unknown,run:(lock:object)=>unknown)=>run({})} as LockManager;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});
function transport(raw:()=>string){vi.stubGlobal('navigator',{locks});const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(raw(),{status:200,headers:{'content-type':'application/json','cache-control':'private, no-store'}}));vi.stubGlobal('fetch',fetch);return fetch;}
it('reads both original-actor starter HTTP pages after recorded deed owner/slot transfer with the unchanged exclusive cursor',async()=>{
 const p=pairs.pairs.starter;let raw=p.raw.first;const fetch=transport(()=>raw),input={wallet:p.wallet,isCurrent:()=>true};
 const first=await readPassportExpeditions(input,{kind:'starter'});expect(first.state).toBe('available');if(first.state!=='available')throw Error('Expected actual source');
 expect(first.data.rows).toHaveLength(20);expect(first.data.nextCursor).not.toBeNull();raw=p.raw.second;
 const second=await readPassportExpeditions(input,{kind:'starter',cursor:first.data.nextCursor!});expect(second.state).toBe('available');if(second.state!=='available')throw Error('Expected actual source');
 expect(second.data.rows).toHaveLength(1);expect(second.data.nextCursor).toBeNull();expect(fetch.mock.calls[1]?.[0]).toContain('cursor='+first.data.nextCursor);
});
it('reads the real advanced HTTP return without substituting a missing route version',async()=>{
 const p=pairs.pairs.advanced;transport(()=>p.raw.first);const response=await readPassportExpeditions({wallet:p.wallet,isCurrent:()=>true},{kind:'advanced'});
 expect(response.state).toBe('available');if(response.state!=='available')throw Error('Expected actual source');expect(response.data.rows).toHaveLength(1);expect(response.data.rows[0]).toMatchObject({routeVersion:null,policyVersion:1});
});
it('preserves funded HTTP publication facts and earlier attestation without turning outage into zero',async()=>{
 const p=pairs.pairs.mining;let raw=p.raw.history;const fetch=transport(()=>raw),input={wallet:p.wallet,isCurrent:()=>true};
 const history=await readPassportInclusions(input);expect(history.state).toBe('available');if(history.state!=='available')throw Error('Expected actual source');expect(history.data.rows).toHaveLength(2);
 raw=p.raw.current;const current=await readPassportCurrent(input);expect(current).toMatchObject({state:'available',data:{published:{cumulativeRenown:'2',cumulativeDays:'2'},attested:{renownTotal:'1',daysAttested:'1',lastSequence:'1'}}});
 raw=p.raw.unavailable;expect(await readPassportCurrent(input)).toMatchObject({state:'unavailable',reason:'SOURCE_UNAVAILABLE',data:null});
 expect(fetch.mock.calls.every(([,options])=>options?.credentials==='include'&&options.cache==='no-store')).toBe(true);
});
