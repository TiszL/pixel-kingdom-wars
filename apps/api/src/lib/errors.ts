/** An error that is safe to show to clients verbatim. Everything else → 500.
 *  `code` is an OPTIONAL machine-readable reason (e.g. 'ALPHA_GATED') for the
 *  cases where the client must branch on WHY — string-matching a human message
 *  is the alternative, and messages get reworded. */
export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code?: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Stringify an error for DB persistence (outbox.lastError, withdrawals.lastError)
 * with RPC credentials stripped: web3.js failures embed the full endpoint URL,
 * and paid providers carry the API key in its path or query (Helius `?api-key=`,
 * QuickNode path token). Persisting that would park a live secret in a table
 * ops reads over the shoulder of. Host is kept — it's the useful triage bit.
 */
export function errorForStorage(e: unknown, max = 500): string {
  return String(e)
    // basic-auth userinfo first (user:pass@host — web3.js Connection accepts it),
    // so the host-capture below can't swallow the credential into group 1
    .replace(/(https?:\/\/)[^/\s"')@]*@/g, '$1')
    // then everything after the host: Helius ?api-key=, QuickNode path tokens
    .replace(/(https?:\/\/[^/\s"')]+)[^\s"')]*/g, '$1')
    .slice(0, max);
}
