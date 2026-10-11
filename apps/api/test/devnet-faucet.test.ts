/**
 * DEVNET PLAYTEST ONLY — in-game devnet SOL faucet (owner 2026-08-22).
 * WHY these tests: the faucet must never over-grant (cap, cooldown, balance
 * gate, one pending at a time), must never touch any cluster but devnet, must
 * leave the treasury floor intact, and must be honest about failures so the
 * client can show a truthful retry. D-098: the status DTO carries the cooldown
 * policy so the client never does policy math, and no refusal points at the
 * public faucet (it may ask for a mainnet balance the player does not have).
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVNET_FAUCET } from '@shardkeep/shared';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { loadConfig } from '../src/config';
import { devnetFaucetGrants } from '../src/db/schema';
import {
  devnetFaucetStatus, processDevnetFaucetGrants, requestDevnetFaucetGrant, type FaucetSender,
} from '../src/money/devnetFaucet';
import { TEST_CONFIG, connectTestDb, createTestPlayer } from './helpers';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';

let conn: ReturnType<typeof connectTestDb>;
beforeAll(() => { conn = connectTestDb(); });
afterAll(async () => conn.sql.end());

/** A Connection whose only job is to answer getBalance from a map. */
function fakeConnection(balances: Map<string, bigint>): Connection {
  return { getBalance: async (pk: PublicKey) => Number(balances.get(pk.toBase58()) ?? 0n) } as unknown as Connection;
}
type Fake = FaucetSender & { sent: Array<{ to: string; lamports: bigint; sig: string }>; treasury: bigint; landed: Set<string>; balances: Map<string, bigint> };
/** `fail` throws BEFORE broadcast (clean failure); `crashAfterSend` broadcasts
 * (the transfer lands) and then throws — the interrupted-worker case. */
function fakeSender(treasury: bigint, fail: (to: string) => boolean = () => false, crashAfterSend: (to: string) => boolean = () => false): Fake {
  let n = 0;
  const s: Fake = {
    publicKey: Keypair.generate().publicKey,
    treasury,
    sent: [],
    landed: new Set<string>(),
    balances: new Map<string, bigint>(),
    treasuryLamports: async () => s.treasury,
    walletLamports: async (pk) => s.balances.get(pk.toBase58()) ?? null,
    transfer: async (to, lamports, onSigned) => {
      if (fail(to.toBase58())) throw new Error('blockhash not found');
      const sig = `sig-${++n}`;
      await onSigned(sig);
      s.treasury -= lamports; s.sent.push({ to: to.toBase58(), lamports, sig }); s.landed.add(sig);
      if (crashAfterSend(to.toBase58())) throw new Error('worker interrupted after broadcast');
      return sig;
    },
    signatureLanded: async (sig) => s.landed.has(sig),
  };
  return s;
}
const POLICY = { enabled: true, cluster: 'devnet' as const };
const sol = (n: number) => BigInt(Math.round(n * LAMPORTS_PER_SOL));

