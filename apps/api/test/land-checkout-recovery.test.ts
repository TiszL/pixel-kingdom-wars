/** Recovery must inspect chain evidence before replacing a reserved parcel.
 * These use the public route without a watcher, covering the phone's actual
 * reserve/reload path and ensuring an RPC outage cannot release paid land. */
import { ECONOMY } from '@shardkeep/shared';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { deposits, plotReservations } from '../src/db/schema';
import { DepositVerificationIndeterminateError, makeChainDepositVerifier, type DepositVerifier } from '../src/money/depositWatcher';
import { Keypair, type Connection } from '@solana/web3.js';
import { TEST_CONFIG, connectTestDb } from './helpers';

const conn = connectTestDb();
let app: FastifyInstance;
const verify = vi.fn<DepositVerifier>(async () => null);
beforeAll(async () => { app = await buildApp(TEST_CONFIG, conn.db, { depositVerifier: verify }); await app.ready(); });
afterAll(async () => { await app.close(); await conn.sql.end(); });
async function player() {
  const key = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(key));
  const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message), key));
  const auth = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  expect(auth.statusCode).toBe(200);
  return { wallet, cookies: { [SESSION_COOKIE]: auth.cookies.find((c) => c.name === SESSION_COOKIE)!.value } };
}
async function reserve(cookies: Record<string, string>, earthCell?: number) {
  return app.inject({ method: 'POST', url: '/deposits', cookies, payload: { kind: 'entry', ...(earthCell === undefined ? {} : { earthCell }) } });
}
async function age(id: string, minutes: number) {
  const createdAt = new Date(Date.now() - minutes * 60_000);
  await conn.db.update(deposits).set({ createdAt }).where(eq(deposits.id, id));
  return createdAt;
}

describe('land checkout recovery without a worker', () => {
  it('returns immutable quote fields on GET and a structured route back to the already reserved cell', async () => {
    const p = await player();
    const requestedAt = Date.now();
    const first = await reserve(p.cookies);
    expect(first.statusCode).toBe(200);
    const intent = first.json();
    // Clients anchor countdowns to this observation, never their skewed wall clock.
    expect(Date.parse(intent.serverNow)).toBeGreaterThanOrEqual(requestedAt);
    expect(Date.parse(intent.serverNow)).toBeLessThanOrEqual(Date.now());
    const restored = await app.inject({ method: 'GET', url: `/deposits/${intent.id}`, cookies: p.cookies });
    expect(restored.json()).toMatchObject({ id: intent.id, reference: intent.reference, earthCell: intent.earthCell,
      amountLamports: intent.amountLamports, countryA3: intent.countryA3, countryName: intent.countryName,
      payableUntil: intent.payableUntil, retryAt: intent.retryAt });
    expect(Date.parse(restored.json().serverNow)).toBeGreaterThanOrEqual(Date.parse(intent.serverNow));
    expect(Date.parse(restored.json().serverNow)).toBeLessThanOrEqual(Date.now());
    const mismatch = await reserve(p.cookies, intent.earthCell === 0 ? 1 : 0);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toMatchObject({ code: 'RESERVATION_MISMATCH', depositId: intent.id,
      earthCell: intent.earthCell, retryAt: intent.retryAt });
    const other = await player();
    const stolen = await app.inject({ method: 'GET', url: `/deposits/${intent.id}`, cookies: other.cookies });
    expect(stolen.statusCode).toBe(404);
  });

  it('holds the original reservation throughout the closing safety window without consulting RPC', async () => {
    verify.mockClear();
    const p = await player();
    const intent = (await reserve(p.cookies)).json();
    await age(intent.id, ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin + 1);
    const retry = await reserve(p.cookies);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toMatchObject({ code: 'PAYMENT_WINDOW_CLOSING', depositId: intent.id });
    expect(verify).not.toHaveBeenCalled();
    expect((await conn.db.select().from(deposits).where(eq(deposits.id, intent.id)))[0]!.status).toBe('pending');
  });

  it('scans an unpaid stale reference before expiring it and creating one replacement', async () => {
    verify.mockClear(); verify.mockResolvedValue(null);
    const p = await player();
    const intent = (await reserve(p.cookies)).json();
    await age(intent.id, ECONOMY.depositPendingTtlMin + 1);
    const retry = await reserve(p.cookies);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).not.toBe(intent.id);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ id: intent.id, reference: intent.reference }));
    expect((await conn.db.select().from(deposits).where(eq(deposits.id, intent.id)))[0]!.status).toBe('expired');
    expect((await conn.db.select().from(plotReservations).where(eq(plotReservations.depositId, intent.id)))[0]!.state).toBe('expired');
  });

  it('concurrent recovery taps reuse a single replacement after verified expiry', async () => {
    verify.mockResolvedValue(null);
    const p = await player();
    const intent = (await reserve(p.cookies)).json();
    await age(intent.id, ECONOMY.depositPendingTtlMin + 1);
    const [one, two] = await Promise.all([reserve(p.cookies), reserve(p.cookies)]);
    expect(one.statusCode).toBe(200); expect(two.statusCode).toBe(200);
    expect(one.json().id).toBe(two.json().id);
    expect(one.json().id).not.toBe(intent.id);
    expect(await conn.db.select().from(deposits).where(eq(deposits.playerWallet, p.wallet))).toHaveLength(2);
  });

  it('credits a paid-but-unreported signature instead of replacing the parcel after TTL', async () => {
    const p = await player();
    const intent = (await reserve(p.cookies)).json();
    await age(intent.id, ECONOMY.depositPendingTtlMin + 1);
    verify.mockImplementationOnce(async (dep) => ({
      txSignature: `paid:${dep.id}`, wallet: dep.playerWallet, kind: dep.kind,
      lamports: BigInt(Math.round(ECONOMY.entryFeeSol * 1e9)), finalized: true,
    }));
    const retry = await reserve(p.cookies);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id: intent.id, status: 'credited', earthCell: intent.earthCell });
    expect((await conn.db.select().from(deposits).where(eq(deposits.playerWallet, p.wallet)))).toHaveLength(1);
  });

  it('RPC uncertainty leaves the reservation intact and returns its recoverable id', async () => {
    const p = await player();
    const intent = (await reserve(p.cookies)).json();
    await age(intent.id, ECONOMY.depositPendingTtlMin + 1);
    verify.mockRejectedValueOnce(new Error('independent RPC disagreement'));
    const retry = await reserve(p.cookies);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toMatchObject({ code: 'PAYMENT_WINDOW_CLOSING', depositId: intent.id });
    expect((await conn.db.select().from(deposits).where(eq(deposits.id, intent.id)))[0]!.status).toBe('pending');
    expect((await conn.db.select().from(plotReservations).where(eq(plotReservations.depositId, intent.id)))[0]!.state).toBe('reserved');
  });
});


