/**
 * Ledger engine property tests (ARCHITECTURE §9 task #7: "schema+ledger first,
 * property tests: entries sum to zero, idempotency").
 *
 * WHY these properties: the ledger is the custody layer for player money
 * (GDD §4.9). If idempotency double-posts, deposits double-credit; if entries
 * don't sum to zero, value is printed or destroyed silently; if balance_after
 * drifts under concurrency, proof-of-liabilities snapshots lie.
 */
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts, ledgerEntries, ledgerTransactions, players, questBucketRetirementState,
} from '../src/db/schema';
import {
  InsufficientFundsError,
  UnbalancedTransactionError,
  bootstrapSystemAccounts,
  canGoNegative,
  getOrCreatePlayerAccount,
  postTransaction,
  type SystemAccountKind,
} from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, randomWallet } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let db: ReturnType<typeof connectTestDb>['db'];
let system: Record<SystemAccountKind, string>;

beforeAll(async () => {
  conn = connectTestDb();
  db = conn.db;
  system = await bootstrapSystemAccounts(db);
});

afterAll(async () => {
  await conn.sql.end();
});

/** Fund a player KEEP account from the finite emission pool. */
async function fund(accountId: string, amount: bigint) {
  await postTransaction(db, {
    idempotencyKey: `test-fund-${randomUUID()}`,
    type: 'test.fund',
    entries: [
      { account: system.emission_pool, delta: -amount },
      { account: accountId, delta: amount },
    ],
  });
}

