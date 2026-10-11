import {randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {registerDivineTrialRoutes} from '../src/game/divineTrialRoutes';
import type {DivineTrialProvider} from '../src/game/divineTrials';
import {HttpError} from '../src/lib/errors';
import vectors from '../../../packages/shared/src/testFixtures/divineTrialVectors.json' with {type:'json'};
const apps:FastifyInstance[]=[],headers={authorization:'fixture-session'},root='/divine-trials';
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
async function fixture(provider:Partial<DivineTrialProvider>|null=null){const app=Fastify();apps.push(app);app.decorateRequest('wallet','');app.decorate('authenticate',async(req:{headers:Record<string,unknown>;wallet:string})=>{if(req.headers.authorization!=='fixture-session')throw new HttpError(401,'Authentication required');req.wallet='authenticated-wallet';});registerDivineTrialRoutes(app,provider as DivineTrialProvider);await app.ready();return app;}
it('default runtime is closed, originals require authentication and responses never enter a public cache',async()=>{
 const app=await fixture(),url=root+'/events';expect((await app.inject({url})).statusCode).toBe(401);const response=await app.inject({url,headers});expect(response.statusCode).toBe(503);expect(response.headers['cache-control']).toBe('private, no-store');
});
it('entry and admission cannot accept a caller wallet, qualification, seed, army or score',async()=>{
 const enter=vi.fn(),admit=vi.fn(),app=await fixture({enter,admit}),id=randomUUID(),body={baseId:randomUUID(),idempotencyKey:randomUUID()};
 for(const path of ['entries','attempts'])for(const extra of [{wallet:'other'},{qualification:{}},{seed:999},{army:{}},{stars:3}])expect((await app.inject({method:'POST',url:`${root}/events/${id}/${path}`,headers,payload:{...body,...extra}})).statusCode).toBe(400);
 expect(enter).not.toHaveBeenCalled();expect(admit).not.toHaveBeenCalled();await app.inject({method:'POST',url:`${root}/events/${id}/entries`,headers,payload:body});expect(enter).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id,body);
});
it('submit accepts only the bounded fixed-roster batch and rejects attacker result or simulation options',async()=>{
 const submit=vi.fn(),app=await fixture({submit}),id=randomUUID(),orders=vectors.plans[0]!.attempt.orders,url=`${root}/attempts/${id}/submit`;
 for(const extra of [{result:{stars:3}},{snapshot:{}},{seed:1},{options:{stopAfterTick:0}}])expect((await app.inject({method:'POST',url,headers,payload:{orders,...extra}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url,headers,payload:{orders:{...orders,heroDeploys:[]}}})).statusCode).toBe(400);expect(submit).not.toHaveBeenCalled();
 await app.inject({method:'POST',url,headers,payload:{orders}});expect(submit).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id,{orders});
});
it('private sponsor funding and terminal ranking have no public mutation route',async()=>{
 const app=await fixture(),id=randomUUID();for(const url of [root+'/events',`${root}/events/${id}/close`,`${root}/events/${id}/fund`])expect((await app.inject({method:'POST',url,headers,payload:{winners:['forged']}})).statusCode).toBe(404);
});
it('claim, abandon and historical reads reject beneficiary substitution, side effects and noncanonical identifiers',async()=>{
 const claim=vi.fn(),abandon=vi.fn(),read=vi.fn(),app=await fixture({claim,abandon,read}),id=randomUUID();
 expect((await app.inject({method:'POST',url:`${root}/events/${id}/prize`,headers,payload:{baseId:randomUUID(),wallet:'other',amounts:{}}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:`${root}/attempts/${id}/abandon`,headers,payload:{refund:true}})).statusCode).toBe(400);
 expect((await app.inject({url:`${root}/attempts/${id}?wallet=other`,headers})).statusCode).toBe(400);expect((await app.inject({url:`${root}/attempts/${id.toUpperCase()}`,headers})).statusCode).toBe(400);
 expect(claim).not.toHaveBeenCalled();expect(abandon).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
});
