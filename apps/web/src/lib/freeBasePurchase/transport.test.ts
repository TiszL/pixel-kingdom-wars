import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { command,identity,receipt } from './fixtures.test-support';
import { matchFreeBasePurchaseProof } from './journal';
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});
afterEach(()=>vi.unstubAllGlobals());
async function setup(){const {purchaseOriginal}=await import('./transport');const retain=vi.fn(async(raw:unknown)=>{matchFreeBasePurchaseProof(raw,identity,command);});return {purchaseOriginal,retain,options:{request:command.request,method:'POST' as const,firstAttempt:true,isCurrent:()=>true,retain,refusal:vi.fn(async()=>undefined)}};}
it('sends exact body once and validates flat POST and wrapped GET receipts through the real owned transport',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify(receipt()),{status:201}));vi.stubGlobal('fetch',fetch);const {purchaseOriginal,options,retain}=await setup();
 await purchaseOriginal(options);expect(fetch).toHaveBeenCalledOnce();expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(command.request);expect(retain).toHaveBeenCalledOnce();
 fetch.mockImplementation(async()=>new Response(JSON.stringify({receipt:receipt()})));await purchaseOriginal({...options,method:'GET',firstAttempt:false});expect(fetch.mock.calls[1]![0]).toContain(`/bases/free-purchases/by-key/${command.request.idempotencyKey}`);
});
it('retains a complete received receipt before obsolete-view rejection and awaits storage',async()=>{
 let current=true,saved=false;vi.stubGlobal('fetch',vi.fn(async()=>{current=false;return new Response(JSON.stringify(receipt()));}));
 const {purchaseOriginal,options}=await setup();await expect(purchaseOriginal({...options,isCurrent:()=>current,retain:async p=>{matchFreeBasePurchaseProof(p,identity,command);await Promise.resolve();saved=true;}})).rejects.toThrow();expect(saved).toBe(true);
});
it('fails closed on wrong terms and unavailable or malformed recovery without POST retries',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify({...receipt(),shardsCharged:'1'})));vi.stubGlobal('fetch',fetch);const {purchaseOriginal,options}=await setup();
 await expect(purchaseOriginal(options)).rejects.toThrow();fetch.mockImplementation(async()=>new Response('{}',{status:404}));await expect(purchaseOriginal({...options,method:'GET',firstAttempt:false})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
});
it('retains definitive first refusal but never treats a retry failure as proof of original absence',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{code:'PHASE_E_DISABLED',message:'paused'}}),{status:503})));
 const {purchaseOriginal,options}=await setup();await expect(purchaseOriginal(options)).rejects.toThrow();expect(options.refusal).toHaveBeenCalledOnce();await expect(purchaseOriginal({...options,firstAttempt:false})).rejects.toThrow();expect(options.refusal).toHaveBeenCalledOnce();
});
