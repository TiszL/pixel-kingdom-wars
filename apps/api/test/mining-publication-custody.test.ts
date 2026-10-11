/** Actual paid Workshop stock, SQL fencing and ambiguous publication recovery. */
import { randomUUID,createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FORGE_INGOT } from '@shardkeep/shared';
import { PublicKey,SystemProgram,TransactionMessage } from '@solana/web3.js';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { baseSlots,bases,buildings } from '../src/db/schema';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { startRefine,collectRefine,getWorkshopView } from '../src/game/workshop';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { reservePendingMiningIngots,abortPendingMiningEpoch } from '../src/game/miningIngotReservations';
import { beginMiningPublicationAttempt,getMiningPublicationAttempt } from '../src/mining/publicationCustody';
import { connectTestDb,createTestPlayer } from './helpers';
import { captureLatestBoundary,restoreLatestBoundary } from './fixtures/latestBoundary';
const conn=connectTestDb(),db=conn.db,at=new Date('2035-01-01T00:00:00Z');
beforeAll(()=>{vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');vi.stubEnv('FORGE_INGOTS_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');});
afterAll(async()=>{vi.unstubAllEnvs();await conn.sql.end();});
const context=(baseId:string)=>({baseId,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],wallet:string,id:string)=>{await assertFreshLockedBaseAuthority(tx,wallet,id,at);}});
const intent=()=>new TransactionMessage({payerKey:new PublicKey(Buffer.alloc(32,6)),recentBlockhash:new PublicKey(Buffer.alloc(32,7)).toBase58(),instructions:[SystemProgram.transfer({fromPubkey:new PublicKey(Buffer.alloc(32,6)),toPubkey:new PublicKey(Buffer.alloc(32,8)),lamports:0})]}).compileToV0Message().serialize();
async function fixture(){
 const {wallet}=await createTestPlayer(db),[base]=await db.insert(bases).values({ownerWallet:wallet}).returning(),baseId=base!.id;
 await db.insert(baseSlots).values({wallet,baseId,slot:1});await db.insert(buildings).values({playerWallet:wallet,baseId,type:'workshop',level:1,tx:20,ty:20});
 await rewardBaseShards(db,baseId,BigInt(FORGE_INGOT.shardsPerIngot)*100n,'test.publication.ingot',randomUUID());
 const job=await startRefine(db,wallet,baseId,3,FORGE_INGOT.recipeVersion,randomUUID(),at,context(baseId)),ready=new Date(job.readyAt);
 await collectRefine(db,wallet,baseId,job.jobId,randomUUID(),ready,context(baseId));
 const body={epochKey:randomUUID(),baseId,ingots:2,idempotencyKey:randomUUID()},reservation=await reservePendingMiningIngots(db,wallet,body,context(baseId),ready);
 const request={epochId:reservation.epochId,attemptKey:randomUUID(),intentBytes:intent()};
 return {wallet,baseId,body,reservation,request,ready,begin:()=>beginMiningPublicationAttempt(db,request)};
}
const stock=async(baseId:string)=>(await conn.sql`select qty from base_items where base_id=${baseId} and item_id='forge_ingot'`)[0]!.qty;
describe('publication attempt ingot fence',()=>{
 it('durably freezes the actual paid reservation set without consuming or inventing publication authority',async()=>{
  const f=await fixture(),receipt=await f.begin();expect(receipt).toMatchObject({epochId:f.reservation.epochId,attemptKey:f.request.attemptKey,reservationCount:1,reservedIngots:'2',publicationFinalized:false,consumptionAuthorized:false});
  expect(receipt.intentSha256).toBe(createHash('sha256').update(f.request.intentBytes).digest('hex'));
  expect(receipt.reservations).toEqual([{reservationId:f.reservation.id,baseId:f.baseId,actorWallet:f.wallet,ingots:2}]);
  expect(await stock(f.baseId)).toBe(1);expect((await getWorkshopView(db,f.wallet,f.baseId,f.ready)).holding.reserved).toBe(2);
  expect(await getMiningPublicationAttempt(db,f.reservation.epochId)).toEqual(receipt);expect(await f.begin()).toEqual(receipt);
 });
 it('captures every original actor and only this epoch, never a caller-supplied stock set',async()=>{
  const first=await fixture(),second=await fixture();
  const extra=await reservePendingMiningIngots(db,second.wallet,{...second.body,epochKey:first.body.epochKey,ingots:1,idempotencyKey:randomUUID()},context(second.baseId),second.ready);
  const receipt=await first.begin();expect(receipt.reservationCount).toBe(2);expect(receipt.reservedIngots).toBe('3');
  expect(receipt.reservations).toEqual([
   {reservationId:first.reservation.id,baseId:first.baseId,actorWallet:first.wallet,ingots:2},
   {reservationId:extra.id,baseId:second.baseId,actorWallet:second.wallet,ingots:1},
  ].sort((a,b)=>a.baseId.localeCompare(b.baseId)||a.reservationId.localeCompare(b.reservationId)));
  expect(receipt.reservations.some(r=>r.reservationId===second.reservation.id)).toBe(false);
  expect(await stock(first.baseId)).toBe(1);expect(await stock(second.baseId)).toBe(0);
  await expect(beginMiningPublicationAttempt(db,{...second.request,reservations:receipt.reservations} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(await first.begin()).toEqual(receipt);
 });
 it('refuses an empty epoch and cross-epoch reuse of a durable attempt key',async()=>{
  const first=await fixture(),second=await fixture();await first.begin();
  await expect(beginMiningPublicationAttempt(db,{...second.request,attemptKey:first.request.attemptKey})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
  expect(await getMiningPublicationAttempt(db,second.request.epochId)).toBeNull();
  const epochId=randomUUID();await conn.sql`insert into mining_ingot_epochs(id,epoch_key,created_at) values(${epochId},${randomUUID()},${at.toISOString()})`;
  await expect(beginMiningPublicationAttempt(db,{...second.request,epochId})).rejects.toMatchObject({code:'EMPTY'});
  expect(await getMiningPublicationAttempt(db,epochId)).toBeNull();
 });
 it('retains ambiguous attempts and permits exact recovery while paused, never abort or new reservations',async()=>{
  const f=await fixture(),receipt=await f.begin();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  try{expect(await f.begin()).toEqual(receipt);expect(await getMiningPublicationAttempt(db,f.request.epochId)).toEqual(receipt);
   await expect(abortPendingMiningEpoch(db,{epochId:f.request.epochId,decisionKey:randomUUID(),reason:'unknown-outcome'},f.ready)).rejects.toMatchObject({cause:{message:'MINING_PUBLICATION_FENCED'}});
  }finally{vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
  await expect(reservePendingMiningIngots(db,f.wallet,{...f.body,ingots:1,idempotencyKey:randomUUID()},context(f.baseId),f.ready)).rejects.toMatchObject({cause:{message:'MINING_PUBLICATION_FENCED'}});
  expect(await stock(f.baseId)).toBe(1);expect((await getWorkshopView(db,f.wallet,f.baseId,f.ready)).holding.reserved).toBe(2);
  const changed={...f.request,intentBytes:Uint8Array.from(f.request.intentBytes)};changed.intentBytes[1]=changed.intentBytes[1]!^1;
  await expect(beginMiningPublicationAttempt(db,{...f.request,attemptKey:randomUUID()})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
  await expect(beginMiningPublicationAttempt(db,changed)).rejects.toThrow();
 });
 it('admits no new attempt while paused or after a completed full-epoch abort',async()=>{
  const paused=await fixture();vi.stubEnv('PHASE_E_MINING_ENABLED','false');try{await expect(paused.begin()).rejects.toMatchObject({code:'DISABLED'});}finally{vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
  expect(await getMiningPublicationAttempt(db,paused.request.epochId)).toBeNull();
  const f=await fixture();await abortPendingMiningEpoch(db,{epochId:f.request.epochId,decisionKey:randomUUID(),reason:'before-publication'},f.ready);
  await expect(f.begin()).rejects.toMatchObject({code:'ABORTED'});expect(await stock(f.baseId)).toBe(3);
 });
 it('serializes concurrent preparation and refuses an epoch held by an abort or reservation transaction',async()=>{
  const f=await fixture(),attempts=await Promise.allSettled([f.begin(),f.begin()]);expect(attempts.some(a=>a.status==='fulfilled')).toBe(true);
  const receipt=await f.begin();for(const a of attempts)if(a.status==='fulfilled')expect(a.value).toEqual(receipt);
  const blocked=await fixture();await conn.sql.begin(async tx=>{await tx`select id from mining_ingot_epochs where id=${blocked.request.epochId} for update`;await expect(blocked.begin()).rejects.toMatchObject({code:'BUSY'});});
 });
 it('keeps fence and stock atomic when its enclosing transaction rolls back',async()=>{
  const f=await fixture();await expect(conn.sql.begin(async tx=>{await tx`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes) values(${f.request.epochId},${f.request.attemptKey},${Buffer.from(f.request.intentBytes)})`;throw Error('injected rollback');})).rejects.toThrow('injected rollback');
  expect(await getMiningPublicationAttempt(db,f.request.epochId)).toBeNull();await abortPendingMiningEpoch(db,{epochId:f.request.epochId,decisionKey:randomUUID(),reason:'after-rollback'},f.ready);expect(await stock(f.baseId)).toBe(3);
 });
 it('refuses immutable rewrites, direct derived source forgery and stale repeatable-read bypass',async()=>{
  const f=await fixture();await expect(conn.sql`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes,reservations) values(${f.request.epochId},${f.request.attemptKey},${Buffer.from(f.request.intentBytes)},'[]'::jsonb)`).rejects.toThrow('MINING_PUBLICATION_DERIVED_FIELDS');
  await expect(conn.sql.begin(async tx=>{await tx`set transaction isolation level repeatable read`;await tx`select count(*) from mining_publication_attempts`;await f.begin();
   await tx`insert into mining_ingot_aborts(epoch_id,decision_key,reason,created_at) values(${f.request.epochId},${randomUUID()},'stale-snapshot',${f.ready.toISOString()})`;})).rejects.toThrow('MINING_PUBLICATION_READ_COMMITTED_REQUIRED');
  await expect(conn.sql`update mining_publication_attempts set intent_sha256=repeat('0',64) where epoch_id=${f.request.epochId}`).rejects.toThrow('MINING_PUBLICATION_IMMUTABLE');
  await expect(conn.sql`delete from mining_publication_attempts where epoch_id=${f.request.epochId}`).rejects.toThrow('MINING_PUBLICATION_IMMUTABLE');
  const retained=await getMiningPublicationAttempt(db,f.request.epochId);expect(retained).not.toBeNull();
  // Include later dependent receipts to exercise retention beyond the FK restriction.
  await expect(conn.sql`truncate mining_publication_attempts cascade`).rejects.toThrow('MINING_PUBLICATION_IMMUTABLE');
  expect(await getMiningPublicationAttempt(db,f.request.epochId)).toEqual(retained);
 });
 it('refuses broad-grant runtime forging and forged TEMP trigger sources',async()=>{
  const f=await fixture(),role=`mining_publication_${randomUUID().replaceAll('-','')}`;
  await conn.sql.unsafe(`create role ${role}`);
  try{await conn.sql.unsafe(`grant usage on schema public to ${role}`);await conn.sql.unsafe(`grant all on all tables in schema public to ${role}`);
   await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes) values(${f.request.epochId},${f.request.attemptKey},${Buffer.from(f.request.intentBytes)})`;})).rejects.toThrow('MINING_PUBLICATION_OWNER_REQUIRED');
   await expect(conn.sql.begin(async tx=>{await tx`create temporary table forged_publication (like public.mining_publication_attempts including defaults)`;await tx`create trigger fake before insert on forged_publication for each row execute function public.shardkeep_mining_publication_attempt_guard()`;
    await tx`insert into forged_publication(epoch_id,attempt_key,intent_bytes) values(${f.request.epochId},${f.request.attemptKey},${Buffer.from(f.request.intentBytes)})`;})).rejects.toThrow('MINING_PUBLICATION_TRIGGER_IDENTITY');
  }finally{await conn.sql.unsafe(`drop owned by ${role}`);await conn.sql.unsafe(`drop role ${role}`);}
 });
 it('preserves the exact receipt through actual migration retries and rejects malformed unsigned messages',async()=>{
  const f=await fixture(),receipt=await f.begin(),migration=readFileSync(new URL('../drizzle/0168_mining_publication_custody.sql',import.meta.url),'utf8');
  // 2026-10-10 (CI run 38043546234, API shard 16): 0168 is no longer the newest body of
  // shardkeep_mining_publication_attempt_guard (0254 and 0268 replaced it), and the record 0279 sealed in
  // divine_fragment_bound_cosmetics_contract pins that body. This replay used to leave the 0168 body installed
  // in the SHARED test database, so every later file whose raids or returns check the Phase E seals failed with
  // RAID_ADVANCED_SOURCE or ADVANCED_RETURN_SOURCE_CHANGED (starter-service-presentation,
  // live-raid-cancellation-race, starter-expedition-base-read). The retries and their assertions are unchanged; afterwards this case puts
  // back the exact catalog it found (fixtures/latestBoundary.ts) and the newest whole-system seal must accept
  // it. Downgraded code is never resealed.
  const boundary=await captureLatestBoundary(conn.sql);
  try{
   for(let n=0;n<2;n++)await conn.sql.begin(async tx=>{for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(statement);});
   expect(await f.begin()).toEqual(receipt);expect(await stock(f.baseId)).toBe(1);
   const other=await fixture();for(const bytes of [new Uint8Array(),new Uint8Array(1233),Uint8Array.of(255),Uint8Array.from([...other.request.intentBytes,0])])await expect(beginMiningPublicationAttempt(db,{...other.request,intentBytes:bytes})).rejects.toMatchObject({code:'INVALID_INPUT'});
  }finally{await restoreLatestBoundary(conn.sql,boundary);}
  expect(await captureLatestBoundary(conn.sql)).toEqual(boundary);await conn.sql`select public.shardkeep_divine_fragment_source()`;
 });
});
