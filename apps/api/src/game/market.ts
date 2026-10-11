/**
 * Marketplace — Lane A (external NFT marketplaces, MARKETPLACE-ESCROW-SPEC §3).
 *
 * Zero on-chain program: tradable assets are Metaplex Core NFTs (Land Deeds now;
 * NFT cosmetics later) carrying a 5% royalty that Tensor / Magic Eden HONOUR by
 * choice (ruleSet None — not enforced on chain). This module is a READ-ONLY browse layer —
 * it lists the player's owned Core assets (via DAS, with a server-truth fallback)
 * and hands back external-marketplace deep-links. It NEVER influences gameplay:
 * attackability is server-truth and ignores deed/NFT state (INV-1).
 *
 * Degrades gracefully on devnet: no Helius key → no DAS discovery (we still show
 * the player's own deed from the DB); no deed collection created → collection
 * links are null. Deeds are soulbound until the liquidity thaw
 * (MARKETPLACE.tradingEnabled), so assets surface with a "not yet tradable" flag.
 */
import { getOwnedCoreAssets, type GameSolanaCluster } from '@shardkeep/chain';
import {
  MARKETPLACE,
  magicEdenCollectionUrl,
  magicEdenItemUrl,
  tensorCollectionUrl,
  tensorItemUrl,
} from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { players } from '../db/schema';

export interface MarketDeps {
  heliusApiKey?: string | undefined;
  deedCollection?: string | undefined;
  cluster?: GameSolanaCluster | undefined;
}

export interface MarketAsset {
  id: string;
  name: string;
  image: string | null;
  /** Soulbound / not-yet-tradable (deeds stay frozen until the liquidity thaw). */
  frozen: boolean;
  kind: 'deed' | 'cosmetic';
  links: { tensor: string; magicEden: string };
}

/** Collection-level view: the deed collection + external links + fee/gate state.
 *  `feeBps` here is the DEED ROYALTY (the client renders it as "% ROYALTY"), not
 *  the in-app item-market fee — those are separate knobs since the 2026-07-29
 *  review even though both currently read 500. */
export function getMarketCollection(deps: MarketDeps): {
  collection: string | null;
  feeBps: number;
  tradingEnabled: boolean;
  links: { tensor: string; magicEden: string } | null;
} {
  const collection = deps.deedCollection ?? null;
  return {
    collection,
    feeBps: MARKETPLACE.deedRoyaltyBps,
    tradingEnabled: MARKETPLACE.tradingEnabled,
    links: collection
      ? { tensor: tensorCollectionUrl(collection), magicEden: magicEdenCollectionUrl(collection) }
      : null,
  };
}

/**
 * The player's owned, tradable Core assets. Merges DAS discovery (rich: image +
 * real frozen state) with a server-truth fallback for the player's own deed, so
 * the deed always shows even when Helius isn't configured. Dedupes by asset id,
 * letting DAS win where both know an asset.
 */
export async function getMarketAssets(
  db: Db, deps: MarketDeps, wallet: string,
): Promise<{ assets: MarketAsset[]; dasConfigured: boolean; tradingEnabled: boolean }> {
  const [p] = await db.select({ deed: players.deedAssetId }).from(players).where(eq(players.wallet, wallet));
  const dasConfigured = !!deps.heliusApiKey;

  const discovered = await getOwnedCoreAssets({
    heliusApiKey: deps.heliusApiKey,
    owner: wallet,
    collection: deps.deedCollection,
    cluster: deps.cluster ?? 'devnet',
  });

  const byId = new Map<string, MarketAsset>();
  const add = (a: Omit<MarketAsset, 'links'>): void => {
    if (byId.has(a.id)) return;
    byId.set(a.id, { ...a, links: { tensor: tensorItemUrl(a.id), magicEden: magicEdenItemUrl(a.id) } });
  };

  // DAS-discovered first (richer), then the DB-known deed as a fallback.
  for (const a of discovered) {
    add({ id: a.id, name: a.name, image: a.image, frozen: a.frozen, kind: a.id === p?.deed ? 'deed' : 'cosmetic' });
  }
  if (p?.deed && !byId.has(p.deed)) {
    // Soulbound until the liquidity thaw — reflect that as frozen when trading is off.
    add({ id: p.deed, name: 'LAND DEED', image: null, frozen: !MARKETPLACE.tradingEnabled, kind: 'deed' });
  }

  return { assets: [...byId.values()], dasConfigured, tradingEnabled: MARKETPLACE.tradingEnabled };
}
