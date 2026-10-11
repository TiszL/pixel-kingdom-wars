/**
 * POST /deposits (entry / deed) answers with the COUNTRY it froze (D-103).
 *
 * WHY: the land screen must show the reserved parcel as land — a country and
 * a cell — before the wallet prompt opens. The client is forbidden from
 * resolving the name itself (the fine country index is a lazy globe chunk and
 * a second list would drift from the registry the deed reads), so the intent
 * carries the registry name for the exact code it froze. A response that
 * names a different country than the frozen code, or none at all, would put
 * the wrong land in front of a 0.2 SOL approval.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, earthCountries, players } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createDepositIntent } from '../src/money/deposits';
import { connectTestDb, countryA3OfCell, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

async function basePlayer() {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await ensureWalletBaseIdentity(db, p.wallet);
  return p;
}

async function registryName(a3: string): Promise<string | null> {
  const [row] = await db.select({ name: earthCountries.name }).from(earthCountries)
    .where(eq(earthCountries.a3, a3));
  return row?.name ?? null;
}

/** Narrow the intent union to the land rail: anything else is a test failure. */
async function landIntent(wallet: string, kind: 'entry' | 'deed') {
  const intent = await createDepositIntent(db, wallet, kind);
  if (intent.kind !== 'entry' && intent.kind !== 'deed') throw new Error(`expected a land intent, got ${intent.kind}`);
  if (intent.earthCell === undefined || intent.countryA3 === undefined) throw new Error('Expected frozen legacy Earth address');
  return { ...intent, earthCell: intent.earthCell, countryA3: intent.countryA3 };
}

describe('land purchase intents name the country they froze', () => {
  it('returns the frozen code and its registry name for a random entry cell, stable across reuse', async () => {
    const p = await basePlayer();
    const intent = await landIntent(p.wallet, 'entry');
    expect(intent.kind).toBe('entry');
    // The code is the one the frozen cell resolves to — not a code of the
    // server's choosing that happens to be valid.
    expect(intent.countryA3).toMatch(/^[A-Z]{3}$/);
    expect(intent.countryA3).toBe(countryA3OfCell(intent.earthCell));
    // And the name is the registry's for THAT code (deed metadata reads the
    // same table), never a fabricated or empty trait.
    const expected = await registryName(intent.countryA3);
    expect(expected, 'a claimable cell always has a registered sovereign').toBeTruthy();
    expect(intent.countryName).toBe(expected);

    // A second request re-answers the SAME pending reservation (no new
    // payable reference) and must carry the same land identity, otherwise the
    // card could flip country between two taps of RESERVE.
    const again = await landIntent(p.wallet, 'entry');
    expect(again.id).toBe(intent.id);
    expect(again.earthCell).toBe(intent.earthCell);
    expect(again.countryA3).toBe(intent.countryA3);
    expect(again.countryName).toBe(intent.countryName);
  });

  it('answers the repeatable deed rail with the same land identity fields', async () => {
    const p = await basePlayer();
    const paidAt = new Date();
    await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, p.wallet));
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, p.wallet));
    const intent = await landIntent(p.wallet, 'deed');
    expect(intent.kind).toBe('deed');
    expect(intent.countryA3).toBe(countryA3OfCell(intent.earthCell));
    expect(intent.countryName).toBe(await registryName(intent.countryA3));
  });
});
