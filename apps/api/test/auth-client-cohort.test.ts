/**
 * Sign-in client cohort (D-103, M35 lane B): the web tells /auth/verify which
 * shell it is ('solana-mobile' | 'browser'). The value is recorded on every
 * session and, for a wallet's FIRST session, on players.first_client — a
 * descriptive tag for the public statistics, never an access decision.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { players, sessions } from '../src/db/schema';
import { TEST_CONFIG, connectTestDb } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;

type Keypair = { secretKey: Uint8Array; wallet: string };
async function makeKeypair(): Promise<Keypair> {
  const secretKey = utils.randomSecretKey();
  return { secretKey, wallet: bs58.encode(await getPublicKeyAsync(secretKey)) };
}
async function verify(kp: Keypair, extra: Record<string, unknown>) {
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), kp.secretKey));
  return app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: kp.wallet, signature, ...extra } });
}
async function sessionClients(wallet: string): Promise<Array<string | null>> {
  const rows = await conn.db.select({ client: sessions.client }).from(sessions).where(eq(sessions.wallet, wallet));
  return rows.map((r) => r.client).sort();
}
async function firstClient(wallet: string): Promise<string | null | undefined> {
  const [row] = await conn.db.select({ firstClient: players.firstClient, seekerVerified: players.seekerVerified })
    .from(players).where(eq(players.wallet, wallet));
  return row?.firstClient;
}

beforeAll(async () => {
  conn = connectTestDb();
  app = await buildApp(TEST_CONFIG, conn.db);
});
afterAll(async () => { await app.close(); await conn.sql.end(); });

describe.sequential('sign-in client cohort', () => {
  it('records the client on every session and the first one on the player, never overwriting', async () => {
    // WHY: the statistics page splits Solana Mobile vs browser by the FIRST
    // shell a player used; a later browser sign-in from the same person must
    // not move them out of the cohort, while each session keeps its own tag.
    const kp = await makeKeypair();
    expect((await verify(kp, { client: 'solana-mobile' })).statusCode).toBe(200);
    expect(await sessionClients(kp.wallet)).toEqual(['solana-mobile']);
    expect(await firstClient(kp.wallet)).toBe('solana-mobile');

    expect((await verify(kp, { client: 'browser' })).statusCode).toBe(200);
    expect(await sessionClients(kp.wallet)).toEqual(['browser', 'solana-mobile']);
    expect(await firstClient(kp.wallet)).toBe('solana-mobile');

    // The tag grants nothing: Seeker verification is still the SGT check.
    const [row] = await conn.db.select({ v: players.seekerVerified }).from(players).where(eq(players.wallet, kp.wallet));
    expect(row?.v).toBe(false);
  });

  it('leaves both columns null for a client that sends nothing, and never backfills first_client later', async () => {
    // WHY: older/cached clients omit the field; a wallet whose first sign-in
    // was untagged counts as browser (D-103) and a later tagged sign-in must
    // not rewrite history — sessions already exist, so first_client stays null.
    const kp = await makeKeypair();
    expect((await verify(kp, {})).statusCode).toBe(200);
    expect(await sessionClients(kp.wallet)).toEqual([null]);
    expect(await firstClient(kp.wallet)).toBeNull();

    expect((await verify(kp, { client: 'solana-mobile' })).statusCode).toBe(200);
    expect(await sessionClients(kp.wallet)).toEqual([null, 'solana-mobile']);
    expect(await firstClient(kp.wallet)).toBeNull();
  });

  it('tags a players row that pre-existed its first sign-in', async () => {
    // WHY: deposits and admin seeds can create a players row before the wallet
    // ever signs in; "first sign-in shell" is about the first SESSION, so the
    // pre-existing row still gets its cohort from that sign-in.
    const kp = await makeKeypair();
    await conn.db.insert(players).values({ wallet: kp.wallet });
    expect((await verify(kp, { client: 'browser' })).statusCode).toBe(200);
    expect(await firstClient(kp.wallet)).toBe('browser');
    expect(await sessionClients(kp.wallet)).toEqual(['browser']);
  });

  it('rejects an unknown client value without minting a session', async () => {
    // WHY: the column feeds public SQL; only the two documented buckets exist,
    // and a bad body must fail validation before any row is written.
    const kp = await makeKeypair();
    const res = await verify(kp, { client: 'tv' });
    expect(res.statusCode).toBe(400);
    expect(await sessionClients(kp.wallet)).toEqual([]);
    expect(await firstClient(kp.wallet)).toBeUndefined();
  });
});
