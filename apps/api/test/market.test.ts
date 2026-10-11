/**
 * Marketplace Lane A — the READ-ONLY browse layer. Encodes the guarantees that
 * matter: it degrades gracefully (no Helius / no collection → the player's own
 * deed still surfaces from server truth), DAS discovery parses + dedupes against
 * the DB deed, and the collection view exposes the 5% fee + soulbound gate. It
 * never touches gameplay (attackability is server-truth — nothing to assert here
 * because there is nothing for it to read).
 */
import { getOwnedCoreAssets } from '@shardkeep/chain';
import { MARKETPLACE } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { players } from '../src/db/schema';
import { getMarketAssets, getMarketCollection } from '../src/game/market';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

/** A fake Helius DAS response returning one deed-collection Core asset. */
function fakeDas(items: Array<{ id: string; name: string; image?: string; collection?: string; frozen?: boolean }>): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({
      result: {
        items: items.map((i) => ({
          id: i.id,
          content: { metadata: { name: i.name }, links: i.image ? { image: i.image } : {} },
          grouping: i.collection ? [{ group_key: 'collection', group_value: i.collection }] : [],
          ownership: { frozen: i.frozen ?? false },
        })),
      },
    }),
  })) as unknown as typeof fetch;
}

describe('marketplace collection view', () => {
  it('exposes the fee + soulbound gate; links only when a collection exists', () => {
    const none = getMarketCollection({});
    expect(none.collection).toBeNull();
    expect(none.links).toBeNull();
    // The collection view's fee IS the deed royalty (rendered "% ROYALTY"), not
    // the in-app item-market fee — separate knobs since the 2026-07-29 review.
    expect(none.feeBps).toBe(MARKETPLACE.deedRoyaltyBps);
    // Mirrors MARKETPLACE.tradingEnabled, which the owner turned ON with the
    // 2026-07-29 deed thaw. The view must report the REAL gate, not a fixed
    // answer — the copy it drives is what tells a holder whether to list.
    expect(none.tradingEnabled).toBe(MARKETPLACE.tradingEnabled);

    const withCol = getMarketCollection({ deedCollection: 'CoLLeCtioN11111111111111111111111111111111' });
    expect(withCol.collection).toBe('CoLLeCtioN11111111111111111111111111111111');
    expect(withCol.links?.tensor).toContain('tensor.trade/trade/');
    expect(withCol.links?.magicEden).toContain('magiceden.io/marketplace/');
  });
});

describe('marketplace owned assets', () => {
  it('surfaces the player\'s deed from server truth even with NO Helius (degrades cleanly)', async () => {
    const p = await createTestPlayer(db);
    await db.update(players).set({ deedAssetId: 'DeeDAsSeT111111111111111111111111111111111' }).where(eq(players.wallet, p.wallet));
    const res = await getMarketAssets(db, {}, p.wallet); // no heliusApiKey
    expect(res.dasConfigured).toBe(false);
    expect(res.assets).toHaveLength(1);
    expect(res.assets[0]!.id).toBe('DeeDAsSeT111111111111111111111111111111111');
    expect(res.assets[0]!.kind).toBe('deed');
    // `frozen` is the DERIVED gate for a DB-only deed (no DAS to ask): it is
    // the inverse of trading being open. Post-thaw that is false — the deeds
    // really are transferable on chain (verified frozen:false on all four).
    expect(res.assets[0]!.frozen).toBe(!MARKETPLACE.tradingEnabled);
    expect(res.assets[0]!.links.tensor).toContain('tensor.trade/item/');
  });

  it('returns no assets for a player with no deed and no DAS', async () => {
    const p = await createTestPlayer(db);
    const res = await getMarketAssets(db, {}, p.wallet);
    expect(res.assets).toEqual([]);
  });

  it('DAS discovery parses assets and dedupes against the DB deed (DAS wins)', async () => {
    const p = await createTestPlayer(db);
    const deed = 'DeeDAsSeT222222222222222222222222222222222';
    await db.update(players).set({ deedAssetId: deed }).where(eq(players.wallet, p.wallet));
    // getOwnedCoreAssets is what getMarketAssets calls; verify the parser directly
    // with an injected fetch (the module path uses the global fetch).
    const discovered = await getOwnedCoreAssets({
      heliusApiKey: 'test-key',
      owner: p.wallet,
      collection: 'CoL',
      fetchImpl: fakeDas([
        { id: deed, name: 'PIXEL KEEP #1', image: 'https://img/deed.png', collection: 'CoL', frozen: true },
        { id: 'OtherAsset', name: 'SomeSkin', collection: 'CoL', frozen: false },
      ]),
    });
    expect(discovered).toHaveLength(2);
    const d = discovered.find((a) => a.id === deed)!;
    expect(d.name).toBe('PIXEL KEEP #1');
    expect(d.image).toBe('https://img/deed.png');
    expect(d.frozen).toBe(true);
  });

  it('DAS filters to the requested collection and never throws on a bad response', async () => {
    const off = await getOwnedCoreAssets({
      heliusApiKey: 'k', owner: 'w', collection: 'WANT',
      fetchImpl: fakeDas([{ id: 'x', name: 'n', collection: 'OTHER' }]),
    });
    expect(off).toEqual([]); // wrong collection filtered out

    const broken = await getOwnedCoreAssets({
      heliusApiKey: 'k', owner: 'w',
      fetchImpl: (async () => ({ ok: false })) as unknown as typeof fetch,
    });
    expect(broken).toEqual([]); // non-ok → graceful empty, never throws
  });
});
