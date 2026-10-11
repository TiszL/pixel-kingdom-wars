/**
 * Authoritative Metaplex Core ownership read for gameplay-sensitive deed
 * selection/transfer. Unlike DAS, this reads the finalized asset account itself.
 */
import {
  collectionAddress,
  deserializeAssetV1,
  deserializeCollectionV1,
  deriveAssetPlugins,
  isFrozen,
  MPL_CORE_PROGRAM_ID,
  type AssetV1,
  type CollectionV1,
} from '@metaplex-foundation/mpl-core';
import { createAmount, publicKey as toUmiPk, type RpcAccount } from '@metaplex-foundation/umi';
import { Connection, PublicKey } from '@solana/web3.js';
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import type { AssetOwnership } from './das';

const UNKNOWN_TRANSFER_DELEGATE = 'core-transfer-delegate-present';

export interface FinalizedAssetOwnership extends AssetOwnership {
  /** Finalized RPC context that bounds every account used for this evidence. */
  slot: number;
}

export interface FinalizedAssetOwnershipRequest {
  assetId: string;
  minContextSlot?: number | undefined;
}

/** One transport response and its bank context. `transportSucceeded` means the
 * transport AND canonical collection authority validated. It remains true when
 * individual deed accounts are absent/malformed, but false for any wave-wide
 * collection failure. `contextSlot` is retained on the latter for diagnostics. */
export interface FinalizedAssetOwnershipBatch {
  owners: Map<string, FinalizedAssetOwnership | null>;
  contextSlot: number | null;
  transportSucceeded: boolean;
}

