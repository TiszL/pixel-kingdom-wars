import { trainTroop } from './training-consent';
/**
 * Elite troop item-gating + hero contracts (D-058, owner 2026-08-16 verbatim:
 * "heroes are also items which can be sold in-game market, and some troops are
 * also items, dragon, wyvern, gloamfang, hexabraw(cannon), mage. some of them
 * for example mage should cost 5,000 KEEP, dragon only can be dropped from
 * gold forge, same for wyvern and rest of other way unlocked troops").
 *
 * What these tests encode and WHY:
 *  - the writ is the ONLY unlock door for new wallets (a gate that leaked
 *    would make the 5,000-KEEP mage writ and the forge grind pointless);
 *  - money discipline: buy charges exactly once, USE consumes exactly once,
 *    and every refusal leaves both the balance and the item untouched;
 *  - GRANDFATHERING is a live-player safety promise: nobody who could train a
 *    troop yesterday may lose it, whether by the boot backfill or the lazy
 *    self-heal — an army that exists must stay trainable forever.
 */
import { ELITE_TROOP_UNLOCKS, HEROES } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  army, baseArmy, bases, buildings, playerItems, players, troopUnlocks,
} from '../src/db/schema';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { getArmyState} from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import { computeBaseForgeDrops } from '../src/game/forge';
import { buyItem, useItem } from '../src/game/items';
import {
  listItem, reserveListing, settleListing, type ItemMarketDeps,
} from '../src/game/itemMarket';
import { rewardShards } from '../src/game/spend';
import {
  assertEliteTroopUnlocked, eliteUnlocksOf, grandfatherEliteTroopUnlocks, hasTroopUnlock,
} from '../src/game/troopUnlocks';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep, randomWallet } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `troop-unlocks-${++key}-${Math.random().toString(36).slice(2)}`;

const keepBalance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
const writQty = async (wallet: string, itemId: string): Promise<number> => {
  const [row] = await db.select({ qty: playerItems.qty }).from(playerItems)
    .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, itemId)));
  return row?.qty ?? 0;
};

/** Player with a completed Barracks + Camp so trainTroop admission passes. */
async function armyPlayer(keep = 100_000n) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
  await rewardShards(db, p.wallet, keep, 'test.fund.shards', k());
  await db.insert(buildings).values([
    { playerWallet: p.wallet, type: 'barracks', level: 5, tx: 14, ty: 8 },
    { playerWallet: p.wallet, type: 'camp', level: 3, tx: 17, ty: 8 },
  ]);
  return p;
}

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('mage writ: 5,000-KEEP purchase → USE → training unlocks (the one door)', () => {
  it('a fresh wallet cannot train a mage; buying + using the writ opens it', async () => {
    const p = await armyPlayer();
    // Locked BEFORE any writ: the refusal names the item path and moves nothing.
    const shardsBefore = (await getOrCreatePlayerAccount(db, p.wallet, 'player_shards')).balance;
    await expect(trainTroop(db, p.wallet, 'mage', k())).rejects
      .toMatchObject({ statusCode: 422, code: 'TROOP_ITEM_LOCKED' });
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_shards')).balance).toBe(shardsBefore);

    // Buy the writ: exactly the 5,000-KEEP catalog price (owner-quoted number).
    const keepBefore = await keepBalance(p.wallet);
    await buyItem(db, p.wallet, 'item_troop_mage', k());
    expect(await keepBalance(p.wallet)).toBe(keepBefore - 5_000n);
    expect(await writQty(p.wallet, 'item_troop_mage')).toBe(1);

    // USE consumes the writ and permanently unlocks the WALLET.
    const used = await useItem(db, p.wallet, 'item_troop_mage', k());
    expect(used).toMatchObject({ used: 'item_troop_mage', left: 0, effect: { troopUnlocked: 'mage' } });
    expect(await hasTroopUnlock(db, p.wallet, 'mage')).toBe(true);
    const queued = await trainTroop(db, p.wallet, 'mage', k());
    expect(queued.id).toBeTruthy();
    // The /army read model publishes the verdict the barracks UI renders.
    const state = await getArmyState(db, p.wallet);
    expect(state.eliteUnlocks).toMatchObject({ mage: true, dragon: false });
  });

  it('USE on an already-unlocked wallet refuses (422) and KEEPS the writ — sell it instead', async () => {
    // Pinned rule (task decision): the buyer who already owns the unlock never
    // burns the item for nothing — the refusal rolls the decrement back so the
    // writ stays tradeable.
    const p = await armyPlayer();
    await db.insert(troopUnlocks).values({ playerWallet: p.wallet, troop: 'mage', source: 'item' });
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'item_troop_mage', qty: 1 });
    await expect(useItem(db, p.wallet, 'item_troop_mage', k())).rejects
      .toThrow(/already train the MAGE/);
    expect(await writQty(p.wallet, 'item_troop_mage')).toBe(1); // kept, not burned
  });
});

