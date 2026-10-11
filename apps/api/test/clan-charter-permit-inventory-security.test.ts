/** PostgreSQL provenance and quarantine fixtures. They do not authenticate a
 * policy signature or protect against an owner replacing the application/DDL.
 * Fault injection restores mandatory hooks before asking the reader to decide. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { createCharterCreationPermitInventory } from '../src/game/clanCharterCreationPermitInventory';
import { charterPermitInventoryFixture, postgresLeaf, sha } from './fixtures/charterPermitInventory';

let f: Awaited<ReturnType<typeof charterPermitInventoryFixture>>;
beforeEach(async () => { f = await charterPermitInventoryFixture(); }, 120_000);
afterEach(async () => { await f?.dispose(); }, 120_000);
const tables = ['charter_creation_permit_heads', 'charter_creation_permit_messages'] as const;
const refused = (suffix: string) => ({ code: 'CLAN_CHARTER_INVENTORY_' + suffix });
async function control() {
  const funded = await f.fund(), saved = await f.inventory().read(funded.actor.wallet, funded.consent.creationIntentId);
  return { ...funded, saved, bytes: f.message(saved) };
}
async function sqlGuard(work: PromiseLike<unknown>, suffix: string, code = 'P0001') {
  const error = await Promise.resolve(work).then(() => null, cause => cause);
  expect(error, 'the exact PostgreSQL guard must reject, not a query echo or unrelated deferred orphan').not.toBeNull();
  expect(postgresLeaf(error)).toEqual({ code, message: 'CLAN_CHARTER_INVENTORY_' + suffix });
}

it('retains the immutable prospective head and permanent candidate against owner update, delete and truncate', async () => {
  const { actor, consent, bytes } = await control(); await f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes);
  const before = await f.inventorySnapshot();
  for (const table of tables) {
    await sqlGuard(f.sql.unsafe(`update ${table} set reservation_id=reservation_id`), 'IMMUTABLE');
    await sqlGuard(f.sql.unsafe(`delete from ${table}`), 'IMMUTABLE');
    await sqlGuard(f.sql.unsafe(`truncate ${table} cascade`), 'IMMUTABLE');
  }
  expect(await f.inventorySnapshot()).toEqual(before);
});

it('denies private reads, appends and raw writes to an accidentally over-granted nonowner role', async () => {
  const { actor, consent, bytes } = await control(), role = 'charter_inventory_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  const before = await f.inventorySnapshot(); let runtime: ReturnType<typeof createDb> | undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    await f.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};
      grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
    const url = await f.ownerUrl(); url.username = role; url.password = password; runtime = createDb(url.toString());
    const inventory = createCharterCreationPermitInventory(runtime.db);
    await expect(inventory.read(actor.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('OWNER'));
    await expect(inventory.recordPrepared(actor.wallet, consent.creationIntentId, bytes)).rejects.toMatchObject(refused('OWNER'));
    await expect(inventory.loadForCancellation(consent.creationIntentId)).rejects.toMatchObject(refused('OWNER'));
    await sqlGuard(runtime.sql`insert into charter_creation_permit_heads select * from charter_creation_permit_heads`, 'OWNER', '42501');
    await sqlGuard(runtime.sql`insert into charter_creation_permit_messages(reservation_id,message_bytes,message_sha256)
      values(${consent.reservationId},${bytes},${sha(bytes)})`, 'OWNER', '42501');
    expect(await f.inventorySnapshot()).toEqual(before);
  } finally { await runtime?.sql.end(); await f.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
});

it('rejects an outer transaction facade and an old repeatable-read writer before invisible-head lookup', async () => {
  const { actor, consent, saved, bytes } = await control(), owner = await f.dedicatedOwner();
  await f.db.transaction(async tx => {
    expect(() => createCharterCreationPermitInventory(tx as unknown as Db)).toThrow(expect.objectContaining(refused('TOP_LEVEL')));
  });
  try {
    await owner.sql`begin isolation level repeatable read`;
    expect(await owner.sql`select * from charter_creation_permit_messages`).toHaveLength(0);
    await f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes);
    // This snapshot sees known zero. RC-first must reject before trusting it.
    expect(await owner.sql`select * from charter_creation_permit_messages`).toHaveLength(0);
    await sqlGuard(owner.sql`insert into charter_creation_permit_messages(reservation_id,message_bytes,message_sha256)
      values(${consent.reservationId},${f.message(saved)},${'00'.repeat(32)})`, 'READ_COMMITTED');
  } finally { await owner.sql`rollback`; await owner.sql.end(); }
  expect((await f.inventory().read(actor.wallet, consent.creationIntentId)).permitInventory.messages[0]!.messageHex).toBe(bytes.toString('hex'));
});

it('rejects direct or nested TEMP head forgery and a copied canonical capture hook on an unrelated source', async () => {
  const { consent } = await control(), owner = await f.dedicatedOwner(), before = await f.inventorySnapshot();
  await sqlGuard(f.sql`insert into charter_creation_permit_heads select * from charter_creation_permit_heads`, 'SOURCE');
  try {
    await owner.sql.unsafe(`create temporary table b6n_attack(value integer);
      create function pg_temp.b6n_attack() returns trigger language plpgsql as $$begin
        insert into public.charter_creation_permit_heads select * from public.charter_creation_permit_heads;
        return NEW;end$$;
      create trigger b6n_attack after insert on b6n_attack for each row execute function pg_temp.b6n_attack();`);
    await sqlGuard(owner.sql`insert into b6n_attack values(1)`, 'SOURCE');
    const [hook] = await f.sql`select p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid='public.charter_creation_reservations'::regclass and t.tgname='charter_creation_reservations_permit_capture'`;
    expect(hook?.proname).toBe('shardkeep_charter_permit_capture');
    await owner.sql.unsafe(`create temporary table b6n_source (like public.charter_creation_reservations including defaults);
      create trigger charter_creation_reservations_permit_capture after insert on b6n_source
      for each row execute function public.shardkeep_charter_permit_capture();`);
    await sqlGuard(owner.sql`insert into b6n_source select * from charter_creation_reservations where id=${consent.reservationId}`, 'TRIGGER');
  } finally { await owner.sql.end(); }
  expect(await f.inventorySnapshot()).toEqual(before);
});

it('holds all recovery and append operations when any required private or canonical source hook is disabled', async () => {
  const { actor, consent, bytes, reservation } = await control(), before = await f.inventorySnapshot();
  const hooks = await f.sql`select c.relname,t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_proc p on p.oid=t.tgfoid where not t.tgisinternal and p.proname like 'shardkeep_charter_permit_%'
    order by c.relname,t.tgname`;
  expect(hooks.some(h => h.relname === 'charter_creation_reservations' && h.tgname === 'charter_creation_reservations_permit_capture')).toBe(true);
  expect(hooks.some(h => h.relname === 'charter_creation_reservations' && h.tgname === 'charter_creation_reservations_permit_complete')).toBe(true);
  for (const hook of hooks) {
    const table = String(hook.relname), trigger = String(hook.tgname);
    expect(table).toMatch(/^charter_creation_[a-z_]+$/); expect(trigger).toMatch(/^charter_creation_[a-z_]+$/);
    await f.sql.unsafe(`alter table public.${table} disable trigger ${trigger}`);
    try {
      await expect(f.inventory().read(actor.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
      await expect(f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes)).rejects.toMatchObject(refused('HELD'));
      await expect(f.inventory().loadForCancellation(consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
      // Existing funded recovery is independent of the prospective inventory.
      expect(await f.service().read(actor.wallet, consent.creationIntentId)).toEqual(reservation);
    } finally { await f.sql.unsafe(`alter table public.${table} enable trigger ${trigger}`); }
  }
  expect(await f.inventorySnapshot()).toEqual(before);
});

it('quarantines a structurally stored raw-owner message with the wrong Keccak payload on read, exact retry and cancellation load', async () => {
  const { actor, consent, bytes } = await control(), bad = Buffer.from(bytes); bad[160] = bad[160]! ^ 1;
  // SQL does not claim to authenticate Solana payloads. A potentially exposed
  // stored candidate must remain counted and held, never disappear as zero.
  await f.sql`insert into charter_creation_permit_messages(reservation_id,message_bytes,message_sha256)
    values(${consent.reservationId},${bad},${sha(bad)})`;
  const before = await f.inventorySnapshot();
  await expect(f.inventory().read(actor.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bad)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().loadForCancellation(consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
  expect(await f.inventorySnapshot()).toEqual(before);
  expect(await f.sql`select message_bytes from charter_creation_permit_messages where reservation_id=${consent.reservationId}`).toEqual([{ message_bytes: bad }]);
});

it('refuses a self-consistent recomputed admission hash when retained JSON no longer matches the protected funding consent', async () => {
  const { actor, consent, saved, bytes } = await control();
  const original = Buffer.from(saved.admission.preimageHex, 'hex'), changed = JSON.parse(original.toString('utf8'));
  changed.consent.clan.name += ' changed'; const forged = Buffer.from(JSON.stringify(changed));
  // Explicit owner fault injection; all original triggers are restored before
  // reads. This tests content comparison, not just the missing-hook fence.
  await f.sql`alter table charter_creation_permit_heads disable trigger user`;
  try { await f.sql`update charter_creation_permit_heads set admission_preimage=${forged},admission_commitment=${sha(forged)}
    where reservation_id=${consent.reservationId}`; }
  finally { await f.sql`alter table charter_creation_permit_heads enable trigger user`; }
  await expect(f.inventory().read(actor.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().loadForCancellation(consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
  expect((await f.sql`select admission_preimage from charter_creation_permit_heads where reservation_id=${consent.reservationId}`)[0]!.admission_preimage).toEqual(forged);
});

it('revalidates the protected actual funding backing on every inventory path after all source hooks are restored', async () => {
  const { actor, consent, reservation, bytes } = await control();
  await f.sql`alter table charter_creation_funding_entries disable trigger user`;
  try { await f.sql`update charter_creation_funding_entries
    set original_entry=jsonb_set(original_entry,'{balance_after}','0'::jsonb) where ledger_id=${reservation.reserveTransactionId}`; }
  finally { await f.sql`alter table charter_creation_funding_entries enable trigger user`; }
  const before = await f.inventorySnapshot();
  await expect(f.inventory().read(actor.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().loadForCancellation(consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
  expect(await f.inventorySnapshot()).toEqual(before);
});
