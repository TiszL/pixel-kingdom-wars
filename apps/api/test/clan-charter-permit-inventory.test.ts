/** Durable unsigned candidates only. Synthetic absence-bank Clock values below
 * do not claim natural expiry, authenticated policy admission or refund rights. */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCharterCreationCancellationReader } from '@shardkeep/chain/charter-creation-cancellation';
import { decodeCharterRegistrationPermit } from '@shardkeep/chain/charter-protocol';
import * as migration from '../src/db/migrate';
import { transferStableBase } from '../src/game/baseOwnership';
import { createCharterCreationReservations } from '../src/game/clanCharterCreationReservations';
import { createCharterCreationPermitInventory, type CharterCreationPermitInventory } from '../src/game/clanCharterCreationPermitInventory';
import { charterPermitInventoryFixture, FIXTURE_EXPIRY, postgresLeaf, sha } from './fixtures/charterPermitInventory';
import { charterPermitCancellationBank } from './fixtures/charterPermitCancellationBank';

let f: Awaited<ReturnType<typeof charterPermitInventoryFixture>>;
beforeEach(async () => { f = await charterPermitInventoryFixture(); }, 120_000);
afterEach(async () => { vi.restoreAllMocks(); await f?.dispose(); }, 120_000);
const refused = (suffix: string) => ({ code: 'CLAN_CHARTER_INVENTORY_' + suffix });
const neverAuthority = { mintAuthorized: false, paymentAuthorized: false, signingAuthorized: false,
  activationAuthorized: false, refundAuthorized: false, reservationReleaseAuthorized: false };

it('creates a durable empty head with actual funding, retaining exact versioned admission bytes and no authority', async () => {
  const { actor, consent, reservation } = await f.fund(), saved = await f.inventory().read(actor.wallet, consent.creationIntentId);
  expect(saved).toMatchObject({ reservation, permitInventory: { version: 1, revision: '0', count: 0, messages: [] }, ...neverAuthority });
  const bytes = Buffer.from(saved.admission.preimageHex, 'hex');
  expect(saved.admission).toEqual({ version: 1, preimageHex: bytes.toString('hex'), commitment: sha(bytes) });
  expect(JSON.parse(bytes.toString('utf8'))).toEqual({ domain: 'SHARDKEEP_CHARTER_CREATION_ADMISSION', version: 1,
    consent, reserveTransactionId: reservation.reserveTransactionId });
  const [head] = await f.sql`select * from charter_creation_permit_heads where reservation_id=${consent.reservationId}`;
  expect(head).toMatchObject({ commitment_version: 1, admission_preimage: bytes, admission_commitment: saved.admission.commitment });
  expect(await f.sql`select * from charter_creation_permit_messages`).toHaveLength(0);
  expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.admission)).toBe(true);
  expect(Object.isFrozen(saved.permitInventory.messages)).toBe(true); expect(Object.isFrozen(saved.reservation.consent.chain)).toBe(true);
});