describe('forge-drop-only writs (dragon/direwyvern/gloamfang/hexbarrow)', () => {
  it('cannot be bought for KEEP — the Gold Forge is their only faucet', async () => {
    const p = await armyPlayer();
    for (const itemId of ['item_troop_dragon', 'item_troop_direwyvern', 'item_troop_gloamfang', 'item_troop_hexbarrow']) {
      await expect(buyItem(db, p.wallet, itemId, k())).rejects.toThrow(/earned, not sold/);
    }
  });

  it('every writ is in the deed/day forge roll and actually drops at its published odds scale', async () => {
    // computeBaseForgeDrops is deterministic per (day, baseId): scanning many
    // synthetic deed ids both proves the writs are wired into the roll AND
    // sanity-bounds the odds (≈bps/10k per position).
    const writs = ['item_troop_dragon', 'item_troop_gloamfang', 'item_troop_hexbarrow', 'item_troop_direwyvern'] as const;
    const hits: Record<string, number> = Object.fromEntries(writs.map((w) => [w, 0]));
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      for (const item of computeBaseForgeDrops('2026-08-16', `synthetic-base-${i}`)) {
        if (item in hits) hits[item] = (hits[item] ?? 0) + 1;
      }
    }
    for (const w of writs) {
      const bps = { item_troop_dragon: 120, item_troop_gloamfang: 80, item_troop_hexbarrow: 50, item_troop_direwyvern: 30 }[w];
      const mean = (n * bps) / 10_000;
      expect(hits[w]).toBeGreaterThan(0);
      expect(hits[w]).toBeGreaterThan(mean * 0.4); // deterministic, so this pins the wiring
      expect(hits[w]).toBeLessThan(mean * 2.5);
    }
  });

  it('a dropped dragon writ unlocks dragon training when used', async () => {
    const p = await armyPlayer();
    // Simulate the forge settle grant (the settle path inserts inventory rows).
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'item_troop_dragon', qty: 1 });
    await expect(trainTroop(db, p.wallet, 'dragon', k())).rejects
      .toMatchObject({ code: 'TROOP_ITEM_LOCKED' });
    await useItem(db, p.wallet, 'item_troop_dragon', k());
    const queued = await trainTroop(db, p.wallet, 'dragon', k());
    expect(queued.id).toBeTruthy();
  });
});

