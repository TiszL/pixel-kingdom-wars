/**
 * KEEP deposit verification (owner 2026-07-19) — the inbound mirror of
 * hotWallet.ts (payouts). A player sends KEEP (a plain SPL transfer) to the
 * custodial hot wallet's KEEP ATA, tagging the tx with the server-minted
 * `reference` pubkey (Solana Pay convention: an extra read-only account the SPL
 * Token program ignores but `getSignaturesForAddress` can find). This module
 * finds that finalized tx and reports the OBSERVED amount from the hot wallet's
 * token-balance delta — the credit is therefore always backed by KEEP actually
 * in custody, never a client-claimed number.
 */
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { Connection, PublicKey } from '@solana/web3.js';

const SIGNATURE_PAGE_SIZE = 16;
const SIGNATURE_SCAN_CAP = 256;

/** Missing finalized transaction data is uncertainty, never proof of nonpayment.
 * Settlement may keep waiting; cancellation/replacement must remain fenced. */
export class PaymentProofUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProofUnavailableError';
  }
}

export class ReferenceSignatureScanIndeterminateError extends Error {
  constructor(reference: string) {
    super(`finalized signature scan cap exhausted for ${reference}`);
    this.name = 'ReferenceSignatureScanIndeterminateError';
  }
}

export type FinalizedReferenceTransaction = NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>;

const base58Encoder = getBase58Encoder();
const base58Decoder = getBase58Decoder();

/** Solana transaction signatures are canonically encoded 64-byte values. This
 * guard belongs at the server edge too, but keeping it beside the direct RPC
 * verifier ensures a malformed value can never become a trusted commitment. */
export function isCanonicalSolanaSignature(signature: string): boolean {
  try {
    const bytes = base58Encoder.encode(signature);
    return bytes.length === 64 && base58Decoder.decode(bytes) === signature;
  } catch {
    return false;
  }
}

/** Bounded, newest-first finalized history for one public reference. Crossing
 * the intent/reservation creation second proves older signatures are unrelated;
 * exhausting the cap proves nothing and therefore throws. */
export async function* finalizedReferenceTransactions(
  connection: Connection, reference: PublicKey, notBefore?: Date, strictUncertainty = false,
): AsyncGenerator<{ signature: string; tx: FinalizedReferenceTransaction }> {
  let before: string | undefined;
  let scanned = 0;
  let complete = false;
  let unavailable = false;
  const notBeforeSecond = notBefore ? Math.floor(notBefore.getTime() / 1_000) : undefined;
  while (scanned < SIGNATURE_SCAN_CAP) {
    const limit = Math.min(SIGNATURE_PAGE_SIZE, SIGNATURE_SCAN_CAP - scanned);
    const sigs = await connection.getSignaturesForAddress(
      reference, { limit, ...(before ? { before } : {}) }, 'finalized',
    );
    if (sigs.length === 0) { complete = true; break; }
    let crossedStart = false;
    for (const sig of sigs) {
      scanned++;
      if (notBeforeSecond !== undefined && sig.blockTime !== null
        && sig.blockTime !== undefined && sig.blockTime < notBeforeSecond) {
        crossedStart = true;
        break;
      }
      if (sig.err) continue;
      const tx = await connection.getTransaction(sig.signature, {
        commitment: 'finalized', maxSupportedTransactionVersion: 0,
      });
      // An available later candidate may positively prove the original payment.
      // Missing earlier bodies must block a negative conclusion, not that proof.
      if (strictUncertainty && (!tx || !tx.meta)) { unavailable = true; continue; }
      if (tx && !tx.meta?.err) yield { signature: sig.signature, tx };
    }
    if (crossedStart || sigs.length < limit) { complete = true; break; }
    const nextBefore = sigs.at(-1)!.signature;
    if (nextBefore === before) break;
    before = nextBefore;
  }
  if (!complete) throw new ReferenceSignatureScanIndeterminateError(reference.toBase58());
  if (unavailable) throw new PaymentProofUnavailableError('finalized reference transaction body is unavailable');
}

/** The KEEP associated token account for an owner (deposit source / destination). */
export function keepAta(owner: PublicKey, keepMint: PublicKey, allowOwnerOffCurve = false): PublicKey {
  return getAssociatedTokenAddressSync(keepMint, owner, allowOwnerOffCurve);
}

