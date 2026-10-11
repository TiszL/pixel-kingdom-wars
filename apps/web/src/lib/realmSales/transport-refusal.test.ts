import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const request={idempotencyKey:'12345678-1234-4234-8234-123456789abc',spot:0,realm:0};
const json=(code='INSUFFICIENT_SOL',status=422)=>new Response(JSON.stringify({error:{code,message:'Declined'}}),{status});
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});
afterEach(()=>vi.unstubAllGlobals());
it('retains a complete first prepare refusal before rejecting an obsolete view',async()=>{
 let deliver!:(response:Response)=>void;const reply=new Promise<Response>(resolve=>{deliver=resolve;});const fetch=vi.fn(async()=>reply);vi.stubGlobal('fetch',fetch);
 const {prepareRealmSaleOriginal}=await import('./transport');let current=true;const refusal=vi.fn(async()=>undefined),retain=vi.fn(async()=>undefined);
 const outcome=prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>current,retain,refusal}).catch(e=>e);
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());current=false;deliver(json());expect(await outcome).toBeInstanceOf(Error);
 expect(refusal).toHaveBeenCalledExactlyOnceWith({status:422,code:'INSUFFICIENT_SOL'});expect(retain).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledOnce();
});
it('does not retain refusals from GET, unrecognized status/code or malformed error envelopes',async()=>{
 const fetch=vi.fn(async()=>json());vi.stubGlobal('fetch',fetch);const {prepareRealmSaleOriginal}=await import('./transport'),refusal=vi.fn(async()=>undefined),retain=vi.fn(async()=>undefined);
 await expect(prepareRealmSaleOriginal({request,method:'GET',isCurrent:()=>true,retain,refusal})).rejects.toThrow();expect(refusal).not.toHaveBeenCalled();
 for(const response of [json('REALM_SALE_UNAVAILABLE',503),json('INSUFFICIENT_SOL',503),new Response(JSON.stringify({error:{code:'INSUFFICIENT_SOL',message:'No',extra:true}}),{status:422})]){
  fetch.mockImplementation(async()=>response);await expect(prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>true,retain,refusal})).rejects.toThrow();
 }
 expect(refusal).not.toHaveBeenCalled();expect(retain).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(4);
});
it('waits for durable refusal storage and never retries when that storage fails',async()=>{
 const fetch=vi.fn(async()=>json());vi.stubGlobal('fetch',fetch);const {prepareRealmSaleOriginal}=await import('./transport');const refusal=vi.fn(async()=>{throw Error('durable storage full');});
 await expect(prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>true,retain:async()=>undefined,refusal})).rejects.toThrow('durable storage full');expect(refusal).toHaveBeenCalledOnce();expect(fetch).toHaveBeenCalledOnce();
});
it.each(['REALM_SALE_NO_QUOTA','REALM_SALE_UNSOLD','REALM_SALE_REALM_UNAVAILABLE'])('retains %s only from the first complete POST response, never an absence read',async code=>{
 const fetch=vi.fn(async()=>json(code));vi.stubGlobal('fetch',fetch);
 const {prepareRealmSaleOriginal}=await import('./transport'),refusal=vi.fn(async()=>undefined),retain=vi.fn(async()=>undefined);
 await expect(prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>true,retain,refusal})).rejects.toThrow();
 expect(refusal).toHaveBeenCalledExactlyOnceWith({status:422,code});refusal.mockClear();
 await expect(prepareRealmSaleOriginal({request,method:'GET',isCurrent:()=>true,retain,refusal})).rejects.toThrow();
 expect(refusal).not.toHaveBeenCalled();expect(retain).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(2);
});