describe('market trade of unlock items (SOL, wallet-custody legacy lane)', () => {
  const FEE = 'FeeTreasury1111111111111111111111111111111';
  let sigN = 0;
  const paidDeps: ItemMarketDeps = {
    feeTreasury: FEE,
    verifyPayment: async () => ({ txSignature: `troop-unlock-sig-${++sigN}` }),
    verifyPaymentCommit: async (p) => ({ txSignature: p.paymentSignature }),
  };

  it('a writ lists, sells, and the buyer (without the unlock) can USE it; hero contracts list too', async () => {
    // Unlike the dropOnly Warzone Aegis, writs/contracts are tradeable by owner
    // decision — forge drops are per-DEED/day (land costs real SOL), so the
    // 2026-08-09 free-account farming rationale does not apply to them.
    const seller = await createTestPlayer(db);
    await db.insert(playerItems).values([
      { playerWallet: seller.wallet, itemId: 'item_troop_dragon', qty: 1 },
      { playerWallet: seller.wallet, itemId: HEROES.vex.recruitItemId, qty: 1 },
    ]);
    const heroListing = await listItem(db, seller.wallet, HEROES.vex.recruitItemId, 1_000_000n, k());
    expect(heroListing.itemId).toBe(HEROES.vex.recruitItemId);
    const listing = await listItem(db, seller.wallet, 'item_troop_dragon', 1_000_000n, k());

    const buyer = await armyPlayer();
    await reserveListing(db, paidDeps, buyer.wallet, listing.id);
    const settled = await settleListing(db, paidDeps, buyer.wallet, listing.id);
    expect(settled).toMatchObject({ settled: true, itemId: 'item_troop_dragon' });
    expect(await writQty(buyer.wallet, 'item_troop_dragon')).toBe(1);
    expect(await writQty(seller.wallet, 'item_troop_dragon')).toBe(0);

    // The transferred writ carries the unlock: the buyer uses it and trains.
    await useItem(db, buyer.wallet, 'item_troop_dragon', k());
    expect(await hasTroopUnlock(db, buyer.wallet, 'dragon')).toBe(true);
    await trainTroop(db, buyer.wallet, 'dragon', k());
  });

  it('the dropOnly Warzone Aegis still cannot be listed — the writ rule did not widen that door', async () => {
    const seller = await createTestPlayer(db);
    await db.insert(playerItems).values({ playerWallet: seller.wallet, itemId: 'warzone_aegis', qty: 1 });
    await expect(listItem(db, seller.wallet, 'warzone_aegis', 1_000_000n, k()))
      .rejects.toThrow(/cannot be sold/);
  });
});

