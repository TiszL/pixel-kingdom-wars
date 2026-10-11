/** Private consistency and pairing guards, not authentication against an owner
 * replacing DDL/application trust. Injected damage restores every hook first. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PHASE_E_CHARTER_ADMISSION } from '@shardkeep/shared';
import { createCharterAdmissionReader } from '@shardkeep/chain/charter-admission';
import { createDb, type Db } from '../src/db/client';
import { createCharterCreationPolicyAdmission } from '../src/game/clanCharterCreationPolicyAdmission';
import { charterCreationPolicyFixture, noPolicyAuthority, policyRefusal, postgresLeaf, sha,
  type PolicyFixture, type PreparedPolicy } from './fixtures/charterCreationPolicyAdmission';

let activeFixture: PolicyFixture | undefined;
function fixture(): PolicyFixture {
  if (!activeFixture) throw Error('Policy fixture setup did not complete');
  return activeFixture;
}
beforeEach(async () => { activeFixture = undefined; activeFixture = await charterCreationPolicyFixture(); }, 120_000);
afterEach(async () => {
  vi.restoreAllMocks(); const current = activeFixture; activeFixture = undefined;
  await current?.dispose();
}, 120_000);
const json = (v: unknown) => JSON.stringify(v, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
async function guard(work: PromiseLike<unknown>, suffix: string, code = 'P0001') {
  expect(postgresLeaf(await Promise.resolve(work).then(() => null, error => error)))
    .toEqual({ code, message: 'CLAN_CHARTER_POLICY_' + suffix });
}
async function control() {
  const f = fixture();
  const p = await f.policyPrepared(), saved = await p.service().admit(p.actor.wallet, p.consent.creationIntentId);
  return { ...p, saved };
}
async function proposed(p: PreparedPolicy) {
  const f = fixture();
  const observed = await createCharterAdmissionReader(p.bank.connect, p.bank.trust, p.bank.current.toBase58())();
  const expiry = observed.unixTimestamp + BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec), bytes = f.message(p.zero, { expiry });
  return { bytes, record: { version: 1, id: randomUUID(), original: { consent: p.consent, reserveTransactionId: p.reservation.reserveTransactionId },
    admission: p.zero.admission, candidate: { messageHex: bytes.toString('hex'), messageSha256: sha(bytes),
      permitId: bytes.subarray(73, 89).toString('hex'), expiry },
    policy: { version: 1, currentSigner: p.bank.current.toBase58(), observation: observed },
    timing: { startedMs: 0, recordSampleMs: 0, elapsedMs: 0 }, ...noPolicyAuthority } };
}

it('rejects transaction facades, stale snapshots and an accidentally over-granted nonowner before trusting private rows', async () => {
  const f = fixture();
  await f.db.transaction(async tx => {
    expect(() => createCharterCreationPolicyAdmission(tx as unknown as Db, { chain: null }))
      .toThrow(expect.objectContaining(policyRefusal('TOP_LEVEL')));
  });
  const p = await f.policyPrepared(), owner = await f.dedicatedOwner();
  let saved: Awaited<ReturnType<ReturnType<typeof p.service>['admit']>>;
  try {
    await owner.sql`begin isolation level repeatable read`;
    expect(await owner.sql`select * from charter_creation_policy_admissions`).toHaveLength(0);
    saved = await p.service().admit(p.actor.wallet, p.consent.creationIntentId);
    expect(await owner.sql`select * from charter_creation_policy_admissions`).toHaveLength(0);
    await guard(owner.sql`select public.shardkeep_charter_policy_read(${p.actor.wallet},${p.consent.creationIntentId}::uuid)`, 'READ_COMMITTED');
  } finally { await owner.sql`rollback`; await owner.sql.end(); }
  const role = 'policy_' + randomUUID().replaceAll('-', ''), password = randomUUID(); let runtime: ReturnType<typeof createDb> | undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    await f.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};
      grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
    const url = await f.ownerUrl(); url.username = role; url.password = password; runtime = createDb(url.toString());
    const facade = createCharterCreationPolicyAdmission(runtime.db, { chain: null });
    await expect(facade.read(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('OWNER'));
    await expect(facade.admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('OWNER'));
    await guard(runtime.sql`insert into charter_creation_policy_admissions select * from charter_creation_policy_admissions`, 'OWNER', '42501');
  } finally { await runtime?.sql.end(); await f.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
  expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(saved!);
});

it('refuses direct and nested TEMP adoption of a real older candidate using a fresh admission primary key', async () => {
  const f = fixture();
  await control(); const p = await f.policyPrepared(await f.actor()), candidate = await proposed(p);
  await f.inventory().recordPrepared(p.actor.wallet, p.consent.creationIntentId, candidate.bytes);
  const before = await f.inventorySnapshot(), owner = await f.dedicatedOwner();
  await guard(f.sql`insert into charter_creation_policy_admissions(id,reservation_id,record,recorded_at)
    values(${candidate.record.id},${p.consent.reservationId},${json(candidate.record)}::jsonb,clock_timestamp())`, 'SOURCE');
  try {
    await owner.sql.unsafe(`create temporary table policy_attack(id uuid,reservation_id uuid,record jsonb);
      create function pg_temp.policy_attack() returns trigger language plpgsql as $$begin
        insert into public.charter_creation_policy_admissions(id,reservation_id,record,recorded_at)
          values(NEW.id,NEW.reservation_id,NEW.record,clock_timestamp());return NEW;end$$;
      create trigger policy_attack after insert on policy_attack for each row execute function pg_temp.policy_attack();`);
    await guard(owner.sql`insert into policy_attack values(${candidate.record.id},${p.consent.reservationId},${json(candidate.record)}::jsonb)`, 'SOURCE');
  } finally { await owner.sql.end(); }
  expect(await f.inventorySnapshot()).toEqual(before); expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toBeNull();
  expect(await f.sql`select id from charter_creation_policy_admissions where reservation_id=${p.consent.reservationId}`).toHaveLength(0);
});

it('requires deferred exact candidate pairing after the actual admission INSERT rather than permitting an orphan or changed message', async () => {
  const f = fixture();
  await control();
  for (const mode of ['absent', 'different']) {
    const p = await f.policyPrepared(await f.actor()), candidate = await proposed(p); let recordReached = false, messageReached = false;
    const before = await f.inventorySnapshot();
    await guard(f.sql.begin(async tx => {
      const rows = await tx`insert into charter_creation_policy_admissions(id,reservation_id,record,recorded_at)
        values(${candidate.record.id},${p.consent.reservationId},${json(candidate.record)}::jsonb,clock_timestamp()) returning id`;
      expect(rows).toEqual([{ id: candidate.record.id }]); recordReached = true;
      if (mode === 'different') {
        const other = f.message(p.zero, { expiry: candidate.record.candidate.expiry });
        await tx`insert into charter_creation_permit_messages(reservation_id,message_bytes,message_sha256)
          values(${p.consent.reservationId},${other},${sha(other)})`; messageReached = true;
      }
    }), 'PAIRING');
    expect(recordReached).toBe(true); expect(messageReached).toBe(mode === 'different');
    expect(await f.inventorySnapshot()).toEqual(before);
    expect(await f.sql`select id from charter_creation_policy_admissions where reservation_id=${p.consent.reservationId}`).toHaveLength(0);
  }
});

it('keeps admitted records immutable and rejects the real private guard when copied to a TEMP source', async () => {
  const f = fixture();
  const p = await control(), before = await f.policyRows(), owner = await f.dedicatedOwner();
  await guard(f.sql`update charter_creation_policy_admissions set record=record`, 'IMMUTABLE');
  await guard(f.sql`delete from charter_creation_policy_admissions`, 'IMMUTABLE');
  await guard(f.sql`truncate charter_creation_policy_admissions cascade`, 'IMMUTABLE');
  try {
    const [hook] = await f.sql`select p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where t.tgrelid='charter_creation_policy_admissions'::regclass and t.tgname='charter_creation_policy_admissions_guard'`;
    expect(hook?.proname).toBe('shardkeep_charter_policy_private');
    await owner.sql.unsafe(`create temporary table policy_copy(like public.charter_creation_policy_admissions including defaults);
      create trigger charter_creation_policy_admissions_guard before insert or update or delete on policy_copy
        for each row execute function public.shardkeep_charter_policy_private();`);
    await guard(owner.sql`insert into policy_copy select * from charter_creation_policy_admissions`, 'TRIGGER');
  } finally { await owner.sql.end(); }
  expect(await f.policyRows()).toEqual(before); expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(p.saved);
});

it('holds every historical path on damaged backing, equal wrong-Keccak candidates or missing source hooks without filtering exposure', async () => {
  const f = fixture();
  const p = await control(), originalRows = await f.policyRows(), hooks = await f.sql`select c.relname,t.tgname from pg_trigger t
    join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and
    (t.tgrelid='charter_creation_policy_admissions'::regclass or t.tgname in
      ('charter_creation_reservations_permit_complete','ledger_transactions_charter_creation_capture')) order by c.relname,t.tgname`;
  expect(hooks.map(h => h.tgname)).toEqual(expect.arrayContaining(['charter_creation_policy_admissions_guard',
    'charter_creation_policy_admissions_no_truncate', 'charter_creation_policy_admissions_complete']));
  for (const hook of hooks) {
    const table = String(hook.relname), name = String(hook.tgname);
    expect(table).toMatch(/^(?:charter_creation_[a-z_]+|ledger_transactions)$/); expect(name).toMatch(/^[a-z_]+$/);
    await f.sql.unsafe(`alter table ${table} disable trigger ${name}`);
    try {
      await expect(p.service().read(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
      await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
    } finally { await f.sql.unsafe(`alter table ${table} enable trigger ${name}`); }
    expect((await f.sql`select tgenabled from pg_trigger where tgrelid=${table}::regclass and tgname=${name}`)[0]!.tgenabled).toBe('O');
  }
  expect(await f.policyRows()).toEqual(originalRows);
  const bad = Buffer.from(p.saved.candidate.messageHex, 'hex'); bad[160] = bad[160]! ^ 1;
  const record = JSON.parse(json(p.saved)); record.candidate.messageHex = bad.toString('hex'); record.candidate.messageSha256 = sha(bad);
  await f.sql`alter table charter_creation_policy_admissions disable trigger user`;
  await f.sql`alter table charter_creation_permit_messages disable trigger user`;
  try {
    await f.sql`update charter_creation_policy_admissions set record=${json(record)}::jsonb where reservation_id=${p.consent.reservationId}`;
    await f.sql`update charter_creation_permit_messages set message_bytes=${bad},message_sha256=${sha(bad)} where reservation_id=${p.consent.reservationId}`;
  } finally {
    await f.sql`alter table charter_creation_policy_admissions enable trigger user`;
    await f.sql`alter table charter_creation_permit_messages enable trigger user`;
  }
  const damaged = await f.inventorySnapshot();
  await expect(p.service().read(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  await expect(f.inventory().loadForCancellation(p.consent.creationIntentId)).rejects.toMatchObject({ code: 'CLAN_CHARTER_INVENTORY_HELD' });
  expect(await f.inventorySnapshot()).toEqual(damaged);
});

it('rejects retained observation, original, preimage, expiry, timing and authority-shape substitutions after hooks are restored', async () => {
  const f = fixture();
  const p = await control(), original = JSON.parse(json(p.saved));
  for (const mode of ['original', 'preimage', 'key', 'domain', 'clock', 'expiry', 'timing', 'authority', 'extra']) {
    const record = structuredClone(original);
    if (mode === 'original') record.original.consent.clan.name += ' changed';
    if (mode === 'preimage') record.admission.preimageHex += '00';
    if (mode === 'key') record.policy.observation.authority.currentPolicyKey = p.bank.previous.toBase58();
    if (mode === 'domain') record.policy.observation.domain.genesisHash = p.bank.previous.toBase58();
    if (mode === 'clock') record.policy.observation.unixTimestamp = String(BigInt(record.policy.observation.unixTimestamp) + 1n);
    if (mode === 'expiry') record.candidate.expiry = String(BigInt(record.candidate.expiry) + 1n);
    if (mode === 'timing') record.timing.elapsedMs = PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs + 0.9;
    if (mode === 'authority') record.signingAuthorized = true;
    if (mode === 'extra') record.policy.unrecognizedOverride = true;
    await f.sql`alter table charter_creation_policy_admissions disable trigger user`;
    try { await f.sql`update charter_creation_policy_admissions set record=${json(record)}::jsonb where reservation_id=${p.consent.reservationId}`; }
    finally { await f.sql`alter table charter_creation_policy_admissions enable trigger user`; }
    await expect(p.service().read(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
    await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  }
  await f.sql`alter table charter_creation_policy_admissions disable trigger user`;
  try { await f.sql`update charter_creation_policy_admissions set record=${json(original)}::jsonb where reservation_id=${p.consent.reservationId}`; }
  finally { await f.sql`alter table charter_creation_policy_admissions enable trigger user`; }
  expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(p.saved);
});
