/**
 * Hero leveling (D-Q1, owner 2026-07-28) — the money path for the KEEP sink
 * that turns "permanently level 1" heroes into upgradeable ones.
 *
 * WHY these tests (Rule 9 — encode intent, not mechanics): every case here is a
 * way a player could get a level they did not pay for, or pay for a level they
 * did not get.
 *  - EXACT price: the level bought must debit HERO_LEVELING.upgradeCostKeep for
 *    the level being LEFT, not the one being entered — an off-by-one here is a
 *    silent mispricing of the game's largest KEEP sink (~278k at the top).
 *  - idempotency: a retried POST (flaky network, double tap) must charge once.
 *  - CONCURRENCY: two simultaneous upgrades must resolve to ONE level and ONE
 *    charge. Without the players-row FOR UPDATE lock in upgradeHero, two racing
 *    calls both read level 1, both price L1→2 and both upsert level 2 — the
 *    player pays twice for one level (or, with a different interleaving, gets
 *    two levels for one payment). This is the test that pins the lock.
 *  - rejections: not-recruited / max-level / broke must move NO KEEP at all.
 */
import { HERO_LEVELING, HEROES } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builderJobs, buildings, heroLevels } from '../src/db/schema';
import { heroUpgradeCost, listHeroes, upgradeHero } from '../src/game/heroes';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `hero-${++key}-${Math.random().toString(36).slice(2)}`;

const keepBal = async (w: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;

/** Fund a wallet from the test-only KEEP mint; hero costs, not pool exhaustion, are under test. */
async function seedKeep(wallet: string, amount: bigint): Promise<void> {
  await fundTestKeep(db, wallet, amount, 'test.keep_seed', k());
}

/**
 * Recruit a hero the way the game does: place its altar. `finished: false`
 * leaves an open `build` job — an altar still under construction, which must
 * NOT count as recruited.
 */
async function buildAltar(
  wallet: string, hero: 'vex' | 'theodor', finished = true,
): Promise<string> {
  const [row] = await db.insert(buildings)
    .values({ playerWallet: wallet, type: HEROES[hero].altar, level: 1, tx: 10, ty: 10 })
    .returning({ id: buildings.id });
  if (!finished) {
    // Far-future finish so completeDueJobs() cannot quietly complete it.
    await db.insert(builderJobs).values({
      playerWallet: wallet, kind: 'build', buildingId: row!.id,
      finishesAt: new Date(Date.now() + 86_400_000),
    });
  }
  return row!.id;
}

/** A recruited hero at an arbitrary level (skips paying for the climb). */
async function setLevel(wallet: string, hero: 'vex' | 'theodor', level: number): Promise<void> {
  await db.insert(heroLevels).values({ playerWallet: wallet, hero, level })
    .onConflictDoUpdate({
      target: [heroLevels.playerWallet, heroLevels.hero],
      set: { level },
    });
}

const levelOf = async (wallet: string, hero: 'vex' | 'theodor'): Promise<number> => {
  const [row] = await db.select().from(heroLevels)
    .where(and(eq(heroLevels.playerWallet, wallet), eq(heroLevels.hero, hero)));
  return row?.level ?? 1;
};

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('hero leveling — read model', () => {
  it('an un-recruited hero reads as level 1 with the unlock hint, and is not upgradeable', async () => {
    const p = await createTestPlayer(db);
    const { heroes } = await listHeroes(db, p.wallet);
    const vex = heroes.find((h) => h.hero === 'vex')!;
    expect(vex.recruited).toBe(false);
    expect(vex.level).toBe(1);
    expect(vex.unlockKeepLevel).toBe(HEROES.vex.unlockKeepLevel);
    // Stats/cost still render (the panel shows what you'd get), but the server
    // is the one that refuses the purchase — see the rejection tests below.
    expect(vex.hp).toBe(HERO_LEVELING.hp.vex[0]);
    expect(vex.next!.costKeep).toBe(String(HERO_LEVELING.upgradeCostKeep.vex[0]));
  });

  it('an altar still under construction does NOT recruit the hero', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex', false);
    const { heroes } = await listHeroes(db, p.wallet);
    expect(heroes.find((h) => h.hero === 'vex')!.recruited).toBe(false);
  });

  it('a completed altar recruits, and affordability is computed from the real balance', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);

    let vex = (await listHeroes(db, p.wallet)).heroes.find((h) => h.hero === 'vex')!;
    expect(vex.recruited).toBe(true);
    expect(vex.affordable).toBe(false); // broke

    await seedKeep(p.wallet, cost);
    vex = (await listHeroes(db, p.wallet)).heroes.find((h) => h.hero === 'vex')!;
    expect(vex.affordable).toBe(true);
    expect(vex.tierName).toBe('Shardborn');
    expect(vex.next).toMatchObject({
      level: 2,
      hp: HERO_LEVELING.hp.vex[1],
      dps: HERO_LEVELING.dps.vex[1],
      costKeep: String(HERO_LEVELING.upgradeCostKeep.vex[0]),
    });
  });

  it('at max level there is no next step and nothing is affordable', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    await setLevel(p.wallet, 'vex', HERO_LEVELING.maxLevel);
    await seedKeep(p.wallet, 10_000_000n);
    const vex = (await listHeroes(db, p.wallet)).heroes.find((h) => h.hero === 'vex')!;
    expect(vex.next).toBeNull();
    expect(vex.affordable).toBe(false);
    expect(vex.tierName).toBe('The Nephilim');
    expect(vex.hp).toBe(HERO_LEVELING.hp.vex[HERO_LEVELING.maxLevel - 1]);
  });

  it('reports attacker recovery as unavailable until the nullable deadline expires', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const now = new Date('2099-02-01T00:00:00.000Z');
    const recoveryUntil = new Date(now.getTime() + HEROES.vex.regenMinAt(1) * 60_000);
    await db.insert(heroLevels).values({
      playerWallet: p.wallet, hero: 'vex', level: 1, recoveryUntil,
    });
    const recovering = (await listHeroes(db, p.wallet, now)).heroes.find((h) => h.hero === 'vex')!;
    expect(recovering.available).toBe(false);
    expect(recovering.recoveryUntil).toBe(recoveryUntil.toISOString());
    const ready = (await listHeroes(db, p.wallet,
      new Date(recoveryUntil.getTime() + 1))).heroes.find((h) => h.hero === 'vex')!;
    expect(ready.available).toBe(true);
  });
});

