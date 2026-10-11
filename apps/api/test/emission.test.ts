/**
 * Mining (fixed quota + lazy accrual + COLLECT) and Daily Shard Cache (streak
 * ladder) — Economy v3, ECONOMY.md §2/§3/§4b. These encode the WHY: income is a
 * FIXED daily quota (never diluted, computed in pure integer bps), it fills a
 * 1-day buffer that pauses when full and is never seized, COLLECT credits exactly
 * the buffer ONCE (even under concurrent taps) and can never over-mint the
 * emission pool, a GET never mints or resurrects a spent buffer, KEEP sinks
 * RECYCLE to the pool (never burn), and the cache is a small predictable streak
 * reward whose 7-day state flips the 1.4× mining bonus.
 */
import { DAILY_CACHE, TOKEN } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { accounts, builderJobs, buildings, mineState, players, streaks } from '../src/db/schema';
import { ensureStartingBase, placeBuilding, completeDueJobs } from '../src/game/base';
import {
  accrue,
  claimDailyCache,
  collectMine,
  DAY_MS,
  ensureMineState,
  getMineStatus,
  getMiningQuota,
} from '../src/game/emission';
import { spendGameCurrency, rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
afterEach(()=>vi.unstubAllEnvs());
let key = 0;
const k = (): string => `em-${++key}-${Math.random().toString(36).slice(2)}`;

/** Player with a completed Mine; keep/mine level configurable. */
async function playerWithMine(mineLevel = 1, keepLevel = 1) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await fundTestKeep(db, p.wallet, 100_000n, 'test.fund', k());
  await rewardShards(db, p.wallet, 100_000n, 'test.fund.shards', k());
  const mine = await placeBuilding(db, p.wallet, 'mine' as never, 11, 8, k());
  await completeDueJobs(db, p.wallet, new Date(Date.now() + 120_000));
  if (mineLevel > 1) {
    await db.update(buildings).set({ level: mineLevel }).where(eq(buildings.id, mine.id));
  }
  if (keepLevel > 1) {
    await db.update(players).set({ keepLevel }).where(eq(players.wallet, p.wallet));
  }
  return p;
}

/** Seed the accrual anchor to a precise (lastAccrualAt, accrued) for timing tests. */
async function seedMine(wallet: string, at: Date, accrued = 0n): Promise<void> {
  await ensureMineState(db, wallet, at);
  await db.update(mineState).set({ lastAccrualAt: at, accruedShards: accrued })
    .where(eq(mineState.playerWallet, wallet));
}

/** Force a player's cache streak to N days (turns the mining bonus on at ≥7). */
async function setStreak(wallet: string, days: number): Promise<void> {
  await db.insert(streaks)
    .values({ playerWallet: wallet, currentDays: days, everCompletedWeek1: days >= 7 })
    .onConflictDoUpdate({ target: streaks.playerWallet, set: { currentDays: days } });
}

const balance = async (w: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, w, 'player_shards')).balance; // split: mining mints shards

async function sysBalance(kind: 'emission_pool' | 'burn'): Promise<bigint> {
  const sys = await bootstrapSystemAccounts(db);
  const [row] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, sys[kind]));
  return row?.b ?? 0n;
}

/** Drain emission_pool down to `target`, run `body`, then restore. The pool is a
 * SHARED system account across the whole run (fileParallelism: false). */
async function withEmissionPool<T>(target: bigint, body: () => Promise<T>): Promise<T> {
  const sys = await bootstrapSystemAccounts(db);
  const start = await sysBalance('emission_pool');
  const drain = start - target;
  if (drain > 0n) {
    await postTransaction(db, {
      idempotencyKey: k(), type: 'test.drain',
      entries: [{ account: sys.emission_pool, delta: -drain }, { account: sys.keep_genesis, delta: drain }],
    });
  }
  try {
    return await body();
  } finally {
    const now = await sysBalance('emission_pool');
    const restore = start - now; // put back exactly what the pool is short of `start`
    if (restore > 0n) {
      await postTransaction(db, {
        idempotencyKey: k(), type: 'test.restore',
        entries: [{ account: sys.keep_genesis, delta: -restore }, { account: sys.emission_pool, delta: restore }],
      });
    }
  }
}

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  await conn.sql.end();
});

// ---------------------------------------------------------------------------
// Quota math (ECONOMY.md §2) — pure integer basis points
// ---------------------------------------------------------------------------

