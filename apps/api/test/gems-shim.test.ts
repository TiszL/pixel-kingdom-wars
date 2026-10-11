/**
 * The sink shim decision table (E2-GEMS-CONTRACT §3; D-152).
 *
 * WHY: installed code-25 clients show a consent dialog that names KEEP, while a
 * Gems-aware client names GEMS. The server must therefore charge the ONE
 * currency the calling client advertised whenever it covers the price, fall
 * back to the other currency for the WHOLE price (never a split — a split
 * would make both dialogs false), and name the client's preferred currency in
 * the typed shortfall so each client's funds sheet routes correctly. With the
 * flag off nothing may change (invariant G-7): the legacy KEEP leg posts
 * byte-for-byte as before.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ledgerTransactions } from '../src/db/schema';
import { parseExpectedCurrency, withClientCurrency, withClientCurrencyContext } from '../src/game/clientCurrency';
import { convertKeepToGems } from '../src/game/gems';
import { spendGameCurrency } from '../src/game/spend';
import { HttpError } from '../src/lib/errors';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const k = () => randomUUID();
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });
const prior = process.env['GEMS_ENABLED'];
beforeEach(() => { process.env['GEMS_ENABLED'] = 'true'; });
afterEach(() => { if (prior === undefined) delete process.env['GEMS_ENABLED']; else process.env['GEMS_ENABLED'] = prior; });

const keepOf = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;
const gemsOf = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_gems')).balance;
/** A wallet holding exactly `keep` custodial KEEP and `gems` Gems. */
async function wallet(keep: bigint, gems: bigint) {
  const { wallet } = await createTestPlayer(db);
  if (keep + gems > 0n) await fundTestKeep(db, wallet, keep + gems, 'test.fund', k());
  if (gems > 0n) await convertKeepToGems(db, wallet, gems, k());
  expect([await keepOf(wallet), await gemsOf(wallet)]).toEqual([keep, gems]);
  return wallet;
}
const metadataOf = async (key: string) => (await db.select({ metadata: ledgerTransactions.metadata })
  .from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key)))[0]!.metadata as Record<string, unknown>;

describe('GEMS_ENABLED=false (G-7: nothing changes)', () => {
  it('posts the legacy KEEP leg even when the client advertises GEMS', async () => {
    delete process.env['GEMS_ENABLED'];
    const w = await wallet(100n, 0n);
    const key = `shim:${w}:off`;
    const posted = await withClientCurrency('GEMS', () => spendGameCurrency(db, w, 40n, 'test.sink', key));
    expect(posted.currency).toBe('KEEP');
    expect(await keepOf(w)).toBe(60n);
    // Byte-identical to the pre-Gems posting: no `currency` stamp while the flag is off.
    expect(await metadataOf(key)).toMatchObject({ wallet: w, recycled: true });
    expect(await metadataOf(key)).not.toHaveProperty('currency');
  });
});

