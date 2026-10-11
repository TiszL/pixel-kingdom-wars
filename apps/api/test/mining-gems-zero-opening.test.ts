import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {describe,expect,it,vi} from 'vitest';
import {getOrCreatePlayerAccount,postTransaction} from '../src/ledger';
import type {DbOrTx} from '../src/db/client';
import {spendGems} from '../src/game/spend';
import {captureGemsZeroOpening,readGemsZeroOpening,readGemsZeroOpeningIntervalInTransaction,replayGemsZeroOpening} from '../src/mining/gemsZeroOpening';
import {withGemsZeroOpeningFixture,resealGemsZeroOpeningFixtureClock} from './fixtures/gemsZeroOpening';
type F=Parameters<Parameters<typeof withGemsZeroOpeningFixture>[0]>[0];
const read=(f:F,id:string)=>({wallet:f.wallet,openingId:id});
async function credit(f:F,amount=7n,db:DbOrTx=f.conn.db){const keep=await getOrCreatePlayerAccount(db,f.wallet,'player_keep');await postTransaction(db,{idempotencyKey:randomUUID(),type:'fixture.keep',entries:[{account:f.sys.keep_genesis,delta:-amount},{account:keep.id,delta:amount}]});return postTransaction(db,{idempotencyKey:randomUUID(),type:'fixture.unknown',entries:[{account:keep.id,delta:-amount},{account:f.sys.emission_pool,delta:amount},{account:f.sys.gems_mint,delta:-amount},{account:f.gems.id,delta:amount}]});}
describe('committed real zero Gems opening',()=>{
 it('captures an existing zero account unchanged, next full day, without fabricating birth or origins',()=>withGemsZeroOpeningFixture(async f=>{
 const before=await f.conn.sql`select balance::text balance from accounts where id=${f.gems.id}`;const p=await f.capture('2020-01-03T12:00:00.000001Z');
 expect(p).toMatchObject({purpose:'gems_zero_opening',account:{id:f.gems.id,balance:'0'},observedAt:'2020-01-03T12:00:00.000001Z',firstEligibleDay:'2020-01-04',baseline:f.baseline,ledger:[],eligibilityAuthorized:false,allocationAuthorized:false,publicationAuthorized:false});
 expect(p).not.toHaveProperty('birthEventId');expect(p.account).not.toHaveProperty('createdAt');expect(await f.conn.sql`select balance::text balance from accounts where id=${f.gems.id}`).toEqual(before);
 expect(replayGemsZeroOpening(JSON.parse(JSON.stringify(p)))).toEqual(p);expect(Object.isFrozen(p.baseline.player)).toBe(true);
 await f.close();expect((await f.conn.db.transaction(tx=>readGemsZeroOpeningIntervalInTransaction(tx,{...read(f,p.id),day:'2020-01-04'}))).opening).toEqual(p);
 await captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id});expect(await readGemsZeroOpening(f.conn.db,read(f,p.id))).toEqual(p);
 await expect(resealGemsZeroOpeningFixtureClock(f.conn)).rejects.toThrow('empty disposable');
 }));
 it('authenticates the full balanced historical ledger at zero and retains that boundary after later credits',()=>withGemsZeroOpeningFixture(async f=>{
 await credit(f);await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'NONZERO'});
 await spendGems(f.conn.db,f.wallet,7n,'fixture.past.use',randomUUID());const p=await f.capture();expect(p.ledger).toHaveLength(2);expect(p.ledger.map(l=>l.entry.delta)).toEqual(['7','-7']);
 for(const mutate of [(v:typeof p)=>{v.ledger.pop();},(v:typeof p)=>{v.ledger[0]!.receipt.pop();},(v:typeof p)=>{v.ledger[0]!.entry.accountId=randomUUID();},(v:typeof p)=>{v.ledgerEntryFrontier='0';}]){const v=structuredClone(p);mutate(v);expect(()=>replayGemsZeroOpening(v)).toThrow();}
 await f.clock('2020-01-04T12:00:00Z');await credit(f,2n);await captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id});
 expect(await readGemsZeroOpening(f.conn.db,read(f,p.id))).toEqual(p);expect((await f.conn.sql`select balance::text balance from accounts where id=${f.gems.id}`)[0]?.balance).toBe('2');
 vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await readGemsZeroOpening(f.conn.db,read(f,p.id))).toEqual(p);
 }));
 it('refuses a cached-zero/full-ledger mismatch and an unbalanced zero-sum account history',()=>withGemsZeroOpeningFixture(async f=>{
 await credit(f);await f.conn.sql`update accounts set balance=0 where id=${f.gems.id}`;
 await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'NONZERO'});
 await f.conn.sql`update accounts set balance=7 where id=${f.gems.id}`;await spendGems(f.conn.db,f.wallet,7n,'fixture.use',randomUUID());
 const id=randomUUID();await f.conn.sql`insert into ledger_transactions(id,idempotency_key,type,metadata) values(${id},${randomUUID()},'fixture.invalid','{}')`;
 await f.conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${id},${f.gems.id},1,1),(${id},${f.gems.id},-1,0)`;
 await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});expect(await f.conn.sql`select id from mining_gems_zero_openings`).toHaveLength(0);
 }));
 it('rejects RLS, changed source guards and runtime authority while keeping committed openings recoverable',()=>withGemsZeroOpeningFixture(async f=>{
 const p=await f.capture();await f.close();
 for(const statement of ['alter table mining_gems_flow_events enable row level security','alter table ledger_entries force row level security','alter table mining_gems_zero_openings force row level security',
 'alter table ledger_entries disable trigger ledger_entries_mining_gems_flow_capture',"create or replace function shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select clock_timestamp() $$"]){
 await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(statement));await readGemsZeroOpeningIntervalInTransaction(tx,{...read(f,p.id),day:'2020-01-04'});})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});}
 expect(await readGemsZeroOpening(f.conn.db,read(f,p.id))).toEqual(p);
 const role='zero_'+randomUUID().replaceAll('-','');await f.conn.sql.unsafe(`create role ${role}`);try{await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`select * from mining_gems_zero_openings`;})).rejects.toMatchObject({code:'42501'});}finally{await f.conn.sql.unsafe(`drop role ${role}`);}
 for(const statement of ['delete from mining_gems_zero_openings','truncate mining_gems_zero_openings',"update mining_gems_zero_openings set evidence='{}'",'delete from mining_gems_zero_contract','truncate mining_gems_zero_contract'])await expect(f.conn.sql.unsafe(statement)).rejects.toThrow(/IMMUTABLE/);
 }));
 it('requires committed baseline/opening, fresh read-committed source transactions and closed full days',()=>withGemsZeroOpeningFixture(async f=>{
 await expect(f.conn.sql.begin(async tx=>{await tx`set transaction isolation level repeatable read`;await tx`insert into mining_gems_zero_openings(wallet,baseline_id) values(${f.wallet},${f.baseline.id})`;})).rejects.toThrow('READ_COMMITTED');
 await expect(f.conn.sql.begin(async tx=>{await tx`update accounts set balance=balance where id=${f.gems.id}`;await tx`insert into mining_gems_zero_openings(wallet,baseline_id) values(${f.wallet},${f.baseline.id})`;})).rejects.toThrow('FRESH_TRANSACTION');
 await expect(f.conn.sql.begin(async tx=>{await tx`insert into mining_existing_wallet_baselines(wallet) values(${f.wallet}) on conflict do nothing`;await tx`insert into mining_gems_zero_openings(wallet,baseline_id) values(${f.wallet},${f.baseline.id})`;})).rejects.toThrow('FRESH_TRANSACTION');
 await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql`insert into mining_gems_zero_openings(wallet,baseline_id) values(${f.wallet},${f.baseline.id})`);const [r]=await tx.execute<{id:string}>(sql`select id from mining_gems_zero_openings where wallet=${f.wallet}`);await readGemsZeroOpeningIntervalInTransaction(tx,{wallet:f.wallet,openingId:r!.id,day:'2020-01-04'});})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 const p=await f.capture();await expect(f.conn.db.transaction(tx=>readGemsZeroOpeningIntervalInTransaction(tx,{...read(f,p.id),day:'2020-01-04'}))).rejects.toMatchObject({code:'DAY_OPEN'});
 await f.close();await expect(f.conn.db.transaction(tx=>readGemsZeroOpeningIntervalInTransaction(tx,{...read(f,p.id),day:'2020-01-03'}))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }));
 it('fences active writers and cannot reset an opening through a race or changed baseline',()=>withGemsZeroOpeningFixture(async f=>{
 let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
 const writer=f.conn.sql.begin(async tx=>{await tx`lock table ledger_entries in row exclusive mode`;ready();await gate;});try{await started;await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
 const results=await Promise.allSettled([captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id}),captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})]);expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(results.every(r=>r.status==='fulfilled'||r.reason.code==='BUSY')).toBe(true);
 expect(await f.conn.sql`select id from mining_gems_zero_openings`).toHaveLength(1);const p=await f.capture();await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:randomUUID()})).rejects.toThrow();
 await f.close();await f.conn.db.transaction(async tx=>{await readGemsZeroOpeningIntervalInTransaction(tx,{...read(f,p.id),day:'2020-01-04'});await expect(f.conn.sql.begin(t=>t`lock table accounts in row exclusive mode nowait`)).rejects.toMatchObject({code:'55P03'});});
 }));
 it('holds out-and-back identity and prior ledger mutations while preserving strict copied replay',()=>withGemsZeroOpeningFixture(async f=>{
 await credit(f);await spendGems(f.conn.db,f.wallet,7n,'fixture.past.use',randomUUID());const p=await f.capture();await f.close();
 await expect(f.conn.sql`update ledger_transactions set type='changed' where id=${p.ledger[0]!.transaction.id}`).rejects.toThrow('MINING_FREE_ATTRIBUTION_IMMUTABLE');
 expect(await readGemsZeroOpening(f.conn.db,read(f,p.id))).toEqual(p);
 await f.conn.sql`update players set created_at='2019-12-02T00:00:00Z' where wallet=${f.wallet}`;await f.conn.sql`update players set created_at='2019-12-01T00:00:00Z' where wallet=${f.wallet}`;
 await expect(readGemsZeroOpening(f.conn.db,read(f,p.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});expect(replayGemsZeroOpening(p)).toEqual(p);
 for(const mutate of [(v:typeof p)=>{v.wallet=f.buyer;},(v:typeof p)=>{v.firstEligibleDay='2020-01-03';},(v:typeof p)=>{Object.assign(v,{birthEventId:'1'});},(v:typeof p)=>{Object.assign(v.account,{balance:'1'});},(v:typeof p)=>{v.flowEventFrontier='-1';},(v:typeof p)=>{Object.assign(v.baseline.player,{createdAt:'2019-12-01T00:00:00.00000Z'});},(v:typeof p)=>{Object.assign(v,{allocationAuthorized:true});}]){const v=structuredClone(p);mutate(v);expect(()=>replayGemsZeroOpening(v)).toThrow();}
 const getter=vi.fn(()=>p.wallet),v=structuredClone(p);Object.defineProperty(v,'wallet',{get:getter,enumerable:true});expect(()=>replayGemsZeroOpening(v)).toThrow();expect(getter).not.toHaveBeenCalled();
 }));
 it('holds a post-baseline backdated source without establishing an opening',()=>withGemsZeroOpeningFixture(async f=>{
 await f.clock('2020-01-03T11:59:59.999999Z');await credit(f);await spendGems(f.conn.db,f.wallet,7n,'fixture.past.use',randomUUID());await f.clock('2020-01-03T12:00:00Z');
 await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));

 it('holds a cross-wallet transaction group completed after the claimed opening clock',()=>withGemsZeroOpeningFixture(async f=>{
 await f.clock('2020-01-03T13:00:00Z');await f.conn.db.transaction(async tx=>{
 await credit(f,7n,tx);await spendGems(tx,f.wallet,7n,'fixture.completed',randomUUID());await f.clock('2020-01-04T00:00:00.000001Z');await getOrCreatePlayerAccount(tx,f.buyer,'player_gems');
 });await f.clock('2020-01-03T14:00:00Z');await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 expect(await f.conn.sql`select id from mining_gems_zero_openings`).toHaveLength(0);
 }));

 // Each inherited source gets a fresh database: relhassubclass can stay true
 // after DROP, so a shared fixture would falsely attribute later refusals.
 it.each(['players','accounts','ledger_transactions','ledger_entries','mining_free_coverage','mining_free_cohort_events',
 'mining_gems_flow_coverage','mining_gems_flow_events','mining_existing_wallet_baselines','mining_existing_wallet_contract',
 'playtest_activity_coverage','mining_activity_evidence','mining_wallet_experience_days','mining_wallet_experience_awards',
 'mining_gems_zero_openings','mining_gems_zero_contract'])('refuses inherited %s as an unauthenticated source on capture and both readers',table=>withGemsZeroOpeningFixture(async f=>{
 const p=await f.capture();await f.close();
 await f.conn.sql.unsafe(`create table public.forged_zero_source() inherits(public.${table})`);
 await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 await expect(readGemsZeroOpening(f.conn.db,read(f,p.id))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 await expect(f.conn.db.transaction(tx=>readGemsZeroOpeningIntervalInTransaction(tx,{...read(f,p.id),day:'2020-01-04'}))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 expect(await f.conn.sql`select id from only mining_gems_zero_openings`).toHaveLength(1);
 }));
 it('does not establish a new opening with inherited flow events',()=>withGemsZeroOpeningFixture(async f=>{
 await f.conn.sql`create table public.forged_zero_source() inherits(public.mining_gems_flow_events)`;
 await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 expect(await f.conn.sql`select id from only mining_gems_zero_openings`).toHaveLength(0);
 }));
 it('refuses rewrite rules that can bypass the authenticated parent journal',()=>withGemsZeroOpeningFixture(async f=>{
 const p=await f.capture();await f.close();
 await f.conn.sql`create rule forged_zero_rule as on insert to mining_gems_flow_events do instead nothing`;
 await expect(captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:f.baseline.id})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 await expect(readGemsZeroOpening(f.conn.db,read(f,p.id))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 await expect(f.conn.db.transaction(tx=>readGemsZeroOpeningIntervalInTransaction(tx,{...read(f,p.id),day:'2020-01-04'}))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }));

});
