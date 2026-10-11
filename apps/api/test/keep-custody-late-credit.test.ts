/** Injected finalized evidence rehearses the frozen late-credit boundary only. */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { keepAta } from '@shardkeep/chain';
import { GEMS, TOKEN } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbTx } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { applyFixtureL1Retirement } from '../src/db/keepCustodyJournal';
import { applyFixtureKeepLateCredit, type FixtureKeepLateCreditRequest } from '../src/db/keepCustodyLateCredit';
import { bootstrapSystemAccounts, postTransaction } from '../src/ledger';
import { spendGems } from '../src/game/spend';
import { createTestPlayer, fundTestKeep } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, zeroL1 = false) {
  const f = await setup(zeroL1);
  try { await run(f); } finally {
    await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.database} with (force)`); await f.admin.end();
  }
}
async function setup(zeroL1 = false) {
  const database = `shardkeep_custody_apply_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('unsafe fixture host');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  await createMigratedDatabase(admin, database);
  const conn = createDb(url.toString(), { max: 5 }); await runMigrations(conn.db);
  const player = await createTestPlayer(conn.db), sys = await bootstrapSystemAccounts(conn.db);
  if (!zeroL1) await fundTestKeep(conn.db, player.wallet, 11n, 'test.fund', randomUUID());
  const depositId = randomUUID(), retirementJournalId = randomUUID();
  const reference = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
  const destination = keepAta(owner, mint).toBase58(), signature = bs58.encode(randomBytes(64));
  const units = 5n * 10n ** BigInt(TOKEN.decimals) + 7n;
  await conn.sql`insert into deposits(id,player_wallet,kind,reference,status,created_at,payload)
    values(${depositId},${player.wallet},'keep_deposit',${reference},'expired','2034-12-31T23:57:00Z','{"original":"preserved"}'::jsonb)`;
  const original = (await conn.sql`select to_jsonb(d) row from deposits d where id=${depositId}`)[0]!.row;
  const env = { HOLD_BEFORE_MIGRATE: '1', TEST_DATABASE_URL: url.toString() };
  await conn.sql`select shardkeep_advance_keep_custody_phase('open','fenced')`;
  await conn.sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`;
  const retirement = await applyFixtureL1Retirement({ fixtureId: retirementJournalId, asOf: '2035-01-01T00:00:00.000Z',
    players: zeroL1 ? [] : [{ wallet: player.wallet, keep: '11', internal: false }] }, env);
  const request: FixtureKeepLateCreditRequest = { fixtureId: randomUUID(), retirementJournalId, depositId, proof: {
    signature, mint: mint.toBase58(), custodyOwner: owner.toBase58(), destination,
    broadcastObservedAt: '2034-12-31T23:58:00.000Z', withdrawalsClosedAt: '2034-12-31T23:59:00.000Z',
    finalizedObservedAt: '2035-01-01T00:01:00.000Z',
    transaction: { slot: 123, blockTime: Date.parse('2034-12-31T23:58:00Z') / 1000,
      transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 1 },
        accountKeys: [player.wallet, destination, reference] } },
      meta: { err: null, preTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), uiTokenAmount: { amount: '100', decimals: TOKEN.decimals } }],
        postTokenBalances: [{ accountIndex: 1, mint: mint.toBase58(), uiTokenAmount: { amount: (units + 100n).toString(), decimals: TOKEN.decimals } }] } },
  } };
  const apply = (r = request) => applyFixtureKeepLateCredit(r, env);
  const snapshot = async () => JSON.stringify(await conn.sql`select
    (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
    (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,
    (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries,
    (select jsonb_agg(to_jsonb(d) order by id) from deposits d) deposits,
    (select jsonb_agg(to_jsonb(j) order by id) from keep_custody_journal j) retirement,
    (select jsonb_agg(to_jsonb(a) order by id) from keep_custody_late_authorizations a) authorizations,
    (select jsonb_agg(to_jsonb(j) order by id) from keep_custody_late_journal j) late_journal`);
  return { database, admin, conn, player, sys, request, env, original, units, retirement, apply, snapshot };
}

async function prepare(tx:DbTx,f:Awaited<ReturnType<typeof setup>>) {
  await tx.execute(sql`select set_config('shardkeep.deed_economy_writer','v1',true),set_config('shardkeep.keep_custody_cutover','late-credit',true)`);
  const [row]=await tx.execute<{plan:{postings:Array<{key:string;type:string;metadata:Record<string,unknown>;entries:Array<{account:string;delta:string}>}>}}>(sql`
    select prepare_fixture_keep_late_credit(${JSON.stringify(f.request)}::jsonb,${'a'.repeat(64)},5,${f.units}::bigint) plan`);
  return row!.plan.postings;
}

describe('fixture-only KEEP deposits finalized after custody freeze', () => {
  it('preserves completed money and immutable evidence on migration replay',async()=>fixture(async f=>{
    const result=await f.apply(),before=await f.snapshot();
    const migration=readFileSync(new URL('../drizzle/0158_custody_late_credit.sql',import.meta.url),'utf8');
    await f.conn.db.transaction(async tx=>{
      for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))
        await tx.execute(sql.raw(statement));
    });
    expect(await f.snapshot()).toBe(before); expect(await f.apply()).toEqual(result);
  }),30_000);
  it('preserves base units beyond JavaScript integer precision in the original result', async () => fixture(async f => {
    const request=structuredClone(f.request), units=BigInt(Number.MAX_SAFE_INTEGER)+100n;
    const meta=request.proof.transaction.meta as {postTokenBalances:Array<{uiTokenAmount:{amount:string}}>};
    meta.postTokenBalances[0]!.uiTokenAmount.amount=(units+100n).toString();
    const result=await f.apply(request);
    expect(result.keep).toBe((units/(10n**BigInt(TOKEN.decimals))).toString());
    expect(result.sourceAfter.amount).toBe(units.toString());
    expect((await f.conn.sql`select amount::text amount from deposits where id=${request.depositId}`)[0]!.amount).toBe(units.toString());
    expect(await f.apply(request)).toEqual(result);
  }),30_000);

  it.each(['unsealed','extra-entry','cache-only','source-only','missing-mode','missing-writer'] as const)
    ('rejects %s within an otherwise authorized fixture transaction',async kind=>fixture(async f=>{
      const before=await f.snapshot();
      await expect(f.conn.db.transaction(async tx=>{
        const [posting]=await prepare(tx,f);
        if(kind==='unsealed') return;
        if(kind==='cache-only') { await tx.execute(sql`update accounts set balance=5 where kind='player_keep' and owner_wallet=${f.player.wallet}`); return; }
        if(kind==='source-only') { await tx.execute(sql`update deposits set amount=1 where id=${f.request.depositId}::uuid`); return; }
        if(kind==='missing-mode') await tx.execute(sql`select set_config('shardkeep.keep_custody_cutover','',true)`);
        if(kind==='missing-writer') await tx.execute(sql`select set_config('shardkeep.deed_economy_writer','',true)`);
        const paid=await postTransaction(tx,{idempotencyKey:posting!.key,type:posting!.type,metadata:posting!.metadata,
          entries:posting!.entries.map(e=>({account:e.account,delta:BigInt(e.delta)}))});
        if(kind==='extra-entry') await tx.execute(sql`insert into ledger_entries(txn_id,account_id,delta,balance_after)
          values(${paid.transaction.id}::uuid,${posting!.entries[1]!.account}::uuid,1,6)`);
      })).rejects.toThrow();
      expect(await f.snapshot()).toBe(before);
    }),30_000);

  it('seals immediately even after SET CONSTRAINTS IMMEDIATE and rolls back an appended Gems leg',async()=>fixture(async f=>{
    const before=await f.snapshot();
    await expect(f.conn.db.transaction(async tx=>{
      const result=await applyFixtureKeepLateCredit(f.request,f.env,()=>({db:tx as unknown as Db,close:async()=>{}}));
      await tx.execute(sql`set constraints all immediate`);
      const receipt=result.receipts[1] as {id:string;entries:Array<{account:string;kind:string;delta:string;balanceAfter:string}>};
      const leg=receipt.entries.find(e=>e.kind==='gems_mint')!;
      await tx.execute(sql`insert into ledger_entries(txn_id,account_id,delta,balance_after)
        values(${receipt.id}::uuid,${leg.account}::uuid,${leg.delta}::bigint,${leg.balanceAfter}::bigint)`);
    })).rejects.toThrow();
    expect(await f.snapshot()).toBe(before);
  }),30_000);

  it('denies private receipt reads and owner impersonation by a broadly granted runtime role',async()=>fixture(async f=>{
    const role=`custody_late_${randomUUID().replaceAll('-','')}`;
    await f.conn.sql.unsafe(`create role ${role} nologin`);
    try {
      const before=await f.snapshot();
      await expect(f.conn.db.transaction(async tx=>{
        await tx.execute(sql.raw(`set local role ${role}`));
        await tx.execute(sql`select shardkeep_fixture_late_receipt(${randomUUID()}::uuid)`);
      })).rejects.toThrow();
      await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}`);
      await f.conn.sql.unsafe(`grant execute on all functions in schema public to ${role}`);
      await expect(f.conn.db.transaction(async tx=>{
        await tx.execute(sql.raw(`set local role ${role}`));
        await prepare(tx,f);
      })).rejects.toThrow();
      expect(await f.snapshot()).toBe(before);
    } finally { await f.conn.sql.unsafe(`drop owned by ${role}`); await f.conn.sql.unsafe(`drop role ${role}`); }
  }),30_000);

  it('refuses recovery if the custody latch singleton disappears',async()=>fixture(async f=>{
    await f.apply();
    // Malformed disposable fixture only: prove NULL cannot authorize replay.
    await f.conn.sql`alter table keep_custody_cutover_state disable trigger keep_custody_state_forward_only`;
    await f.conn.sql`delete from keep_custody_cutover_state`;
    await f.conn.sql`alter table keep_custody_cutover_state enable trigger keep_custody_state_forward_only`;
    const before=await f.snapshot(); await expect(f.apply()).rejects.toMatchObject({cause:{message:'CUSTODY_LATE_REPLAY_INVALID'}});
    expect(await f.snapshot()).toBe(before);
  }),30_000);
  it('credits a captured recipient with no L1 conversion or pre-existing Gems account', async () => fixture(async f => {
    expect(await f.conn.sql`select id from accounts where kind='player_gems' and owner_wallet=${f.player.wallet}`).toHaveLength(0);
    const first = await f.apply();
    expect((await f.conn.sql`select balance::text from accounts where kind='player_gems' and owner_wallet=${f.player.wallet}`)[0]!.balance)
      .toBe(String(5n * BigInt(GEMS.gemsPerKeep)));
    const after = await f.snapshot(); expect(await f.apply()).toEqual(first); expect(await f.snapshot()).toBe(after);
  }, true), 30_000);
  it('posts the exact ingress/conversion once, preserves dust and G8, and recovers after Gems spending', async () => fixture(async f => {
    const outcomes = await Promise.allSettled([f.apply(), f.apply()]);
    expect(outcomes.some(r => r.status === 'fulfilled'),outcomes.map(r=>r.status==='rejected'?String(r.reason.cause??r.reason):'ok').join('\n')).toBe(true);
    const result = await f.apply();
    for (const outcome of outcomes) if (outcome.status === 'fulfilled') expect(outcome.value).toEqual(result);
    expect(result).toMatchObject({ fixtureOnly: true, retirementAuthorized: false });
    const rows = await f.conn.sql`select t.id,t.idempotency_key,t.type,t.metadata,a.kind,a.currency,a.owner_wallet,e.delta::text
      from ledger_transactions t join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id
      where t.idempotency_key in (${'deposit:' + f.request.depositId + ':credit'},${'late-credit:deposit:' + f.request.depositId + ':convert'}) order by t.type,a.kind::text`;
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(r => r.id)).size).toBe(2);
    expect(rows.map(r => [r.type, r.kind, r.currency, r.owner_wallet, r.delta])).toEqual([
      ['deposit.keep', 'onchain_inflow', 'KEEP', null, '-5'], ['deposit.keep', 'player_keep', 'KEEP', f.player.wallet, '5'],
      ['gems.late_credit', 'emission_pool', 'KEEP', null, '5'], ['gems.late_credit', 'gems_mint', 'GEMS', null, String(-5n * BigInt(GEMS.gemsPerKeep))],
      ['gems.late_credit', 'player_gems', 'GEMS', f.player.wallet, String(5n * BigInt(GEMS.gemsPerKeep))], ['gems.late_credit', 'player_keep', 'KEEP', f.player.wallet, '-5'],
    ]);
    expect(rows.filter(r => r.type === 'gems.late_credit').every(r => r.metadata.reason === 'keep_conversion')).toBe(true);
    const [deposit] = await f.conn.sql`select to_jsonb(d)||jsonb_build_object('amount',d.amount::text) row from deposits d where id=${f.request.depositId}`;
    expect(deposit!.row).toEqual({ ...f.original, status: 'credited', tx_signature: f.request.proof.signature,
      amount: f.units.toString(), mint: f.request.proof.mint, finalized_at: '2035-01-01T00:01:00+00:00', ledger_txn_id: rows[0]!.id });
    expect((await f.conn.sql`select balance::text from accounts where kind='player_keep' and owner_wallet=${f.player.wallet}`)[0]!.balance).toBe('0');
    expect((await f.conn.sql`select coalesce(-sum(e.delta),0)::text n from ledger_entries e join accounts a on a.id=e.account_id join ledger_transactions t on t.id=e.txn_id where a.kind='gems_mint' and t.metadata->>'reason'='retirement'`)[0]!.n)
      .toBe(String(11n * BigInt(GEMS.gemsPerKeep)));
    await spendGems(f.conn.db, f.player.wallet, 3n, 'test.spend', randomUUID());
    const after = await f.snapshot(); expect(await f.apply()).toEqual(result); expect(await f.snapshot()).toBe(after);
  }), 30_000);

  it.each(['signature', 'signer', 'destination', 'mint', 'reference', 'failed', 'zero', 'dust-only', 'before-created', 'broadcast-at-W', 'W-after-F', 'finalized-at-F'] as const)
    ('refuses %s proof without writes', async kind => fixture(async f => {
      const r = structuredClone(f.request), tx = r.proof.transaction as any;
      if (kind === 'signature') r.proof.signature = 'bad';
      if (kind === 'signer') tx.transaction.message.accountKeys[0] = Keypair.generate().publicKey.toBase58();
      if (kind === 'destination') r.proof.destination = Keypair.generate().publicKey.toBase58();
      if (kind === 'mint') r.proof.mint = Keypair.generate().publicKey.toBase58();
      if (kind === 'reference') tx.transaction.message.accountKeys[2] = Keypair.generate().publicKey.toBase58();
      if (kind === 'failed') tx.meta.err = { InstructionError: [0, 'Custom'] };
      if (kind === 'zero') tx.meta.postTokenBalances[0].uiTokenAmount.amount = '100';
      if (kind === 'dust-only') tx.meta.postTokenBalances[0].uiTokenAmount.amount = '101';
      if (kind === 'before-created') r.proof.broadcastObservedAt = '2034-12-31T23:56:00.000Z';
      if (kind === 'broadcast-at-W') r.proof.broadcastObservedAt = r.proof.withdrawalsClosedAt;
      if (kind === 'W-after-F') r.proof.withdrawalsClosedAt = '2035-01-01T00:00:01.000Z';
      if (kind === 'finalized-at-F') r.proof.finalizedObservedAt = '2035-01-01T00:00:00.000Z';
      const before = await f.snapshot(); await expect(f.apply(r)).rejects.toThrow(); expect(await f.snapshot()).toBe(before);
    }), 30_000);

  it('refuses absent/changed original sources, request conflicts and signature collisions', async () => fixture(async f => {
    const before = await f.snapshot();
    await expect(f.apply({ ...f.request, depositId: randomUUID() })).rejects.toThrow(); expect(await f.snapshot()).toBe(before);
    await expect(f.conn.sql`update deposits set payload='{"tampered":true}'::jsonb where id=${f.request.depositId}`).rejects.toThrow('KEEP_CUSTODY_FROZEN');
    expect(await f.snapshot()).toBe(before);
    await f.conn.sql`insert into deposits(player_wallet,kind,reference,status,payment_signature) values(${f.player.wallet},'entry',${Keypair.generate().publicKey.toBase58()},'expired',${f.request.proof.signature})`;
    const collision = await f.snapshot(); await expect(f.apply()).rejects.toThrow(); expect(await f.snapshot()).toBe(collision);
  }), 30_000);

  it('rolls ingress and authorization back when conversion fails, then permits the exact retry', async () => fixture(async f => {
    await f.conn.sql`create function fixture_fail_conversion() returns trigger language plpgsql as $$ begin if NEW.type='gems.late_credit' then raise exception 'fixture-conversion-failure'; end if; return NEW; end $$`;
    await f.conn.sql`create trigger fixture_fail_conversion before insert on ledger_transactions for each row execute function fixture_fail_conversion()`;
    const before = await f.snapshot(); await expect(f.apply()).rejects.toThrow(); expect(await f.snapshot()).toBe(before);
    await f.conn.sql`drop trigger fixture_fail_conversion on ledger_transactions`;
    const result = await f.apply(); const after = await f.snapshot();
    await expect(f.apply({ ...f.request, fixtureId: randomUUID() })).rejects.toThrow();
    expect(await f.apply()).toEqual(result); expect(await f.snapshot()).toBe(after);
  }), 30_000);

  it('keeps frozen ordinary postings closed despite spoofed operation GUCs', async () => fixture(async f => {
    const before = await f.snapshot();
    await expect(f.conn.db.transaction(async tx => {
      await tx.execute((await import('drizzle-orm')).sql`select set_config('shardkeep.keep_custody_cutover','late-credit',true)`);
      const [account] = await f.conn.sql`select id from accounts where kind='player_keep' and owner_wallet=${f.player.wallet}`;
      await postTransaction(tx, { idempotencyKey: randomUUID(), type: 'deposit.keep', entries: [
        { account: f.sys.onchain_inflow, delta: -1n }, { account: account!.id, delta: 1n },
      ] });
    })).rejects.toThrow(); expect(await f.snapshot()).toBe(before);
  }), 30_000);
});
