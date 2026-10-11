/** Private prepared admission, never a signature or current signing authority. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PHASE_E_CHARTER_ADMISSION, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { decodeCharterRegistrationPermit, encodeCharterRegistrationPermit } from '@shardkeep/chain/charter-protocol';
import * as migration from '../src/db/migrate';
import { refreshBaseOwnership, transferStableBase } from '../src/game/baseOwnership';
import { createCharterCreationTerminal } from '../src/game/clanCharterCreationTerminal';
import { createCharterCreationPolicyAdmission } from '../src/game/clanCharterCreationPolicyAdmission';
import { charterCreationPolicyFixture, noPolicyAuthority, outcome, pausePolicyBank, policyRefusal, sha,
  waitForPolicyLock, type PolicyFixture } from './fixtures/charterCreationPolicyAdmission';
import { terminalBank, TERMINAL_CLOCK } from './fixtures/charterCreationTerminal';

let activeFixture: PolicyFixture | undefined;
function fixture(): PolicyFixture {
  if (!activeFixture) throw Error('Policy fixture setup did not complete');
  return activeFixture;
}
// Node and the disposable PostgreSQL server each reject future observations.
// Sample both actual clocks for the fixture proof; production freshness checks
// keep advancing normally, with no frozen clock or arbitrary backdating margin.
async function transferObservedAt(f: PolicyFixture): Promise<number> {
  const [row] = await f.sql`select floor(extract(epoch from clock_timestamp()) * 1000)::text observed_ms`;
  return Math.min(Date.now(), Number(row!.observed_ms));
}
const policy = PHASE_E_CHARTER_ADMISSION.v1;
beforeEach(async () => { activeFixture = undefined; activeFixture = await charterCreationPolicyFixture(); }, 120_000);
afterEach(async () => {
  vi.restoreAllMocks(); const current = activeFixture; activeFixture = undefined;
  await current?.dispose();
}, 120_000);

it('records exactly one current-policy candidate from finalized Clock without spending, burning or advancing quests', async () => {
  const f = fixture();
  const p = await f.policyPrepared(); await f.seedSpendQuests(); const before = await f.snapshot(), quests = await f.spendProgress(p.actor.baseId);
  const result = await p.service().admit(p.actor.wallet, p.consent.creationIntentId);
  expect(result).toMatchObject({ version: 1, original: { consent: p.consent, reserveTransactionId: p.reservation.reserveTransactionId },
    admission: p.zero.admission, policy: { version: policy.policyVersion, currentSigner: p.bank.current.toBase58(),
      observation: { unixTimestamp: TERMINAL_CLOCK, expectedCurrentSigner: p.bank.current.toBase58(), source: { accounts: expect.any(Array) } } },
    timing: { startedMs: 0, recordSampleMs: 0, elapsedMs: 0 }, ...noPolicyAuthority });
  expect(result.id).toMatch(/^[0-9a-f-]{36}$/); expect(policy.issuedPermitTtlSec).toBeLessThanOrEqual(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec);
  const bytes = Buffer.from(result.candidate.messageHex, 'hex'), decoded = decodeCharterRegistrationPermit(bytes);
  expect(bytes).toHaveLength(161); expect(encodeCharterRegistrationPermit(decoded)).toEqual(bytes);
  expect(bytes).toEqual(f.message(p.zero, { permitId: Buffer.from(result.candidate.permitId, 'hex'), expiry: TERMINAL_CLOCK + BigInt(policy.issuedPermitTtlSec) }));
  expect(result.candidate).toEqual({ messageHex: bytes.toString('hex'), messageSha256: sha(bytes),
    permitId: Buffer.from(decoded.permitId).toString('hex'), expiry: TERMINAL_CLOCK + BigInt(policy.issuedPermitTtlSec) });
  expect(result.policy.observation.source.accounts).toHaveLength(10);
  expect(p.bank.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
  expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.messages).toEqual([result.candidate]);
  expect(await f.policyRows()).toHaveLength(1); expect(await f.snapshot()).toEqual(before); expect(await f.spendProgress(p.actor.baseId)).toEqual(quests);
  for (const value of [result, result.original, result.original.consent.chain, result.candidate, result.policy,
    result.policy.observation.source.accounts[0], result.timing]) expect(Object.isFrozen(value)).toBe(true);
});

it('reopens the original record offline after transfer and disabled flags without replacing its candidate or timing', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), saved = await p.service().admit(p.actor.wallet, p.consent.creationIntentId), buyer = await f.actor();
  await transferStableBase(f.db, p.actor.baseId, p.actor.wallet, buyer.wallet, p.actor.deed, { ...p.actor.proof(buyer.wallet, 101), observedAtMs: await transferObservedAt(f) });
  process.env['PHASE_E_CHARTER_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'false';
  const reopened = f.reopen();
  try {
    const offline = createCharterCreationPolicyAdmission(reopened.db, { chain: null, monotonicNow: () => { throw Error('Historical replay sampled a new clock'); } });
    expect(await offline.read(p.actor.wallet, p.consent.creationIntentId)).toEqual(saved);
    expect(await offline.admit(p.actor.wallet, p.consent.creationIntentId)).toEqual(saved);
    await expect(offline.read(buyer.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('PAYER'));
  } finally { await reopened.sql.end(); }
  expect(await f.policyRows()).toHaveLength(1); expect(p.bank.rpc.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
});

it('refuses untrusted domains, noncurrent grace keys, either pause and unavailable RPC without consuming genuine zero', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), before = await f.inventorySnapshot();
  for (const mode of ['domain', 'previous', 'policy-pause', 'craft-pause', 'unavailable']) {
    p.bank.authority({ priorGrace: mode === 'previous', paused: mode === 'policy-pause' });
    const control = p.bank.rows.find(row => row.address.toBase58() === p.consent.chain.craftControl)!; control.data[137] = mode === 'craft-pause' ? 1 : 0;
    const trust = { ...p.bank.trust };
    if (mode === 'domain') trust.expectedGenesisHash = Keypair.generate().publicKey.toBase58();
    const connect = mode === 'unavailable' ? () => { throw Error('Unavailable fixture transport'); } : p.bank.connect;
    const service = createCharterCreationPolicyAdmission(f.db, { chain: { connect, trust,
      expectedCurrentSigner: (mode === 'previous' ? p.bank.previous : p.bank.current).toBase58() }, monotonicNow: p.monotonicNow });
    await expect(service.admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
    expect(await f.inventorySnapshot()).toEqual(before); expect(await f.policyRows()).toHaveLength(0);
  }
});

it('counts RPC latency at full monotonic precision and rejects nonfinite, negative or backwards process time', async () => {
  const f = fixture();
  for (const [elapsed, accepted] of [[policy.observationMaxAgeMs, true], [policy.observationMaxAgeMs + 0.9, false], [policy.observationMaxAgeMs + 1, false]] as const) {
    const p = await f.policyPrepared(await f.actor()), original = p.bank.rpc.getGenesisHash.bind(p.bank.rpc);
    p.bank.rpc.getGenesisHash = vi.fn(async () => { p.setTick(elapsed); return original(); });
    const result = outcome(p.service().admit(p.actor.wallet, p.consent.creationIntentId));
    if (accepted) expect(await result).toMatchObject({ ok: true, value: { timing: { startedMs: 0, recordSampleMs: elapsed, elapsedMs: elapsed } } });
    else expect(await result).toMatchObject({ ok: false, error: policyRefusal('STALE') });
    expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.count).toBe(accepted ? 1 : 0);
  }
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const p = await f.policyPrepared(await f.actor()); p.setTick(invalid);
    await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('STALE'));
    expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.count).toBe(0);
  }
  const p = await f.policyPrepared(await f.actor()), original = p.bank.rpc.getGenesisHash.bind(p.bank.rpc); p.setTick(50);
  p.bank.rpc.getGenesisHash = vi.fn(async () => { p.setTick(49); return original(); });
  await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('STALE'));
  expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.count).toBe(0);
}, 120_000);

it('copies application trust and expected key before awaited RPC and returns recursively detached facts', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), chain = { ...p.bank.chain, trust: { ...p.bank.trust } };
  const service = createCharterCreationPolicyAdmission(f.db, { chain, monotonicNow: p.monotonicNow }), gate = pausePolicyBank(p.bank);
  const pending = outcome(service.admit(p.actor.wallet, p.consent.creationIntentId));
  try {
    await Promise.race([gate.arrived, pending.then(result => { if (!result.ok) throw result.error; throw Error('Admission returned before actual policy bank'); })]);
    chain.expectedCurrentSigner = Keypair.generate().publicKey.toBase58();
    chain.trust.expectedGenesisHash = Keypair.generate().publicKey.toBase58();
    gate.release(); const result = await pending;
    expect(result).toMatchObject({ ok: true, value: { policy: { currentSigner: p.bank.current.toBase58() } } });
    if (!result.ok) throw result.error;
    const saved = result.value; p.bank.row.data.fill(0); p.bank.clock.fill(0);
    expect(saved.policy.observation.domain.genesisHash).toBe(p.consent.chain.genesisHash);
    expect(saved.policy.observation.authority.currentPolicyKey).toBe(p.bank.current.toBase58());
    expect(saved.policy.observation.unixTimestamp).toBe(TERMINAL_CLOCK);
    expect(await createCharterCreationPolicyAdmission(f.db, { chain: null }).read(p.actor.wallet, p.consent.creationIntentId)).toEqual(saved);
  } finally { gate.release(); await pending; gate.restore(); }
});

it('rechecks age, admission flags and active custody after an actual original-base row-lock wait', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), owner = await f.dedicatedOwner();
  try {
    for (const mode of ['age', 'flags', 'slot']) {
      await p.actor.refresh(p.actor.wallet, 101); p.setTick(0);
      await owner.sql`begin`; const [pid] = await owner.sql`select pg_backend_pid() pid`;
      await owner.sql`select id from bases where id=${p.actor.baseId} for update`;
      const pending = outcome(p.service().admit(p.actor.wallet, p.consent.creationIntentId));
      try {
        await waitForPolicyLock(f, Number(pid!.pid), pending);
        if (mode === 'age') p.setTick(policy.observationMaxAgeMs + 0.9);
        if (mode === 'flags') process.env['PHASE_E_CHARTER_ENABLED'] = 'false';
        if (mode === 'slot') await owner.sql`update base_slots set active=false where base_id=${p.actor.baseId}`;
        await owner.sql`commit`;
        expect(await pending).toMatchObject({ ok: false, error: policyRefusal(mode === 'age' ? 'STALE' : 'HELD') });
      } finally { await owner.sql`rollback`; await pending; process.env['PHASE_E_CHARTER_ENABLED'] = 'true'; }
      await f.sql`update base_slots set active=true where base_id=${p.actor.baseId}`;
      expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.count).toBe(0);
      expect(await f.policyRows()).toHaveLength(0);
    }
  } finally { await owner.sql.end(); }
}, 120_000);

it('rolls both reached private writes back when the final post-write sample becomes stale or backwards', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), owner = await f.dedicatedOwner(), mutex = 1640225;
  const originalGenesis = p.bank.rpc.getGenesisHash.bind(p.bank.rpc);
  // The real AFTER INSERT runs only after both proposed record and candidate
  // physically exist. The outside clock changes while that exact write waits.
  await f.sql.unsafe(`create function public.policy_fixture_after_message() returns trigger language plpgsql as $$declare retained jsonb;begin
    select record into retained from public.charter_creation_policy_admissions where reservation_id=NEW.reservation_id;
    if not found then raise exception 'POLICY_FIXTURE_MISSING_RECORD';end if;
    if (retained#>>'{timing,startedMs}')::numeric is distinct from 0
      or (retained#>>'{timing,recordSampleMs}')::numeric is distinct from TG_ARGV[0]::numeric then
      raise exception 'POLICY_FIXTURE_WRONG_RECORD_SAMPLE';end if;
    perform pg_advisory_xact_lock(${mutex});return NEW;end$$;`);
  try {
    for (const [recordTick, finalTick] of [[0, policy.observationMaxAgeMs + 0.9], [0, -1], [50, 49]] as const) {
      await f.sql`drop trigger if exists zzz_policy_fixture_after_message on charter_creation_permit_messages`;
      await f.sql.unsafe(`create trigger zzz_policy_fixture_after_message after insert on charter_creation_permit_messages
        for each row execute function public.policy_fixture_after_message('${recordTick}');`);
      p.bank.rpc.getGenesisHash = vi.fn(async () => { p.setTick(recordTick); return originalGenesis(); });
      p.setTick(0); await p.actor.refresh(p.actor.wallet, 101); await owner.sql`select pg_advisory_lock(${mutex})`;
      const [pid] = await owner.sql`select pg_backend_pid() pid`, pending = outcome(p.service().admit(p.actor.wallet, p.consent.creationIntentId));
      try {
        await waitForPolicyLock(f, Number(pid!.pid), pending);
        p.setTick(finalTick); await owner.sql`select pg_advisory_unlock(${mutex})`;
        expect(await pending).toMatchObject({ ok: false, error: policyRefusal('STALE') });
      } finally { await owner.sql`select pg_advisory_unlock(${mutex})`; await pending; }
      expect(await f.policyRows()).toHaveLength(0); expect(await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(p.zero);
    }
  } finally {
    p.bank.rpc.getGenesisHash = originalGenesis;
    await f.sql`drop trigger if exists zzz_policy_fixture_after_message on charter_creation_permit_messages`; await owner.sql.end();
  }
}, 120_000);

it('replays admitted terminal history offline and holds a never-admitted terminal before opening RPC', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), saved = await p.service().admit(p.actor.wallet, p.consent.creationIntentId);
  const inventory = await f.inventory().read(p.actor.wallet, p.consent.creationIntentId), minted = terminalBank(inventory, true);
  expect((await createCharterCreationTerminal(f.db, { chain: minted.chain }).recover(p.actor.wallet, p.consent.creationIntentId)).state).toBe('activated');
  process.env['PHASE_E_CHARTER_ENABLED'] = 'false';
  const offline = createCharterCreationPolicyAdmission(f.db, { chain: null });
  expect(await offline.read(p.actor.wallet, p.consent.creationIntentId)).toEqual(saved);
  expect(await offline.admit(p.actor.wallet, p.consent.creationIntentId)).toEqual(saved);
  process.env['PHASE_E_CHARTER_ENABLED'] = 'true';
  const q = await f.policyPrepared(await f.actor()), absence = terminalBank(q.zero);
  expect((await createCharterCreationTerminal(f.db, { chain: absence.chain }).recover(q.actor.wallet, q.consent.creationIntentId)).state).toBe('cancelled_unpaid');
  await expect(q.service().admit(q.actor.wallet, q.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  expect(q.bank.connect).not.toHaveBeenCalled(); expect(await q.service().read(q.actor.wallet, q.consent.creationIntentId)).toBeNull();
  expect(await f.policyRows()).toHaveLength(1);
});

it('derives expiry from positive finalized Clock with checked int64 addition rather than local wall time', async () => {
  const f = fixture();
  const maximum = (1n << 63n) - 1n, lastClock = maximum - BigInt(policy.issuedPermitTtlSec);
  for (const clock of [lastClock, lastClock + 1n, 0n, -1n]) {
    const p = await f.policyPrepared(await f.actor()); p.bank.clock.writeBigInt64LE(clock, 32);
    if (clock === lastClock) expect((await p.service().admit(p.actor.wallet, p.consent.creationIntentId)).candidate.expiry).toBe(maximum);
    else await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
    expect((await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).permitInventory.count).toBe(clock === lastClock ? 1 : 0);
  }
}, 120_000);

it('requires the original paid active source and exact still-current custody epoch without replacing consent after loss or ABA', async () => {
  const f = fixture();
  const p = await f.policyPrepared(), buyer = await f.actor(), before = p.zero;
  await refreshBaseOwnership(f.db, p.actor.baseId, async () => null, p.actor.collection);
  await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  await p.actor.refresh(); const restored = await p.actor.custody.read(p.actor.baseId);
  expect(restored).not.toBeNull(); if (!restored) throw Error('Fresh original custody must remain enrolled');
  expect(restored.id).toBe(p.actor.epoch.id);
  await f.sql`update base_slots set active=false where base_id=${p.actor.baseId}`;
  await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  await f.sql`update base_slots set active=true where base_id=${p.actor.baseId}`;
  await f.sql`update bases set land_paid_at=null where id=${p.actor.baseId}`;
  await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  await f.sql`update bases set land_paid_at=now() where id=${p.actor.baseId}`;
  await transferStableBase(f.db, p.actor.baseId, p.actor.wallet, buyer.wallet, p.actor.deed, { ...p.actor.proof(buyer.wallet, 101), observedAtMs: await transferObservedAt(f) });
  await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  await transferStableBase(f.db, p.actor.baseId, buyer.wallet, p.actor.wallet, p.actor.deed, { ...p.actor.proof(p.actor.wallet, 102), observedAtMs: await transferObservedAt(f) });
  const returned = await p.actor.custody.read(p.actor.baseId);
  expect(returned).not.toBeNull(); if (!returned) throw Error('Returned custody must retain its new epoch');
  expect(returned.id).not.toBe(p.actor.epoch.id);
  await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  expect(await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(before); expect(await f.policyRows()).toHaveLength(0);
  const q = await f.policyPrepared(await f.actor()), replacementDeed = Keypair.generate().publicKey.toBase58();
  await f.sql`update bases set deed_asset_id=${replacementDeed},deed_mint_asset_id=${replacementDeed} where id=${q.actor.baseId}`;
  await expect(q.service().admit(q.actor.wallet, q.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
  expect(await f.inventory().read(q.actor.wallet, q.consent.creationIntentId)).toEqual(q.zero);
});

it('never adopts an existing unsigned candidate even when canonical, expired or far in the future', async () => {
  const f = fixture();
  for (const expiry of [-1n, TERMINAL_CLOCK + 1_000_000n]) {
    const p = await f.policyPrepared(await f.actor()), bytes = f.message(p.zero, { expiry });
    const saved = await f.inventory().recordPrepared(p.actor.wallet, p.consent.creationIntentId, bytes);
    await expect(p.service().admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
    expect(p.bank.connect).not.toHaveBeenCalled(); expect(await p.service().read(p.actor.wallet, p.consent.creationIntentId)).toBeNull();
    expect(await f.inventory().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(saved);
    expect((await f.inventory().loadForCancellation(p.consent.creationIntentId)).permitInventory.messages).toEqual([bytes]);
  }
  expect(await f.policyRows()).toHaveLength(0);
});

it('holds historical funding without a prospective inventory head while retaining the original funding reader', async () => {
  let f = fixture();
  activeFixture = undefined; await f.dispose();
  const prefix = await mkdtemp(join(tmpdir(), 'charter-policy-prefix-')), runMigrations = migration.runMigrations;
  try {
    await cp(fileURLToPath(new URL('../drizzle', import.meta.url)), prefix, { recursive: true });
    const path = join(prefix, 'meta/_journal.json'), journal = JSON.parse(await readFile(path, 'utf8'));
    const inventoryIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0221_charter_creation_permit_inventory');
    expect(inventoryIndex).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, inventoryIndex);
    expect(journal.entries.at(-1)?.tag).toBe('0220_charter_creation_reservations');
    await writeFile(path, JSON.stringify(journal));
    vi.spyOn(migration, 'runMigrations').mockImplementationOnce(db => runMigrations(db, { migrationsFolder: prefix }));
    f = await charterCreationPolicyFixture(); activeFixture = f; vi.restoreAllMocks();
    expect(await f.sql`select to_regclass('public.charter_creation_permit_heads') name`).toEqual([{ name: null }]);
    const p = await f.fund();
    await runMigrations(f.db); expect(await f.service().read(p.actor.wallet, p.consent.creationIntentId)).toEqual(p.reservation);
    const offline = createCharterCreationPolicyAdmission(f.db, { chain: null });
    await expect(offline.admit(p.actor.wallet, p.consent.creationIntentId)).rejects.toMatchObject(policyRefusal('HELD'));
    expect(await f.sql`select * from charter_creation_permit_heads`).toHaveLength(0); expect(await f.policyRows()).toHaveLength(0);
  } finally { vi.restoreAllMocks(); await rm(prefix, { recursive: true, force: true }); }
}, 120_000);
