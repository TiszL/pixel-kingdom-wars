/**
 * Withdrawal route security contract.
 *
 * WHY this is an API test rather than another money-unit test: the instant path
 * is safe only when the authenticated SIWS session, exact recent-auth intent,
 * mature one-time TOTP factor, business gates, ledger freeze and injected chain sender
 * are wired together in this order. A green primitive in isolation cannot catch
 * a route that drops the session/intent context or consumes the code too early.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { ECONOMY } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret, TOTP } from 'otpauth';
import { buildApp } from '../src/app';
import {
  RECENT_AUTH_HEADER, SESSION_COOKIE, type WithdrawalRecentAuthIntent,
} from '../src/auth/session';
import type { EmailSender } from '../src/auth/twofa';
import { ledgerTransactions, players, withdrawalAuthorizations, withdrawals } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger/accounts';
import { postTransaction } from '../src/ledger/ledger';
import { cancelWithdrawal, requestWithdrawal } from '../src/money/withdrawals';
import { makeWithdrawalAuthorizationGate } from '../src/money/withdrawalAuthorization';
import { TEST_CONFIG, connectTestDb, fundTestKeep } from './helpers';
import { makeTestKeepSender } from './withdrawalSender';

const conn = connectTestDb();
const db = conn.db;
const coveredReserve = async (): Promise<bigint> => 10n ** 15n;

interface DeliveredEmail { to: string; body: string }
interface Transfer { destination: string; amount: bigint; signature: string }

const delivered: DeliveredEmail[] = [];
const transfers: Transfer[] = [];
const emailSender: EmailSender = async (to, _subject, body) => {
  delivered.push({ to, body });
};

let sequence = 0;
const unique = (label: string): string =>
  `withdraw-route:${label}:${++sequence}:${Math.random().toString(36).slice(2)}`;

let app: FastifyInstance;

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db, {
    emailSender,
    reserveReader: coveredReserve,
    keepSender: makeTestKeepSender({ broadcast: async (prepared) => {
      const signature = prepared.signature;
      transfers.push({
        destination: prepared.transfer.destinationOwner,
        amount: BigInt(prepared.transfer.amountKeep),
        signature,
      });
      return signature;
    } }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

async function sign(message: string, secretKey: Uint8Array): Promise<string> {
  return bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
}

interface PlayerFixture {
  wallet: string;
  secretKey: Uint8Array;
  cookie: string;
  email: string;
  totpSecret: string;
  startingKeep: bigint;
}

async function fundedLandowner(startingKeep = 10_000n): Promise<PlayerFixture> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const challenge = await app.inject({
    method: 'GET', url: '/auth/challenge', query: { wallet },
  });
  expect(challenge.statusCode).toBe(200);
  const message = (challenge.json() as { message: string }).message;
  const verified = await app.inject({
    method: 'POST', url: '/auth/verify',
    payload: { wallet, signature: await sign(message, secretKey) },
  });
  expect(verified.statusCode).toBe(200);
  const cookie = verified.cookies.find((candidate) => candidate.name === SESSION_COOKIE)?.value;
  expect(cookie).toBeDefined();

  const email = `withdraw-${sequence}-${wallet.slice(0, 8)}@test.local`;
  const totpSecret = new Secret({ size: 20 }).base32;
  await db.update(players).set({
    entryPaidAt: new Date(), email, emailVerified: true,
    totpSecret, totpEnabled: true, totpEnabledAt: new Date(0),
  }).where(eq(players.wallet, wallet));
  await fundTestKeep(db, wallet, startingKeep, 'test.withdraw-route.fund', unique('fund'));
  return { wallet, secretKey, cookie: cookie!, email, totpSecret, startingKeep };
}

type RequestIntent = { amount: string; destination: string; idempotencyKey: string };
type RecentGrant = {
  grant: string;
  authorization: { challengeToken: string; signature: string };
};

const exactIntent = (intent: RequestIntent, instant = true): WithdrawalRecentAuthIntent => {
  const gross = BigInt(intent.amount);
  const fee = gross * BigInt(ECONOMY.withdrawFeeBps) / 10_000n;
  return {
    version: 1, grossAmount: gross.toString(), feeBurned: fee.toString(),
    netAmount: (gross - fee).toString(), destination: intent.destination,
    cluster: 'devnet', keepMint: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC',
    idempotencyKey: intent.idempotencyKey, mode: instant ? 'instant' : 'standard',
    unbondingHours: instant ? 0 : ECONOMY.unbondingHours,
  };
};

async function recentGrant(
  player: PlayerFixture, intent: RequestIntent, instant = true,
): Promise<RecentGrant> {
  const challenged = await app.inject({
    method: 'POST', url: '/auth/reauth/challenge',
    cookies: { [SESSION_COOKIE]: player.cookie },
    payload: { purpose: 'withdrawal', intent: exactIntent(intent, instant) },
  });
  expect(challenged.statusCode).toBe(200);
  const body = challenged.json() as { challengeToken: string; message: string };
  const signature = await sign(body.message, player.secretKey);
  const verified = await app.inject({
    method: 'POST', url: '/auth/reauth/verify',
    cookies: { [SESSION_COOKIE]: player.cookie },
    payload: {
      challengeToken: body.challengeToken,
      signature,
    },
  });
  expect(verified.statusCode).toBe(200);
  return {
    grant: (verified.json() as { grant: string }).grant,
    authorization: { challengeToken: body.challengeToken, signature },
  };
}

const destination = (): string => Keypair.generate().publicKey.toBase58();
const balance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance;
const rowsFor = (wallet: string) =>
  db.select().from(withdrawals).where(eq(withdrawals.playerWallet, wallet));
const totpCodeFor = (player: PlayerFixture, timestamp = Date.now()): string =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(player.totpSecret) })
    .generate({ timestamp });

const instantBody = (
  intent: RequestIntent,
  code: string,
  authorization: RecentGrant['authorization'],
) => ({
  ...intent, instant: true, method: 'totp' as const, code,
  authorization,
});

describe('withdrawal route security contract', () => {
  it('keeps existing withdrawal history and unwind reachable after land is sold', async () => {
    // WHY: creating a withdrawal is a land privilege, but the escrow remains the
    // player's custody claim after a deed sale. Losing entryPaidAt must not hide
    // the row or its cancel/refund route.
    const player = await fundedLandowner();
    const row = await requestWithdrawal(
      db, player.wallet, 1_000n, destination(), unique('sold-land'),
    );
    await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, player.wallet));

    const listed = await app.inject({
      method: 'GET', url: '/withdrawals', cookies: { [SESSION_COOKIE]: player.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().withdrawals).toContainEqual(expect.objectContaining({
      id: row.id, status: 'unbonding', refundable: false,
    }));
    const cancelled = await app.inject({
      method: 'POST', url: `/withdrawals/${row.id}/cancel`,
      cookies: { [SESSION_COOKIE]: player.cookie }, payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: row.id, status: 'cancelled' });
  });

  it('exposes refundability only after explicit no-broadcast proof', async () => {
    // WHY: legacy workers erased their BROADCAST marker on RPC errors. The UI
    // must never infer refund safety from status=failed or a null signature.
    const safe = await fundedLandowner();
    const safeRow = await requestWithdrawal(
      db, safe.wallet, 1_000n, destination(), unique('safe-refund'),
    );
    await db.update(withdrawals).set({
      status: 'failed',
      lastError: 'NOT BROADCAST — operator verified no matching chain transaction',
    }).where(eq(withdrawals.id, safeRow.id));
    const safeList = await app.inject({
      method: 'GET', url: '/withdrawals', cookies: { [SESSION_COOKIE]: safe.cookie },
    });
    expect(safeList.statusCode).toBe(200);
    expect(safeList.json().withdrawals).toContainEqual(expect.objectContaining({
      id: safeRow.id, status: 'failed', refundable: true,
    }));

    const unknown = await fundedLandowner();
    const unknownRow = await requestWithdrawal(
      db, unknown.wallet, 1_000n, destination(), unique('unknown-refund'),
    );
    await db.update(withdrawals).set({
      status: 'failed', lastError: 'Error: rpc down',
    }).where(eq(withdrawals.id, unknownRow.id));
    const unknownList = await app.inject({
      method: 'GET', url: '/withdrawals', cookies: { [SESSION_COOKIE]: unknown.cookie },
    });
    expect(unknownList.statusCode).toBe(200);
    expect(unknownList.json().withdrawals).toContainEqual(expect.objectContaining({
      id: unknownRow.id, status: 'failed', refundable: false,
    }));

    // The M23 a4 serializer widened deliberately (destination, timestamps,
    // mint, netAmount) — but `lastError` carries the operator refund
    // discriminator ("SENT <sig> — DO NOT RE-SEND" / "NOT BROADCAST") plus raw
    // RPC detail, and must NEVER reach a client. `refundable` is the one
    // derived answer. Pin its absence so a future `...w` spread fails here
    // instead of leaking (security review 2026-08-15).
    for (const row of [...safeList.json().withdrawals, ...unknownList.json().withdrawals]) {
      expect(row).not.toHaveProperty('lastError');
      expect(row).not.toHaveProperty('requestLedgerTxnId');
      expect(row).not.toHaveProperty('payoutLedgerTxnId');
      expect(row).not.toHaveProperty('refundLedgerTxnId');
    }
  });

  it('rejects request IDs that could inject lines or controls into the wallet prompt', async () => {
    const player = await fundedLandowner();
    const unsafe = {
      amount: '1000',
      destination: destination(),
      idempotencyKey: 'valid-part\nAmount: 999999 KEEP',
    };

    const challenge = await app.inject({
      method: 'POST', url: '/auth/reauth/challenge',
      cookies: { [SESSION_COOKIE]: player.cookie },
      payload: { purpose: 'instant_withdrawal', intent: unsafe },
    });
    const prepare = await app.inject({
      method: 'POST', url: '/withdrawals/prepare',
      cookies: { [SESSION_COOKIE]: player.cookie },
      payload: { ...unsafe, instant: true },
    });

    expect(challenge.statusCode).toBe(400);
    expect(prepare.statusCode).toBe(400);
    expect(await rowsFor(player.wallet)).toHaveLength(0);
  });

  it('prepare runs the real gates without creating an idempotency anchor, row or debit', async () => {
    const player = await fundedLandowner();
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('prepare') };
    const before = await balance(player.wallet);

    const response = await app.inject({
      method: 'POST', url: '/withdrawals/prepare',
      cookies: { [SESSION_COOKIE]: player.cookie }, payload: { ...intent, instant: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(exactIntent(intent, true));
    expect(await balance(player.wallet)).toBe(before);
    expect(await rowsFor(player.wallet)).toHaveLength(0);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey,
      `withdrawal.request:${player.wallet}:${intent.idempotencyKey}`,
    ))).toHaveLength(0);
  });

  it('rejects email-only instant custody and exposes no withdrawal email-code route', async () => {
    const player = await fundedLandowner();
    await db.update(players).set({
      totpSecret: null, totpEnabled: false, totpEnabledAt: null,
    }).where(eq(players.wallet, player.wallet));
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('email-only') };
    const before = await balance(player.wallet);
    const emailsBefore = delivered.length;
    const removed = await app.inject({
      method: 'POST', url: '/withdrawals/send-code',
      cookies: { [SESSION_COOKIE]: player.cookie }, payload: intent,
    });
    expect(removed.statusCode).toBe(404);
    const { grant } = await recentGrant(player, intent);
    const rejected = await app.inject({
      method: 'POST', url: '/withdrawals', cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant },
      payload: { ...intent, instant: true, method: 'email', code: '123456' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(delivered).toHaveLength(emailsBefore);
    expect(await balance(player.wallet)).toBe(before);
    expect(await rowsFor(player.wallet)).toHaveLength(0);
  });

  it('rejects a newly enabled TOTP without escrow, then accepts it once the hold matures', async () => {
    const player = await fundedLandowner();
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('totp-hold') };
    await db.update(players).set({
      totpEnabledAt: new Date(), totpLastUsedStep: null,
    }).where(eq(players.wallet, player.wallet));
    const before = await balance(player.wallet);
    const { grant, authorization } = await recentGrant(player, intent);
    const code = totpCodeFor(player);
    const held = await app.inject({
      method: 'POST', url: '/withdrawals', cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant }, payload: instantBody(intent, code, authorization),
    });
    expect(held.statusCode).toBe(403);
    expect(held.json().error.message).toMatch(/still maturing/i);
    expect(await balance(player.wallet)).toBe(before);
    expect(await rowsFor(player.wallet)).toHaveLength(0);
    expect((await db.select({ step: players.totpLastUsedStep }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.step).toBeNull();

    await db.update(players).set({
      totpEnabledAt: new Date(Date.now() - ECONOMY.unbondingHours * 3_600_000),
    }).where(eq(players.wallet, player.wallet));
    const accepted = await app.inject({
      method: 'POST', url: '/withdrawals', cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant }, payload: instantBody(intent, code, authorization),
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ status: 'unbonding', amount: '1000' });
    expect(await rowsFor(player.wallet)).toHaveLength(1);
  });

  it.each(['amount', 'destination', 'idempotencyKey'] as const)(
    'rejects an altered %s with the original exact-intent grant without consuming TOTP',
    async (field) => {
      const player = await fundedLandowner();
      const original: RequestIntent = {
        amount: '1000', destination: destination(), idempotencyKey: unique(`bound-${field}`),
      };
      const { grant: originalGrant, authorization: originalAuthorization } = await recentGrant(player, original);
      const code = totpCodeFor(player);
      const altered: RequestIntent = {
        ...original,
        ...(field === 'amount' ? { amount: '1001' } : {}),
        ...(field === 'destination' ? { destination: destination() } : {}),
        ...(field === 'idempotencyKey' ? { idempotencyKey: unique('altered-key') } : {}),
      };
      const before = await balance(player.wallet);

      // The signed grant itself names all three economic fields.
      const wrongGrant = await app.inject({
        method: 'POST', url: '/withdrawals',
        cookies: { [SESSION_COOKIE]: player.cookie },
        headers: { [RECENT_AUTH_HEADER]: originalGrant },
        payload: instantBody(altered, code, originalAuthorization),
      });
      expect(wrongGrant.statusCode).toBe(428);

      expect(await balance(player.wallet)).toBe(before);
      expect(await rowsFor(player.wallet)).toHaveLength(0);
      const [factor] = await db.select({ step: players.totpLastUsedStep }).from(players)
        .where(eq(players.wallet, player.wallet));
      expect(factor?.step).toBeNull();
    },
  );

  it('does not consume the factor on a business rejection, then consumes it atomically with escrow', async () => {
    const player = await fundedLandowner();
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('atomic') };
    const { grant, authorization } = await recentGrant(player, intent);
    const code = totpCodeFor(player);

    // Drain through the ledger after review/code issue. The final server gate
    // must now reject BEFORE it reaches the one-time authorization seam.
    const sys = await bootstrapSystemAccounts(db);
    const account = await getOrCreatePlayerAccount(db, player.wallet, 'player_keep');
    await postTransaction(db, {
      idempotencyKey: unique('drain'), type: 'test.withdraw-route.drain',
      entries: [
        { account: account.id, delta: -player.startingKeep },
        { account: sys.emission_pool, delta: player.startingKeep },
      ],
    });
    const rejected = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant }, payload: instantBody(intent, code, authorization),
    });
    expect(rejected.statusCode).toBe(422);
    expect(await rowsFor(player.wallet)).toHaveLength(0);
    expect((await db.select({ step: players.totpLastUsedStep }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.step).toBeNull();

    // Restore the reviewed balance through the ledger. The SAME code remains
    // usable, and its consume commits with the one escrow freeze.
    await fundTestKeep(
      db, player.wallet, player.startingKeep, 'test.withdraw-route.restore', unique('restore'),
    );
    const transferBefore = transfers.length;
    const accepted = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant }, payload: instantBody(intent, code, authorization),
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ status: 'unbonding', amount: '1000', feeBurned: '20' });
    expect((await db.select({ step: players.totpLastUsedStep }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.step).not.toBeNull();
    expect(await balance(player.wallet)).toBe(player.startingKeep - 1_000n);
    expect(await rowsFor(player.wallet)).toHaveLength(1);
    expect(transfers).toHaveLength(transferBefore);
  });

  it('reports factor maturity separately from operational instant availability', async () => {
    // WHY: a mature authenticator is an account fact, while the signer kill
    // switch is an operational fact. The UI must not call instant payouts
    // available when only the first is true.
    const player = await fundedLandowner();
    const enabled = await app.inject({
      method: 'GET', url: '/2fa/status', cookies: { [SESSION_COOKIE]: player.cookie },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      totpEnabled: true, instantEligible: true, instantWithdrawalsEnabled: true,
    });

    const disabledApp = await buildApp(TEST_CONFIG, db, {
      emailSender, reserveReader: coveredReserve, instantWithdrawalsEnabled: false,
    });
    await disabledApp.ready();
    try {
      const disabled = await disabledApp.inject({
        method: 'GET', url: '/2fa/status', cookies: { [SESSION_COOKIE]: player.cookie },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({
        totpEnabled: true, instantEligible: true, instantWithdrawalsEnabled: false,
      });

      const prepare = await disabledApp.inject({
        method: 'POST', url: '/withdrawals/prepare',
        cookies: { [SESSION_COOKIE]: player.cookie },
        payload: {
          amount: '1000', destination: destination(),
          idempotencyKey: unique('ops-disabled'), instant: true,
        },
      });
      expect(prepare.statusCode).toBe(503);
    } finally {
      await disabledApp.close();
    }
  });

  it('production-style signer isolation authorizes and queues instant payout without an inline sender', async () => {
    const queuedApp = await buildApp(TEST_CONFIG, db, {
      emailSender,
      reserveReader: coveredReserve,
      instantWithdrawalsEnabled: true,
      // Deliberately no keepSender: production API has no key mount. The worker
      // owns signing and sees this row immediately because unbondsAt is now.
    });
    await queuedApp.ready();
    try {
      const player = await fundedLandowner();
      const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('worker-queued') };
      const { grant, authorization } = await recentGrant(player, intent);
      const code = totpCodeFor(player);
      const sendsBefore = transfers.length;

      const accepted = await queuedApp.inject({
        method: 'POST', url: '/withdrawals',
        cookies: { [SESSION_COOKIE]: player.cookie },
        headers: { [RECENT_AUTH_HEADER]: grant }, payload: instantBody(intent, code, authorization),
      });

      expect(accepted.statusCode).toBe(201);
      expect(accepted.json()).toMatchObject({ status: 'unbonding', amount: '1000' });
      expect(new Date(accepted.json().unbondsAt).getTime()).toBeLessThanOrEqual(Date.now());
      expect(transfers).toHaveLength(sendsBefore);
      expect(await rowsFor(player.wallet)).toEqual([
        expect.objectContaining({ status: 'unbonding', destination: intent.destination }),
      ]);
      expect((await db.select({ step: players.totpLastUsedStep }).from(players)
        .where(eq(players.wallet, player.wallet)))[0]?.step).not.toBeNull();

      // This production-isolation fixture intentionally leaves an instant row
      // immediately due. Remove only its own row after proving the queue shape,
      // otherwise a later worker test can pay it and count a second transfer.
      await cancelWithdrawal(db, player.wallet, accepted.json().id);
    } finally {
      await queuedApp.close();
    }
  });

  it('returns the same instant withdrawal on an exact retry without a second debit, factor consume or send', async () => {
    const player = await fundedLandowner();
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('retry') };
    const { grant, authorization } = await recentGrant(player, intent);
    const code = totpCodeFor(player);
    const request = {
      method: 'POST' as const, url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant }, payload: instantBody(intent, code, authorization),
    };

    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    const afterFirst = await balance(player.wallet);
    const sendsAfterFirst = transfers.length;
    const consumedStep = (await db.select({ step: players.totpLastUsedStep }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]!.step;

    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    expect(await balance(player.wallet)).toBe(afterFirst);
    expect(await rowsFor(player.wallet)).toHaveLength(1);
    expect(transfers).toHaveLength(sendsAfterFirst);
    expect((await db.select({ step: players.totpLastUsedStep }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]!.step).toEqual(consumedStep);
  });

  it('cannot upgrade a standard idempotent row to instant with a fake factor code', async () => {
    // HIGH regression: the old duplicate branch returned the standard row before
    // authorize, after which `instant:true` inline-paid it. A valid fresh-wallet
    // grant and schema-valid fake code make this non-vacuous: mode binding, not
    // an earlier auth/body failure, must stop the payout.
    const player = await fundedLandowner();
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('standard-upgrade') };
    const {
      grant: standardGrant, authorization: standardAuthorization,
    } = await recentGrant(player, intent, false);
    const standard = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: standardGrant },
      payload: { ...intent, authorization: standardAuthorization },
    });
    expect(standard.statusCode).toBe(201);
    expect(standard.json().status).toBe('unbonding');
    const { grant, authorization } = await recentGrant(player, intent);
    const sendsBefore = transfers.length;

    // Both review surfaces must preflight the mode they are about to authorize.
    // If either silently preflights as standard, this existing standard anchor
    // looks exact and the UI proceeds to a signature/code it can never use.
    const prepare = await app.inject({
      method: 'POST', url: '/withdrawals/prepare',
      cookies: { [SESSION_COOKIE]: player.cookie }, payload: { ...intent, instant: true },
    });
    expect(prepare.statusCode).toBe(409);
    expect(prepare.json().error.message).toMatch(/different withdrawal mode/);

    const upgrade = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant },
      payload: instantBody(intent, '000000', authorization),
    });

    expect(upgrade.statusCode).toBe(409);
    expect(upgrade.json().error.message).toMatch(/different withdrawal mode/);
    expect(transfers).toHaveLength(sendsBefore);
    expect(await balance(player.wallet)).toBe(player.startingKeep - 1_000n);
    expect(await rowsFor(player.wallet)).toEqual([
      expect.objectContaining({ id: standard.json().id, status: 'unbonding' }),
    ]);
    expect((await db.select({ step: players.totpLastUsedStep }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.step).toBeNull();
  });

  it('rejects the reverse instant-to-standard idempotency mode mismatch', async () => {
    const player = await fundedLandowner();
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('instant-downgrade') };
    const { grant, authorization } = await recentGrant(player, intent);
    const code = totpCodeFor(player);
    const instant = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant }, payload: instantBody(intent, code, authorization),
    });
    expect(instant.statusCode).toBe(201);
    expect(instant.json().status).toBe('unbonding');
    const afterInstant = await balance(player.wallet);
    const sendsAfterInstant = transfers.length;

    const exactPrepare = await app.inject({
      method: 'POST', url: '/withdrawals/prepare',
      cookies: { [SESSION_COOKIE]: player.cookie }, payload: { ...intent, instant: true },
    });
    expect(exactPrepare.statusCode).toBe(200);
    expect(exactPrepare.json()).toEqual(exactIntent(intent, true));

    const {
      grant: standardGrant, authorization: standardAuthorization,
    } = await recentGrant(player, intent, false);
    const downgrade = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: standardGrant },
      payload: { ...intent, authorization: standardAuthorization },
    });

    expect(downgrade.statusCode).toBe(409);
    expect(downgrade.json().error.message).toMatch(/different withdrawal mode/);
    expect(await balance(player.wallet)).toBe(afterInstant);
    expect(transfers).toHaveLength(sendsAfterInstant);
    expect(await rowsFor(player.wallet)).toEqual([
      expect.objectContaining({ id: instant.json().id, status: 'unbonding' }),
    ]);
  });

  it('requires exact wallet proof on the standard route and applies the 24h unbonding window', async () => {
    const player = await fundedLandowner();
    const intent = { amount: '1000', destination: destination(), idempotencyKey: unique('standard') };
    const before = Date.now();
    const sendsBefore = transfers.length;
    const missing = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie }, payload: intent,
    });
    expect(missing.statusCode).toBe(400);
    const { grant, authorization } = await recentGrant(player, intent, false);

    const response = await app.inject({
      method: 'POST', url: '/withdrawals',
      cookies: { [SESSION_COOKIE]: player.cookie },
      headers: { [RECENT_AUTH_HEADER]: grant },
      payload: { ...intent, authorization },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'unbonding', amount: '1000', feeBurned: '20' });
    const unbondsAt = new Date(response.json().unbondsAt).getTime();
    const expected = ECONOMY.unbondingHours * 3_600_000;
    expect(unbondsAt).toBeGreaterThanOrEqual(before + expected - 1_000);
    expect(unbondsAt).toBeLessThanOrEqual(Date.now() + expected + 1_000);
    expect(await balance(player.wallet)).toBe(player.startingKeep - 1_000n);
    expect(transfers).toHaveLength(sendsBefore);
    expect(delivered.some((entry) => entry.to === player.email)).toBe(false);
    const [proof] = await db.select().from(withdrawalAuthorizations)
      .where(eq(withdrawalAuthorizations.withdrawalId, response.json().id));
    expect(proof).toMatchObject({
      challengeToken: authorization.challengeToken,
      walletSignature: authorization.signature,
      cluster: 'devnet', keepMint: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC',
      validatedDigest: null, validatedAt: null,
    });
    const [frozen] = await db.select().from(withdrawals)
      .where(eq(withdrawals.id, response.json().id));
    const verdict = await makeWithdrawalAuthorizationGate(TEST_CONFIG, db)(frozen!);
    expect(verdict).toMatchObject({
      ok: true, cluster: 'devnet',
      keepMint: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((await db.select().from(withdrawalAuthorizations)
      .where(eq(withdrawalAuthorizations.withdrawalId, response.json().id)))[0])
      .toMatchObject({ validatedDigest: verdict.ok ? verdict.digest : null, validatedAt: expect.any(Date) });
  });
});