describe('mining quota (ECONOMY.md §2)', () => {
  it('every (keep, mine, streak) cell matches the locked table, in integer bps math', () => {
    // Post-retune (owner 2026-07-20, maxed ~250k/day): L1 anchor stays 500; the
    // level multipliers flattened (L20 ×12→×6.68), so mid/high cells drop.
    expect(getMiningQuota(1, [1], 0)).toBe(500);    // anchor — one L1 mine unchanged
    expect(getMiningQuota(3, [1], 0)).toBe(940);    // Keep L3 (×1.88) / Mine L1
    expect(getMiningQuota(1, [3], 0)).toBe(940);    // Keep L1 / Mine L3 (×1.88)
    expect(getMiningQuota(3, [3], 0)).toBe(1_767);  // Keep L3 / Mine L3
    expect(getMiningQuota(5, [5], 0)).toBe(5_346);  // maxed single mine, no streak
    // Maxed single mine + 7-day streak (≈15× a fresh base), EXACT in bps.
    expect(getMiningQuota(5, [5], 7)).toBe(7_485);
    expect(getMiningQuota(5, [5], 7) / getMiningQuota(1, [1], 0)).toBeCloseTo(15.0, 1);
  });

  it('sums income ADDITIVELY across mines (the multi-mine fix, owner 2026-07-19)', () => {
    expect(getMiningQuota(1, [1, 1], 0)).toBe(1_000);                 // 2× L1 = 2× 500
    expect(getMiningQuota(1, [1, 1, 1, 1, 1, 1], 0)).toBe(3_000);     // 6× L1 = 6× 500
    expect(getMiningQuota(1, [1, 3], 0)).toBe(1_440);                 // (×1.0 + ×1.88) × 500
    expect(getMiningQuota(3, [1, 1], 0)).toBe(1_880);                 // keep L3 mult ×1.88 on the sum
    // more mines strictly beats fewer (the OLD highest-level-only model ignored count).
    expect(getMiningQuota(1, [1, 1, 1], 0)).toBeGreaterThan(getMiningQuota(1, [1], 0));
  });

  it('the 7-day streak applies the 1.4× consistency bonus, nothing below', () => {
    expect(getMiningQuota(5, [5], 6)).toBe(5_346);
    expect(getMiningQuota(5, [5], 7)).toBe(7_485);
  });

  it('no mine (or no keep) means zero quota — you cannot mine without a Mine', () => {
    expect(getMiningQuota(1, [], 99)).toBe(0);
    expect(getMiningQuota(0, [1], 99)).toBe(0);
  });

  it('resolves the live quota from the player buildings + cache streak', async () => {
    const { wallet } = await playerWithMine(5, 5);
    await setStreak(wallet, 7);
    const status = await getMineStatus(db, wallet);
    expect(status.mining.quotaPerDay).toBe(7_485);
  });
});

// ---------------------------------------------------------------------------
// Accrual buffer + storage cap + carryover (ECONOMY.md §2)
// ---------------------------------------------------------------------------

