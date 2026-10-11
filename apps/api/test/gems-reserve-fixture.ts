import { keepAta } from '@shardkeep/chain';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import devnet from '../../../infra/devnet.addresses.json';
import type { Db } from '../src/db/client';
import { assertEconomyChainIdentity, assertGemsReserveIdentity } from '../src/money/economyIdentity';
import { SPL_TOKEN_PROGRAM_ID, type FinalizedAccountReader } from '../src/money/reserves';

// Shared across DB suites: the real identity trigger must never be disabled to
// make a second suite silently choose another mint or reserve.
export const gemsTestIdentity = {
  cluster: 'devnet' as const, keepMint: devnet.keepMint,
  coreProgram: devnet.coreProgram, configPda: devnet.config,
};
export const gemsTestOwner = Keypair.fromSeed(new Uint8Array(32).fill(137)).publicKey;
export const gemsTestHot = Keypair.fromSeed(new Uint8Array(32).fill(138)).publicKey;
export const gemsTestMint = new PublicKey(devnet.keepMint);
export const gemsTestAta = keepAta(gemsTestOwner, gemsTestMint, true);
export const gemsTestConfig = { GEMS_RESERVE_OWNER: gemsTestOwner.toBase58(), HOT_WALLET_PUBKEY: gemsTestHot.toBase58() };
export function gemsReserveAccount(owner = gemsTestOwner, mint = gemsTestMint): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0); owner.toBuffer().copy(data, 32); data[108] = 1;
  return { data, owner: SPL_TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 };
}
export const gemsTestReader: FinalizedAccountReader = {
  getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value: gemsReserveAccount() }),
};
export async function bindGemsTestReserve(db: Db): Promise<void> {
  await assertEconomyChainIdentity(db, gemsTestIdentity, gemsTestIdentity);
  await assertGemsReserveIdentity(db, gemsTestConfig, gemsTestIdentity, [gemsTestReader]);
}
