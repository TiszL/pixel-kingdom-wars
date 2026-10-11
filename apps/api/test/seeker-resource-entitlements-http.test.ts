import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { matchSeekerResourceEntitlementView } from '@shardkeep/shared/seekerResourceClaimsApi';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { sessions } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createResourceTaxFixture } from './fixtures/seekerResourceClaims';
import { retainResourceViewTerm } from './fixtures/seekerResourceEntitlements';
import { connectTestDb, TEST_CONFIG } from './helpers';
const conn=connectTestDb(),db=conn.db;let app:FastifyInstance;
const reader=vi.fn(async()=>{throw Error('No current chain provider');});
beforeAll(async()=>{await bootstrapSystemAccounts(db);vi.stubEnv('MULTI_BASE_ENABLED','false');app=await buildApp(TEST_CONFIG,db,{market:{finalizedDeedReader:reader,deedCollection:'11111111111111111111111111111111'}});await app.ready();});
afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await app.close();await conn.sql.end();});
it('real app discovery authenticates, stays private, and reads original rights while disabled without chain calls',async()=>{
 const f=await createResourceTaxFixture(db);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
 // A legitimate empty first page must not make later original rights disappear.
 // Pin a full scan page before this random fixture term, independent of suite order.
 for(let i=1;i<=16;i++){
  const hex=(BigInt('0x'+f.trip.termId.replaceAll('-',''))-BigInt(i)).toString(16).padStart(32,'0');
  await retainResourceViewTerm(db,[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-'),null);
 }
 const denied=await app.inject({url:'/seeker/resource-claims'});expect(denied.statusCode).toBe(401);expect(denied.headers['cache-control']).toBe('private, no-store');
 const [s]=await db.insert(sessions).values({wallet:f.winner.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.winner.wallet,s!.id)};
 const readPage=async(cursor:string|null)=>{
  const response=await app.inject({url:'/seeker/resource-claims'+(cursor?`?cursor=${encodeURIComponent(cursor)}`:''),cookies});
  expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
  const view=matchSeekerResourceEntitlementView(response.json(),f.winner.wallet,cursor);
  expect(view).toMatchObject({wallet:f.winner.wallet,claimsEnabled:false,status:'available'});return view;
 };
 let view=await readPage(null);expect(view.rows).toEqual([]);const visited=new Set<string>();
 while(!view.rows.some(row=>row.termId===f.trip.termId)){
  expect(view.nextCursor).not.toBeNull();const cursor=view.nextCursor!;
  expect(visited.has(cursor)).toBe(false);visited.add(cursor);view=await readPage(cursor);
 }
 expect(view.rows).toMatchObject([{termId:f.trip.termId,spotId:0,dueQuantity:'1'},{termId:f.trip.termId,spotId:20,dueQuantity:'1'}]);
 expect(reader).not.toHaveBeenCalled();
 expect((await app.inject({url:'/seeker/resource-claims?wallet='+f.other.wallet,cookies})).statusCode).toBe(400);
 expect((await app.inject({url:'/seeker/resource-claims?cursor=bad',cookies})).statusCode).toBe(400);
});
