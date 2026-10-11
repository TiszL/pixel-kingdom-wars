/** Material terminal boundaries exercised through actual funding, posting and
 * ownership writers. These fixtures do not authenticate real network finality. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCharterCreationCancellationReader } from '@shardkeep/chain/charter-creation-cancellation';
import * as migration from '../src/db/migrate';
import { baseArmy } from '../src/db/schema';
import { createCharterCreationTerminal } from '../src/game/clanCharterCreationTerminal';
import { createCampaignRaid, compensatePendingRaid } from '../src/game/raids';
import { bootstrapSystemAccounts, postTransaction } from '../src/ledger';
import { postgresLeaf } from './fixtures/charterPermitInventory';
import { charterCreationTerminalFixture, type PreparedTerminal, type TerminalFixture } from './fixtures/charterCreationTerminal';

let f: TerminalFixture;
beforeEach(async () => {
  f = await charterCreationTerminalFixture(); await f.seedSpendQuests();
  const control = await f.prepared({ actor: await f.actor(), minted: true });
  expect((await control.service().recover(control.actor.wallet, control.consent.creationIntentId)).state).toBe('activated');
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); await f?.dispose(); }, 120_000);

const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? String(item) : item);
async function observed(p: PreparedTerminal) {
  const reader = createCharterCreationCancellationReader(p.bank.connect, p.bank.trust, id => f.inventory().loadForCancellation(id));
  const proof = JSON.parse(json(await reader(p.consent.creationIntentId)));
  const [row] = await f.sql`select public.shardkeep_charter_terminal_snapshot(
    public.shardkeep_charter_terminal_inventory(${p.actor.wallet},${p.consent.creationIntentId}::uuid)) value`;
  return { proof, inventory: row!.value };
}

it('rejects real balanced orphan activation/refund posts and the reverse orphan receipt only at deferred pairing', async () => {
  const accounts = await bootstrapSystemAccounts(f.db);
  for (const operation of ['activate', 'refund'] as const) {
    const p = await f.prepared({ actor: await f.actor(), minted: operation === 'activate' });
    const evidence = await observed(p);
    if (operation === 'refund') {
      expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
      // Refresh immediately before the raw posting: an expired observation
      // must not mask the intended missing-refund-receipt commit refusal.
      expect(await p.actor.refresh(p.actor.wallet, 101)).toBe('owned');
    }
    const destination = operation === 'activate' ? accounts.shard_burn : p.actor.account.id;
    const sourceBefore = await f.balance('charter_creation_escrow');
    const destinationBefore = await f.balance(operation === 'activate' ? 'shard_burn' : 'base_shards',
      operation === 'activate' ? undefined : p.actor.baseId);
    const before = await f.terminalSnapshot(); let effectsReached = false;
    const error = await f.db.transaction(async tx => {
      const metadata = operation === 'activate'
        ? { version: 1, reservationId: p.consent.reservationId, inventory: evidence.inventory, observation: evidence.proof }
        : { version: 1, reservationId: p.consent.reservationId, destinationBaseId: p.actor.baseId, automatic: true };
      const posted = await postTransaction(tx, { idempotencyKey: `charter-${operation}:${p.consent.creationIntentId}`,
        type: `clan.charter.${operation}`, metadata,
        entries: [{ account: accounts.charter_creation_escrow, delta: -f.cost }, { account: destination, delta: f.cost }] });
      expect(posted.duplicate).toBe(false); expect(posted.entries).toHaveLength(2);
      expect(posted.entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
      const balances = await tx.execute<{ id: string; balance: string }>(sql`
        select id,balance::text balance from accounts where id in(${accounts.charter_creation_escrow}::uuid,${destination}::uuid)`);
      expect(balances.find(row => row.id === accounts.charter_creation_escrow)?.balance).toBe(String(sourceBefore - f.cost));
      expect(balances.find(row => row.id === destination)?.balance).toBe(String(destinationBefore + f.cost));
      const [witness] = await tx.execute<{ n: number }>(sql`select count(*)::int n from charter_creation_terminal_entries where ledger_id=${posted.transaction.id}::uuid`);
      expect(witness!.n).toBe(2);
      effectsReached = true;
      // Deliberately omit the terminal/refund receipt and state transition.
      // This reaches COMMIT with real canonical money, not fabricated FK rows.
    }, { isolationLevel: 'read committed' }).then(() => null, cause => cause);
    expect(effectsReached).toBe(true); expect(error).not.toBeNull();
    expect(postgresLeaf(error)).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_TERMINAL_HELD' });
    expect(await f.terminalSnapshot()).toEqual(before);
    if (operation === 'activate') expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
    else expect((await p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId)).state).toBe('refunded');
  }

  // Pairing is bidirectional: a genuine zero-head absence receipt is also
  // forbidden without the atomic closure of the reserved issuance state.
  const p = await f.prepared({ actor: await f.actor(), count: 0 }), evidence = await observed(p), before = await f.terminalSnapshot();
  let receiptReached = false;
  const error = await f.db.transaction(async tx => {
    await tx.execute(sql`insert into charter_creation_terminals(reservation_id,inventory,observation)
      values(${p.consent.reservationId}::uuid,${json(evidence.inventory)}::jsonb,${json(evidence.proof)}::jsonb)`);
    const [receipt] = await tx.execute<{ outcome: string; state: string }>(sql`
      select t.outcome,r.state from charter_creation_terminals t join charter_creation_reservations r on r.id=t.reservation_id
      where r.id=${p.consent.reservationId}::uuid`);
    expect(receipt).toEqual({ outcome: 'cancelled_unpaid', state: 'reserved' }); receiptReached = true;
  }, { isolationLevel: 'read committed' }).then(() => null, cause => cause);
  expect(receiptReached).toBe(true); expect(error).not.toBeNull();
  expect(postgresLeaf(error)).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_TERMINAL_HELD' });
  expect(await f.terminalSnapshot()).toEqual(before);
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
}, 120_000);

it('preserves unpaid liability after positive custody loss deferred by a real outgoing campaign, including a fresh A-to-B-to-A return', async () => {
  expect(await f.source.refresh(f.source.wallet, 100)).toBe('owned');
  const p = await f.prepared(), buyer = await f.actor();
  await f.db.insert(baseArmy).values({ baseId: p.actor.baseId, troop: 'plunderer', count: 1 });
  const raid = await createCampaignRaid(f.db, p.actor.wallet, 1, randomUUID(), new Date(), {
    attackerBaseId: p.actor.baseId, authorizeAttackerBase: async () => {},
  });
  expect(await p.actor.refresh(buyer.wallet, 101)).toBe('mismatch');
  expect((await f.sql`select owner_wallet from bases where id=${p.actor.baseId}`)[0]!.owner_wallet).toBe(p.actor.wallet);
  expect(await p.actor.custody.read(p.actor.baseId)).toMatchObject({ ownerWallet: buyer.wallet, authority: 'unavailable', ordinal: '2' });
  expect(await f.sql`select * from base_raid_locks where base_id=${p.actor.baseId}`).toHaveLength(0);
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
  expect(await p.actor.refresh(buyer.wallet, 101)).toBe('mismatch');
  let before = await f.terminalSnapshot();
  await expect(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId))
    .rejects.toMatchObject({ code: 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY' });
  expect(await f.terminalSnapshot()).toEqual(before);

  // Neither RPC staleness nor a current owner mismatch can explain this second
  // hold: A has a fresh accepted owned proof while its original epoch is gone.
  expect(await p.actor.refresh(p.actor.wallet, 102)).toBe('owned');
  const returned = await p.actor.custody.read(p.actor.baseId);
  expect(returned).toMatchObject({ ownerWallet: p.actor.wallet, authority: 'current', ordinal: '3' });
  expect(returned!.id).not.toBe(p.consent.funding.ownershipEpoch.id);
  expect((await f.sql`select owner_wallet from bases where id=${p.actor.baseId}`)[0]!.owner_wallet).toBe(p.actor.wallet);
  before = await f.terminalSnapshot();
  await expect(p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId))
    .rejects.toMatchObject({ code: 'CLAN_CHARTER_TERMINAL_REFUND_AUTHORITY' });
  // The refusal must be the lost original epoch, not an expired current proof.
  expect(await p.actor.custody.read(p.actor.baseId)).toMatchObject({ id: returned!.id, authority: 'current', ordinal: '3' });
  expect(await f.terminalSnapshot()).toEqual(before);
  expect((await p.service().read(p.actor.wallet, p.consent.creationIntentId))!.state).toBe('cancelled_unpaid');
  expect(await f.balance('charter_creation_escrow')).toBe(f.cost);
  expect(await f.sql`select * from charter_creation_refunds where reservation_id=${p.consent.reservationId}`).toHaveLength(0);
  expect(await f.sql`select payer,base_id,state from charter_creation_reservations where id=${p.consent.reservationId}`)
    .toEqual([{ payer: p.actor.wallet, base_id: p.actor.baseId, state: 'cancelled_unpaid' }]);
  expect(await compensatePendingRaid(f.db, raid, false)).toBe(true);
  expect(await p.actor.refresh(p.actor.wallet, 103)).toBe('owned');
  // An explicit current-owner destination choice remains independently usable.
  expect((await p.service().claimRefund(p.actor.wallet, p.consent.creationIntentId, p.actor.baseId)).state).toBe('refunded');
});

it('rolls back real activation money, quests and receipts when a trailing state trigger changes the committed clan identity', async () => {
  expect(await f.source.refresh(f.source.wallet, 100)).toBe('owned');
  const p = await f.prepared({ minted: true }), before = await f.terminalSnapshot();
  await f.sql`create sequence public.b6o_trailing_identity_reached`;
  await f.sql.unsafe(`create function public.b6o_trailing_identity() returns trigger language plpgsql as $$begin
    if NEW.id='${p.consent.reservationId}' and NEW.state='activated' then
      if not exists(select 1 from public.charter_creation_terminals t where t.reservation_id=NEW.id and t.outcome='activated'
        and public.shardkeep_charter_terminal_money(t.terminal_transaction_id,true))
      or not exists(select 1 from public.base_quest_progress where base_id=NEW.base_id and progress>0)
      or not exists(select 1 from public.clan_members where player_wallet=NEW.payer and clan_id=NEW.clan_id)
      then raise exception 'FIXTURE_EXPECTED_COMPLETE_ACTIVATION_EFFECTS';end if;
      update public.clans set name=reverse(name) where id=NEW.clan_id;
      perform nextval('public.b6o_trailing_identity_reached');
    end if;return NEW;end$$;
    create trigger zzz_b6o_trailing_identity after update on charter_creation_reservations
      for each row execute function public.b6o_trailing_identity();`);
  try {
    await expect(p.service().recover(p.actor.wallet, p.consent.creationIntentId))
      .rejects.toMatchObject({ code: 'CLAN_CHARTER_TERMINAL_EFFECTS' });
  } finally { await f.sql`drop trigger zzz_b6o_trailing_identity on charter_creation_reservations`; }
  expect((await f.sql`select is_called from public.b6o_trailing_identity_reached`)[0]!.is_called).toBe(true);
  expect(await f.terminalSnapshot()).toEqual(before);
  expect((await p.service().recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
});

it('retains readable pre-inventory funding while every terminal operation holds before RPC instead of inventing a historical zero head', async () => {
  await f.dispose(); f = undefined!;
  const prefix = await mkdtemp(join(tmpdir(), 'charter-terminal-prefix-')), runMigrations = migration.runMigrations;
  try {
    await cp(fileURLToPath(new URL('../drizzle', import.meta.url)), prefix, { recursive: true });
    const path = join(prefix, 'meta/_journal.json'), journal = JSON.parse(await readFile(path, 'utf8'));
    const inventoryIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0221_charter_creation_permit_inventory');
    expect(inventoryIndex).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, inventoryIndex);
    expect(journal.entries.at(-1)?.tag).toBe('0220_charter_creation_reservations');
    await writeFile(path, JSON.stringify(journal));
    vi.spyOn(migration, 'runMigrations').mockImplementationOnce(db => runMigrations(db, { migrationsFolder: prefix }));
    f = await charterCreationTerminalFixture(); vi.restoreAllMocks();
    expect(await f.sql`select to_regclass('public.charter_creation_permit_heads') name`).toEqual([{ name: null }]);
    const old = await f.fund();
    await runMigrations(f.db); await runMigrations(f.db);
    expect(await f.service().read(old.actor.wallet, old.consent.creationIntentId)).toEqual(old.reservation);
    expect(await f.service().reserve(old.actor.wallet, old.consent)).toEqual(old.reservation);
    expect(await f.sql`select * from charter_creation_permit_heads where reservation_id=${old.consent.reservationId}`).toHaveLength(0);

    const next = await f.prepared({ actor: await f.actor(), count: 0 });
    expect((await next.service().recover(next.actor.wallet, next.consent.creationIntentId)).state).toBe('cancelled_unpaid');
    const connect = vi.fn(() => { throw Error('Historical missing head must hold before transport'); });
    const terminal = createCharterCreationTerminal(f.db, { chain: { trust: next.bank.trust, connect } }), before = await f.terminalSnapshot();
    for (const action of [() => terminal.read(old.actor.wallet, old.consent.creationIntentId),
      () => terminal.recover(old.actor.wallet, old.consent.creationIntentId),
      () => terminal.claimRefund(old.actor.wallet, old.consent.creationIntentId)]) {
      await expect(action()).rejects.toMatchObject({ code: 'CLAN_CHARTER_TERMINAL_HELD' });
    }
    expect(connect).not.toHaveBeenCalled(); expect(await f.terminalSnapshot()).toEqual(before);
    expect(await f.service().read(old.actor.wallet, old.consent.creationIntentId)).toEqual(old.reservation);
    expect(await f.sql`select * from charter_creation_permit_heads where reservation_id=${old.consent.reservationId}`).toHaveLength(0);
    expect(await f.sql`select * from charter_creation_terminals where reservation_id=${old.consent.reservationId}`).toHaveLength(0);
  } finally { vi.restoreAllMocks(); await rm(prefix, { recursive: true, force: true }); }
}, 120_000);
