/**
 * Gold Forge engine (owner rules 2026-07-24) — encodes the economic contract:
 * soft-cap scaling, the 30% per-player cap WITH shard refunds, sub-parity by
 * construction, idempotent settlement, and escrow conservation (contributed
 * shards either burn or come back — never vanish, never duplicate).
 */
import { ECONOMY, FORGE, FORGE_DROPS } from '@shardkeep/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts, baseForgePositions, builderJobs, buildings, forgeContributions, playerItems, players,
} from '../src/db/schema';
import { claimForgeDays, computeForgeDropWinners, contributeToForge, convertKeepToShards, expireDueForgeAllocations, forgeCycleEndsAt, forgeDayOf, getForgeAllocations, getForgeGlobalDay, getForgeStatus, settleForgeDay } from '../src/game/forge';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { postTransaction } from '../src/ledger/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `forge-${++key}-${Math.random().toString(36).slice(2)}`;

/** Test-only shard faucet — the SAME posting shape mining will use post-split:
 * shard_genesis − / player_shards + (per-currency balanced). */
async function seedShards(wallet: string, amount: bigint): Promise<void> {
  const sys = await bootstrapSystemAccounts(db);
  const p = await getOrCreatePlayerAccount(db, wallet, 'player_shards');
  await postTransaction(db, {
    idempotencyKey: k(), type: 'test.shard_seed',
    entries: [{ account: sys.shard_genesis, delta: -amount }, { account: p.id, delta: amount }],
  });
}
/** Owner 2026-07-24: contributions are gated by a BUILT Gold Forge whose level
 * caps the daily amount — tests seed one directly (L20 cap covers every case). */
async function buildGoldforge(wallet: string, level = 20): Promise<{ id: string }> {
  const [row] = await db.insert(buildings)
    .values({ playerWallet: wallet, type: 'goldforge', level, tx: 20, ty: 20 })
    .returning({ id: buildings.id });
  return row!;
}
const shardBal = async (w: string): Promise<bigint> => (await getOrCreatePlayerAccount(db, w, 'player_shards')).balance;
const keepBal = async (w: string): Promise<bigint> => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;
const sysBal = async (kind: 'emission_pool' | 'shard_burn' | 'forge_escrow' | 'forge_payout_escrow'): Promise<bigint> => {
  const sys = await bootstrapSystemAccounts(db);
  const [row] = await db.select().from(accounts).where(eq(accounts.id, sys[kind]));
  return row!.balance;
};

