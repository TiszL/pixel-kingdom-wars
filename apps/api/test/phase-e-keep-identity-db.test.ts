/**
 * the content pipeline-queued PostgreSQL guard contract. AUTHORED, NOT EXECUTED by MS-S.
 * Applies the unnumbered identity SQL to a disposable local database containing
 * intentionally minimal history tables. This exercises PostgreSQL parsing,
 * trigger execution, privileges and real competing sessions. It does NOT prove
 * integration with production history schemas/triggers, migration ordering,
 * provisioned application roles or the full migration journal. Those gates
 * remain separately queued. No runMigrations, chain calls, keys or signatures.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import { ADMIN_DATABASE_URL } from './db-url';

type Client = ReturnType<typeof postgres>;
type Executor = Pick<Client, 'unsafe'>;

// Reviewed table boundary: 27 transaction/recovery tables plus six unsigned
// input-custody tables. Never replace this with an indiscriminate mining_* scan:
// seeded policies/coverage are not transaction history.
const HISTORY_TABLES = [
  'mining_publication_attempts',
  'mining_publication_manifests',
  'mining_publication_settlements',
  'mining_publication_signing_reservations',
  'mining_publication_signed_wires',
  'mining_ingot_dispositions',
  'mining_claim_entitlement_headers',
  'mining_claim_entitlement_leaves',
  'mining_claim_preparations',
  'mining_claim_signed_wires',
  'mining_claim_receipts',
  'mining_claim_failures',
  'mining_claim_continuations',
  'mining_tax_claim_preparations',
  'mining_tax_claim_signed_wires',
  'mining_tax_claim_receipts',
  'mining_tax_claim_failures',
  'mining_tax_claim_continuations',
  'keep_equipment_listings',
  'keep_equipment_fills',
  'keep_equipment_listing_cancellations',
  'keep_equipment_payment_preparations',
  'keep_equipment_payment_wires',
  'keep_equipment_deliveries',
  'keep_equipment_fill_releases',
  'mining_contribution_terminals',
  'payment_signature_claims',
  'mining_ingot_epochs',
  'mining_ingot_reservations',
  'mining_ingot_aborts',
  'mining_ingot_releases',
  'mining_contribution_receipts',
  'mining_contribution_lines',
] as const;
type HistoryTable = typeof HISTORY_TABLES[number];

// Public deterministic TEST mint only; it is not a generated keypair, actual
// KEEP v4 address, mint authority or ceremony evidence. Other addresses below
// are the accepted public role/P3 identities; ATA derivation is local and pure.
const testMint = new PublicKey(new Uint8Array(32).fill(41));
const reserveOwner = new PublicKey('CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q');
const binding = {
  singleton: true,
  cluster: 'devnet',
  genesis_hash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  keep_mint: testMint.toBase58(),
  economy_program: '5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr',
  craft_program: '4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59',
  treasury: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
  reserve_owner: reserveOwner.toBase58(),
  reserve_ata: getAssociatedTokenAddressSync(testMint, reserveOwner, true).toBase58(),
  binding_receipt_sha256: 'a'.repeat(64), // TEST receipt digest, not an attestation.
};
const columns = Object.keys(binding);
const insertSql = 'insert into public.phase_e_chain_identity (' + columns.join(',') +
  ') values (' + columns.map((_, index) => '$' + (index + 1)).join(',') + ') returning *';

function bind(sql: Executor) {
  // Deliberately omit bound_at: only the trigger may derive it.
  return sql.unsafe(insertSql, Object.values(binding));
}
function seedHistory(sql: Executor, table: HistoryTable, consumerKind = 'keep_equipment_market') {
  // Every minimal fixture includes BOTH exact tuple columns and an exact tuple
  // JSON envelope. Matching identity is deliberately still forbidden history.
  return sql.unsafe('insert into public.' + table +
    ' (id,consumer_kind,keep_mint,economy_program,program_id,genesis_hash,reserve_owner,artifact,publication,receipt)' +
    ' values ($1,$2,$3,$4,$4,$5,$6,$7::jsonb,$7::jsonb,$7::jsonb)',
  [randomUUID(), consumerKind, binding.keep_mint, binding.economy_program,
    binding.genesis_hash, binding.reserve_owner, JSON.stringify(binding)]);
}
async function rows(sql: Executor) {
  return sql.unsafe('select * from public.phase_e_chain_identity order by singleton');
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(run: (f: {
  sql: Client;
  writer: Client;
  createRole: () => Promise<string>;
}) => Promise<void>) {
  // No shared database is reset or migrated. Fail closed unless the configured
  // admin endpoint is loopback and a maintenance/test database.
  const adminUrl = new URL(ADMIN_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname) ||
    !(adminUrl.pathname === '/postgres' || adminUrl.pathname.endsWith('_test'))) {
    throw Error('PHASE_E_IDENTITY_FIXTURE_LOCAL_DATABASE_REQUIRED');
  }
  const name = 'phase_e_identity_' + randomUUID().replaceAll('-', '') + '_test';
  const url = new URL(adminUrl); url.pathname = '/' + name;
  const options = { max: 1, onnotice: () => {},
    connection: { statement_timeout: 5000, default_transaction_isolation: 'read committed' as const } };
  const admin = postgres(adminUrl.toString(), options);
  const sql = postgres(url.toString(), options);
  const writer = postgres(url.toString(), options);
  const roles: string[] = [];
  let created = false;
  try {
    await admin.unsafe('create database ' + name);
    created = true;
    for (const table of HISTORY_TABLES) {
      // This is a history-presence fixture, NOT a replacement for the real DDL.
      // No production trigger, constraint, role or data is disabled or copied.
      await sql.unsafe('create table public.' + table + ' (' +
        'id text primary key,consumer_kind text,keep_mint text,economy_program text,' +
        'program_id text,genesis_hash text,reserve_owner text,artifact jsonb,publication jsonb,receipt jsonb)');
    }
    // Legacy v3 placeholders prove their existence/data are not mistaken for
    // Phase E history. Their actual guards are a separate integration gate.
    for (const table of ['economy_chain_identity', 'deposits', 'withdrawals',
      'withdrawal_attempts', 'keep_custody_journal', 'ledger_transactions',
      'merkle_snapshots', 'merkle_leaves', 'outbox']) {
      await sql.unsafe('create table public.' + table + ' (fixture_record text not null)');
      await sql.unsafe('insert into public.' + table + ' values ($1)', ['legacy-v3-preserved']);
    }
    const draft = readFileSync(new URL(
      '../../../docs/phase-e/ms-s-corrections/identity/02-phase-e-chain-identity.sql',
      import.meta.url), 'utf8');
    await sql.begin(async tx => {
      for (const statement of draft.split('--> statement-breakpoint').filter(part => part.trim())) {
        await tx.unsafe(statement);
      }
    });
    const createRole = async () => {
      const role = 'phase_e_identity_runtime_' + randomUUID().replaceAll('-', '');
      await admin.unsafe('create role ' + role + ' nologin');
      roles.push(role);
      return role;
    };
    await run({ sql, writer, createRole });
  } finally {
    // The only managed resources have generated names owned by this fixture.
    // No FORCE/session termination is used; a leaked session fails cleanup.
    await Promise.all([sql.end(), writer.end()]);
    try {
      if (created) await admin.unsafe('drop database ' + name);
      for (const role of roles) await admin.unsafe('drop role ' + role);
    } finally { await admin.end(); }
  }
}

describe('Phase E identity SQL contract on minimal PostgreSQL history tables (queued)', () => {
  it('creates no identity, preserves legacy rows and derives the first owner timestamp', async () => fixture(async f => {
    expect(HISTORY_TABLES).toHaveLength(33);
    expect(new Set(HISTORY_TABLES).size).toBe(33);
    expect(await rows(f.sql)).toEqual([]);
    const before = await f.sql.unsafe('select clock_timestamp() as at');
    const inserted = await bind(f.sql);
    const after = await f.sql.unsafe('select clock_timestamp() as at');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject(binding);
    expect(inserted[0]).not.toHaveProperty('gems_reserve_owner');
    expect(inserted[0]).not.toHaveProperty('gems_reserve_ata');
    expect(inserted[0]!.bound_at).toBeInstanceOf(Date);
    expect(inserted[0]!.bound_at.getTime()).toBeGreaterThanOrEqual(before[0]!.at.getTime());
    expect(inserted[0]!.bound_at.getTime()).toBeLessThanOrEqual(after[0]!.at.getTime());
    for (const table of ['economy_chain_identity', 'deposits', 'withdrawals',
      'withdrawal_attempts', 'keep_custody_journal', 'ledger_transactions',
      'merkle_snapshots', 'merkle_leaves', 'outbox']) {
      expect(await f.sql.unsafe('select * from public.' + table))
        .toEqual([{ fixture_record: 'legacy-v3-preserved' }]);
    }
  }), 30_000);

  it.each(['gems_reserve_owner', 'gems_reserve_ata'])('refuses obsolete %s writes', async column => fixture(async f => {
    const obsolete = 'insert into public.phase_e_chain_identity (' + columns.join(',') + ',' + column +
      ') values (' + columns.map((_, index) => '$' + (index + 1)).join(',') + ',$' + (columns.length + 1) + ')';
    await expect(f.sql.unsafe(obsolete, [...Object.values(binding), binding.reserve_owner]))
      .rejects.toMatchObject({ code: '42703' });
    expect(await rows(f.sql)).toEqual([]);
  }), 30_000);

  it.each(HISTORY_TABLES)('refuses any existing %s history, including the exact binding tuple', async table => fixture(async f => {
    await seedHistory(f.sql, table);
    const before = await f.sql.unsafe('select * from public.' + table);
    await expect(bind(f.sql)).rejects.toThrow('PHASE_E_IDENTITY_HISTORY');
    expect(await rows(f.sql)).toEqual([]);
    expect(await f.sql.unsafe('select * from public.' + table)).toEqual(before);
  }), 30_000);

  it('allows deposit-only permanent signatures but refuses standalone market signatures', async () => fixture(async f => {
    await seedHistory(f.sql, 'payment_signature_claims', 'deposit');
    const original = await f.sql.unsafe('select * from public.payment_signature_claims');
    // SAVEPOINT/transaction rollback keeps the singleton empty without ever
    // disabling its trigger or deleting a bound identity.
    const rollback = Error('FIXTURE_ROLLBACK_BINDING');
    await expect(f.sql.begin(async tx => {
      expect(await bind(tx)).toHaveLength(1);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await rows(f.sql)).toEqual([]);
    await seedHistory(f.sql, 'payment_signature_claims', 'keep_equipment_market');
    await expect(bind(f.sql)).rejects.toThrow('PHASE_E_IDENTITY_HISTORY');
    const saved = await f.sql.unsafe('select * from public.payment_signature_claims');
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(expect.arrayContaining(original));
  }), 30_000);

  it('rejects a caller-supplied binding timestamp', async () => fixture(async f => {
    const withTimestamp = 'insert into public.phase_e_chain_identity (' + columns.join(',') +
      ',bound_at) values (' + columns.map((_, index) => '$' + (index + 1)).join(',') +
      ',$' + (columns.length + 1) + ')';
    await expect(f.sql.unsafe(withTimestamp, [...Object.values(binding), '2000-01-01T00:00:00Z']))
      .rejects.toThrow('PHASE_E_IDENTITY_DERIVED_FIELDS');
    expect(await rows(f.sql)).toEqual([]);
  }), 30_000);

  it.each(['repeatable read', 'serializable'])('refuses first binding at %s isolation', async isolation => fixture(async f => {
    await expect(f.sql.begin(async tx => {
      await tx.unsafe('set transaction isolation level ' + isolation);
      await bind(tx);
    })).rejects.toThrow('PHASE_E_IDENTITY_READ_COMMITTED');
    expect(await rows(f.sql)).toEqual([]);
  }), 30_000);

  it('does not let broad runtime grants insert, update, delete or truncate', async () => fixture(async f => {
    const role = await f.createRole();
    await f.sql.unsafe('grant usage on schema public to ' + role);
    await f.sql.unsafe('grant all on all tables in schema public to ' + role);
    await expect(f.sql.begin(async tx => {
      await tx.unsafe('set local role ' + role);
      await bind(tx);
    })).rejects.toThrow('PHASE_E_IDENTITY_OWNER');
    await bind(f.sql);
    const original = await rows(f.sql);
    for (const command of [
      'update public.phase_e_chain_identity set keep_mint=keep_mint',
      'delete from public.phase_e_chain_identity',
      'truncate public.phase_e_chain_identity',
    ]) {
      await expect(f.sql.begin(async tx => {
        await tx.unsafe('set local role ' + role);
        await tx.unsafe(command);
      })).rejects.toThrow(/PHASE_E_IDENTITY_(OWNER|IMMUTABLE)/);
      expect(await rows(f.sql)).toEqual(original);
    }
  }), 30_000);

  it('refuses SET ROLE impersonation even when current_user is the table owner', async () => fixture(async f => {
    const role = await f.createRole();
    await f.sql.unsafe('grant usage,create on schema public to ' + role);
    await f.sql.unsafe('alter table public.phase_e_chain_identity owner to ' + role);
    await expect(f.sql.begin(async tx => {
      await tx.unsafe('set local role ' + role);
      const identity = await tx.unsafe('select current_user::text actor,session_user::text session,' +
        '(select pg_get_userbyid(relowner)::text from pg_class where oid=' +
        "'public.phase_e_chain_identity'::regclass) owner");
      expect(identity[0]!.actor).toBe(role);
      expect(identity[0]!.owner).toBe(role);
      expect(identity[0]!.session).not.toBe(role);
      await bind(tx);
    })).rejects.toThrow('PHASE_E_IDENTITY_OWNER');
    expect(await rows(f.sql)).toEqual([]);
  }), 30_000);

  it('makes the owner binding immutable, including no-op updates and conflicting inserts', async () => fixture(async f => {
    await bind(f.sql);
    const original = await rows(f.sql);
    for (const command of [
      'update public.phase_e_chain_identity set keep_mint=keep_mint',
      "update public.phase_e_chain_identity set binding_receipt_sha256=repeat('b',64)",
      'delete from public.phase_e_chain_identity',
      'truncate public.phase_e_chain_identity',
    ]) {
      await expect(f.sql.unsafe(command)).rejects.toThrow('PHASE_E_IDENTITY_IMMUTABLE');
      expect(await rows(f.sql)).toEqual(original);
    }
    await expect(bind(f.sql)).rejects.toMatchObject({ code: '23505' });
    expect(await rows(f.sql)).toEqual(original);
  }), 30_000);

  it.each(['mining_publication_signed_wires', 'mining_ingot_releases', 'payment_signature_claims'] as const)(
    'refuses an uncommitted %s writer with 55P03 rather than binding an old snapshot', async table => fixture(async f => {
      const written = latch(), release = latch();
      const transaction = f.writer.begin(async tx => {
        await seedHistory(tx, table);
        written.release();
        await release.promise;
      });
      // Observe early SQL failure as well as successful arrival at the latch.
      const early = transaction.then(() => { throw Error('writer ended before release'); });
      try {
        await Promise.race([written.promise, early]);
        await expect(bind(f.sql)).rejects.toMatchObject({ code: '55P03' });
        expect(await rows(f.sql)).toEqual([]);
      } finally {
        release.release();
        await transaction;
        // Handle the derived completion branch after the latch wins.
        await early.catch(() => {});
      }
      await expect(bind(f.sql)).rejects.toThrow('PHASE_E_IDENTITY_HISTORY');
    }), 30_000);

  it.each(['mining_publication_attempts', 'mining_contribution_receipts', 'payment_signature_claims'] as const)(
    'holds the %s writer fence through the binding transaction', async table => fixture(async f => {
      const bound = latch(), release = latch();
      const transaction = f.sql.begin(async tx => {
        await bind(tx);
        bound.release();
        await release.promise;
      });
      const early = transaction.then(() => { throw Error('binder ended before release'); });
      try {
        await Promise.race([bound.promise, early]);
        await expect(f.writer.begin(async tx => {
          await tx.unsafe("set local lock_timeout='250ms'");
          await seedHistory(tx, table);
        })).rejects.toMatchObject({ code: '55P03' });
      } finally {
        release.release();
        await transaction;
        await early.catch(() => {});
      }
      expect(await rows(f.sql)).toHaveLength(1);
      expect(await f.writer.unsafe('select * from public.' + table)).toEqual([]);
      // The lock ends at commit. This only proves first-bind serialization; the
      // production admission/identity checks on later writes remain queued.
      await seedHistory(f.writer, table);
      expect(await f.writer.unsafe('select * from public.' + table)).toHaveLength(1);
    }), 30_000);
});
