import {randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import {afterEach,expect,it,vi} from 'vitest';
import {registerCharterTournamentRoutes} from '../src/game/clanCharterTournamentRoutes';
import {registerCharterTournamentEventsRoutes} from '../src/game/clanCharterTournamentEventsRoutes';
import type {CharterTournamentProvider} from '../src/game/clanCharterTournaments';
import type {CharterTournamentEventsClientProvider} from '../src/game/clanCharterTournamentEventsClient';
import {HttpError} from '../src/lib/errors';
const apps:FastifyInstance[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
async function fixture(provider:CharterTournamentProvider|null=null,events:CharterTournamentEventsClientProvider|null=null){
 const app=Fastify();apps.push(app);app.decorateRequest('wallet','');
 app.decorate('authenticate',async(req:{headers:Record<string,unknown>;wallet:string})=>{if(req.headers.authorization!=='fixture-session')throw new HttpError(401,'Authentication required');req.wallet='authenticated-wallet';});
 registerCharterTournamentRoutes(app,provider);registerCharterTournamentEventsRoutes(app,events);await app.ready();return app;
}
const headers={authorization:'fixture-session'},root='/clans/charter/tournaments';
it('keeps default runtime closed and authenticates before disclosing an original',async()=>{
 const app=await fixture(),url=root+'/operations/'+randomUUID();
 expect((await app.inject({url})).statusCode).toBe(401);
 const held=await app.inject({url,headers});expect(held.statusCode).toBe(503);expect(held.headers['cache-control']).toBe('private, no-store');
});
it('binds entry only to the authenticated actor and rejects injected roster, results and wallet',async()=>{
 const createEntry=vi.fn(async()=>({version:1,status:'pending'}));
 const app=await fixture({createEntry} as unknown as CharterTournamentProvider),input={eventId:randomUUID(),clanId:randomUUID(),idempotencyKey:randomUUID()};
 for(const extra of [{wallet:'another-wallet'},{roster:['another-wallet']},{score:999},{leader:'another-wallet'}]){
  expect((await app.inject({method:'POST',url:root+'/entries',headers,payload:{...input,...extra}})).statusCode).toBe(400);
 }
 expect(createEntry).not.toHaveBeenCalled();
 const created=await app.inject({method:'POST',url:root+'/entries',headers,payload:input});expect(created.statusCode).toBe(201);
 expect(createEntry).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',input);
});
it('delivery accepts only an original ID, never replacement transaction or blockhash',async()=>{
 const deliver=vi.fn(async()=>({status:'held',reason:'NOT_SIGNED'})),app=await fixture({deliver} as unknown as CharterTournamentProvider),id=randomUUID(),url=`${root}/operations/${id}/deliver`;
 for(const payload of [{signedTransaction:'AAAA'},{blockhash:'replacement'},{signature:'caller-trusted'}])expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
 expect(deliver).not.toHaveBeenCalled();
 expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(200);expect(deliver).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id);
});
it('requires canonical singleleader base64 and rejects query additions before any wire retention',async()=>{
 const retainSigned=vi.fn(async()=>({status:'signed'})),app=await fixture({retainSigned} as unknown as CharterTournamentProvider),id=randomUUID(),url=`${root}/operations/${id}/signed`;
 for(const signedTransaction of ['','AAAA','!'.repeat(1000),Buffer.alloc(1233).toString('base64')])expect((await app.inject({method:'POST',url,headers,payload:{signedTransaction}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:url+'?actor=other',headers,payload:{signedTransaction:Buffer.alloc(100).toString('base64')}})).statusCode).toBe(400);
 expect(retainSigned).not.toHaveBeenCalled();
});
it('tournament matchmaking never accepts a defender, ordinary raid identity, or caller score',async()=>{
 const startRaid=vi.fn(async()=>({version:1,raid:null})),app=await fixture(null,{startRaid} as unknown as CharterTournamentEventsClientProvider),id=randomUUID(),input={baseId:randomUUID(),idempotencyKey:randomUUID()},url=`${root}/events/${id}/raids`;
 for(const extra of [{defenderWallet:'selected-target'},{defenderBaseId:randomUUID()},{raidId:randomUUID()},{stars:3},{privateKey:randomUUID()}])expect((await app.inject({method:'POST',url,headers,payload:{...input,...extra}})).statusCode).toBe(400);
 expect(startRaid).not.toHaveBeenCalled();expect((await app.inject({method:'POST',url,headers,payload:input})).statusCode).toBe(200);expect(startRaid).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id,input);
});
it('canonical closure and original prize claims cannot accept winners or another beneficiary',async()=>{
 const close=vi.fn(async()=>({version:1})),claim=vi.fn(async()=>({version:1})),app=await fixture(null,{close,claim} as unknown as CharterTournamentEventsClientProvider),id=randomUUID();
 expect((await app.inject({method:'POST',url:`${root}/events/${id}/close`,headers,payload:{winners:[randomUUID()]}})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:`${root}/events/${id}/prize`,headers,payload:{baseId:randomUUID(),wallet:'chosen-recipient',amount:'900'}})).statusCode).toBe(400);
 expect(close).not.toHaveBeenCalled();expect(claim).not.toHaveBeenCalled();
 expect((await app.inject({method:'POST',url:`${root}/events/${id}/close`,headers,payload:{}})).statusCode).toBe(200);expect(close).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id);
});
it('abandonment accepts only the authenticated original request key, never a selected raid or refund command',async()=>{
 const cancelRaidRequest=vi.fn(async()=>({version:1,status:'cancelled',ordinal:null,raid:null})),app=await fixture(null,{cancelRaidRequest} as unknown as CharterTournamentEventsClientProvider),id=randomUUID(),key=randomUUID(),url=`${root}/events/${id}/raids/by-key/${key}/cancel`;
 for(const payload of [{raidId:randomUUID()},{wallet:'other-wallet'},{refund:true},{baseId:randomUUID()}])expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
 expect(cancelRaidRequest).not.toHaveBeenCalled();expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(200);expect(cancelRaidRequest).toHaveBeenCalledExactlyOnceWith('authenticated-wallet',id,key);
});
