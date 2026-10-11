/** Real migrated fixture DBs: conversion, journal and freeze commit together. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { BASE_OWNERSHIP, FORGE } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { applyFixtureL1Retirement, type FixtureRetirementRequest } from '../src/db/keepCustodyJournal';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, getOrCreateBaseAccount, postTransaction } from '../src/ledger';
import { spendGems } from '../src/game/spend';
import { createTestPlayer, fundTestKeep } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
import { deliverSystemMail, claimMailReward, expireDueMailRewards, getMail, markMailRead } from '../src/mail/service';
import { bases, baseItems, baseForgePositions, deedOwnershipObservations } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { buildWeeklySnapshot, getInclusionProof, getProofOfReserves } from '../src/money/snapshot';

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.database} with (force)`); await f.admin.end(); }
}
async function setup() {
  const database = `shardkeep_custody_apply_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('fixture host');
  const admin = postgres(ADMIN_DATABASE_URL, { max:1, onnotice:()=>{} });
  await createMigratedDatabase(admin, database);
  const conn = createDb(url.toString(), { max:5 }); await runMigrations(conn.db);
  const a = await createTestPlayer(conn.db), b = await createTestPlayer(conn.db), internal = await createTestPlayer(conn.db);
  await bootstrapSystemAccounts(conn.db);
  for (const [wallet,amount] of [[a.wallet,11n],[b.wallet,7n],[internal.wallet,5n]] as const)
    await fundTestKeep(conn.db,wallet,amount,'test.fund',randomUUID());
  const request: FixtureRetirementRequest = { fixtureId:randomUUID(),asOf:'2035-01-01T00:00:00.000Z',
    players:[{wallet:a.wallet,keep:'11',internal:false},{wallet:b.wallet,keep:'7',internal:false},{wallet:internal.wallet,keep:'5',internal:true}] };
  const env = { HOLD_BEFORE_MIGRATE:'1',TEST_DATABASE_URL:url.toString(),ALPHA_WALLETS:internal.wallet };
  const apply = (input = request) => applyFixtureL1Retirement(input,env);
  const close = async () => {
    await conn.sql`select shardkeep_advance_keep_custody_phase('open','fenced')`;
    await conn.sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`;
  };
  const snapshot = async () => JSON.stringify(await conn.sql`select
    (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
    (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,
    (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries,
    (select jsonb_agg(to_jsonb(j)) from keep_custody_journal j) journal,
    (select jsonb_agg(to_jsonb(m) order by id) from mail_messages m) mail,
    (select jsonb_agg(to_jsonb(p) order by attachment_id) from mail_keep_retirements p) provenance,
    (select phase from keep_custody_cutover_state) phase`);
  return {database,admin,conn,a,b,internal,request,env,apply,close,snapshot};
}

async function seedForge(f: Awaited<ReturnType<typeof setup>>, internal = false) {
  const wallet = internal ? f.internal.wallet : f.b.wallet, day = '2034-12-31';
  const [base] = await f.conn.db.insert(bases).values({ ownerWallet:wallet, deedAssetId:f.a.wallet, status:'active' }).returning();
  const sys = await bootstrapSystemAccounts(f.conn.db), escrow = await getOrCreateBaseAccount(f.conn.db,base!.id,'base_forge_escrow');
  await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.forge-fund',entries:[
    {account:sys.keep_genesis,delta:-9n},{account:sys.emission_pool,delta:9n},
    {account:sys.shard_genesis,delta:-8n},{account:escrow.id,delta:8n}]});
  const metadata={day,baseId:base!.id,counted:'8'};
  const burned=await postTransaction(f.conn.db,{idempotencyKey:`forge:base:${day}:${base!.id}:shards`,type:'forge.burn',metadata,
    entries:[{account:escrow.id,delta:-8n},{account:sys.shard_burn,delta:8n}]});
  const allocated=await postTransaction(f.conn.db,{idempotencyKey:`forge:base:${day}:${base!.id}:keep`,type:'forge.allocate',metadata,
    entries:[{account:sys.emission_pool,delta:-9n},{account:sys.forge_payout_escrow,delta:9n}]});
  const [position]=await f.conn.db.insert(baseForgePositions).values({day,baseId:base!.id,contributedShards:10n,raidDebitedShards:2n,
    countedShards:8n,shardsRefunded:0n,keepPaid:9n,settlementOwnerWallet:f.a.wallet,itemsDropped:['keg_of_haste'],
    shardSettlementTxnId:burned.transaction.id,keepEscrowTxnId:allocated.transaction.id,settledAt:new Date(Date.parse(f.request.asOf)-1000)}).returning();
  await f.conn.db.insert(baseItems).values({baseId:base!.id,itemId:'keg_of_haste',qty:1});
  await f.conn.db.insert(deedOwnershipObservations).values({baseId:base!.id,assetId:f.a.wallet,owner:wallet,slot:100n,
    checkedAt:new Date(f.request.asOf),source:'fixture-finalized',status:'owned',auditHash:'fixture'});
  return {position:position!,base:base!,row:{positionId:position!.id,baseId:base!.id,day,wallet,keep:'9',internal}};
}

describe('L1 fixture-only atomic retirement', () => {
  it('captures complete unknown expired deposit sources in the immutable freeze journal', async () => fixture(async f => {
    const id=randomUUID();
    await f.conn.sql`insert into deposits(id,player_wallet,kind,reference,status,created_at,payload)
      values(${id},${f.a.wallet},'keep_deposit',${f.b.wallet},'expired','2034-12-31T23:59:00Z','{"fixture":"original"}'::jsonb)`;
    const original=(await f.conn.sql`select to_jsonb(d) row from deposits d where id=${id}`)[0]!.row;
    await f.close(); await f.apply();
    const journal=(await f.conn.sql`select late_deposit_sources from keep_custody_journal`)[0]!;
    expect(journal.late_deposit_sources).toEqual([original]);
    await expect(f.conn.sql`update deposits set payload='{"fixture":"changed"}'::jsonb where id=${id}`).rejects.toThrow('KEEP_CUSTODY_FROZEN');
    expect((await f.conn.sql`select late_deposit_sources from keep_custody_journal`)[0]!.late_deposit_sources).toEqual([original]);
    await expect(f.conn.sql`update keep_custody_journal set late_deposit_sources='[]'::jsonb`).rejects.toThrow('CUSTODY_JOURNAL_IMMUTABLE');
  }),30_000);
  it('keeps historical proofs and excludes retired mixed-mail KEEP from future roots', async () => fixture(async f => {
    const sys=await bootstrapSystemAccounts(f.conn.db), oldDelivery=process.env['MAIL_DELIVERY_ENABLED'];
    await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.mail-fund',entries:[{account:sys.keep_genesis,delta:-3n},{account:sys.emission_pool,delta:3n}]});
    process.env['MAIL_DELIVERY_ENABLED']='true';
    let sent;
    try { sent=await deliverSystemMail(f.conn.db,{recipientWallet:f.a.wallet,deliveryKey:'por-mixed',subject:'Mixed',body:'Preserve remaining rewards',attachments:[{kind:'KEEP',amount:3n},{kind:'SHARDS',amount:4n}]},new Date(f.request.asOf)); }
    finally { if(oldDelivery===undefined) delete process.env['MAIL_DELIVERY_ENABLED']; else process.env['MAIL_DELIVERY_ENABLED']=oldDelivery; }
    const original=await buildWeeklySnapshot(f.conn.db,new Date(f.request.asOf));
    expect(original.totalBalance).toBe(26n);
    const proof=await getInclusionProof(f.conn.db,f.a.wallet);
    const outbox=JSON.stringify(await f.conn.sql`select * from outbox order by id`);
    await f.close();
    await f.apply({...f.request,mails:[{messageId:sent.message.id,wallet:f.a.wallet,keep:'3',internal:false}]});
    expect((await f.conn.sql`select reward_state from mail_messages where id=${sent.message.id}`)[0]!.reward_state).toBe('pending');
    expect(await getInclusionProof(f.conn.db,f.a.wallet)).toEqual(proof);
    expect(await buildWeeklySnapshot(f.conn.db,new Date(f.request.asOf))).toEqual({...original,alreadyExisted:true});
    expect(await buildWeeklySnapshot(f.conn.db,new Date('2035-01-08T00:00:00.000Z'))).toMatchObject({kind:'no_liabilities',phase:'frozen',root:null,totalBalance:0n,leafCount:0});
    expect(JSON.stringify(await f.conn.sql`select * from outbox order by id`)).toBe(outbox);
    expect((await f.conn.sql`select count(*)::int n from merkle_snapshots`)[0]!.n).toBe(1);
    const por=await getProofOfReserves(f.conn.db);
    expect(por.liabilities?.root).toBe(original.root);
    expect(por.custodyTransition).toMatchObject({phase:'frozen',reserveAttested:false,
      evidence:{status:'fixture_recorded',keepConverted:'21',gemsMinted:'21',internalKeepSwept:'5'}});
  }),30_000);
  it('refuses unsafe application input before a connection', async () => {
    const request = {fixtureId:randomUUID(),asOf:'2035-01-01T00:00:00.000Z',players:[]};
    for (const env of [{HOLD_BEFORE_MIGRATE:'0',TEST_DATABASE_URL:'postgres://localhost/fixture_test'},
      {HOLD_BEFORE_MIGRATE:'1',TEST_DATABASE_URL:'postgres://example.com/shardkeep_custody_apply_00000000000000000000000000000000_test'},
      {HOLD_BEFORE_MIGRATE:'1',TEST_DATABASE_URL:'postgres://localhost/shardkeep_test'}])
      await expect(applyFixtureL1Retirement(request,env)).rejects.toThrow();
  });
  it('posts exact four-leg player conversions and separate internal sweep, freezes atomically and recovers after Gems spending/restart', async () => fixture(async f => {
    await f.close(); const first = await f.apply();
    expect(first).toMatchObject({fixtureOnly:true,retirementAuthorized:false,measuredG8:true,totalKeepConverted:'18',sweptInternalKeep:'5'});
    expect(first.releaseEvidence).toHaveLength(8); expect(first.releaseEvidence.every(e=>e.status==='unverified')).toBe(true);
    const rows = await f.conn.sql`select t.idempotency_key,t.type,t.metadata,a.kind,a.owner_wallet,a.currency,e.delta::text
      from ledger_transactions t join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id
      where t.metadata->>'fixtureId'=${f.request.fixtureId} order by t.idempotency_key,a.kind`;
    expect(rows).toHaveLength(10);
    for (const p of f.request.players) {
      const own = rows.filter(r=>r.metadata.wallet===p.wallet);
      expect(own.map(r=>[r.kind,r.owner_wallet,r.currency,r.delta]).sort()).toEqual((p.internal ?
        [['player_keep',p.wallet,'KEEP','-5'],['emission_pool',null,'KEEP','5']] :
        [['player_keep',p.wallet,'KEEP',`-${p.keep}`],['emission_pool',null,'KEEP',p.keep],['gems_mint',null,'GEMS',`-${p.keep}`],['player_gems',p.wallet,'GEMS',p.keep]]).sort());
      expect(own.every(r=>r.type===(p.internal?'gems.retirement.sweep':'gems.retirement'))).toBe(true);
      expect(own.every(r=>r.idempotency_key===(p.internal?`retirement:sweep:${p.wallet}`:`retirement:${p.wallet}`))).toBe(true);
      expect(own.every(r=>p.internal
        ? r.metadata.keep===p.keep && r.metadata.reason==='internal-wallet'
        : r.metadata.class==='L1' && r.metadata.keep===p.keep && r.metadata.gems===p.keep && r.metadata.reason==='retirement')).toBe(true);
    }
    expect((await f.conn.sql`select phase from keep_custody_cutover_state`)[0]!.phase).toBe('frozen');
    await spendGems(f.conn.db,f.a.wallet,3n,'test.spend',randomUUID());
    const before = await f.snapshot(); expect(await f.apply()).toEqual(first); expect(await f.snapshot()).toBe(before);
    await expect(f.conn.sql`update keep_custody_journal set input_hash=repeat('0',64)`).rejects.toThrow('CUSTODY_JOURNAL_IMMUTABLE');
    await expect(f.conn.sql`delete from keep_custody_journal`).rejects.toThrow('CUSTODY_JOURNAL_IMMUTABLE');
    await expect(f.conn.sql`truncate keep_custody_journal cascade`).rejects.toThrow('CUSTODY_JOURNAL_IMMUTABLE');
    await expect(f.apply({...f.request,fixtureId:randomUUID()})).rejects.toThrow('CUSTODY_JOURNAL_CONFLICT');
  }),30_000);
  it('requires withdrawals_closed and exact current input', async () => fixture(async f => {
    await expect(f.apply()).rejects.toThrow('CUSTODY_PHASE_REQUIRED'); await f.close();
    const before=await f.snapshot();
    await expect(f.apply({...f.request,players:f.request.players.slice(1)})).rejects.toThrow('CUSTODY_INPUT_MISMATCH');
    expect(await f.snapshot()).toBe(before);
  }),30_000);
  it.each(['forge_payout_escrow','mail_keep_escrow','league_entitlement_escrow','withdrawal_escrow','deposit','ledger'] as const)('refuses unsupported %s state without posting or journaling', async kind => fixture(async f => {
    const sys=await bootstrapSystemAccounts(f.conn.db);
    if(kind==='deposit') await f.conn.sql`insert into deposits(player_wallet,kind,reference) values(${f.a.wallet},'keep_deposit',${randomUUID()})`;
    else if(kind==='ledger') await f.conn.sql`update accounts set balance=balance+1 where kind='player_keep' and owner_wallet=${f.a.wallet}`;
    else await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.escrow',entries:[{account:sys.keep_genesis,delta:-1n},{account:sys[kind],delta:1n}]});
    await f.close(); const before=await f.snapshot(); await expect(f.apply()).rejects.toThrow('CUSTODY_UNSUPPORTED_STATE'); expect(await f.snapshot()).toBe(before);
  }),30_000);
  it('rolls prior wallet postings back on a conflicting later retirement key', async () => fixture(async f => {
    const last=[...f.request.players].filter(p=>!p.internal).sort((a,b)=>(a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0)).at(-1)!;
    const sys=await bootstrapSystemAccounts(f.conn.db);
    await postTransaction(f.conn.db,{idempotencyKey:`retirement:${last.wallet}`,type:'test.conflict',entries:[{account:sys.keep_genesis,delta:-1n},{account:sys.emission_pool,delta:1n}]});
    await f.close(); const before=await f.snapshot(); await expect(f.apply()).rejects.toThrow('CUSTODY_RECEIPT_CONFLICT'); expect(await f.snapshot()).toBe(before);
  }),30_000);
  it('concurrent requests either recover the exact journal or fail NOWAIT without duplicate credit', async () => fixture(async f => {
    await f.close(); const attempts=await Promise.allSettled([f.apply(),f.apply()]);
    expect(attempts.some(r=>r.status==='fulfilled')).toBe(true);
    const receipt=await f.apply();
    for(const attempt of attempts) if(attempt.status==='fulfilled') expect(attempt.value).toEqual(receipt);
    expect((await f.conn.sql`select count(*)::int n from keep_custody_journal`)[0]!.n).toBe(1);
    expect((await f.conn.sql`select count(*)::int n from ledger_transactions where metadata->>'fixtureId'=${f.request.fixtureId}`)[0]!.n).toBe(3);
  }),30_000);
  it('refuses a broadly granted runtime principal and forged GUCs', async () => fixture(async f => {
    await f.close(); const role=`custody_runtime_${randomUUID().replaceAll('-','')}`;
    await f.admin.unsafe(`create role ${role}`);
    try {
      await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);
      await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}`);
      await f.conn.sql.unsafe(`grant execute on all functions in schema public to ${role}`);
      await expect(f.conn.db.transaction(async tx=>{
        await tx.execute(sql.raw(`set local role ${role}`));
        await tx.execute(sql`select set_config('shardkeep.keep_custody_cutover','operator-settle',true)`);
        await applyFixtureL1Retirement(f.request,f.env,()=>({db:tx as unknown as Db,close:async()=>{}}));
      })).rejects.toThrow('CUSTODY_FIXTURE_IDENTITY_REQUIRED');
      await expect(f.conn.db.transaction(async tx=>{
        await tx.execute(sql.raw(`set local role ${role}`)); await tx.execute(sql`select set_config('shardkeep.keep_custody_cutover','operator-settle',true)`);
        await tx.execute(sql`insert into keep_custody_journal(id,operation,scope,subcommand,dry_run,input_hash,operator_name,database_name,request,receipts,before_state,after_state)
          values(${f.request.fixtureId},'fixture:l1-retirement','fixture','retire-l1',false,${'0'.repeat(64)},current_user,current_database(),'{}','[]','{}','{}')`);
      })).rejects.toMatchObject({cause:{message:'CUSTODY_JOURNAL_OWNER_REQUIRED'}});
    } finally { await f.conn.sql.unsafe(`drop owned by ${role}`); await f.admin.unsafe(`drop role ${role}`); }
  }),30_000);
  it('rejects a different actual database even when the claimed URL is a valid fixture name', async () => fixture(async f => {
    const url=new URL(f.env.TEST_DATABASE_URL); url.pathname=`/shardkeep_custody_apply_${'0'.repeat(32)}_test`;
    await expect(applyFixtureL1Retirement(f.request,{...f.env,TEST_DATABASE_URL:url.toString()},()=>({db:f.conn.db,close:async()=>{}})))
      .rejects.toThrow('CUSTODY_FIXTURE_IDENTITY_REQUIRED');
  }),30_000);
  it.each(['entry','account'] as const)('recovery validates original %s identity rather than current Gems or a key alone', async change => fixture(async f => {
    await f.close(); await f.apply();
    if(change==='entry') await f.conn.sql`update ledger_entries set delta=delta+1 where account_id in
      (select id from accounts where kind='player_gems' and owner_wallet=${f.a.wallet})`;
    else await f.conn.sql`update accounts set owner_wallet=${f.internal.wallet} where kind='player_gems' and owner_wallet=${f.a.wallet}`;
    const before=await f.snapshot(); await expect(f.apply()).rejects.toThrow('CUSTODY_RECEIPT_CONFLICT'); expect(await f.snapshot()).toBe(before);
  }),30_000);
  it('refuses a busy ledger writer before taking the latch', async () => fixture(async f => {
    await f.close(); let release!:()=>void,ready!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{ready=resolve});
    const writer=f.conn.db.transaction(async tx=>{await tx.execute(sql`update accounts set balance=balance where kind='player_keep'`);ready();await gate;});
    try { await held; await expect(f.apply()).rejects.toMatchObject({cause:{code:'55P03'}}); }
    finally { release(); await writer; }
    expect((await f.conn.sql`select phase from keep_custody_cutover_state`)[0]!.phase).toBe('withdrawals_closed');
    expect((await f.conn.sql`select count(*)::int n from keep_custody_journal`)[0]!.n).toBe(0);
  }),30_000);

  it('recovers identical original receipts across database time zones', async () => fixture(async f => {
    await f.close();
    const inZone = (zone: string) => f.conn.db.transaction(async tx => {
      await tx.execute(sql`select set_config('TimeZone',${zone},true)`);
      return applyFixtureL1Retirement(f.request,f.env,()=>({db:tx as unknown as Db,close:async()=>{}}));
    });
    const saved = await inZone('Asia/Tbilisi');
    expect(await inZone('America/New_York')).toEqual(saved);
  }),30_000);
  it.each(['journal','freeze'] as const)('rolls every posting and journal back when the final %s step fails', async stage => fixture(async f => {
    const sys=await bootstrapSystemAccounts(f.conn.db), oldDelivery=process.env['MAIL_DELIVERY_ENABLED'];
    await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.mail-fund',entries:[{account:sys.keep_genesis,delta:-3n},{account:sys.emission_pool,delta:3n}]});
    process.env['MAIL_DELIVERY_ENABLED']='true';
    let sent;
    try { sent=await deliverSystemMail(f.conn.db,{recipientWallet:f.a.wallet,deliveryKey:'rollback',subject:'Rollback',body:'No partial retirement',attachments:[{kind:'KEEP',amount:3n},{kind:'SHARDS',amount:1n}]},new Date(f.request.asOf)); }
    finally { if(oldDelivery===undefined) delete process.env['MAIL_DELIVERY_ENABLED']; else process.env['MAIL_DELIVERY_ENABLED']=oldDelivery; }
    await f.close();
    await f.conn.sql.unsafe("create function fixture_abort_custody() returns trigger language plpgsql as $$ begin raise exception 'FIXTURE_LAST_STEP_FAILED'; end $$");
    await f.conn.sql.unsafe(stage==='journal'
      ? 'create trigger fixture_abort_custody before insert on keep_custody_journal for each row execute function fixture_abort_custody()'
      : 'create trigger fixture_abort_custody before update on keep_custody_cutover_state for each row execute function fixture_abort_custody()');
    const before = await f.snapshot();
    await expect(f.apply({...f.request,mails:[{messageId:sent.message.id,wallet:f.a.wallet,keep:'3',internal:false}]})).rejects.toMatchObject({cause:{message:'FIXTURE_LAST_STEP_FAILED'}});
    expect(await f.snapshot()).toBe(before);
  }),30_000);
  it('refuses direct fixture journal authority when the latch singleton is missing', async () => fixture(async f => {
    await f.close();
    // Deliberately corrupt only this disposable database, bypassing the existing
    // owner guard to prove the new journal independently fails closed.
    await f.conn.sql`alter table keep_custody_cutover_state disable trigger keep_custody_state_forward_only`;
    await f.conn.sql`delete from keep_custody_cutover_state`;
    await f.conn.sql`alter table keep_custody_cutover_state enable trigger keep_custody_state_forward_only`;
    await expect(f.conn.sql`insert into keep_custody_journal(id,operation,scope,subcommand,dry_run,input_hash,operator_name,database_name,request,receipts,before_state,after_state)
      values(${f.request.fixtureId},'fixture:l1-retirement','fixture','retire-l1',false,${'0'.repeat(64)},current_user,current_database(),'{}','[]','{}','{}')`)
      .rejects.toThrow('CUSTODY_JOURNAL_PHASE_REQUIRED');
    expect((await f.conn.sql`select count(*)::int n from keep_custody_journal`)[0]!.n).toBe(0);
  }),30_000);

  it('retires KEEP-only and mixed mail, preserves every attachment and claims only remaining rewards exactly once', async () => fixture(async f => {
    const now = new Date(f.request.asOf), sys = await bootstrapSystemAccounts(f.conn.db);
    await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.mail-fund',entries:[{account:sys.keep_genesis,delta:-100n},{account:sys.emission_pool,delta:100n}]});
    process.env['MAIL_DELIVERY_ENABLED']='true';
    let mixed,only,internal;
    try {
      mixed=await deliverSystemMail(f.conn.db,{recipientWallet:f.a.wallet,deliveryKey:'mixed',subject:'Mixed',body:'Mixed',attachments:[{kind:'KEEP',amount:3n},{kind:'SHARDS',amount:4n},{kind:'ITEM',itemId:'keg_of_haste',qty:2}]},now);
      only=await deliverSystemMail(f.conn.db,{recipientWallet:f.b.wallet,deliveryKey:'only',subject:'Only',body:'Only',attachments:[{kind:'KEEP',amount:6n}]},now);
      internal=await deliverSystemMail(f.conn.db,{recipientWallet:f.internal.wallet,deliveryKey:'internal',subject:'Internal',body:'Internal',attachments:[{kind:'KEEP',amount:2n}]},now);
    } finally { delete process.env['MAIL_DELIVERY_ENABLED']; }
    const originals=JSON.stringify(await f.conn.sql`select * from mail_attachments order by id`);
    const request={...f.request,mails:[{messageId:mixed.message.id,wallet:f.a.wallet,keep:'3',internal:false},{messageId:only.message.id,wallet:f.b.wallet,keep:'6',internal:false},{messageId:internal.message.id,wallet:f.internal.wallet,keep:'2',internal:true}]};
    await f.close(); const result=await f.apply(request);
    expect(result).toMatchObject({measuredG8:true,totalKeepConverted:'27',sweptInternalKeep:'7'});
    expect((await getMail(f.conn.db,f.a.wallet,mixed.message.id))).toMatchObject({rewardState:'pending',attachments:expect.arrayContaining([{kind:'KEEP',amount:'3',retired:true}])});
    expect((await getMail(f.conn.db,f.b.wallet,only.message.id)).rewardState).toBe('claimed');
    const later=new Date(new Date(mixed.message.expiresAt!).getTime()+1000);
    expect((await expireDueMailRewards(f.conn.db,later)).expired).toBe(0);
    const [base]=await f.conn.db.insert(bases).values({ownerWallet:f.a.wallet,status:'active'}).returning();
    const authority={prepare:async()=>{},assertLocked:async()=>{}};
    await expect(claimMailReward(f.conn.db,f.a.wallet,mixed.message.id,undefined,authority,later)).rejects.toMatchObject({code:'BASE_ID_REQUIRED'});
    const denied={prepare:async()=>{throw new Error('CURRENT_DEED_REQUIRED');},assertLocked:async()=>{throw new Error('CURRENT_DEED_REQUIRED');}};
    await expect(claimMailReward(f.conn.db,f.a.wallet,mixed.message.id,base!.id,denied,later)).rejects.toThrow('CURRENT_DEED_REQUIRED');
    const claims=await Promise.all([1,2].map(()=>claimMailReward(f.conn.db,f.a.wallet,mixed.message.id,base!.id,authority,later)));
    expect(claims.every(m=>m.rewardState==='claimed')).toBe(true);
    expect((await f.conn.db.select().from(baseItems).where(eq(baseItems.baseId,base!.id)))[0]!.qty).toBe(2);
    expect((await f.conn.sql`select balance::text from accounts where kind='base_shards' and base_id=${base!.id}`)[0]!.balance).toBe('4');
    expect(await f.apply(request)).toEqual(result);
    expect(JSON.stringify(await f.conn.sql`select * from mail_attachments order by id`)).toBe(originals);
    await expect(f.conn.sql`update mail_attachments set amount=1 where message_id=${mixed.message.id} and kind='KEEP'`).rejects.toThrow('MAIL_RETIREMENT_IMMUTABLE');
    await expect(f.conn.sql`update mail_messages set recipient_wallet=${f.b.wallet} where id=${mixed.message.id}`).rejects.toThrow('MAIL_RETIREMENT_IMMUTABLE');
    await expect(f.conn.sql`delete from mail_keep_retirements`).rejects.toThrow('MAIL_RETIREMENT_IMMUTABLE');
  }),30_000);
  it('refuses lazy-expired pending KEEP mail without reviving expired welcome or partially posting', async () => fixture(async f => {
    const sys=await bootstrapSystemAccounts(f.conn.db), now=new Date(f.request.asOf);
    await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.mail-fund',entries:[{account:sys.keep_genesis,delta:-10n},{account:sys.emission_pool,delta:10n}]});
    process.env['MAIL_DELIVERY_ENABLED']='true';
    let sent;
    try { sent=await deliverSystemMail(f.conn.db,{recipientWallet:f.a.wallet,deliveryKey:'welcome:expired',subject:'Welcome',body:'Welcome',attachments:[{kind:'KEEP',amount:3n}]},now); }
    finally { delete process.env['MAIL_DELIVERY_ENABLED']; }
    await f.close(); const before=await f.snapshot();
    await expect(f.apply({...f.request,asOf:new Date(sent.message.expiresAt!).toISOString(),mails:[{messageId:sent.message.id,wallet:f.a.wallet,keep:'3',internal:false}]})).rejects.toThrow('CUSTODY_UNSUPPORTED_STATE');
    expect(await f.snapshot()).toBe(before);
  }),30_000);

  it('keeps ordinary runtime mail available without private-table grants and skips paused mail before the expiry limit', async () => fixture(async f => {
    const role=`mail_runtime_${randomUUID().replaceAll('-','')}`, now=new Date(f.request.asOf);
    await f.admin.unsafe(`create role ${role}`);
    const runtime = <T>(run:(db:Db)=>Promise<T>)=>f.conn.db.transaction(async tx=>{
      await tx.execute(sql.raw(`set local role ${role}`)); return run(tx as unknown as Db);
    });
    const oldDelivery=process.env['MAIL_DELIVERY_ENABLED']; process.env['MAIL_DELIVERY_ENABLED']='true';
    try {
      await f.conn.sql.unsafe(`grant usage on schema public to ${role}; grant all on all tables in schema public to ${role}; grant usage,select on all sequences in schema public to ${role}; revoke all on keep_custody_journal,mail_keep_retirements from ${role}`);
      const [base]=await f.conn.db.insert(bases).values({ownerWallet:f.a.wallet,status:'active'}).returning();
      const authority={prepare:async()=>{},assertLocked:async()=>{}};
      const ordinary=await runtime(db=>deliverSystemMail(db,{recipientWallet:f.a.wallet,deliveryKey:'runtime',subject:'Runtime',body:'Ordinary reward',attachments:[{kind:'SHARDS',amount:2n}]},now));
      await runtime(db=>markMailRead(db,f.a.wallet,ordinary.message.id,now));
      expect((await runtime(db=>claimMailReward(db,f.a.wallet,ordinary.message.id,base!.id,authority,now))).rewardState).toBe('claimed');
      const sys=await bootstrapSystemAccounts(f.conn.db);
      await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.mail-fund',entries:[{account:sys.keep_genesis,delta:-3n},{account:sys.emission_pool,delta:3n}]});
      const mixed=await runtime(db=>deliverSystemMail(db,{recipientWallet:f.a.wallet,deliveryKey:'paused',subject:'Paused',body:'Mixed reward',attachments:[{kind:'KEEP',amount:3n},{kind:'SHARDS',amount:4n}]},now));
      const due=await runtime(db=>deliverSystemMail(db,{recipientWallet:f.a.wallet,deliveryKey:'due',subject:'Due',body:'Ordinary expiry',attachments:[{kind:'SHARDS',amount:1n}]},new Date(now.getTime()+1000)));
      await f.close(); const request={...f.request,mails:[{messageId:mixed.message.id,wallet:f.a.wallet,keep:'3',internal:false}]};
      await f.conn.sql.unsafe(`grant all on mail_keep_retirements to ${role}`);
      await expect(runtime(db=>db.execute(sql`insert into mail_keep_retirements(attachment_id,message_id,recipient_wallet,amount,original_expires_at,ledger_txn_id,journal_id,receipt)
        select a.id,m.id,m.recipient_wallet,a.amount,m.expires_at,m.reserve_ledger_txn_id,${f.request.fixtureId}::uuid,'{}'::jsonb
        from mail_attachments a join mail_messages m on m.id=a.message_id where m.id=${mixed.message.id}::uuid and a.kind='KEEP'`))).rejects.toMatchObject({cause:{message:'MAIL_RETIREMENT_OWNER_REQUIRED'}});
      await f.conn.sql.unsafe(`revoke all on mail_keep_retirements from ${role}`);
      await f.apply(request);
      expect((await runtime(db=>getMail(db,f.a.wallet,mixed.message.id))).attachments).toContainEqual({kind:'KEEP',amount:'3',retired:true});
      const later=new Date(new Date(due.message.expiresAt!).getTime()+1000);
      expect(await runtime(db=>expireDueMailRewards(db,later,1))).toEqual({scanned:1,expired:1});
      expect((await runtime(db=>getMail(db,f.a.wallet,mixed.message.id))).rewardState).toBe('pending');
      expect((await runtime(db=>claimMailReward(db,f.a.wallet,mixed.message.id,base!.id,authority,later))).rewardState).toBe('claimed');
      expect((await f.conn.sql`select balance::text from accounts where kind='base_shards' and base_id=${base!.id}`)[0]!.balance).toBe('6');
    } finally {
      if(oldDelivery===undefined) delete process.env['MAIL_DELIVERY_ENABLED']; else process.env['MAIL_DELIVERY_ENABLED']=oldDelivery;
      await f.conn.sql.unsafe(`drop owned by ${role}`); await f.admin.unsafe(`drop role ${role}`);
    }
  }),30_000);

  it.each(['amount','recipient','reason','request'] as const)('rejects self-consistent but noncanonical mail %s evidence atomically', async defect=>fixture(async f=>{
    const sys=await bootstrapSystemAccounts(f.conn.db), now=new Date(f.request.asOf);
    await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.mail-fund',entries:[{account:sys.keep_genesis,delta:-3n},{account:sys.emission_pool,delta:3n}]});
    const oldDelivery=process.env['MAIL_DELIVERY_ENABLED']; process.env['MAIL_DELIVERY_ENABLED']='true';
    let sent;
    try { sent=await deliverSystemMail(f.conn.db,{recipientWallet:f.a.wallet,deliveryKey:'forged',subject:'Forged',body:'Evidence must match payment',attachments:[{kind:'KEEP',amount:3n},{kind:'SHARDS',amount:1n}]},now); }
    finally { if(oldDelivery===undefined) delete process.env['MAIL_DELIVERY_ENABLED']; else process.env['MAIL_DELIVERY_ENABLED']=oldDelivery; }
    await f.close(); const before=await f.snapshot();
    await expect(f.conn.db.transaction(async tx=>{
      await tx.execute(sql`set local time zone 'UTC'`);
      const target=await getOrCreatePlayerAccount(tx,defect==='recipient'?f.b.wallet:f.a.wallet,'player_gems'), amount=defect==='amount'?2n:3n;
      const posted=await postTransaction(tx,{idempotencyKey:`mail:retire:${sent.message.id}`,type:'gems.retirement',
        metadata:{wallet:f.a.wallet,class:'L4',keep:'3',gems:'3',reason:defect==='reason'?'other':'retirement',fixtureId:f.request.fixtureId,messageId:sent.message.id},
        entries:[{account:sys.mail_keep_escrow,delta:-amount},{account:sys.emission_pool,delta:amount},{account:sys.gems_mint,delta:-amount},{account:target.id,delta:amount}]});
      const receipts=await tx.execute(sql`select jsonb_build_object('id',t.id,'type',t.type,'idempotencyKey',t.idempotency_key,'metadata',t.metadata,'createdAt',t.created_at,'entries',
        (select jsonb_agg(jsonb_build_object('id',e.id::text,'account',a.id,'kind',a.kind,'currency',a.currency,'wallet',a.owner_wallet,'baseId',a.base_id,'delta',e.delta::text,'balanceAfter',e.balance_after::text) order by e.id)
        from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=t.id)) receipt from ledger_transactions t where t.id=${posted.transaction.id}::uuid`);
      const receipt=(receipts as unknown as {receipt:unknown}[])[0]!.receipt;
      const request={...f.request,mails:defect==='request'?[]:[{messageId:sent.message.id,wallet:f.a.wallet,keep:'3',internal:false}]};
      await tx.execute(sql`insert into keep_custody_journal(id,operation,scope,subcommand,dry_run,input_hash,operator_name,database_name,request,receipts,before_state,after_state)
        values(${f.request.fixtureId},'fixture:l1-mail-retirement','fixture','retire-l1-mail',false,${'0'.repeat(64)},current_user,current_database(),${JSON.stringify(request)}::jsonb,${JSON.stringify([receipt])}::jsonb,'{}','{}')`);
      await tx.execute(sql`insert into mail_keep_retirements(attachment_id,message_id,recipient_wallet,amount,original_expires_at,ledger_txn_id,journal_id,receipt)
        select a.id,m.id,m.recipient_wallet,a.amount,m.expires_at,${posted.transaction.id}::uuid,${f.request.fixtureId}::uuid,${JSON.stringify(receipt)}::jsonb
        from mail_attachments a join mail_messages m on m.id=a.message_id where m.id=${sent.message.id}::uuid and a.kind='KEEP'`);
    })).rejects.toThrow();
    expect(await f.snapshot()).toBe(before);
    expect((await f.conn.sql`select count(*)::int n from mail_keep_retirements`)[0]!.n).toBe(0);
  }),30_000);
  it('retires settled Forge to its current observed owner, preserves settlement facts and recovers after spend and deed transfer', async () => fixture(async f => {
    const forge=await seedForge(f), sys=await bootstrapSystemAccounts(f.conn.db);
    await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.mail-fund',entries:[{account:sys.keep_genesis,delta:-3n},{account:sys.emission_pool,delta:3n}]});
    process.env['MAIL_DELIVERY_ENABLED']='true';
    let mail;
    try { mail=await deliverSystemMail(f.conn.db,{recipientWallet:f.a.wallet,deliveryKey:'forge-combined',subject:'Combined',body:'Combined',attachments:[{kind:'KEEP',amount:3n}]},new Date(f.request.asOf)); }
    finally { delete process.env['MAIL_DELIVERY_ENABLED']; }
    const request={...f.request,forge:[forge.row],mails:[{messageId:mail.message.id,wallet:f.a.wallet,keep:'3',internal:false}]};
    const items=JSON.stringify(await f.conn.sql`select * from base_items order by id`);
    await f.close(); const first=await f.apply(request);
    expect(first).toMatchObject({measuredG8:true,totalKeepConverted:'30',sweptInternalKeep:'5'});
    expect((await getMail(f.conn.db,f.a.wallet,mail.message.id)).rewardState).toBe('claimed');
    const rows=await f.conn.sql`select a.kind,a.currency,a.owner_wallet,e.delta::text,t.metadata from ledger_transactions t
      join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id where t.idempotency_key=${`forge:base:${forge.row.day}:${forge.row.baseId}:claim`} order by a.kind::text`;
    expect(rows.map(r=>[r.kind,r.currency,r.owner_wallet,r.delta])).toEqual([
      ['emission_pool','KEEP',null,'9'],['forge_payout_escrow','KEEP',null,'-9'],['gems_mint','GEMS',null,'-9'],['player_gems','GEMS',f.b.wallet,'9']]);
    expect(rows.every(r=>r.metadata.class==='L2' && r.metadata.positionId===forge.row.positionId && r.metadata.reason==='retirement')).toBe(true);
    const [claimed]=await f.conn.db.select().from(baseForgePositions).where(eq(baseForgePositions.id,forge.position.id));
    expect(claimed).toMatchObject({...forge.position,claimedAt:new Date(f.request.asOf),claimTxnId:expect.any(String),updatedAt:new Date(f.request.asOf)});
    await spendGems(f.conn.db,f.b.wallet,4n,'test.spend',randomUUID());
    // The observer cache refreshes in place; historical retirement authority
    // lives in the immutable journal, not the latest cache slot or owner.
    await f.conn.db.update(deedOwnershipObservations).set({slot:101n,
      checkedAt:new Date(Date.parse(f.request.asOf)+1000),auditHash:'refreshed'})
      .where(eq(deedOwnershipObservations.baseId,forge.base.id));
    expect(await f.apply(request)).toEqual(first);
    await f.conn.db.update(bases).set({ownerWallet:f.a.wallet}).where(eq(bases.id,forge.base.id));
    await f.conn.db.update(deedOwnershipObservations).set({owner:f.a.wallet,slot:102n,
      checkedAt:new Date(Date.parse(f.request.asOf)+2000),auditHash:'transferred'})
      .where(eq(deedOwnershipObservations.baseId,forge.base.id));
    expect(await f.apply(request)).toEqual(first);
    expect(JSON.stringify(await f.conn.sql`select * from base_items order by id`)).toBe(items);
  }),30_000);
  it('sweeps internal Forge without minting Gems', async () => fixture(async f => {
    const forge=await seedForge(f,true); await f.close();
    const result=await f.apply({...f.request,forge:[forge.row]});
    expect(result).toMatchObject({totalKeepConverted:'18',sweptInternalKeep:'14',measuredG8:true});
    expect((await f.conn.sql`select count(*)::int n from ledger_entries e join ledger_transactions t on t.id=e.txn_id where t.idempotency_key=${`forge:base:${forge.row.day}:${forge.row.baseId}:claim`}`)[0]!.n).toBe(2);
  }),30_000);
  it.each(['stale','mismatch','asset','unknown-slot','lapsed','wrong-roster','open','legacy','orphan','settlement-receipt'] as const)('refuses %s Forge without any partial retirement', async reason => fixture(async f => {
    const forge=await seedForge(f);
    if(reason==='stale') await f.conn.sql`update deed_ownership_observations set checked_at=${new Date(Date.parse(f.request.asOf)-BASE_OWNERSHIP.mutationFreshnessMs-1).toISOString()}`;
    if(reason==='mismatch') await f.conn.sql`update deed_ownership_observations set owner=${f.a.wallet}`;
    if(reason==='asset') await f.conn.sql`update deed_ownership_observations set asset_id=${f.internal.wallet}`;
    if(reason==='unknown-slot') await f.conn.sql`update deed_ownership_observations set slot=null`;
    if(reason==='lapsed') await f.conn.sql`update base_forge_positions set settled_at=${new Date(Date.parse(f.request.asOf)-FORGE.claimWindowDays*86400000).toISOString()}`;
    if(reason==='settlement-receipt') await f.conn.sql`update ledger_transactions set metadata='{}'::jsonb where id=${forge.position.keepEscrowTxnId}`;
    if(reason==='open') await f.conn.db.insert(baseForgePositions).values({baseId:forge.base.id,day:'2034-12-30'});
    if(reason==='legacy') await f.conn.sql`insert into forge_contributions(player_wallet,day,shards) values(${f.a.wallet},'2034-12-30',1)`;
    if(reason==='orphan') { const sys=await bootstrapSystemAccounts(f.conn.db); await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'test.orphan',entries:[{account:sys.keep_genesis,delta:-1n},{account:sys.forge_payout_escrow,delta:1n}]}); }
    await f.close(); const before=await f.snapshot(), positions=JSON.stringify(await f.conn.sql`select * from base_forge_positions order by id`);
    await expect(f.apply({...f.request,forge:[{...forge.row,...(reason==='wrong-roster'?{day:'2034-12-30'}:{})}]})).rejects.toThrow();
    expect(await f.snapshot()).toBe(before); expect(JSON.stringify(await f.conn.sql`select * from base_forge_positions order by id`)).toBe(positions);
  }),30_000);
  it.each(['duplicate','journal','freeze'] as const)('rolls Forge markers and all payouts back on %s failure', async stage => fixture(async f => {
    const forge=await seedForge(f);
    if(stage==='duplicate') { const sys=await bootstrapSystemAccounts(f.conn.db); await postTransaction(f.conn.db,{idempotencyKey:`forge:base:${forge.row.day}:${forge.row.baseId}:claim`,type:'test.conflict',entries:[{account:sys.keep_genesis,delta:-1n},{account:sys.emission_pool,delta:1n}]}); }
    await f.close();
    if(stage!=='duplicate') { await f.conn.sql.unsafe("create function fixture_abort_forge() returns trigger language plpgsql as $$ begin raise exception 'FIXTURE_FINAL_FAILED'; end $$");
      await f.conn.sql.unsafe(stage==='journal'?'create trigger fixture_abort_forge before insert on keep_custody_journal for each row execute function fixture_abort_forge()':'create trigger fixture_abort_forge before update on keep_custody_cutover_state for each row execute function fixture_abort_forge()'); }
    const before=await f.snapshot(), positions=JSON.stringify(await f.conn.sql`select * from base_forge_positions order by id`);
    await expect(f.apply({...f.request,forge:[forge.row]})).rejects.toThrow();
    expect(await f.snapshot()).toBe(before); expect(JSON.stringify(await f.conn.sql`select * from base_forge_positions order by id`)).toBe(positions);
  }),30_000);

});
