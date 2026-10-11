import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import fixture from '../../../../../packages/shared/src/testFixtures/realmSaleFailureApi.json';

const {wallet,idempotencyKey}=fixture.preparation;
const failure=()=>({wallet,idempotencyKey,failure:structuredClone(fixture.failure)});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve};}
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});
afterEach(()=>vi.unstubAllGlobals());

describe('original realm failure GET transport',()=>{
 it('uses only the exact authenticated GET and retains its explicit null outcome once',async()=>{
  const raw={wallet,idempotencyKey,failure:null},fetch=vi.fn<typeof globalThis.fetch>(async()=>json(raw)),retain=vi.fn(async()=>undefined);vi.stubGlobal('fetch',fetch);
  const {failedRealmSaleOriginal}=await import('./transport');expect(await failedRealmSaleOriginal({idempotencyKey,isCurrent:()=>true,retain})).toEqual(raw);
  expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0]![0]).toMatch(`/seeker/realm-sales/failures/by-key/${idempotencyKey}`);
  expect(fetch.mock.calls[0]![1]).toMatchObject({method:'GET',body:null,credentials:'include',cache:'no-store',redirect:'error'});expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
 });
 it('returns the strict separate failure envelope after the original evidence owner completes',async()=>{
  const raw=failure(),fetch=vi.fn(async()=>json(raw)),retain=vi.fn(async()=>undefined);vi.stubGlobal('fetch',fetch);const {failedRealmSaleOriginal}=await import('./transport');
  expect(await failedRealmSaleOriginal({idempotencyKey,isCurrent:()=>true,retain})).toEqual(raw);expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
 });
 it('lets malformed positive failure establish its hold before nested parsing or a stale-view error',async()=>{
  const raw={wallet,idempotencyKey,failure:{unknown:'positive'}},fetch=vi.fn(async()=>json(raw)),storage=Error('original failure retained but storage failed');vi.stubGlobal('fetch',fetch);
  const {failedRealmSaleOriginal}=await import('./transport');let current=true,held=false;
  await expect(failedRealmSaleOriginal({idempotencyKey,isCurrent:()=>current,retain:async value=>{held=(value as typeof raw).failure!==null;current=false;throw storage;}})).rejects.toBe(storage);
  expect(held).toBe(true);expect(fetch).toHaveBeenCalledOnce();
 });
 it('strictly rejects malformed nested failure only after retention has run',async()=>{
  const raw={wallet,idempotencyKey,failure:{unknown:'positive'}},retain=vi.fn(async()=>undefined);vi.stubGlobal('fetch',vi.fn(async()=>json(raw)));const {failedRealmSaleOriginal}=await import('./transport');
  await expect(failedRealmSaleOriginal({idempotencyKey,isCurrent:()=>true,retain})).rejects.toThrow();expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
 });
 it('awaits durable retention of late headers before rejecting the retired view',async()=>{
  const headers=deferred<Response>(),persist=deferred<void>(),fetch=vi.fn(async()=>headers.promise),raw=failure();vi.stubGlobal('fetch',fetch);const {failedRealmSaleOriginal}=await import('./transport');let current=true,finished=false;
  const retain=vi.fn(async()=>persist.promise),pending=failedRealmSaleOriginal({idempotencyKey,isCurrent:()=>current,retain}).catch(e=>e).finally(()=>{finished=true;});await flush();current=false;headers.resolve(json(raw));await flush();
  expect(retain).toHaveBeenCalledExactlyOnceWith(raw);expect(finished).toBe(false);persist.resolve();expect(await pending).toMatchObject({message:'Sign-in changed. Please try again.'});expect(fetch).toHaveBeenCalledOnce();
 });
 it('rejects detached outer identity and unknown outer fields before retention',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(),retain=vi.fn(async()=>undefined);vi.stubGlobal('fetch',fetch);const {failedRealmSaleOriginal}=await import('./transport');
  for(const raw of [{...failure(),extra:true},{...failure(),idempotencyKey:'00000000-0000-4000-8000-000000000099'},{...failure(),idempotencyKey:idempotencyKey.toUpperCase()},{...failure(),wallet:'invalid'},{wallet,idempotencyKey}]){
   fetch.mockImplementation(async()=>json(raw));await expect(failedRealmSaleOriginal({idempotencyKey,isCurrent:()=>true,retain})).rejects.toThrow();
  }expect(retain).not.toHaveBeenCalled();
 });
 it('rejects injected options and requires a retention owner before any request',async()=>{
  const fetch=vi.fn(async()=>json(failure()));vi.stubGlobal('fetch',fetch);const {failedRealmSaleOriginal}=await import('./transport'),input={idempotencyKey,isCurrent:()=>true,retain:async()=>undefined};
  for(const raw of [{...input,idempotencyKey:idempotencyKey.toUpperCase()},{...input,retain:undefined},{...input,method:'POST'},{...input,headers:{}}])await expect(failedRealmSaleOriginal(raw as typeof input)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
 it('never retries or refreshes authentication for failed original GETs',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(),retain=vi.fn(async()=>undefined);vi.stubGlobal('fetch',fetch);const {failedRealmSaleOriginal}=await import('./transport');
  for(const status of [401,503]){fetch.mockImplementation(async()=>json({error:{code:'REALM_SALE_UNAVAILABLE',message:'Unavailable'}},status));await expect(failedRealmSaleOriginal({idempotencyKey,isCurrent:()=>true,retain})).rejects.toMatchObject({status});}
  expect(fetch).toHaveBeenCalledTimes(2);expect(retain).not.toHaveBeenCalled();
 });
 it('restricts failure access to canonical GETs within its original request family',async()=>{
  const {requestRealmSaleOriginal,requestMiningClaimOriginal,requestUnpaidOriginal}=await import('../api'),fetch=vi.fn(async()=>json({})),observe=vi.fn(async()=>({})),base={method:'GET' as const,path:`/seeker/realm-sales/failures/by-key/${idempotencyKey}`,isCurrent:()=>true,timeoutMs:1000,observe};vi.stubGlobal('fetch',fetch);
  for(const method of [requestMiningClaimOriginal,requestUnpaidOriginal])await expect(method(base)).rejects.toThrow();
  for(const path of [base.path+'?x=1',base.path+'#x',base.path+'/',base.path.replace('failures','failure'),base.path.toUpperCase()])await expect(requestRealmSaleOriginal({...base,path})).rejects.toThrow();
  await expect(requestRealmSaleOriginal({...base,method:'POST'})).rejects.toThrow();await expect(requestRealmSaleOriginal({...base,body:{}})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
  expect(await requestRealmSaleOriginal(base)).toEqual({});expect(fetch).toHaveBeenCalledOnce();
 });
});