describe('grandfathering (critical — live players keep what they have)', () => {
  it('the boot backfill seeds exactly the retired rules, then self-marks and never re-runs', async () => {
    const cutoverMs = Date.parse(ELITE_TROOP_UNLOCKS.grandfather.cutoverIso);
    const preCutoverCreatedAt = new Date(cutoverMs - 1);
    const postCutoverCreatedAt = new Date(cutoverMs + 1);
    // Wallets modelling the live population at rollout use an explicit
    // pre-cutover timestamp so this contract remains true after wall-clock time
    // passes the historical D-058 rollout date.
    const veteranK8 = await createTestPlayer(db);   // Keep 8 → gloamfang under the retired gate
    await db.update(players).set({ keepLevel: 8, createdAt: preCutoverCreatedAt })
      .where(eq(players.wallet, veteranK8.wallet));
    const starterK1 = await createTestPlayer(db);   // Keep 1 → only the never-gated troops
    await db.update(players).set({ createdAt: preCutoverCreatedAt })
      .where(eq(players.wallet, starterK1.wallet));
    // This owner is deliberately post-cutover: fielded presence, not the
    // retired Keep gate or account age, must preserve its direwyvern.
    const wyvernOwner = await createTestPlayer(db); // Keep 1 but FIELDS a direwyvern
    await db.update(players).set({ createdAt: postCutoverCreatedAt })
      .where(eq(players.wallet, wyvernOwner.wallet));
    await db.insert(army).values({ playerWallet: wyvernOwner.wallet, troop: 'direwyvern', count: 2 });
    // A wallet created AFTER the cutover gets nothing from the gate criterion.
    const newcomer = randomWallet();
    await db.insert(players).values({
      wallet: newcomer,
      createdAt: postCutoverCreatedAt,
    });

    // Order independence: server-startup.test boots the worker, which runs this
    // same backfill into the shared test DB and self-marks it. The self-mark is
    // exactly what this test pins, so start from an unmarked DB regardless of
    // which file ran first (K-049).
    await db.delete(troopUnlocks).where(eq(troopUnlocks.source, 'grandfather'));
    const first = await grandfatherEliteTroopUnlocks(db);
    expect(first.skipped).toBe(false);
    expect(first.inserted).toBeGreaterThan(0);

    expect(await eliteUnlocksOf(db, veteranK8.wallet)).toEqual({
      mage: true, dragon: true, gloamfang: true, hexbarrow: false, direwyvern: false,
    });
    expect(await eliteUnlocksOf(db, starterK1.wallet)).toEqual({
      mage: true, dragon: true, gloamfang: false, hexbarrow: false, direwyvern: false,
    });
    // Fielding exactly this troop wins regardless of Keep level or account
    // age: the army stays trainable without widening any other unlock.
    expect(await eliteUnlocksOf(db, wyvernOwner.wallet)).toEqual({
      mage: false, dragon: false, gloamfang: false, hexbarrow: false, direwyvern: true,
    });
    expect(await eliteUnlocksOf(db, newcomer)).toEqual({
      mage: false, dragon: false, gloamfang: false, hexbarrow: false, direwyvern: false,
    });

    // Second run: the source='grandfather' marker short-circuits the scan, so
    // a pre-cutover wallet leveling up LATER cannot ride the retired rule in.
    await db.update(players).set({ keepLevel: 14 }).where(eq(players.wallet, starterK1.wallet));
    const second = await grandfatherEliteTroopUnlocks(db);
    expect(second).toEqual({ skipped: true, inserted: 0 });
    expect((await eliteUnlocksOf(db, starterK1.wallet)).direwyvern).toBe(false);
  });

  it('the lazy self-heal grants a wallet that already fields the troop, even after the backfill', async () => {
    // Belt and braces for worker-less deployments (the R9 lesson): the gate
    // itself repairs any fielded army the sweep missed — a training queue must
    // never refuse a troop the player demonstrably owns.
    const p = await armyPlayer();
    await db.insert(army).values({ playerWallet: p.wallet, troop: 'gloamfang', count: 1 });
    const previous = process.env['DARK_ATTACKER_ROSTER_ENABLED'];
    process.env['DARK_ATTACKER_ROSTER_ENABLED'] = 'true';
    try {
      const queued = await trainTroop(db, p.wallet, 'gloamfang', k());
      expect(queued.id).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env['DARK_ATTACKER_ROSTER_ENABLED'];
      else process.env['DARK_ATTACKER_ROSTER_ENABLED'] = previous;
    }
    const [row] = await db.select().from(troopUnlocks).where(and(
      eq(troopUnlocks.playerWallet, p.wallet), eq(troopUnlocks.troop, 'gloamfang'),
    ));
    expect(row?.source).toBe('lazy_grandfather');
  });

  it('a DEED-scoped army does NOT lazy-grant — a shuttled base cannot mint unlocks (security review 2026-08-16 F1)', async () => {
    // base_army follows the base on every deed transfer/sale. If the lazy
    // self-heal read it, one parked direwyvern plus one deed would mint a
    // permanent unlock for every wallet the deed passes through, draining the
    // writ market this change creates. Deed armies at rollout are covered by
    // the one-shot boot backfill instead; a post-rollout base buyer keeps the
    // army itself (deploys are roster-based) but must earn the writ to train
    // more.
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await ensureWalletBaseIdentity(db, p.wallet);
    const [base] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, p.wallet));
    await db.insert(baseArmy).values({ baseId: base!.id, troop: 'direwyvern', count: 3 });
    await expect(assertEliteTroopUnlocked(db, p.wallet, 'direwyvern')).rejects
      .toMatchObject({ statusCode: 422, code: 'TROOP_ITEM_LOCKED' });
    expect(await hasTroopUnlock(db, p.wallet, 'direwyvern')).toBe(false);
  });
});

describe('hero contracts vs /items/use', () => {
  it('a hero contract is not usable from inventory — placement is the consume path', async () => {
    const p = await createTestPlayer(db);
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: HEROES.theodor.recruitItemId, qty: 1 });
    await expect(useItem(db, p.wallet, HEROES.theodor.recruitItemId, k()))
      .rejects.toThrow(/placing the hero's altar/);
    expect(await writQty(p.wallet, HEROES.theodor.recruitItemId)).toBe(1);
  });

  it('buying a hero contract enforces the Keep-5 acquisition gate and the exact owner price', async () => {
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await fundTestKeep(db, p.wallet, 100_000n, 'test.fund', k());
    await expect(buyItem(db, p.wallet, 'item_hero_vex', k())).rejects.toThrow(/Keep level 5/);
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, p.wallet));
    const before = await keepBalance(p.wallet);
    await buyItem(db, p.wallet, 'item_hero_vex', k());
    expect(await keepBalance(p.wallet)).toBe(before - BigInt(HEROES.vex.recruitCostKeep));
    expect(await writQty(p.wallet, 'item_hero_vex')).toBe(1);
  });
});
