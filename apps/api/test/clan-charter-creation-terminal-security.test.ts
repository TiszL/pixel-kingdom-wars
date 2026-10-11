import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { createCharterCreationTerminal, type CharterCreationTerminalResult } from '../src/game/clanCharterCreationTerminal';
import { charterCreationTerminalFixture, type TerminalFixture } from './fixtures/charterCreationTerminal';

let f: TerminalFixture, control: CharterCreationTerminalResult;
beforeEach(async () => {
  f = await charterCreationTerminalFixture(); await f.seedSpendQuests();
  // Every refusal suite first demonstrates an actual successful terminal, so
  // missing runtime/migration support cannot satisfy negative assertions.
  const p = await f.prepared({ actor: await f.actor(), minted: true });
  control = await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  expect(control.state).toBe('activated');
}, 120_000);
afterEach(async () => { await f?.dispose(); }, 120_000);

it('protects immutable terminal/refund receipts and both original and terminal money sources from owner mutation and truncation', async () => {
  const p = await f.prepared(); await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  const refunded = await p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId), before = await f.terminalSnapshot();
  for (const [table, field] of [['charter_creation_terminals', 'reservation_id'], ['charter_creation_refunds', 'reservation_id'],
    ['charter_creation_terminal_posts', 'ledger_id'], ['charter_creation_terminal_entries', 'entry_id']]) {
    await expect(f.sql.unsafe(`update public.${table} set ${field}=${field}`)).rejects.toThrow();
    await expect(f.sql.unsafe(`delete from public.${table}`)).rejects.toThrow();
    await expect(f.sql.unsafe(`truncate public.${table} cascade`)).rejects.toThrow();
  }
  for (const id of [control.reserveTransactionId, control.terminalTransactionId!, refunded.refundTransactionId!]) {
    await expect(f.sql`update ledger_transactions set metadata=metadata where id=${id}`).rejects.toThrow();
    await expect(f.sql`delete from ledger_entries where txn_id=${id}`).rejects.toThrow();
  }
  await expect(f.sql`truncate ledger_transactions cascade`).rejects.toThrow();
  await expect(f.sql`update charter_creation_reservations set state='reserved' where id=${p.consent.reservationId}`).rejects.toThrow();
  expect(await f.terminalSnapshot()).toEqual(before);
});

it('requires both actual burn cache movements rather than accepting correct-looking terminal entries alone', async () => {
  const p = await f.prepared({ minted: true });
  for (const kind of ['charter_creation_escrow', 'shard_burn']) {
    const before = await f.terminalSnapshot();
    await f.sql.unsafe(`create or replace function public.b6o_skip_cache() returns trigger language plpgsql as $$begin
      if OLD.kind::text='${kind}' then return NULL;end if;return NEW;end$$;
      create trigger aaa_b6o_skip_cache before update on accounts for each row execute function public.b6o_skip_cache();`);
    try { await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow(); }
    finally { await f.sql`drop trigger aaa_b6o_skip_cache on accounts`; }
    expect(await f.terminalSnapshot()).toEqual(before);
  }
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
});

it('rolls back burn, spend quests, clan and obligation when the real founder is omitted or deleted after insertion', async () => {
  const p = await f.prepared({ minted: true });
  await f.sql`create sequence public.b6o_effects_reached`;
  for (const mode of ['skip', 'delete']) {
    const before = await f.terminalSnapshot();
    await f.sql`alter sequence public.b6o_effects_reached restart with 1`;
    await f.sql.unsafe(`create or replace function public.b6o_founder_fault() returns trigger language plpgsql as $$begin
      if NEW.player_wallet='${p.actor.wallet}' then
        if not exists(select 1 from base_quest_progress where base_id='${p.actor.baseId}' and progress>0)
          then raise exception 'FIXTURE_EXPECTED_QUESTS_BEFORE_CLAN_BARRIER';end if;
        perform nextval('public.b6o_effects_reached');
        ${mode === 'skip' ? 'return NULL;' : 'delete from clan_members where player_wallet=NEW.player_wallet;'}
      end if;return NEW;end$$;
      create trigger zzz_b6o_founder_fault ${mode === 'skip' ? 'before' : 'after'} insert on clan_members
        for each row execute function public.b6o_founder_fault();`);
    try { await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow(); }
    finally { await f.sql`drop trigger zzz_b6o_founder_fault on clan_members`; }
    expect((await f.sql`select is_called from public.b6o_effects_reached`)[0]!.is_called).toBe(true);
    expect(await f.terminalSnapshot()).toEqual(before);
  }
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
});

