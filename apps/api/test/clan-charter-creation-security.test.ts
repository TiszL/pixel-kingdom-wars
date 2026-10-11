/** Intended path: apps/api/test/clan-charter-creation-security.test.ts.
 * Provisional schema pins: reservations.id, reserve_transaction_id;
 * posts.ledger_id/tx_key; entries.entry_id/ledger_id. Freeze alongside migration.
 * These attacks start after trusted opening balances. They do not prove that
 * arbitrary owner pre-credit before protected capture is impossible. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getBaseShardBalance, spendBaseShards } from '../src/game/baseEconomy';
import { createDb } from '../src/db/client';
import { createCharterCreationReservations, type CharterCreationReservation } from '../src/game/clanCharterCreationReservations';
import { postTransaction as ledgerPost } from '../src/ledger';
import { charterCreationFundingFixture } from './fixtures/charterCreationFunding';

let f: Awaited<ReturnType<typeof charterCreationFundingFixture>>;
let control: CharterCreationReservation;
beforeEach(async () => {
  f = await charterCreationFundingFixture();
  // Each attack has a real successful funding control. A missing facade/SQL
  // guard cannot satisfy a negative assertion by throwing an unrelated error.
  const payer = await f.actor(); control = await f.service().reserve(payer.wallet, f.consent(payer));
  const wire = await f.posting(payer, control.consent);
  const [actual] = await f.sql`select type,idempotency_key,metadata from ledger_transactions where id=${control.reserveTransactionId}`;
  expect(actual).toEqual({ type: wire.type, idempotency_key: wire.idempotencyKey, metadata: wire.metadata });
}, 120_000);
afterEach(async () => { await f?.dispose(); }, 120_000);
const privateTables = ['charter_creation_reservations', 'charter_creation_funding_posts', 'charter_creation_funding_entries'] as const;
const postTransaction = ledgerPost;
function postgresLeaf(error: unknown) {
  let cause = error, leaf: { code: string; message: string } | undefined;
  for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z0-9]{5}$/.test(cause.code)
      && 'message' in cause && typeof cause.message === 'string') leaf = { code: cause.code, message: cause.message };
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  expect(leaf, 'a real PostgreSQL leaf error is required, never echoed query metadata').toBeDefined();
  return leaf!;
}
async function expectSqlGuard(operation: Promise<unknown>, suffix: string, code = 'P0001') {
  const error = await operation.then(() => null, value => value);
  expect(error, 'the guarded operation must fail').not.toBeNull();
  expect(postgresLeaf(error)).toEqual({ code, message: 'CLAN_CHARTER_CREATION_' + suffix });
}

it('rolls back a real affordable reserve posting with no paired reservation at deferred commit', async () => {
  const before = await f.snapshot(), input = await f.posting(f.source);
  let bodyReached = false;
  await expectSqlGuard(f.db.transaction(async tx => { await postTransaction(tx, input); bodyReached = true; }), 'PAIRING');
  expect(bodyReached).toBe(true);
  expect(await f.snapshot()).toEqual(before);
});

it('rejects amount, account and extra-leg mismatches even through the real balanced ledger engine', async () => {
  const other = await f.actor(), before = await f.snapshot();
  for (const mode of ['amount', 'source', 'extra']) {
    const input = await f.posting(f.source);
    if (mode === 'amount') input.entries = input.entries.map(e => ({ ...e, delta: e.delta < 0n ? -(f.cost - 1n) : f.cost - 1n }));
    if (mode === 'source') input.entries[0]!.account = other.account.id;
    if (mode === 'extra') input.entries.push({ account: other.account.id, delta: -1n }, { account: input.entries[1]!.account, delta: 1n });
    await expectSqlGuard(f.db.transaction(async tx => {
      await postTransaction(tx, input);
      throw Error('MALFORMED_POST_WAS_ACCEPTED');
    }), mode === 'amount' ? 'ENTRY_AMOUNT' : mode === 'extra' ? 'ENTRY_EXTRA' : 'ENTRY_ACCOUNT');
  }
  expect(await f.snapshot()).toEqual(before);
});

it('refuses escrow money movement hidden under an unrelated posting type, in both directions', async () => {
  const escrow = await f.escrowAccount(), before = await f.snapshot();
  for (const delta of [1n, -1n]) await expectSqlGuard(postTransaction(f.db, { idempotencyKey: randomUUID(), type: 'test.unrelated',
    entries: [{ account: f.source.account.id, delta: -delta }, { account: escrow.id, delta }] }), 'MONEY');
  expect(await f.snapshot()).toEqual(before);
});

it('requires actual source cache subtraction and escrow addition rather than entry-only evidence', async () => {
  // Fault injection targets an otherwise ordinary facade posting. No orphan
  // reservation can mask a missing cache check because reserve supplies it.
  for (const kind of ['base_shards', 'charter_creation_escrow']) for (const action of ['skip', 'noop']) {
    const before = await f.snapshot();
    await f.sql.unsafe(`create or replace function public.b6l_cache_fault() returns trigger language plpgsql as $$ begin
      if OLD.kind::text='${kind}' then ${action === 'skip' ? 'return NULL' : 'return OLD'};end if;return NEW;end $$;
      create trigger aaa_b6l_cache_fault before update on accounts for each row execute function public.b6l_cache_fault();`);
    try { await expect(f.service().reserve(f.source.wallet, f.consent(f.source)))
      .rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_MONEY' }); }
    finally { await f.sql`drop trigger aaa_b6l_cache_fault on accounts`; }
    expect(await f.snapshot()).toEqual(before);
  }
});

it('rejects forged balance_after values from an actual ledger INSERT before they can back a reservation', async () => {
  const before = await f.snapshot();
  await f.sql.unsafe(`create function public.b6l_entry_fault() returns trigger language plpgsql as $$ begin
    if exists(select 1 from ledger_transactions where id=NEW.txn_id and type='clan.charter.reserve')
    then NEW.balance_after:=NEW.balance_after+1;end if;return NEW;end $$;
    create trigger aaa_b6l_entry_fault before insert on ledger_entries for each row execute function public.b6l_entry_fault();`);
  try { await expect(f.service().reserve(f.source.wallet, f.consent(f.source)))
    .rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_ENTRY_BALANCE' }); }
  finally { await f.sql`drop trigger aaa_b6l_entry_fault on ledger_entries`; }
  expect(await f.snapshot()).toEqual(before);
});

it('rejects raw entry/cache arithmetic that attempts to fund a reservation without the facade', async () => {
  const input = await f.posting(f.source), escrow = await f.escrowAccount(), before = await f.snapshot();
  await expectSqlGuard(f.sql.begin(async tx => {
    const [p] = await tx`insert into ledger_transactions(idempotency_key,type,metadata)
      values(${input.idempotencyKey},${input.type},${JSON.stringify(input.metadata)}::jsonb) returning id`;
    // Correct deltas with forged after values cannot certify an actual debit.
    await tx`insert into ledger_entries(txn_id,account_id,delta,balance_after)
      values(${p!.id},${f.source.account.id},${String(-f.cost)},${String(f.source.account.balance)}),
      (${p!.id},${escrow.id},${String(f.cost)},${String(escrow.balance+f.cost)})`;
    throw Error('FORGED_BALANCE_AFTER_WAS_ACCEPTED');
  }), 'ENTRY_BALANCE');
  expect(await f.snapshot()).toEqual(before);
});

it('rejects an unaffordable raw reserve post during capture before any deferred orphan check', async () => {
  const empty = await f.actor(0n), input = await f.posting(empty), before = await f.snapshot();
  await expectSqlGuard(f.sql.begin(async tx => {
    await tx`insert into ledger_transactions(idempotency_key,type,metadata)
      values(${input.idempotencyKey},${input.type},${JSON.stringify(input.metadata)}::jsonb)`;
    throw Error('UNFUNDED_POST_WAS_ACCEPTED');
  }), 'UNAFFORDABLE');
  expect(await f.snapshot()).toEqual(before);
});

it('prevents a second posting touching captured money within the same reservation transaction', async () => {
  const other = await f.actor(), input = await f.posting(f.source), before = await f.snapshot();
  await expectSqlGuard(f.db.transaction(async tx => {
    await postTransaction(tx, input);
    // No escrow leg: only captured-source protection can refuse this posting.
    await postTransaction(tx, { idempotencyKey: randomUUID(), type: 'test.trailing',
      entries: [{ account: f.source.account.id, delta: -1n }, { account: other.account.id, delta: 1n }] });
    throw Error('SECOND_POSTING_WAS_ACCEPTED');
  }), 'POST_CONFLICT');
  expect(await f.snapshot()).toEqual(before);
});

it('preserves private witnesses and original reserved sources against owner mutation and truncation', async () => {
  const before = await f.snapshot();
  for (const [table, field] of [['charter_creation_reservations', 'id'], ['charter_creation_funding_posts', 'ledger_id'], ['charter_creation_funding_entries', 'entry_id']]) {
    if (table === 'charter_creation_reservations') {
      // Terminal completion permits only receipt-backed state transitions. An
      // owner no-op update still cannot rewrite the original reservation.
      const error = await f.sql.unsafe(`update ${table} set ${field}=${field}`).then(() => null, value => value);
      expect(postgresLeaf(error)).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_TERMINAL_STATE' });
    } else await expectSqlGuard(f.sql.unsafe(`update ${table} set ${field}=${field}`), 'IMMUTABLE');
    await expectSqlGuard(f.sql.unsafe(`delete from ${table}`), 'IMMUTABLE');
    await expectSqlGuard(f.sql.unsafe(`truncate ${table} cascade`), 'IMMUTABLE');
  }
  await expectSqlGuard(f.sql`update ledger_transactions set type=type where id=${control.reserveTransactionId}`, 'IMMUTABLE');
  await expectSqlGuard(f.sql`delete from ledger_entries where txn_id=${control.reserveTransactionId}`, 'IMMUTABLE');
  await expectSqlGuard(f.sql`truncate ledger_transactions cascade`, 'IMMUTABLE');
  expect(await f.snapshot()).toEqual(before);
});

it('refuses direct escrow cache credit/debit and account identity substitution after real funding', async () => {
  const escrow = await f.escrowAccount(), before = await f.snapshot();
  for (const delta of [1n, -1n]) await expectSqlGuard(f.sql`update accounts set balance=balance+${String(delta)}::bigint where id=${escrow.id}`, 'MONEY');
  await expectSqlGuard(f.sql`update accounts set kind='shard_burn' where id=${escrow.id}`, 'IMMUTABLE');
  await expectSqlGuard(f.sql`update accounts set owner_wallet=${f.source.wallet} where id=${escrow.id}`, 'IMMUTABLE');
  await expectSqlGuard(f.sql`update accounts set base_id=${f.source.baseId} where id=${escrow.id}`, 'IMMUTABLE');
  await expectSqlGuard(f.sql`delete from accounts where id=${escrow.id}`, 'IMMUTABLE');
  const [source] = await f.sql`select id from accounts where base_id=${control.consent.funding.baseId} and kind::text='base_shards'`;
  await expectSqlGuard(f.sql`update accounts set base_id=${f.source.baseId} where id=${source!.id}`, 'IMMUTABLE');
  await expectSqlGuard(f.sql`update accounts set kind='base_forge_escrow' where id=${source!.id}`, 'IMMUTABLE');
  await expectSqlGuard(f.sql`update accounts set currency='KEEP' where id=${source!.id}`, 'IMMUTABLE');
  expect(await f.snapshot()).toEqual(before);
});

it('keeps private writes and the facade owner-only even after accidental broad grants', async () => {
  const role = 'charter_test_' + randomUUID().replaceAll('-', ''), password = randomUUID(), before = await f.snapshot();
  let runtime: ReturnType<typeof createDb> | undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    await f.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
    const url = await f.ownerUrl(); url.username = role; url.password = password; runtime = createDb(url.toString());
    const store = createCharterCreationReservations(runtime.db, { newCreationDomain: f.domain });
    await expect(store.reserve(f.source.wallet, f.consent(f.source))).rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_OWNER' });
    await expect(store.read(control.consent.payer, control.consent.creationIntentId)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_OWNER' });
    for (const table of privateTables) await expectSqlGuard(runtime.sql.unsafe(`insert into ${table} select * from ${table}`), 'OWNER', '42501');
    expect(await f.snapshot()).toEqual(before);
    // Existing RC gameplay can still spend the unreserved part of a funded
    // source through the runtime role; the historical proof remains unchanged.
    const sourceBase = control.consent.funding.baseId, balance = await getBaseShardBalance(f.db, sourceBase);
    await spendBaseShards(runtime.db, sourceBase, 1n, 'test.runtime.charter-unreserved', randomUUID());
    expect(await getBaseShardBalance(f.db, sourceBase)).toBe(balance - 1n);
    expect(await f.service().read(control.consent.payer, control.consent.creationIntentId)).toEqual(control);
  } finally { await runtime?.sql.end(); await f.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
});

it('rejects owner TEMP wrappers copying old witnesses with a newly forged top-level transaction key', async () => {
  const owner = await f.dedicatedOwner(), before = await f.snapshot();
  try {
    await owner.sql.unsafe(`create temporary table b6l_attack(mode text);
      create function pg_temp.b6l_attack() returns trigger language plpgsql as $$
      declare p public.charter_creation_funding_posts%rowtype;e public.charter_creation_funding_entries%rowtype;
      begin
        if NEW.mode='post' then select * into strict p from public.charter_creation_funding_posts limit 1;
          p.tx_key:=pg_current_xact_id()::text;insert into public.charter_creation_funding_posts select p.*;
        else select * into strict e from public.charter_creation_funding_entries limit 1;
          e.tx_key:=pg_current_xact_id()::text;insert into public.charter_creation_funding_entries select e.*;
        end if;return NEW;end $$;
      create trigger b6l_attack after insert on b6l_attack for each row execute function pg_temp.b6l_attack();`);
    for (const mode of ['post', 'entry']) await expectSqlGuard(owner.sql`insert into b6l_attack values(${mode})`, 'SOURCE');
  } finally { await owner.sql.end(); }
  expect(await f.snapshot()).toEqual(before);
});

it('rejects fresh-key forged snapshots and reservations instead of relying on duplicate primary keys', async () => {
  const owner = await f.dedicatedOwner();
  try {
    const [unrelated] = await owner.sql`insert into ledger_transactions(type,idempotency_key,metadata)
      values('test.unrelated',${randomUUID()},'{}'::jsonb) returning id`;
    expect(unrelated!.id).not.toBe(control.reserveTransactionId);
    const before = await f.snapshot();
    await expectSqlGuard(owner.sql`update ledger_transactions set type='clan.charter.reserve' where id=${unrelated!.id}`, 'IMMUTABLE');
    await owner.sql.unsafe(`create temporary table b6l_fresh_attack(mode text,fake_id uuid);
      create function pg_temp.b6l_fresh_attack() returns trigger language plpgsql as $$
      declare p public.charter_creation_funding_posts%rowtype;r public.charter_creation_reservations%rowtype;
      begin
        if NEW.mode='post' then
          select * into strict p from public.charter_creation_funding_posts limit 1;
          p.ledger_id:=NEW.fake_id;p.tx_key:=pg_current_xact_id()::text;p.source_before:=p.source_before+1;
          insert into public.charter_creation_funding_posts select p.*;
        else
          select * into strict r from public.charter_creation_reservations limit 1;
          r.id:=gen_random_uuid();r.intent_id:=gen_random_uuid();
          r.consent:=jsonb_set(jsonb_set(r.consent,'{reservationId}',to_jsonb(r.id::text)),
            '{creationIntentId}',to_jsonb(r.intent_id::text));
          insert into public.charter_creation_reservations select r.*;
        end if;return NEW;end $$;
      create trigger b6l_fresh_attack after insert on b6l_fresh_attack for each row execute function pg_temp.b6l_fresh_attack();`);
    await expectSqlGuard(owner.sql`insert into b6l_fresh_attack values('post',${unrelated!.id})`, 'SOURCE');
    await expectSqlGuard(owner.sql`insert into b6l_fresh_attack values('reservation',${unrelated!.id})`, 'MONEY');
    expect(await f.snapshot()).toEqual(before);
  } finally { await owner.sql.end(); }
});

it('rejects copied capture triggers rather than trusting their function name or nesting alone', async () => {
  const owner = await f.dedicatedOwner(), before = await f.snapshot();
  try {
    // Resolve exact installed source names; no guessed trigger can accidentally
    // make this case pass by failing to exist. Require one actual INSERT hook.
    const captures = await owner.sql`select t.tgname,p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid='public.ledger_transactions'::regclass and t.tgtype=5 and p.proname like '%charter_creation%'`;
    expect(captures).toHaveLength(1); const capture = captures[0]!;
    await owner.sql.unsafe(`create temporary table b6l_copied(like public.ledger_transactions including defaults);
      create trigger ${capture.tgname} after insert on b6l_copied for each row execute function public.${capture.proname}();`);
    await expectSqlGuard(owner.sql`insert into b6l_copied select * from public.ledger_transactions where id=${control.reserveTransactionId}`, 'TRIGGER');
  } finally { await owner.sql.end(); }
  expect(await f.snapshot()).toEqual(before);
});

it('holds original reads and new admission when any Charter source hook is disabled', async () => {
  const hooks = await f.sql`select c.relname,t.tgname from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_class c on c.oid=t.tgrelid
    where t.tgrelid in ('public.ledger_transactions'::regclass,'public.ledger_entries'::regclass,'public.accounts'::regclass)
      and p.proname like '%charter_creation%' order by c.relname,t.tgname`;
  expect(hooks.length).toBeGreaterThanOrEqual(3); const before = await f.snapshot();
  for (const hook of hooks) {
    await f.sql.unsafe(`alter table public.${hook.relname} disable trigger ${hook.tgname}`);
    try {
      await expect(f.service().read(control.consent.payer, control.consent.creationIntentId)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_HELD' });
      await expect(f.service().reserve(f.source.wallet, f.consent(f.source))).rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_HELD' });
    } finally { await f.sql.unsafe(`alter table public.${hook.relname} enable trigger ${hook.tgname}`); }
  }
  expect(await f.snapshot()).toEqual(before);
});
