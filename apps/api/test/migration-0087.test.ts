/**
 * Migration 0087 retires the obsolete KEEP quest allocation without rewriting
 * ledger history. These tests replay both real upgrade shapes: an existing
 * partially-used 50M allocation and a fresh database that never seeded it.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_QUEST_KEEP_ALLOCATION, TOKEN } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import {
  accounts, ledgerEntries, ledgerTransactions, questBucketRetirementState,
} from '../src/db/schema';
import {
  GENESIS_QUEST_BUCKET_KEY,
  InsufficientFundsError,
  QUEST_BUCKET_RETIREMENT_KEY,
  bootstrapEconomyAllocations,
  bootstrapPlayPool,
  bootstrapSystemAccounts,
  canGoNegative,
  getOrCreatePlayerAccount,
  postTransaction,
  retireQuestBucketAllocation,
  type PostTransactionInput,
} from '../src/ledger';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const DB_PREFIX = 'shardkeep_migration_0087_';

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

function assertDisposableDbName(name: string): void {
  if (!new RegExp(`^${DB_PREFIX}[0-9a-f]{32}_test$`).test(name)) {
    throw new Error(`refusing to manage unexpected database name: ${name}`);
  }
}

async function withDisposableDb(
  run: (args: {
    conn: ReturnType<typeof createDb>;
    migrationDir: string;
    fullJournalText: string;
  }) => Promise<void>,
): Promise<void> {
  const databaseName = `${DB_PREFIX}${randomUUID().replaceAll('-', '')}_test`;
  assertDisposableDbName(databaseName);
  const migrationDir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0087-'));
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const databaseUrl = new URL(ADMIN_DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    await cp(MIGRATIONS, migrationDir, { recursive: true });
    const fullJournalText = await readFile(path.join(migrationDir, 'meta/_journal.json'), 'utf8');
    conn = createDb(databaseUrl.toString(), { max: 10 });
    await run({ conn, migrationDir, fullJournalText });
  } finally {
    await conn?.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
    await rm(migrationDir, { recursive: true, force: true });
  }
}

async function migrateThrough0086(
  conn: ReturnType<typeof createDb>,
  migrationDir: string,
  fullJournalText: string,
): Promise<void> {
  const journal = JSON.parse(fullJournalText) as Journal;
  journal.entries = journal.entries.filter(({ idx }) => idx <= 86);
  expect(journal.entries.at(-1)?.tag).toBe('0086_green_kabuki');
  await writeFile(
    path.join(migrationDir, 'meta/_journal.json'),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
  await migrate(conn.db, { migrationsFolder: migrationDir });
}

/** Seed historical facts using the schema that actually existed at 0086.
 * The current application writer requires the 0154 custody function; adding a
 * no-op version of that guard would conceal the real upgrade boundary. */
async function seed0086Posting(
  conn: ReturnType<typeof createDb>, input: PostTransactionInput,
): Promise<void> {
  await conn.db.transaction(async tx => {
    const identity = await tx.execute<{ name: string; custody: string | null }>(sql`
      select current_database() as name, to_regclass('public.keep_custody_cutover_state')::text as custody`);
    assertDisposableDbName(identity[0]!.name);
    expect(identity[0]!.custody).toBeNull();
    expect(input.entries).toHaveLength(2);
    expect(input.entries.reduce((total, entry) => total + entry.delta, 0n)).toBe(0n);
    const [transaction] = await tx.insert(ledgerTransactions).values({
      idempotencyKey: input.idempotencyKey, type: input.type, metadata: input.metadata ?? {},
    }).returning();
    for (const entry of [...input.entries].sort((a,b) => a.account.localeCompare(b.account))) {
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, entry.account)).for('update');
      expect(account?.currency).toBe('KEEP');
      const next = account!.balance + entry.delta;
      if (!canGoNegative(account!.kind)) expect(next >= 0n).toBe(true);
      await tx.insert(ledgerEntries).values({ txnId: transaction!.id, accountId: entry.account, delta: entry.delta, balanceAfter: next });
      await tx.update(accounts).set({balance: next}).where(eq(accounts.id, entry.account));
    }
  });
}