/** A closed day in the past, unique per test run to avoid cross-test bleed. */
let dayN = 0;
const pastDay = (): { day: string; at: Date } => {
  const at = new Date(Date.now() - (2 + dayN++) * 86_400_000);
  return { day: forgeDayOf(at), at };
};

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('gold forge engine', () => {
  it('KEEP→SHARDS conversion binds an idempotency key to its original amount', async () => {
    const p = await createTestPlayer(db);
    await fundTestKeep(db, p.wallet, 10n, 'test.fund', k());
    const key = k();
    const converted = await convertKeepToShards(db, p.wallet, 3n, key);
    await convertKeepToShards(db, p.wallet, 3n, key);
    await expect(convertKeepToShards(db, p.wallet, 4n, key)).rejects.toThrow(/different conversion amount/);
    expect(await keepBal(p.wallet)).toBe(7n);
    const expectedShards = 3n * BigInt(ECONOMY.shardsPerKeep);
    expect(converted).toEqual({ converted: '3', shards: expectedShards.toString(), rate: ECONOMY.shardsPerKeep });
    expect(await shardBal(p.wallet)).toBe(expectedShards);
  });

  it('contribute moves shards into escrow and accumulates the day row', async () => {
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    await seedShards(p.wallet, 1_000n);
    const escrowBefore = await sysBal('forge_escrow');
    await contributeToForge(db, p.wallet, 400n, k());
    const res = await contributeToForge(db, p.wallet, 100n, k());
    expect(res.myShards).toBe('500');
    expect(await shardBal(p.wallet)).toBe(500n);
    expect(await sysBal('forge_escrow')).toBe(escrowBefore + 500n);
  });

  it('cannot contribute more than the shard balance', async () => {
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    await seedShards(p.wallet, 50n);
    await expect(contributeToForge(db, p.wallet, 100n, k())).rejects.toThrow();
    expect(await shardBal(p.wallet)).toBe(50n);
  });

  it('single contributor: soft-cap scaling AND the 30% cap apply (exact ints), excess refunds', async () => {
    // Settlement ESCROWS the KEEP (2026-07-29) — it no longer credits the
    // player. Asserting escrow-then-claim here IS the proof custody moved:
    // anyone who "fixes" this by re-pointing settlement at player_keep has
    // silently reverted the claim feature.
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    const { day, at } = pastDay();
    await seedShards(p.wallet, 35_000n);
    await contributeToForge(db, p.wallet, 35_000n, k(), at);
    const poolBefore = await sysBal('emission_pool');
    const burnBefore = await sysBal('shard_burn');
    const escrowBefore = await sysBal('forge_payout_escrow');
    await settleForgeDay(db, day);
    // distributable = 273 972 × 35 000 / 350 000 = 27 397 (floor)
    // capShards = 35 000 × 30% = 10 500 → payout = 27 397 × 10 500 / 35 000 = 8 219
    const [row] = await db.select().from(forgeContributions)
      .where(and(eq(forgeContributions.day, day), eq(forgeContributions.playerWallet, p.wallet)));
    expect(row!.keepPaid).toBe(8_219n);
    expect(row!.shardsRefunded).toBe(24_500n);
    expect(await keepBal(p.wallet)).toBe(0n);                                 // NOT credited yet
    expect(await sysBal('forge_payout_escrow')).toBe(escrowBefore + 8_219n);  // waiting to be claimed
    expect(await shardBal(p.wallet)).toBe(24_500n); // refund came back
    expect(await sysBal('emission_pool')).toBe(poolBefore - 8_219n);
    expect(await sysBal('shard_burn')).toBe(burnBefore + 10_500n); // counted shards burned

    const res = await claimForgeDays(db, p.wallet);
    expect(res.claimed).toEqual([{ day, keep: '8219' }]);
    expect(await keepBal(p.wallet)).toBe(8_219n);
    expect(await sysBal('forge_payout_escrow')).toBe(escrowBefore); // escrow drained back
  });

  it('four equal contributors under the cap split the scaled pool evenly', async () => {
    const ps = await Promise.all([1, 2, 3, 4].map(() => createTestPlayer(db)));
    const { day, at } = pastDay();
    for (const p of ps) {
      await buildGoldforge(p.wallet);
      await seedShards(p.wallet, 10_000n);
      await contributeToForge(db, p.wallet, 10_000n, k(), at);
    }
    await settleForgeDay(db, day);
    // total 40 000 < softCap → distributable = 273 972 × 40 000/350 000 = 31 311
    // each share 25% < 30% cap → payout = 31 311 × 10 000/40 000 = 7 827 each, no refunds
    for (const p of ps) {
      expect(await keepBal(p.wallet)).toBe(0n); // escrowed, not credited
      await claimForgeDays(db, p.wallet);
      expect(await keepBal(p.wallet)).toBe(7_827n);
      expect(await shardBal(p.wallet)).toBe(0n);
    }
  });

  it('settlement is idempotent (second run changes nothing)', async () => {
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    const { day, at } = pastDay();
    await seedShards(p.wallet, 1_000n);
    await contributeToForge(db, p.wallet, 1_000n, k(), at);
    await settleForgeDay(db, day);
    const keep1 = await keepBal(p.wallet); const shard1 = await shardBal(p.wallet);
    await settleForgeDay(db, day);
    expect(await keepBal(p.wallet)).toBe(keep1);
    expect(await shardBal(p.wallet)).toBe(shard1);
    // no unsettled rows remain for the day
    const open = await db.select().from(forgeContributions)
      .where(and(eq(forgeContributions.day, day), isNull(forgeContributions.settledAt)));
    expect(open).toHaveLength(0);
  });

  it('contributing without a Gold Forge building is rejected (owner: the building IS the faucet)', async () => {
    // WHY: the Gold Forge BUILDING gates the shards→KEEP faucet — without this,
    // the build cost + steep upgrade curve would be optional, not an economy sink.
    const p = await createTestPlayer(db);
    await seedShards(p.wallet, 1_000n);
    await expect(contributeToForge(db, p.wallet, 100n, k())).rejects.toThrow(/build a Gold Forge/);
    expect(await shardBal(p.wallet)).toBe(1_000n); // nothing moved
  });

  it('a Gold Forge still under construction counts as level 0 (no contributions)', async () => {
    const p = await createTestPlayer(db);
    await seedShards(p.wallet, 1_000n);
    const gf = await buildGoldforge(p.wallet, 1);
    await db.insert(builderJobs).values({
      playerWallet: p.wallet, kind: 'build', buildingId: gf.id,
      startedAt: new Date(), finishesAt: new Date(Date.now() + 60_000),
    });
    await expect(contributeToForge(db, p.wallet, 100n, k())).rejects.toThrow(/build a Gold Forge/);
  });

  it('the DAILY cap follows the building level; the day accumulates toward it', async () => {
    // WHY (owner 2026-07-24): "upgrading forge should increase forge contribution
    // cap per player" — L1 caps the day at contributionCapByLevel[1]; the check
    // is on the day's ACCUMULATED total, so splitting a contribution can't dodge it.
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet, 1);
    const cap = BigInt(FORGE.contributionCapByLevel[1]!); // 2 000
    await seedShards(p.wallet, cap + 1_000n);
    await contributeToForge(db, p.wallet, cap - 500n, k());
    await expect(contributeToForge(db, p.wallet, 501n, k())).rejects.toThrow(/daily forge cap/);
    await contributeToForge(db, p.wallet, 500n, k()); // exactly to the cap is fine
    expect(await shardBal(p.wallet)).toBe(1_000n);
    const status = await getForgeStatus(db, p.wallet);
    expect(status.goldforgeLevel).toBe(1);
    expect(status.myDailyCapShards).toBe(cap.toString());
    expect(status.myShards).toBe(cap.toString());
  });

  it('a retried contribute (same key) neither double-charges NOR double-records', async () => {
    // WHY (security review 2026-07-24 #1): a duplicate escrow post moves NO
    // shards; if the day row still accumulated, settlement would pay KEEP on
    // phantom shards — a net mint that breaks the sub-parity invariant.
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    await seedShards(p.wallet, 1_000n);
    const key1 = k();
    await contributeToForge(db, p.wallet, 100n, key1);
    const res = await contributeToForge(db, p.wallet, 100n, key1); // retry, same key
    expect(res.myShards).toBe('100');            // recorded once
    expect(await shardBal(p.wallet)).toBe(900n); // charged once
  });

  it('a client convert key crafted to collide with a settlement key cannot swallow the payout', async () => {
    // WHY (security review 2026-07-24 #3): client keys are namespaced, so a
    // forged `forge:${day}:${wallet}` convert key can no longer pre-consume the
    // settlement ledger key and DoS a victim's forge payout.
    const victim = await createTestPlayer(db);
    await buildGoldforge(victim.wallet);
    const { day, at } = pastDay();
    await seedShards(victim.wallet, 10_000n);
    await contributeToForge(db, victim.wallet, 10_000n, k(), at);

    const attacker = await createTestPlayer(db);
    await fundTestKeep(db, attacker.wallet, 10n, 'test.fund', k());
    // Attacker tries to pre-consume the victim's settlement keys.
    await convertKeepToShards(db, attacker.wallet, 1n, `forge:${day}:${victim.wallet}`);

    await settleForgeDay(db, day); // must NOT throw and must allocate to the victim
    const [row] = await db.select().from(forgeContributions)
      .where(and(eq(forgeContributions.day, day), eq(forgeContributions.playerWallet, victim.wallet)));
    expect(row!.keepPaid! > 0n).toBe(true);
    await claimForgeDays(db, victim.wallet);
    expect(await keepBal(victim.wallet)).toBe(row!.keepPaid);
  });

  it('an open (current) day refuses to settle; status reports the live pool', async () => {
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    await seedShards(p.wallet, 200n);
    await contributeToForge(db, p.wallet, 200n, k());
    await expect(settleForgeDay(db, forgeDayOf(new Date()))).rejects.toThrow(/still open/);
    const status = await getForgeStatus(db, p.wallet);
    expect(status.myShards).toBe('200');
    expect(BigInt(status.totalShards)).toBeGreaterThanOrEqual(200n);
    expect(status.dailyEmissionKeep).toBe(FORGE.dailyEmissionKeep);
    expect('table' in status.drops && status.drops.table[0]!.dailyLimit)
      .toBe(FORGE_DROPS.table[0]!.dailyLimit); // legacy compatibility only
  });

  it('drop winners are deterministic and honor per-item daily limits (amount-agnostic)', () => {
    // WHY (owner 2026-07-24): drops go to RANDOM eligible contributors, capped
    // per item per day; determinism IS the idempotency guarantee for re-settle.
    const wallets = Array.from({ length: 50 }, (_, i) => `w${i}`);
    const a = computeForgeDropWinners('2026-07-01', wallets);
    const b = computeForgeDropWinners('2026-07-01', wallets);
    expect([...a.entries()]).toEqual([...b.entries()]); // stable
    // Each item awarded to exactly its dailyLimit (pool is large enough).
    for (const d of FORGE_DROPS.table) {
      const got = [...a.values()].filter((v) => v === d.itemId).length;
      expect(got).toBe(d.dailyLimit);
    }
    // A wallet wins at most ONE item; the Aegis (limit 1) has exactly one winner.
    expect([...a.values()].filter((v) => v === 'warzone_aegis')).toHaveLength(1);
  });

  it('a small day awards only as many items as there are eligible contributors', () => {
    // Two contributors, four item types — nobody double-wins, so at most 2 drops.
    const winners = computeForgeDropWinners('2026-07-02', ['x', 'y']);
    expect(winners.size).toBe(2);
    expect(new Set(winners.values()).size).toBe(2); // two distinct items (rarest first)
  });

  it('settlement grants EXACTLY the computed winners, records them, never re-grants', async () => {
    // A pool of contributors so we can observe the daily-limited random award.
    const ps = await Promise.all(Array.from({ length: 6 }, () => createTestPlayer(db)));
    const { day, at } = pastDay();
    for (const p of ps) {
      await buildGoldforge(p.wallet);
      await seedShards(p.wallet, 5_000n);
      await contributeToForge(db, p.wallet, 5_000n, k(), at);
    }
    await settleForgeDay(db, day);
    const expected = computeForgeDropWinners(day, ps.map((p) => p.wallet));
    for (const p of ps) {
      const [row] = await db.select().from(forgeContributions)
        .where(and(eq(forgeContributions.day, day), eq(forgeContributions.playerWallet, p.wallet)));
      const want = expected.get(p.wallet) ?? null;
      expect(row!.itemDropped).toBe(want);
      const inv = await db.select({ itemId: playerItems.itemId, qty: playerItems.qty }).from(playerItems)
        .where(eq(playerItems.playerWallet, p.wallet));
      expect(inv).toEqual(want ? [{ itemId: want, qty: 1 }] : []);
    }
    // Re-settle is idempotent — no double-grant.
    await settleForgeDay(db, day);
    for (const p of ps) {
      const inv = await db.select({ qty: playerItems.qty }).from(playerItems)
        .where(eq(playerItems.playerWallet, p.wallet));
      expect(inv.every((r) => r.qty === 1)).toBe(true);
    }
  });
});