describe('devnet faucet eligibility and grants', () => {
  it('grants only a low wallet on devnet with the flag on, one pending at a time, then enforces cooldown and the lifetime cap', async () => {
    const p = await createTestPlayer(conn.db);
    const balances = new Map([[p.wallet, sol(0.01)]]);
    const rpc = fakeConnection(balances);
    expect((await devnetFaucetStatus(conn.db, { enabled: false, cluster: 'devnet' }, rpc, p.wallet)).reason).toBe('disabled');
    expect((await devnetFaucetStatus(conn.db, { enabled: true, cluster: 'mainnet-beta' }, rpc, p.wallet)).reason).toBe('not_devnet');
    const s0 = await devnetFaucetStatus(conn.db, POLICY, rpc, p.wallet);
    expect(s0).toMatchObject({ enabled: true, eligible: true, reason: 'ok', grantSol: DEVNET_FAUCET.grantSol, grantedSol: 0 });
    // D-098: the policy rides on every status; the cooldown instant only while cooling down.
    expect(s0).toMatchObject({ cooldownHours: DEVNET_FAUCET.cooldownHours, nextEligibleAt: null });

    const first = await requestDevnetFaucetGrant(conn.db, POLICY, rpc, p.wallet, new Date('2026-08-22T10:00:00Z'));
    expect(first.grant.status).toBe('requested');
    expect(first.status.reason).toBe('pending');
    await expect(requestDevnetFaucetGrant(conn.db, POLICY, rpc, p.wallet)).rejects.toMatchObject({ statusCode: 409 });

    // Worker pays it; treasury floor respected; the row records the signature.
    const sender = fakeSender(sol(10));
    expect(await processDevnetFaucetGrants(conn.db, sender, new Date('2026-08-22T10:00:05Z'))).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sender.sent).toEqual([{ to: p.wallet, lamports: sol(DEVNET_FAUCET.grantSol), sig: 'sig-1' }]);
    const [row] = await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, p.wallet));
    expect(row).toMatchObject({ status: 'sent', txSignature: 'sig-1' });

    // Cooldown right after a grant even though the (fake) balance is still low.
    const cooling = await devnetFaucetStatus(conn.db, POLICY, rpc, p.wallet, new Date('2026-08-22T11:00:00Z'));
    expect(cooling.reason).toBe('cooldown');
    // D-098: the client counts down to sentAt + cooldownHours — computed HERE,
    // never on the client — and the refusal names that instant instead of
    // sending the player to faucet.solana.com.
    const sentAt = Date.parse('2026-08-22T10:00:05Z');
    expect(cooling.nextEligibleAt).toBe(new Date(sentAt + DEVNET_FAUCET.cooldownHours * 3_600_000).toISOString());
    expect(cooling.cooldownHours).toBe(DEVNET_FAUCET.cooldownHours);
    await expect(requestDevnetFaucetGrant(conn.db, POLICY, rpc, p.wallet, new Date('2026-08-22T11:00:00Z')))
      .rejects.toMatchObject({ statusCode: 429, message: expect.stringMatching(/top you up again at 2026-08-22 \d\d:\d\d UTC$/) });
    // After the cooldown a wallet that now holds enough SOL is not topped up.
    balances.set(p.wallet, sol(1));
    expect((await devnetFaucetStatus(conn.db, POLICY, rpc, p.wallet, new Date('2026-08-23T10:00:00Z'))).reason).toBe('balance_ok');
    // A low wallet after the cooldown is eligible again until the lifetime cap.
    balances.set(p.wallet, sol(0));
    let at = new Date('2026-08-23T10:00:00Z');
    let grants = 1;
    while (grants * DEVNET_FAUCET.grantSol + DEVNET_FAUCET.grantSol <= DEVNET_FAUCET.lifetimeCapSol) {
      await requestDevnetFaucetGrant(conn.db, POLICY, rpc, p.wallet, at);
      await processDevnetFaucetGrants(conn.db, sender, at);
      grants += 1;
      at = new Date(at.getTime() + (DEVNET_FAUCET.cooldownHours + 1) * 3_600_000);
    }
    const capped = await devnetFaucetStatus(conn.db, POLICY, rpc, p.wallet, at);
    expect(capped.reason).toBe('cap_reached');
    expect(capped.grantedSol).toBeCloseTo(grants * DEVNET_FAUCET.grantSol, 6);
    expect(capped.nextEligibleAt).toBeNull();
    await expect(requestDevnetFaucetGrant(conn.db, POLICY, rpc, p.wallet, at)).rejects.toMatchObject({
      statusCode: 429, message: expect.stringContaining('lifetime maximum from the in-game faucet'),
    });
    // D-098: no refusal, on any reason, sends the player to the public faucet.
    // Settle all three at once: a promise that rejects while an earlier one is
    // still being awaited would surface as an unhandled rejection and fail the
    // run even though every assertion passes.
    const refusals = await Promise.allSettled([
      requestDevnetFaucetGrant(conn.db, POLICY, rpc, p.wallet, at),
      requestDevnetFaucetGrant(conn.db, { enabled: false, cluster: 'devnet' }, rpc, p.wallet, at),
      requestDevnetFaucetGrant(conn.db, POLICY, { getBalance: async () => { throw new Error('rpc down'); } } as unknown as Connection, p.wallet, at),
    ]);
    for (const refusal of refusals) {
      expect(refusal.status).toBe('rejected');
      expect((refusal as PromiseRejectedResult).reason).toMatchObject({
        message: expect.not.stringContaining('faucet.solana.com'),
      });
    }
  });

  it('keeps the treasury floor and records rpc failures as failed rows (the client then shows the faucet fallback)', async () => {
    const a = await createTestPlayer(conn.db);
    const b = await createTestPlayer(conn.db);
    const rpc = fakeConnection(new Map([[a.wallet, 0n], [b.wallet, 0n]]));
    await requestDevnetFaucetGrant(conn.db, POLICY, rpc, a.wallet, new Date('2026-08-22T12:00:00Z'));
    await requestDevnetFaucetGrant(conn.db, POLICY, rpc, b.wallet, new Date('2026-08-22T12:00:01Z'));
    // Treasury holds floor + one grant: the first pays, the second is refused.
    const low = fakeSender(sol(DEVNET_FAUCET.treasuryFloorSol + DEVNET_FAUCET.grantSol));
    expect(await processDevnetFaucetGrants(conn.db, low, new Date('2026-08-22T12:01:00Z'))).toEqual({ sent: 1, failed: 1, skipped: 1 });
    const rows = await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, b.wallet));
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'treasury_low' });
    expect(low.treasury).toBe(sol(DEVNET_FAUCET.treasuryFloorSol));

    const c = await createTestPlayer(conn.db);
    await requestDevnetFaucetGrant(conn.db, POLICY, fakeConnection(new Map([[c.wallet, 0n]])), c.wallet);
    const broken = fakeSender(sol(50), () => true);
    expect(await processDevnetFaucetGrants(conn.db, broken)).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const [cRow] = await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, c.wallet));
    expect(cRow?.status).toBe('failed');
    expect(cRow?.error).toMatch(/^rpc: /);
    // A failed grant is not counted against the lifetime cap.
    expect((await devnetFaucetStatus(conn.db, POLICY, fakeConnection(new Map([[c.wallet, 0n]])), c.wallet)).grantedSol).toBe(0);
  });

  it('never pays a grant twice when the worker dies between broadcast and the DB update', async () => {
    // WHY: the signature is persisted BEFORE the broadcast; a later sweep settles
    // the row from chain state instead of transferring again.
    const p = await createTestPlayer(conn.db);
    const rpc = fakeConnection(new Map([[p.wallet, 0n]]));
    await requestDevnetFaucetGrant(conn.db, POLICY, rpc, p.wallet, new Date('2026-08-22T14:00:00Z'));
    const crashy = fakeSender(sol(10), () => false, () => true);
    expect(await processDevnetFaucetGrants(conn.db, crashy, new Date('2026-08-22T14:00:05Z'))).toEqual({ sent: 0, failed: 0, skipped: 1 });
    let [row] = await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, p.wallet));
    expect(row).toMatchObject({ status: 'requested', txSignature: 'sig-1' });
    expect(row?.error).toMatch(/^broadcast pending since /);
    // The next sweep (same or another worker) finds the signature landed: mark sent, no second transfer.
    expect(await processDevnetFaucetGrants(conn.db, crashy, new Date('2026-08-22T14:00:10Z'))).toEqual({ sent: 1, failed: 0, skipped: 0 });
    [row] = await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, p.wallet));
    expect(row).toMatchObject({ status: 'sent', txSignature: 'sig-1', error: null });
    expect(crashy.sent).toHaveLength(1);

    // A persisted signature that never landed is resent only after the horizon.
    const q = await createTestPlayer(conn.db);
    await requestDevnetFaucetGrant(conn.db, POLICY, fakeConnection(new Map([[q.wallet, 0n]])), q.wallet, new Date('2026-08-22T15:00:00Z'));
    const lost = fakeSender(sol(10), () => false, () => true);
    await processDevnetFaucetGrants(conn.db, lost, new Date('2026-08-22T15:00:05Z'));
    lost.landed.clear(); // the broadcast was dropped by the cluster
    expect(await processDevnetFaucetGrants(conn.db, lost, new Date('2026-08-22T15:01:00Z'))).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await processDevnetFaucetGrants(conn.db, fakeSender(sol(10)), new Date('2026-08-22T15:03:00Z'))).toEqual({ sent: 1, failed: 0, skipped: 0 });
    const [qRow] = await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, q.wallet));
    expect(qRow).toMatchObject({ status: 'sent', txSignature: 'sig-1' });
  });

  it('fails stale requests, re-checks the balance before paying, and respects the treasury-wide daily budget', async () => {
    // WHY: eligibility is checked at request time; the sweep must not pay a
    // request hours later (worker downtime) or top up a wallet that got SOL
    // meanwhile, and one referral tree must not drain the treasury in a day.
    const stale = await createTestPlayer(conn.db);
    const t0 = new Date('2026-08-22T16:00:00Z');
    await requestDevnetFaucetGrant(conn.db, POLICY, fakeConnection(new Map([[stale.wallet, 0n]])), stale.wallet, t0);
    const s1 = fakeSender(sol(10));
    expect(await processDevnetFaucetGrants(conn.db, s1, new Date(t0.getTime() + (DEVNET_FAUCET.requestTtlMinutes + 1) * 60_000))).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect((await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, stale.wallet)))[0]).toMatchObject({ status: 'failed', error: 'stale' });
    expect(s1.sent).toHaveLength(0);

    const rich = await createTestPlayer(conn.db);
    await requestDevnetFaucetGrant(conn.db, POLICY, fakeConnection(new Map([[rich.wallet, 0n]])), rich.wallet, new Date('2026-08-22T17:00:00Z'));
    const s2 = fakeSender(sol(10)); s2.balances.set(rich.wallet, sol(1));
    expect(await processDevnetFaucetGrants(conn.db, s2, new Date('2026-08-22T17:00:05Z'))).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect((await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, rich.wallet)))[0]?.error).toBe('balance_ok_now');
    expect(s2.sent).toHaveLength(0);

    const a = await createTestPlayer(conn.db);
    const b = await createTestPlayer(conn.db);
    const day = new Date('2026-09-01T10:00:00Z'); // a day nothing else in this suite pays on
    await requestDevnetFaucetGrant(conn.db, POLICY, fakeConnection(new Map([[a.wallet, 0n]])), a.wallet, day);
    await requestDevnetFaucetGrant(conn.db, POLICY, fakeConnection(new Map([[b.wallet, 0n]])), b.wallet, new Date(day.getTime() + 1000));
    const s3 = fakeSender(sol(10));
    expect(await processDevnetFaucetGrants(conn.db, s3, new Date(day.getTime() + 5000), 20, { dailyBudgetLamports: sol(DEVNET_FAUCET.grantSol) })).toEqual({ sent: 1, failed: 1, skipped: 1 });
    expect((await conn.db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, b.wallet)))[0]?.error).toBe('daily_budget');
    expect(s3.sent).toHaveLength(1);
  });

  it('reports an unreadable balance as rpc_unavailable (503 on claim), never as balance_ok', async () => {
    const p = await createTestPlayer(conn.db);
    const broken = { getBalance: async () => { throw new Error('rpc down'); } } as unknown as Connection;
    expect((await devnetFaucetStatus(conn.db, POLICY, broken, p.wallet)).reason).toBe('rpc_unavailable');
    await expect(requestDevnetFaucetGrant(conn.db, POLICY, broken, p.wallet)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('refuses the flag on any cluster but devnet at config load', () => {
    const base = {
      DATABASE_URL: 'postgres://x/y', JWT_SECRET: 'test-secret-test-secret-test-secret!',
      WEB_ORIGIN: 'https://play.example.com', NODE_ENV: 'test' as const,
    };
    expect(() => loadConfig({ ...base, SOLANA_CLUSTER: 'mainnet-beta', DEVNET_FAUCET_ENABLED: 'true' })).toThrow(/DEVNET_FAUCET_ENABLED/);
    expect(loadConfig({ ...base, SOLANA_CLUSTER: 'devnet', DEVNET_FAUCET_ENABLED: 'true' }).DEVNET_FAUCET_ENABLED).toBe('true');
  });
});

describe('devnet faucet routes', () => {
  let app: FastifyInstance;
  let wallet: string; let cookie: string;
  beforeAll(async () => {
    const balances = new Map<string, bigint>();
    app = await buildApp({ ...TEST_CONFIG, DEVNET_FAUCET_ENABLED: 'true' }, conn.db, { devnetFaucetConnection: fakeConnection(balances) });
    const secretKey = utils.randomSecretKey();
    wallet = bs58.encode(await getPublicKeyAsync(secretKey));
    balances.set(wallet, 0n);
    const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    const { message } = ch.json() as { message: string };
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  });
  afterAll(async () => app.close());

  it('reports status and records one claim for the signed-in wallet', async () => {
    const status = await app.inject({ method: 'GET', url: '/devnet-faucet/status', cookies: { [SESSION_COOKIE]: cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ enabled: true, eligible: true, reason: 'ok' });
    const claim = await app.inject({ method: 'POST', url: '/devnet-faucet/claim', cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ grant: { status: 'requested' }, status: { reason: 'pending' } });
    const again = await app.inject({ method: 'POST', url: '/devnet-faucet/claim', cookies: { [SESSION_COOKIE]: cookie }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('FAUCET_NOT_ELIGIBLE');
    expect((await app.inject({ method: 'GET', url: '/devnet-faucet/status' })).statusCode).toBe(401);
  });
});
