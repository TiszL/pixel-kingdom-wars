import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import {
  withdrawalAttempts, withdrawalPayoutReservations, withdrawals,
} from '../src/db/schema';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const PREFIX = 'shardkeep_migration_0089_';
interface Journal { entries: Array<{ idx: number; tag: string }> }

describe('migration 0089 payout allowance evidence', () => {
  it('backfills recent sent payouts by completion time, not request time', async () => {
    const name = `${PREFIX}${randomUUID().replaceAll('-', '')}_test`;
    if (!new RegExp(`^${PREFIX}[0-9a-f]{32}_test$`).test(name)) throw new Error('unsafe database name');
    const dir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0089-'));
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const url = new URL(ADMIN_DATABASE_URL);
    url.pathname = `/${name}`;
    let conn: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`);
      await cp(MIGRATIONS, dir, { recursive: true });
      const journalPath = path.join(dir, 'meta/_journal.json');
      const fullJournal = await readFile(journalPath, 'utf8');
      const journal = JSON.parse(fullJournal) as Journal;
      journal.entries = journal.entries.filter(({ idx }) => idx <= 88);
      expect(journal.entries.at(-1)?.tag).toBe('0088_complex_black_tarantula');
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      conn = createDb(url.toString(), { max: 4 });
      await migrate(conn.db, { migrationsFolder: dir });

      const wallet = `migration-0089-${randomUUID()}`;
      // WHY: this fixture is deliberately paused at migration 0088. Using the
      // current Drizzle player model would reference columns added later.
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      const now = Date.now();
      const [recent, old, zeroSent, positiveProcessing, zeroProcessing] = await conn.db.insert(withdrawals).values([
        {
          playerWallet: wallet, currency: 'KEEP', amount: 30_000n, feeBurned: 600n,
          destination: '11111111111111111111111111111111', status: 'sent',
          unbondsAt: new Date(now - 25 * 60 * 60 * 1_000),
          createdAt: new Date(now - 49 * 60 * 60 * 1_000),
          completedAt: new Date(now - 60 * 60 * 1_000), txSignature: `recent-${randomUUID()}`,
        },
        {
          playerWallet: wallet, currency: 'KEEP', amount: 30_000n, feeBurned: 600n,
          destination: '11111111111111111111111111111111', status: 'sent',
          unbondsAt: new Date(now - 49 * 60 * 60 * 1_000),
          createdAt: new Date(now - 73 * 60 * 60 * 1_000),
          completedAt: new Date(now - 25 * 60 * 60 * 1_000), txSignature: `old-${randomUUID()}`,
        },
        {
          playerWallet: wallet, currency: 'KEEP', amount: 0n, feeBurned: 0n,
          destination: '11111111111111111111111111111111', status: 'sent',
          unbondsAt: new Date(now - 2 * 60 * 60 * 1_000),
          createdAt: new Date(now - 3 * 60 * 60 * 1_000),
          completedAt: new Date(now - 60 * 60 * 1_000), txSignature: `zero-sent-${randomUUID()}`,
        },
        {
          playerWallet: wallet, currency: 'KEEP', amount: 20_000n, feeBurned: 400n,
          destination: '11111111111111111111111111111111', status: 'processing',
          unbondsAt: new Date(now - 2 * 60 * 60 * 1_000),
          createdAt: new Date(now - 3 * 60 * 60 * 1_000),
        },
        {
          playerWallet: wallet, currency: 'KEEP', amount: 0n, feeBurned: 0n,
          destination: '11111111111111111111111111111111', status: 'processing',
          unbondsAt: new Date(now - 2 * 60 * 60 * 1_000),
          createdAt: new Date(now - 3 * 60 * 60 * 1_000),
        },
      ]).returning({ id: withdrawals.id });
      await conn.db.insert(withdrawalAttempts).values([
        {
          withdrawalId: positiveProcessing!.id,
          txSignature: `positive-processing-${randomUUID()}`,
          signedTransaction: Buffer.from([1]), recentBlockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1n, transferSnapshot: {},
        },
        {
          withdrawalId: zeroProcessing!.id,
          txSignature: `zero-processing-${randomUUID()}`,
          signedTransaction: Buffer.from([2]), recentBlockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1n, transferSnapshot: {},
        },
      ]);

      const through0089 = JSON.parse(fullJournal) as Journal;
      through0089.entries = through0089.entries.filter(({ idx }) => idx <= 89);
      expect(through0089.entries.at(-1)?.tag).toBe('0089_daily_karen_page');
      await writeFile(journalPath, `${JSON.stringify(through0089, null, 2)}\n`);
      await migrate(conn.db, { migrationsFolder: dir });
      const evidence = await conn.db.select().from(withdrawalPayoutReservations)
        .where(inArray(withdrawalPayoutReservations.withdrawalId, [
          recent!.id, old!.id, zeroSent!.id, positiveProcessing!.id, zeroProcessing!.id,
        ]));
      // WHY: legacy zero-value rows cannot satisfy the new positive-gross
      // constraint and must not make the production migration abort. Both the
      // processing-attempt and recent-sent backfills filter them explicitly.
      expect(evidence).toHaveLength(2);
      expect(evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ withdrawalId: recent!.id, status: 'sent', grossKeep: 30_000n }),
        expect.objectContaining({
          withdrawalId: positiveProcessing!.id, status: 'reserved', grossKeep: 20_000n,
        }),
      ]));

      const functions = await conn.db.execute(sql<{
        proname: string; prosecdef: boolean; proconfig: string[] | null;
        publicExecute: boolean; definition: string;
      }>`
        SELECT p.proname, p.prosecdef, p.proconfig,
               pg_catalog.has_function_privilege('public', p.oid, 'execute') AS "publicExecute",
               pg_catalog.pg_get_functiondef(p.oid) AS definition
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN (
          'shardkeep_reserve_withdrawal_allowance',
          'shardkeep_finalize_withdrawal_allowance',
          'shardkeep_release_withdrawal_allowance',
          'shardkeep_release_terminal_withdrawal_reservation'
        )
      `);
      expect(functions).toHaveLength(4);
      for (const fn of functions) {
        expect(fn.prosecdef).toBe(true);
        expect(fn.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(fn.publicExecute).toBe(false);
        expect(fn.definition).toContain('public.withdrawal_');
      }
      const reserveDefinition = functions.find(
        ({ proname }) => proname === 'shardkeep_reserve_withdrawal_allowance',
      )?.definition;
      expect(reserveDefinition).toContain('pg_catalog.statement_timestamp()');
      expect(reserveDefinition).not.toContain('p_now');
      const [signatures] = await conn.db.execute(sql<{
        trusted: string | null; legacy: string | null;
      }>`
        SELECT
          pg_catalog.to_regprocedure(
            'public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint)'
          )::text AS trusted,
          pg_catalog.to_regprocedure(
            'public.shardkeep_reserve_withdrawal_allowance(uuid,text,bigint,bigint,timestamptz)'
          )::text AS legacy
      `);
      expect(signatures?.trusted).not.toBeNull();
      expect(signatures?.legacy).toBeNull();

      // A prepared/broadcast attempt is ambiguous and must keep its allowance
      // reserved even if a caller incorrectly marks the withdrawal failed.
      const [prematureRelease] = await conn.db.execute(sql<{ released: boolean }>`
        SELECT public.shardkeep_release_withdrawal_allowance(
          ${positiveProcessing!.id}::uuid
        ) AS released
      `);
      expect(prematureRelease?.released).toBe(false);
      await conn.db.update(withdrawals).set({ status: 'failed', completedAt: new Date() })
        .where(eq(withdrawals.id, positiveProcessing!.id));
      expect((await conn.db.select().from(withdrawalPayoutReservations)
        .where(eq(withdrawalPayoutReservations.withdrawalId, positiveProcessing!.id)))[0]?.status)
        .toBe('reserved');

      // Positive terminal error evidence unlocks the same reservation.
      const terminalAt = new Date();
      await conn.db.update(withdrawalAttempts).set({
        status: 'finalized_error', finalizedAt: terminalAt,
      }).where(eq(withdrawalAttempts.withdrawalId, positiveProcessing!.id));
      const [provenRelease] = await conn.db.execute(sql<{ released: boolean }>`
        SELECT public.shardkeep_release_withdrawal_allowance(
          ${positiveProcessing!.id}::uuid
        ) AS released
      `);
      expect(provenRelease?.released).toBe(true);
      expect((await conn.db.select().from(withdrawalPayoutReservations)
        .where(eq(withdrawalPayoutReservations.withdrawalId, positiveProcessing!.id)))[0]?.status)
        .toBe('released');
    } finally {
      await conn?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
