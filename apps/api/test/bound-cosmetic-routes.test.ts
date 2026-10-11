import Fastify from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {registerBoundCosmeticRoutes} from '../src/game/boundCosmeticRoutes';
import type {BoundCosmeticWorkshop} from '../src/game/boundCosmeticWorkshop';
import {HttpError} from '../src/lib/errors';
const id='00000000-0000-4000-8000-000000000001',baseId='00000000-0000-4000-8000-000000000002',wallet='11111111111111111111111111111111';
const request={idempotencyKey:id,baseId,recipeId:'craft_artisan_market_awning_t1_v1',recipeVersion:1,appearanceBindingSha256:'a'.repeat(64)};
const opened:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(opened.splice(0).map(app=>app.close()));});
function server(present=true){
 const provider={view:vi.fn(async()=>({view:true})),read:vi.fn(async()=>({status:'unknown'})),start:vi.fn(async()=>({status:'accepted'})),preference:vi.fn(async()=>({revision:'1'})),collectForBaseRead:vi.fn(async()=>baseId)};
 const app=Fastify();opened.push(app);app.decorate('authenticate',async(req)=>{if(req.headers.authorization!=='session')throw new HttpError(401,'Sign in');req.wallet=wallet;});
 app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof HttpError?error.statusCode:500).send({error:{code:error instanceof HttpError?error.code:undefined,message:error instanceof Error?error.message:String(error)}}));
 registerBoundCosmeticRoutes(app,present?provider as unknown as BoundCosmeticWorkshop:null);return {app,provider};
}
it('authenticates every status/original/write route before exposing disabled service availability',async()=>{
 const {app,provider}=server(false);
 for(const entry of [{method:'GET' as const,url:'/bound-cosmetics'},{method:'GET' as const,url:'/bound-cosmetics/jobs/by-key/'+id},{method:'POST' as const,url:'/bound-cosmetics/jobs',payload:request},{method:'PUT' as const,url:'/bound-cosmetics/awning',payload:{baseId,enabled:false,expectedRevision:'0'}}]){
  expect((await app.inject(entry)).statusCode).toBe(401);
  expect((await app.inject({...entry,headers:{authorization:'session'}})).statusCode).toBe(503);
 }
 for(const call of Object.values(provider))expect(call).not.toHaveBeenCalled();
});
it('uses only the authenticated actor and exact original key and prevents caching private replies',async()=>{
 const {app,provider}=server(),headers={authorization:'session'};
 expect((await app.inject({url:'/bound-cosmetics?baseId='+baseId,headers})).headers['cache-control']).toBe('private, no-store');
 expect(provider.view).toHaveBeenCalledWith(wallet,baseId);
 expect((await app.inject({url:'/bound-cosmetics/jobs/by-key/'+id,headers})).statusCode).toBe(200);expect(provider.read).toHaveBeenCalledWith(wallet,id);
 expect((await app.inject({method:'POST',url:'/bound-cosmetics/jobs',headers,payload:request})).statusCode).toBe(200);expect(provider.start).toHaveBeenCalledWith(wallet,request);
 const toggle={baseId,enabled:false,expectedRevision:'9'};expect((await app.inject({method:'PUT',url:'/bound-cosmetics/awning',headers,payload:toggle})).statusCode).toBe(200);expect(provider.preference).toHaveBeenCalledWith(wallet,toggle);
 expect(provider.collectForBaseRead).not.toHaveBeenCalled(); // Accepted original recovery owns its own ordering.
});
it('rejects actor overrides, altered recipes and ambiguous preference revisions before a private call',async()=>{
 const {app,provider}=server(),headers={authorization:'session'};
 for(const payload of [{...request,wallet:'other'},{...request,quantity:2},{...request,baseId:'invalid'}])expect((await app.inject({method:'POST',url:'/bound-cosmetics/jobs',headers,payload})).statusCode).toBe(400);
 for(const expectedRevision of [0,'01','-1','9223372036854775807'])expect((await app.inject({method:'PUT',url:'/bound-cosmetics/awning',headers,payload:{baseId,enabled:false,expectedRevision}})).statusCode).toBe(400);
 expect((await app.inject({url:'/bound-cosmetics?baseId='+baseId+'&wallet=other',headers})).statusCode).toBe(400);
 expect((await app.inject({url:'/bound-cosmetics/jobs/by-key/'+id+'?baseId='+baseId,headers})).statusCode).toBe(400);
 for(const call of Object.values(provider))expect(call).not.toHaveBeenCalled();
});