// ===========================================================================
// Claim / history / global list (dashboard, 2026-07-29). Settlement ESCROWS;
// the player CLAIMS. These tests encode WHY the extra columns exist.
// ===========================================================================

/** RECONCILIATION INVARIANT — asserted after every settle/claim/expire below:
 *  forge_payout_escrow.balance === Σ keep_paid over rows that are escrowed and
 *  neither claimed nor expired. If this drifts, the escrow is either holding
 *  money nobody can claim or promising money it does not have. */
async function expectEscrowReconciles(): Promise<void> {
  const rows = await db.select().from(forgeContributions);
  const baseRows = await db.select().from(baseForgePositions);
  const legacyOwed = rows.reduce((a, r) =>
    a + (r.keepEscrowTxnId !== null && r.claimedAt === null && r.expiredAt === null ? (r.keepPaid ?? 0n) : 0n), 0n);
  const baseOwed = baseRows.reduce((a, r) =>
    a + (r.keepEscrowTxnId !== null && r.claimedAt === null && r.expiredAt === null ? (r.keepPaid ?? 0n) : 0n), 0n);
  expect(await sysBal('forge_payout_escrow')).toBe(legacyOwed + baseOwed);
}

/** One contributor, one settled past day. Returns the day + the escrowed payout. */
async function settledDay(shards = 10_000n): Promise<{ wallet: string; day: string; payout: bigint }> {
  const p = await createTestPlayer(db);
  await buildGoldforge(p.wallet);
  const { day, at } = pastDay();
  await seedShards(p.wallet, shards);
  await contributeToForge(db, p.wallet, shards, k(), at);
  await settleForgeDay(db, day);
  const [row] = await db.select().from(forgeContributions)
    .where(and(eq(forgeContributions.day, day), eq(forgeContributions.playerWallet, p.wallet)));
  return { wallet: p.wallet, day, payout: row!.keepPaid! };
}

