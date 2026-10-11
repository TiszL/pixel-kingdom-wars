/**
 * Jupiter swap client (Phase 5, ONRAMP-WALLETS-PLAN §5.4/D2) — the TGE-time
 * bidirectional SOL/USDC ↔ KEEP path. Thin typed wrappers over Jupiter's public
 * quote/swap API: the USER signs the returned transaction (non-custodial — the
 * game never holds or converts user funds; that rule is what keeps the swap
 * outside exchange/MSB scope, §7).
 *
 * MAINNET-ONLY: Jupiter routes real liquidity; there is no devnet KEEP pool.
 * Callers gate on cluster === 'mainnet-beta' + a seeded pool (post-liquidity
 * event). Until then these helpers are wired but dormant.
 */

export const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
  /** Opaque — pass back verbatim to buildJupiterSwapTx. */
  [k: string]: unknown;
}

/** Fetch a swap quote (amounts in base units). `slippageBps` guards the fill. */
export async function fetchJupiterQuote(params: {
  inputMint: string; outputMint: string; amount: bigint; slippageBps: number;
}): Promise<JupiterQuote> {
  const q = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps),
  });
  const res = await fetch(`${JUPITER_QUOTE_API}/quote?${q}`);
  if (!res.ok) throw new Error(`jupiter quote failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<JupiterQuote>;
}

/** Build the swap transaction for a quote. Returns the base64 serialized tx the
 *  USER's wallet signs and sends (never a server key). Optional platform fee
 *  accrues to `feeAccount` (SWAP_REFERRAL_BPS revenue, plan §9). */
export async function buildJupiterSwapTx(params: {
  quote: JupiterQuote; userPublicKey: string; feeAccount?: string;
}): Promise<{ swapTransaction: string }> {
  const res = await fetch(`${JUPITER_QUOTE_API}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: params.quote,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      ...(params.feeAccount ? { feeAccount: params.feeAccount } : {}),
    }),
  });
  if (!res.ok) throw new Error(`jupiter swap build failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<{ swapTransaction: string }>;
}