describe('hero leveling — upgrade money path', () => {
  it('debits EXACTLY the table cost and grants exactly one level', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    await seedKeep(p.wallet, cost * 3n);
    const before = await keepBal(p.wallet);

    const res = await upgradeHero(db, p.wallet, 'vex', k());

    expect(res.level).toBe(2);
    expect(res.duplicate).toBe(false);
    expect(res.spentKeep).toBe(String(cost));
    expect(res.hp).toBe(HERO_LEVELING.hp.vex[1]);
    expect(res.dps).toBe(HERO_LEVELING.dps.vex[1]);
    expect(await keepBal(p.wallet)).toBe(before - cost);
    expect(await levelOf(p.wallet, 'vex')).toBe(2);
  });

  it('consecutive upgrades charge the price of the level being LEFT (no off-by-one)', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'theodor');
    const c1 = BigInt(HERO_LEVELING.upgradeCostKeep.theodor[0]!); // L1→2
    const c2 = BigInt(HERO_LEVELING.upgradeCostKeep.theodor[1]!); // L2→3
    const c3 = BigInt(HERO_LEVELING.upgradeCostKeep.theodor[2]!); // L3→4
    await seedKeep(p.wallet, c1 + c2 + c3);

    await upgradeHero(db, p.wallet, 'theodor', k());
    await upgradeHero(db, p.wallet, 'theodor', k());
    const third = await upgradeHero(db, p.wallet, 'theodor', k());

    expect(third.level).toBe(4);
    expect(third.spentKeep).toBe(String(c3));
    // Exactly the three table prices, nothing left over and nothing short.
    expect(await keepBal(p.wallet)).toBe(0n);
    expect(await levelOf(p.wallet, 'theodor')).toBe(4);
  });

  it('tier title advances with level (L5→L6 crosses into T2)', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    await setLevel(p.wallet, 'vex', 5);
    await seedKeep(p.wallet, BigInt(HERO_LEVELING.upgradeCostKeep.vex[4]!));
    const res = await upgradeHero(db, p.wallet, 'vex', k());
    expect(res.level).toBe(6);
    expect(res.tier).toBe(2);
    expect(res.tierName).toBe('Awakened');
  });

  it('IDEMPOTENT: the same key twice charges once and grants one level', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    await seedKeep(p.wallet, cost * 2n); // enough for TWO levels if it double-charged
    const before = await keepBal(p.wallet);
    const idem = k();

    const first = await upgradeHero(db, p.wallet, 'vex', idem);
    const replay = await upgradeHero(db, p.wallet, 'vex', idem);

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);
    expect(replay.spentKeep).toBe('0');
    expect(replay.level).toBe(2); // still level 2 — the replay bought nothing
    expect(await keepBal(p.wallet)).toBe(before - cost);
    expect(await levelOf(p.wallet, 'vex')).toBe(2);
  });

  it('the same client key is usable independently for each hero', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    await buildAltar(p.wallet, 'theodor');
    const cv = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    const ct = BigInt(HERO_LEVELING.upgradeCostKeep.theodor[0]!);
    await seedKeep(p.wallet, cv + ct);
    const shared = k();

    // The key is namespaced by hero, so Theodor's upgrade is not mistaken for a
    // replay of Vex's.
    expect((await upgradeHero(db, p.wallet, 'vex', shared)).duplicate).toBe(false);
    expect((await upgradeHero(db, p.wallet, 'theodor', shared)).duplicate).toBe(false);
    expect(await keepBal(p.wallet)).toBe(0n);
    expect(await levelOf(p.wallet, 'vex')).toBe(2);
    expect(await levelOf(p.wallet, 'theodor')).toBe(2);
  });

  it('one player cannot burn another player’s idempotency key', async () => {
    // Money-path review 2026-07-29 #3: the ledger key is
    // `heroup:<wallet>:<hero>:<clientKey>`. Drop the wallet and player B
    // submitting the same client key first would make player A's paid upgrade
    // silently return duplicate/no-level — a cross-player DoS. Mutation-checked:
    // removing the wallet from the key makes this test fail and nothing else.
    const a = await createTestPlayer(db);
    const b = await createTestPlayer(db);
    for (const p of [a, b]) await buildAltar(p.wallet, 'vex');
    const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    await seedKeep(a.wallet, cost);
    await seedKeep(b.wallet, cost);
    const shared = k(); // the SAME client-chosen key, from two different players

    const rb = await upgradeHero(db, b.wallet, 'vex', shared);
    const ra = await upgradeHero(db, a.wallet, 'vex', shared);

    expect(rb.duplicate).toBe(false);
    expect(ra.duplicate).toBe(false); // A's purchase is NOT eaten by B's key
    expect(await levelOf(a.wallet, 'vex')).toBe(2);
    expect(await levelOf(b.wallet, 'vex')).toBe(2);
    expect(await keepBal(a.wallet)).toBe(0n);
    expect(await keepBal(b.wallet)).toBe(0n);
  });

  it('CONCURRENCY: two parallel upgrades with DISTINCT keys buy at most one level each, priced correctly', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const c1 = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    const c2 = BigInt(HERO_LEVELING.upgradeCostKeep.vex[1]!);
    await seedKeep(p.wallet, c1 + c2);
    const before = await keepBal(p.wallet);

    // Distinct keys = two genuinely different purchase intents fired at once.
    // The FOR UPDATE lock must SERIALIZE them: the loser has to re-read level 2
    // and pay c2, never re-pay c1 for a level it already owns.
    const [a, b] = await Promise.all([
      upgradeHero(db, p.wallet, 'vex', k()),
      upgradeHero(db, p.wallet, 'vex', k()),
    ]);

    const levels = [a.level, b.level].sort((x, y) => x - y);
    expect(levels).toEqual([2, 3]);
    const spent = BigInt(a.spentKeep) + BigInt(b.spentKeep);
    expect(spent).toBe(c1 + c2); // exactly the two table prices — no double-charge
    expect(await keepBal(p.wallet)).toBe(before - spent);
    expect(await levelOf(p.wallet, 'vex')).toBe(3);
  });

  it('CONCURRENCY: the same key fired twice in parallel = one level, one charge', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    await seedKeep(p.wallet, cost * 2n); // funded for two, must only spend one
    const before = await keepBal(p.wallet);
    const idem = k();

    // A genuine double-submit (one tap, two in-flight requests). Under contention
    // one side may lose the idempotency race at the DB level; a rejection is
    // acceptable, a SECOND CHARGE is not.
    const results = await Promise.allSettled([
      upgradeHero(db, p.wallet, 'vex', idem),
      upgradeHero(db, p.wallet, 'vex', idem),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);

    expect(await keepBal(p.wallet)).toBe(before - cost); // charged exactly once
    expect(await levelOf(p.wallet, 'vex')).toBe(2); // exactly one level
  });
});