describe('mine accrual + storage (ECONOMY.md §2)', () => {
  it('accrual fills continuously and pauses at the 1-day storage cap', async () => {
    const { wallet } = await playerWithMine(1, 1); // quota 500/day, cap 500
    const t0 = new Date();
    await seedMine(wallet, t0, 0n);

    const half = await getMineStatus(db, wallet, new Date(t0.getTime() + DAY_MS / 2));
    expect(half.mining.quotaPerDay).toBe(500);
    expect(half.mining.storageCap).toBe(500);
    expect(half.mining.accrued).toBe(250);

    // Two full days later → would be 1000 but CLAMPS at the cap (500).
    const later = await getMineStatus(db, wallet, new Date(t0.getTime() + 2 * DAY_MS));
    expect(later.mining.accrued).toBe(500);
  });

  it('a missed/late collect loses NOTHING — yesterday is still collectable (no decay)', async () => {
    const { wallet } = await playerWithMine(1, 1);
    const t0 = new Date();
    await seedMine(wallet, t0, 0n);
    const s = await getMineStatus(db, wallet, new Date(t0.getTime() + 3 * DAY_MS));
    expect(s.mining.accrued).toBe(500); // exactly one full day buffered
  });

  it('accrue() never decreases the buffer even if the quota later drops (we do not seize)', () => {
    const t0 = new Date();
    const full = new Date(t0.getTime() + DAY_MS);
    const filled = accrue(0n, t0, 14_580, full); // fills to 14,580
    expect(filled).toBe(14_580n);
    // Quota drops to 500 (cap 500) — the existing buffer is NOT seized down.
    const afterDrop = accrue(filled, full, 500, new Date(full.getTime() + DAY_MS));
    expect(afterDrop).toBe(14_580n);
  });

  // A mine only earns from when it EXISTS — adding capacity must never pay for a
  // window before it was there. WHY: quotaFor counts producing mines only, and the
  // accrual clock re-anchors at build completion, so the summed rate can't be
  // applied retroactively to the older buffer (security review 2026-07-19).
  it('a mine under construction does not yet count toward the quota (no early income)', async () => {
    const { wallet } = await playerWithMine(1, 1); // one COMPLETED L1 mine → quota 500
    // A 2nd mine with an OPEN build job (still under construction).
    const [m2] = await db.insert(buildings)
      .values({ playerWallet: wallet, type: 'mine', level: 1, tx: 13, ty: 8 }).returning();
    await db.insert(builderJobs).values({
      playerWallet: wallet, kind: 'build', buildingId: m2!.id,
      startedAt: new Date(), finishesAt: new Date(Date.now() + 3_600_000),
    });
    const s = await getMineStatus(db, wallet);
    expect(s.mining.quotaPerDay).toBe(500); // only the producing mine counts, not 1000
    expect(s.mining.mineCount).toBe(1);      // count reflects PRODUCING mines
  });

  it('adding a 2nd mine does NOT back-credit the 1st mine window at the higher rate', async () => {
    const { wallet } = await playerWithMine(1, 1); // quota 500/day, cap 500
    const t0 = new Date('2026-08-01T00:00:00Z');
    await seedMine(wallet, t0, 0n); // clock at t0, empty buffer
    // A 2nd mine whose build job is due a day later. Completing it re-anchors the
    // accrual clock; without that fix the collect below would pay the SUMMED
    // 1,000/day over the whole day (double), crediting income the 2nd mine never
    // produced. Insert directly (the paid SOL flow is exercised in base.test.ts).
    const [m2] = await db.insert(buildings)
      .values({ playerWallet: wallet, type: 'mine', level: 1, tx: 13, ty: 8 }).returning();
    await db.insert(builderJobs).values({
      playerWallet: wallet, kind: 'build', buildingId: m2!.id,
      startedAt: t0, finishesAt: new Date(t0.getTime() + 60_000),
    });
    const oneDay = new Date(t0.getTime() + DAY_MS);
    await completeDueJobs(db, wallet, oneDay); // completes mine #2, re-anchors accrual

    const before = await balance(wallet);
    const { amount } = await collectMine(db, wallet, oneDay);
    expect(amount).toBe(500n); // exactly ONE mine-day, NOT 1,000 (no retroactive rate)
    expect((await balance(wallet)) - before).toBe(500n);
  });
});

// ---------------------------------------------------------------------------
// COLLECT (ECONOMY.md §2) — credit-once, cap-safe, concurrency-safe
// ---------------------------------------------------------------------------

