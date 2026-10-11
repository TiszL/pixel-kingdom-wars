/**
 * Item-market payment proof, shared by the API process (buyer-driven
 * /paid, /settle, cancel, takeover) and the worker reconciler (game/
 * itemMarketReconcile.ts). One construction site keeps both processes on the
 * same two-source, FINALIZED, strict-uncertainty rule: a settlement or a
 * release is only ever decided on proof that both independent RPCs agree on.
 */
import { verifySplitPayment, verifySplitPaymentCommit } from '@shardkeep/chain';
import { type Connection, PublicKey } from '@solana/web3.js';
import type { MarketPaymentCommitVerifier, MarketPaymentVerifier } from '../game/itemMarket';

/** Two independent RPCs must agree on the proof outcome; a disagreement is an
 * error (never "unpaid"), so a lagging or faulty provider cannot release or
 * reassign an item. */
export async function requireMatchingChainProof<T extends { txSignature: string }>(
  label: string,
  primary: () => Promise<T | null>,
  secondary: (() => Promise<T | null>) | null,
): Promise<T | null> {
  if (!secondary) return primary();
  const [a, b] = await Promise.all([primary(), secondary()]);
  if (a?.txSignature !== b?.txSignature) {
    throw new Error(
      `independent RPCs disagree for ${label}: ${a?.txSignature ?? 'not-seen'} != ${b?.txSignature ?? 'not-seen'}`,
    );
  }
  return a;
}

export function makeMarketPaymentVerifiers(
  primary: Connection, secondary: Connection | null,
): { verifyPayment: MarketPaymentVerifier; verifyPaymentCommit: MarketPaymentCommitVerifier } {
  const keys = (p: { reference: string; buyer: string; seller: string; feeTreasury: string }) => ({
    reference: new PublicKey(p.reference), buyer: new PublicKey(p.buyer),
    seller: new PublicKey(p.seller), feeTreasury: new PublicKey(p.feeTreasury),
  });
  return {
    // Exact confirmed proof before a submitted signature pins a reservation.
    verifyPaymentCommit: (p) => requireMatchingChainProof(
      `item-market payment ${p.paymentSignature}`,
      () => verifySplitPaymentCommit(primary, {
        ...keys(p), sellerLamports: p.sellerLamports, feeLamports: p.feeLamports,
        paymentSignature: p.paymentSignature,
      }),
      secondary ? () => verifySplitPaymentCommit(secondary, {
        ...keys(p), sellerLamports: p.sellerLamports, feeLamports: p.feeLamports,
        paymentSignature: p.paymentSignature,
      }) : null,
    ),
    // Finalized proof for settlement/release. strictUncertainty: a missing
    // transaction body or an exhausted reference scan throws instead of
    // reading as "unpaid".
    verifyPayment: (p) => requireMatchingChainProof(
      `item-market reference ${p.reference}`,
      () => verifySplitPayment(primary, {
        ...keys(p), sellerLamports: p.sellerLamports, feeLamports: p.feeLamports,
        paymentSignature: p.paymentSignature, notBefore: p.notBefore, strictUncertainty: true,
      }),
      secondary ? () => verifySplitPayment(secondary, {
        ...keys(p), sellerLamports: p.sellerLamports, feeLamports: p.feeLamports,
        paymentSignature: p.paymentSignature, notBefore: p.notBefore, strictUncertainty: true,
      }) : null,
    ),
  };
}
