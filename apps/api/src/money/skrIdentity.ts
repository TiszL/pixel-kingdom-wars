import type { ChainAddresses } from '@shardkeep/chain';
import { SKR_FAUCET } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';

export type SkrRegistry = Pick<ChainAddresses, 'cluster' | 'skrMint' | 'skrDecimals'>;
export interface SkrIdentity { mint: string; decimals: number }

/** Public registry only: no environment mint alias and no implicit mainnet fallback.
 * This is a pin, not on-chain evidence. Consumers must re-read the finalized mint. */
export function resolveSkrMint(addresses: SkrRegistry | null): SkrIdentity | null {
  if (!addresses) return null;
  const { skrMint: mint, skrDecimals: decimals } = addresses;
  if (mint === undefined && decimals === undefined) return null;
  if (typeof mint !== 'string' || !mint || !Number.isSafeInteger(decimals)
      || decimals! < 0 || decimals! > 19) throw new Error('invalid SKR registry pair');
  if (new PublicKey(mint).toBase58() !== mint) throw new Error('invalid SKR registry mint');
  if (addresses.cluster === 'devnet' && (SKR_FAUCET.devnet.refusedMints as readonly string[]).includes(mint)) {
    throw new Error('real SKR mint refused on devnet');
  }
  return { mint, decimals: decimals! };
}

/** Called before DB initialization; adding a registry pair cannot silently
 * redirect an existing auction consumer to a different denomination. */
export function assertSkrMintPinsAgree(addresses: SkrRegistry | null, config: {
  SOLANA_CLUSTER: ChainAddresses['cluster'];
  MINING_TAX_AUCTION_MINT?: string | undefined;
  SEEKER_REALM_SALE_AUCTION_MINT?: string | undefined;
}): void {
  if (addresses && addresses.cluster !== config.SOLANA_CLUSTER) throw new Error('SKR registry cluster mismatch');
  const identity = resolveSkrMint(addresses);
  if (!identity) return;
  for (const pin of [config.MINING_TAX_AUCTION_MINT, config.SEEKER_REALM_SALE_AUCTION_MINT]) {
    if (pin !== undefined && pin !== identity.mint) throw new Error('SKR auction mint pin disagrees with registry');
  }
}
