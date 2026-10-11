import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots } from '../src/db/schema';
import { claimSeekerResourceTax } from '../src/game/seekerResourceClaims';
import * as claims from '../src/game/seekerResourceClaims';
import { readSeekerResourceEntitlements } from '../src/game/seekerResourceEntitlements';
import { createResourceTaxFixture } from './fixtures/seekerResourceClaims';
import { retainResourceViewTerm } from './fixtures/seekerResourceEntitlements';
import { createTestPlayer } from './helpers';
const conn=resourceClaimsDatabase(),db=conn.db;
beforeAll(()=>conn.setup());
afterAll(()=>conn.close());afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
// Fresh fixture claims explicitly enable the production gate; callbacks cannot bypass it.
beforeEach(()=>vi.stubEnv('PHASE_E_SEEKER_ENABLED','true'));
const enabled={assertAdmission(){}};
async function page(wallet:string,termId:string){
 // Exact predecessor avoids unrelated terms created by independent fixture cases.
 const n=BigInt('0x'+termId.replaceAll('-',''))-1n,s=n.toString(16).padStart(32,'0');
 const cursor=[s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');
 return readSeekerResourceEntitlements(db,wallet,{cursor});
}
describe('bounded original-winner resource discovery',()=>{
 it('shows equal original King/regular rights from both actual ledgers while paused without a destination base',async()=>{
  const f=await createResourceTaxFixture(db);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({status:'inactive',ownerWallet:f.other.wallet}).where(eq(bases.id,f.baseId));});
  const view=await page(f.winner.wallet,f.trip.termId);
  expect(view).toMatchObject({wallet:f.winner.wallet,status:'available',claimsEnabled:false,shardsIncluded:false});
  expect(view.rows).toHaveLength(2);
  expect(view.rows.map(r=>[r.spotId,r.poolTotal,r.cumulativeTotal,r.claimedTotal,r.dueQuantity])).toEqual([[0,'4','1','0','1'],[20,'4','1','0','1']]);
  expect(view.rows.every(r=>r.termId===f.trip.termId&&r.termHash===f.trip.termHash&&r.resourceId===f.trip.resourceId)).toBe(true);
  const outsider=await createTestPlayer(db);expect((await page(outsider.wallet,f.trip.termId)).rows).toEqual([]);
 });
 it('discovers paid-down rights after reconnect and late original-term earnings without current owner or lease',async()=>{
  const f=await createResourceTaxFixture(db,{singleWinner:true,settleHarvester:false});
  await claimSeekerResourceTax(db,f.winner.wallet,f.command(),f.authority,enabled);
  let view=await page(f.winner.wallet,f.trip.termId);expect(view.rows[0]).toMatchObject({poolTotal:'1',claimedTotal:'1',dueQuantity:'0'});
  await f.settle(15);const reopened=conn.reopen();
  try { view=await readSeekerResourceEntitlements(reopened.db,f.winner.wallet,{cursor:view.cursor!});expect(view.rows[0]).toMatchObject({poolTotal:'4',claimedTotal:'1',dueQuantity:'3'}); }
  finally{await reopened.sql.end();}
 });
 it('keeps browse continuation on empty bounded pages and refresh discovers earlier newly retained rights',async()=>{
  const wallet=(await createTestPlayer(db)).wallet;
  const ids=Array.from({length:18},(_,i)=>`00000000-0000-4000-8000-${(100+i).toString().padStart(12,'0')}`);
  for(const [i,id]of ids.entries())await retainResourceViewTerm(db,id,i===17?wallet:null);
  const first=await readSeekerResourceEntitlements(db,wallet,{});expect(first.rows).toEqual([]);expect(first.nextCursor).toBe(ids[15]);
  const second=await readSeekerResourceEntitlements(db,wallet,{cursor:first.nextCursor!});expect(second.rows).toEqual([]);expect(second.nextCursor).toBe(ids[17]);
  const earlier='00000000-0000-4000-8000-000000000050';await retainResourceViewTerm(db,earlier,wallet);
  const refreshed=await readSeekerResourceEntitlements(db,wallet,{});expect(refreshed.nextCursor).toBe(earlier);expect(refreshed.rows).toEqual([]);
 });
 it('returns source integrity unavailable when one producer leg is absent, with no writes',async()=>{
  const f=await createResourceTaxFixture(db),original=(await conn.sql`select * from harvester_entries where source_id=${f.harvester.id} and ordinal=1 and bucket='issued'`)[0]!;
  await conn.sql.begin(async tx=>{await tx.unsafe('set local session_replication_role=replica');await tx`delete from harvester_entries where source_id=${f.harvester.id} and ordinal=1 and bucket='issued'`;});
  try {
   vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');expect(await page(f.winner.wallet,f.trip.termId)).toMatchObject({status:'unavailable',reason:'SOURCE_INTEGRITY',rows:[],nextCursor:null});
   expect(await conn.sql`select id from seeker_resource_claims where term_id=${f.trip.termId}`).toHaveLength(0);
  }finally{await conn.sql.begin(async tx=>{await tx.unsafe('set local session_replication_role=replica');await tx`insert into harvester_entries(source_id,ordinal,bucket,delta)values(${original.source_id},${original.ordinal},${original.bucket},${original.delta})`;});}
 });
 it('refuses a malformed latest claim rather than reporting a smaller claimed amount',async()=>{
  const f=await createResourceTaxFixture(db),claim=await claimSeekerResourceTax(db,f.winner.wallet,f.command(),f.authority,enabled);
  await conn.sql.begin(async tx=>{await tx.unsafe('set local session_replication_role=replica');await tx`update seeker_resource_claims set wallet=${f.other.wallet} where id=${claim.id}`;});
  try{expect(await page(f.winner.wallet,f.trip.termId)).toMatchObject({status:'unavailable',reason:'SOURCE_INTEGRITY',rows:[]});}
  finally{await conn.sql.begin(async tx=>{await tx.unsafe('set local session_replication_role=replica');await tx`update seeker_resource_claims set wallet=${f.winner.wallet} where id=${claim.id}`;});}
 });
 it('bounds source bytes across the whole page before decoding any oversized later pool',async()=>{
  const f=await createResourceTaxFixture(db),original=(await conn.sql`select home_evidence from harvester_sources where id=${f.harvester.id}`)[0]!.home_evidence;
  await conn.sql.begin(async tx=>{await tx.unsafe('set local session_replication_role=replica');await tx`update harvester_sources set home_evidence=${JSON.stringify({padding:'x'.repeat(9*1024*1024)})}::jsonb where id=${f.harvester.id}`;});
  try{expect(await page(f.winner.wallet,f.trip.termId)).toMatchObject({status:'unavailable',reason:'SOURCE_BOUNDS',rows:[]});}
  finally{await conn.sql.begin(async tx=>{await tx.unsafe('set local session_replication_role=replica');await tx`update harvester_sources set home_evidence=${JSON.stringify(original)}::jsonb where id=${f.harvester.id}`;});}
 });
 it('rejects caller wallet, destination and authority fields before a query',async()=>{
  const player=await createTestPlayer(db);
  for(const query of [{wallet:player.wallet},{baseId:randomUUID()},{poolTotal:'999'},{cursor:'invalid'}])
   await expect(readSeekerResourceEntitlements(db,player.wallet,query)).rejects.toThrow();
 });
 it('uses one cumulative source budget for every pool and refuses before a second real ledger replay exceeds it',async()=>{
  const f=await createResourceTaxFixture(db),read=claims.readCompleteSeekerResourcePool,budgets:unknown[]=[];
  vi.spyOn(claims,'readCompleteSeekerResourcePool').mockImplementation(async(...args)=>{budgets.push(args[4]);return read(...args);});
  expect((await page(f.winner.wallet,f.trip.termId)).status).toBe('available');
  expect(budgets).toHaveLength(8);expect(new Set(budgets).size).toBe(1);
  const budget=claims.createSeekerResourceSourceBudget();await read(db,f.trip.termId,f.trip.termHash,f.trip.resourceId,budget);
  // The next source group fits independently, but does not fit the remaining
  // whole-page allowance. Resetting the budget per resource would accept it.
  budget.bytes=8n*1024n*1024n-budget.bytes+1n;
  await expect(read(db,f.trip.termId,f.trip.termHash,f.trip.resourceId,budget)).rejects.toMatchObject({code:'SEEKER_RESOURCE_SOURCE_BOUNDS'});
 });
});