it('refuses forged terminal balance_after on the actual ledger path and preserves the original funded intent for retry', async () => {
  const p = await f.prepared({ minted: true }), before = await f.terminalSnapshot();
  const [header] = await f.sql`select type from ledger_transactions where id=${control.terminalTransactionId}`;
  // The type comes from the successful control, not a guessed implementation label.
  await f.sql.unsafe(`create function public.b6o_entry_fault() returns trigger language plpgsql as $$begin
    if exists(select 1 from ledger_transactions where id=NEW.txn_id and type='${header!.type}')
      then NEW.balance_after:=NEW.balance_after+1;end if;return NEW;end$$;
    create trigger aaa_b6o_entry_fault before insert on ledger_entries for each row execute function public.b6o_entry_fault();`);
  try { await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow(); }
  finally { await f.sql`drop trigger aaa_b6o_entry_fault on ledger_entries`; }
  expect(await f.terminalSnapshot()).toEqual(before);
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
});

it('keeps cancellation irrevocable but its liability unpaid when either refund cache effect fails', async () => {
  const p = await f.prepared(); await p.service().recover(p.actor.wallet, p.consent.creationIntentId);
  for (const kind of ['charter_creation_escrow', 'base_shards']) {
    const before = await f.terminalSnapshot();
    await f.sql.unsafe(`create or replace function public.b6o_refund_fault() returns trigger language plpgsql as $$begin
      if OLD.kind::text='${kind}' then return OLD;end if;return NEW;end$$;
      create trigger aaa_b6o_refund_fault before update on accounts for each row execute function public.b6o_refund_fault();`);
    try { await expect(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)).rejects.toThrow(); }
    finally { await f.sql`drop trigger aaa_b6o_refund_fault on accounts`; }
    expect(await f.terminalSnapshot()).toEqual(before);
    expect((await p.service().read(p.actor.wallet, p.consent.creationIntentId))!.state).toBe('cancelled_unpaid');
  }
  expect((await p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)).state).toBe('refunded');
});

it('keeps the private facade and terminal state transitions owner-only even after accidental broad grants', async () => {
  const p = await f.prepared(), before = await f.terminalSnapshot();
  const role = 'b6o_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  let runtime: ReturnType<typeof createDb> | undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    await f.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};
      grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
    const url = await f.ownerUrl(); url.username = role; url.password = password; runtime = createDb(url.toString());
    const service = createCharterCreationTerminal(runtime.db, { chain: p.bank.chain });
    for (const run of [() => service.read(control.consent.payer, control.consent.creationIntentId),
      () => service.recover(p.actor.wallet, p.consent.creationIntentId),
      () => service.claimRefund(p.actor.wallet, p.consent.creationIntentId)]) await expect(run()).rejects.toThrow();
    await expect(runtime.sql`update charter_creation_reservations set state='cancelled_unpaid' where id=${p.consent.reservationId}`).rejects.toThrow();
    await expect(runtime.sql`update charter_creation_terminals set reservation_id=reservation_id`).rejects.toThrow();
  } finally {
    await runtime?.sql.end(); await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);
  }
  expect(p.bank.connect).not.toHaveBeenCalled(); expect(await f.terminalSnapshot()).toEqual(before);
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
});