it('rolls real money and the reservation back if prospective head capture is suppressed, then permits the same funded retry', async () => {
  const control = await f.fund(); await f.inventory().read(control.actor.wallet, control.consent.creationIntentId);
  const actor = await f.actor(), consent = f.consent(actor), before = await f.inventorySnapshot();
  await f.sql.unsafe(`create function public.b6n_skip_head() returns trigger language plpgsql as $$begin return NULL;end$$;
    create trigger aaa_b6n_skip_head before insert on charter_creation_permit_heads for each row execute function public.b6n_skip_head();`);
  try { await expect(f.service().reserve(actor.wallet, consent)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_HELD' }); }
  finally { await f.sql`drop trigger aaa_b6n_skip_head on charter_creation_permit_heads`; }
  expect(await f.inventorySnapshot()).toEqual(before);
  await f.service().reserve(actor.wallet, consent);
  expect((await f.inventory().read(actor.wallet, consent.creationIntentId)).permitInventory.count).toBe(0);
});

it('keeps pre-migration funded intents held rather than adopting their historical absence as a known zero head', async () => {
  await f.dispose(); f = undefined!;
  const prefix = await mkdtemp(join(tmpdir(), 'charter-permit-prefix-'));
  const runMigrations = migration.runMigrations;
  try {
    await cp(fileURLToPath(new URL('../drizzle', import.meta.url)), prefix, { recursive: true });
    const path = join(prefix, 'meta/_journal.json'), journal = JSON.parse(await readFile(path, 'utf8'));
    const inventoryIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0221_charter_creation_permit_inventory');
    expect(inventoryIndex).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, inventoryIndex);
    expect(journal.entries.at(-1)?.tag).toBe('0220_charter_creation_reservations');
    await writeFile(path, JSON.stringify(journal));
    vi.spyOn(migration, 'runMigrations').mockImplementationOnce(db => runMigrations(db, { migrationsFolder: prefix }));
    f = await charterPermitInventoryFixture(); vi.restoreAllMocks();
    expect(await f.sql`select to_regclass('public.charter_creation_permit_heads') name`).toEqual([{ name: null }]);
    const { actor, consent, reservation } = await f.fund();
    await runMigrations(f.db); await runMigrations(f.db);
    expect(await f.service().read(actor.wallet, consent.creationIntentId)).toEqual(reservation);
    expect(await f.service().reserve(actor.wallet, consent)).toEqual(reservation);
    await expect(f.inventory().read(actor.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
    await expect(f.inventory().loadForCancellation(consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
    expect(await f.sql`select * from charter_creation_permit_heads`).toHaveLength(0);
    // The PK and FK are both fresh/valid. Correct canonical old funding bytes
    // still cannot acquire a prospective zero head in this later transaction.
    const [wire] = await f.sql`select convert_to(jsonb_build_object('domain','SHARDKEEP_CHARTER_CREATION_ADMISSION','version',1,
      'consent',consent,'reserveTransactionId',reserve_transaction_id)::text,'UTF8') bytes
      from charter_creation_reservations where id=${consent.reservationId}`;
    const preimage = Buffer.from(wire!.bytes), owner = await f.dedicatedOwner();
    const assertSource = async (work: PromiseLike<unknown>) => {
      const error = await Promise.resolve(work).then(() => null, cause => cause);
      expect(error).not.toBeNull(); expect(postgresLeaf(error)).toEqual({ code: 'P0001', message: 'CLAN_CHARTER_INVENTORY_SOURCE' });
    };
    try {
      await assertSource(owner.sql`insert into charter_creation_permit_heads(reservation_id,commitment_version,admission_preimage,admission_commitment,recorded_at)
        values(${consent.reservationId},1,${preimage},${sha(preimage)},clock_timestamp())`);
      await owner.sql.unsafe(`create temporary table b6n_historical_attack(reservation_id uuid,preimage bytea,commitment text);
        create function pg_temp.b6n_historical_attack() returns trigger language plpgsql as $$begin
          insert into public.charter_creation_permit_heads(reservation_id,commitment_version,admission_preimage,admission_commitment,recorded_at)
          values(NEW.reservation_id,1,NEW.preimage,NEW.commitment,clock_timestamp());return NEW;end$$;
        create trigger b6n_historical_attack after insert on b6n_historical_attack
          for each row execute function pg_temp.b6n_historical_attack();`);
      await assertSource(owner.sql`insert into b6n_historical_attack values(${consent.reservationId},${preimage},${sha(preimage)})`);
    } finally { await owner.sql.end(); }
    expect(await f.sql`select * from charter_creation_permit_heads`).toHaveLength(0);
    await expect(f.inventory().loadForCancellation(consent.creationIntentId)).rejects.toMatchObject(refused('HELD'));
    const next = await f.fund(await f.actor());
    expect((await f.inventory().read(next.actor.wallet, next.consent.creationIntentId)).permitInventory.count).toBe(0);
  } finally { vi.restoreAllMocks(); await rm(prefix, { recursive: true, force: true }); }
}, 120_000);

it('retains the one exact canonical kind5 message and derives its opaque full id, digest, expiry and revision', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId);
  const bytes = f.message(zero), before = await f.snapshot(), decoded = decodeCharterRegistrationPermit(bytes);
  const saved = await f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes);
  expect(saved).toEqual({ ...zero, permitInventory: { version: 1, revision: '1', count: 1,
    messages: [{ messageHex: bytes.toString('hex'), messageSha256: sha(bytes), permitId: Buffer.from(decoded.permitId).toString('hex'), expiry: FIXTURE_EXPIRY }] } });
  expect(await f.snapshot()).toEqual(before);
  const [row] = await f.sql`select message_bytes,message_sha256 from charter_creation_permit_messages where reservation_id=${consent.reservationId}`;
  expect(row).toEqual({ message_bytes: bytes, message_sha256: sha(bytes) });
  expect(Object.isFrozen(saved.permitInventory.messages[0])).toBe(true);
});

it('reopens byte-identical retries and refuses a replacement id or refreshed expiry without mutating the original', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId), bytes = f.message(zero);
  const saved = await f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes), reopened = f.reopen();
  try {
    const inventory = createCharterCreationPermitInventory(reopened.db);
    expect(await inventory.recordPrepared(actor.wallet, consent.creationIntentId, Buffer.from(bytes))).toEqual(saved);
    const before = await f.inventorySnapshot();
    for (const changed of [f.message(zero), f.message(zero, { permitId: bytes.subarray(73, 89), expiry: FIXTURE_EXPIRY + 1n })])
      await expect(inventory.recordPrepared(actor.wallet, consent.creationIntentId, changed)).rejects.toMatchObject(refused('CONFLICT'));
    expect(await inventory.read(actor.wallet, consent.creationIntentId)).toEqual(saved); expect(await f.inventorySnapshot()).toEqual(before);
  } finally { await reopened.sql.end(); }
});