describe('gold forge — claim', () => {
  it('settlement makes the allocation CLAIMABLE instead of crediting it', async () => {
    // WHY: the pour is the moment of the game; a claim is what makes it one.
    // The money must be a real, named obligation in the meantime — not sitting
    // in the player's spendable balance, and not left inside emission_pool
    // where the next day's settlement could spend it.
    const { wallet, day, payout } = await settledDay();
    expect(payout > 0n).toBe(true);
    expect(await keepBal(wallet)).toBe(0n);
    await expectEscrowReconciles();

    const status = await getForgeStatus(db, wallet);
    expect(status.claimable.count).toBe(1);
    expect(status.claimable.days).toEqual([day]);
    expect(status.claimable.totalKeep).toBe(payout.toString());
    expect(status.claimable.nextExpiresAt).toBeInstanceOf(Date);

    const hist = await getForgeAllocations(db, wallet);
    expect(hist.days[0]!.status).toBe('claimable');
    expect(hist.days[0]!.expiresAt).toBeInstanceOf(Date);
  });

  it('claiming credits EXACTLY once — a concurrent double-claim pays one', async () => {
    // WHY: the row gate, the deterministic ledger key and the non-negative
    // escrow are three independent layers; this is the race they exist for.
    const { wallet, payout } = await settledDay();
    const before = await keepBal(wallet);
    const results = await Promise.allSettled([
      claimForgeDays(db, wallet),
      claimForgeDays(db, wallet),
    ]);
    const paid = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof claimForgeDays>>> => r.status === 'fulfilled')
      .reduce((a, r) => a + BigInt(r.value.totalKeep), 0n);
    expect(paid).toBe(payout);                         // one credit, not two
    expect(await keepBal(wallet)).toBe(before + payout);
    await expectEscrowReconciles();

    // A third, serial claim is a no-op (nothing left).
    const again = await claimForgeDays(db, wallet);
    expect(again.claimed).toEqual([]);
    expect(again.remaining).toBe(0);
    expect(await keepBal(wallet)).toBe(before + payout);
  });

  it('claiming reports the running KEEP balance and what is left', async () => {
    const { wallet, day, payout } = await settledDay();
    const res = await claimForgeDays(db, wallet, day);
    expect(res.claimed).toEqual([{ day, keep: payout.toString() }]);
    expect(res.totalKeep).toBe(payout.toString());
    expect(res.remaining).toBe(0);
    expect(res.keepBalance).toBe(payout.toString());
  });

  it('an UNSETTLED (still open) day cannot be claimed', async () => {
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    await seedShards(p.wallet, 1_000n);
    await contributeToForge(db, p.wallet, 1_000n, k()); // today
    await expect(claimForgeDays(db, p.wallet, forgeDayOf(new Date()))).rejects.toThrow(/not settled yet/);
    const res = await claimForgeDays(db, p.wallet); // claim-all skips the open day
    expect(res.claimed).toEqual([]);
    expect(await keepBal(p.wallet)).toBe(0n);
  });

  it('a PRE-MIGRATION auto-credited row can NEVER be claimed (double-pay firebreak)', async () => {
    // WHY (the whole reason keep_escrow_txn_id exists): rows settled by the old
    // auto-credit code — including any day settled in the migrate→deploy window,
    // which lands with BOTH claimed_at and keep_escrow_txn_id NULL — already
    // paid the player. Claiming one would credit the same payout a SECOND time
    // against real balances. This test fails the moment someone "simplifies"
    // the claim predicate down to `claimed_at IS NULL`.
    const p = await createTestPlayer(db);
    const { day } = pastDay();
    await db.insert(forgeContributions).values({
      day, playerWallet: p.wallet, shards: 5_000n,
      settledAt: new Date(Date.now() - 3_600_000),
      keepPaid: 5_000n, shardsRefunded: 0n,
      // legacy shape: no escrow txn, and (deploy window) not stamped claimed
      keepEscrowTxnId: null, claimedAt: null,
    });
    const before = await keepBal(p.wallet);
    const res = await claimForgeDays(db, p.wallet);
    expect(res.claimed).toEqual([]);
    expect(await keepBal(p.wallet)).toBe(before); // EXACTLY unchanged
    // ...and it reports as already-paid, not as a stuck unclaimed allocation.
    const hist = await getForgeAllocations(db, p.wallet);
    expect(hist.days.find((d) => d.day === day)!.status).toBe('paid_legacy');
    expect((await getForgeStatus(db, p.wallet)).claimable.count).toBe(0);
    await expectEscrowReconciles();
  });

  it('an unclaimed allocation expires back to emission_pool and cannot then be claimed', async () => {
    // WHY: unclaimed emission returning to the LIFETIME MINT pool means it was
    // never minted out — the 500M cap only ever tightens. It must never land in
    // treasury (operator profiting from player inattention) and it must not sit
    // in escrow forever (an unbounded Proof-of-Reserves liability).
    const { wallet, day, payout } = await settledDay();
    // Far enough ahead that EVERY outstanding allocation has lapsed, so the
    // expected sweep total is the whole escrow balance (which must land in the
    // pool to the last unit — an expiry that loses value is worse than none).
    // Other serial suites deliberately settle fixtures in a future year. The
    // global escrow assertion includes those rows, so its all-expired cutoff
    // must follow their real settlement clocks, not just this test's wall clock.
    const allocationClocks = [
      ...await db.select({ settledAt: forgeContributions.settledAt }).from(forgeContributions),
      ...await db.select({ settledAt: baseForgePositions.settledAt }).from(baseForgePositions),
    ];
    const latestSettlement = allocationClocks.reduce((latest, row) =>
      Math.max(latest, row.settledAt?.getTime() ?? 0), Date.now());
    const lapsed = new Date(latestSettlement + (FORGE.claimWindowDays + 1) * 86_400_000);
    const poolBefore = await sysBal('emission_pool');
    const escrowBefore = await sysBal('forge_payout_escrow');
    expect(escrowBefore >= payout).toBe(true);
    // Expiry intentionally bounds each worker batch. Drain the finite fixture
    // population without assuming another suite left fewer than one batch.
    let swept = 0;
    for (;;) {
      const count = await expireDueForgeAllocations(db, lapsed);
      expect(count).toBeLessThanOrEqual(FORGE.expireBatchMax);
      swept += count;
      expect(swept).toBeLessThanOrEqual(allocationClocks.length);
      if (count === 0) break;
    }
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await sysBal('emission_pool')).toBe(poolBefore + escrowBefore);
    expect(await sysBal('forge_payout_escrow')).toBe(0n);
    await expectEscrowReconciles();

    const res = await claimForgeDays(db, wallet, day);
    expect(res.claimed).toEqual([]);
    expect(await keepBal(wallet)).toBe(0n);
    const hist = await getForgeAllocations(db, wallet);
    expect(hist.days.find((d) => d.day === day)!.status).toBe('expired');
    // Sweeping twice must not double-refund the pool.
    const pool2 = await sysBal('emission_pool');
    await expireDueForgeAllocations(db, lapsed);
    expect(await sysBal('emission_pool')).toBe(pool2);
  });
});

