/**
 * Privy's Solana hook returns every connected Wallet Standard wallet. Address
 * equality alone therefore cannot distinguish a Privy embedded signer from an
 * external Phantom/Solflare wallet wrapped by Privy.
 */
export function findPrivyEmbeddedWallet<Wallet extends {
  address: string;
  standardWallet: unknown;
}>(wallets: readonly Wallet[], session: string | null | undefined): Wallet | undefined {
  if (!session) return undefined;
  return wallets.find((wallet) => wallet.address === session
    && (wallet.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet === true);
}

export function walletMatchesSession(
  publicKey: { toBase58: () => string } | null,
  session: string | null | undefined,
): boolean {
  return !!session && publicKey?.toBase58() === session;
}