it('rejects malformed first candidates and every original domain, payer and payload substitution without consuming zero', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId), bytes = f.message(zero);
  const bad = [bytes.subarray(0, 160), Buffer.concat([bytes, Buffer.of(0)])];
  for (const offset of [0, 8, 40, 72, 89, 129, 160]) { const b = Buffer.from(bytes); b[offset] = b[offset]! ^ 1; bad.push(b); }
  // A payload using a different full UUID (including its second half) is not the original consent.
  const id = zero.reservation.consent.creationIntentId;
  const altered = { ...zero, reservation: { ...zero.reservation, consent: { ...zero.reservation.consent,
    creationIntentId: id.slice(0, -1) + (id.endsWith('0') ? '1' : '0') } } };
  bad.push(f.message(altered));
  const before = await f.inventorySnapshot();
  for (const candidate of bad) await expect(f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, candidate)).rejects.toMatchObject(refused('INPUT'));
  expect(await f.inventory().read(actor.wallet, consent.creationIntentId)).toEqual(zero); expect(await f.inventorySnapshot()).toEqual(before);
});

it('refuses an unfunded or foreign-payer intent instead of manufacturing an empty inventory', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId), other = await f.actor();
  await expect(f.inventory().read(other.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('PAYER'));
  await expect(f.inventory().recordPrepared(other.wallet, consent.creationIntentId, f.message(zero))).rejects.toMatchObject(refused('PAYER'));
  const absent = randomUUID();
  await expect(f.inventory().read(actor.wallet, absent)).rejects.toMatchObject(refused('HELD'));
  await expect(f.inventory().loadForCancellation(absent)).rejects.toMatchObject(refused('HELD'));
  expect((await f.inventory().read(actor.wallet, consent.creationIntentId)).permitInventory.count).toBe(0);
});

it('preserves the original payer inventory across transfer, disabled admission and a reopened offline application', async () => {
  const { actor, consent, reservation } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId);
  const buyer = await f.actor();
  await transferStableBase(f.db, actor.baseId, actor.wallet, buyer.wallet, actor.deed, { ...actor.proof(buyer.wallet, 101), observedAtMs: Date.now() });
  process.env['PHASE_E_CHARTER_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'false';
  const reopened = f.reopen(), before = await f.snapshot();
  try {
    expect(await createCharterCreationReservations(reopened.db, { newCreationDomain: null }).read(actor.wallet, consent.creationIntentId)).toEqual(reservation);
    const inventory = createCharterCreationPermitInventory(reopened.db);
    expect(await inventory.read(actor.wallet, consent.creationIntentId)).toEqual(zero);
    const recorded = await inventory.recordPrepared(actor.wallet, consent.creationIntentId, f.message(zero));
    expect(recorded).toMatchObject({ reservation, permitInventory: { count: 1 }, ...neverAuthority });
    await expect(inventory.read(buyer.wallet, consent.creationIntentId)).rejects.toMatchObject(refused('PAYER'));
  } finally { await reopened.sql.end(); }
  expect(await f.snapshot()).toEqual(before);
});