describe('GEMS_ENABLED=true — the §3 table', () => {
  it('GEMS client, Gems cover the price → Gems (KEEP untouched)', async () => {
    const w = await wallet(100n, 100n);
    const posted = await withClientCurrency('GEMS', () => spendGameCurrency(db, w, 60n, 'test.sink', `shim:${w}:1`));
    expect(posted.currency).toBe('GEMS');
    expect([await keepOf(w), await gemsOf(w)]).toEqual([100n, 40n]);
    expect(await metadataOf(`shim:${w}:1`)).toMatchObject({ wallet: w, currency: 'GEMS' });
    expect(await metadataOf(`shim:${w}:1`)).not.toHaveProperty('recycled');
  });
  it('GEMS client, Gems short, KEEP covers → the WHOLE price from KEEP (never split)', async () => {
    const w = await wallet(100n, 30n);
    const posted = await withClientCurrency('GEMS', () => spendGameCurrency(db, w, 60n, 'test.sink', `shim:${w}:2`));
    expect(posted.currency).toBe('KEEP');
    expect([await keepOf(w), await gemsOf(w)]).toEqual([40n, 30n]);
  });
  it('GEMS client, neither covers → 422 INSUFFICIENT_GEMS naming both balances', async () => {
    const w = await wallet(50n, 30n);
    const err = await withClientCurrency('GEMS', () => spendGameCurrency(db, w, 60n, 'test.sink', `shim:${w}:3`)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_GEMS', details: { costGems: '60', gemsBalance: '30', keepCustodial: '50' } });
    expect([await keepOf(w), await gemsOf(w)]).toEqual([50n, 30n]);
  });
  it('legacy client, KEEP covers → KEEP first (Gems untouched)', async () => {
    const w = await wallet(100n, 100n);
    const posted = await spendGameCurrency(db, w, 60n, 'test.sink', `shim:${w}:4`);
    expect(posted.currency).toBe('KEEP');
    expect([await keepOf(w), await gemsOf(w)]).toEqual([40n, 100n]);
  });
  it('legacy client, KEEP short, Gems cover → Gems', async () => {
    const w = await wallet(10n, 100n);
    const posted = await spendGameCurrency(db, w, 60n, 'test.sink', `shim:${w}:5`);
    expect(posted.currency).toBe('GEMS');
    expect([await keepOf(w), await gemsOf(w)]).toEqual([10n, 40n]);
  });
  it('legacy client, neither covers → 422 INSUFFICIENT_KEEP (today\'s code, so the funds sheet still routes)', async () => {
    const w = await wallet(10n, 20n);
    const err = await spendGameCurrency(db, w, 60n, 'test.sink', `shim:${w}:6`).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_KEEP' });
    expect([await keepOf(w), await gemsOf(w)]).toEqual([10n, 20n]);
  });
  it('an explicit currency option beats the request context (workers pass what the client consented to)', async () => {
    const w = await wallet(100n, 100n);
    const posted = await withClientCurrency('KEEP', () => spendGameCurrency(db, w, 5n, 'test.sink', `shim:${w}:7`, undefined, { currency: 'GEMS' }));
    expect(posted.currency).toBe('GEMS');
    expect([await keepOf(w), await gemsOf(w)]).toEqual([100n, 95n]);
  });
  it('a replayed key wins even when both balances have since dropped below the price (retry after a charge)', async () => {
    // WHY (security review 2026-09-20 #4): a client that lost the response
    // retries the same key; the charge already happened, so the retry must
    // resolve to the receipt, never to INSUFFICIENT_* — which every sink maps
    // to "buy more" and which would hide a completed purchase.
    const w = await wallet(60n, 60n);
    const key = `shim:${w}:9`;
    const first = await withClientCurrency('GEMS', () => spendGameCurrency(db, w, 60n, 'test.sink', key));
    expect(first.currency).toBe('GEMS');
    await spendGameCurrency(db, w, 60n, 'test.sink', `shim:${w}:9b`); // drains the KEEP too
    expect([await keepOf(w), await gemsOf(w)]).toEqual([0n, 0n]);
    const again = await withClientCurrency('GEMS', () => spendGameCurrency(db, w, 60n, 'test.sink', key));
    expect(again).toMatchObject({ duplicate: true, transaction: { id: first.transaction.id } });
    expect([await keepOf(w), await gemsOf(w)]).toEqual([0n, 0n]);
  });
  it('a replayed key returns the original posting in its original currency, whatever the context now says', async () => {
    const w = await wallet(100n, 100n);
    const key = `shim:${w}:8`;
    const first = await withClientCurrency('GEMS', () => spendGameCurrency(db, w, 9n, 'test.sink', key));
    const again = await spendGameCurrency(db, w, 9n, 'test.sink', key);
    expect(again).toMatchObject({ duplicate: true, transaction: { id: first.transaction.id } });
    expect(again.currency).toBe('GEMS'); // prove the original debit, not the attempted KEEP leg
    expect([await keepOf(w), await gemsOf(w)]).toEqual([100n, 91n]);
  });
});


const exact = <T>(expectedCurrency: 'GEMS' | 'KEEP', fn: () => T) =>
  withClientCurrencyContext({ currency: expectedCurrency === 'GEMS' ? 'KEEP' : 'GEMS', expectedCurrency }, fn);

describe('exact reviewed currency (K-155)', () => {
  it.each(['GEMS', 'KEEP'] as const)('%s consent overrides preference and refuses fallback without consuming the key', async (currency) => {
    const w = await wallet(currency === 'KEEP' ? 5n : 100n, currency === 'GEMS' ? 5n : 100n);
    const key = `exact:${w}:${k()}`;
    await expect(exact(currency, () => spendGameCurrency(db, w, 10n, 'test.sink', key))).rejects.toMatchObject({
      statusCode: 409, code: 'CURRENCY_CONSENT_CHANGED', details: { expectedCurrency: currency, cost: '10', reason: 'insufficient_balance' },
    });
    expect([await keepOf(w), await gemsOf(w)]).toEqual(currency === 'GEMS' ? [100n, 5n] : [5n, 100n]);
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key))).toHaveLength(0);
    const other = currency === 'GEMS' ? 'KEEP' : 'GEMS';
    expect((await exact(other, () => spendGameCurrency(db, w, 10n, 'test.sink', key))).currency).toBe(other);
  });

  it('Gems pause refuses only new Gems postings; old receipts survive changed consent, empty balances and pause', async () => {
    const w = await wallet(10n, 10n);
    const key = `exact:${w}:${k()}`;
    const first = await exact('GEMS', () => spendGameCurrency(db, w, 10n, 'test.sink', key));
    await exact('KEEP', () => spendGameCurrency(db, w, 10n, 'test.sink', k()));
    process.env['GEMS_ENABLED'] = 'false';
    for (const expected of ['GEMS', 'KEEP'] as const) {
      expect(await exact(expected, () => spendGameCurrency(db, w, 10n, 'test.sink', key)))
        .toMatchObject({ duplicate: true, currency: 'GEMS', transaction: { id: first.transaction.id } });
    }
    const fresh = k();
    await expect(exact('GEMS', () => spendGameCurrency(db, w, 10n, 'test.sink', fresh)))
      .rejects.toMatchObject({ code: 'CURRENCY_CONSENT_CHANGED', details: { reason: 'currency_unavailable' } });
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, fresh))).toHaveLength(0);
    await fundTestKeep(db, w, 10n, 'test.fund', k());
    expect((await exact('KEEP', () => spendGameCurrency(db, w, 10n, 'test.sink', fresh))).currency).toBe('KEEP');
  });

  it('concurrent opposite exact consents for one key return the single original debit currency', async () => {
    const w = await wallet(100n, 100n); const key = k();
    const results = await Promise.all((['GEMS', 'KEEP'] as const).map((c) =>
      exact(c, () => spendGameCurrency(db, w, 10n, 'test.sink', key))));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results[0]!.transaction.id).toBe(results[1]!.transaction.id);
    expect(results[0]!.currency).toBe(results[1]!.currency);
    expect([await keepOf(w), await gemsOf(w)]).toEqual(results[0]!.currency === 'GEMS' ? [100n, 90n] : [90n, 100n]);
  });

  it('a known key for a different wallet or sink cannot masquerade as this spend', async () => {
    const w = await wallet(100n, 100n); const other = await wallet(100n, 100n); const key = k();
    await exact('GEMS', () => spendGameCurrency(db, w, 10n, 'test.sink', key));
    await expect(exact('KEEP', () => spendGameCurrency(db, other, 10n, 'test.sink', key))).rejects.toThrow('does not prove');
    await expect(exact('KEEP', () => spendGameCurrency(db, w, 10n, 'other.sink', key))).rejects.toThrow('does not prove');
    expect([await keepOf(other), await gemsOf(other)]).toEqual([100n, 100n]);
  });

  it('only one canonical, command-local header is consent', () => {
    expect(parseExpectedCurrency(undefined, [], 'GET')).toBeUndefined();
    expect(parseExpectedCurrency('GEMS', ['X-Pkw-Expected-Currency', 'GEMS'], 'POST')).toBe('GEMS');
    for (const value of ['', 'gems', ' GEMS ', 'GEMS,KEEP', ['GEMS'], 'SOL']) {
      expect(() => parseExpectedCurrency(value, [], 'POST')).toThrowError(HttpError);
    }
    expect(() => parseExpectedCurrency('GEMS', ['x-pkw-expected-currency', 'GEMS', 'X-PKW-EXPECTED-CURRENCY', 'GEMS'], 'POST')).toThrowError(HttpError);
    expect(() => parseExpectedCurrency('KEEP', [], 'GET')).toThrowError(HttpError);
  });
});