describe('postTransaction', () => {
  it('keeps the retired quest bucket at zero and rejects every new posting', async () => {
    const [state] = await db.select().from(questBucketRetirementState);
    const [bucket] = await db.select().from(accounts).where(eq(accounts.id, system.quest_bucket));
    expect(state).toMatchObject({ phase: 'ready', reconciliationTxnId: null });
    expect(bucket?.balance).toBe(0n);
    expect(canGoNegative('quest_bucket')).toBe(false);

    const key = `test-retired-quest-${randomUUID()}`;
    await expect(postTransaction(db, {
      idempotencyKey: key,
      type: 'test.retired_quest_write',
      entries: [
        { account: system.keep_genesis, delta: -1n },
        { account: system.quest_bucket, delta: 1n },
      ],
    })).rejects.toMatchObject({
      cause: { code: 'P0001', message: expect.stringContaining('QUEST_BUCKET_RETIRED') },
    });
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key))).toHaveLength(0);
  });

  it('test fixture funding leaves the retired historical bucket untouched', async () => {
    class RollbackFixture extends Error {}

    await expect(db.transaction(async (tx) => {
      const wallet = randomWallet();
      await tx.insert(players).values({ wallet });
      const [questBefore] = await tx.select().from(accounts).where(eq(accounts.id, system.quest_bucket));
      const [genesisBefore] = await tx.select().from(accounts).where(eq(accounts.id, system.keep_genesis));
      const amount = questBefore!.balance + 1n;

      await fundTestKeep(tx, wallet, amount, 'test.fixture_fund', `test-fixture-${randomUUID()}`);

      const [questAfter] = await tx.select().from(accounts).where(eq(accounts.id, system.quest_bucket));
      const [genesisAfter] = await tx.select().from(accounts).where(eq(accounts.id, system.keep_genesis));
      const player = await getOrCreatePlayerAccount(tx, wallet, 'player_keep');
      expect(questAfter!.balance).toBe(questBefore!.balance);
      expect(genesisAfter!.balance).toBe(genesisBefore!.balance - amount);
      expect(player.balance).toBe(amount);
      expect(canGoNegative('quest_bucket')).toBe(false);

      throw new RollbackFixture();
    })).rejects.toBeInstanceOf(RollbackFixture);
  });

  it('rejects emission-pool exhaustion atomically without crediting the player', async () => {
    const player = await createTestPlayer(db);
    const [pool] = await db.select().from(accounts).where(eq(accounts.id, system.emission_pool));
    const before = (await db.select().from(accounts).where(eq(accounts.id, player.keepAccountId)))[0]!.balance;
    const key = `test-emission-exhaust-${randomUUID()}`;

    await expect(postTransaction(db, {
      idempotencyKey: key,
      type: 'test.emission_exhaustion',
      entries: [
        { account: system.emission_pool, delta: -(pool!.balance + 1n) },
        { account: player.keepAccountId, delta: pool!.balance + 1n },
      ],
    })).rejects.toBeInstanceOf(InsufficientFundsError);

    const after = (await db.select().from(accounts).where(eq(accounts.id, player.keepAccountId)))[0]!.balance;
    expect(after).toBe(before);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key))).toHaveLength(0);
  });

  it('is idempotent: concurrent posts of the same key produce exactly one transaction', async () => {
    const a = await createTestPlayer(db);
    const b = await createTestPlayer(db);
    await fund(a.keepAccountId, 100n);

    const key = `test-idem-${randomUUID()}`;
    const post = () =>
      postTransaction(db, {
        idempotencyKey: key,
        type: 'test.transfer',
        entries: [
          { account: a.keepAccountId, delta: -10n },
          { account: b.keepAccountId, delta: 10n },
        ],
      });

    const results = await Promise.all(Array.from({ length: 10 }, post));

    // Exactly one execution; everyone sees the same original transaction.
    const ids = new Set(results.map((r) => r.transaction.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(9);

    const rows = await db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key));
    expect(rows).toHaveLength(1);

    // Applied exactly once: 100 - 10, not 100 - 10*n.
    const [accA] = await db.select().from(accounts).where(eq(accounts.id, a.keepAccountId));
    const [accB] = await db.select().from(accounts).where(eq(accounts.id, b.keepAccountId));
    expect(accA!.balance).toBe(90n);
    expect(accB!.balance).toBe(10n);

    // Duplicates return the original's entries.
    for (const r of results) {
      expect(r.entries).toHaveLength(2);
      expect(r.entries.reduce((s, e) => s + e.delta, 0n)).toBe(0n);
    }
  });

  it('rejects transactions whose entries do not sum to zero, leaving no trace', async () => {
    const a = await createTestPlayer(db);
    await fund(a.keepAccountId, 100n);
    const key = `test-unbalanced-${randomUUID()}`;

    await expect(
      postTransaction(db, {
        idempotencyKey: key,
        type: 'test.bad',
        entries: [
          { account: a.keepAccountId, delta: -10n },
          { account: system.treasury, delta: 9n }, // prints 1 KEEP — must die
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError);

    // The whole SQL transaction rolled back — not even the txn row survives.
    const rows = await db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key));
    expect(rows).toHaveLength(0);
  });

  it('rejects cross-currency "balanced" totals: zero-sum is per currency', async () => {
    const a = await createTestPlayer(db);
    await fund(a.keepAccountId, 100n);

    await expect(
      postTransaction(db, {
        idempotencyKey: `test-xcur-${randomUUID()}`,
        type: 'test.bad',
        entries: [
          { account: a.keepAccountId, delta: -10n }, // KEEP
          { account: system.sol_treasury, delta: 10n }, // SOL — sums to 0 only if you ignore currency
        ],
      }),
    ).rejects.toBeInstanceOf(UnbalancedTransactionError);
  });

  it('rejects drains below zero on player accounts and rolls back atomically', async () => {
    const a = await createTestPlayer(db);
    const b = await createTestPlayer(db);
    await fund(a.keepAccountId, 50n);
    const key = `test-nsf-${randomUUID()}`;

    await expect(
      postTransaction(db, {
        idempotencyKey: key,
        type: 'test.overdraft',
        entries: [
          { account: a.keepAccountId, delta: -100n },
          { account: b.keepAccountId, delta: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    const [accA] = await db.select().from(accounts).where(eq(accounts.id, a.keepAccountId));
    const [accB] = await db.select().from(accounts).where(eq(accounts.id, b.keepAccountId));
    expect(accA!.balance).toBe(50n); // untouched
    expect(accB!.balance).toBe(0n);
    const rows = await db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key));
    expect(rows).toHaveLength(0); // key is reusable after a rejected post

    // World/mint accounts MAY go negative (they represent the outside / the
    // fixed-supply mint). Economy v3: emission_pool is now NON-negative (seeded
    // with the 500M play allocation — its floor IS the lifetime cap), while the
    // keep_genesis mint that funded it sits at −500M without error.
    const [genesis] = await db.select().from(accounts).where(eq(accounts.id, system.keep_genesis));
    expect(genesis!.balance).toBeLessThan(0n);
    const [pool] = await db.select().from(accounts).where(eq(accounts.id, system.emission_pool));
    expect(pool!.balance).toBeGreaterThanOrEqual(0n);
  });

  it('keeps balances and balance_after consistent under 50 concurrent random transfers', async () => {
    const playerCount = 5;
    const initial = 1_000n;
    const playerList = [];
    for (let i = 0; i < playerCount; i++) {
      const p = await createTestPlayer(db);
      await fund(p.keepAccountId, initial);
      playerList.push(p);
    }
    const accountIds = playerList.map((p) => p.keepAccountId);

    // 50 concurrent random transfers; insufficient-funds rejections are legal.
    const transfers = Array.from({ length: 50 }, (_, i) => {
      const from = accountIds[i % playerCount]!;
      let to = accountIds[Math.floor(Math.random() * playerCount)]!;
      if (to === from) to = accountIds[(i + 1) % playerCount]!;
      const amount = BigInt(1 + Math.floor(Math.random() * 300));
      return postTransaction(db, {
        idempotencyKey: `test-conc-${randomUUID()}`,
        type: 'test.transfer',
        entries: [
          { account: from, delta: -amount },
          { account: to, delta: amount },
        ],
      }).catch((err) => {
        if (err instanceof InsufficientFundsError) return null;
        throw err;
      });
    });
    const settled = await Promise.all(transfers);
    expect(settled.some((r) => r !== null)).toBe(true); // the test actually moved money

    for (const id of accountIds) {
      const entryRows = await db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.accountId, id))
        .orderBy(asc(ledgerEntries.id));

      // Final cached balance == sum of all persisted entry deltas.
      const sum = entryRows.reduce((s, e) => s + e.delta, 0n);
      const [acc] = await db.select().from(accounts).where(eq(accounts.id, id));
      expect(acc!.balance).toBe(sum);
      expect(acc!.balance).toBeGreaterThanOrEqual(0n); // player accounts never negative

      // balance_after forms a consistent chain in entry order.
      let running = 0n;
      for (const e of entryRows) {
        running += e.delta;
        expect(e.balanceAfter).toBe(running);
      }
    }

    // Global double-entry invariant: every currency sums to zero across ALL
    // entries in the database (world accounts absorb the negatives).
    const all = await db.select().from(ledgerEntries);
    const accs = await db.select().from(accounts);
    const currencyOf = new Map(accs.map((a) => [a.id, a.currency]));
    const sums = new Map<string, bigint>();
    for (const e of all) {
      const cur = currencyOf.get(e.accountId)!;
      sums.set(cur, (sums.get(cur) ?? 0n) + e.delta);
    }
    for (const [, sum] of sums) expect(sum).toBe(0n);

    // Sanity: the concurrent transfers conserved player-side value exactly.
    const finals = await db.select().from(accounts).where(inArray(accounts.id, accountIds));
    const total = finals.reduce((s, a) => s + a.balance, 0n);
    expect(total).toBe(initial * BigInt(playerCount));
  });
});