describe('collectMine (ECONOMY.md §2)', () => {
  it('credits exactly the accrued buffer, clears it, and is idempotent', async () => {
    const { wallet } = await playerWithMine(1, 1);
    const collectAt = new Date();
    await seedMine(wallet, collectAt, 500n); // a full day already buffered

    const before = await balance(wallet);
    const { amount } = await collectMine(db, wallet, collectAt);
    expect(amount).toBe(500n);
    expect((await balance(wallet)) - before).toBe(500n);

    // Buffer cleared; a re-collect at the SAME instant pays nothing.
    const again = await collectMine(db, wallet, collectAt);
    expect(again.amount).toBe(0n);
    const [ms] = await db.select().from(mineState).where(eq(mineState.playerWallet, wallet));
    expect(ms!.accruedShards).toBe(0n);
  });

  it('TWO concurrent collects credit exactly ONE buffer (row lock serializes the tap)', async () => {
    const { wallet } = await playerWithMine(5, 5); // quota 14,580
    const collectAt = new Date();
    await seedMine(wallet, collectAt, 14_580n); // one full buffer, no extra accrual at collectAt

    const before = await balance(wallet);
    const results = await Promise.all([
      collectMine(db, wallet, collectAt),
      collectMine(db, wallet, collectAt),
    ]);
    const total = results.reduce((s, r) => s + r.amount, 0n);
    expect(total).toBe(14_580n); // NOT 2×
    expect((await balance(wallet)) - before).toBe(14_580n);
    const [ms] = await db.select().from(mineState).where(eq(mineState.playerWallet, wallet));
    expect(ms!.accruedShards).toBe(0n);
  });

  it('requires a Mine', async () => {
    const bare = await createTestPlayer(db);
    await ensureStartingBase(db, bare.wallet);
    await expect(collectMine(db, bare.wallet)).rejects.toThrow(/build a Mine/);
  });

  it('SPLIT: mining mints shards INDEPENDENT of the play pool (the pool now only funds the forge)', async () => {
    // Pre-split, collects were clamped to emission_pool; post-split shards are
    // the soft currency — a drained pool must NOT block mining (the pool's
    // budget discipline moved to the Gold Forge's daily settlement).
    const { wallet } = await playerWithMine(1, 1);
    const collectAt = new Date();
    await seedMine(wallet, collectAt, 500n);
    await withEmissionPool(100n, async () => {
      const before = await balance(wallet);
      const { amount } = await collectMine(db, wallet, collectAt);
      expect(amount).toBe(500n); // full buffer, no pool clamp
      expect((await balance(wallet)) - before).toBe(500n);
      expect(await sysBalance('emission_pool')).toBe(100n); // pool untouched by mining
      const [ms] = await db.select().from(mineState).where(eq(mineState.playerWallet, wallet));
      expect(ms!.accruedShards).toBe(0n);
    });
  });

  it('SPLIT: concurrent collects each mint exactly their own buffer (no pool contention)', async () => {
    const a = await playerWithMine(5, 5);
    const b = await playerWithMine(5, 5);
    const collectAt = new Date();
    await seedMine(a.wallet, collectAt, 14_580n);
    await seedMine(b.wallet, collectAt, 14_580n);
    await withEmissionPool(9_000n, async () => {
      const [ra, rb] = await Promise.all([
        collectMine(db, a.wallet, collectAt),
        collectMine(db, b.wallet, collectAt),
      ]);
      // Shards are per-player quota-bounded, not pool-bounded: both collect in
      // full, and the KEEP pool is untouched (it only funds forge settlements).
      expect(ra.amount + rb.amount).toBe(29_160n);
      expect(await sysBalance('emission_pool')).toBe(9_000n);
    });
  });

  it('getMineStatus is READ-ONLY: it never mints or resurrects a spent buffer', async () => {
    const { wallet } = await playerWithMine(1, 1);
    const collectAt = new Date();
    await seedMine(wallet, collectAt, 500n);
    await collectMine(db, wallet, collectAt); // buffer → 0

    const balBefore = await balance(wallet);
    const [msBefore] = await db.select().from(mineState).where(eq(mineState.playerWallet, wallet));
    // A GET a full day later would DISPLAY new accrual, but must not persist it…
    await getMineStatus(db, wallet, new Date(collectAt.getTime() + DAY_MS));
    const [msAfter] = await db.select().from(mineState).where(eq(mineState.playerWallet, wallet));
    expect(await balance(wallet)).toBe(balBefore);                 // GET minted nothing
    expect(msAfter!.accruedShards).toBe(msBefore!.accruedShards);  // GET persisted nothing
    expect(msAfter!.lastAccrualAt.getTime()).toBe(msBefore!.lastAccrualAt.getTime()); // clock not advanced
  });
});

// ---------------------------------------------------------------------------
// KEEP recycles, never burns (ECONOMY.md §4b)
// ---------------------------------------------------------------------------

describe('KEEP recycle (ECONOMY.md §4b)', () => {
  it('a KEEP sink CREDITS emission_pool by the full amount; the burn account is untouched', async () => {
    const p = await createTestPlayer(db);
    await fundTestKeep(db, p.wallet, 1_000n, 'test.fund', k());
    await rewardShards(db, p.wallet, 1_000n, 'test.fund.shards', k());
    const poolBefore = await sysBalance('emission_pool');
    const burnBefore = await sysBalance('burn');

    // D-152: with Gems dark the shim posts the legacy KEEP leg, which must keep
    // recycling 100% to emission_pool (the pre-Gems invariant, byte-identical).
    await spendGameCurrency(db, p.wallet, 300n, 'test.sink', k());

    expect((await sysBalance('emission_pool')) - poolBefore).toBe(300n); // recycled in full
    expect(await sysBalance('burn')).toBe(burnBefore);                   // nothing burned
    // KEEP sinks debit the KEEP balance (the shards helper reads the soft one)
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance).toBe(700n);
  });
});

// ---------------------------------------------------------------------------
// Daily Shard Cache — streak state machine (ECONOMY.md §3)
// ---------------------------------------------------------------------------

