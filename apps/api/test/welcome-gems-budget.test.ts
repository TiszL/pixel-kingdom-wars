import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMS_TASKS } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { parseWelcomeBudgetArgs } from '../src/db/fundWelcomeGemsBudget';
import { runMigrations } from '../src/db/migrate';
import * as migrationBuild from '../src/db/migrate';
import { accounts, ledgerEntries, ledgerTransactions, players, welcomeGemsObligations } from '../src/db/schema';
import { fundWelcomeGemsBudget, welcomeBudgetAvailable, type WelcomeBudgetRequest } from '../src/db/welcomeGemsBudget';
import { fundGemsRewardBudget, grantGems } from '../src/game/gemsGrants';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { assertEconomyChainIdentity } from '../src/money/economyIdentity';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
import { gemsTestIdentity } from './gems-reserve-fixture';

// D153.13 reviewed this exact 139-row history. The additive Gems split is a
// different history even though its terminal tag remains 0138; it grants no new
// funding approval. Frozen files and hashes come from this original commit.
const REVIEWED_SOURCE = '980afb41c4e743e34dd8a7c8d35ea368266b95b7';
const REVIEWED_FRONTIER = '0138_workshop_allowance';
const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const HISTORICAL = fileURLToPath(new URL('./fixtures/welcome-gems-980afb41', import.meta.url));
let reviewedMigrations: string | undefined;
let reviewedMigration: { tag: string; when: number };
beforeAll(async () => {
  const manifest = JSON.parse(await readFile(path.join(HISTORICAL, 'manifest.json'), 'utf8')) as {
    sourceCommit: string; journalSha256: string; migrationSha256: Record<string, string>;
  };
  const originalJournal = await readFile(path.join(HISTORICAL, 'meta/_journal.json'));
  const journal = JSON.parse(originalJournal.toString('utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  expect(manifest.sourceCommit).toBe(REVIEWED_SOURCE);
  expect(createHash('sha256').update(originalJournal).digest('hex')).toBe(manifest.journalSha256);
  expect(journal.entries).toHaveLength(139);
  expect(journal.entries.at(-1)).toMatchObject({ idx: 138, tag: REVIEWED_FRONTIER });
  expect(Object.keys(manifest.migrationSha256)).toEqual(journal.entries.map(entry => entry.tag));
  reviewedMigration = journal.entries.at(-1)!;
  reviewedMigrations = await mkdtemp(path.join(tmpdir(), 'shardkeep-welcome-980afb41-'));
  try {
    await mkdir(path.join(reviewedMigrations, 'meta'));
    await writeFile(path.join(reviewedMigrations, 'meta/_journal.json'), originalJournal);
    for (const entry of journal.entries) {
      const source = path.join(entry.idx >= 134 ? HISTORICAL : MIGRATIONS, `${entry.tag}.sql`);
      const contents = await readFile(source);
      expect(createHash('sha256').update(contents).digest('hex'), `${entry.tag} must match the reviewed source`)
        .toBe(manifest.migrationSha256[entry.tag]);
      await writeFile(path.join(reviewedMigrations, `${entry.tag}.sql`), contents);
    }
  } catch (error) {
    await rm(reviewedMigrations, { recursive: true, force: true });
    reviewedMigrations = undefined;
    throw error;
  }
});
afterAll(async () => {
  if (reviewedMigrations) await rm(reviewedMigrations, { recursive: true, force: true });
});

/** Every fixture owns a disposable database: immutable obligations/funding must
 * never be deleted to reset a test or mixed with unclassified broad-suite aid. */
async function fixture(work: (f: {
  db: Db; request: WelcomeBudgetRequest; day: string;
  sys: Awaited<ReturnType<typeof bootstrapSystemAccounts>>;
  obligation: (amount?: bigint, day?: string) => Promise<string>;
  connection: ReturnType<typeof createDb>; databaseUrl: URL;
}) => Promise<void>, history: 'reviewed' | 'm41' | 'current' = 'reviewed') {
  const name = `welcome_budget_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const databaseUrl = new URL(ADMIN_DATABASE_URL); databaseUrl.pathname = `/${name}`;
  let connection: ReturnType<typeof createDb> | undefined;
  let m41Migrations: string | undefined;
  try {
    // The reviewed and rewritten-M41 histories replay their own truncated journals. The current
    // history is exactly this build's whole chain: clone its template (test/migratedTemplate.ts);
    // runMigrations below re-verifies every applied row and the frontier checks still run.
    await (history === 'current' ? createMigratedDatabase(admin, name) : admin.unsafe(`CREATE DATABASE ${name}`));
    connection = createDb(databaseUrl.toString());
    const db = connection.db;
    if (!reviewedMigrations) throw new Error('reviewed migration fixture was not initialized');
    if (history === 'm41') {
      const journal = JSON.parse(await readFile(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
        entries: Array<{ tag: string; when: number }>;
      };
      const frontier = journal.entries.findIndex(entry => entry.tag === REVIEWED_FRONTIER);
      expect(frontier).toBe(140);
      journal.entries = journal.entries.slice(0, frontier + 1);
      m41Migrations = await mkdtemp(path.join(tmpdir(), 'shardkeep-welcome-m41-'));
      await mkdir(path.join(m41Migrations, 'meta'));
      await writeFile(path.join(m41Migrations, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries) {
        await writeFile(path.join(m41Migrations, `${entry.tag}.sql`), await readFile(path.join(MIGRATIONS, `${entry.tag}.sql`)));
      }
    }
    await runMigrations(db, { migrationsFolder: m41Migrations ?? (history === 'reviewed' ? reviewedMigrations : MIGRATIONS) });
    const [applied] = await connection.sql<{ count: string; latest: string }[]>`
      SELECT count(*)::text AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations
    `;
    if (history === 'reviewed') {
      expect(applied).toEqual({ count: '139', latest: String(reviewedMigration.when) });
    } else if (history === 'm41') {
      expect(applied).toEqual({ count: '141', latest: String(reviewedMigration.when) });
    } else {
      const currentJournal = JSON.parse(await readFile(path.join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
        entries: Array<{ when: number }>;
      };
      expect(applied).toEqual({
        count: String(currentJournal.entries.length), latest: String(currentJournal.entries.at(-1)!.when),
      });
    }
    await assertEconomyChainIdentity(db, gemsTestIdentity, gemsTestIdentity);
    const sys = await bootstrapSystemAccounts(db);
    await postTransaction(db, { idempotencyKey: randomUUID(), type: 'test.seed',
      entries: [{ account: sys.keep_genesis, delta: -1000n }, { account: sys.emission_pool, delta: 1000n }] });
    const [clock] = await db.execute<{ day: string }>(sql`SELECT (transaction_timestamp() AT TIME ZONE 'UTC')::date::text AS day`);
    const day = clock!.day;
    const obligation = async (amount = 10n, historicalDay?: string) => {
      const wallet = `welcome_${randomUUID()}`;
      await db.insert(players).values({ wallet });
      if (historicalDay) {
        // Admin-only disposable fixture: reconstruct a previously accepted
        // immutable cohort. This escape does not exist in production code.
        await db.transaction(async (tx) => {
          await tx.execute(sql`ALTER TABLE welcome_gems_obligations DISABLE TRIGGER welcome_gems_obligation_guard`);
          await tx.insert(welcomeGemsObligations).values({ wallet, gems: amount, acceptedAt: new Date(`${historicalDay}T12:00:00.000Z`) });
          await tx.execute(sql`ALTER TABLE welcome_gems_obligations ENABLE TRIGGER welcome_gems_obligation_guard`);
        });
      } else await db.insert(welcomeGemsObligations).values({ wallet, gems: amount });
      return wallet;
    };
    const request: WelcomeBudgetRequest = { expectedDatabase: name, cluster: 'devnet', cohortDay: day,
      keep: 10n, maxKeep: 10n, idempotencyKey: randomUUID(), buildSha: 'a'.repeat(40), apply: true };
    // Historical and rewritten M41 fixtures use their actual terminal build
    // tag/time. The current-history refusal case uses the build without a spy.
    const build = history !== 'current'
      ? vi.spyOn(migrationBuild, 'latestMigrationInBuild').mockReturnValue({
        tag: REVIEWED_FRONTIER, when: reviewedMigration.when,
      }) : undefined;
    try { await work({ db, request, day, sys, obligation, connection, databaseUrl }); }
    finally { build?.mockRestore(); }
  } finally {
    await connection?.sql.end();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    finally {
      await admin.end();
      if (m41Migrations) await rm(m41Migrations, { recursive: true, force: true });
    }
  }
}
const yesterday = (day: string) => new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
const tomorrow = (day: string) => new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);

describe.sequential('governed devnet welcome funding', () => {
  it('refuses the rewritten M41 history despite its reviewed terminal tag, without funding', async () => fixture(async ({ db, request }) => {
    expect(migrationBuild.latestMigrationInBuild().tag).toBe(REVIEWED_FRONTIER);
    const before = await db.select().from(ledgerTransactions);
    const balances = await db.select().from(accounts);
    for (const apply of [false, true]) {
      await expect(fundWelcomeGemsBudget(db, { ...request, apply })).rejects.toThrow('reviewed pre-mining schema frontier');
    }
    expect(await db.select().from(ledgerTransactions)).toEqual(before);
    expect(await db.select().from(accounts)).toEqual(balances);
  }, 'm41'));

  it('refuses the later current frontier without funding', async () => fixture(async ({ db, request }) => {
    expect(migrationBuild.latestMigrationInBuild().tag).not.toBe(REVIEWED_FRONTIER);
    const before = await db.select().from(ledgerTransactions);
    const balances = await db.select().from(accounts);
    for (const apply of [false, true]) {
      await expect(fundWelcomeGemsBudget(db, { ...request, apply })).rejects.toThrow('policy review required');
    }
    expect(await db.select().from(ledgerTransactions)).toEqual(before);
    expect(await db.select().from(accounts)).toEqual(balances);
  }, 'current'));

  it('refuses a future build before database access even after the Workshop-only schema review', async () => {
    // A later migration can change funding assumptions: never follow the latest
    // journal automatically merely because this build can migrate that far.
    const request: WelcomeBudgetRequest = { expectedDatabase: 'fixture', cluster: 'devnet',
      cohortDay: '2026-09-21', keep: 1n, maxKeep: 1n, idempotencyKey: 'future-schema', buildSha: 'a'.repeat(40) };
    const latest = migrationBuild.latestMigrationInBuild();
    const spy = vi.spyOn(migrationBuild, 'latestMigrationInBuild').mockReturnValue({ tag: 'future_unreviewed', when: latest.when + 1 });
    try { await expect(fundWelcomeGemsBudget({} as Db, request)).rejects.toThrow('policy review required'); }
    finally { spy.mockRestore(); }
  });

  it('refuses a database ahead of the reviewed schema in both dry-run and apply without funding', async () => fixture(async ({ db, request, connection, obligation }) => {
    await obligation();
    const before = await db.select().from(ledgerTransactions);
    await connection.sql`INSERT INTO drizzle.__drizzle_migrations(hash, created_at)
      SELECT 'test-only-future-schema', max(created_at) + 1 FROM drizzle.__drizzle_migrations`;
    for (const apply of [false, true]) {
      await expect(fundWelcomeGemsBudget(db, { ...request, apply })).rejects.toThrow('reviewed pre-mining schema frontier');
    }
    expect(await db.select().from(ledgerTransactions)).toEqual(before);
  }));

  it('dry-run cannot reserve a key, create accounts, or fund; exact apply remains possible afterward', async () => fixture(async ({ db, request, obligation }) => {
    await obligation();
    const before = await db.select().from(accounts);
    const ledger = await db.select().from(ledgerTransactions);
    const preview = await fundWelcomeGemsBudget(db, { ...request, apply: false });
    expect(preview).toMatchObject({ mode: 'dry-run', permitted: true, receiptId: null,
      evidence: { capBefore: { cohortAccepted: '10', cohortGrossFunded: '0', globalPending: '10', budget: '0', available: '10' } } });
    expect(await db.select().from(accounts)).toEqual(before);
    expect(await db.select().from(ledgerTransactions)).toEqual(ledger);
    expect(await fundWelcomeGemsBudget(db, request)).toMatchObject({ mode: 'applied', permitted: true });
  }));

  it('serializes two keys against the same cap and replays the winning original after its grant consumed the budget', async () => fixture(async ({ db, request, obligation }) => {
    const wallet = await obligation();
    const requests = [request, { ...request, idempotencyKey: randomUUID() }];
    const outcomes = await Promise.allSettled(requests.map((r) => fundWelcomeGemsBudget(db, r)));
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes.findIndex((r) => r.status === 'fulfilled');
    const original = outcomes[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof fundWelcomeGemsBudget>>>;
    await grantGems(db, { wallet, gems: 10n, reason: 'welcome' });
    expect(await fundWelcomeGemsBudget(db, { ...requests[winner]!, buildSha: 'b'.repeat(40) }))
      .toEqual({ ...original.value, mode: 'replay' });
    for (const mismatch of [{ keep: 9n }, { maxKeep: 11n }, { cohortDay: yesterday(request.cohortDay) }]) {
      await expect(fundWelcomeGemsBudget(db, { ...requests[winner]!, ...mismatch })).rejects.toThrow('idempotency key request mismatch');
    }
  }));

  it('simultaneous identical requests write once and report one original receipt', async () => fixture(async ({ db, request, obligation }) => {
    await obligation();
    const results = await Promise.all([fundWelcomeGemsBudget(db, request), fundWelcomeGemsBudget(db, request)]);
    expect(results.map((r) => r.mode).sort()).toEqual(['applied', 'replay']);
    expect(results[0]!.receiptId).toBe(results[1]!.receiptId);
  }));

  it('recycling and emptying the balance never renew a gross cohort allowance', async () => fixture(async ({ db, request, obligation, sys }) => {
    const first = await obligation(); await obligation();
    await fundWelcomeGemsBudget(db, { ...request, keep: 20n, maxKeep: 20n });
    await grantGems(db, { wallet: first, gems: 10n, reason: 'welcome' });
    // Even a separate compensating return cannot pretend gross funding was 10.
    await postTransaction(db, { idempotencyKey: randomUUID(), type: 'test.return',
      entries: [{ account: sys.gems_reward_budget, delta: -10n }, { account: sys.emission_pool, delta: 10n }] });
    const next = { ...request, idempotencyKey: randomUUID(), apply: false };
    expect((await fundWelcomeGemsBudget(db, next)).evidence.capBefore).toMatchObject({
      cohortAccepted: '20', cohortGrossFunded: '20', cohortPending: '10', globalPending: '10', budget: '0', available: '0',
    });
    await expect(fundWelcomeGemsBudget(db, { ...next, apply: true })).rejects.toThrow('exceeds available cap');
  }));

  it('counts the exact database acceptance boundary without truncating microseconds or admitting later obligations', async () => fixture(async ({ db, request, obligation }) => {
    const accepted = await obligation();
    const later = await obligation();
    let checked = false;
    // A timestamp exactly on a millisecond cannot distinguish the regression.
    // Fresh transactions find a fractional boundary without sleeps or any
    // production clock override; exhaustion fails the test instead of skipping.
    for (let attempt = 0; attempt < 16 && !checked; attempt += 1) {
      checked = await db.transaction(async (tx) => {
        const [clock] = await tx.execute<{ fractional: boolean }>(sql`SELECT
          transaction_timestamp() <> date_trunc('milliseconds', transaction_timestamp()) AS fractional`);
        if (!clock!.fractional) return false;
        // Owner-only disposable history reconstruction, as in the cohort
        // fixtures above. Production callers cannot rewrite these facts.
        await tx.execute(sql`ALTER TABLE welcome_gems_obligations DISABLE TRIGGER welcome_gems_obligation_guard`);
        await tx.execute(sql`UPDATE welcome_gems_obligations SET accepted_at = transaction_timestamp()
          + CASE WHEN wallet = ${later} THEN interval '1 microsecond' ELSE interval '0' END
          WHERE wallet IN (${accepted}, ${later})`);
        await tx.execute(sql`ALTER TABLE welcome_gems_obligations ENABLE TRIGGER welcome_gems_obligation_guard`);
        // The nested savepoint retains this transaction's exact clock. Apply
        // mode preserves the real funding locks and posting path.
        const original = await fundWelcomeGemsBudget(tx as unknown as Db, request);
        expect(original).toMatchObject({ mode: 'applied', evidence: { capBefore: {
          cohortAccepted: '10', cohortPending: '10', globalPending: '10', available: '10',
        } } });
        expect(await fundWelcomeGemsBudget(tx as unknown as Db, request))
          .toEqual({ ...original, mode: 'replay' });
        await expect(fundWelcomeGemsBudget(tx as unknown as Db, { ...request, idempotencyKey: randomUUID() }))
          .rejects.toThrow('exceeds available cap');
        return true;
      });
    }
    expect(checked).toBe(true);
  }));

  it('funds the original past UTC cohort and rejects future dates without moving it into today', async () => fixture(async ({ db, request, obligation, day }) => {
    const past = yesterday(day); await obligation(10n, past);
    const oldRequest = { ...request, cohortDay: past };
    const original = await fundWelcomeGemsBudget(db, oldRequest);
    expect(original.evidence.cohortDay).toBe(past);
    expect(await fundWelcomeGemsBudget(db, oldRequest)).toEqual({ ...original, mode: 'replay' });
    await expect(fundWelcomeGemsBudget(db, { ...request, idempotencyKey: randomUUID(), cohortDay: tomorrow(day) })).rejects.toThrow('database UTC future');
    expect((await fundWelcomeGemsBudget(db, { ...request, idempotencyKey: randomUUID(), apply: false })).evidence.capBefore.cohortAccepted).toBe('0');
  }));

  it('replays a prior-day funding receipt after its original cohort has no remaining obligation or budget', async () => fixture(async ({ db, request, obligation, day, sys }) => {
    const past = yesterday(day); const wallet = await obligation(10n, past);
    const oldRequest = { ...request, cohortDay: past };
    const preview = await fundWelcomeGemsBudget(db, { ...oldRequest, apply: false });
    // Owner-fixture reconstruction of yesterday's exact governed posting. No
    // production clock override or mutable ledger history is introduced.
    const historical = { ...preview.evidence, serverTime: `${past}T23:59:00.000Z` };
    const posted = await postTransaction(db, { idempotencyKey: `gems:budget:welcome:v1:${request.idempotencyKey}`, type: 'gems.budget.fund',
      entries: [{ account: sys.emission_pool, delta: -10n }, { account: sys.gems_reward_budget, delta: 10n }], metadata: historical });
    await grantGems(db, { wallet, gems: 10n, reason: 'welcome' });
    expect(await fundWelcomeGemsBudget(db, oldRequest)).toEqual({ mode: 'replay', receiptId: posted.transaction.id, permitted: true, evidence: historical });
  }));

  it('uses unused gross allowance when another cohort claimed the shared budget first, without renewing either allowance', async () => fixture(async ({ db, request, obligation, day }) => {
    const past = yesterday(day);
    const first = await obligation(10n, past);
    const second = await obligation(10n);
    await fundWelcomeGemsBudget(db, { ...request, cohortDay: past });
    // B reaches the shared pool before A. B's obligation is complete but its
    // unused gross funding allowance must still be able to fund pending A.
    await grantGems(db, { wallet: second, gems: 10n, reason: 'welcome' });
    const next = { ...request, idempotencyKey: randomUUID() };
    const preview = await fundWelcomeGemsBudget(db, { ...next, apply: false });
    expect(preview).toMatchObject({ permitted: true, evidence: { capBefore: {
      cohortAccepted: '10', cohortGrossFunded: '0', cohortPending: '0', globalPending: '10', budget: '0', available: '10',
    } } });
    await fundWelcomeGemsBudget(db, next);
    await grantGems(db, { wallet: first, gems: 10n, reason: 'welcome' });
    for (const cohortDay of [past, day]) {
      const exhausted = { ...request, cohortDay, idempotencyKey: randomUUID(), apply: false };
      expect((await fundWelcomeGemsBudget(db, exhausted)).evidence.capBefore).toMatchObject({
        cohortAccepted: '10', cohortGrossFunded: '10', globalPending: '0', budget: '0', available: '0',
      });
      await expect(fundWelcomeGemsBudget(db, { ...exhausted, apply: true })).rejects.toThrow('exceeds available cap');
    }
    expect((await getOrCreatePlayerAccount(db, first, 'player_gems')).balance).toBe(10n);
    expect((await getOrCreatePlayerAccount(db, second, 'player_gems')).balance).toBe(10n);
  }));

  it('requires reconciliation of unclassified funding even after its balance was entirely consumed', async () => fixture(async ({ db, request, obligation }) => {
    const wallet = await obligation();
    await fundGemsRewardBudget(db, 10n, randomUUID(), { purpose: 'old dev fixture' });
    await grantGems(db, { wallet, gems: 10n, reason: 'welcome' });
    await expect(fundWelcomeGemsBudget(db, request)).rejects.toThrow('reconcile historical postings');
  }));

  it('rejects an occupied key whose metadata or transfer entries do not prove this policy', async () => fixture(async ({ db, request, obligation, sys }) => {
    await obligation(30n);
    const valid = await fundWelcomeGemsBudget(db, request);
    const other = { ...request, idempotencyKey: randomUUID() };
    const wallet = await obligation();
    const player = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
    // Reconstruct this malformed historical posting at 0138 without invoking
    // today's custody admission engine against a schema predating its fence.
    await db.transaction(async (tx) => {
      const [txn] = await tx.insert(ledgerTransactions).values({
        idempotencyKey: `gems:budget:welcome:v1:${other.idempotencyKey}`,
        type: 'gems.budget.fund', metadata: { ...valid.evidence },
      }).returning({ id: ledgerTransactions.id });
      for (const entry of [{ account: sys.emission_pool, delta: -10n }, { account: sys.gems_reward_budget, delta: 10n },
        { account: sys.keep_genesis, delta: -1n }, { account: player.id, delta: 1n }]) {
        const [updated] = await tx.update(accounts).set({ balance: sql`${accounts.balance} + ${entry.delta}` })
          .where(eq(accounts.id, entry.account)).returning({ balance: accounts.balance });
        await tx.insert(ledgerEntries).values({
          txnId: txn!.id, accountId: entry.account, delta: entry.delta, balanceAfter: updated!.balance,
        });
      }
    });
    await expect(fundWelcomeGemsBudget(db, other)).rejects.toThrow('exact two-entry transfer');
  }));

  it('refuses wrong databases, missing chain pins, and runtime credentials before creating money rows', async () => fixture(async ({ db, request, connection, databaseUrl }) => {
    await expect(fundWelcomeGemsBudget(db, { ...request, expectedDatabase: 'another_database' })).rejects.toThrow('differs from expected');
    const role = `welcome_runtime_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    let runtime: ReturnType<typeof createDb> | undefined;
    try {
      await connection.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      const url = new URL(databaseUrl); url.username = role; url.password = password;
      runtime = createDb(url.toString());
      await expect(fundWelcomeGemsBudget(runtime.db, request)).rejects.toThrow('database-owner operator');
    } finally {
      await runtime?.sql.end();
      await connection.sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
    // Separate owner-fixture corruption must not be repaired by an operator dry-run.
    await connection.sql`ALTER TABLE economy_chain_identity DISABLE TRIGGER ALL`;
    await connection.sql`DELETE FROM economy_chain_identity`;
    await connection.sql`ALTER TABLE economy_chain_identity ENABLE TRIGGER ALL`;
    const before = await db.select().from(ledgerTransactions);
    await expect(fundWelcomeGemsBudget(db, { ...request, apply: false })).rejects.toThrow('existing database chain identity');
    expect(await db.select().from(ledgerTransactions)).toEqual(before);
    await connection.sql`INSERT INTO economy_chain_identity(singleton, cluster, keep_mint, core_program, config_pda)
      VALUES(true, 'devnet', ${gemsTestIdentity.coreProgram}, ${gemsTestIdentity.coreProgram}, ${gemsTestIdentity.configPda})`;
    await expect(fundWelcomeGemsBudget(db, { ...request, apply: false })).rejects.toThrow('existing database chain identity');
  }));

  it('fails closed before DB access for unsupported networks or a nonempty task catalogue', async () => {
    const request: WelcomeBudgetRequest = { expectedDatabase: 'test', cluster: 'mainnet-beta', cohortDay: '2026-09-21', keep: 1n, maxKeep: 1n, idempotencyKey: 'key', buildSha: 'a'.repeat(40) };
    await expect(fundWelcomeGemsBudget({} as Db, request)).rejects.toThrow('devnet only');
    Object.assign(GEMS_TASKS, { fixture: {} });
    try { await expect(fundWelcomeGemsBudget({} as Db, { ...request, cluster: 'devnet' })).rejects.toThrow('task catalogue/rate'); }
    finally { delete (GEMS_TASKS as Record<string, unknown>)['fixture']; }
  });

  it('caps all independent constraints, including global pending minus already available backing', () => {
    const caps = { cohortAccepted: 100n, cohortGrossFunded: 20n, cohortPending: 70n, globalPending: 90n, budget: 40n, maxKeep: 60n, emissionPool: 80n };
    expect(welcomeBudgetAvailable(caps)).toBe(50n);
    expect(welcomeBudgetAvailable({ ...caps, cohortGrossFunded: 99n })).toBe(1n);
    expect(welcomeBudgetAvailable({ ...caps, cohortPending: 0n })).toBe(50n);
    expect(welcomeBudgetAvailable({ ...caps, maxKeep: 3n })).toBe(3n);
    expect(welcomeBudgetAvailable({ ...caps, emissionPool: 4n })).toBe(4n);
    expect(welcomeBudgetAvailable({ ...caps, budget: 91n })).toBe(0n);
  });

  it('CLI defaults to dry-run and requires every target and amount input explicitly', () => {
    const args = ['--database-url', 'postgres://operator:secret@localhost/example', '--expected-db', 'example', '--cluster', 'devnet',
      '--keep', '10', '--max-keep', '20', '--cohort-day', '2026-09-21', '--idempotency-key', 'reviewed-cohort-1'];
    expect(parseWelcomeBudgetArgs(args).request.apply).toBe(false);
    expect(parseWelcomeBudgetArgs([...args, '--apply']).request.apply).toBe(true);
    for (let index = 0; index < args.length; index += 2) expect(() => parseWelcomeBudgetArgs(args.filter((_, i) => i < index || i > index + 1))).toThrow();
    expect(() => parseWelcomeBudgetArgs([...args, '--apply', '--apply'])).toThrow();
    expect(() => parseWelcomeBudgetArgs(args.map((v) => v === 'example' ? 'wrong' : v))).toThrow('expected database');
    for (const bad of ['-1', '1e3', '01', '1.2']) expect(() => parseWelcomeBudgetArgs(args.map((v) => v === '10' ? bad : v))).toThrow();
  });
});
