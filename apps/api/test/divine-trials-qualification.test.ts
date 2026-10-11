import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {createDivineTrialQualificationReader} from '../src/game/divineTrialQualification';
import {withDivineTrialFixture} from './fixtures/divineTrials';

it('fully claimed KEEP never bypasses pause, correction, current root or exact personally earned Renown',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);const read=()=>createDivineTrialQualificationReader(f.db,f.options.qualificationSource,f.clock)(f.wallet);
 expect((await read()).qualification.renown).toBe('1');
 for(const flags of [1,2,32]){await f.setConfig({flags});await expect(read()).rejects.toMatchObject({code:'DIVINE_TRIAL_QUALIFICATION'});}await f.setConfig({flags:0});
 await f.setConfig({correction_pending:true});await expect(read()).rejects.toThrow();await f.setConfig({correction_pending:false});
 f.bank.root.revoked=true;await f.bank.encodeRoot();await expect(read()).rejects.toThrow();f.bank.root.revoked=false;await f.bank.encodeRoot();
 const sequence=f.bank.backing.model.latest_sequence;await f.setConfig({latest_sequence:sequence+1n});await expect(read()).rejects.toThrow();await f.setConfig({latest_sequence:sequence});
 const renown=f.first.post.renown;renown.renown_total=0n;await f.first.post.records();await expect(read()).rejects.toThrow();renown.renown_total=1n;renown.last_sequence=0n;renown.synced_at=0n;await f.first.post.records();await expect(read()).rejects.toThrow();
 expect(await f.sql`select * from divine_trial_entries`).toHaveLength(0);
}),120000);

it('coalesced and slow reads retain their first observation time and reject stale or future finalized Clock',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);let release!:()=>void,started!:()=>void;const wait=new Promise<void>(r=>{release=r;}),seen=new Promise<void>(r=>{started=r;});
 f.beforeRead(async()=>{started();await wait;});const read=createDivineTrialQualificationReader(f.db,f.options.qualificationSource,f.clock),first=read(f.wallet);await seen;
 f.setTime(new Date(f.clock().getTime()+P.observationMaxAgeMs+1));const joined=read(f.wallet);expect(joined).toBe(first);release();await expect(first).rejects.toThrow();f.beforeRead(null);
 const at=f.clock().getTime();(f.bank.rows[7]!.data as Buffer).writeBigInt64LE(BigInt(Math.floor(at/1000)+1),32);await expect(read(f.wallet)).rejects.toThrow();
 (f.bank.rows[7]!.data as Buffer).writeBigInt64LE(BigInt(Math.floor((at-P.observationMaxAgeMs)/1000)-1),32);await expect(read(f.wallet)).rejects.toThrow();
}),120000);

it('final entry locks cannot turn queued old source into a fresh qualification',async()=>withDivineTrialFixture(async f=>{
 f.setTime(f.event.entryStartsAt);let release!:()=>void,locked!:()=>void,read!:()=>void;
 const hold=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{locked=r;}),observed=new Promise<void>(r=>{read=r;});
 const blocker=f.sql.begin(async tx=>{await tx`select id from bases where id=${f.baseId} for update`;locked();await hold;});await ready;
 f.beforeRead(async()=>{read();});const pending=f.enter();await observed;
 // Let the reader complete with current Clock, then wait for the actual blocked
 // transaction: no timing guess may manufacture the stale-lock condition.
 const deadline=Date.now()+10000;let blocked=false;
 while(Date.now()<deadline){const [row]=await f.sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%bases%') yes`;if(row?.yes){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
 f.setTime(new Date(f.clock().getTime()+P.observationMaxAgeMs+1));release();await blocker;expect(blocked).toBe(true);await expect(pending).rejects.toMatchObject({code:'DIVINE_TRIAL_QUALIFICATION'});
 expect(await f.sql`select * from divine_trial_entries`).toHaveLength(0);
}),120000);

it('entry window and original identity survive later outage while changed bodies or unqualified wallets do not',async()=>withDivineTrialFixture(async f=>{
 await expect(f.enter()).rejects.toMatchObject({code:'DIVINE_TRIAL_WINDOW'});f.setTime(f.event.entryStartsAt);const entry=await f.enter();
 f.setTime(f.event.playStartsAt);f.setOnline(false);process.env.PHASE_E_MINING_ENABLED='false';const service=f.service();
 expect(await service.enter(f.wallet,f.event.id,{baseId:f.baseId,idempotencyKey:entry.idempotencyKey})).toEqual(entry);
 await expect(service.enter(f.wallet,f.event.id,{baseId:f.baseId,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'DIVINE_TRIAL_IDEMPOTENCY_BODY_MISMATCH'});
 await expect(service.enter(f.buyer,f.event.id,{baseId:f.buyerBaseId,idempotencyKey:randomUUID()})).rejects.toThrow();
}),120000);
