import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {retirementFixture} from './testFixture';
const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('admits only the exact dissolution routes through the real session-safe helper',async()=>{
 const f=await retirementFixture(),fetch=vi.fn<typeof globalThis.fetch>(async()=>json(f.draft));vi.stubGlobal('fetch',fetch);const {requestRetirement}=await import('./transport');
 const retain=vi.fn(async()=>undefined),input={actor:f.actor,isCurrent:()=>true,retain};
 await requestRetirement({...input,request:{key:null,action:'create',body:f.draft.request}});
 await requestRetirement({...input,request:{key:f.draft.id,action:'read'}});
 for(const action of ['pay-members','prepare','recover-preparation','deliver','recover','cancel'] as const)await requestRetirement({...input,request:{key:f.draft.id,action,body:{}}});
 fetch.mockImplementation(async()=>json({version:1,actor:f.actor,idempotencyKey:f.draft.request.idempotencyKey,draft:f.draft}));
 await requestRetirement({...input,request:{key:f.draft.request.idempotencyKey,action:'by-key'}});expect(fetch).toHaveBeenCalledTimes(9);expect(retain).toHaveBeenCalledTimes(9);
 const api=await import('../api'),calls=fetch.mock.calls.length;
 for(const path of [`/clans/charter/retirements/${f.draft.id}?x=1`,`/clans/charter/retirements/${f.draft.id}/refund`,`/clans/charter/retirements/${f.draft.id}/recover/`,`/clans/charter/retirements/../client/activity`])await expect(api.requestCharterOriginal({method:'POST',path,body:{},isCurrent:()=>true,timeoutMs:1000,observe:async()=>({})})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(calls);
});
it('retains malformed same-original terminals before semantic rejection and excludes foreign identities',async()=>{
 const f=await retirementFixture(),raw={...f.draft,operation:{...f.operation,status:'completed',terminal:{outcome:'damaged'}}},fetch=vi.fn<typeof globalThis.fetch>(async()=>json(raw));vi.stubGlobal('fetch',fetch);
 const {requestRetirement}=await import('./transport'),retain=vi.fn(async()=>undefined),input={actor:f.actor,request:{key:f.draft.id,action:'read' as const},isCurrent:()=>true,retain};
 await expect(requestRetirement(input)).rejects.toThrow();expect(retain).toHaveBeenCalledWith(raw);retain.mockClear();fetch.mockImplementation(async()=>json({...raw,actor:f.policy.publicKey.toBase58()}));await expect(requestRetirement(input)).rejects.toThrow();expect(retain).not.toHaveBeenCalled();
});
