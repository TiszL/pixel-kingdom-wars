import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {withDivineFragmentFixture,type DivineFragmentFixture} from './fixtures/divineFragments';
import {Keypair} from '@solana/web3.js';
import {createDivineTrials} from '../src/game/divineTrials';
import {createDivineFragments} from '../src/game/divineFragments';
import {DIVINE_FRAGMENT_POLICY,divineFragmentWeekAt} from '@shardkeep/shared/divineFragments';

async function ready(f:DivineFragmentFixture){await f.fragments.enroll(f.event.id);await f.play();return f.settle();}
it('future-only enrollment refuses retrospective event histories and global period aliases',async()=>withDivineFragmentFixture(async f=>{
 const week=divineFragmentWeekAt(f.event.playEndsAt);await f.fragments.enroll(f.event.id);
 const otherDomain={...f.domain,genesisHash:Keypair.generate().publicKey.toBase58()},otherTrials=createDivineTrials(f.db,{...f.options,domain:otherDomain,qualificationSource:{...f.options.qualificationSource,trust:{...f.options.qualificationSource.trust,expectedGenesisHash:otherDomain.genesisHash}}}),otherFragments=createDivineFragments(f.db,{...f.options,domain:otherDomain});
 const second=await otherTrials.fund(f.wallet,{id:randomUUID(),baseId:f.baseId,weekStart:f.event.entryStartsAt,budget:Object.fromEntries(Object.keys(f.budget).map(k=>[k,'1']))});
 await expect(otherFragments.enroll(second.id)).rejects.toThrow();expect(await f.sql`select * from divine_fragment_enrollments`).toHaveLength(1);
 await expect(f.sql`insert into divine_fragment_periods(week_start,economic_lineage,policy) values(${week},'alias',${JSON.stringify(DIVINE_FRAGMENT_POLICY)}::jsonb) on conflict do nothing`).rejects.toThrow('DIVINE_FRAGMENT_POLICY');
 await expect(f.sql`insert into divine_fragment_periods(week_start,economic_lineage,policy) values(${week},'shardkeep',${JSON.stringify({...DIVINE_FRAGMENT_POLICY,version:2})}::jsonb) on conflict do nothing`).rejects.toThrow('DIVINE_FRAGMENT_POLICY');
 f.setTime(f.event.entryStartsAt);await f.enter();
 await expect(f.sql`insert into divine_fragment_enrollments(event_id,week_start,domain,earned_at,enrolled_at) values(${f.event.id},${week},${JSON.stringify(f.domain)}::jsonb,${f.event.playEndsAt},'2019-01-01')`).rejects.toThrow('DIVINE_FRAGMENT_ENROLLMENT');
 const missing=createDivineFragments(f.db,{...f.options,termSource:null});await expect(missing.settle(second.id)).rejects.toMatchObject({code:'DIVINE_FRAGMENT_DISABLED'});
}),120000);

it('raw SQL cannot change or mint protected source, carry, delivery or stock, even after constraints are flushed',async()=>withDivineFragmentFixture(async f=>{
 const settled=await ready(f),cmd={idempotencyKey:randomUUID(),baseId:f.baseId};await f.fragments.deliver(f.wallet,f.event.id,cmd);
 for(const query of [
  "update crystal_fragment_stocks set available=available+1", "update crystal_fragment_stocks set available=available-1", "delete from crystal_fragment_stocks", "truncate crystal_fragment_stocks",
  "update divine_fragment_awards set record=jsonb_set(record,'{carryAfter}','\"0\"')", "delete from divine_fragment_awards", "truncate divine_fragment_awards",
  "update divine_fragment_settlements set source_hash=repeat('0',64)", "delete from divine_fragment_deliveries", "truncate divine_fragment_deliveries",
  "update divine_fragment_enrollments set earned_at=earned_at+interval '1 day'", "update divine_fragment_contract set record='{}'"
 ])await expect(f.sql.begin(async tx=>{await tx`set constraints all immediate`;await tx.unsafe(query);})).rejects.toThrow();
 await expect(f.sql`insert into divine_fragment_awards(event_id,wallet,site,record) values(${f.event.id},${f.wallet},'divine-individual-500',${JSON.stringify({...settled.awards[0],site:'divine-individual-500'})}::jsonb)`).rejects.toThrow('DIVINE_FRAGMENT_AWARD');
 expect((await f.fragments.stock(f.wallet,f.baseId)).available).toBe('12');
 await f.sql`insert into divine_fragment_deliveries(id,event_id,wallet,base_id,quantity,record,delivered_at) values(${cmd.idempotencyKey},${f.event.id},${f.wallet},${f.baseId},null,'{}',${f.clock().toISOString()}::timestamptz) on conflict do nothing`;expect(await f.sql`select * from divine_fragment_deliveries`).toHaveLength(1);expect((await f.fragments.stock(f.wallet,f.baseId)).available).toBe('12');
}),120000);

