import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import type { GameWallet } from '../../auth/useGameWallet';
import { buildKeepDepositTx } from '../chain';
import { assertGemsBuyAdmissionFresh, gemsBuyAddress, gemsBuySignature, type GemsBuyAdmission } from './contracts';

export type GemsBuyPaymentConnection = Pick<Connection, 'getGenesisHash' | 'getLatestBlockhash' | 'getFeeForMessage'
  | 'getBalance' | 'getTokenAccountBalance' | 'getBlockHeight'>;
export type PreparedGemsBuyPayment = { readonly transaction: Transaction; readonly message: Uint8Array;
  readonly networkFee: number; readonly lastValidBlockHeight: number };
type PaymentProof = { admission: GemsBuyAdmission; genesis: string; message: Uint8Array; lastValidBlockHeight: number };
const preparedPayments = new WeakMap<PreparedGemsBuyPayment, PaymentProof>();
function sameMessage(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, index) => value === b[index]); }
function height(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

/** No wallet or broadcasts: one Classic SPL TransferChecked with the original reference. */
export async function prepareGemsBuyPayment(admission: GemsBuyAdmission, connection: GemsBuyPaymentConnection,
  expectedGenesis: string): Promise<PreparedGemsBuyPayment> {
  assertGemsBuyAdmissionFresh(admission);
  // The expected value comes from the selected public registry, never this endpoint.
  if (!expectedGenesis || await connection.getGenesisHash() !== expectedGenesis) throw new Error('The payment RPC serves a different Solana network.');
  const q = admission.quote, owner = new PublicKey(q.wallet), source = new PublicKey(q.source);
  const amountBaseUnits = BigInt(q.keepIn) * 10n ** BigInt(q.decimals);
  const transaction = buildKeepDepositTx({ owner, source, mint: new PublicKey(q.mint), destination: new PublicKey(q.destination),
    reference: new PublicKey(q.reference), amountBaseUnits, decimals: q.decimals });
  const latest = await connection.getLatestBlockhash('confirmed');
  gemsBuyAddress(latest.blockhash);
  if (!height(latest.lastValidBlockHeight)) throw new Error('The payment blockhash validity is unavailable.');
  transaction.feePayer = owner;
  transaction.recentBlockhash = latest.blockhash;
  const [fee, sol, token, currentHeight] = await Promise.all([
    connection.getFeeForMessage(transaction.compileMessage(), 'confirmed'), connection.getBalance(owner, 'confirmed'),
    connection.getTokenAccountBalance(source, 'confirmed'), connection.getBlockHeight('confirmed'),
  ]);
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) throw new Error('The network fee is unavailable. No transaction was signed.');
  if (!Number.isSafeInteger(sol) || sol < fee.value) throw new Error('The original wallet needs enough SOL for the network fee.');
  if (!token.value || token.value.decimals !== q.decimals || typeof token.value.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(token.value.amount)
    || token.value.amount.length > 20 || BigInt(token.value.amount) > 0xffff_ffff_ffff_ffffn
    || BigInt(token.value.amount) < amountBaseUnits) throw new Error('The original wallet needs the full quoted KEEP amount.');
  if (!height(currentHeight) || currentHeight > latest.lastValidBlockHeight) throw new Error('The payment blockhash has expired.');
  assertGemsBuyAdmissionFresh(admission);
  // A private independent copy prevents an in-place wallet mutation, or a caller
  // changing the public snapshot, from changing what counts as approved.
  const message = new Uint8Array(transaction.serializeMessage());
  const prepared = Object.freeze({ transaction, get message() { return new Uint8Array(message); },
    networkFee: fee.value, lastValidBlockHeight: latest.lastValidBlockHeight });
  preparedPayments.set(prepared, { admission, genesis: expectedGenesis, message, lastValidBlockHeight: latest.lastValidBlockHeight });
  return prepared;
}
/** Call after saving the signature and immediately before the controller's one broadcast. */
export async function assertGemsBuyPaymentLive(prepared: PreparedGemsBuyPayment,
  connection: Pick<Connection, 'getGenesisHash' | 'getBlockHeight'>): Promise<void> {
  const proof = preparedPayments.get(prepared);
  if (!proof) throw new Error('This payment has no original prepared quote.');
  assertGemsBuyAdmissionFresh(proof.admission);
  const [genesis, currentHeight] = await Promise.all([connection.getGenesisHash(), connection.getBlockHeight('confirmed')]);
  if (genesis !== proof.genesis) throw new Error('The payment RPC serves a different Solana network.');
  if (!height(currentHeight) || currentHeight > proof.lastValidBlockHeight) throw new Error('The payment blockhash has expired.');
  assertGemsBuyAdmissionFresh(proof.admission);
}
export async function signGemsBuyPayment(prepared: PreparedGemsBuyPayment, wallet: GameWallet): Promise<{ wire: Uint8Array; signature: string }> {
  const proof = preparedPayments.get(prepared);
  if (!proof) throw new Error('This payment has no original prepared quote.');
  assertGemsBuyAdmissionFresh(proof.admission);
  const owner = new PublicKey(proof.admission.quote.wallet);
  if (!wallet.publicKey?.equals(owner)) throw new Error('Connect the original purchase wallet before signing.');
  if (!wallet.signTransaction) throw new Error('This wallet does not support sign-only payments. No transaction was sent.');
  if (!sameMessage(proof.message, prepared.transaction.serializeMessage())) throw new Error('The prepared payment changed before wallet approval.');
  const signed = await wallet.signTransaction(prepared.transaction);
  if (!sameMessage(proof.message, signed.serializeMessage()) || !signed.feePayer?.equals(owner)
    || signed.signatures.length !== 1 || !signed.signatures[0]?.publicKey.equals(owner)
    || !signed.signatures[0].signature || !signed.verifySignatures()) throw new Error('The wallet returned a different or invalid payment. No transaction was sent.');
  // Do not throw because time/account changed while the wallet was open: the
  // caller must save this signature BEFORE its lifecycle and broadcast checks.
  return { wire: new Uint8Array(signed.serialize()), signature: bs58.encode(signed.signatures[0].signature) };
}
/** Caller owns the durable one-attempt marker; an uncertain send is never retried here. */
export async function broadcastGemsBuyPayment(connection: Pick<Connection, 'sendRawTransaction'>,
  wire: Uint8Array, signature: string): Promise<void> {
  gemsBuySignature(signature);
  const signed = Transaction.from(wire);
  if (signed.signatures.length !== 1 || !signed.signatures[0]?.signature || !signed.verifySignatures()
    || bs58.encode(signed.signatures[0].signature) !== signature) throw new Error('The saved payment signature does not match its wire bytes.');
  const sent = await connection.sendRawTransaction(wire, { maxRetries: 0, skipPreflight: false, preflightCommitment: 'confirmed' });
  if (sent !== signature) throw new Error('The RPC returned a different signature. Check the original saved payment.');
}
