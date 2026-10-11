/** Default-off capability, real auth and strict client-only input boundary. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {TEST_CONFIG} from './helpers';
let f:Awaited<ReturnType<typeof vehicleBurnDatabase>>,app:FastifyInstance|undefined,cookies:Record<string,string>;
beforeEach(async()=>{f=await vehicleBurnDatabase();const [s]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,s!.id)};vi.stubEnv('MULTI_BASE_ENABLED','false');},120000);
afterEach(async()=>{await app?.close();app=undefined;await f?.dispose();vi.unstubAllEnvs();},120000);
it('requires authentication and has no ambient vehicle client provider',async()=>{
 app=await buildApp(TEST_CONFIG,f.conn.db);await app.ready();const url='/vehicles/client/installations/'+f.reservation.id;
 expect((await app.inject({url})).statusCode).toBe(401);const held=await app.inject({url,cookies});expect(held.statusCode).toBe(503);expect(held.json().error.code).toBe('VEHICLE_CLIENT_UNAVAILABLE');expect(held.headers['cache-control']).toBe('private, no-store');
},120000);
it('does not accept proof, fee, replacement, extra query or caller wire for delivery',async()=>{
 const {createVehicleClient}=await import('../src/game/vehicleClient');app=await buildApp(TEST_CONFIG,f.conn.db,{vehicleClientProvider:createVehicleClient(f.conn.db)});await app.ready();const root='/vehicles/client/installations/'+f.reservation.id;
 for(const action of ['prepare','recover','review','deliver'])for(const body of [{proof:{}},{fee:0},{blockhash:f.identity.assetId},{baseId:randomUUID()},{signedTransaction:'AA=='}])expect((await app.inject({method:'POST',url:root+'/'+action,cookies,payload:body})).statusCode).toBe(400);
 expect((await app.inject({url:root+'?wallet='+f.actor,cookies})).statusCode).toBe(400);expect((await app.inject({url:'/vehicles/client/assets?limit=1000',cookies})).statusCode).toBe(400);
 expect((await app.inject({method:'POST',url:root+'/signed',cookies,payload:{signedTransaction:'A'.repeat(5000)}})).statusCode).toBe(413);
 const read=await app.inject({url:root,cookies});expect(read.statusCode,read.body).toBe(200);expect(read.headers['cache-control']).toBe('private, no-store');
 expect(await f.conn.sql`select count(*)::int n from vehicle_burn_signed_wires`).toEqual([{n:0}]);
},120000);
