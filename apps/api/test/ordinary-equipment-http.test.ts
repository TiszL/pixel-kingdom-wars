import {randomUUID} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app';
import {TEST_CONFIG} from './helpers';
import {ordinaryEquipmentPairFixture} from './fixtures/ordinaryEquipmentPair';
import {OrdinaryEquipmentEnvelopeSchema,OrdinaryEquipmentViewSchema} from '@shardkeep/shared/ordinaryEquipmentApi';
import {StarterExpeditionViewSchema} from '@shardkeep/shared/starterExpeditionApi';
it('authenticates before equipment/provider gates, rejects forged actors, serves fitted previews and reopens paused originals',async()=>{
 const f=await ordinaryEquipmentPairFixture();let app:FastifyInstance|undefined;
 try{
  async function open(deps=f.providers()){vi.stubEnv('MULTI_BASE_ENABLED','false');try{const next=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.f.conn.db,deps);await next.ready();return next;}finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}}
  app=await open();const request={idempotencyKey:randomUUID(),baseId:f.config.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1};
  expect((await app.inject({method:'GET',url:`/ordinary-equipment?baseId=${f.config.baseId}`})).statusCode).toBe(401);
  const forged=await app.inject({method:'POST',url:'/ordinary-equipment/jobs',cookies:f.cookies,payload:{...request,wallet:f.config.wallet}});expect(forged.statusCode).toBe(400);
  const before=await app.inject({method:'GET',url:`/ordinary-equipment?baseId=${f.config.baseId}`,cookies:f.cookies});expect(before.statusCode,before.body).toBe(200);expect(OrdinaryEquipmentViewSchema.parse(before.json()).equipmentStock[0]!.available).toBe('0');
  const quote=await app.inject({method:'GET',url:`/starter-expeditions?baseId=${f.config.baseId}&fitting=route_compass`,cookies:f.cookies});expect(quote.statusCode,quote.body).toBe(200);expect(StarterExpeditionViewSchema.parse(quote.json()).routes.every(r=>r.fitting?.itemId==='route_compass')).toBe(true);
  const post=await app.inject({method:'POST',url:'/ordinary-equipment/jobs',cookies:f.cookies,payload:request});expect(post.statusCode,post.body).toBe(200);const proof=OrdinaryEquipmentEnvelopeSchema.parse(post.json());expect(proof.status).toBe('accepted');
  await f.finishCraft(request.idempotencyKey);f.state({paused:true,providerless:true});await app.close();app=await open();
  const replay=await app.inject({method:'POST',url:'/ordinary-equipment/jobs',cookies:f.cookies,payload:request});expect(replay.statusCode,replay.body).toBe(200);expect(OrdinaryEquipmentEnvelopeSchema.parse(replay.json()).receipt).toEqual(proof.receipt);
  const current=await app.inject({method:'GET',url:`/ordinary-equipment?baseId=${f.config.baseId}`,cookies:f.cookies});expect(current.statusCode,current.body).toBe(200);expect(OrdinaryEquipmentViewSchema.parse(current.json()).equipmentStock[0]!.available).toBe('1');expect(current.headers['cache-control']).toBe('private, no-store');
  f.state({paused:false});
  const missingKey=randomUUID(),missing=await app.inject({method:'POST',url:'/ordinary-equipment/jobs',cookies:f.cookies,payload:{...request,idempotencyKey:missingKey}});
  expect(missing.statusCode,missing.body).toBe(422);expect(missing.json().error.code).toBe('INSUFFICIENT_CRAFTING_STOCK');
  expect((await app.inject({method:'GET',url:`/ordinary-equipment/jobs/by-key/${missingKey}`,cookies:f.cookies})).json().status).toBe('unknown');
  f.state({paused:true,providerless:true});
  const history=await app.inject({method:'GET',url:`/ordinary-equipment/jobs/by-key/${request.idempotencyKey}`,cookies:f.cookies});expect(history.json().completion).not.toBeNull();
 }finally{await app?.close();await f.dispose();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();}
},120_000);
