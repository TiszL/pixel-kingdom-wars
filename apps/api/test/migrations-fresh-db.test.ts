/**
 * 0134 on a FRESH database (E2-GEMS-CONTRACT §1.1 / §7, GEMS-CURRENCY §11).
 *
 * WHY: enum labels must commit before dependent DDL uses them. The migration
 * runner commits one file at a time; 0134 appends values without replacing any
 * enum, retyping money columns, or rebuilding existing partial indexes.
 * The remaining cases pin the DB-level rules the Gems ledger relies on:
 * account scope, the workshop cost identity, gems_buy intent uniqueness and
 * item provenance — each one is a guard that code cannot bypass.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { createDb } from '../src/db/client';
import { latestMigrationInBuild, runMigrations } from '../src/db/migrate';
import {
  accounts, baseItems, bases, deposits, ledgerTransactions, playerItems, players, workshopJobs,
} from '../src/db/schema';
import { ACCOUNT_CURRENCY, bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { ADMIN_DATABASE_URL } from './db-url';

const DB_PREFIX = 'shardkeep_migration_fresh_';

function assertDisposableDbName(name: string): void {
  if (!new RegExp(`^${DB_PREFIX}[0-9a-f]{32}_test$`).test(name)) {
    throw new Error(`refusing to manage unexpected database name: ${name}`);
  }
}

/** Drizzle wraps driver errors (DrizzleQueryError.cause); raw postgres does not. */
async function pgError(work: Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await work;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    return (cause && typeof cause === 'object' ? cause : err) as { code?: string; constraint_name?: string };
  }
  throw new Error('expected the statement to be refused');
}

const wallet = () => `fresh${randomUUID().replaceAll('-', '')}`;