describe('hero leveling — rejections move no KEEP', () => {
  it('rejects an un-recruited hero (no altar) with 422 and no ledger movement', async () => {
    const p = await createTestPlayer(db);
    await seedKeep(p.wallet, 1_000_000n);
    const before = await keepBal(p.wallet);

    await expect(upgradeHero(db, p.wallet, 'vex', k()))
      .rejects.toMatchObject({ statusCode: 422 });

    expect(await keepBal(p.wallet)).toBe(before);
    expect(await levelOf(p.wallet, 'vex')).toBe(1);
  });

  it('rejects a hero whose altar is still building', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'theodor', false);
    await seedKeep(p.wallet, 1_000_000n);
    const before = await keepBal(p.wallet);

    await expect(upgradeHero(db, p.wallet, 'theodor', k()))
      .rejects.toMatchObject({ statusCode: 422 });

    expect(await keepBal(p.wallet)).toBe(before);
    expect(await levelOf(p.wallet, 'theodor')).toBe(1);
  });

  it('rejects at max level with no ledger movement', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    await setLevel(p.wallet, 'vex', HERO_LEVELING.maxLevel);
    await seedKeep(p.wallet, 10_000_000n);
    const before = await keepBal(p.wallet);

    await expect(upgradeHero(db, p.wallet, 'vex', k()))
      .rejects.toMatchObject({ statusCode: 422 });

    expect(await keepBal(p.wallet)).toBe(before);
    expect(await levelOf(p.wallet, 'vex')).toBe(HERO_LEVELING.maxLevel);
  });

  it('rejects when short by ONE unit, and the level does not move', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    await seedKeep(p.wallet, cost - 1n);
    const before = await keepBal(p.wallet);

    await expect(upgradeHero(db, p.wallet, 'vex', k())).rejects.toThrow();

    expect(await keepBal(p.wallet)).toBe(before); // the failed tx rolled back
    expect(await levelOf(p.wallet, 'vex')).toBe(1);
  });

  it('a failed (broke) attempt leaves the hero upgradeable once funded', async () => {
    const p = await createTestPlayer(db);
    await buildAltar(p.wallet, 'vex');
    const cost = BigInt(HERO_LEVELING.upgradeCostKeep.vex[0]!);
    await seedKeep(p.wallet, cost - 1n);
    await expect(upgradeHero(db, p.wallet, 'vex', k())).rejects.toThrow();

    await seedKeep(p.wallet, 1n);
    const res = await upgradeHero(db, p.wallet, 'vex', k());
    expect(res.level).toBe(2);
    expect(await keepBal(p.wallet)).toBe(0n);
  });
});