describe('gold forge — cycle clock', () => {
  it('the cycle ends at the NEXT UTC midnight, the same boundary settlement uses', async () => {
    // WHY: the countdown must be derived from the SAME definition as the day
    // key, or the clock and the settlement boundary can disagree — the client
    // would show a pour that already happened (or one hours away).
    const now = new Date('2026-07-29T14:03:11.000Z');
    const end = forgeCycleEndsAt(now);
    expect(end.toISOString()).toBe('2026-07-30T00:00:00.000Z');
    expect(forgeDayOf(new Date(end.getTime() - 1))).toBe(forgeDayOf(now));  // last ms of the cycle
    expect(forgeDayOf(end)).not.toBe(forgeDayOf(now));                      // first ms of the next

    const p = await createTestPlayer(db);
    const status = await getForgeStatus(db, p.wallet, now);
    expect(status.cycleEndsAt.toISOString()).toBe('2026-07-30T00:00:00.000Z');
    expect(status.cycleEndsInSec).toBe(35_809); // server-computed, device clock irrelevant
    expect(status.serverNow.toISOString()).toBe(now.toISOString());
  });
});

describe('gold forge — history', () => {
  it("returns the caller's OWN rows only, with derived counted/status and lifetime totals", async () => {
    // WHY: another player's claim status flags an inactive account sitting on
    // value, and their itemDropped reveals who holds the Warzone Aegis.
    const mine = await settledDay(35_000n); // 30%-cap case → a refund to assert
    const other = await settledDay(10_000n);
    const hist = await getForgeAllocations(db, mine.wallet);
    expect(hist.days.every((d) => d.day !== undefined)).toBe(true);
    expect(hist.days).toHaveLength(1);
    const row = hist.days[0]!;
    expect(row.shards).toBe('35000');
    expect(row.shardsRefunded).toBe('24500');
    expect(row.counted).toBe('10500'); // derived shards − refunded, not a column
    expect(hist.totals.keepClaimable).toBe(mine.payout.toString());
    expect(hist.totals.keepClaimed).toBe('0');
    expect(hist.totals.shardsBurned).toBe('10500');

    await claimForgeDays(db, mine.wallet);
    const after = await getForgeAllocations(db, mine.wallet);
    expect(after.days[0]!.status).toBe('claimed');
    expect(after.totals.keepClaimed).toBe(mine.payout.toString());
    expect(after.totals.keepClaimable).toBe('0');
    // the other player's day is nowhere in this response
    expect(JSON.stringify(after)).not.toContain(other.wallet);
    expect(after.days.find((d) => d.day === other.day && d.shards === '10000')).toBeUndefined();
  });

  it('paginates by day (keyset) and clamps the page size', async () => {
    const p = await createTestPlayer(db);
    await buildGoldforge(p.wallet);
    const days: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { day, at } = pastDay();
      await seedShards(p.wallet, 1_000n);
      await contributeToForge(db, p.wallet, 1_000n, k(), at);
      await settleForgeDay(db, day);
      days.push(day);
    }
    const first = await getForgeAllocations(db, p.wallet, { limit: 2 });
    expect(first.days).toHaveLength(2);
    expect(first.nextBefore).toBe(first.days[1]!.day);
    const second = await getForgeAllocations(db, p.wallet, { before: first.nextBefore!, limit: 2 });
    expect(second.days.map((d) => d.day)).not.toContain(first.days[0]!.day); // `before` is exclusive
    expect(second.nextBefore).toBeNull();
    // An oversized limit is clamped, never honoured.
    const huge = await getForgeAllocations(db, p.wallet, { limit: 10_000 });
    expect(huge.days.length).toBeLessThanOrEqual(FORGE.historyMaxPageDays);
    expect(days).toHaveLength(3);
  });
});