const absentEvidence = [
  ['body', null],
  ['metadata', { meta: null }],
  ['logs', { meta: { err: null, logMessages: null } }],
] as const;
function incompleteRpc(body: unknown): Connection {
  return {
    getSignaturesForAddress: vi.fn(async () => [{ signature: 'listed-finalized-success', err: null, blockTime: Math.floor(Date.now() / 1000) }]),
    getTransaction: vi.fn(async () => body),
  } as unknown as Connection;
}

describe('successful reference candidates with incomplete RPC evidence', () => {
  it.each(absentEvidence)('missing %s is indeterminate, never an unpaid verdict', async (_field, body) => {
    const inspect = makeChainDepositVerifier(incompleteRpc(body));
    await expect(inspect({
      id: 'missing-evidence', kind: 'deed', reference: Keypair.generate().publicKey.toBase58(),
      playerWallet: Keypair.generate().publicKey.toBase58(), createdAt: new Date(Date.now() - 60_000),
    })).rejects.toBeInstanceOf(DepositVerificationIndeterminateError);
  });

  it('still credits a complete exact payment found after another candidate has missing evidence', async () => {
    const reference = Keypair.generate().publicKey.toBase58();
    const wallet = Keypair.generate().publicKey.toBase58();
    const amount = BigInt(Math.round(ECONOMY.entryFeeSol * 1e9));
    const connection = {
      getSignaturesForAddress: vi.fn(async () => [
        { signature: 'missing', err: null, blockTime: 2000 },
        { signature: 'proven', err: null, blockTime: 2000 },
      ]),
      getTransaction: vi.fn(async (signature: string) => signature === 'missing' ? null
        : { meta: { err: null, logMessages: ['payment'] } }),
    } as unknown as Connection;
    const inspect = makeChainDepositVerifier(connection, () => [{ reference, wallet, kind: 9, lamports: amount }]);
    await expect(inspect({ id: 'later-proof', kind: 'deed', reference, playerWallet: wallet,
      createdAt: new Date(1_999_000), expectedLamports: amount })).resolves.toMatchObject({ txSignature: 'proven', lamports: amount });
  });

  it.each(absentEvidence)('a stale land intent keeps its parcel when finalized history lacks %s', async (_field, body) => {
    const p = await player();
    const intent = (await reserve(p.cookies)).json();
    await age(intent.id, ECONOMY.depositPendingTtlMin + 1);
    verify.mockImplementationOnce(makeChainDepositVerifier(incompleteRpc(body)));
    const retry = await reserve(p.cookies);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toMatchObject({ code: 'PAYMENT_WINDOW_CLOSING', depositId: intent.id });
    expect((await conn.db.select().from(deposits).where(eq(deposits.id, intent.id)))[0]!.status).toBe('pending');
    expect((await conn.db.select().from(plotReservations).where(eq(plotReservations.depositId, intent.id)))[0]!.state).toBe('reserved');
    expect(await conn.db.select().from(deposits).where(eq(deposits.playerWallet, p.wallet))).toHaveLength(1);
  });
});
