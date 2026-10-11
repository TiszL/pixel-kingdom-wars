import {afterEach,beforeEach,expect,it,vi} from 'vitest';
beforeEach(()=>vi.resetModules());afterEach(()=>vi.unstubAllGlobals());
const id='00000000-0000-4000-8000-000000000001';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const wake={idempotencyKey:id,baseId:'00000000-0000-4000-8000-000000000002',recipeId:'craft_aurora_wake_v1',recipeVersion:1,appearanceBindingSha256:'a'.repeat(64)};
it('keeps bound crafting originals in their exact endpoint family',async()=>{
 const fetch=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>json({status:'accepted'}));vi.stubGlobal('fetch',fetch);
 const {requestBoundCosmeticOriginal}=await import('./api');
 const observe=vi.fn(async(_status:number,body:unknown)=>body),options={timeoutMs:1000,isCurrent:()=>true,observe};
 for(const path of ['/bound-cosmetics','/bound-cosmetics/awning','/bound-cosmetics/jobs?retry=true','/ordinary-crafting/jobs'])
  await expect(requestBoundCosmeticOriginal({...options,method:'POST',path,body:{idempotencyKey:id}})).rejects.toThrow();
 expect(fetch).not.toHaveBeenCalled();
 await requestBoundCosmeticOriginal({...options,method:'POST',path:'/bound-cosmetics/jobs',body:{idempotencyKey:id}});
 await requestBoundCosmeticOriginal({...options,method:'GET',path:'/bound-cosmetics/jobs/by-key/'+id});
 expect(fetch).toHaveBeenCalledTimes(2);expect(observe).toHaveBeenCalledTimes(2);
 expect(fetch.mock.calls[0]?.[1]).toMatchObject({credentials:'include',redirect:'error',cache:'no-store',body:JSON.stringify({idempotencyKey:id})});
});
it('awaits original durable retention after the view becomes stale without issuing another request',async()=>{
 let current=true,retained=false,release!:()=>void;
 const wait=new Promise<void>(resolve=>{release=resolve;});
 vi.stubGlobal('fetch',vi.fn(async()=>json({status:'accepted'})));
 const {requestBoundCosmeticOriginal}=await import('./api');
 const result=requestBoundCosmeticOriginal({method:'POST',path:'/bound-cosmetics/jobs',body:{idempotencyKey:id},timeoutMs:1000,isCurrent:()=>current,
  observe:async(_status,body)=>{current=false;await wait;retained=true;return body;}});
 const rejected=expect(result).rejects.toThrow();await vi.waitFor(()=>expect(current).toBe(false));expect(retained).toBe(false);
 release();await rejected;expect(retained).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);
});
it('guards a delayed preference response before stale errors can navigate the current account',async()=>{
 let current=true,respond!:(value:Response)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{respond=resolve;})));
 const {api,setMaintenanceHandler}=await import('./api'),navigate=vi.fn();setMaintenanceHandler(navigate);
 const result=api.put('/bound-cosmetics/awning',{enabled:false,expectedRevision:'1'},{isCurrent:()=>current});const rejected=expect(result).rejects.toThrow();
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));current=false;respond(json({error:{code:'MAINTENANCE',message:'paused'}},503));
 await rejected;expect(navigate).not.toHaveBeenCalled();
});
it('admits only the exact Wake crafting route and strict original request before sending',async()=>{
 const fetch=vi.fn(async()=>json({status:'accepted'}));vi.stubGlobal('fetch',fetch);
 const {requestBoundCosmeticOriginal}=await import('./api');
 const options={timeoutMs:1000,isCurrent:()=>true,observe:async(_status:number,body:unknown)=>body};
 for(const path of ['/bound-cosmetics/wakes/v1/jobs?retry=true','/bound-cosmetics/wakes/v1/jobs/','/bound-cosmetics/wakes/v2/jobs','/bound-cosmetics/wakes/v1/preference','/bound-cosmetics/wakes/v1/workshop'])
  await expect(requestBoundCosmeticOriginal({...options,method:'POST',path,body:wake})).rejects.toThrow();
 for(const body of [{...wake,recipeId:'craft_artisan_market_awning_t1_v1'},{...wake,recipeVersion:'1'},{...wake,wallet:'injected'},{...wake,appearanceBindingSha256:'A'.repeat(64)},null])
  await expect(requestBoundCosmeticOriginal({...options,method:'POST',path:'/bound-cosmetics/wakes/v1/jobs',body})).rejects.toThrow();
 await expect(requestBoundCosmeticOriginal({...options,method:'GET',path:'/bound-cosmetics/wakes/v1/jobs'})).rejects.toThrow();
 expect(fetch).not.toHaveBeenCalled();
 await requestBoundCosmeticOriginal({...options,method:'POST',path:'/bound-cosmetics/wakes/v1/jobs',body:wake});
 expect(fetch).toHaveBeenCalledTimes(1);
 expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/bound-cosmetics/wakes/v1/jobs'),expect.objectContaining({body:JSON.stringify(wake),credentials:'include',redirect:'error',cache:'no-store'}));
});
it('retains a late accepted Wake original before rejecting the replaced view without resending',async()=>{
 let current=true,retained=false,release!:()=>void;
 const wait=new Promise<void>(resolve=>{release=resolve;});
 const fetch=vi.fn(async()=>json({status:'accepted'}));vi.stubGlobal('fetch',fetch);
 const {requestBoundCosmeticOriginal}=await import('./api');
 const result=requestBoundCosmeticOriginal({method:'POST',path:'/bound-cosmetics/wakes/v1/jobs',body:wake,timeoutMs:1000,isCurrent:()=>current,
  observe:async(_status,body)=>{current=false;await wait;retained=true;return body;}});
 const rejected=expect(result).rejects.toThrow();await vi.waitFor(()=>expect(current).toBe(false));expect(retained).toBe(false);
 release();await rejected;expect(retained).toBe(true);expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps a failed Wake submission unknown without an implicit transport retry',async()=>{
 const fetch=vi.fn(async()=>json({error:{code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE',message:'paused'}},503));vi.stubGlobal('fetch',fetch);
 const {requestBoundCosmeticOriginal}=await import('./api'),accepted=vi.fn();
 await expect(requestBoundCosmeticOriginal({method:'POST',path:'/bound-cosmetics/wakes/v1/jobs',body:wake,timeoutMs:1000,isCurrent:()=>true,
  observe:async(status,body)=>{if(status>=200&&status<300){accepted(body);return body;}return undefined;}})).rejects.toThrow();
 expect(accepted).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
});
