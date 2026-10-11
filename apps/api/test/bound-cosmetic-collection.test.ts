import Fastify from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {registerBoundCosmeticCollection,boundCosmeticQueueError} from '../src/game/boundCosmeticCollection';
import {HttpError} from '../src/lib/errors';
const opened:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(opened.splice(0).map(app=>app.close()));vi.unstubAllEnvs();});
function server(collect:ReturnType<typeof vi.fn<(wallet:string,requestedBaseId?:string)=>Promise<string|null>>>){
 vi.stubEnv('MULTI_BASE_ENABLED','true');const app=Fastify();opened.push(app);
 app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof HttpError?error.statusCode:400).send({error:error instanceof Error?error.message:String(error)}));
 registerBoundCosmeticCollection(app,{collectForBaseRead:collect});
 const preHandler=async(req:{wallet:string;headers:Record<string,unknown>})=>{if(!req.headers.authorization)throw new HttpError(401,'Sign in');req.wallet='authenticated-wallet';};
 for(const url of ['/base','/ordinary-crafting','/ordinary-equipment'])app.get(url,{preHandler},async req=>({query:req.query,collected:collect.mock.calls.length}));
 app.post('/ordinary-crafting/jobs',{preHandler},async()=>({original:true}));return app;
}
it('collects before the base response and pins implicit selection, only after authenticated GET admission',async()=>{
 const id=randomUUID(),collect=vi.fn(async()=>id),app=server(collect);
 expect((await app.inject({url:'/base'})).statusCode).toBe(401);expect(collect).not.toHaveBeenCalled();
 expect((await app.inject({method:'HEAD',url:'/base',headers:{authorization:'ok'}})).statusCode).toBe(200);expect(collect).not.toHaveBeenCalled();
 const base=await app.inject({url:'/base?legacyDisplay=kept',headers:{authorization:'ok'}});expect(base.json()).toEqual({query:{legacyDisplay:'kept',baseId:id},collected:1});
 expect(collect).toHaveBeenLastCalledWith('authenticated-wallet',undefined);
 await app.inject({method:'POST',url:'/ordinary-crafting/jobs',headers:{authorization:'ok'},payload:{baseId:randomUUID()}});expect(collect).toHaveBeenCalledTimes(1);
 vi.stubEnv('MULTI_BASE_ENABLED','false');await app.inject({url:'/base',headers:{authorization:'ok'}});expect(collect).toHaveBeenCalledTimes(1);
});
it('validates each Workshop query before completion and fails a source outage without publishing a stale response',async()=>{
 const id=randomUUID(),collect=vi.fn(async()=>id),app=server(collect);
 for(const path of ['/ordinary-crafting','/ordinary-equipment']){
  expect((await app.inject({url:path+'?baseId='+id+'&unexpected=true',headers:{authorization:'ok'}})).statusCode).toBe(400);
 }
 expect(collect).not.toHaveBeenCalled();
 for(const path of ['/ordinary-crafting','/ordinary-equipment'])expect((await app.inject({url:path+'?baseId='+id+'&catalogueVersion=2',headers:{authorization:'ok'}})).statusCode).toBe(200);
 expect(collect).toHaveBeenCalledTimes(2);
 collect.mockRejectedValueOnce(new Error('private source unavailable'));
 const failed=await app.inject({url:'/base?baseId='+id,headers:{authorization:'ok'}});expect(failed.statusCode).toBe(503);expect(failed.body).not.toContain('private source');
});
it('only classifies the exact rolled-back SQL queue refusal, preserving ambiguous transport failures',()=>{
 const refused={cause:{code:'P0001',message:'BOUND_COSMETIC_WORKSHOP_BUSY'}};
 expect(boundCosmeticQueueError(refused)).toMatchObject({statusCode:409,code:'ORDINARY_CRAFTING_BUSY'});
 for(const other of [{code:'ECONNRESET',message:'BOUND_COSMETIC_WORKSHOP_BUSY'},{code:'P0001',message:'different guard'},new Error('lost commit')])expect(boundCosmeticQueueError(other)).toBe(other);
});
