/**
 * The deed-economy cutover is a database security boundary, not merely a route
 * flag: a rolled-back binary must be unable to recreate wallet gameplay or
 * spend the drained wallet SHARDS account after activation.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts, army, baseEconomyBackfills, bases, baseSlots, deedEconomyCutoverState,
  deposits, forgeContributions, playerItems,
} from '../src/db/schema';
import {
  activateDeedEconomyCutover, completeBaseEconomyBackfill,
} from '../src/game/baseEconomy';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ensureValleyAtSite } from '../src/game/world';
import {
  bootstrapSystemAccounts, getOrCreateBaseAccount,
  getOrCreatePlayerAccount, postTransaction,
} from '../src/ledger';
import { creditDeposit } from '../src/money/deposits';
import { connectTestDb, createTestPlayer } from './helpers';
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL } from './db-url';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';
import { createMigratedDatabase } from './migratedTemplate';
import globalSetup from './global-setup';

const conn = connectTestDb();
const db = conn.db;

// WHY a database of its own (2026-10-10, CI round 2 shard 6: beforeAll refused, 11 cases
// skipped). This suite flips a DATABASE-GLOBAL, irreversible boundary, and activation reads the
// whole database (wallet SHARDS, backfills, open raids, unbound deposits, legacy physical
// state), so its result must not depend on what earlier files left behind. The old in-place
// reset TRUNCATEd the shared run database with named TRUNCATE guards paused and, correctly,
// refused to discard immutable facts. Every raid leaves a bound_cosmetic_raid_visuals row
// (FK to raids), so after any raid file it refused; no in-place reset can be sound while such
// capture tables hang off raids, bases and players. The suite therefore needs a FRESH
// database named exactly shardkeep_test: the 0077/0123 test escape is pinned to that name
// (K-035) and a cluster holds one such database. Only CI gives this file a cluster of its own
// (one Postgres service per API shard job), whose shardkeep_test the run's global-setup
// already drops and recreates. There the suite recreates it exactly as global-setup does
// (drop, create, every migration, finite pools), runs, and recreates it again afterwards, so
// later files in the shard see the same pristine state a first file sees. No guard is paused
// and no recorded fact is truncated. Anywhere else it refuses loudly and never skips: a
// shared local shardkeep_test is never dropped by this file.
let ownsDatabase = false;

function ciOwnedExactTestDatabase(): boolean {
  const url = new URL(TEST_DATABASE_URL);
  return process.env['GITHUB_ACTIONS'] === 'true' && url.hostname === 'localhost'
    && url.pathname === '/shardkeep_test';
}

beforeAll(async () => {
  if (!ciOwnedExactTestDatabase()) {
    throw new Error('the deed cutover suite needs CI\'s per-job shardkeep_test cluster (K-035)');
  }
  ownsDatabase = true;
  await globalSetup();
  expect(await conn.sql`select current_database() as name`).toEqual([{ name: 'shardkeep_test' }]);
  // The pre-case shape the cases were written against: the old reset ended by seeding one
  // canonical production valley (with its nine PvE camps) after the finite pools.
  await ensureValleyAtSite(db, 0);
}, FRESH_DB_CASE_MS);

afterAll(async () => {
  await conn.sql.end();
  if (ownsDatabase) await globalSetup();
}, FRESH_DB_CASE_MS);

async function errorMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    const wrapped = error as { message?: string; cause?: { message?: string } };
    return wrapped.cause?.message ?? wrapped.message ?? String(error);
  }
}

describe.sequential('one-way deed-economy database fence', () => {
  it('keeps a fresh flag-off database dormant instead of silently activating it', async () => {
    expect(await activateDeedEconomyCutover(db, false)).toEqual({ phase: 'fenced', activated: false });
    const [state] = await db.select().from(deedEconomyCutoverState);
    expect(state).toMatchObject({ id: true, phase: 'fenced', readyAt: null });
    const old = createDb(TEST_DATABASE_URL, { max: 1, deedEconomyWriter: false });
    try {
      // The fence is deliberately dormant until the one-way phase flip, so the
      // old deployment can drain/backfill during its maintenance window.
      await expect(bootstrapSystemAccounts(old.db)).resolves.toBeDefined();
    } finally {
      await old.sql.end();
    }
  });

  it('lets the audited cutover finish idempotently but never reopens wallet SHARDS', async () => {
    // This fixture is deliberately installed with the exact session-local test
    // escape; production/dev databases cannot satisfy its DB-name half.
    const owner = await createTestPlayer(db);
    const [base] = await db.insert(bases).values({ ownerWallet: owner.wallet }).returning();
    const source = await getOrCreatePlayerAccount(db, owner.wallet, 'player_shards');
    const destination = await getOrCreateBaseAccount(db, base!.id, 'base_shards');
    const sys = await bootstrapSystemAccounts(db);
    const forgeDestination = await getOrCreateBaseAccount(db, base!.id, 'base_forge_escrow');
    await postTransaction(db, {
      idempotencyKey: `cutover-fence-source:${owner.wallet}`,
      type: 'test.cutover_fence_source',
      entries: [
        { account: sys.shard_genesis, delta: -90n },
        { account: source.id, delta: 90n },
      ],
    });
    await db.insert(baseEconomyBackfills).values({
      legacyWallet: owner.wallet, primaryBaseId: base!.id,
      sourceShardAccountId: source.id, destinationShardAccountId: destination.id,
      legacyShardBalance: 90n, sourceForgeEscrowAccountId: sys.forge_escrow,
      destinationForgeEscrowAccountId: forgeDestination.id,
    });

    const first = await completeBaseEconomyBackfill(db, owner.wallet);
    const retry = await completeBaseEconomyBackfill(db, owner.wallet);
    expect(retry.transactionId).toBe(first.transactionId);
    expect((await db.select().from(accounts).where(eq(accounts.id, source.id)))[0]?.balance).toBe(0n);
    expect((await db.select().from(accounts).where(eq(accounts.id, destination.id)))[0]?.balance).toBe(90n);
  });

  it('refuses activation while a pending base-owned payment has no frozen deed', async () => {
    const owner = await createTestPlayer(db);
    const [legacy] = await db.insert(deposits).values({
      playerWallet: owner.wallet,
      kind: 'energy',
      reference: randomUUID(),
      status: 'pending',
      payload: { amountLamports: 1 },
    }).returning();

    // WHY: this reference might already be paid on-chain. Activation may neither
    // guess the wallet's current deed nor expire a real customer payment.
    expect(await errorMessage(() => activateDeedEconomyCutover(db, true)))
      .toContain('DEED_ECONOMY_LEGACY_DEPOSIT_OPEN');
    expect((await db.select().from(deedEconomyCutoverState))[0]?.phase).toBe('fenced');
    expect((await db.select().from(deposits).where(eq(deposits.id, legacy!.id)))[0]?.status)
      .toBe('pending');

    // The pre-cutover watcher/operator owns terminalization. Only then may the
    // irreversible phase flip proceed.
    await db.update(deposits).set({ status: 'expired' }).where(eq(deposits.id, legacy!.id));
  });

  it('activation waits out an old RowExclusive writer and rejects writes begun afterward', async () => {
    const owner = await createTestPlayer(db);
    const old = createDb(TEST_DATABASE_URL, { max: 1, deedEconomyWriter: false });
    let release!: () => void;
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => { inserted = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    try {
      const oldTxn = old.db.transaction(async (tx) => {
        await tx.insert(army).values({ playerWallet: owner.wallet, troop: 'mage', count: 1 });
        inserted();
        await releaseSignal;
      });
      await insertedSignal;
      let activated = false;
      const activation = activateDeedEconomyCutover(db, true).then((value) => {
        activated = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activated).toBe(false);
      release();
      await oldTxn;
      await expect(activation).resolves.toEqual({ phase: 'ready', activated: true });
      expect(await errorMessage(() => old.db.insert(army).values({
        playerWallet: owner.wallet, troop: 'mage', count: 1,
      }))).toContain('LEGACY_GAMEPLAY_WRITER_FENCED:army');
    } finally {
      release?.();
      await old.sql.end();
    }
  });

  it('activation is immutable and production startup can never return to flag-off mode', async () => {
    expect(await activateDeedEconomyCutover(db, true)).toEqual({ phase: 'ready', activated: false });
    await expect(activateDeedEconomyCutover(db, false)).rejects.toMatchObject({
      code: 'base_economy.rollback_forbidden',
    });
    const [state] = await db.select().from(deedEconomyCutoverState);
    expect(state).toMatchObject({ id: true, phase: 'ready' });
    expect(state?.readyAt).toBeInstanceOf(Date);
  });

  it('requires the deed-aware writer for every ledger account mutation after activation', async () => {
    const owner = await createTestPlayer(db);
    const [base] = await db.insert(bases).values({ ownerWallet: owner.wallet }).returning();
    const system = await bootstrapSystemAccounts(db);
    const old = createDb(TEST_DATABASE_URL, { max: 1, deedEconomyWriter: false });
    const current = createDb(TEST_DATABASE_URL, { max: 1, deedEconomyWriter: true });
    try {
      // WHY: ON CONFLICT does not make stale bootstrap safe. Its BEFORE INSERT
      // triggers still run, and an old image also computes reserves without the
      // deed/league liability set carried by this activated schema.
      expect(await errorMessage(() => bootstrapSystemAccounts(old.db)))
        .toContain('DEED_ECONOMY_WRITER_REQUIRED:accounts');
      expect(await errorMessage(() => old.db.insert(accounts).values({
        baseId: base!.id, kind: 'base_shards', currency: 'SHARDS',
      }))).toContain('DEED_ECONOMY_WRITER_REQUIRED:accounts');
      expect(await errorMessage(() => old.db.update(accounts)
        .set({ balance: sql`${accounts.balance}` })
        .where(eq(accounts.id, system.treasury))))
        .toContain('DEED_ECONOMY_WRITER_REQUIRED:accounts');
      expect(await errorMessage(() => old.db.delete(accounts)
        .where(eq(accounts.id, system.treasury))))
        .toContain('DEED_ECONOMY_WRITER_REQUIRED:accounts');

      // The current writer may create, update and remove a disposable base
      // account. This proves the fence distinguishes binary generation rather
      // than freezing the live ledger itself.
      const created = await getOrCreateBaseAccount(current.db, base!.id, 'base_shards');
      await expect(current.db.update(accounts).set({ balance: sql`${accounts.balance}` })
        .where(eq(accounts.id, created.id))).resolves.toBeDefined();
      await expect(current.db.delete(accounts).where(eq(accounts.id, created.id)))
        .resolves.toBeDefined();
    } finally {
      await old.sql.end();
      await current.sql.end();
    }
  });

  it('blocks old binaries from publishing or retaining an unbound payable reference', async () => {
    const owner = await createTestPlayer(db);
    const old = createDb(TEST_DATABASE_URL, { max: 1, deedEconomyWriter: false });
    try {
      expect(await errorMessage(() => old.db.insert(deposits).values({
        playerWallet: owner.wallet,
        kind: 'shield',
        reference: randomUUID(),
        status: 'pending',
        payload: { amountLamports: 1 },
      }))).toContain('LEGACY_BASE_DEPOSIT_SCOPE_FENCED');

      // Install an upgrade-era row through the exact test-only escape. A stale
      // writer cannot keep it payable, but may terminalize it for reconciliation.
      const [legacy] = await db.insert(deposits).values({
        playerWallet: owner.wallet,
        kind: 'energy',
        reference: randomUUID(),
        status: 'pending',
        payload: { amountLamports: 1 },
      }).returning();
      expect(await errorMessage(() => old.db.update(deposits).set({ payload: null })
        .where(eq(deposits.id, legacy!.id)))).toContain('LEGACY_BASE_DEPOSIT_SCOPE_FENCED');
      await expect(old.db.update(deposits).set({ status: 'expired' })
        .where(eq(deposits.id, legacy!.id))).resolves.toBeDefined();
    } finally {
      await old.sql.end();
    }
  });

  it('never guesses a selected deed for a paid legacy quote after activation', async () => {
    const owner = await createTestPlayer(db);
    const [base] = await db.insert(bases).values({
      ownerWallet: owner.wallet,
      landPaidAt: new Date('2026-08-13T00:00:00.000Z'),
    }).returning();
    await db.insert(baseSlots).values({ wallet: owner.wallet, slot: 1, baseId: base!.id });
    const [legacy] = await db.insert(deposits).values({
      playerWallet: owner.wallet,
      kind: 'energy',
      reference: randomUUID(),
      status: 'pending',
      payload: { amountLamports: 1 },
    }).returning();

    await expect(creditDeposit(db, legacy!.id, {
      txSignature: `paid-${randomUUID()}`,
      wallet: owner.wallet,
      kind: 'energy',
      lamports: 1n,
      finalized: true,
    })).rejects.toMatchObject({ code: 'DEPOSIT_BASE_REQUIRED' });
    const [preserved] = await db.select().from(deposits).where(eq(deposits.id, legacy!.id));
    expect(preserved).toMatchObject({
      status: 'pending',
      paymentSignature: null,
      txSignature: null,
      amount: null,
    });
    await db.update(deposits).set({ status: 'expired' }).where(eq(deposits.id, legacy!.id));
  });

  it('rejects old writers, permits cosmetics and historical Forge KEEP claim fields', async () => {
    const owner = await createTestPlayer(db);
    const old = createDb(TEST_DATABASE_URL, { max: 1, deedEconomyWriter: false });
    try {
      expect(await errorMessage(() => old.db.insert(army).values({
        playerWallet: owner.wallet, troop: 'highlander', count: 1,
      }))).toContain('LEGACY_GAMEPLAY_WRITER_FENCED:army');
      expect(await errorMessage(() => old.db.insert(playerItems).values({
        playerWallet: owner.wallet, itemId: 'keg_of_haste', qty: 1,
      }))).toContain('LEGACY_NONCOSMETIC_ITEM_FENCED');
      // The 0077 fence's cosmetic allowlist literally names the three keep-skin
      // ids. Those skins are RETIRED (M23 a8) and the ids are unknown to the
      // catalog, but the SQL exemption is immutable migration history — this
      // pins that an old binary's cosmetic write path stays fence-exempt.
      await expect(old.db.insert(playerItems).values({
        playerWallet: owner.wallet, itemId: 'skin_keep_gilded', qty: 1,
      })).resolves.toBeDefined();

      const id = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('shardkeep.allow_legacy_test', 'on', true)`);
        await tx.insert(forgeContributions).values({
          id, day: '2000-01-01', playerWallet: owner.wallet, shards: 1n,
          settledAt: new Date(), keepPaid: 1n, shardsRefunded: 0n,
        });
      });
      await expect(old.db.update(forgeContributions).set({ claimedAt: new Date() })
        .where(eq(forgeContributions.id, id))).resolves.toBeDefined();
      expect(await errorMessage(() => old.db.update(forgeContributions).set({ shards: 2n })
        .where(eq(forgeContributions.id, id)))).toContain('LEGACY_FORGE_WRITER_FENCED');
    } finally {
      await old.sql.end();
    }
  });

  it('test escape requires both exact database and SET LOCAL transaction scope', async () => {
    const owner = await createTestPlayer(db);
    const old = createDb(TEST_DATABASE_URL, { max: 1, deedEconomyWriter: false });
    try {
      expect(await errorMessage(() => old.db.execute(sql`
        select set_config('shardkeep.allow_legacy_test', 'wrong', false)
      `).then(() => old.db.insert(army).values({
        playerWallet: owner.wallet, troop: 'bowman', count: 1,
      })))).toContain('LEGACY_GAMEPLAY_WRITER_FENCED:army');
      await old.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('shardkeep.allow_legacy_test', 'on', true)`);
        await tx.insert(army).values({ playerWallet: owner.wallet, troop: 'bowman', count: 1 });
        await tx.insert(accounts).values({
          ownerWallet: owner.wallet, kind: 'player_sol_credit', currency: 'SOL',
        });
      });
      expect(await errorMessage(() => old.db.update(army).set({ count: 2 }).where(eq(
        army.playerWallet, owner.wallet,
      )))).toContain('LEGACY_GAMEPLAY_WRITER_FENCED:army');
      expect(await errorMessage(() => old.db.update(accounts)
        .set({ balance: sql`${accounts.balance}` })
        .where(eq(accounts.ownerWallet, owner.wallet))))
        .toContain('DEED_ECONOMY_WRITER_REQUIRED:accounts');
    } finally {
      await old.sql.end();
    }
  });

  it('the test GUC grants nothing in a database not named exactly shardkeep_test', async () => {
    const wrongName = 'shardkeep_cutover_wrong';
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const wrongUrl = new URL(ADMIN_DATABASE_URL);
    wrongUrl.pathname = `/${wrongName}`;
    let wrong: ReturnType<typeof createDb> | undefined;
    let wrongOld: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${wrongName} WITH (FORCE)`);
      // A clone of the template this run's global setup copied from shardkeep_test right after
      // its replay (test/migratedTemplate.ts): the same functions, triggers and fence a full
      // replay installs, under another name. The escape checks current_database() at run time,
      // so a copy of a shardkeep_test-born database must grant nothing either.
      await createMigratedDatabase(admin, wrongName);
      wrong = createDb(wrongUrl.toString(), { max: 1, legacyTestEscape: true });
      await runMigrations(wrong.db);
      await activateDeedEconomyCutover(wrong.db, true);
      wrongOld = createDb(wrongUrl.toString(), {
        max: 1, deedEconomyWriter: false, legacyTestEscape: true,
      });
      const wallet = `wrong-db-${randomUUID()}`;
      await wrong.db.execute(sql`insert into players (wallet) values (${wallet})`);
      expect(await errorMessage(() => wrong!.db.insert(army).values({
        playerWallet: wallet, troop: 'highlander', count: 1,
      }))).toContain('LEGACY_GAMEPLAY_WRITER_FENCED:army');
      expect(await errorMessage(() => wrongOld!.db.insert(accounts).values({
        ownerWallet: wallet, kind: 'player_sol_credit', currency: 'SOL',
      }))).toContain('DEED_ECONOMY_WRITER_REQUIRED:accounts');
    } finally {
      await wrongOld?.sql.end();
      await wrong?.sql.end();
      // The literal fixed name is the only destructive target; never derive it
      // from an environment variable or user input.
      await admin.unsafe(`DROP DATABASE IF EXISTS ${wrongName} WITH (FORCE)`);
      await admin.end();
    }
  });

});
