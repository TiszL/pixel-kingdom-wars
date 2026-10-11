/**
 * Pixel Kingdom Gold (KEEP) branded mint — standalone devnet admin op (Phase 6).
 *
 * The original devnet mint (8u6x…) had its mint + freeze authorities revoked to
 * null, so Metaplex metadata can never attach to it — hence a FRESH mint. This
 * creates the new mint WITH branded metadata via Metaplex createFungible
 * (name/symbol/uri + decimals in one flow). Supply is minted separately with the
 * spl-token CLI (the umi mintV1 path is incompatible with this repo's umi 1.x),
 * so this returns the mint keypair for the caller to persist + fund.
 */
import { TOKEN } from '@shardkeep/shared';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createFungible, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata';
import { createSignerFromKeypair, generateSigner, keypairIdentity, percentAmount } from '@metaplex-foundation/umi';

export interface CreateBrandedMintOpts {
  rpcUrl: string;
  /** Admin secret key bytes (payer + mint/update authority). */
  adminSecret: Uint8Array;
  /** URI of the hosted off-chain metadata JSON (name/symbol/image → the coin logo). */
  metadataUri: string;
}

export interface CreateBrandedMintResult {
  mint: string;
  /** The new mint's 64-byte secret key — persist it (infra/keys) to keep control. */
  mintSecretKey: Uint8Array;
}

/** Create the branded KEEP mint + attach Metaplex metadata (no supply — mint that
 *  with `spl-token mint` using the admin as mint authority afterward). */
export async function createBrandedMint(opts: CreateBrandedMintOpts): Promise<CreateBrandedMintResult> {
  const umi = createUmi(opts.rpcUrl).use(mplTokenMetadata());
  const admin = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(opts.adminSecret));
  umi.use(keypairIdentity(admin));

  const mint = generateSigner(umi);
  await createFungible(umi, {
    mint,
    name: TOKEN.name,
    symbol: TOKEN.symbol,
    uri: opts.metadataUri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: TOKEN.decimals,
    isMutable: true,
  }).sendAndConfirm(umi);

  return { mint: mint.publicKey.toString(), mintSecretKey: mint.secretKey };
}