/**
 * Gems (D-152; GEMS-CURRENCY §3; E2-GEMS-CONTRACT §1.2).
 *
 * WHY: Gems are non-withdrawable in-game KEEP. G-3 says no Gem is ever minted
 * without a same-amount KEEP debit — and the ONLY thing that makes that a
 * single atomic fact is that the engine balances PER CURRENCY inside ONE
 * transaction, so the KEEP leg and the GEMS leg commit together or not at all.
 * If they could commit separately, a crash between them would mint unbacked
 * Gems or burn KEEP for nothing. The non-negative rules are the structural
 * guards behind every Gems sink and refund: player_gems cannot be overdrawn,
 * gems_sink cannot refund more than was ever spent, gems_reward_budget cannot
 * grant beyond its funding; gems_mint is the world account whose −balance is
 * the outstanding + sunk Gems (the shard_genesis shape).
 */
describe('Gems postings (D-152)', () => {
  const balanceOf = async (id: string) =>
    (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!.balance;

  it('posts the G-3 backing shape: a KEEP pair and a GEMS pair balance per currency in one transaction', async () => {
    const p = await createTestPlayer(db);
    await fund(p.keepAccountId, 100n);
    const gems = await getOrCreatePlayerAccount(db, p.wallet, 'player_gems');
    expect(gems).toMatchObject({ ownerWallet: p.wallet, baseId: null, currency: 'GEMS', balance: 0n });
    // KEEP → Gems is 1:1 (D-152 lock 1): k KEEP recycle to the pool, g Gems mint.
    const k = 40n;
    const g = 40n;

    const posted = await postTransaction(db, {
      idempotencyKey: `gems:from-keep:${p.wallet}:${randomUUID()}`,
      type: 'gems.from_keep',
      entries: [
        { account: p.keepAccountId, delta: -k },
        { account: system.emission_pool, delta: k },
        { account: system.gems_mint, delta: -g },
        { account: gems.id, delta: g },
      ],
    });

    expect(posted.duplicate).toBe(false);
    expect(posted.entries.map((e) => e.delta)).toEqual([-k, k, -g, g]);
    expect(await balanceOf(p.keepAccountId)).toBe(60n);
    expect(await balanceOf(gems.id)).toBe(g);
    // The mint went negative by at least this posting: it is the world account.
    expect(posted.entries[2]!.balanceAfter).toBeLessThanOrEqual(-g);
    expect(canGoNegative('gems_mint')).toBe(true);
  });

  it('refuses a GEMS leg that does not balance even when the KEEP leg does', async () => {
    const p = await createTestPlayer(db);
    await fund(p.keepAccountId, 100n);
    const gems = await getOrCreatePlayerAccount(db, p.wallet, 'player_gems');
    const key = `test-gems-unbalanced-${randomUUID()}`;

    await expect(postTransaction(db, {
      idempotencyKey: key,
      type: 'gems.from_keep',
      entries: [
        { account: p.keepAccountId, delta: -10n },
        { account: system.emission_pool, delta: 10n },
        { account: system.gems_mint, delta: -10n },
        { account: gems.id, delta: 9n }, // destroys 1 Gem silently — must die
      ],
    })).rejects.toBeInstanceOf(UnbalancedTransactionError);

    // Whole posting rolled back: the KEEP leg did not commit on its own.
    expect(await balanceOf(p.keepAccountId)).toBe(100n);
    expect(await balanceOf(gems.id)).toBe(0n);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, key))).toHaveLength(0);
  });

  it('refuses minting Gems straight from a KEEP debit: zero-sum is per currency (G-1)', async () => {
    const p = await createTestPlayer(db);
    await fund(p.keepAccountId, 100n);
    const gems = await getOrCreatePlayerAccount(db, p.wallet, 'player_gems');

    await expect(postTransaction(db, {
      idempotencyKey: `test-gems-xcur-${randomUUID()}`,
      type: 'gems.from_keep',
      entries: [
        { account: p.keepAccountId, delta: -10n }, // KEEP
        { account: gems.id, delta: 10n }, // GEMS — sums to 0 only if you ignore currency
      ],
    })).rejects.toBeInstanceOf(UnbalancedTransactionError);
    expect(await balanceOf(gems.id)).toBe(0n);
  });

  it('never lets player_gems, gems_sink or gems_reward_budget go negative', async () => {
    expect(canGoNegative('player_gems')).toBe(false);
    expect(canGoNegative('player_gems_store')).toBe(false);
    expect(canGoNegative('gems_sink')).toBe(false);
    expect(canGoNegative('gems_reward_budget')).toBe(false);

    const p = await createTestPlayer(db);
    const gems = await getOrCreatePlayerAccount(db, p.wallet, 'player_gems');

    // A sink debit against an empty Gems balance.
    await expect(postTransaction(db, {
      idempotencyKey: `test-gems-nsf-${randomUUID()}`,
      type: 'build.speedup',
      entries: [
        { account: gems.id, delta: -1n },
        { account: system.gems_sink, delta: 1n },
      ],
    })).rejects.toBeInstanceOf(InsufficientFundsError);

    // A refund larger than everything ever sunk would conjure Gems.
    const sunk = await balanceOf(system.gems_sink);
    await expect(postTransaction(db, {
      idempotencyKey: `test-gems-sink-overdraw-${randomUUID()}`,
      type: 'build.speedup.system_refund',
      entries: [
        { account: system.gems_sink, delta: -(sunk + 1n) },
        { account: gems.id, delta: sunk + 1n },
      ],
    })).rejects.toBeInstanceOf(InsufficientFundsError);

    // A grant beyond the funded reward budget must fail closed.
    const budget = await balanceOf(system.gems_reward_budget);
    await expect(postTransaction(db, {
      idempotencyKey: `test-gems-budget-overdraw-${randomUUID()}`,
      type: 'gems.grant',
      entries: [
        { account: system.gems_reward_budget, delta: -(budget + 1n) },
        { account: system.emission_pool, delta: budget + 1n },
        { account: system.gems_mint, delta: -(budget + 1n) },
        { account: gems.id, delta: budget + 1n },
      ],
    })).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await balanceOf(gems.id)).toBe(0n);
    expect(await balanceOf(system.gems_sink)).toBe(sunk);
    expect(await balanceOf(system.gems_reward_budget)).toBe(budget);
  });
});
