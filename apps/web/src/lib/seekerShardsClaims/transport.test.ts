import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {command,identity,receipt,proof} from './fixtures.test-support';
import {matchSeekerShardsClaimsProof} from './journal';
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});
afterEach(()=>vi.unstubAllGlobals());
async function setup(){const {seekerShardsClaimOriginal}=await import('./transport');const retain=vi.fn(async(raw:unknown)=>{matchSeekerShardsClaimsProof(raw,identity,command);});return {seekerShardsClaimOriginal,options:{request:command.request,method:'POST' as const,isCurrent:()=>true,retain}};}
it('uses authenticated no-store exact-body POST and by-key GET without retries',async()=>{const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify(proof(true)),{status:201}));vi.stubGlobal('fetch',fetch);const {seekerShardsClaimOriginal,options}=await setup();await seekerShardsClaimOriginal(options);expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0]![1]).toMatchObject({credentials:'include',cache:'no-store',redirect:'error'});expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(command.request);fetch.mockImplementation(async()=>new Response(JSON.stringify(proof(false))));await seekerShardsClaimOriginal({...options,method:'GET'});expect(fetch.mock.calls[1]![0]).toContain(`/seeker/shards/claims/by-key/${command.request.idempotencyKey}`);expect(fetch.mock.calls[1]![1]!.body).toBeNull();});
it('retains complete owned evidence before logout or stale-view rejection',async()=>{let current=true,saved=false;vi.stubGlobal('fetch',vi.fn(async()=>{current=false;return new Response(JSON.stringify(proof(true)));}));const {seekerShardsClaimOriginal,options}=await setup();await expect(seekerShardsClaimOriginal({...options,isCurrent:()=>current,retain:async raw=>{matchSeekerShardsClaimsProof(raw,identity,command);await Promise.resolve();saved=true;}})).rejects.toThrow();expect(saved).toBe(true);});
it('does not accept unrelated wallet/term/destination receipts or malformed GET',async()=>{const fetch=vi.fn<typeof globalThis.fetch>();vi.stubGlobal('fetch',fetch);const {seekerShardsClaimOriginal,options}=await setup();for(const change of [{wallet:'So11111111111111111111111111111111111111112'},{termHash:'b'.repeat(64)},{baseId:'00000000-0000-4000-8000-000000000099'}]){fetch.mockImplementation(async()=>new Response(JSON.stringify({...proof(true),receipt:{...receipt(),...change}})));await expect(seekerShardsClaimOriginal(options)).rejects.toThrow();}fetch.mockImplementation(async()=>new Response('{}'));await expect(seekerShardsClaimOriginal({...options,method:'GET'})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(4);});
it('fails closed on durable storage failure and never retries a server refusal',async()=>{const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify(proof(true))));vi.stubGlobal('fetch',fetch);const {seekerShardsClaimOriginal,options}=await setup();await expect(seekerShardsClaimOriginal({...options,retain:async()=>{throw Error('storage failed');}})).rejects.toThrow('storage failed');fetch.mockImplementation(async()=>new Response(JSON.stringify({error:{code:'PHASE_E_DISABLED',message:'paused'}}),{status:503}));await expect(seekerShardsClaimOriginal(options)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);});
it('reads paginated entitlement snapshots through authenticated no-store GET',async()=>{const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response('{}'));vi.stubGlobal('fetch',fetch);const {api}=await import('../api');await api.getPrivate('/seeker/shards/entitlements?cursor='+command.request.termId,{isCurrent:()=>true});expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0]![1]).toMatchObject({method:'GET',credentials:'include',cache:'no-store',body:null});});

it('allows only the exact SHARDS original POST and by-key GET in the unpaid transport', async () => {
 const {requestUnpaidOriginal, requestMiningClaimOriginal, requestRealmSaleOriginal} = await import('../api');
 const fetch = vi.fn(async () => new Response('{}'));
 vi.stubGlobal('fetch', fetch);
 const original = {
  method: 'POST' as const, path: '/seeker/shards/claims', body: command.request,
  isCurrent: () => true, timeoutMs: 1000, observe: async () => ({}),
 };
 await requestUnpaidOriginal(original);
 await requestUnpaidOriginal({...original, method: 'GET', path: `/seeker/shards/claims/by-key/${command.request.idempotencyKey}`, body: undefined});
 for (const path of ['/seeker/shards/claims/', '/seeker/shards/claims?retry=1', '/seeker/shards/entitlements', `/seeker/shards/claims/by-key/${command.request.idempotencyKey}`]) {
  await expect(requestUnpaidOriginal({...original, path})).rejects.toThrow('Invalid unpaid original request');
 }
 for (const path of ['/seeker/shards/claims', '/seeker/shards/claims/by-key/bad', `/seeker/shards/claims/by-key/${command.request.idempotencyKey}?retry=1`]) {
  await expect(requestUnpaidOriginal({...original, method: 'GET', path, body: undefined})).rejects.toThrow('Invalid unpaid original request');
 }
 await expect(requestUnpaidOriginal({...original, method: 'GET', path: `/seeker/shards/claims/by-key/${command.request.idempotencyKey}`})).rejects.toThrow('Invalid unpaid original request');
 await expect(requestMiningClaimOriginal(original)).rejects.toThrow('Invalid unpaid original request');
 await expect(requestRealmSaleOriginal(original)).rejects.toThrow('Invalid unpaid original request');
 expect(fetch).toHaveBeenCalledTimes(2);
});