interface KeepDepositParams {
  reference: PublicKey;
  keepMint: PublicKey;
  /** The EXACT token account the transfer must land in: the custody hot
   * wallet's KEEP ATA for `keep_deposit`, the emission-reserve ATA for
   * `gems_buy` (E2-GEMS-CONTRACT §2). Callers derive it (`keepAta`); the
   * verifier never derives an owner-based ATA itself. */
  destination: PublicKey;
  expectedSigner: PublicKey;
}

function keepDepositAmount(
  tx: FinalizedReferenceTransaction, params: KeepDepositParams,
): bigint | null {
  // Lookup-table aware (refuter R9): a v0 transaction may carry the destination
  // ATA (or the reference) in an address lookup table, where it lives in
  // `meta.loadedAddresses`, not in the static keys. `transactionAccountKeys`
  // appends writable then readonly loaded keys — the same order the RPC uses
  // for `accountIndex` in pre/postTokenBalances, so index matching stays exact.
  const keys = transactionAccountKeys(tx);
  if (!keys.some((key) => key.toBase58() === params.reference.toBase58())) return null;
  if (keys[0]?.toBase58() !== params.expectedSigner.toBase58()) return null;
  const destination = params.destination.toBase58();
  const ataIdx = keys.findIndex((key) => key.toBase58() === destination);
  if (ataIdx < 0) return null;
  const mint = params.keepMint.toBase58();
  const pre = tx.meta?.preTokenBalances?.find((b) => b.accountIndex === ataIdx && b.mint === mint);
  const post = tx.meta?.postTokenBalances?.find((b) => b.accountIndex === ataIdx && b.mint === mint);
  const delta = BigInt(post?.uiTokenAmount.amount ?? '0') - BigInt(pre?.uiTokenAmount.amount ?? '0');
  return delta > 0n ? delta : null;
}

/**
 * Verify a KEEP transfer against a reference key. Accepts the tx only if it
 * finalized successfully, INCREASED the explicit `destination` token account
 * (that raw base-unit delta IS the reported amount — the caller floors it to
 * whole KEEP, so custody/reserve always backs the credit and dust is never
 * rounded up), and was fee-paid/signed by the deposit intent's wallet (binds
 * the credit to the depositor). Returns the signature + base-unit amount, or
 * null if no matching finalized tx exists yet.
 */
export async function verifyKeepDeposit(
  connection: Connection,
  params: {
    reference: PublicKey; keepMint: PublicKey; destination: PublicKey; expectedSigner: PublicKey;
    notBefore?: Date | undefined;
    paymentSignature?: string | undefined;
    /** Missing successful reference bodies must not authorize expiry. */
    strictUncertainty?: boolean | undefined;
  },
): Promise<{ txSignature: string; amountBaseUnits: bigint } | null> {
  // The EXACT canonical destination ATA (not merely "any token account owned by
  // the hot wallet / reserve"). Binding to owner+mint would let a deposit into a
  // permissionless auxiliary owner-held token account credit off-reserve,
  // desyncing PoR/payout from the tracked ATA (security review 2026-07-19). We
  // match by account index.
  const candidates = finalizedPaymentTransactions(
    connection, params.reference, params.notBefore, params.paymentSignature, params.strictUncertainty,
  );
  for await (const { signature, tx } of candidates) {
    const delta = keepDepositAmount(tx, params);
    if (delta !== null) return { txSignature: signature, amountBaseUnits: delta };
  }
  return null;
}

/** Exact confirmed custody proof used before persisting a client-submitted
 * signature. It never searches the public reference history. */
