/** Synthetic authority fixtures exercise real DB admission, not chain finality. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_HARVESTER as P, PHASE_E_SEEKER_AUCTION as A } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS as IDS, PHASE_E_RAW_RESOURCES as R } from '@shardkeep/shared/phaseEResources';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { baseRaidLocks, bases, baseSlots, builderJobs, buildings, harvesterSourceHeads, harvesterSources, players, raids, resourceStocks } from '../src/db/schema';
import { readHarvesterSource, selectHarvesterSource, type HarvesterSourceCommand } from '../src/game/harvesterSources';
import { readHarvesterSettlement } from '../src/game/harvesterSettlement';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';
const conn=connectTestDb(), db=conn.db;
afterAll(()=>conn.sql.end()); afterEach(()=>vi.restoreAllMocks());
async function fixture(wallet?: string) {
  if (!wallet) { wallet=Keypair.generate().publicKey.toBase58(); await db.insert(players).values({wallet}); }
  const f=await createStarterExpeditionFixture(db,{wallet});
  const [b]=await db.insert(buildings).values({baseId:f.baseId,playerWallet:wallet,type:BuildingType.Harvester,tx:9,ty:2}).returning();
  const completedAt=new Date(f.now.getTime()-1_000);
  const [j]=await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:wallet,buildingId:b!.id,kind:'build',
    startedAt:new Date(completedAt.getTime()-BUILD_COSTS[BuildingType.Harvester].buildSec*1_000),finishesAt:completedAt,completedAt}).returning();
  const reader={async readOperatingTerm(){return {snapshot:f.snapshot,finality:{commitment:'finalized' as const,contextSlot:'200',observedAt:result.now.toISOString()}};}};
  const result={...f,harvesterId:b!.id,jobId:j!.id,reader,cmd:{id:randomUUID(),baseId:f.baseId,harvesterId:b!.id,policyVersion:P.v1.policyVersion}};
  return result;
}
type F=Awaited<ReturnType<typeof fixture>>;
const select=(f:F,cmd:HarvesterSourceCommand=f.cmd)=>selectHarvesterSource(db,f.wallet,cmd,f.authority,{reader:f.reader,clock:()=>f.now});
it('pins SQL only to immutable v1 economics and native identities',()=>{
  const migration=readFileSync(new URL('../drizzle/0148_harvester_sources.sql',import.meta.url),'utf8');
  expect(migration).toContain(JSON.stringify(Object.fromEntries(IDS.map(id=>[R[id].realmId,id]))));
  expect(migration).toContain(`interval '${P.v1.maxLeaseSec} seconds'`);
  expect(migration).toContain(`NEW.policy_version=${P.v1.policyVersion}`);
});
describe('Harvester immutable source admission without issuance',()=>{
 it('freezes original native source and bounded lease, with no stock or allowance grant',async()=>{
  const f=await fixture(), p=await select(f);
  expect(p).toMatchObject({actorWallet:f.wallet,baseId:f.baseId,harvesterId:f.harvesterId,realmId:'crownlands',resourceId:'crown_iron_ore',admittedAt:f.now});
  expect(p.leaseExpiresAt.getTime()).toBe(f.now.getTime()+P.v1.maxLeaseSec*1_000);
  expect(await db.select().from(resourceStocks).where(eq(resourceStocks.baseId,f.baseId))).toEqual([]);
  expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet,f.wallet))).toHaveLength(1);
  expect(await readHarvesterSource(db,p.id)).toEqual(p);
 });
 it('historical same-key replay survives custody, facility removal and current policy changes without reader or clock',async()=>{
  const f=await fixture(), p=await select(f), buyer=Keypair.generate().publicKey.toBase58(); await db.insert(players).values({wallet:buyer});
  await db.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId)); await db.update(bases).set({ownerWallet:buyer,status:'inactive'}).where(eq(bases.id,f.baseId));
  await db.update(buildings).set({level:0}).where(eq(buildings.id,f.harvesterId));
  const policy=P as unknown as {currentPolicyVersion:number}, old=policy.currentPolicyVersion;
  try { policy.currentPolicyVersion=old+1;
   expect(await selectHarvesterSource(db,f.wallet,f.cmd,f.authority,{clock:()=>{throw new Error('no historical clock');}})).toEqual(p);
   await expect(selectHarvesterSource(db,buyer,f.cmd,f.authority)).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
  }finally{policy.currentPolicyVersion=old;}
 });
 it('settles and closes an expired obligation before a fresh different-base lease',async()=>{
  const f=await fixture(), p=await select(f); await db.update(baseSlots).set({slot:2}).where(eq(baseSlots.baseId,f.baseId));
  const other=await fixture(f.wallet); other.now=new Date(p.leaseExpiresAt.getTime()+1);
  const renewed=await select(other); expect(renewed.baseId).toBe(other.baseId);
  expect(await readHarvesterSource(db,p.id)).toEqual(p);
  const original=await readHarvesterSettlement(db,p.id); expect(original!.closure?.reason).toBe('lease_expired');
  expect(original!.events).toHaveLength(15); // original output is preserved before head replacement
 });
 it('refuses buyer admission on a base whose old original-wallet obligation is pending',async()=>{
  const f=await fixture(), p=await select(f), buyer=Keypair.generate().publicKey.toBase58(); await db.insert(players).values({wallet:buyer});
  await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer}).where(eq(bases.id,f.baseId));await tx.insert(baseSlots).values({wallet:buyer,slot:1,baseId:f.baseId});});
  f.wallet=buyer;
  await expect(select(f,{...f.cmd,id:randomUUID()})).rejects.toMatchObject({code:'HARVESTER_SOURCE_PENDING'});
  expect(await readHarvesterSource(db,p.id)).toEqual(p);
 });
 it.each(['unfinished','wrong-facility','inactive','authority','raid'] as const)('%s refuses a new interval without leaving source or head',async reason=>{
  const f=await fixture();
  if(reason==='unfinished')await db.update(builderJobs).set({completedAt:null}).where(eq(builderJobs.id,f.jobId));
  if(reason==='wrong-facility')f.cmd.harvesterId=f.lodgeId;
  if(reason==='inactive')await db.update(bases).set({status:'inactive'}).where(eq(bases.id,f.baseId));
  if(reason==='authority')f.authority.assertAuthority=async()=>{throw new Error('unavailable');};
  if(reason==='raid'){const a=await fixture();const [r]=await db.insert(raids).values({idempotencyKey:randomUUID(),attackerWallet:a.wallet,defenderWallet:f.wallet,attackerBaseId:a.baseId,defenderBaseId:f.baseId,seed:1n,snapshot:{},armySnapshot:{},simVersion:9,ordersDeadlineAt:new Date(f.now.getTime()+60_000)}).returning();await db.insert(baseRaidLocks).values({baseId:f.baseId,raidId:r!.id,expiresAt:r!.ordersDeadlineAt});}
  await expect(select(f)).rejects.toThrow(); expect(await readHarvesterSource(db,f.cmd.id)).toBeNull();
  expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet,f.wallet))).toEqual([]);
 });
 it('requires genuine injected reader boundary; missing, stale, future and partial observations refuse',async()=>{
  const f=await fixture(); await expect(selectHarvesterSource(db,f.wallet,f.cmd,f.authority,{clock:()=>f.now})).rejects.toThrow('unavailable');
  const observed=await f.reader.readOperatingTerm();
  for(const bad of [{...observed,finality:{...observed.finality,observedAt:new Date(f.now.getTime()-A.observationMaxAgeMs-1).toISOString()}},
   {...observed,finality:{...observed.finality,observedAt:new Date(f.now.getTime()+1).toISOString()}},
   {...observed,snapshot:{...observed.snapshot,spots:observed.snapshot.spots.slice(1)}}]){
    await expect(selectHarvesterSource(db,f.wallet,f.cmd,f.authority,{reader:{async readOperatingTerm(){return bad;}},clock:()=>f.now})).rejects.toThrow();
  }
  expect(await readHarvesterSource(db,f.cmd.id)).toBeNull();
 });
 it('prefetches before locks and refuses an observation that ages while waiting for a base lock',async()=>{
  const f=await fixture(); let release!:()=>void, held=false, holderPid=0, at=f.now;
  const gate=new Promise<void>(r=>{release=r;});
  const holder=db.transaction(async tx=>{await tx.select().from(bases).where(eq(bases.id,f.baseId)).for('update');const [pid]=await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{pid:number}>;holderPid=pid!.pid;held=true;await gate;});
  let started=false;const reader={async readOperatingTerm(){started=true;return f.reader.readOperatingTerm();}};
  let work:Promise<unknown>|undefined;
  try{await expect.poll(()=>held).toBe(true);work=selectHarvesterSource(db,f.wallet,f.cmd,f.authority,{reader,clock:()=>at}).then(v=>({v}),e=>({e}));
   await expect.poll(()=>started).toBe(true);await expect.poll(async()=>(await conn.sql<{waiting:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting).toBe(true);at=new Date(f.now.getTime()+A.observationMaxAgeMs+1);release();
   expect(await work).toMatchObject({e:expect.objectContaining({message:expect.stringContaining('stale')})});
  }finally{release();await Promise.allSettled([holder,...(work?[work]:[])]);}
  expect(await readHarvesterSource(db,f.cmd.id)).toBeNull();
 });
 it('serializes parallel same-wallet selections through closure to one producing source',async()=>{
  const a=await fixture();await db.update(baseSlots).set({slot:2}).where(eq(baseSlots.baseId,a.baseId));const b=await fixture(a.wallet);
  const results=await Promise.allSettled([select(a),select(b)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(0);expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet,a.wallet))).toHaveLength(1);
 });
 it('parallel identical commands preserve one source and mismatched reuse never changes it',async()=>{
  const f=await fixture();const p=await Promise.all([select(f),select(f)]);expect(p[0]).toEqual(p[1]);
  await expect(select(f,{...f.cmd,policyVersion:f.cmd.policyVersion+1})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
 });
 it('caps lease at original term end and refuses new admission at the exclusive boundary',async()=>{
  const f=await fixture();f.now=new Date(Date.parse(f.snapshot.endsAt)-1);const p=await select(f);expect(p.leaseExpiresAt.toISOString()).toBe(f.snapshot.endsAt);
  const other=await fixture();other.now=new Date(other.snapshot.endsAt);await expect(select(other)).rejects.toThrow('not current');
 });
 it('rolls source, head and pinned term back with outer failure',async()=>{
  const f=await fixture();await expect(db.transaction(async tx=>{await selectHarvesterSource(tx,f.wallet,f.cmd,f.authority,{reader:f.reader,clock:()=>f.now});throw new Error('rollback');})).rejects.toThrow('rollback');
  expect(await readHarvesterSource(db,f.cmd.id)).toBeNull();expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet,f.wallet))).toEqual([]);
 });
 it('SQL refuses source/head mutation, deletion, missing head and forged original time/resource',async()=>{
  const f=await fixture(),p=await select(f);
  await expect(db.update(harvesterSources).set({leaseExpiresAt:new Date(p.leaseExpiresAt.getTime()+1)}).where(eq(harvesterSources.id,p.id))).rejects.toThrow();
  await expect(db.delete(harvesterSourceHeads).where(eq(harvesterSourceHeads.wallet,f.wallet))).rejects.toThrow();
  await expect(db.delete(harvesterSources).where(eq(harvesterSources.id,p.id))).rejects.toThrow();
  for(const patch of [{resourceId:'frost_quartz'},{leaseExpiresAt:new Date(p.leaseExpiresAt.getTime()+1)}]){
   const id=randomUUID();
   await expect(db.insert(harvesterSources).values({...p,...patch,id,intervalSnapshot:{...p.intervalSnapshot,sourceId:id}})).rejects.toThrow();
  }
  const id=randomUUID();await expect(db.insert(harvesterSources).values({...p,id,intervalSnapshot:{...p.intervalSnapshot,sourceId:id}})).rejects.toThrow('Failed query');
  expect(await readHarvesterSource(db,p.id)).toEqual(p);
 });
});