async function bounded<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(
      () => controller.abort(new Error('finalized Core ownership read timed out')),
      BASE_OWNERSHIP.observationReadTimeoutMs,
    );
    return await run(controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Convert already-deserialized finalized accounts into the one ownership shape
 * consumed by the transfer/activation policy. Any transient TransferDelegate is
 * surfaced as delegated even when its authority has no address, so callers fail
 * closed rather than treating a marketplace-controlled asset as a plain wallet
 * holding. PermanentTransferDelegate is deliberately not that listing signal. */
export function coreOwnershipFromAccounts(
  asset: AssetV1,
  collection?: CollectionV1,
): AssetOwnership {
  const plugins = deriveAssetPlugins(asset, collection);
  const transfer = plugins.transferDelegate;
  return {
    owner: asset.owner.toString(),
    frozen: isFrozen(asset, collection),
    delegate: transfer
      ? transfer.authority.address?.toString() ?? UNKNOWN_TRANSFER_DELEGATE
      : null,
    collection: collectionAddress(asset)?.toString() ?? null,
  };
}

function rpcAccount(publicKey: PublicKey, account: {
  executable: boolean;
  owner: PublicKey;
  lamports: number;
  data: Buffer;
}): RpcAccount {
  return {
    publicKey: toUmiPk(publicKey.toBase58()),
    executable: account.executable,
    owner: toUmiPk(account.owner.toBase58()),
    lamports: createAmount(account.lamports, 'SOL', 9),
    data: new Uint8Array(account.data),
  };
}

/**
 * Read one Core asset directly at FINALIZED commitment. Null means unknown or
 * ineligible-to-trust: missing/burned/malformed asset, collection mismatch,
 * missing referenced collection, RPC failure, or timeout. Gameplay callers must
 * interpret null as loss of mutation authority, never as continuing ownership.
 */
export async function getFinalizedCoreAssetOwner(opts: {
  rpcUrl: string;
  assetId: string;
  expectedCollection?: string | undefined;
  /** Reject a node response whose finalized context predates accepted evidence. */
  minContextSlot?: number | undefined;
}): Promise<FinalizedAssetOwnership | null> {
  if (opts.expectedCollection) {
    const result = await getFinalizedCoreAssetOwners({
      rpcUrl: opts.rpcUrl,
      assets: [{ assetId: opts.assetId, minContextSlot: opts.minContextSlot }],
      expectedCollection: opts.expectedCollection,
    });
    return result.get(opts.assetId) ?? null;
  }
  try {
    return await bounded(async (signal) => {
      // One abort signal covers the asset + collection pair. Promise.race alone
      // returned on timeout while leaving web3's socket alive; repeated sweeps
      // could then accumulate abandoned 32-wide batches behind a sick RPC.
      const connection = new Connection(opts.rpcUrl, {
        commitment: 'finalized',
        // web3 retries HTTP 429 responses five times by default, with its own
        // backoff outside our observer wave budget. One logical read must stay
        // one transport request so pacing and the AbortSignal remain real.
        disableRetryOnRateLimit: true,
        fetch: (input, init) => globalThis.fetch(input, { ...init, signal }),
      });
      const assetKey = new PublicKey(opts.assetId);
      const readOptions = {
        commitment: 'finalized' as const,
        ...(opts.minContextSlot === undefined ? {} : { minContextSlot: opts.minContextSlot }),
      };
      const assetResponse = await connection.getAccountInfoAndContext(assetKey, readOptions);
      if (!assetResponse.value) return null;
      // A discriminator-shaped byte string in an arbitrary Solana account is
      // not a Core asset. Deserializers establish data shape, not the owning
      // program, so prove the runtime account authority before trusting owner,
      // plugins, collection, or any mutation permission derived from them.
      if (assetResponse.value.owner.toBase58() !== MPL_CORE_PROGRAM_ID.toString()) return null;
      const asset = deserializeAssetV1(rpcAccount(assetKey, assetResponse.value));

      const collectionKey = collectionAddress(asset);
      const actualCollection = collectionKey?.toString() ?? null;
      if (opts.expectedCollection !== undefined && actualCollection !== opts.expectedCollection) return null;

      let collection: CollectionV1 | undefined;
      if (collectionKey) {
        const collectionWeb3Key = new PublicKey(collectionKey.toString());
        const collectionResponse = await connection.getAccountInfoAndContext(collectionWeb3Key, {
          commitment: 'finalized', minContextSlot: assetResponse.context.slot,
        });
        if (!collectionResponse.value || collectionResponse.context.slot < assetResponse.context.slot) return null;
        if (collectionResponse.value.owner.toBase58() !== MPL_CORE_PROGRAM_ID.toString()) return null;
        collection = deserializeCollectionV1(rpcAccount(collectionWeb3Key, collectionResponse.value));
      }
      // The collection response may be newer, but it cannot advance the slot at
      // which the owner account itself was observed. Reporting that later slot
      // would overstate the precision of the ownership evidence.
      return { ...coreOwnershipFromAccounts(asset, collection), slot: assetResponse.context.slot };
    });
  } catch {
    return null;
  }
}

/** One finalized transport request for an observer wave: up to 32 Core assets
 * plus their configured collection account at one shared context slot. A bad
 * asset fails only its own result; a bad collection or transport fails all. */
export async function getFinalizedCoreAssetOwners(opts: {
  rpcUrl: string;
  assets: readonly FinalizedAssetOwnershipRequest[];
  expectedCollection: string;
}): Promise<Map<string, FinalizedAssetOwnership | null>> {
  return (await getFinalizedCoreAssetOwnerBatch(opts)).owners;
}

export async function getFinalizedCoreAssetOwnerBatch(opts: {
  rpcUrl: string;
  assets: readonly FinalizedAssetOwnershipRequest[];
  expectedCollection: string;
}): Promise<FinalizedAssetOwnershipBatch> {
  const result = new Map<string, FinalizedAssetOwnership | null>(
    opts.assets.map(({ assetId }) => [assetId, null]),
  );
  if (opts.assets.length === 0) {
    return { owners: result, contextSlot: null, transportSucceeded: true };
  }
  if (opts.assets.length > BASE_OWNERSHIP.observationConcurrency) {
    throw new Error(`finalized Core ownership batch exceeds ${BASE_OWNERSHIP.observationConcurrency} assets`);
  }
  try {
    return await bounded(async (signal) => {
      const connection = new Connection(opts.rpcUrl, {
        commitment: 'finalized',
        disableRetryOnRateLimit: true,
        fetch: (input, init) => globalThis.fetch(input, { ...init, signal }),
      });
      const assetKeys = opts.assets.map(({ assetId }) => new PublicKey(assetId));
      const collectionKey = new PublicKey(opts.expectedCollection);
      const floors = opts.assets.flatMap(({ minContextSlot }) =>
        minContextSlot === undefined ? [] : [minContextSlot]);
      if (floors.some((slot) => !Number.isSafeInteger(slot) || slot < 0)) {
        return { owners: result, contextSlot: null, transportSucceeded: false };
      }
      const minContextSlot = floors.length > 0 ? Math.max(...floors) : undefined;
      const response = await connection.getMultipleAccountsInfoAndContext(
        [...assetKeys, collectionKey],
        { commitment: 'finalized', ...(minContextSlot === undefined ? {} : { minContextSlot }) },
      );
      const collectionAccount = response.value.at(-1) ?? null;
      if (!collectionAccount
        || collectionAccount.owner.toBase58() !== MPL_CORE_PROGRAM_ID.toString()) {
        return { owners: result, contextSlot: response.context.slot, transportSucceeded: false };
      }
      let collection: CollectionV1;
      try {
        collection = deserializeCollectionV1(rpcAccount(collectionKey, collectionAccount));
      } catch {
        return { owners: result, contextSlot: response.context.slot, transportSucceeded: false };
      }
      for (let i = 0; i < assetKeys.length; i++) {
        const account = response.value[i] ?? null;
        if (!account || account.owner.toBase58() !== MPL_CORE_PROGRAM_ID.toString()) continue;
        try {
          const asset = deserializeAssetV1(rpcAccount(assetKeys[i]!, account));
          if (collectionAddress(asset)?.toString() !== opts.expectedCollection) continue;
          result.set(opts.assets[i]!.assetId, {
            ...coreOwnershipFromAccounts(asset, collection), slot: response.context.slot,
          });
        } catch {
          // A malformed asset cannot erase valid neighbors from the same read.
        }
      }
      return { owners: result, contextSlot: response.context.slot, transportSucceeded: true };
    });
  } catch {
    return { owners: result, contextSlot: null, transportSucceeded: false };
  }
}