it('serializes identical concurrent candidates into one immutable message without another money movement', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId), bytes = f.message(zero);
  const before = await f.snapshot();
  const [a, b] = await Promise.all([f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes),
    f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, Buffer.from(bytes))]);
  expect(a).toEqual(b); expect(a.permitInventory.count).toBe(1);
  expect(await f.sql`select * from charter_creation_permit_messages`).toHaveLength(1); expect(await f.snapshot()).toEqual(before);
});

it('allows exactly one of two competing candidates and makes the loser a conflict against the committed original', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId);
  const candidates = [f.message(zero), f.message(zero)], results = await Promise.allSettled(candidates.map(bytes =>
    f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  const winner = results.findIndex(r => r.status === 'fulfilled'), loser = 1 - winner;
  expect(results[loser]).toMatchObject({ status: 'rejected', reason: refused('CONFLICT') });
  expect((await f.inventory().read(actor.wallet, consent.creationIntentId)).permitInventory.messages[0]!.messageHex).toBe(candidates[winner]!.toString('hex'));
  await expect(f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, candidates[loser]!)).rejects.toMatchObject(refused('CONFLICT'));
  expect(await f.sql`select * from charter_creation_permit_messages`).toHaveLength(1);
});

it('copies candidate bytes before waiting for the canonical reservation lock', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId);
  const bytes = f.message(zero), expected = bytes.toString('hex'), owner = await f.dedicatedOwner();
  let pending: Promise<CharterCreationPermitInventory> | undefined;
  try {
    await owner.sql`begin`; const [pid] = await owner.sql`select pg_backend_pid() pid`;
    await owner.sql`select id from charter_creation_reservations where id=${consent.reservationId} for update`;
    pending = f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes); void pending.catch(() => {});
    await expect.poll(async () => (await f.sql`select pid from pg_stat_activity where datname=current_database()
      and ${Number(pid!.pid)}::int=any(pg_blocking_pids(pid))`).length, { timeout: 10_000 }).toBeGreaterThan(0);
    bytes.fill(0); await owner.sql`commit`;
    expect((await pending).permitInventory.messages[0]!.messageHex).toBe(expected);
  } finally { await owner.sql`rollback`; await pending?.catch(() => {}); await owner.sql.end(); }
});

it('returns a prepared candidate only after its database commit, including deferred work, has completed', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId), blocker = await f.dedicatedOwner();
  await f.sql.unsafe(`create function public.b6n_pause_commit() returns trigger language plpgsql as $$begin
    perform pg_advisory_xact_lock(7300222);return NEW;end$$;
    create constraint trigger zzz_b6n_pause_commit after insert on charter_creation_permit_messages
    deferrable initially deferred for each row execute function public.b6n_pause_commit();`);
  let pending: Promise<unknown> | undefined, settled = false;
  try {
    const [pid] = await blocker.sql`select pg_backend_pid() pid`; await blocker.sql`select pg_advisory_lock(7300222)`;
    pending = f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, f.message(zero));
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await expect.poll(async () => (await f.sql`select pid from pg_stat_activity where datname=current_database()
      and ${Number(pid!.pid)}::int=any(pg_blocking_pids(pid))`).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(settled).toBe(false); expect(await f.sql`select * from charter_creation_permit_messages`).toHaveLength(0);
    await blocker.sql`select pg_advisory_unlock(7300222)`;
    expect(await pending).toMatchObject({ permitInventory: { count: 1 } });
    expect(await f.sql`select * from charter_creation_permit_messages`).toHaveLength(1);
  } finally {
    await blocker.sql`select pg_advisory_unlock(7300222)`; await pending?.catch(() => {}); await blocker.sql.end();
    await f.sql`drop trigger zzz_b6n_pause_commit on charter_creation_permit_messages`;
  }
});

