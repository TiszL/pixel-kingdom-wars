import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
import {withDivineTrialFixture} from './fixtures/divineTrials';

it('funding retries cannot change sponsor stock or budget and an insufficient new event rolls back every item',async()=>withDivineTrialFixture(async f=>{
 const before=await f.sql`select * from crafting_stocks order by base_id,item_id`,cmd={id:f.event.id,baseId:f.baseId,weekStart:f.event.entryStartsAt,budget:f.budget};
 expect(await f.client.fund(f.wallet,cmd)).toEqual(f.event);await expect(f.client.fund(f.buyer,cmd)).rejects.toMatchObject({statusCode:403});
 await expect(f.client.fund(f.wallet,{...cmd,budget:{...f.budget,crownsteel:'8'}})).rejects.toMatchObject({code:'DIVINE_TRIAL_IDEMPOTENCY_BODY_MISMATCH'});
 const id=randomUUID();await expect(f.client.fund(f.wallet,{...cmd,id,weekStart:'2020-01-11T00:00:00.000Z',budget:{...f.budget,thornsilk:'100'}})).rejects.toThrow();
 expect(await f.sql`select * from divine_trial_events where id=${id}`).toHaveLength(0);expect(await f.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(before);
}),120000);

it('concurrent prize claims credit once and original paid-wallet claims remain readable after authority disappears',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);await f.enter(f.buyer,f.buyerBaseId);f.setTime(f.event.playStartsAt);const a=await f.admit(f.buyer,f.buyerBaseId);await f.client.submit(f.buyer,a.id,{orders:f.orders()});f.setTime(f.event.playEndsAt);await f.client.close(f.event.id);
 const both=await Promise.allSettled([f.client.claim(f.buyer,f.event.id,{baseId:f.buyerBaseId}),f.client.claim(f.buyer,f.event.id,{baseId:f.buyerBaseId})]);expect(both.some(r=>r.status==='fulfilled')).toBe(true);
 const original=await f.client.claim(f.buyer,f.event.id,{baseId:f.buyerBaseId});expect(Object.values(original.amounts)).toEqual(Array(8).fill('7'));
 expect(await f.sql`select * from divine_trial_prize_claims where event_id=${f.event.id} and wallet=${f.buyer}`).toHaveLength(1);
 const stocks=await f.sql`select * from crafting_stocks where base_id=${f.buyerBaseId} order by item_id`;f.setOnline(false);f.setDeedOnline(false);process.env.PHASE_E_BUILDINGS_ENABLED='false';
 await f.sql.begin(async tx=>{await tx`update bases set status='inactive' where id=${f.buyerBaseId}`;await tx`update base_slots set active=false where base_id=${f.buyerBaseId}`;});
 expect(await f.service().claim(f.buyer,f.event.id,{baseId:f.buyerBaseId})).toEqual(original);expect(await f.sql`select * from crafting_stocks where base_id=${f.buyerBaseId} order by item_id`).toEqual(stocks);
}),120000);

it('stock witnesses refuse deletion, rebinding and truncation even after immediate constraint flushing',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.playEndsAt);await f.client.close(f.event.id);const before=await f.sql`select * from crafting_stocks order by base_id,item_id`;
 for(const kind of ['delete','rebind','truncate']){
  await expect(f.sql.begin(async tx=>{
   await tx`insert into divine_trial_prize_claims(event_id,wallet,base_id,amounts,stock,claimed_at,tx_key) values(${f.event.id},${f.wallet},${f.baseId},'{}','[]',${f.clock().toISOString()}::timestamptz,pg_current_xact_id()::text)`;
   await tx`set constraints all immediate`;
   if(kind==='delete')await tx`delete from crafting_stocks where base_id=${f.baseId} and item_id='thornsilk'`;
   else if(kind==='rebind')await tx`update crafting_stocks set item_id='changed' where base_id=${f.baseId} and item_id='thornsilk'`;
   else await tx`truncate crafting_stocks`;
  })).rejects.toThrow('DIVINE_TRIAL_STOCK_CONSERVATION');
 }
 expect(await f.sql`select * from divine_trial_prize_claims`).toHaveLength(0);expect(await f.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(before);
}),120000);

it('immutable originals, schema attestation and exact migration replay cannot be used to replace admission or bless weakened hooks',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);const entry=await f.enter();f.setTime(f.event.playStartsAt);const a=await f.admit();
 await expect(f.sql`update divine_trial_entries set source_sha256=repeat('0',64) where id=${entry.id}`).rejects.toThrow('DIVINE_TRIAL_IMMUTABLE');
 await expect(f.sql`delete from divine_trial_attempts where id=${a.id}`).rejects.toThrow('DIVINE_TRIAL_IMMUTABLE');
 await expect(f.sql`insert into divine_trial_outcomes(attempt_id,status,result,completed_at) values(${a.id},'completed','{"stars":3,"destruction":100,"events":[],"inputSha256":"fake"}',${f.clock().toISOString()}::timestamptz)`).rejects.toThrow('DIVINE_TRIAL_RESULT');
 const migration=await readFile(new URL('../drizzle/0237_divine_trials.sql',import.meta.url),'utf8');
 await expect(f.sql.begin(async tx=>{await tx`alter table divine_trial_commands disable trigger divine_trial_commands_guard`;await tx.unsafe(migration);})).rejects.toThrow('DIVINE_TRIAL_SOURCE');
 await expect(f.sql.begin(async tx=>{await tx`alter table divine_trial_attempts alter column record drop not null`;await tx.unsafe(migration);})).rejects.toThrow('DIVINE_TRIAL_SOURCE');
 await f.sql.begin(async tx=>{await tx.unsafe(migration);});expect((await f.client.participant(f.wallet,f.event.id)).entry).toEqual(entry);expect(await f.client.read(f.wallet,a.id)).toEqual(a);
}),120000);

it('unprivileged runtime SQL cannot write private admissions and ordinary later stock remains usable',async()=>withDivineTrialFixture(async f=>{
 const role='divine_trial_'+randomUUID().replaceAll('-','');await f.sql.unsafe(`create role ${role} noinherit`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role}`);
  await expect(f.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into divine_trial_event_terminals(event_id,record,completed_at,tx_key) values(${f.event.id},'{}',now(),'fake')`;})).rejects.toThrow('permission denied');
  await f.sql`update crafting_stocks set available=available+1 where base_id=${f.baseId}`;
  f.setTime(f.event.playEndsAt);await f.client.close(f.event.id);await f.client.claim(f.wallet,f.event.id,{baseId:f.baseId});
  await f.sql`update crafting_stocks set available=available-1 where base_id=${f.baseId}`;
  expect((await f.sql`select available from crafting_stocks where base_id=${f.baseId}`).every(r=>BigInt(r.available)===11n)).toBe(true);
 }finally{await f.sql.unsafe(`drop owned by ${role}`);await f.sql.unsafe(`drop role ${role}`);}
}),120000);
