/**
 * Items: purchases must charge exactly the catalog price atomically with the
 * grant (never one without the other) and be idempotent per request key — the
 * economy rule being encoded: item purchases are pure KEEP sinks that recycle
 * to emission_pool. The keep-skin cosmetics were REMOVED from the game (owner
 * 2026-08-15, M23 a8, D-009 refund); their ids must now behave as fully
 * unknown items on every purchase/use/discovery surface.
 */
import { BuildingType, GEAR_ITEMS, GEAR_SLOTS, INVENTORY, ITEMS } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bases, baseSlots, baseItems, troopUnlocks, builderJobs, buildings, campaignProgress, heroEquipment, heroLevels, heroLoadouts,
  obstacles, playerItems, players, shields,
} from '../src/db/schema';
import {
  buyItem, equipHeroItem, getItems, markItemSeen, resolveHeroLoadouts, useItem,
} from '../src/game/items';
import { ensureStartingBase, placeBuilding, upgradeBuilding } from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `items-${++key}-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

const balance = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;

async function richPlayer(keep = 100_000n) {
  const p = await createTestPlayer(db);
  await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
  await rewardShards(db, p.wallet, keep, 'test.fund.shards', k());
  return p;
}

describe('idempotency-key abuse (security review 2026-07-24 #2)', () => {
  it('a retried buy (same key) neither double-charges NOR double-grants', async () => {
    // WHY: a duplicate spendKeep is a charge NO-OP — if the grant still runs,
    // every network retry stacks a free consumable.
    const p = await richPlayer();
    const before = await balance(p.wallet);
    const key1 = k();
    await buyItem(db, p.wallet, 'powder_charge', key1);
    await buyItem(db, p.wallet, 'powder_charge', key1); // retry, same key
    expect(await balance(p.wallet)).toBe(before - BigInt(ITEMS.powder_charge.costKeep)); // one charge
    const inv = await getItems(db, p.wallet);
    expect(inv.owned).toEqual([{ itemId: 'powder_charge', qty: 1 }]); // ONE grant
  });

  it('rejects a spent key reused for a DIFFERENT item and grants nothing for free', async () => {
    const p = await richPlayer();
    const key1 = k();
    await buyItem(db, p.wallet, 'finishers_seal', key1);
    const before = await balance(p.wallet);
    await expect(buyItem(db, p.wallet, 'keg_of_haste', key1))
      .rejects.toThrow(/different item/);
    expect(await balance(p.wallet)).toBe(before);
    const inv = await getItems(db, p.wallet);
    expect(inv.owned).toEqual([{ itemId: 'finishers_seal', qty: 1 }]); // ...and NO free item
  });
});

describe('purchase discipline (post keep-skin retirement, M23 a8)', () => {

  it.each(['item_hero_vex', 'item_hero_theodor', 'item_troop_mage'] as const)(
    'concurrent %s purchases grant one unused copy and charge once', async (itemId) => {
      const p = await richPlayer();
      await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, p.wallet));
      const before = await balance(p.wallet);
      const outcomes = await Promise.allSettled([
        buyItem(db, p.wallet, itemId, k()), buyItem(db, p.wallet, itemId, k()),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await balance(p.wallet)).toBe(before - BigInt(ITEMS[itemId].costKeep));
      expect((await getItems(db, p.wallet)).owned).toEqual([{ itemId, qty: 1 }]);
    },
  );

  it('activated training and an unused tradable writ remain distinct', async () => {
    const p = await richPlayer();
    await db.insert(troopUnlocks).values({ playerWallet: p.wallet, troop: 'mage', source: 'item' });
    const before = await balance(p.wallet);
    await buyItem(db, p.wallet, 'item_troop_mage', k());
    const inv = await getItems(db, p.wallet);
    expect(inv.catalog.find((item) => item.id === 'item_troop_mage')?.activation)
      .toEqual({ kind: 'troop', active: true });
    expect(inv.owned).toEqual([{ itemId: 'item_troop_mage', qty: 1 }]);
    expect(await balance(p.wallet)).toBe(before - BigInt(ITEMS.item_troop_mage.costKeep));
    await expect(useItem(db, p.wallet, 'item_troop_mage', k())).rejects.toThrow(/already train/);
    expect((await getItems(db, p.wallet)).owned).toEqual(inv.owned);
  });

  it('hero activation follows the selected base; legacy contracts fund placement without becoming deed stock', async () => {
    const p = await richPlayer();
    const rows = await db.insert(bases).values([
      { ownerWallet: p.wallet, keepLevel: 5 }, { ownerWallet: p.wallet, keepLevel: 5 },
    ]).returning();
    await db.insert(baseSlots).values(rows.map((base, index) => ({ wallet: p.wallet, slot: index + 1, baseId: base.id })));
    await db.insert(buildings).values({ playerWallet: p.wallet, baseId: rows[0]!.id, type: 'siegestool', level: 1, tx: 8, ty: 8 });
    await db.insert(baseItems).values({ baseId: rows[0]!.id, itemId: 'item_hero_theodor', qty: 1 });
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'item_hero_theodor', qty: 1 });
    const previous = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const first = await getItems(db, p.wallet, rows[0]!.id);
      const second = await getItems(db, p.wallet, rows[1]!.id);
      expect(first.catalog.find((item) => item.id === 'item_hero_theodor')?.activation)
        .toEqual({ kind: 'hero', active: true, availableContracts: 2 });
      expect(second.catalog.find((item) => item.id === 'item_hero_theodor')?.activation)
        .toEqual({ kind: 'hero', active: false, availableContracts: 1 });
      expect(first.owned).toEqual([{ itemId: 'item_hero_theodor', qty: 1 }]);
      expect(second.owned).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = previous;
    }
  });

  it('buy charges the catalog price and grants the item atomically', async () => {
    const p = await richPlayer();
    const before = await balance(p.wallet);
    await buyItem(db, p.wallet, 'finishers_seal', k());
    expect(await balance(p.wallet)).toBe(before - BigInt(ITEMS.finishers_seal.costKeep));
    const inv = await getItems(db, p.wallet);
    expect(inv.owned).toEqual([{ itemId: 'finishers_seal', qty: 1 }]);
  });

  it('rejects a buy past maxOwned BEFORE charging', async () => {
    // WHY: maxOwned is the cap that replaced the cosmetics' unique-per-player
    // rule; the refusal must land before any KEEP moves, like every other gate.
    // (Rewritten 2026-08-16: this used to buy Warden gear, but gear is now
    // forge-drop-exclusive — the hero contract is the purchasable capped item.)
    const p = await richPlayer(200_000n);
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, p.wallet));
    await buyItem(db, p.wallet, 'item_hero_vex', k()); // maxOwned: 1
    const before = await balance(p.wallet);
    await expect(buyItem(db, p.wallet, 'item_hero_vex', k())).rejects.toThrow(/maximum owned/);
    expect(await balance(p.wallet)).toBe(before); // no charge on the refusal
  });

  it('insufficient KEEP grants nothing (charge + grant roll back together)', async () => {
    const p = await richPlayer(10n); // far below any catalog price
    await expect(buyItem(db, p.wallet, 'finishers_seal', k())).rejects.toThrow();
    const inv = await getItems(db, p.wallet);
    expect(inv.owned).toHaveLength(0);
    expect(await balance(p.wallet)).toBe(10n);
  });

  it('unknown items — including retired keep-skin ids — are a 404, not a charge', async () => {
    // WHY: the three skins were deleted from the catalog (D-009 refund handled
    // by the worker sweep); a stale client retrying a skin purchase must get
    // "unknown", never a charge or a resurrected cosmetic.
    const p = await richPlayer();
    await expect(buyItem(db, p.wallet, 'skin_keep_dragonglass', k())).rejects.toThrow(/unknown/);
    await expect(buyItem(db, p.wallet, 'skin_keep_frost', k())).rejects.toThrow(/unknown/);
    await expect(buyItem(db, p.wallet, 'skin_keep_gilded', k())).rejects.toThrow(/unknown/);
    await expect(buyItem(db, p.wallet, 'skin_keep_voidstone', k())).rejects.toThrow(/unknown/);
  });

  it('the catalog carries no cosmetic kind and retired ids are unknown to every surface', async () => {
    const p = await richPlayer();
    const inv = await getItems(db, p.wallet);
    expect(new Set<string>(inv.catalog.map((item) => item.kind)).has('cosmetic')).toBe(false);
    expect(inv.catalog.some((item) => item.id.startsWith('skin_'))).toBe(false);
    await expect(markItemSeen(db, p.wallet, 'skin_keep_frost')).rejects.toThrow(/unknown/);
    await expect(useItem(db, p.wallet, 'skin_keep_frost', k())).rejects.toThrow(/unknown/);
  });
});

describe('Warden gear inventory and hero loadouts', () => {
  async function recruit(wallet: string, both = false): Promise<void> {
    await db.insert(buildings).values({
      playerWallet: wallet, type: BuildingType.HeroAltar, level: 1, tx: 1, ty: 1,
    });
    if (both) {
      await db.insert(buildings).values({
        playerWallet: wallet, type: BuildingType.SiegeStool, level: 1, tx: 4, ty: 1,
      });
    }
  }

  it('refuses to SELL any gear no matter the progression — drops are the only source', async () => {
    // Rewritten 2026-08-16: this test used to walk the retired Keep-level /
    // campaign / max-hero PURCHASE gates. Owner (verbatim): "gear also should
    // be gathered exclusively from drops." The rule to pin is that no amount
    // of KEEP or progression buys gear any more — a maxed player with every
    // prerequisite of the old gates still gets the earned-not-sold refusal
    // and is never charged. Gear ALREADY owned (bought under the old rules or
    // forge-dropped) stays owned and fully usable — no clawback.
    const p = await richPlayer(2_000_000n);
    await db.update(players).set({ keepLevel: 20 }).where(eq(players.wallet, p.wallet));
    await db.insert(campaignProgress).values([
      { playerWallet: p.wallet, stage: 6, bestStars: 3 },
      { playerWallet: p.wallet, stage: 18, bestStars: 3 },
    ]);
    await db.insert(heroLevels).values({ playerWallet: p.wallet, hero: 'vex', level: 20 });
    const before = await balance(p.wallet);
    for (const gearId of Object.keys(GEAR_ITEMS)) {
      await expect(buyItem(db, p.wallet, gearId, k())).rejects.toThrow(/earned, not sold/);
    }
    expect(await balance(p.wallet)).toBe(before); // no refusal ever charged
    // Previously-acquired gear is honoured: it stays owned and keeps its spec
    // in the catalog so inventory/market can render it.
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'marchers_greaves', qty: 1 });
    const inv = await getItems(db, p.wallet);
    expect(inv.owned).toEqual([{ itemId: 'marchers_greaves', qty: 1 }]);
    expect(inv.catalog.some((item) => item.id === 'marchers_greaves')).toBe(true);
  });

  it('serialises one owned copy across both heroes and rejects stale versions', async () => {
    const p = await richPlayer();
    await recruit(p.wallet, true);
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'wardens_helm', qty: 1 });
    const first = await equipHeroItem(db, p.wallet, 'vex', 'helm', 'wardens_helm', 0);
    expect(first.version).toBe(1);
    // Optimistic concurrency is authoritative even when a stale caller asks for
    // the state it happens to see: it must refresh the whole loadout first.
    await expect(equipHeroItem(db, p.wallet, 'vex', 'helm', 'wardens_helm', 0))
      .rejects.toThrow(/loadout changed/);
    await expect(equipHeroItem(db, p.wallet, 'theodor', 'helm', 'wardens_helm', 0))
      .rejects.toThrow(/already equipped/);
    await expect(equipHeroItem(db, p.wallet, 'vex', 'helm', null, 0)).rejects.toThrow(/loadout changed/);
    await expect(equipHeroItem(db, p.wallet, 'vex', 'boots', 'wardens_helm', 1)).rejects.toThrow(/does not fit/);
    expect(await db.select().from(heroEquipment).where(eq(heroEquipment.playerWallet, p.wallet))).toHaveLength(1);
  });

  it('applies fixed integer modifiers, removes equipped weight, and allows overflow on unequip', async () => {
    const p = await richPlayer();
    await recruit(p.wallet);
    await db.insert(playerItems).values([
      { playerWallet: p.wallet, itemId: 'wardens_helm', qty: 1 },
      { playerWallet: p.wallet, itemId: 'keg_of_haste', qty: 156 },
    ]);
    const before = await getItems(db, p.wallet);
    expect(before.capacity).toEqual({ used: 160, max: 160, overflow: false });
    await equipHeroItem(db, p.wallet, 'vex', 'helm', 'wardens_helm', 0);
    const equipped = await getItems(db, p.wallet);
    expect(equipped.capacity.used).toBe(156);
    const vex = equipped.heroLoadouts.find((row) => row.hero === 'vex')!;
    expect(vex.effectiveStats).toEqual({ hp: 1_484, basicDamage: 95, skillDamageSeed: 98 });

    // Returned equipment is never destroyed or stranded; it may overflow and
    // the resulting bag blocks a new acquisition until the player makes space.
    await db.update(playerItems).set({ qty: 160 }).where(and(
      eq(playerItems.playerWallet, p.wallet), eq(playerItems.itemId, 'keg_of_haste'),
    ));
    await equipHeroItem(db, p.wallet, 'vex', 'helm', null, 1);
    const overflow = await getItems(db, p.wallet);
    expect(overflow.capacity).toEqual({ used: 164, max: 160, overflow: true });
    await expect(buyItem(db, p.wallet, 'keg_of_haste', k())).rejects.toThrow(/inventory full/);
  });

  it('resolves one canonical capped loadout hash/version independent of row order', async () => {
    const p = await richPlayer();
    await recruit(p.wallet);
    const gear = Object.entries(GEAR_ITEMS).map(([itemId, spec]) => ({ itemId, spec }));
    await db.insert(playerItems).values(gear.map(({ itemId }) => ({
      playerWallet: p.wallet, itemId, qty: 1,
    })));
    await db.insert(heroLoadouts).values({ playerWallet: p.wallet, hero: 'vex', version: 9 });
    await db.insert(heroEquipment).values([...gear].reverse().map(({ itemId, spec }) => ({
      playerWallet: p.wallet, hero: 'vex' as const, slot: spec.slot, itemId,
    })));

    const first = (await resolveHeroLoadouts(db, p.wallet)).vex;
    const second = (await resolveHeroLoadouts(db, p.wallet)).vex;
    expect(first.version).toBe(9);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.hash).toBe(first.hash);
    expect(Object.keys(first.equipment)).toEqual(GEAR_SLOTS);

    const expected = Object.fromEntries(
      Object.keys(INVENTORY.modifierCapsBps).map((stat) => [stat, 0]),
    ) as Record<keyof typeof INVENTORY.modifierCapsBps, number>;
    for (const { spec } of gear) for (const modifier of spec.modifiers) {
      expected[modifier.stat] += modifier.value;
    }
    for (const modifier of INVENTORY.wardenSet.modifiers) expected[modifier.stat] += modifier.value;
    for (const stat of Object.keys(expected) as Array<keyof typeof expected>) {
      expected[stat] = Math.max(-INVENTORY.modifierCapsBps[stat],
        Math.min(INVENTORY.modifierCapsBps[stat], expected[stat]));
    }
    expect(first.modifiers).toEqual(expected);
    expect(first.setActive).toBe(true);
  });

  it('persists discovery at qty zero and later buying that item still works', async () => {
    const p = await richPlayer();
    const seen = await markItemSeen(db, p.wallet, 'powder_charge', new Date('2026-08-11T00:00:00Z'));
    expect(seen.seenAt).toBe('2026-08-11T00:00:00.000Z');
    expect((await getItems(db, p.wallet)).owned).toHaveLength(0);
    await buyItem(db, p.wallet, 'powder_charge', k());
    const inv = await getItems(db, p.wallet);
    expect(inv.owned).toContainEqual({ itemId: 'powder_charge', qty: 1 });
    expect(inv.discovery).toContainEqual({ itemId: 'powder_charge', seenAt: '2026-08-11T00:00:00.000Z' });
  });

  it('the DB constraint rejects negative quantities', async () => {
    const p = await richPlayer();
    await expect(db.insert(playerItems).values({
      playerWallet: p.wallet, itemId: 'keg_of_haste', qty: -1,
    })).rejects.toThrow();
  });

  it('the catalog has ten live gear slots and no off-world mock mechanics', async () => {
    const p = await richPlayer();
    const inv = await getItems(db, p.wallet);
    const gear = inv.catalog.filter((item) => item.kind === 'gear');
    expect(new Set(gear.map((item) => item.slot))).toEqual(new Set(GEAR_SLOTS));
    expect(inv.catalog.map((item) => item.id)).not.toEqual(expect.arrayContaining([
      'he3_canister', 'h2_flask', 'deed_moon', 'deed_jup', 'molten_core', 'ward_charm',
    ]));
  });

  it('reveals an earned drop-only item in inventory without advertising unowned drops', async () => {
    // WHY: the HUD builds every cube and action from `catalog`. Returning an
    // owned Aegis only in `owned` made the world's scarce daily Forge reward
    // invisible and unusable from the dedicated inventory screen.
    const p = await richPlayer();
    expect((await getItems(db, p.wallet)).catalog.some((item) => item.id === 'warzone_aegis')).toBe(false);
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'warzone_aegis', qty: 1 });
    const inv = await getItems(db, p.wallet);
    expect(inv.catalog.find((item) => item.id === 'warzone_aegis')).toMatchObject({
      dropOnly: true, acquisition: { type: 'drop' }, kind: 'consumable',
    });
    expect(inv.owned).toContainEqual({ itemId: 'warzone_aegis', qty: 1 });
  });

  it('unions authoritative stable-base deeds without duplicating them as backpack items', async () => {
    const p = await richPlayer();
    const [base] = await db.insert(bases).values({
      ownerWallet: p.wallet, deedAssetId: `deed-${k()}`, keepLevel: 7, landPaidAt: new Date(),
    }).returning();
    await db.insert(baseSlots).values({ wallet: p.wallet, slot: 1, baseId: base!.id });
    const previous = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const inv = await getItems(db, p.wallet, base!.id);
      expect(inv.deeds).toEqual([expect.objectContaining({
        id: base!.deedAssetId, baseId: base!.id, kind: 'deed', asset: 'itm_deed_earth', status: 'active',
      })]);
      expect(inv.owned.some((row) => row.itemId === base!.deedAssetId)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = previous;
    }
  });

  it('never exposes a stale player deed shadow as multi-base authority', async () => {
    // WHY: players.deedAssetId is a flag-off compatibility projection. A sold
    // or independently reconciled stable deed can leave it stale; inventory
    // must not relabel that scalar as a currently owned NFT under multi-base.
    const p = await richPlayer();
    await db.update(players).set({ deedAssetId: `stale-${k()}` }).where(eq(players.wallet, p.wallet));
    const [base] = await db.insert(bases).values({ ownerWallet: p.wallet }).returning();
    await db.insert(baseSlots).values({ wallet: p.wallet, slot: 1, baseId: base!.id });
    const previous = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      expect((await getItems(db, p.wallet, base!.id)).deeds).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = previous;
    }
  });
});

describe('consumables (USABLE items — owner priority 2026-07-24)', () => {
  it('purchases stack qty; each buy charges the price', async () => {
    const p = await richPlayer();
    const before = await balance(p.wallet);
    await buyItem(db, p.wallet, 'keg_of_haste', k());
    await buyItem(db, p.wallet, 'keg_of_haste', k());
    expect(await balance(p.wallet)).toBe(before - 2n * BigInt(ITEMS.keg_of_haste.costKeep));
    const inv = await getItems(db, p.wallet);
    expect(inv.owned).toEqual([{ itemId: 'keg_of_haste', qty: 2 }]);
  });

  it('use with none left rejects (atomic qty guard)', async () => {
    const p = await richPlayer();
    await expect(useItem(db, p.wallet, 'keg_of_haste', k())).rejects.toThrow(/none left/);
  });

  it('powder_charge grants +1 purchased raid energy and consumes one unit', async () => {
    const p = await richPlayer();
    await buyItem(db, p.wallet, 'powder_charge', k());
    const res = await useItem(db, p.wallet, 'powder_charge', k());
    expect(res.left).toBe(0);
    const [row] = await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, p.wallet));
    expect(row!.e).toBe(1);
    // second use: consumed → rejects, energy unchanged
    await expect(useItem(db, p.wallet, 'powder_charge', k())).rejects.toThrow(/none left/);
  });

  it('the SAME use request submitted twice consumes exactly one unit (E2)', async () => {
    // The qty > 0 guard stops you spending units you don't own, but it cannot
    // tell one intent sent twice from two real uses — and a unit is SOL-
    // denominated value (items trade for SOL on the market). Buy TWO so the
    // second submit would genuinely succeed if the key weren't enforced; that is
    // what separates this from the "none left" case above.
    const p = await richPlayer();
    await buyItem(db, p.wallet, 'powder_charge', k());
    await buyItem(db, p.wallet, 'powder_charge', k());
    const sameKey = k();

    const first = await useItem(db, p.wallet, 'powder_charge', sameKey);
    expect(first.left).toBe(1); // one of the two spent
    await expect(useItem(db, p.wallet, 'powder_charge', sameKey))
      .rejects.toThrow(/duplicate use request/);

    // THE POINT: the surviving unit is still owned and the effect applied once.
    const [inv] = await db.select({ qty: playerItems.qty }).from(playerItems)
      .where(and(eq(playerItems.playerWallet, p.wallet), eq(playerItems.itemId, 'powder_charge')));
    expect(inv!.qty).toBe(1);
    const [row] = await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, p.wallet));
    expect(row!.e).toBe(1); // NOT 2 — the duplicate granted nothing

    // A genuinely different intent still works: the key gates replays, not usage.
    await useItem(db, p.wallet, 'powder_charge', k());
    const [after] = await db.select({ e: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, p.wallet));
    expect(after!.e).toBe(2);
  });

  it('finish_job completes an eligible build; an over-bound job rolls the use back', async () => {
    const p = await richPlayer(1_000_000n);
    await ensureStartingBase(db, p.wallet);
    // obstacles are wallet-hashed — clear them so tile choice is deterministic
    await db.delete(obstacles).where(eq(obstacles.playerWallet, p.wallet));
    // a fresh camp build has a 60s timer (constants) — inside the keg's 30m bound
    await placeBuilding(db, p.wallet, BuildingType.Camp, 11, 11, k());
    await buyItem(db, p.wallet, 'keg_of_haste', k());
    const res = await useItem(db, p.wallet, 'keg_of_haste', k());
    expect(res.effect).toHaveProperty('finishedJobId');
    const [done] = await db.select().from(buildings).where(and(
      eq(buildings.playerWallet, p.wallet), eq(buildings.type, 'camp')));
    expect(done!.level).toBe(1);
    // over-bound: the use REJECTS and the item is kept (decrement rolled back
    // with the effect). This case has now been re-pointed TWICE, and the reason
    // is worth keeping: it was a cannon BUILD (3600s) until owner 2026-08-29 made
    // every L1 build 60s, then a cannon L1→L2 upgrade (8h) until owner 2026-08-30
    // (D-085) replaced the upgrade table with one ladder whose L1→L2 is 10m —
    // under the keg's own 1800s bound. Every LOW step is now short, so the bound
    // has to be exercised further up the ladder: L10→L11 is 10h. The rule under
    // test never changed and is still load-bearing: without the bound, chaining
    // 60-KEEP kegs would undercut the super-linear speed-up curve on long jobs.
    const cannon = await placeBuilding(db, p.wallet, BuildingType.Cannon, 17, 11, k());
    await db.update(buildings).set({ level: 10 }).where(eq(buildings.id, cannon.id));
    await db.update(players).set({ keepLevel: 11 }).where(eq(players.wallet, p.wallet));
    await db.update(bases).set({ keepLevel: 11 }).where(eq(bases.ownerWallet, p.wallet));
    // +2m lands the 60s cannon build inside upgradeBuilding's completeDueJobs,
    // so the only open job left is the 10h upgrade the keg must refuse.
    await upgradeBuilding(db, p.wallet, cannon.id, k(), new Date(Date.now() + 120_000));
    await buyItem(db, p.wallet, 'keg_of_haste', k());
    await expect(useItem(db, p.wallet, 'keg_of_haste', k())).rejects.toThrow(/finishes builds under/);
    const inv = await getItems(db, p.wallet);
    expect(inv.owned.find((o) => o.itemId === 'keg_of_haste')?.qty).toBe(1);
  });

  it('the warzone relic cannot be burned onto a shield you already have, and is NOT consumed by the refusal', async () => {
    // WHY: warzone_aegis is dropOnly — one is forged per DAY in the whole world and
    // it is catalogued at 8 000 KEEP. The SOL purchase path preflights no-stacking
    // via assertWarzoneShieldPurchasable, but USE granted unconditionally, so a
    // player holding a live warzone shield could spend the relic on a duplicate
    // shields row worth nothing (audit 2026-07-26). The refusal must also ROLL BACK
    // the qty take, or the guard would cost the player the very item it protects.
    const p = await richPlayer();
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'warzone_aegis', qty: 2 });

    const first = await useItem(db, p.wallet, 'warzone_aegis', k());
    expect(first.effect).toHaveProperty('warzoneShieldUntil');
    expect(first.left).toBe(1);

    await expect(useItem(db, p.wallet, 'warzone_aegis', k())).rejects.toThrow(/already have an active warzone shield/);
    const inv = await getItems(db, p.wallet);
    expect(inv.owned.find((o) => o.itemId === 'warzone_aegis')?.qty).toBe(1); // NOT consumed
    const live = await db.select().from(shields)
      .where(and(eq(shields.playerWallet, p.wallet), eq(shields.source, 'warzone')));
    expect(live.length).toBe(1); // exactly one shield, no duplicate row
  });

  it('a finish-build item is NOT burned on a job that is already due', async () => {
    // WHY: completion is lazy (completeDueJobs runs post-commit / on /base polls),
    // so a job can sit finishesAt-in-the-past with completedAt NULL. USE used to
    // "finish" it and destroy a 60-KEEP item for a build that was completing for
    // free — and a double-tap burned the second unit too (security review F1).
    const p = await richPlayer();
    await ensureStartingBase(db, p.wallet);
    const b = await placeBuilding(db, p.wallet, BuildingType.Vault, 11, 8, k());
    await buyItem(db, p.wallet, 'keg_of_haste', k());
    // age the build job past its finish time WITHOUT completing it
    await db.update(builderJobs)
      .set({ finishesAt: new Date(Date.now() - 30_000) })
      .where(eq(builderJobs.buildingId, b.id));

    await expect(useItem(db, p.wallet, 'keg_of_haste', k())).rejects.toThrow(/already done/);
    const inv = await getItems(db, p.wallet);
    expect(inv.owned.find((o) => o.itemId === 'keg_of_haste')?.qty).toBe(1); // NOT consumed
  });

  it('gear is not usable; consumables do not fit hero gear slots', async () => {
    // WHY: kind boundaries are what keep USE (value-destroying) and EQUIP
    // (custody-moving) from crossing — a consumable equipping into a slot
    // would shelter it from the market's loose-copy fence.
    const p = await richPlayer();
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'wardens_helm', qty: 1 });
    await expect(useItem(db, p.wallet, 'wardens_helm', k())).rejects.toThrow(/not usable/);
    await buyItem(db, p.wallet, 'keg_of_haste', k());
    await expect(equipHeroItem(db, p.wallet, 'vex', 'helm', 'keg_of_haste', 0))
      .rejects.toThrow(/does not fit/);
  });
});
