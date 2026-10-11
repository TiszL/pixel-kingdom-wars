/** Derived solely from the audited immutable preservation archive. This is
 * presentation quarantine, never ownership, claim or retirement DB authority.
 * Keep protections active while compatible code is staged before DB import. */
import identities from './retiredDeedPreservation.v1.json';

if (identities.version !== 1 || !/^[a-f0-9]{64}$/.test(identities.manifestSha256)
  || identities.entries.length === 0
  || identities.entries.some(row => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.mintId)
    || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.walletAlias))
  || new Set(identities.entries.map(row => row.mintId)).size !== identities.entries.length
  || new Set(identities.entries.map(row => row.walletAlias)).size !== identities.entries.length) {
  throw new Error('Invalid audited retired-deed preservation identities');
}
export const RETIRED_ARCHIVE_MANIFEST_SHA256 = identities.manifestSha256;
export const PRESERVED_RETIRED_DEED_MINTS: readonly string[] = Object.freeze(identities.entries.map(row => row.mintId));
export const PRESERVED_RETIRED_DEED_WALLETS: readonly string[] = Object.freeze(identities.entries.map(row => row.walletAlias));
const byMint = new Map(identities.entries.map(row => [row.mintId, Object.freeze({ ...row })]));
const byWallet = new Map([...byMint.values()].map(row => [row.walletAlias, row]));
export const preservedRetiredDeedForMint = (mint: string) => byMint.get(mint) ?? null;
export const preservedRetiredDeedForWallet = (wallet: string) => byWallet.get(wallet) ?? null;
