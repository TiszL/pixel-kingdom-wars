import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {claimRaidSimulationPermit} from '../src/game/raidSimulationRunner';
import {withDivineTrialFixture} from './fixtures/divineTrials';

it('concurrent admissions consume one ordinal; explicit abandonment never replenishes the three tries',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);await f.enter();f.setTime(f.event.playStartsAt);
 const both=await Promise.allSettled([f.admit(),f.admit()]);expect(both.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 let attempt=(await f.client.participant(f.wallet,f.event.id)).attempts[0]!;expect(attempt.ordinal).toBe(1);
 await expect(f.client.read(f.buyer,attempt.id)).rejects.toMatchObject({statusCode:404});
 for(let i=1;i<=P.attemptsPerWallet;i++){expect(attempt.ordinal).toBe(i);const ended=await f.client.abandon(f.wallet,attempt.id);expect(ended.status).toBe('abandoned');expect(await f.client.abandon(f.wallet,attempt.id)).toEqual(ended);if(i<P.attemptsPerWallet)attempt=await f.admit();}
 await expect(f.admit()).rejects.toMatchObject({code:'DIVINE_TRIAL_ATTEMPT_LIMIT'});
 f.setTime(f.event.playEndsAt);const closed=await f.client.close(f.event.id);expect(closed.terminal?.occupations).toEqual([]);expect(closed.terminal?.entitlements).toEqual([{wallet:f.wallet,amounts:f.budget}]);
}),120000);

it('a committed command survives CPU unavailability, deadline and pause and prevents replacement or fabricated closing',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);await f.enter();f.setTime(f.event.playStartsAt);const a=await f.admit(),permit=claimRaidSimulationPermit();
 try{
  await expect(f.client.submit(f.wallet,a.id,{orders:f.orders()})).rejects.toThrow('busy');expect((await f.client.read(f.wallet,a.id)).status).toBe('committed');
  await expect(f.client.submit(f.wallet,a.id,{orders:f.orders('north')})).rejects.toMatchObject({code:'DIVINE_TRIAL_IDEMPOTENCY_BODY_MISMATCH'});
  await expect(f.client.abandon(f.wallet,a.id)).rejects.toMatchObject({code:'DIVINE_TRIAL_COMMAND_COMMITTED'});await expect(f.admit()).rejects.toMatchObject({code:'DIVINE_TRIAL_UNFINISHED'});
  f.setTime(f.event.playEndsAt);process.env.PHASE_E_CATALOG_ENABLED='false';f.setOnline(false);await expect(f.client.close(f.event.id)).rejects.toThrow('busy');expect(await f.sql`select * from divine_trial_event_terminals`).toHaveLength(0);
 }finally{await permit.release();}
 const restart=f.service(),closed=await restart.close(f.event.id);expect(closed.terminal?.rankings[0]).toMatchObject({wallet:f.wallet,attemptId:a.id,stars:3});
 expect((await restart.submit(f.wallet,a.id,{orders:f.orders()})).status).toBe('completed');expect(await restart.close(f.event.id)).toEqual(closed);
}),120000);

it('racing different commands freeze one batch; invalid geometry and extra army never become durable combat input',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);await f.enter();f.setTime(f.event.playStartsAt);const a=await f.admit();
 const illegal=f.orders();illegal.deploys[0]!.tx=Number.MAX_SAFE_INTEGER;await expect(f.client.submit(f.wallet,a.id,{orders:illegal})).rejects.toThrow();
 const extra=f.orders();extra.deploys.push(extra.deploys[0]!);await expect(f.client.submit(f.wallet,a.id,{orders:extra})).rejects.toThrow();expect((await f.client.read(f.wallet,a.id)).status).toBe('admitted');
 const attempts=await Promise.allSettled([f.client.submit(f.wallet,a.id,{orders:f.orders('north')}),f.client.submit(f.wallet,a.id,{orders:f.orders('south')})]);expect(attempts.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const original=await f.client.read(f.wallet,a.id);expect(original.status).toBe('completed');expect(await f.sql`select * from divine_trial_commands where attempt_id=${a.id}`).toHaveLength(1);expect(await f.sql`select * from divine_trial_outcomes where attempt_id=${a.id}`).toHaveLength(1);
 await expect(f.client.admit(f.wallet,f.event.id,{baseId:randomUUID(),idempotencyKey:a.idempotencyKey})).rejects.toMatchObject({code:'DIVINE_TRIAL_IDEMPOTENCY_BODY_MISMATCH'});
}),120000);

it('deadline expires an empty attempt without score and a new identity cannot revive it',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);await f.enter();f.setTime(f.event.playStartsAt);const a=await f.admit();f.setTime(f.event.playEndsAt);
 await expect(f.client.submit(f.wallet,a.id,{orders:f.orders()})).rejects.toMatchObject({code:'DIVINE_TRIAL_WINDOW'});
 const closed=await f.client.close(f.event.id);expect(closed.terminal?.rankings).toEqual([]);expect((await f.client.read(f.wallet,a.id)).status).toBe('expired');await expect(f.admit()).rejects.toMatchObject({code:'DIVINE_TRIAL_WINDOW'});
}),120000);