it('pairs a real prospective zero-head loader with B6k while preserving its no-release and paused-recovery semantics', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId);
  const bank = charterPermitCancellationBank(consent, FIXTURE_EXPIRY), request = vi.spyOn(bank.rpc, 'getMultipleAccountsInfoAndContext');
  const read = createCharterCreationCancellationReader(() => bank.rpc, bank.trust, f.inventory().loadForCancellation);
  const observed = await read(consent.creationIntentId);
  expect(observed).toMatchObject({ outcome: 'absent-after-expiry', original: { admissionCommitment: zero.admission.commitment },
    inventory: { version: 1, revision: '0', count: 0, messages: [] }, reservationReleaseAuthorized: false, refundAuthorized: false,
    signingAuthorized: false, paymentAuthorized: false, activationAuthorized: false, inventoryAuthenticated: false });
  expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0]![0]).toHaveLength(14);
  expect((await f.inventory().read(actor.wallet, consent.creationIntentId)).reservation.state).toBe('reserved');
});

it('pairs the complete permanent message with B6k and holds at exact expiry before observing strict elapsed absence', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId), bytes = f.message(zero);
  const saved = await f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes);
  const bank = charterPermitCancellationBank(consent, FIXTURE_EXPIRY), read = createCharterCreationCancellationReader(() => bank.rpc, bank.trust, f.inventory().loadForCancellation);
  await expect(read(consent.creationIntentId)).rejects.toMatchObject({ code: 'LIVE_PERMIT' });
  bank.clock.writeBigInt64LE(FIXTURE_EXPIRY + 1n, 32);
  const observed = await read(consent.creationIntentId);
  expect(observed).toMatchObject({ outcome: 'absent-after-expiry', inventory: { version: 1, revision: '1', count: 1,
    messages: [{ messageHex: bytes.toString('hex'), permitId: saved.permitInventory.messages[0]!.permitId, expiry: FIXTURE_EXPIRY }] },
    reservationReleaseAuthorized: false, refundAuthorized: false });
  expect(await f.inventory().read(actor.wallet, consent.creationIntentId)).toEqual(saved);
});

it('detaches loader message bytes so a consumer cannot rewrite, filter or release the durable candidate', async () => {
  const { actor, consent } = await f.fund(), zero = await f.inventory().read(actor.wallet, consent.creationIntentId), bytes = f.message(zero);
  await f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes);
  const a = await f.inventory().loadForCancellation(consent.creationIntentId);
  expect(a).toEqual({ original: { creationIntentId: consent.creationIntentId, clanId: consent.clanId, payer: consent.payer,
    metadata: consent.metadata, chain: consent.chain, admissionCommitment: zero.admission.commitment },
    permitInventory: { version: 1, revision: '1', count: 1, messages: [bytes] } });
  expect(Object.isFrozen(a)).toBe(true); expect(Object.isFrozen(a.original.chain)).toBe(true); expect(Object.isFrozen(a.permitInventory.messages)).toBe(true);
  a.permitInventory.messages[0]!.fill(0);
  const b = await f.inventory().loadForCancellation(consent.creationIntentId);
  expect(Buffer.from(b.permitInventory.messages[0]!)).toEqual(bytes); expect(b.permitInventory.messages[0]).not.toBe(a.permitInventory.messages[0]);
});

it('stores structurally canonical past and far-future expiries without inventing a signing or expiry policy', async () => {
  for (const expiry of [-1n, (1n << 63n) - 1n]) {
    const { actor, consent } = await f.fund(await f.actor()), zero = await f.inventory().read(actor.wallet, consent.creationIntentId);
    const bytes = f.message(zero, { expiry, permitId: expiry === -1n ? Buffer.alloc(16) : randomBytes(16) });
    expect(await f.inventory().recordPrepared(actor.wallet, consent.creationIntentId, bytes))
      .toMatchObject({ ...neverAuthority, permitInventory: { count: 1, messages: [{ expiry }] } });
    const loaded = await f.inventory().loadForCancellation(consent.creationIntentId);
    expect(loaded.permitInventory).toEqual({ version: 1, revision: '1', count: 1, messages: [bytes] });
  }
});
