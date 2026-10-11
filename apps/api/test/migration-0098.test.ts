import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const PREFIX = 'shardkeep_migration_0098_';

interface Journal { entries: Array<{ idx: number; tag: string; when: number }> }

async function disposable(run: (
  conn: ReturnType<typeof createDb>, dir: string, journal: string, databaseUrl: string,
) => Promise<void>): Promise<void> {
  const name = `${PREFIX}${randomUUID().replaceAll('-', '')}_test`;
  if (!new RegExp(`^${PREFIX}[0-9a-f]{32}_test$`).test(name)) throw new Error('unsafe test DB name');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0098-'));
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await cp(MIGRATIONS, dir, { recursive: true });
    const journal = await readFile(path.join(dir, 'meta/_journal.json'), 'utf8');
    conn = createDb(url.toString(), { max: 4 });
    await run(conn, dir, journal, url.toString());
  } finally {
    await conn?.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertInstalled(conn: ReturnType<typeof createDb>): Promise<void> {
  const enumRows = await conn.sql<{ enumlabel: string }[]>`
    SELECT enumlabel FROM pg_enum
    WHERE enumtypid = 'public.two_fa_purpose'::regtype ORDER BY enumsortorder
  `;
  expect(enumRows.map((row) => row.enumlabel)).toEqual(['enroll', 'withdraw', 'totp_recovery']);
  const [facts] = await conn.sql<{
    tableCount: number; activeIndexCount: number; reenrollDefault: string;
    expiresNullable: string; outboxLeaseColumns: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables
       WHERE table_schema='public' AND table_name='totp_recoveries') AS "tableCount",
      (SELECT count(*)::int FROM pg_indexes
       WHERE indexname='totp_recoveries_one_active_wallet_uq') AS "activeIndexCount",
      (SELECT column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='players'
         AND column_name='totp_reenrollment_required') AS "reenrollDefault",
      (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema='public' AND table_name='totp_recoveries'
         AND column_name='expires_at') AS "expiresNullable",
      (SELECT count(*)::int FROM information_schema.columns
       WHERE table_schema='public' AND table_name='outbox'
         AND column_name IN ('delivery_lease_token', 'delivery_lease_expires_at')) AS "outboxLeaseColumns"
  `;
  expect(facts).toEqual({
    tableCount: 1,
    activeIndexCount: 1,
    reenrollDefault: 'false',
    expiresNullable: 'NO',
    outboxLeaseColumns: 2,
  });
  const [allowance] = await conn.sql<{ definition: string }[]>`
    SELECT pg_get_functiondef(
      'public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint)'::regprocedure
    ) AS definition
  `;
  expect(allowance?.definition).toContain('shardkeep:withdrawal-wallet');
  expect(allowance?.definition.indexOf('shardkeep:withdrawal-wallet'))
    .toBeLessThan(allowance!.definition.indexOf('withdrawal-cap:'));
}

describe('migration 0098 authenticator recovery', { timeout: FRESH_DB_CASE_MS }, () => {
  it('upgrades the immediately previous journal head inside one transaction', async () => {
    await disposable(async (conn, dir, fullJournal) => {
      const prior = JSON.parse(fullJournal) as Journal;
      // "Immediately previous head" = every entry BEFORE 0098, not "everything but
      // 0098": drizzle applies only entries newer than the ledger's last `when`,
      // so a later migration (0099+) applied first would silently skip 0098 on
      // the second run and this test would stop proving the upgrade.
      const head = prior.entries.findIndex((entry) => entry.tag === '0098_totp_recovery');
      expect(head).toBeGreaterThan(0);
      prior.entries = prior.entries.slice(0, head);
      expect(prior.entries.some((entry) => entry.tag === '0098_totp_recovery')).toBe(false);
      await writeFile(path.join(dir, 'meta/_journal.json'), `${JSON.stringify(prior, null, 2)}\n`);
      await migrate(conn.db, { migrationsFolder: dir });
      const wallet = `rolling-${randomUUID()}`;
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      await conn.sql`
        INSERT INTO email_otps
          (player_wallet, purpose, code_hash, expires_at)
        VALUES (${wallet}, 'withdraw', 'legacy-hash', now() + interval '5 minutes')
      `;

      await writeFile(path.join(dir, 'meta/_journal.json'), fullJournal);
      await migrate(conn.db, { migrationsFolder: dir });
      await assertInstalled(conn);
      const [preserved] = await conn.sql<{ purpose: string }[]>`
        SELECT purpose::text AS purpose FROM email_otps WHERE player_wallet=${wallet}
      `;
      expect(preserved?.purpose).toBe('withdraw');
      // Rolling compatibility: an old binary's player insert omits the additive
      // latch and receives the safe false default after migration.
      const second = `rolling-old-writer-${randomUUID()}`;
      await conn.sql`INSERT INTO players (wallet) VALUES (${second})`;
      const [row] = await conn.sql<{ required: boolean }[]>`
        SELECT totp_reenrollment_required AS required FROM players WHERE wallet=${second}
      `;
      expect(row?.required).toBe(false);
    });
  });

  it('installs cleanly on a fresh database', async () => {
    await disposable(async (conn, dir) => {
      await migrate(conn.db, { migrationsFolder: dir });
      await assertInstalled(conn);
    });
  });

  it('lets the isolated API role atomically cancel, release and link only an exact recovery refund', async () => {
    await disposable(async (conn, dir, _journal, databaseUrl) => {
      await migrate(conn.db, { migrationsFolder: dir });
      const provision = await readFile(
        path.resolve(MIGRATIONS, '../../../infra/db/provision-runtime-roles.sh'), 'utf8',
      );
      const guardStart = provision.indexOf(
        'CREATE OR REPLACE FUNCTION public.shardkeep_guard_withdrawal_api_write()',
      );
      const guardEnd = provision.indexOf('\n$install$;', guardStart) + '\n$install$;'.length;
      expect(guardStart).toBeGreaterThan(0);
      expect(guardEnd).toBeGreaterThan(guardStart);
      await conn.sql.unsafe(provision.slice(guardStart, guardEnd));

      const role = `sk_api_${randomUUID().replaceAll('-', '')}`;
      const password = 'a'.repeat(64);
      const wallet = `isolated-${randomUUID()}`;
      const sessionId = randomUUID();
      const recoveryId = randomUUID();
      const withdrawalId = randomUUID();
      const conflictedWithdrawalId = randomUUID();
      const requestTxnId = randomUUID();
      const escrowId = randomUUID();
      const playerId = randomUUID();
      const amount = '4000';
      const negativeAmount = '-4000';
      await conn.sql.unsafe(`
        DO $$ BEGIN CREATE ROLE shardkeep_api_runtime NOLOGIN;
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        CREATE ROLE ${role} LOGIN PASSWORD '${password}';
        GRANT shardkeep_api_runtime TO ${role};
        GRANT CONNECT ON DATABASE ${new URL(databaseUrl).pathname.slice(1)} TO ${role};
        GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role};
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
      `);
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      await conn.sql`INSERT INTO sessions (id, wallet, expires_at)
        VALUES (${sessionId}, ${wallet}, now() + interval '1 day')`;
      await conn.sql`INSERT INTO totp_recoveries (
          id, player_wallet, started_session_id, status, target_email,
          requested_at, confirmed_at, ready_at, expires_at, updated_at
        ) VALUES (
          ${recoveryId}, ${wallet}, ${sessionId}, 'holding', 'role-test@pkw.testmail.dev',
          now() - interval '1 hour', now() - interval '30 minutes',
          now() + interval '24 hours', now() + interval '7 days', now()
        )`;
      await conn.sql`INSERT INTO ledger_transactions (id, idempotency_key, type)
        VALUES (${requestTxnId}, ${`request:${withdrawalId}`}, 'withdrawal.request')`;
      await conn.sql`INSERT INTO accounts (id, kind, currency, balance)
        VALUES (${escrowId}, 'withdrawal_escrow', 'KEEP', ${amount})`;
      await conn.sql`INSERT INTO accounts (id, owner_wallet, kind, currency, balance)
        VALUES (${playerId}, ${wallet}, 'player_keep', 'KEEP', 0)`;
      await conn.sql`INSERT INTO withdrawals (
          id, player_wallet, currency, amount, destination, status, unbonds_at, request_ledger_txn_id
        ) VALUES (${withdrawalId}, ${wallet}, 'KEEP', ${amount}, '11111111111111111111111111111111',
          'unbonding', now() + interval '1 day', ${requestTxnId})`;
      const conflictedRequestTxnId = randomUUID();
      await conn.sql`INSERT INTO ledger_transactions (id, idempotency_key, type)
        VALUES (${conflictedRequestTxnId}, ${`request:${conflictedWithdrawalId}`}, 'withdrawal.request')`;
      await conn.sql`INSERT INTO withdrawals (
          id, player_wallet, currency, amount, destination, status, unbonds_at, request_ledger_txn_id
        ) VALUES (${conflictedWithdrawalId}, ${wallet}, 'KEEP', 1,
          '11111111111111111111111111111111', 'unbonding', now() + interval '1 day',
          ${conflictedRequestTxnId})`;
      await conn.sql`INSERT INTO withdrawal_attempts (
          withdrawal_id, status, tx_signature, signed_transaction, recent_blockhash,
          last_valid_block_height, transfer_snapshot
        ) VALUES (${conflictedWithdrawalId}, 'prepared', ${`sig-${conflictedWithdrawalId}`},
          decode('00', 'hex'), 'test-blockhash', 1, '{}'::jsonb)`;
      await conn.sql`INSERT INTO withdrawal_payout_reservations (
          withdrawal_id, player_wallet, gross_keep, status
        ) VALUES (${withdrawalId}, ${wallet}, ${amount}, 'reserved')`;

      const runtimeUrl = new URL(databaseUrl);
      runtimeUrl.username = role;
      runtimeUrl.password = password;
      const runtime = createDb(runtimeUrl.toString(), { max: 1 });
      try {
        await expect(runtime.sql`UPDATE withdrawals SET last_error='forbidden' WHERE id=${withdrawalId}`)
          .rejects.toMatchObject({ code: '42501' });
        await expect(runtime.sql`
          UPDATE withdrawals SET status='cancelled', completed_at=now()
          WHERE id=${conflictedWithdrawalId}
        `).rejects.toMatchObject({ code: '42501' });
        expect((await conn.sql<{ status: string }[]>`
          SELECT status::text AS status FROM withdrawals WHERE id=${conflictedWithdrawalId}
        `)[0]?.status).toBe('unbonding');

        const badRefundId = randomUUID();
        await expect(runtime.sql.begin(async (sql) => {
          await sql`UPDATE withdrawals SET status='cancelled', completed_at=now() WHERE id=${withdrawalId}`;
          await sql`INSERT INTO ledger_transactions (id, idempotency_key, type, metadata) VALUES (
            ${badRefundId}, ${`withdrawal:${withdrawalId}:cancel`}, 'withdrawal.cancel',
            ${JSON.stringify({ wallet, withdrawalId, reason: 'totp_recovery', recoveryId })}::jsonb
          )`;
          await sql`INSERT INTO ledger_entries (txn_id, account_id, delta, balance_after)
            VALUES (${badRefundId}, ${playerId}, ${amount}, ${amount})`;
          await sql`UPDATE withdrawals SET refund_ledger_txn_id=${badRefundId} WHERE id=${withdrawalId}`;
        })).rejects.toMatchObject({ code: '42501' });
        expect((await conn.sql<{ status: string; refund: string | null }[]>`
          SELECT status::text AS status, refund_ledger_txn_id AS refund FROM withdrawals WHERE id=${withdrawalId}
        `)[0]).toEqual({ status: 'unbonding', refund: null });
        expect((await conn.sql<{ status: string }[]>`
          SELECT status FROM withdrawal_payout_reservations WHERE withdrawal_id=${withdrawalId}
        `)[0]?.status).toBe('reserved');

        const refundId = randomUUID();
        await runtime.sql.begin(async (sql) => {
          await sql`UPDATE withdrawals SET status='cancelled', completed_at=now() WHERE id=${withdrawalId}`;
          await sql`INSERT INTO ledger_transactions (id, idempotency_key, type, metadata) VALUES (
            ${refundId}, ${`withdrawal:${withdrawalId}:cancel`}, 'withdrawal.cancel',
            ${JSON.stringify({ wallet, withdrawalId, reason: 'totp_recovery', recoveryId })}::jsonb
          )`;
          await sql`INSERT INTO ledger_entries (txn_id, account_id, delta, balance_after) VALUES
            (${refundId}, ${escrowId}, ${negativeAmount}, 0),
            (${refundId}, ${playerId}, ${amount}, ${amount})`;
          await sql`UPDATE accounts SET balance=0 WHERE id=${escrowId}`;
          await sql`UPDATE accounts SET balance=${amount} WHERE id=${playerId}`;
          await sql`UPDATE withdrawals SET refund_ledger_txn_id=${refundId} WHERE id=${withdrawalId}`;
        });
        expect((await conn.sql<{ status: string; refund: string | null; lastError: string | null }[]>`
          SELECT status::text AS status, refund_ledger_txn_id AS refund, last_error AS "lastError"
          FROM withdrawals WHERE id=${withdrawalId}
        `)[0]).toEqual({ status: 'cancelled', refund: refundId, lastError: null });
        expect((await conn.sql<{ status: string }[]>`
          SELECT status FROM withdrawal_payout_reservations WHERE withdrawal_id=${withdrawalId}
        `)[0]?.status).toBe('released');
        const [ledger] = await conn.sql<{ count: number; total: bigint }[]>`
          SELECT count(*)::int AS count, sum(delta)::bigint AS total
          FROM ledger_entries WHERE txn_id=${refundId}
        `;
        expect(ledger).toEqual({ count: 2, total: '0' });
      } finally {
        await runtime.sql.end();
        await conn.sql.unsafe(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
      }
    });
  });
});
