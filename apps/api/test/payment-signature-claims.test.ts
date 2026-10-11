/** SQL fence prerequisite, not proof of a complete KEEP market settlement.
 * Raw deposit writes stand in for unchanged/rolling old API and worker binaries;
 * owner market claims exercise mutual exclusion before its receipt table exists. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TransactionSql } from 'postgres';
import { sql as expression } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb } from './helpers';
import { TEST_DATABASE_URL } from './db-url';

const conn = connectTestDb(), wallet = randomUUID();
type Client = typeof conn.sql | TransactionSql;
const migrations = ['0241_payment_signature_claims.sql', '0242_deposit_signature_claims.sql'].map(name =>
  readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8').split('--> statement-breakpoint').filter(statement => statement.trim()));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const rollback = new Error('rollback historical rehearsal');
beforeAll(async () => { await conn.sql`insert into players(wallet) values(${wallet})`; });
afterAll(async () => { await conn.sql.end(); });

async function deposit(client: Client = conn.sql, values: { id?: string; reference?: string; payment?: string; final?: string } = {}) {
  const id = values.id ?? randomUUID();
  await client`insert into deposits(id,player_wallet,kind,reference,payment_signature,tx_signature)
    values(${id},${wallet},'sol_topup',${values.reference ?? randomUUID()},${values.payment ?? null},${values.final ?? null})`;
  return id;
}
const claim = (client: Client, signature: string, id: string, kind = 'keep_equipment_market') =>
  client`select public.shardkeep_claim_payment_signature(${signature},${kind},${id}::uuid)`;
const claims = (signature: string) => conn.sql`select signature,consumer_kind,consumer_id,created_at from payment_signature_claims where signature=${signature}`;
async function migrate(client: Client, index: number) { for (const statement of migrations[index]!) await client.unsafe(statement); }
async function waiting(pid: number) {
  await vi.waitFor(async () => {
    expect((await conn.sql`select wait_event_type from pg_stat_activity where pid=${pid}`)[0]?.wait_event_type).toBe('Lock');
  });
}

it('null intent signatures do not claim; both actual columns claim once and exact-owner retries preserve creation evidence', async () => {
  const id = await deposit(), first = randomUUID(), final = randomUUID();
  expect(await conn.sql`select * from payment_signature_claims where consumer_id=${id}`).toHaveLength(0);
  await conn.sql`update deposits set payment_signature=${first},tx_signature=${final} where id=${id}`;
  const before = await conn.sql`select * from payment_signature_claims where consumer_id=${id} order by signature`;
  expect(before.map(row => row.signature).sort()).toEqual([first, final].sort());
  expect(before.every(row => row.consumer_kind === 'deposit')).toBe(true);
  await conn.sql`update deposits set payment_signature=${first},tx_signature=${final},status='expired' where id=${id}`;
  await claim(conn.sql, first, id, 'deposit');
  expect(await conn.sql`select * from payment_signature_claims where consumer_id=${id} order by signature`).toEqual(before);
});

it('inserting equal signatures deduplicates the owner and clearing or deleting the source cannot release the identity', async () => {
  const signature = 'pda:' + randomUUID(), id = await deposit(conn.sql, { payment: signature, final: signature });
  const before = await claims(signature); expect(before).toHaveLength(1);
  await conn.sql`update deposits set payment_signature=null,tx_signature=null where id=${id}`;
  await conn.sql`delete from deposits where id=${id}`;
  expect(await claims(signature)).toEqual(before);
  await expect(claim(conn.sql, signature, randomUUID())).rejects.toMatchObject({ code: '23505', message: 'PAYMENT_SIGNATURE_ALREADY_CLAIMED' });
});

it.each(['payment_signature', 'tx_signature'] as const)('a prior market claim rejects a legacy %s write and leaves its original deposit unchanged', async column => {
  const id = await deposit(), signature = randomUUID(), marketId = randomUUID();
  await claim(conn.sql, signature, marketId);
  await expect(conn.sql`update deposits set ${conn.sql(column)}=${signature},status='credited' where id=${id}`)
    .rejects.toMatchObject({ code: '23505', message: 'PAYMENT_SIGNATURE_ALREADY_CLAIMED' });
  expect(await conn.sql`select payment_signature,tx_signature,status from deposits where id=${id}`)
    .toEqual([{ payment_signature: null, tx_signature: null, status: 'pending' }]);
  expect((await claims(signature))[0]).toMatchObject({ consumer_kind: 'keep_equipment_market', consumer_id: marketId });
});

it.each(['payment', 'final'] as const)('a legacy %s deposit claim rejects market reuse and cross-column reuse by another deposit', async column => {
  const signature = randomUUID(), id = await deposit(conn.sql, { [column]: signature }), other = await deposit();
  await expect(claim(conn.sql, signature, randomUUID())).rejects.toMatchObject({ code: '23505' });
  const opposite = column === 'payment' ? 'tx_signature' : 'payment_signature';
  await expect(conn.sql`update deposits set ${conn.sql(opposite)}=${signature} where id=${other}`).rejects.toMatchObject({ code: '23505' });
  expect((await claims(signature))[0]?.consumer_id).toBe(id);
});

it('an ignored conflicting INSERT cannot reserve a signature for a consumer row that never existed', async () => {
  const reference = randomUUID(), original = await deposit(conn.sql, { reference }), phantom = randomUUID(), signature = randomUUID();
  await conn.sql`insert into deposits(id,player_wallet,kind,reference,payment_signature)
    values(${phantom},${wallet},'sol_topup',${reference},${signature}) on conflict(reference) do nothing`;
  expect(await claims(signature)).toHaveLength(0);
  expect(await conn.sql`select id from deposits where reference=${reference}`).toEqual([{ id: original }]);
});

it('all claim fields are immutable even for the owner, while exact no-op updates and same-market retries are harmless', async () => {
  const signature = randomUUID(), id = randomUUID(); await claim(conn.sql, signature, id);
  const before = await claims(signature); await claim(conn.sql, signature, id);
  await conn.sql`update payment_signature_claims set signature=signature where signature=${signature}`;
  expect(await claims(signature)).toEqual(before);
  for (const change of ["consumer_kind='deposit'", `consumer_id='${randomUUID()}'`, "signature=signature||'changed'", "created_at=created_at+interval '1 second'"]) {
    await expect(conn.sql.unsafe(`update payment_signature_claims set ${change} where signature=$1`, [signature]))
      .rejects.toMatchObject({ code: '23514', message: 'PAYMENT_SIGNATURE_IMMUTABLE' });
  }
  await expect(conn.sql`delete from payment_signature_claims where signature=${signature}`).rejects.toMatchObject({ code: '23514' });
  await expect(conn.sql`truncate payment_signature_claims`).rejects.toMatchObject({ code: '23514' });
  await expect(claim(conn.sql, randomUUID(), id, 'other_consumer')).rejects.toMatchObject({ code: '23514' });
  expect(await claims(signature)).toEqual(before);
});

it.each([
  ['deposit', 'payment_signature'], ['deposit', 'tx_signature'],
  ['market', 'payment_signature'], ['market', 'tx_signature'],
] as const)('a concurrent %s winner excludes the opposite consumer at the %s boundary', async (winner, column) => {
  const signature = randomUUID(), depositId = await deposit(), marketId = randomUUID(), entered = deferred(), release = deferred(), loserStarted = deferred();
  let loserPid = 0;
  const write = (client: Client, kind: 'deposit' | 'market') => kind === 'deposit'
    ? client`update deposits set ${client(column)}=${signature} where id=${depositId}` : claim(client, signature, marketId);
  const first = conn.sql.begin(async tx => { await write(tx, winner); entered.resolve(); await release.promise; });
  await entered.promise;
  const second = conn.sql.begin(async tx => {
    loserPid = Number((await tx`select pg_backend_pid() pid`)[0]!.pid); loserStarted.resolve();
    await write(tx, winner === 'deposit' ? 'market' : 'deposit');
  }).then(() => null, error => error as { code: string; message: string });
  try { await loserStarted.promise; await waiting(loserPid); } finally { release.resolve(); }
  await first; expect(await second).toMatchObject({ code: '23505', message: 'PAYMENT_SIGNATURE_ALREADY_CLAIMED' });
  expect((await claims(signature))[0]).toMatchObject({ consumer_kind: winner === 'deposit' ? 'deposit' : 'keep_equipment_market', consumer_id: winner === 'deposit' ? depositId : marketId });
});

it('opposite dual-column orders have one atomic winner without a claim-lock deadlock or partial losing claim', async () => {
  const a = await deposit(), b = await deposit(), first = randomUUID(), second = randomUUID();
  const results = await Promise.allSettled([
    conn.sql`update deposits set payment_signature=${first},tx_signature=${second} where id=${a}`,
    conn.sql`update deposits set payment_signature=${second},tx_signature=${first} where id=${b}`,
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: '23505' } });
  const rows = await conn.sql`select consumer_id from payment_signature_claims where signature in (${first},${second})`;
  expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.consumer_id)).size).toBe(1);
});

it('a conflicting claim rolls back the surrounding real Gems grant and a later failure rolls back a newly inserted claim', async () => {
  const id = await deposit(), signature = randomUUID(), marketId = randomUUID(), sys = await bootstrapSystemAccounts(conn.db);
  const account = await getOrCreatePlayerAccount(conn.db, wallet, 'player_gems'), grantKey = randomUUID();
  let grantPosted = false;
  await claim(conn.sql, signature, marketId);
  await expect(conn.db.transaction(async tx => {
    await postTransaction(tx, { idempotencyKey: grantKey, type: 'test.signature.grant', entries: [
      { account: sys.onchain_inflow, delta: -7n }, { account: sys.emission_pool, delta: 7n },
      { account: sys.gems_mint, delta: -7n }, { account: account.id, delta: 7n },
    ] });
    grantPosted = true;
    await tx.execute(expression`update deposits set tx_signature=${signature},status='credited' where id=${id}`);
  })).rejects.toMatchObject({ cause: { code: '23505', message: 'PAYMENT_SIGNATURE_ALREADY_CLAIMED' } });
  expect(grantPosted).toBe(true);
  expect(await conn.sql`select * from ledger_transactions where idempotency_key=${grantKey}`).toHaveLength(0);
  expect((await getOrCreatePlayerAccount(conn.db, wallet, 'player_gems')).balance).toBe(account.balance);
  expect((await claims(signature))[0]?.consumer_id).toBe(marketId);
  const released = randomUUID();
  await expect(conn.sql.begin(async tx => { await tx`update deposits set tx_signature=${released} where id=${id}`; throw rollback; })).rejects.toBe(rollback);
  expect(await claims(released)).toHaveLength(0); await claim(conn.sql, released, randomUUID());
});

it('historical backfill preserves legacy identifiers, deduplicates one consumer and safely replays both migrations', async () => {
  await expect(conn.sql.begin(async tx => {
    await tx`drop trigger deposits_payment_signature_claims on deposits`;
    const signature = 'pda:' + randomUUID(), extra = randomUUID();
    const id = await deposit(tx, { payment: signature, final: signature }), other = await deposit(tx, { final: extra });
    expect(await tx`select * from payment_signature_claims where consumer_id in (${id},${other})`).toHaveLength(0);
    await migrate(tx, 1);
    const before = await tx`select * from payment_signature_claims where consumer_id in (${id},${other}) order by signature`;
    expect(before).toHaveLength(2); expect(before.some(row => row.signature === signature && row.consumer_id === id)).toBe(true);
    await migrate(tx, 0); await migrate(tx, 1);
    expect(await tx`select * from payment_signature_claims where consumer_id in (${id},${other}) order by signature`).toEqual(before);
    throw rollback;
  })).rejects.toBe(rollback);
});

it('historical cross-owner column collisions fail explicitly and roll back the entire backfill', async () => {
  const signature = randomUUID(), clean = randomUUID();
  await expect(conn.sql.begin(async tx => {
    await tx`drop trigger deposits_payment_signature_claims on deposits`;
    await deposit(tx, { payment: clean }); await deposit(tx, { payment: signature }); await deposit(tx, { final: signature });
    await migrate(tx, 1);
  })).rejects.toMatchObject({ code: '23505', message: 'PAYMENT_SIGNATURE_HISTORICAL_CONFLICT' });
  expect(await claims(signature)).toHaveLength(0); expect(await claims(clean)).toHaveLength(0);
  expect((await conn.sql`select tgenabled from pg_trigger where tgrelid='public.deposits'::regclass and tgname='deposits_payment_signature_claims'`)[0]?.tgenabled).toBe('O');
});

it('the backfill transaction excludes live writes until its capture trigger is committed', async () => {
  const entered = deferred(), release = deferred(), started = deferred(), signature = randomUUID(); let pid = 0;
  const migration = conn.sql.begin(async tx => { await migrate(tx, 1); entered.resolve(); await release.promise; });
  await entered.promise;
  const writer = conn.sql.begin(async tx => { pid = Number((await tx`select pg_backend_pid() pid`)[0]!.pid); started.resolve(); return deposit(tx, { payment: signature }); });
  try { await started.promise; await waiting(pid); } finally { release.resolve(); }
  await migration; const id = await writer;
  expect((await claims(signature))[0]).toMatchObject({ consumer_kind: 'deposit', consumer_id: id });
});

it('an old restricted LOGIN can write deposits without private grants; broad grants still cannot forge claims or a trigger owner', async () => {
  const role = 'payment_old_' + randomUUID().replaceAll('-', ''), password = randomUUID(); let runtime: ReturnType<typeof createDb> | undefined;
  await conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    await conn.sql.unsafe(`grant usage on schema public to ${role}; grant select,insert,update,delete on deposits to ${role}; grant select on deed_economy_cutover_state to ${role}`);
    const url = new URL(TEST_DATABASE_URL); url.username = role; url.password = password;
    runtime = createDb(url.toString(), { deedEconomyWriter: false, marketRecoveryWriter: false });
    const first = randomUUID(), final = randomUUID(), id = await deposit(runtime.sql, { payment: first });
    await runtime.sql`update deposits set tx_signature=${final} where id=${id}`;
    expect((await claims(first))[0]?.consumer_id).toBe(id); expect((await claims(final))[0]?.consumer_id).toBe(id);
    await expect(runtime.sql`select * from payment_signature_claims`).rejects.toMatchObject({ code: '42501' });
    await expect(claim(runtime.sql, randomUUID(), randomUUID())).rejects.toMatchObject({ code: '42501' });
    await conn.sql.unsafe(`grant all on payment_signature_claims to ${role}; grant execute on function shardkeep_claim_payment_signature(text,text,uuid),shardkeep_deposit_payment_signature_capture() to ${role}`);
    await expect(claim(runtime.sql, randomUUID(), randomUUID())).rejects.toMatchObject({ code: '42501', message: 'PAYMENT_SIGNATURE_OWNER' });
    await expect(runtime.sql`insert into payment_signature_claims(signature,consumer_kind,consumer_id) values(${randomUUID()},'deposit',${id})`)
      .rejects.toMatchObject({ code: '42501', message: 'PAYMENT_SIGNATURE_OWNER' });
    await expect(runtime.sql.begin(async tx => {
      await tx`create temporary table forged_deposits(id uuid,payment_signature text,tx_signature text)`;
      await tx`create trigger deposits_payment_signature_claims after insert on forged_deposits for each row execute function public.shardkeep_deposit_payment_signature_capture()`;
      await tx`insert into forged_deposits(id,payment_signature) values(${id},${randomUUID()})`;
    })).rejects.toMatchObject({ message: 'PAYMENT_SIGNATURE_TRIGGER' });
  } finally { await runtime?.sql.end(); await conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`); }
});
