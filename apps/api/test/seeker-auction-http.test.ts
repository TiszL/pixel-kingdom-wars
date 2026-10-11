/** T10: production app registration/auth/cache guards; no auction DB authority. */
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { players,sessions } from '../src/db/schema';
import { issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC } from '../src/auth/session';
import { connectTestDb,TEST_CONFIG } from './helpers';
const conn=connectTestDb(),apps:FastifyInstance[]=[];
const wallet='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const paths=[['GET','/seeker/auctions/current'],['GET','/seeker/auctions/refunds'],['GET','/seeker/auctions/round/0'],['GET','/seeker/auctions/tx/'+'2'.repeat(88)],
 ['POST','/seeker/auctions/bids/prepare'],['POST','/seeker/auctions/withdrawals/prepare'],['POST','/seeker/auctions/submit']] as const;
afterAll(async()=>{for(const app of apps)await app.close();await conn.sql.end();});
describe('SA-1 default-off auction routes',()=>{
 it('T10 all auction endpoints are absent when the flag is unset or false',async()=>{
  for(const config of [TEST_CONFIG,{...TEST_CONFIG,PHASE_E_SEEKER_AUCTION_ENABLED:'false' as const}]){
   const app=await buildApp(config,conn.db);apps.push(app);
   for(const [method,url]of paths)expect((await app.inject({method,url})).statusCode).toBe(404);
  }
 });
 it('authenticates enabled routes and refuses missing finalized source without caching',async()=>{
  const app=await buildApp({...TEST_CONFIG,PHASE_E_SEEKER_AUCTION_ENABLED:'true'},conn.db);apps.push(app);
  const unauth=await app.inject({url:paths[0][1]});expect(unauth.statusCode).toBe(401);expect(unauth.headers['cache-control']).toBe('private, no-store');
  await conn.db.insert(players).values({wallet}).onConflictDoNothing();
  const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};
  const missing=await app.inject({url:paths[0][1],cookies});expect(missing.statusCode).toBe(503);expect(missing.headers['cache-control']).toBe('private, no-store');
  const missingRefunds=await app.inject({url:'/seeker/auctions/refunds',cookies});expect(missingRefunds.statusCode).toBe(503);expect(missingRefunds.headers['cache-control']).toBe('private, no-store');
  for(const url of ['/seeker/auctions/refunds?round=0','/seeker/auctions/refunds?round=0&spot=01','/seeker/auctions/refunds?wallet=x','/seeker/auctions/current?wallet=x','/seeker/auctions/round/00','/seeker/auctions/round/18446744073709551616','/seeker/auctions/tx/bad'])
   expect((await app.inject({url,cookies})).statusCode).toBe(400);
 });
});
