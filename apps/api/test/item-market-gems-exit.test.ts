/**
 * Gems have no exit through the item market (D-152 owner lock §2.1-6;
 * refuter R1 in the M41 plan; E2-GEMS-CONTRACT §3 provenance).
 *
 * WHY: the shipped in-game item market is a SOL lane (95 % to the seller's
 * wallet). If a system-shop item bought with Gems could be listed there,
 * "non-withdrawable" would be false — Gems → item → SOL, bypassing the KEEP
 * market's 10 % burn. So every catalogue item the shop sells for Gems must be
 * refused at LIST, for the whole stack, while a KEEP-bought or legacy copy
 * still lists (pre-rule listings settle; settlement is deliberately untouched).
 */
import { randomUUID } from 'node:crypto';
import { ITEMS, MARKETPLACE } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playerItems, players } from '../src/db/schema';
import { withClientCurrency } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import { listItem } from '../src/game/itemMarket';
import { buyItem } from '../src/game/items';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const k = () => randomUUID();
const ENV = ['GEMS_ENABLED', 'MULTI_BASE_ENABLED'] as const;
const prior: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
beforeAll(async () => {
  for (const key of ENV) prior[key] = process.env[key];
  process.env['GEMS_ENABLED'] = 'true';
  process.env['MULTI_BASE_ENABLED'] = 'false';
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  for (const key of ENV) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  await conn.sql.end();
});

type Spec = { costKeep: number; dropOnly?: boolean; acquisition: { type: string; keepLevel?: number } };
/** Every item the system shop sells for a price: the Gems-buyable catalogue. */
const SOLD_FOR_A_PRICE = Object.entries(ITEMS as Record<string, Spec>)
  .filter(([, spec]) => spec.costKeep > 0 && !spec.dropOnly && (spec.acquisition.type === 'shop' || spec.acquisition.type === 'keep_level'))
  .map(([id]) => id);
const price = BigInt(MARKETPLACE.itemMarket.minPriceLamports);

async function buyer(gems: bigint, keep = 0n) {
  const { wallet } = await createTestPlayer(db);
  await db.update(players).set({ keepLevel: 20 }).where(eq(players.wallet, wallet));
  await fundTestKeep(db, wallet, gems + keep, 'test.fund', k());
  if (gems > 0n) await convertKeepToGems(db, wallet, gems, k());
  return wallet;
}
const provenance = async (wallet: string, itemId: string) => (await db.select({ v: playerItems.acquiredVia }).from(playerItems)
  .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, itemId))))[0]?.v;

describe('every priced shop item bought with Gems is account-bound', () => {
  it('has a non-empty catalogue to pin', () => {
    expect(SOLD_FOR_A_PRICE.length).toBeGreaterThan(0);
  });

  for (const itemId of SOLD_FOR_A_PRICE) {
    it(`${itemId}: bought with Gems → shop_gems → listItem refuses ITEM_NOT_LISTABLE`, async () => {
      const wallet = await buyer(BigInt(ITEMS[itemId as keyof typeof ITEMS].costKeep));
      const bought = await withClientCurrency('GEMS', () => buyItem(db, wallet, itemId, k()));
      expect(bought).toMatchObject({ itemId, currency: 'GEMS', duplicate: false });
      expect(await provenance(wallet, itemId)).toBe('shop_gems');
      await expect(listItem(db, wallet, itemId, price, k()))
        .rejects.toMatchObject({ statusCode: 422, code: 'ITEM_NOT_LISTABLE' });
      // Nothing left the inventory.
      const [row] = await db.select({ qty: playerItems.qty }).from(playerItems)
        .where(and(eq(playerItems.playerWallet, wallet), eq(playerItems.itemId, itemId)));
      expect(row!.qty).toBe(1);
    });
  }

  it('a KEEP top-up onto a Gems-bought stack keeps the whole stack bound', async () => {
    const itemId = SOLD_FOR_A_PRICE.find((id) => ITEMS[id as keyof typeof ITEMS].maxOwned === null)!;
    const cost = BigInt(ITEMS[itemId as keyof typeof ITEMS].costKeep);
    const wallet = await buyer(cost, cost);
    await withClientCurrency('GEMS', () => buyItem(db, wallet, itemId, k()));
    const second = await buyItem(db, wallet, itemId, k()); // legacy client: KEEP
    expect(second).toMatchObject({ currency: 'KEEP' });
    expect(await provenance(wallet, itemId)).toBe('shop_gems');
    await expect(listItem(db, wallet, itemId, price, k())).rejects.toMatchObject({ code: 'ITEM_NOT_LISTABLE' });
  });

  it('a KEEP-bought copy (shop_keep) and a legacy row still list', async () => {
    const itemId = SOLD_FOR_A_PRICE.find((id) => ITEMS[id as keyof typeof ITEMS].maxOwned === null)!;
    const cost = BigInt(ITEMS[itemId as keyof typeof ITEMS].costKeep);
    const keepBuyer = await buyer(0n, cost);
    const bought = await buyItem(db, keepBuyer, itemId, k());
    expect(bought).toMatchObject({ currency: 'KEEP' });
    expect(await provenance(keepBuyer, itemId)).toBe('shop_keep');
    await expect(listItem(db, keepBuyer, itemId, price, k())).resolves.toMatchObject({ itemId });

    const { wallet: legacy } = await createTestPlayer(db);
    await db.insert(playerItems).values({ playerWallet: legacy, itemId, qty: 1 }); // acquired_via defaults to 'legacy'
    expect(await provenance(legacy, itemId)).toBe('legacy');
    await expect(listItem(db, legacy, itemId, price, k())).resolves.toMatchObject({ itemId });
  });
});