export async function verifyKeepDepositCommit(
  connection: Connection, params: KeepDepositParams & { paymentSignature: string },
): Promise<{ txSignature: string; amountBaseUnits: bigint } | null> {
  if (!isCanonicalSolanaSignature(params.paymentSignature)) return null;
  const tx = await connection.getTransaction(params.paymentSignature, {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return null;
  const amountBaseUnits = keepDepositAmount(tx, params);
  return amountBaseUnits === null ? null : { txSignature: params.paymentSignature, amountBaseUnits };
}

interface SolPaymentParams {
  reference: PublicKey;
  destination: PublicKey;
  expectedSigner: PublicKey;
  expectedLamports?: bigint | undefined;
}

function solPaymentAmount(tx: FinalizedReferenceTransaction, params: SolPaymentParams): bigint | null {
  const msg = tx.transaction.message as unknown as {
    staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[];
  };
  const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  if (!keys.some((key) => key.toBase58() === params.reference.toBase58())) return null;
  if (keys[0]?.toBase58() !== params.expectedSigner.toBase58()) return null;
  const destIdx = keys.findIndex((key) => key.toBase58() === params.destination.toBase58());
  if (destIdx < 0) return null;
  const delta = BigInt(tx.meta?.postBalances?.[destIdx] ?? 0) - BigInt(tx.meta?.preBalances?.[destIdx] ?? 0);
  if (delta <= 0n || (params.expectedLamports !== undefined && delta !== params.expectedLamports)) return null;
  return delta;
}

/**
 * Verify a NATIVE SOL payment to a specific `destination` wallet, reference-tagged
 * (owner 2026-07-19 — for mine-build SOL that must go 100% to the liquidity pool,
 * NOT the 40/35/25 buy_sink split). Finds the finalized tx by reference, confirms
 * the depositor signed/fee-paid it, and reports the destination's SOL balance
 * INCREASE (that lamport delta is what actually landed in the liquidity wallet,
 * so the credit/grant is backed). Returns the signature + lamports, or null.
 */
export async function verifySolPayment(
  connection: Connection,
  params: {
    reference: PublicKey;
    destination: PublicKey;
    expectedSigner: PublicKey;
    /** Frozen server quote. When the same reference has multiple finalized
     * attempts, the exact payment must win over an earlier/later wrong amount. */
    expectedLamports?: bigint | undefined;
    /** Intent creation bounds the backwards scan. */
    notBefore?: Date | undefined;
    paymentSignature?: string | undefined;
  },
): Promise<{ txSignature: string; lamports: bigint } | null> {
  const candidates: Array<{ txSignature: string; lamports: bigint }> = [];
  for await (const { signature, tx } of finalizedPaymentTransactions(
    connection, params.reference, params.notBefore, params.paymentSignature,
  )) {
    const delta = solPaymentAmount(tx, { ...params, expectedLamports: undefined });
    if (delta !== null) {
      const candidate = { txSignature: signature, lamports: delta };
      if (params.expectedLamports === undefined || delta === params.expectedLamports) return candidate;
      candidates.push(candidate);
    }
  }
  return selectSolPaymentCandidate(candidates, params.expectedLamports);
}

/** Exact confirmed direct-SOL proof used before persisting a submitted
 * signature. The destination delta must equal the frozen quote. */
export async function verifySolPaymentCommit(
  connection: Connection, params: SolPaymentParams & { paymentSignature: string },
): Promise<{ txSignature: string; lamports: bigint } | null> {
  if (!isCanonicalSolanaSignature(params.paymentSignature)) return null;
  const tx = await connection.getTransaction(params.paymentSignature, {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return null;
  const lamports = solPaymentAmount(tx, params);
  return lamports === null ? null : { txSignature: params.paymentSignature, lamports };
}

/** Exact submitted signature first, then the bounded public-reference history.
 * A third party can spam a public reference but cannot hide a wallet-authenticated
 * signature. An unfinalized/wrong submitted tx does not disable the fallback. */
export async function* finalizedPaymentTransactions(
  connection: Connection, reference: PublicKey, notBefore?: Date, paymentSignature?: string,
  strictUncertainty = false,
): AsyncGenerator<{ signature: string; tx: FinalizedReferenceTransaction }> {
  if (paymentSignature && isCanonicalSolanaSignature(paymentSignature)) {
    const exact = await connection.getTransaction(paymentSignature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 0,
    });
    if (exact && !exact.meta?.err) yield { signature: paymentSignature, tx: exact };
  }
  for await (const candidate of finalizedReferenceTransactions(connection, reference, notBefore, strictUncertainty)) {
    if (candidate.signature !== paymentSignature) yield candidate;
  }
}

/** Keep the RPC's newest-first fallback for auditability when every attempt is
 * wrong, but never let a wrong retry shadow an exact frozen-quote payment. */
export function selectSolPaymentCandidate<T extends { lamports: bigint }>(
  candidates: readonly T[], expectedLamports?: bigint,
): T | null {
  if (expectedLamports !== undefined) {
    const exact = candidates.find((candidate) => candidate.lamports === expectedLamports);
    if (exact) return exact;
  }
  return candidates[0] ?? null;
}

/**
 * Verify a MARKETPLACE split payment (Lane B, item market): one buyer-signed,
 * reference-tagged, finalized tx that delivered ≥ `sellerLamports` to the seller
 * AND ≥ `feeLamports` to the fee treasury. Both legs are required, so the 5% fee
 * can't be skipped (a payment missing either leg never verifies → no item). The
 * buyer is the fee payer, so we read the SELLER's and TREASURY's positive
 * balance deltas (neither pays the network fee, so their deltas are exact).
 */
interface SplitPaymentParams {
  reference: PublicKey;
  buyer: PublicKey;
  seller: PublicKey;
  feeTreasury: PublicKey;
  sellerLamports: bigint;
  feeLamports: bigint;
}

function transactionAccountKeys(tx: FinalizedReferenceTransaction): PublicKey[] {
  const msg = tx.transaction.message as unknown as {
    staticAccountKeys?: PublicKey[];
    accountKeys?: PublicKey[];
  };
  const staticKeys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses;
  return loaded
    ? [...staticKeys, ...loaded.writable, ...loaded.readonly]
    : staticKeys;
}

function matchesSplitPayment(tx: FinalizedReferenceTransaction, params: SplitPaymentParams): boolean {
  const buyer = params.buyer.toBase58();
  const seller = params.seller.toBase58();
  const treasury = params.feeTreasury.toBase58();
  // Structural guard (security review 2026-07-24 #7): distinct parties, else one
  // transfer's delta could satisfy two checks. Not reachable today (parties are
  // authenticated players vs. a server-configured treasury) but made explicit.
  if (seller === treasury || buyer === seller || buyer === treasury) return false;

  const msg = tx.transaction.message as unknown as {
    header?: { numRequiredSignatures?: number };
  };
  const keys = transactionAccountKeys(tx);
  // Account zero is the fee payer and is necessarily one of the message's
  // required signers. Check both facts explicitly: a read-only buyer account
  // elsewhere in the transaction is not payment authority.
  if ((msg.header?.numRequiredSignatures ?? 0) < 1 || keys[0]?.toBase58() !== buyer) return false;
  if (!keys.some((key) => key.toBase58() === params.reference.toBase58())) return false;

  const deltaOf = (addr: string): bigint => {
    const i = keys.findIndex((key) => key.toBase58() === addr);
    if (i < 0) return 0n;
    return BigInt(tx.meta?.postBalances?.[i] ?? 0) - BigInt(tx.meta?.preBalances?.[i] ?? 0);
  };
  // The frozen quote is exact. An over/underpayment or a transaction that nets
  // unrelated transfers into either party cannot commit a different listing.
  return deltaOf(seller) === params.sellerLamports && deltaOf(treasury) === params.feeLamports;
}

async function verifyExactSplitPayment(
  connection: Connection,
  params: SplitPaymentParams & { paymentSignature: string },
  commitment: 'confirmed' | 'finalized',
  strictUncertainty = false,
): Promise<{ txSignature: string } | null> {
  if (!isCanonicalSolanaSignature(params.paymentSignature)) return null;
  const exact = await connection.getTransaction(params.paymentSignature, {
    commitment, maxSupportedTransactionVersion: 0,
  });
  if (strictUncertainty && (!exact || !exact.meta)) throw new PaymentProofUnavailableError('marketplace signature proof is unavailable');
  return exact && !exact.meta?.err && matchesSplitPayment(exact, params)
    ? { txSignature: params.paymentSignature }
    : null;
}

/** Direct confirmation used only by POST /paid before `payment_sig` extends a
 * reservation. It proves the exact submitted signature; unlike settlement it
 * never searches public reference history and does not claim finality. */
export async function verifySplitPaymentCommit(
  connection: Connection,
  params: SplitPaymentParams & { paymentSignature: string },
): Promise<{ txSignature: string } | null> {
  return verifyExactSplitPayment(connection, params, 'confirmed');
}

export async function verifySplitPayment(
  connection: Connection,
  params: SplitPaymentParams & {
    /** Buyer-committed broadcast signature. Verify this directly before the
     * public reference history, which may be spammed by third parties. */
    paymentSignature?: string | undefined;
    /** Reservation creation bounds the paginated fallback. */
    notBefore?: Date | undefined;
    /** Marketplace replacement/cancellation cannot treat unavailable proof as unpaid. */
    strictUncertainty?: boolean | undefined;
  },
): Promise<{ txSignature: string } | null> {

  if (params.paymentSignature) {
    try {
      const exact = await verifyExactSplitPayment(
        connection, { ...params, paymentSignature: params.paymentSignature }, 'finalized', params.strictUncertainty,
      );
      if (exact) return exact;
    } catch (error) {
      if (params.strictUncertainty) throw error;
      // A malformed/unavailable committed signature cannot make the reservation
      // reclaimable. Fall back to the bounded reference scan below.
    }
  }

  for await (const { signature, tx } of finalizedReferenceTransactions(
    connection, params.reference, params.notBefore, params.strictUncertainty,
  )) {
    if (matchesSplitPayment(tx, params)) return { txSignature: signature };
  }
  return null;
}