describe('migration 0134 gems currency on a fresh database', () => {
  const databaseName = `${DB_PREFIX}${randomUUID().replaceAll('-', '')}_test`;
  assertDisposableDbName(databaseName);
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const databaseUrl = new URL(ADMIN_DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;
  let conn: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>['db'];

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    conn = createDb(databaseUrl.toString(), { max: 1 });
    db = conn.db;
    // The complete history uses the same per-file commits as the migration CLI.
    // The held owner-scope replacement is exercised only in this fixture.
    await runMigrations(db);
  }, 120_000);

  afterAll(async () => {
    await conn?.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  });

  it('applies every migration through the M42 frontier and keeps each enum in label order with the Gems labels appended', async () => {
    const [applied] = await conn.sql<{ count: string; created_at: string }[]>`
      select count(*)::text as count, max(created_at)::text as created_at from drizzle.__drizzle_migrations
    `;
    const latest = latestMigrationInBuild();
    // Later building labels and reserve identity follow the three 0134 steps.
    // Preserve main's deployed 0170/0500 prefix; append the private Phase E frontier.
    // 2026-10-10 (CI 37503885235): this used to pin '0257…' and 261, hand-bumped per migration, and went
    // stale when Phase E added 0258..0299. Pin the rule instead: main's deployed 158-entry prefix
    // (0000..0153 incl. the three 0134 steps, then 0170 and 0500) stays first; every private Phase E file
    // follows with a strictly later `when` (the migrator only applies entries newer than the last applied
    // one, so an earlier stamp would be skipped on every existing database); a fresh database applies all of
    // them and its frontier is the journal's last entry.
    const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const main = journal.entries.slice(0, 158), phaseE = journal.entries.slice(158);
    expect(main.slice(-2).map((entry) => entry.tag)).toEqual(['0170_native_update_channel', '0500_release_history']);
    expect(phaseE.length).toBeGreaterThan(0);
    phaseE.forEach((entry, i) => expect(entry.when, entry.tag).toBeGreaterThan((phaseE[i - 1] ?? main.at(-1)!).when));
    expect(latest.tag).toBe(phaseE.at(-1)!.tag);
    expect(Number(applied?.created_at)).toBe(latest.when);
    expect(Number(applied?.count)).toBe(main.length + phaseE.length); // main158 plus every private Phase E migration

    const labels = async (type: string) => (await conn.sql<{ enumlabel: string }[]>`
      select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = ${type} order by e.enumsortorder
    `).map((row) => row.enumlabel);

    // Order matters to ORDER BY on enum columns; 0134 may only append.
    expect(await labels('account_kind')).toEqual([
      'player_keep', 'player_sol_credit', 'emission_pool', 'burn', 'league_pool',
      'league_entitlement_escrow', 'treasury', 'quest_bucket', 'sol_treasury',
      'withdrawal_escrow', 'onchain_outflow', 'onchain_inflow', 'keep_genesis',
      'league_sol_pool', 'player_shards', 'forge_escrow', 'forge_payout_escrow',
      'clan_chest', 'shard_genesis', 'shard_burn', 'base_shards', 'base_forge_escrow',
      'raid_loot_escrow', 'mail_keep_escrow', 'mail_shards_escrow',
      'player_gems', 'player_gems_store', 'gems_mint', 'gems_sink', 'gems_reward_budget', 'shards_tax_escrow',
      'charter_creation_escrow', 'mining_contribution_escrow',
    ]);
    expect(await labels('currency')).toEqual(['KEEP', 'SOL', 'SHARDS', 'GEMS']);
    expect(await labels('deposit_kind')).toEqual([
      'entry', 'deed', 'builder', 'expansion', 'sol_topup', 'keep_deposit', 'energy',
      'energy_pack', 'shield', 'mine', 'mine_build', 'warzone_shield', 'keep_vend', 'gems_buy',
    ]);
    // 0134 never creates legacy replacement types.
    const leftovers = await conn.sql<{ typname: string }[]>`
      select typname from pg_type where typname like '%_legacy_0134'
    `;
    expect(leftovers).toEqual([]);
  });

  it('preserves the four 0070 pending-slot index definitions and adds Gems intent uniqueness', async () => {
    // The additive enum change preserves literal-dependent indexes. Losing one
    // would reopen the duplicate-quote races closed by 0063 / 0066 / 0070.
    const rows = await conn.sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes where tablename = 'deposits' and indexname in (
        'deposits_builder_slot_pending_uq', 'deposits_builder_legacy_slot_pending_uq',
        'deposits_expansion_slot_pending_uq', 'deposits_expansion_legacy_slot_pending_uq',
        'deposits_gems_buy_key_uq', 'deposits_base_purchase_key_uq'
      ) order by indexname
    `;
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(Object.keys(defs)).toEqual([
      'deposits_base_purchase_key_uq', 'deposits_builder_legacy_slot_pending_uq', 'deposits_builder_slot_pending_uq',
      'deposits_expansion_legacy_slot_pending_uq', 'deposits_expansion_slot_pending_uq', 'deposits_gems_buy_key_uq',
    ]);
    for (const name of Object.keys(defs)) expect(defs[name]).toContain('UNIQUE INDEX');
    expect(defs['deposits_builder_slot_pending_uq']).toContain("(kind = 'builder'::deposit_kind)");
    expect(defs['deposits_builder_slot_pending_uq']).toContain("(payload ? 'baseId'::text)");
    expect(defs['deposits_builder_legacy_slot_pending_uq']).toContain("(NOT (payload ? 'baseId'::text))");
    expect(defs['deposits_expansion_slot_pending_uq']).toContain("(kind = 'expansion'::deposit_kind)");
    expect(defs['deposits_expansion_legacy_slot_pending_uq']).toContain("(NOT (payload ? 'baseId'::text))");
    expect(defs['deposits_gems_buy_key_uq']).toContain("(kind = 'gems_buy'::deposit_kind)");
  });

  it('bootstraps the Gems system accounts and creates a wallet-scoped player_gems account', async () => {
    const system = await bootstrapSystemAccounts(db);
    for (const kind of ['gems_mint', 'gems_sink', 'gems_reward_budget'] as const) {
      const [row] = await db.select().from(accounts).where(eq(accounts.id, system[kind]));
      expect(row).toMatchObject({
        ownerWallet: null, baseId: null, kind, currency: ACCOUNT_CURRENCY[kind], balance: 0n,
      });
    }
    expect(ACCOUNT_CURRENCY.gems_mint).toBe('GEMS');
    expect(ACCOUNT_CURRENCY.gems_sink).toBe('GEMS');
    // The reward budget is the KEEP backing behind grants (G-3), not Gems.
    expect(ACCOUNT_CURRENCY.gems_reward_budget).toBe('KEEP');

    const w = wallet();
    await db.insert(players).values({ wallet: w });
    const gems = await getOrCreatePlayerAccount(db, w, 'player_gems');
    expect(gems).toMatchObject({ ownerWallet: w, baseId: null, kind: 'player_gems', currency: 'GEMS', balance: 0n });
    // Idempotent under the (owner, kind) unique.
    expect((await getOrCreatePlayerAccount(db, w, 'player_gems')).id).toBe(gems.id);
    const store = await getOrCreatePlayerAccount(db, w, 'player_gems_store');
    expect(store).toMatchObject({ ownerWallet: w, baseId: null, currency: 'GEMS' });
  });

  it('accounts_owner_scope_ck refuses Gems accounts outside their scope', async () => {
    const w = wallet();
    await db.insert(players).values({ wallet: w });
    const [base] = await db.insert(bases).values({ ownerWallet: w, landPaidAt: new Date() }).returning();

    // A player Gems account tied to a base: Gems follow the wallet, never the deed.
    expect(await pgError(db.insert(accounts).values({
      ownerWallet: w, baseId: base!.id, kind: 'player_gems', currency: 'GEMS',
    }))).toMatchObject({ code: '23514', constraint_name: 'accounts_owner_scope_ck' });
    // A deed-owned player_gems row is refused too.
    expect(await pgError(db.insert(accounts).values({
      baseId: base!.id, kind: 'player_gems', currency: 'GEMS',
    }))).toMatchObject({ code: '23514', constraint_name: 'accounts_owner_scope_ck' });
    // An ownerless player_gems row would be an unattributed Gems balance.
    expect(await pgError(db.insert(accounts).values({
      kind: 'player_gems', currency: 'GEMS',
    }))).toMatchObject({ code: '23514', constraint_name: 'accounts_owner_scope_ck' });
    // A wallet-owned mint would let a player print Gems.
    expect(await pgError(db.insert(accounts).values({
      ownerWallet: w, kind: 'gems_mint', currency: 'GEMS',
    }))).toMatchObject({ code: '23514', constraint_name: 'accounts_owner_scope_ck' });
  });

  it('workshop_jobs refuses a shards_charged that is not ingots × PHASE_E_POLICY.forge.shardsPerIngot', async () => {
    const w = wallet();
    await db.insert(players).values({ wallet: w });
    const [base] = await db.insert(bases).values({ ownerWallet: w, landPaidAt: new Date() }).returning();
    const debit = async () => (await db.insert(ledgerTransactions)
      .values({ idempotencyKey: `workshop:${base!.id}:${w}:${randomUUID()}`, type: 'workshop.refine' })
      .returning())[0]!.id;
    const job = (ingots: number, shardsCharged: bigint, debitLedgerTxnId: string) => ({
      baseId: base!.id, startedByWallet: w, workshopLevelAtStart: 1, recipeVersion: 1,
      ingots, shardsCharged, readyAt: new Date(Date.now() + 60_000), debitLedgerTxnId,
      startIdempotencyKey: randomUUID(),
    });
    const perIngot = BigInt(PHASE_E_POLICY.forge.shardsPerIngot);

    // The SQL literal and the constant must agree, or a recipe change would
    // silently disagree with the DB guard.
    expect(await pgError(db.insert(workshopJobs).values(job(3, 3n * perIngot - 1n, await debit()))))
      .toMatchObject({ code: '23514', constraint_name: 'workshop_jobs_shards_charged_ck' });
    expect(await pgError(db.insert(workshopJobs).values(job(0, 0n, await debit()))))
      .toMatchObject({ code: '23514', constraint_name: 'workshop_jobs_ingots_ck' });

    const paid = await debit();
    const [row] = await db.insert(workshopJobs).values(job(3, 3n * perIngot, paid)).returning();
    expect(row).toMatchObject({ ingots: 3, shardsCharged: 3n * perIngot, collectedAt: null });
    // One SHARDS debit funds exactly one job.
    expect(await pgError(db.insert(workshopJobs).values(job(1, perIngot, paid))))
      .toMatchObject({ code: '23505', constraint_name: 'workshop_jobs_debit_ledger_txn_id_unique' });
  });

  it('deposits_gems_buy_key_uq allows one gems_buy intent per (wallet, idempotencyKey) and nothing else', async () => {
    const w1 = wallet();
    const w2 = wallet();
    await db.insert(players).values([{ wallet: w1 }, { wallet: w2 }]);
    const intent = (playerWallet: string, kind: 'gems_buy' | 'keep_deposit', idempotencyKey: string) => ({
      playerWallet, kind, reference: randomUUID(), payload: { idempotencyKey, keepIn: '10' },
    });

    await db.insert(deposits).values(intent(w1, 'gems_buy', 'key-1'));
    expect(await pgError(db.insert(deposits).values(intent(w1, 'gems_buy', 'key-1'))))
      .toMatchObject({ code: '23505', constraint_name: 'deposits_gems_buy_key_uq' });
    // Another wallet may reuse the key; another kind is outside the partial index.
    await db.insert(deposits).values(intent(w2, 'gems_buy', 'key-1'));
    await db.insert(deposits).values(intent(w1, 'keep_deposit', 'key-1'));
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, w1))).toHaveLength(2);
  });

  it('acquired_via defaults to legacy and refuses unknown provenance on both inventories', async () => {
    const w = wallet();
    await db.insert(players).values({ wallet: w });
    const [base] = await db.insert(bases).values({ ownerWallet: w, landPaidAt: new Date() }).returning();

    const [legacy] = await db.insert(playerItems).values({ playerWallet: w, itemId: 'skin_keep_gilded' }).returning();
    expect(legacy?.acquiredVia).toBe('legacy');
    const [bound] = await db.insert(playerItems)
      .values({ playerWallet: w, itemId: 'skin_keep_frost', acquiredVia: 'shop_gems' }).returning();
    expect(bound?.acquiredVia).toBe('shop_gems');
    expect(await pgError(db.insert(playerItems).values({ playerWallet: w, itemId: 'skin_keep_voidstone', acquiredVia: 'bogus' })))
      .toMatchObject({ code: '23514', constraint_name: 'player_items_acquired_via_ck' });

    const [ingot] = await db.insert(baseItems)
      .values({ baseId: base!.id, itemId: 'forge_ingot', acquiredVia: 'craft' }).returning();
    expect(ingot?.acquiredVia).toBe('craft');
    expect(await pgError(db.insert(baseItems).values({ baseId: base!.id, itemId: 'other_item', acquiredVia: 'bogus' })))
      .toMatchObject({ code: '23514', constraint_name: 'base_items_acquired_via_ck' });
  });
});
