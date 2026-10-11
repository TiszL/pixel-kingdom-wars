import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildMarketBuyTx } from '../chain';
import type { GameWallet } from '../../auth/useGameWallet';
import type { ReservationReceipt } from './journal';

export type PreparedMarketPayment = { transaction: Transaction; message: Uint8Array; networkFee: number };
/** The RPC methods here are all reads; preparation never opens a wallet. */
export async function prepareMarketPayment(quote: ReservationReceipt['quote'], connection: Pick<Connection, 'getLatestBlockhash' | 'getFeeForMessage' | 'getBalance'>): Promise<PreparedMarketPayment> {
  const transaction = buildMarketBuyTx({
    buyer: new PublicKey(quote.buyer), seller: new PublicKey(quote.seller), feeTreasury: new PublicKey(quote.feeTreasury),
    reference: new PublicKey(quote.reference), sellerLamports: BigInt(quote.sellerLamports), feeLamports: BigInt(quote.feeLamports),
  });
  transaction.feePayer = new PublicKey(quote.buyer);
  transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value;
  if (fee === null || !Number.isSafeInteger(fee) || fee < 0) throw new Error('The network fee is unavailable. Review the quote again.');
  const balance = await connection.getBalance(transaction.feePayer, 'confirmed');
  if (!Number.isSafeInteger(balance) || BigInt(balance) < BigInt(quote.priceLamports) + BigInt(fee)) throw new Error('Your wallet needs the full quoted SOL price plus the network fee.');
  return { transaction, message: new Uint8Array(transaction.serializeMessage()), networkFee: fee };
}
/** Both adapter and Privy sign-only results must match the approved bytes and
 * carry exactly the buyer's valid signature. Signed bytes are never journaled. */
export async function signMarketPayment(prepared: PreparedMarketPayment, buyer: string, wallet: GameWallet): Promise<{ wire: Uint8Array; signature: string }> {
  if (wallet.publicKey?.toBase58() !== buyer || !wallet.signTransaction) throw new Error('Connect the original buyer wallet with sign-only support.');
  // A wallet may mutate its input in place, so compare against the independent
  // message snapshot, not against the returned Transaction object itself.
  const signed = await wallet.signTransaction(prepared.transaction);
  const message = signed.serializeMessage();
  if (message.length !== prepared.message.length || message.some((byte, i) => byte !== prepared.message[i])
    || signed.feePayer?.toBase58() !== buyer || signed.signatures.length !== 1
    || signed.signatures[0]!.publicKey.toBase58() !== buyer || !signed.signatures[0]!.signature
    || !signed.verifySignatures()) throw new Error('The wallet returned a different or invalid payment. Keep the saved receipt for recovery.');
  return { wire: new Uint8Array(signed.serialize()), signature: bs58.encode(signed.signatures[0]!.signature!) };
}
/** No application retries. An exception is uncertain even if the RPC saw it. */
export async function broadcastMarketPayment(connection: Pick<Connection, 'sendRawTransaction'>, wire: Uint8Array, signature: string): Promise<void> {
  const sent = await connection.sendRawTransaction(wire, { maxRetries: 0, skipPreflight: false, preflightCommitment: 'confirmed' });
  if (sent !== signature) throw new Error('The RPC response did not match the saved signature. Check the original payment receipt.');
}
