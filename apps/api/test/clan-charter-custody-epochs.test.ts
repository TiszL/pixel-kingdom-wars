/** D-153.154 prospective accepted DB custody only. These injected observations
 * are local authority fixtures, never evidence of continuous on-chain custody. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { observationHash } from '../src/game/baseOwnership';
import { createClanCharterCustodyEpochs } from '../src/game/clanCharterCustodyEpochs';
import { ADMIN_DATABASE_URL } from './db-url';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

let f: ReturnType<typeof resourceClaimsDatabase>, actor: string, buyer: string, base: string, deed: string;
const migration = new URL('../drizzle/0218_charter_custody_epochs.sql', import.meta.url);
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
  f = resourceClaimsDatabase(); await f.setup(); actor = Keypair.generate().publicKey.toBase58(); buyer = Keypair.generate().publicKey.toBase58(); base = randomUUID(); deed = Keypair.generate().publicKey.toBase58();
  await f.sql`insert into players(wallet) values(${actor}),(${buyer})`;
  await f.sql`insert into bases(id,owner_wallet,deed_asset_id,deed_mint_asset_id,land_paid_at,status) values(${base},${actor},${deed},${deed},now(),'active')`;
  await f.sql`insert into base_slots(wallet,slot,base_id,active) values(${actor},1,${base},true)`;
  await proof(actor, 'owned', 100n);
}, 120_000);
afterEach(async () => { vi.unstubAllEnvs(); await f?.close(); }, 120_000);
const service = () => createClanCharterCustodyEpochs(f.db);
async function proof(owner: string | null, status: 'owned' | 'mismatch' | 'ineligible' | 'unavailable', slot: bigint | null, ageMs = 0) {
  const [clock] = await f.sql`select date_trunc('milliseconds',clock_timestamp()) at`;
  const at = new Date(new Date(clock!.at).getTime() - ageMs), source = 'charter-custody-fixture';
  const hash = observationHash(deed, owner, status, slot, at);
  const existing = await f.sql`select id from deed_ownership_observations where base_id=${base}`;
  if (existing.length) await f.sql`update deed_ownership_observations set asset_id=${deed},owner=${owner},slot=${slot?.toString() ?? null},checked_at=${at.toISOString()}::timestamptz,source=${source},status=${status}::deed_observation_status,audit_hash=${hash} where base_id=${base}`;
  else await f.sql`insert into deed_ownership_observations(base_id,asset_id,owner,slot,checked_at,source,status,audit_hash) values(${base},${deed},${owner},${slot?.toString() ?? null},${at.toISOString()}::timestamptz,${source},${status}::deed_observation_status,${hash})`;
}
async function journal() { return f.sql`select * from charter_custody_epochs where base_id=${base} order by ordinal`; }
async function ownerUrl() { const [db] = await f.sql`select current_database() name`; const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + db!.name; return url; }

it('starts one server-generated prospective epoch without inventing earlier coverage, and re-enrollment preserves it', async () => {
  const store = service(); expect(Object.keys(store).sort()).toEqual(['enroll', 'read']); expect(Object.isFrozen(store)).toBe(true);
  expect(await store.read(base)).toBeNull();
  const first = await store.enroll(actor, base);
  expect(Object.keys(first).sort()).toEqual(['id', 'evidenceCommitment', 'baseId', 'deedAssetId', 'ownerWallet', 'ordinal', 'authority'].sort());
  expect(first).toMatchObject({ baseId: base, deedAssetId: deed, ownerWallet: actor, ordinal: '1', authority: 'current' });
  expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first.evidenceCommitment).toMatch(/^[0-9a-f]{64}$/);
  const [observation] = await f.sql`select id,audit_hash from deed_ownership_observations where base_id=${base}`;
  expect(first.id).not.toBe(String(observation!.id)); expect(first.evidenceCommitment).not.toBe(observation!.audit_hash);
  expect(await store.enroll(actor, base)).toEqual(first); expect(await store.read(base)).toEqual(first);
  expect(await journal()).toHaveLength(1); expect((await journal())[0]).toMatchObject({ id: first.id, predecessor_id: null, ordinal: '1' });
});

it('requires both initial flags while preserving the journal and passive capture during pause', async () => {
  for (const [multi, charter] of [['false', 'true'], ['true', 'false'], ['TRUE', 'true'], ['true', '1']]) {
    vi.stubEnv('MULTI_BASE_ENABLED', multi); vi.stubEnv('PHASE_E_CHARTER_ENABLED', charter);
    await expect(service().enroll(actor, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_DISABLED' });
  }
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
  const first = await service().enroll(actor, base);
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  expect(await service().enroll(actor, base)).toEqual(first);
  await proof(buyer, 'mismatch', 101n);
  expect(await service().read(base)).toMatchObject({ ownerWallet: buyer, ordinal: '2', authority: 'unavailable' });
  expect((await journal())[0]!.id).toBe(first.id);
});

it('enrolls only an exact paid active owner and active slot with fresh nonfuture positive evidence', async () => {
  await expect(service().enroll(buyer, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_UNAVAILABLE' });
  await f.sql`update bases set land_paid_at=null where id=${base}`;
  await expect(service().enroll(actor, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_UNAVAILABLE' });
  await f.sql`update bases set land_paid_at=now(),status='inactive' where id=${base}`;
  await expect(service().enroll(actor, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_UNAVAILABLE' });
  await f.sql`update bases set status='active' where id=${base}`; await f.sql`update base_slots set active=false where base_id=${base}`;
  await expect(service().enroll(actor, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_UNAVAILABLE' });
  await f.sql`update base_slots set active=true where base_id=${base}`;
  await proof(actor, 'owned', 101n, BASE_OWNERSHIP.mutationFreshnessMs + 1);
  await expect(service().enroll(actor, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_UNAVAILABLE' });
  await proof(actor, 'owned', 102n, -BASE_OWNERSHIP.mutationFreshnessMs);
  await expect(service().enroll(actor, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_UNAVAILABLE' });
  await proof(actor, 'owned', 103n); expect((await service().enroll(actor, base)).authority).toBe('current');
});

it('does not rotate for polling, gameplay, slot changes or unavailable RPC, and never caches current authority', async () => {
  const first = await service().enroll(actor, base), original = await journal();
  await proof(actor, 'owned', 101n); await f.sql`update bases set updated_at=now() where id=${base}`;
  expect(await service().read(base)).toEqual(first);
  await f.sql`update base_slots set active=false where base_id=${base}`;
  expect(await service().read(base)).toEqual({ ...first, authority: 'unavailable' });
  await f.sql`update base_slots set active=true where base_id=${base}`;
  await proof(null, 'unavailable', 101n); expect(await service().read(base)).toEqual({ ...first, authority: 'unavailable' });
  await proof(actor, 'owned', 102n); expect(await service().read(base)).toEqual(first);
  await proof(actor, 'owned', 103n, BASE_OWNERSHIP.mutationFreshnessMs + 1);
  expect(await service().read(base)).toEqual({ ...first, authority: 'unavailable' }); expect(await journal()).toEqual(original);
});

it('retains A-to-B-to-A while the database owner stays A during deferred delivery', async () => {
  const first = await service().enroll(actor, base);
  await proof(buyer, 'mismatch', 101n); const second = (await service().read(base))!;
  expect(second).toMatchObject({ ownerWallet: buyer, ordinal: '2', authority: 'unavailable' }); expect(second.id).not.toBe(first.id);
  await proof(buyer, 'mismatch', 102n); expect(await service().read(base)).toEqual(second);
  await proof(actor, 'owned', 103n); const third = (await service().read(base))!;
  expect(third).toMatchObject({ ownerWallet: actor, ordinal: '3', authority: 'current' }); expect(third.id).not.toBe(first.id);
  expect((await journal()).map(row => row.predecessor_id)).toEqual([null, first.id, second.id]);
  expect((await f.sql`select owner_wallet from bases where id=${base}`)[0]!.owner_wallet).toBe(actor);
});

it('deduplicates a later DB move to the already observed buyer and preserves the old owner history', async () => {
  const first = await service().enroll(actor, base); await proof(buyer, 'mismatch', 101n); const second = (await service().read(base))!;
  await f.sql`update bases set owner_wallet=${buyer} where id=${base}`;
  await f.sql`delete from base_slots where base_id=${base}`; await f.sql`insert into base_slots(wallet,slot,base_id,active) values(${buyer},1,${base},true)`;
  await proof(buyer, 'owned', 102n); expect(await service().read(base)).toEqual({ ...second, authority: 'current' });
  expect((await journal()).map(row => row.id)).toEqual([first.id, second.id]);
});

it('invalidates positive ineligible evidence and requires a new epoch even when the same owner returns', async () => {
  const first = await service().enroll(actor, base); await proof(actor, 'ineligible', 101n);
  expect((await service().read(base))!.authority).toBe('unavailable'); const stopped = await journal();
  expect(stopped).toHaveLength(2); expect(stopped[1]).toMatchObject({ kind: 'invalidated', predecessor_id: first.id });
  await proof(actor, 'ineligible', 102n); expect(await journal()).toEqual(stopped);
  await proof(actor, 'owned', 103n); const returned = (await service().read(base))!;
  expect(returned).toMatchObject({ ownerWallet: actor, ordinal: '3', authority: 'current' }); expect(returned.id).not.toBe(first.id);
});

it('refuses stale or contradictory positive evidence and malformed hashes rather than minting an epoch', async () => {
  await service().enroll(actor, base); await proof(buyer, 'mismatch', 101n); const original = await journal();
  await expect(proof(actor, 'owned', 100n)).rejects.toThrow('CLAN_CHARTER_CUSTODY_SOURCE');
  await expect(proof(actor, 'owned', 101n)).rejects.toThrow('CLAN_CHARTER_CUSTODY_SOURCE');
  await expect(proof(buyer, 'ineligible', 101n)).rejects.toThrow('CLAN_CHARTER_CUSTODY_SOURCE');
  await expect(f.sql`update deed_ownership_observations set audit_hash=${'ab'.repeat(32)} where base_id=${base}`).rejects.toThrow('CLAN_CHARTER_CUSTODY_SOURCE');
  expect(await journal()).toEqual(original);
});

it('invalidates source deletion and unsupported DB identity changes without replacing them with invented evidence', async () => {
  const first = await service().enroll(actor, base); await f.sql`delete from deed_ownership_observations where base_id=${base}`;
  expect((await service().read(base))!.authority).toBe('unavailable'); expect((await journal())[0]!.id).toBe(first.id);
  await proof(actor, 'owned', 101n); const recovered = (await service().read(base))!; expect(recovered.id).not.toBe(first.id);
  await f.sql`update bases set owner_wallet=${buyer} where id=${base}`;
  expect((await service().read(base))!.authority).toBe('unavailable'); expect((await journal())[0]!.id).toBe(first.id);
  await f.sql`update bases set owner_wallet=${actor} where id=${base}`;
  expect((await service().read(base))!.authority).toBe('unavailable');
  await proof(actor, 'owned', 102n); expect((await service().read(base))!.id).not.toBe(recovered.id);
});

it('rolls source updates and custody appends back together, and migration replay never resets history', async () => {
  const first = await service().enroll(actor, base), original = await journal();
  await expect(f.sql.begin(async tx => { await tx`delete from deed_ownership_observations where base_id=${base}`; throw Error('fixture rollback'); })).rejects.toThrow('fixture rollback');
  expect(await journal()).toEqual(original); expect(await service().read(base)).toEqual(first);
  await f.sql.begin(async tx => { for (const statement of readFileSync(migration, 'utf8').split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement); });
  expect(await journal()).toEqual(original); expect(await service().enroll(actor, base)).toEqual(first);
});

it('serializes concurrent enrollment into one original rather than issuing two initial epochs', async () => {
  const [first, second] = await Promise.all([service().enroll(actor, base), service().enroll(actor, base)]);
  expect(first).toEqual(second); expect(await journal()).toHaveLength(1);
});

it('denies direct owner journal/head forgery, mutation and truncation', async () => {
  await service().enroll(actor, base); const original = await journal();
  for (const table of ['charter_custody_epochs', 'charter_custody_heads']) {
    await expect(f.sql.unsafe(`delete from ${table}`)).rejects.toThrow('CLAN_CHARTER_CUSTODY_IMMUTABLE');
    await expect(f.sql.unsafe(`truncate ${table} cascade`)).rejects.toThrow('CLAN_CHARTER_CUSTODY_IMMUTABLE');
    await expect(f.sql.unsafe(`insert into ${table} select * from ${table}`)).rejects.toMatchObject({ code: '42501' });
  }
  await expect(f.sql`update charter_custody_epochs set owner_wallet=owner_wallet`).rejects.toThrow('CLAN_CHARTER_CUSTODY_IMMUTABLE');
  await expect(f.sql`update charter_custody_heads set ordinal=ordinal+1`).rejects.toMatchObject({ code: '42501' });
  expect(await journal()).toEqual(original);
});

it('rejects outer transactions and opens fresh RC reads even if the owner connection defaults to RR', async () => {
  await expect(f.db.transaction(async tx => createClanCharterCustodyEpochs(tx as unknown as Db))).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_TOP_LEVEL' });
  const owner = createDb((await ownerUrl()).toString(), { max: 1 });
  try { await owner.sql`set default_transaction_isolation='repeatable read'`; const first = await createClanCharterCustodyEpochs(owner.db).enroll(actor, base);
    await proof(null, 'unavailable', 100n); expect(await createClanCharterCustodyEpochs(owner.db).read(base)).toEqual({ ...first, authority: 'unavailable' });
  } finally { await owner.sql.end(); }
});

it('refuses an old RR source write before checking whether its snapshot can see enrollment', async () => {
  // Enter the facade first so the RED is the explicit stub, not missing SQL.
  expect(await service().read(base)).toBeNull();
  await expect(f.sql.begin('isolation level repeatable read', async tx => {
    expect(await tx`select * from charter_custody_heads`).toHaveLength(0);
    await service().enroll(actor, base);
    expect(await tx`select * from charter_custody_heads`).toHaveLength(0);
    await tx`update deed_ownership_observations set checked_at=checked_at where base_id=${base}`;
  })).rejects.toThrow('CLAN_CHARTER_CUSTODY_READ_COMMITTED');
  await expect(f.sql.begin('isolation level repeatable read', async tx => { await tx`update bases set owner_wallet=owner_wallet where id=${base}`; })).rejects.toThrow('CLAN_CHARTER_CUSTODY_READ_COMMITTED');
});

it('keeps private capabilities closed after accidental grants and rejects copied trigger origin', async () => {
  await service().enroll(actor, base); const role = 'charter_custody_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  let runtime: ReturnType<typeof createDb> | undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    await f.sql.unsafe(`grant usage on schema public to ${role};grant all on charter_custody_epochs,charter_custody_heads to ${role};grant execute on function shardkeep_charter_custody_enroll(text,uuid,integer),shardkeep_charter_custody_read(uuid,integer) to ${role}`);
    const url = await ownerUrl(); url.username = role; url.password = password; runtime = createDb(url.toString());
    await expect(createClanCharterCustodyEpochs(runtime.db).enroll(actor, base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_OWNER' });
    await expect(createClanCharterCustodyEpochs(runtime.db).read(base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_OWNER' });
    await expect(runtime.sql`select shardkeep_charter_custody_enroll(${actor},${base}::uuid,${BASE_OWNERSHIP.mutationFreshnessMs})`).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.sql`select shardkeep_charter_custody_read(${base}::uuid,${BASE_OWNERSHIP.mutationFreshnessMs})`).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.sql`insert into charter_custody_epochs select * from charter_custody_epochs`).rejects.toMatchObject({ code: '42501' });
  } finally { await runtime?.sql.end(); await f.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
  await f.sql`create table copied_charter_observations(like deed_ownership_observations including defaults)`;
  await f.sql`create trigger deed_observations_charter_custody after insert or update or delete on copied_charter_observations for each row execute function shardkeep_charter_custody_observation()`;
  await expect(f.sql`insert into copied_charter_observations select * from deed_ownership_observations`).rejects.toThrow('CLAN_CHARTER_CUSTODY_TRIGGER');
});

it('holds damaged history, head or capture hooks instead of blessing a mutually consistent rewrite', async () => {
  await service().enroll(actor, base);
  await f.sql`alter table charter_custody_heads disable trigger charter_custody_heads_guard`;
  try { await f.sql`update charter_custody_heads set ordinal=ordinal+1 where base_id=${base}`; }
  finally { await f.sql`alter table charter_custody_heads enable trigger charter_custody_heads_guard`; }
  await expect(service().read(base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_HELD' });
  await f.sql`alter table charter_custody_heads disable trigger charter_custody_heads_guard`;
  try { await f.sql`update charter_custody_heads set ordinal=ordinal-1 where base_id=${base}`; }
  finally { await f.sql`alter table charter_custody_heads enable trigger charter_custody_heads_guard`; }
  const [original] = await journal();
  await f.sql`alter table charter_custody_epochs disable trigger charter_custody_epochs_guard`;
  try { await f.sql`update charter_custody_epochs set evidence_commitment=${'ab'.repeat(32)} where base_id=${base}`; }
  finally { await f.sql`alter table charter_custody_epochs enable trigger charter_custody_epochs_guard`; }
  await expect(service().read(base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_HELD' });
  await f.sql`alter table charter_custody_epochs disable trigger charter_custody_epochs_guard`;
  try { await f.sql`update charter_custody_epochs set evidence_commitment=${original!.evidence_commitment} where base_id=${base}`; }
  finally { await f.sql`alter table charter_custody_epochs enable trigger charter_custody_epochs_guard`; }
  await f.sql`alter table deed_ownership_observations disable trigger deed_observations_charter_custody`;
  try { await expect(service().read(base)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CUSTODY_HELD' }); }
  finally { await f.sql`alter table deed_ownership_observations enable trigger deed_observations_charter_custody`; }
});

it('keeps an existing RC source writer transparent before enrollment and captures through exact definer hooks afterward', async () => {
  const role = 'charter_source_' + randomUUID().replaceAll('-', ''), password = randomUUID();
  let runtime: ReturnType<typeof createDb> | undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try {
    // Existing observation/action-capture triggers use ordinary gameplay tables.
    // The writer gets those legacy permissions, never private custody storage.
    await f.sql.unsafe(`grant usage on schema public to ${role};grant select,insert,update on all tables in schema public to ${role};grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role};revoke all on charter_custody_sources,charter_custody_epochs,charter_custody_heads from ${role}`);
    const url = await ownerUrl(); url.username = role; url.password = password; runtime = createDb(url.toString());
    await runtime.sql`update bases set updated_at=now() where id=${base}`;
    await runtime.sql`update deed_ownership_observations set checked_at=checked_at where base_id=${base}`;
    expect(await journal()).toHaveLength(0);
    await expect(runtime.sql`select * from charter_custody_heads`).rejects.toMatchObject({ code: '42501' });
    await service().enroll(actor, base);
    const [clock] = await f.sql`select date_trunc('milliseconds',clock_timestamp()) at`;
    const at = new Date(clock!.at), hash = observationHash(deed, buyer, 'mismatch', 101n, at);
    await runtime.sql`update deed_ownership_observations set owner=${buyer},slot=101,status='mismatch',checked_at=${at.toISOString()}::timestamptz,audit_hash=${hash} where base_id=${base}`;
    expect(await service().read(base)).toMatchObject({ ownerWallet: buyer, ordinal: '2', authority: 'unavailable' });
    await expect(runtime.sql`select shardkeep_charter_custody_advance(${base}::uuid)`).rejects.toMatchObject({ code: '42501' });
  } finally { await runtime?.sql.end(); await f.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
});

it('refuses owner TEMP wrappers that forge epochs, floors or fabricated loss preimages at valid trigger depth', async () => {
  const first = await service().enroll(actor, base), original = await journal();
  const heads = await f.sql`select * from charter_custody_heads`;
  const connection = createDb((await ownerUrl()).toString(), { max: 1 });
  try {
  await connection.sql.unsafe(`create temporary table custody_attack(base_id uuid,mode text);
    create function pg_temp.custody_attack() returns trigger language plpgsql as $$
    declare e public.charter_custody_epochs%rowtype;v jsonb;
    begin
      select ep.* into strict e from public.charter_custody_heads h join public.charter_custody_epochs ep on ep.id=h.epoch_id where h.base_id=NEW.base_id;
      if NEW.mode='epoch' then
        e.predecessor_id:=e.id;e.id:=gen_random_uuid();e.ordinal:=e.ordinal+1;
        e.evidence:=jsonb_build_object('forged',true);e.evidence_commitment:=public.shardkeep_charter_custody_commit(e);
        insert into public.charter_custody_epochs select e.*;
        update public.charter_custody_heads set epoch_id=e.id,ordinal=e.ordinal where base_id=NEW.base_id;
      elsif NEW.mode='floor' then
        update public.charter_custody_heads set floor_slot=floor_slot+1 where base_id=NEW.base_id;
      else
        if NEW.mode='deletion' then
          v:=jsonb_build_object('reason','observation_deleted','observation',jsonb_build_object('id',-99));
        else
          v:=jsonb_build_object('reason','base_identity','before',jsonb_build_object('owner_wallet','invented'),
            'after',(select to_jsonb(b) from public.bases b where b.id=NEW.base_id));
        end if;
        e.predecessor_id:=e.id;e.id:=gen_random_uuid();e.ordinal:=e.ordinal+1;
        e.kind:='invalidated';e.evidence:=v;e.evidence_commitment:=public.shardkeep_charter_custody_commit(e);
        insert into public.charter_custody_epochs select e.*;
      end if;return NEW;
    end $$;
    create trigger custody_attack after insert on custody_attack for each row execute function pg_temp.custody_attack();`);
  for (const mode of ['epoch', 'floor', 'deletion', 'base']) {
    await expect(connection.sql`insert into custody_attack values(${base},${mode})`).rejects.toThrow('CLAN_CHARTER_CUSTODY_SOURCE');
  }
  expect(await journal()).toEqual(original); expect(await f.sql`select * from charter_custody_heads`).toEqual(heads);
  expect(await service().read(base)).toEqual(first);
  } finally { await connection.sql.end(); }
});

it('refuses source TRUNCATE before a same-owner insert could revive the original epoch', async () => {
  expect(await service().read(base)).toBeNull();
  await expect(f.sql.begin('isolation level repeatable read', async tx => { await tx`truncate deed_ownership_observations`; })).rejects.toThrow('CLAN_CHARTER_CUSTODY_READ_COMMITTED');
  const first = await service().enroll(actor, base), original = await journal();
  await expect(f.sql`truncate deed_ownership_observations`).rejects.toThrow('CLAN_CHARTER_CUSTODY_SOURCE_TRUNCATE');
  await expect(f.sql`truncate bases cascade`).rejects.toThrow('CLAN_CHARTER_CUSTODY_SOURCE_TRUNCATE');
  expect(await journal()).toEqual(original); expect(await service().read(base)).toEqual(first);
  expect((await f.sql`select count(*) n from deed_ownership_observations where base_id=${base}`)[0]!.n).toBe('1');
});

it('rolls back an isolated canonical epoch append when its matching head is missing at commit', async () => {
  const first = await service().enroll(actor, base), original = await journal();
  const connection = createDb((await ownerUrl()).toString(), { max: 1 });
  try {
  await connection.sql.unsafe(`create temporary table custody_orphan(base_id uuid);
    create function pg_temp.custody_orphan() returns trigger language plpgsql as $$ begin
      insert into public.charter_custody_epochs(base_id) values(NEW.base_id);return NEW;
    end $$;
    create trigger custody_orphan after insert on custody_orphan for each row execute function pg_temp.custody_orphan();`);
  // Deliberate owner-level source damage creates a real pending transition.
  // All guards are restored before testing the independent commit invariant.
  let orphanInserted = false;
  await expect(connection.sql.begin(async tx => {
    const [clock] = await tx`select date_trunc('milliseconds',clock_timestamp()) at`;
    const at = new Date(clock!.at), hash = observationHash(deed, buyer, 'mismatch', 101n, at);
    await tx`alter table deed_ownership_observations disable trigger deed_observations_charter_custody`;
    await tx`update deed_ownership_observations set owner=${buyer},slot=101,status='mismatch',checked_at=${at.toISOString()}::timestamptz,audit_hash=${hash} where base_id=${base}`;
    // Later source constraints queue events on this table. Run those checks
    // before ALTER, then restore deferred timing for the orphan commit proof.
    await tx`set constraints all immediate`;
    await tx`set constraints all deferred`;
    await tx`alter table deed_ownership_observations enable trigger deed_observations_charter_custody`;
    await tx`insert into custody_orphan values(${base})`;
    orphanInserted = true;
  })).rejects.toThrow('CLAN_CHARTER_CUSTODY_HELD');
  expect(orphanInserted).toBe(true);
  expect(await journal()).toEqual(original); expect(await service().read(base)).toEqual(first);
  } finally { await connection.sql.end(); }
});
