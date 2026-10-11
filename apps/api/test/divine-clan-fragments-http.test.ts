import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {expect,it} from 'vitest';
import {divineClanFragmentFixture} from './fixtures/divineClanFragments';
import {registerDivineFragmentRoutes} from '../src/game/divineFragmentRoutes';
import {createDivineFragments} from '../src/game/divineFragments';
import {HttpError} from '../src/lib/errors';

it('actual clan member uses unchanged authenticated award/delivery/receipt routes with a private paused source',async()=>{
 const f=await divineClanFragmentFixture();const app=Fastify();try{
  await f.clan.enroll(f.event.id);await f.play();const settled=await f.settle(),member=f.members[1]!;
  app.decorateRequest('wallet','');app.decorate('authenticate',async(req:{headers:Record<string,unknown>;wallet:string})=>{if(req.headers.authorization!=='member-session')throw new HttpError(401,'Authentication required');req.wallet=member.wallet;});
  registerDivineFragmentRoutes(app,{fragments:createDivineFragments(f.db,{...f.fragmentOptions,termSource:null}),seeker:f.seeker});await app.ready();
  const headers={authorization:'member-session'},root='/divine-fragments',url=`${root}/events/${f.event.id}`;
  expect((await app.inject({url})).statusCode).toBe(401);
  const view=await app.inject({url,headers});expect(view.statusCode,view.body).toBe(200);expect(view.json().award).toEqual(settled.awards.find(a=>a.wallet===member.wallet));expect(view.headers['cache-control']).toBe('private, no-store');
  const request={idempotencyKey:randomUUID(),baseId:member.baseId};
  for(const patch of [{source_kind:'clan'},{clanId:f.birth.consent.clanId},{rosterSize:1},{gross:'40'},{wallet:f.source.wallet}])
   expect((await app.inject({url:url+'/delivery',method:'POST',headers,payload:{...request,...patch}})).statusCode).toBe(400);
  const response=await app.inject({url:url+'/delivery',method:'POST',headers,payload:request});expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({wallet:member.wallet,eventId:f.event.id,quantity:'11',baseId:member.baseId});
  process.env.PHASE_E_CATALOG_ENABLED='false';
  const original=await app.inject({url:`${root}/deliveries/${request.idempotencyKey}`,headers});expect(original.statusCode).toBe(200);expect(original.json().receipt).toEqual(response.json());
  expect((await app.inject({url:root+'/clan/enroll',method:'POST',headers,payload:{eventId:f.event.id}})).statusCode).toBe(404);
 }finally{await app.close();await f.dispose();}
},120000);
