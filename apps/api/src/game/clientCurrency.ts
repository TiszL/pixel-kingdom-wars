/**
 * Which in-game currency the CALLING CLIENT understands (D-152, GEMS-CURRENCY §6,
 * E2-GEMS-CONTRACT §3). A code-26+ client (or the Gems-aware web build) sends
 * `x-pkw-currency: GEMS` on every money POST; installed code 25 sends nothing.
 * The sink shim prefers that currency, then falls back to the other currency
 * for the whole price. New clients negotiate exactSpendCurrency, then freeze
 * one command with x-pkw-expected-currency; that command cannot fall back.
 *
 * Carried through the request's async chain with AsyncLocalStorage (entered in
 * an onRequest hook, apps/api/src/app.ts) so the twelve sink sites keep their
 * signatures. Recovery workers do not recharge journaled buffs: acceptance
 * already committed the original currency's ledger posting with the command.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError } from '../lib/errors';

export type ClientCurrency = 'GEMS' | 'KEEP';
export const CLIENT_CURRENCY_HEADER = 'x-pkw-currency';
export const EXPECTED_CURRENCY_HEADER = 'x-pkw-expected-currency';
export const GAME_CURRENCY_FEATURE = { version: 1, exactSpendCurrency: 1 } as const;
export interface ClientCurrencyContext {
  readonly currency: ClientCurrency | undefined;
  readonly expectedCurrency: ClientCurrency | undefined;
}

// An empty context means this request advertised neither preference nor exact consent.
const store = new AsyncLocalStorage<ClientCurrencyContext>();

export function parseClientCurrency(header: unknown): ClientCurrency | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  return upper === 'GEMS' || upper === 'KEEP' ? upper : undefined;
}

/** Exact consent is command-local and canonical. A duplicate must not become
 * first/last-wins when Node normalizes headers; inspect the original names too. */
export function parseExpectedCurrency(header: unknown, rawHeaders: readonly string[], method: string): ClientCurrency | undefined {
  const occurrences = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === EXPECTED_CURRENCY_HEADER).length;
  if (header === undefined && occurrences === 0) return undefined;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || occurrences > 1 || (header !== 'GEMS' && header !== 'KEEP')) {
    throw new HttpError(400, 'expected currency must be one canonical GEMS or KEEP command header', 'INVALID_CURRENCY_CONSENT');
  }
  return header;
}

/** Enter the request's currency context for the rest of its async chain.
 *  ALWAYS entered — a header-less (legacy) request must reset any store the
 *  surrounding async context carries (fastify.inject runs a request inside the
 *  caller's context, so an earlier GEMS request would otherwise bleed into it). */
export function enterClientCurrency(value: ClientCurrency | undefined, expectedCurrency?: ClientCurrency): void {
  store.enterWith(Object.freeze({ currency: value, expectedCurrency }));
}

/** Run `fn` under an explicit currency context (tests and workers). `undefined`
 *  runs it as a legacy client, isolated from whatever the caller's context holds. */
export function withClientCurrency<T>(value: ClientCurrency | undefined, fn: () => T): T {
  return withClientCurrencyContext({ currency: value, expectedCurrency: undefined }, fn);
}

export function withClientCurrencyContext<T>(context: ClientCurrencyContext, fn: () => T): T {
  return store.run(Object.freeze({ ...context }), fn);
}

export function clientCurrencyContext(): ClientCurrencyContext {
  return store.getStore() ?? { currency: undefined, expectedCurrency: undefined };
}

export function clientCurrency(): ClientCurrency | undefined {
  return store.getStore()?.currency;
}
