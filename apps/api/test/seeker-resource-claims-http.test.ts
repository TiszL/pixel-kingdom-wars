import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
/** Real earning receipts -> authenticated claim -> usable stock and durable recovery. */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, baseSlots, resourceStocks, sessions } from '../src/db/schema';
import * as ownership from '../src/game/baseOwnership';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createResourceTaxFixture } from './fixtures/seekerResourceClaims';
import { createTestPlayer, TEST_CONFIG } from './helpers';

const conn=resourceClaimsDatabase(),db=conn.db;let app:FastifyInstance;
const reader=vi.fn(async()=>{throw Error('No provider is available');});
async function start(){
 const previous=process.env.MULTI_BASE_ENABLED;process.env.MULTI_BASE_ENABLED='false';
 try{app=await buildApp(TEST_CONFIG,db,{market:{finalizedDeedReader:reader,deedCollection:'11111111111111111111111111111111'}});await app.ready();}
 finally{if(previous===undefined)delete process.env.MULTI_BASE_ENABLED;else process.env.MULTI_BASE_ENABLED=previous;}
}
beforeAll(async()=>{await conn.setup();await bootstrapSystemAccounts(db);await start();});
beforeEach(()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');reader.mockClear();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await app.close();await conn.close();});
async function cookies(wallet:string){const [s]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
async function fixture(){const f=await createResourceTaxFixture(db);return {...f,cookies:await cookies(f.winner.wallet),request:f.command()};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const post=(f:Fixture,body:object=f.request)=>app.inject({method:'POST',url:'/seeker/resource-claims',cookies:f.cookies,payload:body});
const history=(f:Fixture)=>app.inject({url:`/seeker/resource-claims/by-key/${f.request.idempotencyKey}`,cookies:f.cookies});
const balance=async(f:Fixture)=>(await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId,f.baseId),eq(resourceStocks.resourceId,f.trip.resourceId))))[0]?.available??0n;

describe('Seeker original-resource claim HTTP',()=>{
 it('authenticates before flags and never calls a deed provider for disabled new claims',async()=>{
  const f=await fixture();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  for(const request of [{method:'POST' as const,url:'/seeker/resource-claims',payload:f.request},{url:`/seeker/resource-claims/by-key/${f.request.idempotencyKey}`}]){
   const response=await app.inject(request);expect(response.statusCode).toBe(401);expect(response.headers['cache-control']).toBe('private, no-store');
  }
  await db.update(bases).set({deedAssetId:f.other.wallet,deedMintAssetId:f.other.wallet}).where(eq(bases.id,f.baseId));
  expect((await post(f)).statusCode).toBe(503);expect(reader).not.toHaveBeenCalled();expect(await balance(f)).toBe(0n);
 });
 it('delivers the actual source pool once and recovers the same receipt after restart, pause and deed transfer',async()=>{
  const f=await fixture(),response=await post(f);expect(response.statusCode).toBe(201);
  const accepted=response.json();expect(accepted.wallet).toBe(f.winner.wallet);
  expect(accepted.receipt.quantity).toBe(((f.trip.tax+3n)/3n).toString());expect(await balance(f)).toBe(BigInt(accepted.receipt.quantity));
  await app.close();await start();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  const buyer=await createTestPlayer(db);
  await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));});
  const replay=await post(f);expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(accepted);expect((await history(f)).json()).toEqual(accepted);
  expect(reader).not.toHaveBeenCalled();expect(await balance(f)).toBe(BigInt(accepted.receipt.quantity));
  const foreign=await app.inject({url:`/seeker/resource-claims/by-key/${f.request.idempotencyKey}`,cookies:await cookies(buyer.wallet)});
  expect(foreign.statusCode).toBe(200);expect(foreign.json().receipt).toBeNull();expect(foreign.body).not.toContain(f.winner.wallet);
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');expect((await post(f,{...f.request,idempotencyKey:randomUUID(),spotId:20})).statusCode).toBe(404);
  expect(await conn.sql`select id from seeker_resource_claims where id=${f.request.idempotencyKey}`).toHaveLength(1);
  expect(await conn.sql`select bucket from seeker_resource_claim_entries where claim_id=${f.request.idempotencyKey}`).toHaveLength(2);
 });
 it('rejects caller payout authority and changed replay bodies without a second credit',async()=>{
  const f=await fixture();
  for(const extra of [{quantity:'1000'},{winner:f.winner.wallet},{poolTotal:'1000'},{claimedAt:new Date().toISOString()}])expect((await post(f,{...f.request,...extra})).statusCode).toBe(400);
  expect(await balance(f)).toBe(0n);expect((await post(f)).statusCode).toBe(201);const before=await balance(f);
  expect((await post(f,{...f.request,spotId:20})).statusCode).toBe(409);expect(await balance(f)).toBe(before);
 });
 it('rechecks the live pause after locking destination authority',async()=>{
  const f=await fixture(),original=ownership.assertFreshLockedBaseAuthority;
  vi.spyOn(ownership,'assertFreshLockedBaseAuthority').mockImplementation(async(...args)=>{const result=await original(...args);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');return result;});
  expect((await post(f)).statusCode).toBe(503);expect(await balance(f)).toBe(0n);
  expect(await conn.sql`select id from seeker_resource_claims where id=${f.request.idempotencyKey}`).toHaveLength(0);
 });
});