describe('heroUpgradeCost', () => {
  it('mirrors the shared table and returns null at max level', () => {
    for (const hero of ['vex', 'theodor'] as const) {
      for (let n = 1; n < HERO_LEVELING.maxLevel; n++) {
        expect(heroUpgradeCost(hero, n)).toBe(BigInt(HERO_LEVELING.upgradeCostKeep[hero][n - 1]!));
      }
      expect(heroUpgradeCost(hero, HERO_LEVELING.maxLevel)).toBeNull();
    }
  });
});

describe('a purchased hero level actually reaches combat (money-path review #1)', () => {
  it('the raid snapshot freezes hero levels, and the sim fields the paid stats', async () => {
    // The blocking finding: heroes.ts debited real KEEP for a level nothing
    // read, so the purchase bought nothing. This pins the whole chain —
    // hero_levels -> armySnapshot.heroLevels -> HeroDeploy.level -> sim stats.
    const { simulateRaid } = await import('@shardkeep/sim');
    const { HERO_LEVELING } = await import('@shardkeep/shared');
    const snapshot = {
      buildings: [{ id: 'keep', type: 'keep' as never, level: 3, tx: 14, ty: 14, fw: 3, fh: 3 }],
      claimMin: 2, claimMax: 28,
    };
    const orders = { deploys: [], heroDeploys: [{ hero: 'vex' as const, tx: 2, ty: 14, tMs: 0 }] };
    const l1 = simulateRaid(snapshot as never, orders as never, 42);
    const l8 = simulateRaid(
      snapshot as never,
      { ...orders, heroDeploys: [{ ...orders.heroDeploys[0]!, level: 8 }] } as never,
      42,
    );
    // Same seed, same base, same drop — only the PAID level differs. Damage
    // saturates once the keep falls, so the observable is SPEED: the level-8
    // hero must flatten it strictly sooner than the level-1 hero.
    const killTick = (r: typeof l1): number => {
      const ev = r.events.find((e) => e.e === 'destroyed' && e.id === 'keep');
      return ev ? ev.t : Number.MAX_SAFE_INTEGER;
    };
    expect(HERO_LEVELING.dps.vex[7]!).toBeGreaterThan(HERO_LEVELING.dps.vex[0]!);
    expect(killTick(l1)).toBeLessThan(Number.MAX_SAFE_INTEGER); // both do kill it
    expect(killTick(l8)).toBeLessThan(killTick(l1));
  });
});