it('source attestation rejects disabled hooks and non-RC sessions; prospective extension rejects old guard rollback',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);const migration=await readFile(new URL('../drizzle/0246_divine_fragments.sql',import.meta.url),'utf8');
 await expect(f.sql.begin(async tx=>{await tx`alter table crystal_fragment_stocks disable trigger crystal_fragment_stocks_guard`;await tx.unsafe(migration);})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 await expect(f.sql.begin(async tx=>{await tx`alter table divine_fragment_awards alter column record drop not null`;await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 for(const isolation of ['repeatable read','serializable'])await expect(f.sql.begin(async tx=>{await tx.unsafe(`set transaction isolation level ${isolation}`);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_OWNER_ISOLATION');
 // D193 preserves migration0246 but its old functions cannot replace the extended sealed accounting.
 await expect(f.sql.begin(async tx=>{await tx.unsafe(migration);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');expect((await f.fragments.award(f.wallet,f.event.id)).enrolled).toBe(true);
 const role='fragment_'+randomUUID().replaceAll('-','');await f.sql.unsafe(`create role ${role} noinherit`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role}`);
  await expect(f.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into crystal_fragment_stocks(base_id,available) values(${f.baseId},1)`;})).rejects.toThrow('permission denied');
  await expect(f.sql.begin(async tx=>{await tx.unsafe(`grant select,insert on divine_fragment_periods to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`insert into divine_fragment_periods(week_start,economic_lineage,policy) values('2020-01-02','shardkeep',${JSON.stringify(DIVINE_FRAGMENT_POLICY)}::jsonb)`;})).rejects.toThrow();
 }finally{await f.sql.unsafe(`drop owned by ${role}`);await f.sql.unsafe(`drop role ${role}`);}
}),120000);

it('raw SQL rejects nullable or altered certificates before ON CONFLICT can mask a bad source and rolls back real insert effects',async()=>withDivineFragmentFixture(async f=>{
 await ready(f);const [saved]=await f.sql`select * from divine_fragment_settlements where event_id=${f.event.id}`;expect(saved).toBeTruthy();
 for(const mutation of ['completedAt','completedSlot','observedAt','deployedSlot','authority','future','hash','source']){
  const cert=JSON.parse(saved!.certificate_json);if(mutation==='observedAt')delete cert.finality.observedAt;else if(mutation==='deployedSlot')delete cert.deployment.deployedSlot;else if(mutation==='authority')cert.operatingAdmissionAuthorized=true;else if(mutation==='future')cert.completedAt='2099-01-01T00:00:00.000Z';else if(mutation==='completedAt'||mutation==='completedSlot')delete cert[mutation];
  const json=JSON.stringify(cert),hash=createHash('sha256').update('shardkeep:historical-shards-term-certificate:v1\n'+json).digest('hex');
  await expect(f.sql`insert into divine_fragment_settlements(event_id,term_id,term_hash,certificate_json,certificate_hash,source_hash,record,settled_at) values(${f.event.id},${saved!.term_id},${saved!.term_hash},${json},${mutation==='hash'?'0'.repeat(64):hash},${mutation==='source'?'0'.repeat(64):saved!.source_hash},'{}',${f.clock().toISOString()}::timestamptz) on conflict do nothing`).rejects.toThrow();
 }
 await expect(f.sql.begin(async tx=>{await tx`insert into divine_fragment_deliveries(id,event_id,wallet,base_id,quantity,record,delivered_at) values(${randomUUID()},${f.event.id},${f.wallet},${f.baseId},null,'{}',${f.clock().toISOString()}::timestamptz)`;await tx`set constraints all immediate`;await tx`update crystal_fragment_stocks set available=available-1 where base_id=${f.baseId}`;})).rejects.toThrow('DIVINE_FRAGMENT_STOCK_CONSERVATION');
 expect(await f.sql`select * from divine_fragment_deliveries`).toHaveLength(0);expect(await f.sql`select * from crystal_fragment_stocks`).toHaveLength(0);
}),120000);

it('concurrent settlement, delivery and original spot claims conserve once; replay with another key cannot mint',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);await f.play();
 const sourceResults=await f.withSourceClock(()=>Promise.all([f.fragments.settle(f.event.id),f.fragments.settle(f.event.id)]));expect(sourceResults[0]).toEqual(sourceResults[1]);
 const cmd={idempotencyKey:randomUUID(),baseId:f.baseId};const deliveries=await Promise.all([f.fragments.deliver(f.wallet,f.event.id,cmd),f.fragments.deliver(f.wallet,f.event.id,cmd)]);expect(deliveries[0]).toEqual(deliveries[1]);
 const termId=sourceResults[0]!.term!.snapshot.termId,c={idempotencyKey:randomUUID(),baseId:f.baseId,termId,spotId:0};const claims=await Promise.all([f.seeker.claim(f.wallet,c),f.seeker.claim(f.wallet,c)]);expect(claims[0]).toEqual(claims[1]);
 await expect(f.seeker.claim(f.wallet,{...c,idempotencyKey:randomUUID()})).rejects.toThrow();await expect(f.seeker.claim(f.buyer,{...c,idempotencyKey:randomUUID(),baseId:f.buyerBaseId})).rejects.toMatchObject({code:'DIVINE_FRAGMENT_SPOT_OWNER'});
 await expect(f.fragments.deliver(f.wallet,f.event.id,{...cmd,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'DIVINE_FRAGMENT_IDEMPOTENCY_BODY_MISMATCH'});
 expect((await f.fragments.stock(f.wallet,f.baseId)).available).toBe('14');expect(await f.sql`select * from divine_fragment_settlements`).toHaveLength(1);expect(await f.sql`select * from seeker_fragment_claims`).toHaveLength(1);
}),120000);
