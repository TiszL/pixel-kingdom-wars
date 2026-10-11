import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {migrationFixture} from './testFixture';
const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('preserves a terminal before rejecting stale views and admits only original migration endpoints',async()=>{
 const f=migrationFixture(),raw={...f.migration,status:'controlled',terminal:{id:f.migration.id,outcome:'controlled'}},fetch=vi.fn<typeof globalThis.fetch>(async()=>json(raw));vi.stubGlobal('fetch',fetch);
 const {requestMigration}=await import('./transport'),retain=vi.fn(async()=>undefined),input={actor:f.actor,isCurrent:()=>true,retain};
 await requestMigration({...input,request:{key:null,action:'create',body:f.migration.request}});await requestMigration({...input,request:{key:f.migration.id,action:'read'}});
 for(const action of ['prepare','recover-preparation','recover','cancel','deliver'] as const)await requestMigration({...input,request:{key:f.migration.id,action,body:{}}});
 fetch.mockImplementation(async()=>json({version:1,actor:f.actor,idempotencyKey:f.migration.request.idempotencyKey,migration:raw}));await requestMigration({...input,request:{key:f.migration.request.idempotencyKey,action:'by-key'}});expect(retain).toHaveBeenLastCalledWith(raw);
 const api=await import('../api');for(const path of [`/clans/charter/migrations/${f.migration.id}/pay-members`,`/clans/charter/migrations/${f.migration.id}/refund`,`/clans/charter/migrations/${f.migration.id}/cancel?x=1`])await expect(api.requestCharterOriginal({method:'POST',path,body:{},isCurrent:()=>true,timeoutMs:1000,observe:async()=>({})})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(8);
});
it('retains same-original malformed terminals from by-key without accepting another request identity',async()=>{
 const f=migrationFixture(),raw={...f.migration,status:'controlled',terminal:{outcome:'damaged'}},envelope={version:1,actor:f.actor,idempotencyKey:f.migration.request.idempotencyKey,migration:raw};
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(envelope));vi.stubGlobal('fetch',fetch);const {requestMigration}=await import('./transport'),retain=vi.fn(async()=>undefined),input={actor:f.actor,request:{key:f.migration.request.idempotencyKey,action:'by-key' as const},isCurrent:()=>true,retain};
 await expect(requestMigration(input)).rejects.toThrow();expect(retain).toHaveBeenCalledWith(raw);retain.mockClear();fetch.mockImplementation(async()=>json({...envelope,idempotencyKey:f.migration.id}));await expect(requestMigration(input)).rejects.toThrow();expect(retain).not.toHaveBeenCalled();
});