describe('daily cache streak (ECONOMY.md §3)', () => {
  const day = (anchor: Date, n: number): Date => new Date(anchor.getTime() + n * DAY_MS);

  it('first week ever ladders D1 100 → D7 700, then latches everCompletedWeek1', async () => {
    const { wallet } = await playerWithMine();
    const anchor = new Date('2026-01-01T12:00:00Z');
    const expected = [100n, 200n, 300n, 400n, 500n, 600n, 700n];
    for (let i = 0; i < 7; i++) {
      const before = await balance(wallet);
      const res = await claimDailyCache(db, wallet, day(anchor, i));
      expect(res.amount).toBe(expected[i]);
      expect(res.streakDays).toBe(i + 1);
      expect((await balance(wallet)) - before).toBe(expected[i]);
    }
    const [s] = await db.select().from(streaks).where(eq(streaks.playerWallet, wallet));
    expect(s!.everCompletedWeek1).toBe(true);
    expect(s!.currentDays).toBe(7); // streak≥7 → the 1.4× mining bonus is on
    expect(getMiningQuota(1, [1], s!.currentDays)).toBe(700); // 500 × 1.4
  });

  it('after a miss the streak resets to 1 and the lifetime cache is 100, not the ladder', async () => {
    const { wallet } = await playerWithMine();
    const anchor = new Date('2026-02-01T12:00:00Z');
    for (let i = 0; i < 7; i++) await claimDailyCache(db, wallet, day(anchor, i)); // complete week 1
    // Skip a day (gap = 2): claim on day 8+1 → streak resets to 1, cache = 100.
    const afterGap = await claimDailyCache(db, wallet, day(anchor, 8));
    expect(afterGap.streakDays).toBe(1);
    expect(afterGap.amount).toBe(BigInt(DAILY_CACHE.baseShards)); // 100, NOT 100-from-ladder
    expect(getMiningQuota(1, [1], afterGap.streakDays)).toBe(500);  // bonus OFF (streak<7)
  });

  it('rebuilding 7 consecutive days after a miss pays 500/day and re-arms the 1.4× bonus', async () => {
    const { wallet } = await playerWithMine();
    const anchor = new Date('2026-03-01T12:00:00Z');
    for (let i = 0; i < 7; i++) await claimDailyCache(db, wallet, day(anchor, i)); // week 1 done
    await claimDailyCache(db, wallet, day(anchor, 8)); // miss day 7 → reset to 1
    let res!: Awaited<ReturnType<typeof claimDailyCache>>;
    for (let i = 9; i <= 14; i++) res = await claimDailyCache(db, wallet, day(anchor, i));
    expect(res.streakDays).toBe(7);
    expect(res.amount).toBe(BigInt(DAILY_CACHE.consistentShards)); // 500, lifetime consistent
    expect(getMiningQuota(1, [1], res.streakDays)).toBe(700);        // bonus back ON
  });

  it('enforces once-per-UTC-day and requires a Mine', async () => {
    const { wallet } = await playerWithMine();
    const at = new Date('2026-04-01T12:00:00Z');
    await claimDailyCache(db, wallet, at);
    await expect(claimDailyCache(db, wallet, at)).rejects.toThrow(/already claimed today/);

    const bare = await createTestPlayer(db);
    await ensureStartingBase(db, bare.wallet);
    await expect(claimDailyCache(db, bare.wallet)).rejects.toThrow(/build a Mine/);
  });

  it('TWO concurrent claims credit ONCE and the second is rejected (row lock + day guard)', async () => {
    const { wallet } = await playerWithMine();
    const at = new Date('2026-05-01T12:00:00Z');
    const before = await balance(wallet);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    const settled = await Promise.allSettled([
      claimDailyCache(db, wallet, at),
      claimDailyCache(db, wallet, at),
    ]);
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);   // exactly one claim went through
    expect(failed).toHaveLength(1);
    expect((await balance(wallet)) - before).toBe(100n); // credited exactly once (D1 = 100)
    const [s] = await db.select().from(streaks).where(eq(streaks.playerWallet, wallet));
    expect(s!.currentDays).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Status read (ECONOMY.md §2/§3)
// ---------------------------------------------------------------------------

describe('getMineStatus (ECONOMY.md §2/§3)', () => {
  it('returns both mining and cache blocks the client renders', async () => {
    const { wallet } = await playerWithMine(3, 3); // quota 1,767 (post-retune)
    const status = await getMineStatus(db, wallet);
    expect(status.mining.quotaPerDay).toBe(1_767);
    expect(status.mining.storageCap).toBe(1_767);
    expect(status.mining.ratePerHour).toBe(Math.floor(1_767 / 24));
    expect(status.cache.claimable).toBe(true);
    expect(status.cache.cacheShards).toBe(100); // first-ever projected claim = D1
    expect(typeof status.cache.nextClaimAt).toBe('string');
  });
});

// keep the lifetime-cap constant referenced (documents intent)
void TOKEN;
void sql;
