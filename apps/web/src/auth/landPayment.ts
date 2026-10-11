/** Build and price the reserved payment before handing control to a wallet.
 * The estimate is advisory; the program and deposit watcher remain authoritative. */
import type { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { buildBuySinkTx, buildPayEntryTx, playerPda } from '../lib/chain';
import type { LandReservation } from './useEntry';

// Anchor discriminator + Player fields in shardkeep-core/src/lib.rs (Borsh).
export const ENTRY_PLAYER_ACCOUNT_BYTES = 8 + 32 + 8 + 1 + 1 + 1;
export interface LandFundingEstimate {
  paymentLamports: number;
  networkFeeLamports: number;
  accountRentLamports: number;
  requiredLamports: number;
  balanceLamports: number;
}
type FundingConnection = Pick<Connection, 'getLatestBlockhash' | 'getBalance'
  | 'getAccountInfo' | 'getMinimumBalanceForRentExemption' | 'getFeeForMessage'>;

function lamports(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('SOL funding estimate unavailable');
  }
  return value;
}

export async function prepareLandPayment(
  connection: FundingConnection, wallet: PublicKey, reference: PublicKey,
  reservation: Pick<LandReservation, 'kind' | 'amountLamports'>,
): Promise<{ transaction: Transaction; estimate: LandFundingEstimate }> {
  const transaction = reservation.kind === 'entry'
    ? buildPayEntryTx(wallet, reference)
    : buildBuySinkTx(wallet, reference, 'deed', BigInt(reservation.amountLamports));
  const [blockhash, balance, accountRent] = await Promise.all([
    connection.getLatestBlockhash('confirmed'), connection.getBalance(wallet, 'confirmed'),
    reservation.kind === 'entry'
      ? connection.getAccountInfo(playerPda(wallet), 'confirmed').then((account) => account ? 0
        : connection.getMinimumBalanceForRentExemption(ENTRY_PLAYER_ACCOUNT_BYTES, 'confirmed'))
      : Promise.resolve(0),
  ]);
  transaction.feePayer = wallet;
  transaction.recentBlockhash = blockhash.blockhash;
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
  const paymentLamports = lamports(reservation.amountLamports);
  const networkFeeLamports = lamports(fee.value);
  const accountRentLamports = lamports(accountRent);
  return { transaction, estimate: {
    paymentLamports, networkFeeLamports, accountRentLamports,
    requiredLamports: lamports(paymentLamports + networkFeeLamports + accountRentLamports),
    balanceLamports: lamports(balance),
  } };
}
