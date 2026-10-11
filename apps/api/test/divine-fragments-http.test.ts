import {randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {registerDivineFragmentRoutes,type DivineFragmentRouteProvider} from '../src/game/divineFragmentRoutes';
import {withDivineFragmentFixture} from './fixtures/divineFragments';
import {createDivineFragments} from '../src/game/divineFragments';
import {createSeekerFragmentClaims} from '../src/game/seekerFragmentClaims';
import {HttpError} from '../src/lib/errors';
const apps:FastifyInstance[]=[],headers={authorization:'fixture-session'},root='/divine-fragments';
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
async function fixture(provider:Partial<DivineFragmentRouteProvider>|null=null){const app=Fastify();apps.push(app);app.decorateRequest('wallet','');app.decorate('authenticate',async(req:{headers:Record<string,unknown>;wallet:string})=>{if(req.headers.authorization!=='fixture-session')throw new HttpError(401,'Authentication required');req.wallet='authenticated-wallet';});registerDivineFragmentRoutes(app,provider as DivineFragmentRouteProvider);await app.ready();return app;}
it('fresh production mount holds without a provider, requires authenticated history and forbids public source mutations',async()=>{
 const app=await fixture();for(const path of ['/policy','/awards','/seeker/terms']){expect((await app.inject({url:root+path})).statusCode).toBe(401);const r=await app.inject({url:root+path,headers});expect(r.statusCode).toBe(503);expect(r.headers['cache-control']).toBe('private, no-store');}
 for(const path of ['/enroll','/settle',`/events/${randomUUID()}/enroll`,`/events/${randomUUID()}/settle`])expect((await app.inject({method:'POST',url:root+path,headers,payload:{}})).statusCode).toBe(404);
});
it('commands reject supplied beneficiaries, earning source, amounts, carry, timestamps and certificate authority',async()=>{
 const deliver=vi.fn(),claim=vi.fn(),app=await fixture({fragments:{deliver} as never,seeker:{claim} as never}),id=randomUUID(),delivery={idempotencyKey:randomUUID(),baseId:randomUUID()},seeker={...delivery,termId:randomUUID(),spotId:0};
 for(const extra of [{wallet:'other'},{quantity:'1'},{gross:'14'},{carryBefore:'0'},{earnedAt:'2020-01-01T00:00:00.000Z'},{certificate:{}},{sourceHash:'f'.repeat(64)},{termId:randomUUID()}])expect((await app.inject({method:'POST',url:`${root}/events/${id}/delivery`,headers,payload:{...delivery,...extra}})).statusCode).toBe(400);
 for(const extra of [{wallet:'other'},{quantity:'1'},{poolTotal:'9'},{termHash:'f'.repeat(64)},{certificate:{}}])expect((await app.inject({method:'POST',url:`${root}/seeker/claims`,headers,payload:{...seeker,...extra}})).statusCode).toBe(400);
 expect(deliver).not.toHaveBeenCalled();expect(claim).not.toHaveBeenCalled();await app.inject({method:'POST',url:`${root}/events/${id}/delivery`,headers,payload:delivery});expect(deliver).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id,delivery);await app.inject({method:'POST',url:`${root}/seeker/claims`,headers,payload:seeker});expect(claim).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',seeker);
});
it('canonical exact recovery and pagination forbid wallet substitution and unrelated query fields',async()=>{
 const deliveryRead=vi.fn(),claimRead=vi.fn(),awards=vi.fn(),app=await fixture({fragments:{deliveryRead,awards} as never,seeker:{claimRead} as never}),id=randomUUID();
 for(const path of [`/deliveries/${id}?wallet=other`,`/seeker/claims/${id}?baseId=${id}`,`/deliveries/${id.toUpperCase()}`,`/awards?amount=1`,`/awards?cursor=${id.toUpperCase()}`])expect((await app.inject({url:root+path,headers})).statusCode).toBe(400);
 expect(deliveryRead).not.toHaveBeenCalled();expect(claimRead).not.toHaveBeenCalled();await app.inject({url:`${root}/deliveries/${id}`,headers});expect(deliveryRead).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id);
});

it('exact original term HTTP recovers actual source rights without a cursor, source provider or current base and preserves claim arithmetic',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);await f.play();const source=await f.settle(),termId=source.term!.snapshot.termId;
 const app=Fastify();apps.push(app);app.decorateRequest('wallet','');app.decorate('authenticate',async(req:{headers:Record<string,unknown>;wallet:string})=>{if(req.headers.authorization!=='fixture-session')throw new HttpError(401,'Authentication required');req.wallet=f.wallet;});
 registerDivineFragmentRoutes(app,{fragments:createDivineFragments(f.db,{...f.options,termSource:null}),seeker:createSeekerFragmentClaims(f.db,{...f.options,finalizedDeedReader:null})});await app.ready();
 process.env.PHASE_E_CATALOG_ENABLED='false';process.env.PHASE_E_SEEKER_ENABLED='false';f.setDeedOnline(false);
 const url=`${root}/seeker/terms/${termId}`;
 expect((await app.inject({url})).statusCode).toBe(401);
 const response=await app.inject({url,headers});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
 const before=response.json();expect(before.nextCursor).toBeNull();expect(before.wallet).toBe(f.wallet);expect(before.rows).toHaveLength(1);expect(before.rows[0]).toMatchObject({termId,spotId:0,poolTotal:'4',claimable:'2'});
 const claim=await f.seeker.claim(f.wallet,{termId,spotId:0,baseId:f.baseId,idempotencyKey:randomUUID()});expect(claim.quantity).toBe('2');
 await f.sql.begin(async tx=>{await tx`update bases set owner_wallet=${f.buyer},status='inactive' where id=${f.baseId}`;await tx`update base_slots set active=false where base_id=${f.baseId}`;});
 const after=await app.inject({url,headers});expect(after.statusCode).toBe(200);expect(after.json().rows[0]).toMatchObject({termId,spotId:0,poolTotal:'4',previousTotal:'2',cumulativeTotal:'2',claimable:'0'});
 for(const path of [url+'?cursor='+randomUUID(),url+'?wallet='+f.buyer,`${root}/seeker/terms/${termId.toUpperCase()}`])expect((await app.inject({url:path,headers})).statusCode).toBe(400);
 expect((await app.inject({url:`${root}/seeker/terms/${randomUUID()}`,headers})).statusCode).toBe(404);
}),120000);