describe('gold forge — global allocations', () => {
  it('is bounded, ranks by KEEP, abbreviates wallets and leaks nothing private', async () => {
    // WHY: truncating in React would still ship every full address in the JSON
    // — a one-request harvester linking in-game identity to on-chain holdings.
    const ps = await Promise.all(Array.from({ length: 5 }, () => createTestPlayer(db)));
    const { day, at } = pastDay();
    for (const [i, p] of ps.entries()) {
      await db.update(players).set({ name: `KINGDOM${i}`, seekerVerified: i === 0 }).where(eq(players.wallet, p.wallet));
      await buildGoldforge(p.wallet);
      await seedShards(p.wallet, BigInt(1_000 * (i + 1)));
      await contributeToForge(db, p.wallet, BigInt(1_000 * (i + 1)), k(), at);
    }
    await settleForgeDay(db, day);

    const page = await getForgeGlobalDay(db, ps[2]!.wallet, { day, limit: 2 });
    expect(page.settled).toBe(true);
    expect(page.contributors).toBe(5);
    expect(page.rows).toHaveLength(2);                       // the limit is honoured
    expect(page.rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(BigInt(page.rows[0]!.keepPaid) >= BigInt(page.rows[1]!.keepPaid)).toBe(true);
    expect(page.rows[0]!.name).toBe('KINGDOM4');             // usernames from the players table
    expect(page.nextCursor).not.toBeNull();

    // Never a full address — anywhere in the payload.
    const json = JSON.stringify(page);
    for (const p of ps) expect(json).not.toContain(p.wallet);
    expect(page.rows[0]!.walletShort).toMatch(/^.{4}….{4}$/);
    expect(page.rows[0]!.walletShort.length).toBe(FORGE.globalWalletHeadChars + 1 + FORGE.globalWalletTailChars);
    // Never claim status, item drops, balances or forge levels.
    for (const key of ['claimedAt', 'status', 'itemDropped', 'expiresAt', 'goldforgeLevel', 'myShardBalance']) {
      expect(json).not.toContain(key);
    }

    // `me` locates the caller without paging; the cursor continues the ranks.
    expect(page.me!.rank).toBe(3);
    expect(page.me!.walletShort).toBe(`${ps[2]!.wallet.slice(0, 4)}…${ps[2]!.wallet.slice(-4)}`);
    const next = await getForgeGlobalDay(db, ps[2]!.wallet, { day, limit: 2, cursor: page.nextCursor! });
    expect(next.rows.map((r) => r.rank)).toEqual([3, 4]);
    expect(next.rows.map((r) => r.walletShort)).not.toContain(page.rows[0]!.walletShort);
  });

  it('clamps an oversized limit and rejects a forged cursor', async () => {
    const { wallet, day } = await settledDay();
    const page = await getForgeGlobalDay(db, wallet, { day, limit: 100_000 });
    expect(page.rows.length).toBeLessThanOrEqual(FORGE.globalMaxPageSize);
    await expect(getForgeGlobalDay(db, wallet, { day, cursor: 'not-a-cursor' })).rejects.toThrow(/bad cursor/);
  });

  it('refuses the CURRENT cycle — live per-player positions are an economic leak', async () => {
    // WHY: seeing everyone's live stake lets a whale size a contribution to sit
    // exactly under the 30% share cap while nobody can react, and time deposits
    // against the soft cap. Today's AGGREGATE stays public; its composition does not.
    const p = await createTestPlayer(db);
    await expect(getForgeGlobalDay(db, p.wallet, { day: forgeDayOf(new Date()) })).rejects.toThrow(/still open/);
  });

  it('offers only settled cycles as day options, newest first and bounded', async () => {
    const { wallet } = await settledDay();
    const res = await getForgeGlobalDay(db, wallet);
    expect(res.days.length).toBeLessThanOrEqual(FORGE.globalListDays);
    expect(res.days.every((d) => d < forgeDayOf(new Date()))).toBe(true);
    expect([...res.days]).toEqual([...res.days].sort().reverse());
    expect(res.day).toBe(res.days[0]); // defaults to the most recent settled cycle
  });
});