describe('migration 0087 quest KEEP allocation retirement', () => {
  it('consolidates a partially-used legacy allocation exactly once and fences old writers', async () => {
    await withDisposableDb(async ({ conn, migrationDir, fullJournalText }) => {
      await migrateThrough0086(conn, migrationDir, fullJournalText);
      const system = await bootstrapPlayPool(conn.db);
      const allocation = BigInt(LEGACY_QUEST_KEEP_ALLOCATION);
      const issued = 7_000_000n;
      const legacyDevGrant = 500_000n;
      await postTransaction(conn.db, {
        idempotencyKey: GENESIS_QUEST_BUCKET_KEY,
        type: 'genesis.quest_bucket',
        entries: [
          { account: system.keep_genesis, delta: -allocation },
          { account: system.quest_bucket, delta: allocation },
        ],
      });
      const wallet = 'quest-retirement-player';
      // WHY: this fixture is deliberately paused at migration 0086. Using the
      // current Drizzle player model would reference columns added later.
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      const player = await getOrCreatePlayerAccount(conn.db, wallet, 'player_keep');
      await seed0086Posting(conn, {
        idempotencyKey: 'test:legacy-dev-grant',
        type: 'dev.grant',
        entries: [
          { account: system.keep_genesis, delta: -legacyDevGrant },
          { account: player.id, delta: legacyDevGrant },
        ],
      });
      await seed0086Posting(conn, {
        idempotencyKey: 'test:legacy-quest-award',
        type: 'raid.pve_bounty',
        entries: [
          { account: system.quest_bucket, delta: -issued },
          { account: player.id, delta: issued },
        ],
      });

      await writeFile(path.join(migrationDir, 'meta/_journal.json'), fullJournalText);
      await migrate(conn.db, { migrationsFolder: migrationDir });

      const guards = await conn.db.execute(sql<{
        proname: string; prosecdef: boolean; proconfig: string[] | null;
        publicExecute: boolean; definition: string;
      }>`
        SELECT p.proname, p.prosecdef, p.proconfig,
               pg_catalog.has_function_privilege('public', p.oid, 'execute') AS "publicExecute",
               pg_catalog.pg_get_functiondef(p.oid) AS definition
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.pronargs = 0
          AND p.proname IN ('shardkeep_quest_bucket_retired', 'shardkeep_activate_quest_bucket_retirement',
            'shardkeep_reject_retired_quest_entry', 'shardkeep_reject_retired_quest_balance')
        ORDER BY p.proname
      `);
      // Pin this migration's actual guards; later Charter quest helpers are a different authority.
      expect(guards.map(guard => guard.proname)).toEqual([
        'shardkeep_activate_quest_bucket_retirement', 'shardkeep_quest_bucket_retired',
        'shardkeep_reject_retired_quest_balance', 'shardkeep_reject_retired_quest_entry',
      ]);
      for (const guard of guards) {
        expect(guard.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(guard.publicExecute).toBe(false);
        if (guard.prosecdef) {
          expect(guard.definition).toContain('public.');
        }
      }

      const first = await retireQuestBucketAllocation(conn.db);
      expect(first.activated).toBe(true);
      expect(first.reconciliationTxnId).toBeTruthy();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => retireQuestBucketAllocation(conn.db)),
      );
      expect(results.every((result) =>
        !result.activated && result.reconciliationTxnId === first.reconciliationTxnId)).toBe(true);

      const rows = await conn.db.select().from(accounts);
      const balance = (kind: (typeof accounts.kind.enumValues)[number]) =>
        rows.find((row) => row.kind === kind && row.ownerWallet === null && row.baseId === null)?.balance;
      expect(balance('quest_bucket')).toBe(0n);
      expect(balance('emission_pool')).toBe(
        BigInt(TOKEN.allocation.playPool) - issued - legacyDevGrant,
      );
      expect(balance('keep_genesis')).toBe(-BigInt(TOKEN.allocation.playPool));
      expect((await conn.db.select().from(accounts).where(eq(accounts.id, player.id)))[0]?.balance)
        .toBe(issued + legacyDevGrant);

      const [state] = await conn.db.select().from(questBucketRetirementState);
      expect(state).toMatchObject({
        phase: 'ready',
        reconciliationTxnId: first.reconciliationTxnId,
      });
      const [reconciliation] = await conn.db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, QUEST_BUCKET_RETIREMENT_KEY));
      expect(reconciliation?.type).toBe('economy.quest_bucket_retirement');
      const entries = await conn.db.select().from(ledgerEntries)
        .where(eq(ledgerEntries.txnId, reconciliation!.id));
      expect(entries.map(({ accountId, delta }) => [accountId, delta])).toEqual(expect.arrayContaining([
        [system.quest_bucket, -(allocation - issued)],
        [system.emission_pool, -(issued + legacyDevGrant)],
        [system.keep_genesis, allocation + legacyDevGrant],
      ]));
      expect(entries).toHaveLength(3);

      await expect(postTransaction(conn.db, {
        idempotencyKey: 'test:old-writer-after-retirement',
        type: 'test.old_writer',
        entries: [
          { account: system.keep_genesis, delta: -1n },
          { account: system.quest_bucket, delta: 1n },
        ],
      })).rejects.toMatchObject({
        cause: { code: 'P0001', message: expect.stringContaining('QUEST_BUCKET_RETIRED') },
      });
      await expect(conn.db.update(accounts).set({ balance: 1n })
        .where(eq(accounts.id, system.quest_bucket))).rejects.toMatchObject({
        cause: { code: 'P0001', message: expect.stringContaining('QUEST_BUCKET_RETIRED') },
      });
    });
  }, 120_000);

  it('activates as a zero-value no-op on a fresh database', async () => {
    await withDisposableDb(async ({ conn, migrationDir }) => {
      await migrate(conn.db, { migrationsFolder: migrationDir });
      await bootstrapEconomyAllocations(conn.db);
      const system = await bootstrapSystemAccounts(conn.db);
      const [state] = await conn.db.select().from(questBucketRetirementState);
      const [bucket] = await conn.db.select().from(accounts)
        .where(eq(accounts.id, system.quest_bucket));
      expect(state).toMatchObject({ phase: 'ready', reconciliationTxnId: null });
      expect(bucket?.balance).toBe(0n);
      expect(await conn.db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, GENESIS_QUEST_BUCKET_KEY))).toHaveLength(0);
      expect(await conn.db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, QUEST_BUCKET_RETIREMENT_KEY))).toHaveLength(0);
    });
  }, 120_000);

  it('fails atomically when prior awards no longer fit inside the play pool', async () => {
    await withDisposableDb(async ({ conn, migrationDir, fullJournalText }) => {
      await migrateThrough0086(conn, migrationDir, fullJournalText);
      const system = await bootstrapPlayPool(conn.db);
      const allocation = BigInt(LEGACY_QUEST_KEEP_ALLOCATION);
      await postTransaction(conn.db, {
        idempotencyKey: GENESIS_QUEST_BUCKET_KEY,
        type: 'genesis.quest_bucket',
        entries: [
          { account: system.keep_genesis, delta: -allocation },
          { account: system.quest_bucket, delta: allocation },
        ],
      });
      const wallet = 'quest-retirement-overcommitted';
      // WHY: this fixture is deliberately paused at migration 0086. Using the
      // current Drizzle player model would reference columns added later.
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      const player = await getOrCreatePlayerAccount(conn.db, wallet, 'player_keep');
      await seed0086Posting(conn, {
        idempotencyKey: 'test:consume-play-pool',
        type: 'test.consume_play_pool',
        entries: [
          { account: system.emission_pool, delta: -480_000_000n },
          { account: player.id, delta: 480_000_000n },
        ],
      });
      await seed0086Posting(conn, {
        idempotencyKey: 'test:overcommitted-legacy-award',
        type: 'raid.pve_bounty',
        entries: [
          { account: system.quest_bucket, delta: -30_000_000n },
          { account: player.id, delta: 30_000_000n },
        ],
      });

      await writeFile(path.join(migrationDir, 'meta/_journal.json'), fullJournalText);
      await migrate(conn.db, { migrationsFolder: migrationDir });
      await expect(retireQuestBucketAllocation(conn.db)).rejects.toBeInstanceOf(InsufficientFundsError);

      const [state] = await conn.db.select().from(questBucketRetirementState);
      const [bucket] = await conn.db.select().from(accounts)
        .where(eq(accounts.id, system.quest_bucket));
      expect(state).toMatchObject({ phase: 'fenced', reconciliationTxnId: null });
      expect(bucket?.balance).toBe(20_000_000n);
      expect(await conn.db.select().from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, QUEST_BUCKET_RETIREMENT_KEY))).toHaveLength(0);
    });
  }, 120_000);
});
