/**
 * GET /wallet/keep-deposits — the DEPOSIT KEEP page's RECENT DEPOSITS list
 * (tester request 2026-09-16). These pin what makes the read safe to ship on a
 * money surface: it is the CALLER's rows only, KEEP custody inflows only, the
 * whole-KEEP figure is the same division the credit posting used (never a
 * client guess), bigint columns are serialized, and it is auth-only — custody
 * history is a wallet right, not a land or base stake.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import type { FastifyInstance } from 'fastify';
import { TOKEN } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { deposits, players } from '../src/db/schema';
import { listKeepDeposits } from '../src/money/deposits';
import { connectTestDb, createTestPlayer, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;

describe('GET /wallet/keep-deposits', () => {
  let app: FastifyInstance;
  let cookie: string;
  let wallet: string;
  const keepUnits = (whole: number): bigint => BigInt(whole) * (10n ** BigInt(TOKEN.decimals));

  beforeAll(async () => {
    app = await buildApp(TEST_CONFIG, db);
    await app.ready();
    const secretKey = utils.randomSecretKey();
    wallet = bs58.encode(await getPublicKeyAsync(secretKey));
    const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    const { message } = ch.json() as { message: string };
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    await db.insert(players).values({ wallet }).onConflictDoNothing();
  });
  afterAll(async () => { await app.close(); await conn.sql.end(); });

  it('returns only the caller\'s keep_deposit rows, newest first, with the credited whole-KEEP figure', async () => {
    const other = await createTestPlayer(db);
    const t0 = Date.parse('2026-09-16T10:00:00.000Z');
    await db.insert(deposits).values([
      { playerWallet: wallet, kind: 'keep_deposit', reference: randomWallet(), status: 'credited',
        amount: keepUnits(1_500), txSignature: `sig-${randomWallet()}`, createdAt: new Date(t0), finalizedAt: new Date(t0 + 30_000) },
      { playerWallet: wallet, kind: 'keep_deposit', reference: randomWallet(), status: 'pending',
        amount: null, createdAt: new Date(t0 + 60_000) },
      // Dust below one whole KEEP is what the credit path refuses; the list must not round it up.
      { playerWallet: wallet, kind: 'keep_deposit', reference: randomWallet(), status: 'expired',
        amount: keepUnits(2) + 5n, createdAt: new Date(t0 - 60_000) },
      // Not a KEEP inflow: a land purchase intent never appears here.
      { playerWallet: wallet, kind: 'entry', reference: randomWallet(), status: 'credited',
        amount: 200_000_000n, createdAt: new Date(t0 + 120_000) },
      // Someone else's deposit: never visible to this caller.
      { playerWallet: other.wallet, kind: 'keep_deposit', reference: randomWallet(), status: 'credited',
        amount: keepUnits(9_999), createdAt: new Date(t0 + 180_000) },
    ]);
    const res = await app.inject({ method: 'GET', url: '/wallet/keep-deposits', cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    const { deposits: rows } = res.json() as { deposits: Array<Record<string, unknown>> };
    expect(rows.map((r) => r['status'])).toEqual(['pending', 'credited', 'expired']);
    expect(rows[0]).toMatchObject({ amount: null, amountKeep: null, txSignature: null });
    expect(rows[1]).toMatchObject({ amount: keepUnits(1_500).toString(), amountKeep: '1500' });
    expect(typeof rows[1]!['txSignature']).toBe('string');
    expect(rows[2]).toMatchObject({ amountKeep: '2' });
    expect(rows.some((r) => r['amountKeep'] === '9999')).toBe(false);
    expect(rows.every((r) => !('kind' in r) || r['kind'] === 'keep_deposit')).toBe(true);
  });

  it('is bounded to the newest rows so the page never grows with a whale\'s history', async () => {
    const p = await createTestPlayer(db);
    const t0 = Date.parse('2026-09-16T00:00:00.000Z');
    await db.insert(deposits).values(Array.from({ length: 25 }, (_, i) => ({
      playerWallet: p.wallet, kind: 'keep_deposit' as const, reference: randomWallet(), status: 'credited' as const,
      amount: keepUnits(i + 1), createdAt: new Date(t0 + i * 1_000),
    })));
    const rows = await listKeepDeposits(db, p.wallet);
    expect(rows).toHaveLength(20);
    expect(rows[0]!.amountKeep).toBe('25');
    expect(rows[19]!.amountKeep).toBe('6');
  });

  it('refuses an unauthenticated read', async () => {
    const res = await app.inject({ method: 'GET', url: '/wallet/keep-deposits' });
    expect(res.statusCode).toBe(401);
  });
});
