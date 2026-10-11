/**
 * Metaplex DAS reads (Marketplace Lane A) — the player's owned Core assets
 * (Land Deeds now; NFT cosmetics later), so the in-app Collection view can
 * list them and link out to Tensor / Magic Eden.
 *
 * DAS lives on an indexer (Helius). It is READ-ONLY and NON-authoritative:
 * gameplay never consults it (attackability is server-truth — see
 * MARKETPLACE-ESCROW-SPEC INV-1); this is a display-only convenience over the
 * chain. Degrades gracefully — no Helius key / no collection / a transport
 * error all return `[]`, never throw, so the marketplace UI stays up on devnet
 * where the deed collection isn't created and the free RPC has no DAS.
 */
import type { GameSolanaCluster } from './bootstrap';

export interface OwnedCoreAsset {
  /** Core asset address (the "mint" for URL building). */
  id: string;
  name: string;
  /** Off-chain image URI from the asset's metadata JSON (best-effort). */
  image: string | null;
  /** Collection this asset belongs to (grouping), or null. */
  collection: string | null;
  /** True when the asset is frozen (soulbound) — deeds are frozen until the
   *  liquidity-event thaw, so the UI shows a "not yet tradable" badge. */
  frozen: boolean;
}

interface DasAssetsResponse {
  result?: {
    items?: Array<{
      id: string;
      content?: { metadata?: { name?: string }; links?: { image?: string }; files?: Array<{ uri?: string; cdn_uri?: string }> };
      grouping?: Array<{ group_key?: string; group_value?: string }>;
      ownership?: { frozen?: boolean };
    }>;
  };
}

/** Helius DAS RPC URL for the selected economy cluster. */
function heliusDasUrl(apiKey: string, cluster: GameSolanaCluster): string {
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
  return `https://${subdomain}.helius-rpc.com/?api-key=${apiKey}`;
}

/** DAS page size. 1000 is the documented maximum for getAssetsByOwner /
 *  searchAssets; asking for less just costs more round trips. */
const DAS_PAGE_SIZE = 1000;
/** Pages to walk before giving up. 5000 assets is far past any real wallet, and
 *  the loop must terminate even if an indexer keeps handing back full pages. */
const DAS_MAX_PAGES = 5;
/** Per-call bound. DAS is a third party read inside a request. */
const DAS_TIMEOUT_MS = 8_000;

/**
 * Owned Core assets for `owner`, optionally filtered to one `collection`.
 * Returns `[]` (never throws) when DAS is unconfigured or on any error, so a
 * caller can always render — an empty list means "nothing to show", not a bug.
 *
 * PAGINATION IS LOAD-BEARING (2026-07-29 review, finding (b)). This used to ask
 * for page 1 / limit 100 and filter to the deed collection CLIENT-side, so a
 * wallet holding more than 100 assets could own a deed and be told it owned
 * none — and `ownedDeeds` (game/baseClaim.ts) is what decides whether a player
 * may claim their base. Now the collection filter is pushed SERVER-side via
 * `searchAssets` + `grouping`, so a page holds deeds rather than arbitrary
 * assets, and the pages are walked to the end.
 */
export async function getOwnedCoreAssets(opts: {
  heliusApiKey?: string | undefined;
  cluster?: GameSolanaCluster | undefined;
  owner: string;
  collection?: string | undefined;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}): Promise<OwnedCoreAsset[]> {
  const { heliusApiKey, owner, collection } = opts;
  const cluster = opts.cluster ?? 'devnet';
  if (!heliusApiKey) return []; // DAS not configured → nothing to show, cleanly
  const doFetch = opts.fetchImpl ?? fetch;
  const out: OwnedCoreAsset[] = [];
  try {
    for (let page = 1; page <= DAS_MAX_PAGES; page += 1) {
      const res = await doFetch(heliusDasUrl(heliusApiKey, cluster), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'skp-market',
          // searchAssets is the only one that takes `grouping`, i.e. the only
          // way to make the indexer do the collection filtering for us.
          ...(collection
            ? {
              method: 'searchAssets',
              params: {
                ownerAddress: owner, grouping: ['collection', collection], burnt: false,
                page, limit: DAS_PAGE_SIZE, displayOptions: { showCollectionMetadata: false },
              },
            }
            : {
              method: 'getAssetsByOwner',
              params: {
                ownerAddress: owner, page, limit: DAS_PAGE_SIZE,
                displayOptions: { showCollectionMetadata: false },
              },
            }),
        }),
        signal: AbortSignal.timeout(DAS_TIMEOUT_MS),
      });
      if (!res.ok) return out;
      const json = (await res.json()) as DasAssetsResponse;
      const items = json.result?.items ?? [];
      for (const it of items) {
        const group = (it.grouping ?? []).find((g) => g.group_key === 'collection');
        const asset: OwnedCoreAsset = {
          id: it.id,
          name: it.content?.metadata?.name ?? 'Untitled',
          image: it.content?.links?.image ?? it.content?.files?.[0]?.cdn_uri ?? it.content?.files?.[0]?.uri ?? null,
          collection: group?.group_value ?? null,
          frozen: it.ownership?.frozen ?? false,
        };
        // Kept as a BELT-AND-BRACES check on top of the server-side grouping: a
        // deed read that trusts the indexer's filter blindly would let a
        // mis-tagged asset be treated as a deed.
        if (!collection || asset.collection === collection) out.push(asset);
      }
      if (items.length < DAS_PAGE_SIZE) break; // last page
    }
    return out;
  } catch {
    return out; // transport / parse error → whatever we have, never break the UI
  }
}

/** Full ownership shape for ONE Core asset (deed-transfer S1). The consumer
 *  must validate EVERY field before acting (security review 2026-07-27 #3):
 *  a marketplace-escrowed deed (frozen/delegated/PDA owner) must never move a
 *  base. Null on any failure or on burnt — "unknown" reads as "no change". */
export interface AssetOwnership {
  owner: string;
  frozen: boolean;
  delegate: string | null;
  collection: string | null;
}

export async function getAssetOwner(
  apiKey: string, assetId: string,
  fetchImpl: typeof fetch = fetch,
  cluster: GameSolanaCluster = 'devnet',
): Promise<AssetOwnership | null> {
  try {
    const res = await fetchImpl(heliusDasUrl(apiKey, cluster), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: assetId } }),
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      error?: unknown;
      result?: {
        ownership?: { owner?: string; frozen?: boolean; delegate?: string | null };
        grouping?: Array<{ group_key?: string; group_value?: string }>;
        burnt?: boolean;
      };
    };
    if (body.error || !body.result) return null; // JSON-RPC error at HTTP 200
    if (body.result.burnt) return null;          // a burnt deed transfers nothing
    const owner = body.result.ownership?.owner;
    if (typeof owner !== 'string' || owner.length === 0) return null;
    return {
      owner,
      frozen: body.result.ownership?.frozen ?? true, // unknown = assume frozen (fail closed)
      delegate: body.result.ownership?.delegate ?? null,
      collection: body.result.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? null,
    };
  } catch {
    return null;
  }
}
