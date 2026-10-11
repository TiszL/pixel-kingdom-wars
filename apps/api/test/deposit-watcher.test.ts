import { requiredFixture } from './helpers';
/**
 * R9 entry-flow tests (ECONOMY.md §5).
 *
 * WHY: the 0.2 SOL entry is the game's paywall — if the gate leaks, bases are
 * free; if the watcher over-credits, payments mint bases for the wrong wallet;
 * if it under-credits, paying players are locked out. So we pin: (1) game
 * routes 402 until the credit, (2) a verified finalized payment — and ONLY a
 * matching one — creates base + plot exactly once, (3) unpaid states can't
 * reach the lazy plot-assign leak, (4) stale unpaid intents expire.
 *
 * The chain verifier is injected (house seam convention — no RPC in unit
 * tests); the real verifier runs against devnet in the e2e pass.
 */
import { DEPOSIT_VERIFICATION, ECONOMY, TOKEN, WARZONE, WORLD } from '@shardkeep/shared';
import { CORE_PROGRAM_ID, playerPda } from '@shardkeep/chain';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { createDb } from '../src/db/client';
import {
  bases, builderJobs, buildings, deposits, players, plotReservations, plots, valleys,
} from '../src/db/schema';
import { globeContext } from '../src/game/globe';
import { getMapChunk } from '../src/game/world';
import { globeCacheLoads, resetGlobeCache } from '../src/lib/globeCache';
import { mapCacheLoads, resetMapCache } from '../src/lib/mapCache';
import { rewardBaseShards } from '../src/game/baseEconomy';
import {
  createDepositIntent, withDepositVerificationDeadline, type DepositPaymentCommitVerifier,
} from '../src/money/deposits';
import { NATIVE_SOL_MINT, depositMint } from '../src/money/mintDimension';
import {
  depositVerificationFetch, DepositVerificationIndeterminateError, makeChainDepositVerifier,
  makeDepositRpcConnection,
  makeWarzoneShieldVerifier,
  pollPendingDeposits, requireMatchingDepositCommitVerifiers, requireMatchingDepositVerifiers,
  selectProgramPaymentCandidate, verifyDepositNow, WARZONE_SHIELD_KIND,
  type DepositVerifier, type PendingDeposit,
} from '../src/money/depositWatcher';
import { TEST_CONFIG, connectTestDb, createTestPlayer, fundTestKeep } from './helpers';
import { TEST_DATABASE_URL } from './db-url';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;
const db = () => conn.db;

// Injected on-demand verifier (no RPC in unit tests): POST /deposits/:id/verify
// credits a reference present in this map. Mirrors the production seam.
const verifyMap = new Map<string, { wallet: string; sig: string }>();
const injectedVerifier: DepositVerifier = async (dep: PendingDeposit) => {
  const hit = verifyMap.get(dep.reference);
  if (!hit) return null;
  return { txSignature: hit.sig, wallet: hit.wallet, kind: dep.kind, lamports: 200_000_000n, finalized: true };
};
const commitProofs = new Map<string, {
  wallet: string; reference: string; kind: string; lamports?: bigint;
  hold?: () => Promise<void>;
}>();
const injectedCommitVerifier: DepositPaymentCommitVerifier = async (dep) => {
  const proof = commitProofs.get(dep.paymentSignature);
  await proof?.hold?.();
  return proof?.wallet === dep.playerWallet && proof.reference === dep.reference
    && proof.kind === dep.kind && (proof.lamports === undefined || proof.lamports === dep.expectedLamports)
    ? { txSignature: dep.paymentSignature } : null;
};

describe('independent money-RPC agreement', () => {
  const dep: PendingDeposit = {
    id: '00000000-0000-4000-8000-000000000001',
    playerWallet: Keypair.generate().publicKey.toBase58(),
    kind: 'entry',
    reference: Keypair.generate().publicKey.toBase58(),
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
  };
  const payment = {
    txSignature: 'same-finalized-signature', wallet: dep.playerWallet,
    kind: dep.kind, lamports: 200_000_000n, finalized: true as const,
  };

  it('credits only when both finalized providers return the same proof', async () => {
    const verifier = requireMatchingDepositVerifiers(
      async () => payment,
      async () => ({ ...payment }),
    );
    await expect(verifier(dep)).resolves.toEqual(payment);
  });

  it('holds when finalized providers disagree instead of crediting or expiring', async () => {
    const verifier = requireMatchingDepositVerifiers(
      async () => payment,
      async () => null,
    );
    await expect(verifier(dep)).rejects.toThrow(/independent RPCs disagree/);
  });

  it('pins a submitted signature only when both providers see it', async () => {
    const proof = { txSignature: 'same-confirmed-signature' };
    const verifier = requireMatchingDepositCommitVerifiers(
      async () => proof,
      async () => ({ ...proof }),
    );
    await expect(verifier({
      ...dep, paymentSignature: proof.txSignature,
    })).resolves.toEqual(proof);
  });
});

const PLAYER_ACCOUNT_DISCRIMINATOR = Uint8Array.from([205, 222, 112, 7, 165, 155, 206, 218]);

function playerAccountData(wallet: PublicKey, bump: number): Buffer {
  const data = Buffer.alloc(51);
  data.set(PLAYER_ACCOUNT_DISCRIMINATOR, 0);
  data.set(wallet.toBuffer(), 8);
  data.writeBigInt64LE(1_700_000_000n, 40);
  data[48] = 1;
  data[49] = 0;
  data[50] = bump;
  return data;
}

function playerAccountInfo(
  wallet: PublicKey,
  overrides: Partial<AccountInfo<Buffer>> = {},
): AccountInfo<Buffer> {
  const [, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from('player'), wallet.toBuffer()], CORE_PROGRAM_ID,
  );
  return {
    data: playerAccountData(wallet, bump),
    executable: false,
    lamports: 1_000_000,
    owner: CORE_PROGRAM_ID,
    rentEpoch: 0,
    ...overrides,
  };
}

function entryPdaVerifier(
  wallet: PublicKey,
  account: AccountInfo<Buffer> | null,
): { verify: DepositVerifier; getAccountInfo: ReturnType<typeof vi.fn> } {
  const getAccountInfo = vi.fn(async () => account);
  const connection = {
    getSignaturesForAddress: vi.fn(async () => []),
    getAccountInfo,
  } as unknown as Connection;
  return {
    verify: makeChainDepositVerifier(connection, () => []),
    getAccountInfo,
  };
}

function entryPdaIntent(wallet: PublicKey): PendingDeposit {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    playerWallet: wallet.toBase58(),
    kind: 'entry',
    reference: Keypair.generate().publicKey.toBase58(),
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
  };
}

describe('finalized Player-PDA entry recovery', () => {
  it('accepts only the canonical shardkeep-core Player account for the intended wallet', async () => {
    const wallet = Keypair.generate().publicKey;
    const account = playerAccountInfo(wallet);
    const { verify, getAccountInfo } = entryPdaVerifier(wallet, account);

    await expect(verify(entryPdaIntent(wallet))).resolves.toEqual({
      txSignature: `pda:${wallet.toBase58()}`,
      wallet: wallet.toBase58(),
      kind: 'entry',
      lamports: 200_000_000n,
      finalized: true,
    });
    expect(getAccountInfo).toHaveBeenCalledWith(playerPda(wallet), 'finalized');
  });

  it('rejects a 1-lamport system-owned prefund at the canonical PDA', async () => {
    const wallet = Keypair.generate().publicKey;
    const prefund = playerAccountInfo(wallet, {
      data: Buffer.alloc(0), lamports: 1, owner: SystemProgram.programId,
    });
    await expect(entryPdaVerifier(wallet, prefund).verify(entryPdaIntent(wallet))).resolves.toBeNull();
  });

  it('rejects an account owned by a program other than reviewed shardkeep-core', async () => {
    const wallet = Keypair.generate().publicKey;
    const foreign = playerAccountInfo(wallet, { owner: Keypair.generate().publicKey });
    await expect(entryPdaVerifier(wallet, foreign).verify(entryPdaIntent(wallet))).resolves.toBeNull();
  });

  it.each([
    ['wrong discriminator', (data: Buffer) => {
      data[0] = data[0]! ^ 0xff;
      return data;
    }],
    ['wrong exact size', (data: Buffer) => data.subarray(0, data.length - 1)],
  ])('rejects Player account data with %s', async (_label, corrupt) => {
    const wallet = Keypair.generate().publicKey;
    const original = playerAccountInfo(wallet);
    const corrupted = corrupt(Buffer.from(original.data));
    const account = { ...original, data: corrupted };
    await expect(entryPdaVerifier(wallet, account).verify(entryPdaIntent(wallet))).resolves.toBeNull();
  });

  it('rejects a valid-looking Player account decoded for a different wallet', async () => {
    const intended = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const account = playerAccountInfo(intended);
    account.data.set(other.toBuffer(), 8);
    await expect(entryPdaVerifier(intended, account).verify(entryPdaIntent(intended))).resolves.toBeNull();
  });

  it('rejects a Player account whose stored bump is not the canonical PDA bump', async () => {
    const wallet = Keypair.generate().publicKey;
    const account = playerAccountInfo(wallet);
    account.data[50] = (account.data[50]! + 1) & 0xff;
    await expect(entryPdaVerifier(wallet, account).verify(entryPdaIntent(wallet))).resolves.toBeNull();
  });
});

beforeAll(async () => {
  conn = connectTestDb();
  process.env['DEV_LOGIN'] = 'true'; // dev-login registers at build time (route is double-gated)
  app = await buildApp(TEST_CONFIG, conn.db, {
    depositVerifier: injectedVerifier, depositPaymentCommitVerifier: injectedCommitVerifier,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

/** Full SIWS login for a fresh throwaway key; returns wallet + session cookie. */
async function login() {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = ch.json() as { message: string };
  const sig = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature: sig } });
  expect(verify.statusCode).toBe(200);
  const cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return { wallet, cookie, entryPaid: (verify.json() as { entryPaid: boolean }).entryPaid };
}

/** Verifier that "finds" a finalized pay_entry for exactly the given intents. */
const verifierFor = (byReference: Map<string, { wallet: string; sig: string }>): DepositVerifier =>
  async (dep: PendingDeposit) => {
    const hit = byReference.get(dep.reference);
    if (!hit) return null;
    return {
      txSignature: hit.sig,
      wallet: hit.wallet,
      kind: dep.kind,
      lamports: 200_000_000n,
      finalized: true,
    };
  };

function controlledBarrier() {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, hold: async () => { markReached(); await wait; } };
}

describe('frozen-quote payment selection', () => {
  it('does not let another authenticated wallet squat a victim exact payment signature', async () => {
    const victim = await login();
    const attacker = await login();
    const victimIntent = await createDepositIntent(db(), victim.wallet, 'keep_deposit');
    const attackerIntent = await createDepositIntent(db(), attacker.wallet, 'keep_deposit');
    const signature = bs58.encode(new Uint8Array(64).fill(23));
    commitProofs.set(signature, {
      wallet: victim.wallet, reference: victimIntent.reference, kind: 'keep_deposit',
    });

    const squat = await app.inject({
      method: 'POST', url: `/deposits/${attackerIntent.id}/paid`,
      cookies: { [SESSION_COOKIE]: attacker.cookie }, payload: { signature },
    });
    expect(squat.statusCode).toBe(422);
    const victimCommit = await app.inject({
      method: 'POST', url: `/deposits/${victimIntent.id}/paid`,
      cookies: { [SESSION_COOKIE]: victim.cookie }, payload: { signature },
    });
    expect(victimCommit.statusCode).toBe(200);
    expect((await db().select({ paymentSignature: deposits.paymentSignature }).from(deposits)
      .where(eq(deposits.id, attackerIntent.id)))[0]?.paymentSignature).toBeNull();
    expect((await db().select({ paymentSignature: deposits.paymentSignature }).from(deposits)
      .where(eq(deposits.id, victimIntent.id)))[0]?.paymentSignature).toBe(signature);
    commitProofs.delete(signature);
  });

  it('never TTL-expires an exact confirmed payment while it waits for finality, then credits once', async () => {
    const account = await login();
    const createdAt = new Date('2026-08-12T02:00:00.000Z');
    const intent = await createDepositIntent(db(), account.wallet, 'keep_deposit', undefined, createdAt);
    const signature = bs58.encode(new Uint8Array(64).fill(24));
    await db().update(deposits).set({ paymentSignature: signature, createdAt })
      .where(eq(deposits.id, intent.id));
    const afterTtl = new Date(createdAt.getTime() + (ECONOMY.depositPendingTtlMin + 1) * 60_000);

    await expect(verifyDepositNow(
      db(), async () => null, account.wallet, intent.id, afterTtl,
    )).resolves.toEqual({ action: 'none' });
    expect((await db().select({ status: deposits.status }).from(deposits)
      .where(eq(deposits.id, intent.id)))[0]?.status).toBe('pending');

    const finalized: DepositVerifier = async (dep) => ({
      txSignature: signature, wallet: dep.playerWallet, kind: dep.kind,
      lamports: 25n * 10n ** BigInt(TOKEN.decimals), finalized: true,
    });
    await expect(verifyDepositNow(db(), finalized, account.wallet, intent.id, afterTtl))
      .resolves.toEqual({ action: 'credited' });
    await expect(verifyDepositNow(db(), finalized, account.wallet, intent.id, afterTtl))
      .resolves.toEqual({ action: 'none' });
  });

  it('credits with a one-connection pool (shared verification never nests pool acquisition)', async () => {
    const single = createDb(TEST_DATABASE_URL, { max: 1 });
    try {
      const account = await login();
      const intent = await createDepositIntent(single.db, account.wallet, 'keep_deposit');
      const signature = bs58.encode(new Uint8Array(64).fill(30));
      const finalized: DepositVerifier = async (dep) => ({
        txSignature: signature, wallet: dep.playerWallet, kind: dep.kind,
        lamports: 1n * 10n ** BigInt(TOKEN.decimals), finalized: true,
      });
      await expect(verifyDepositNow(single.db, finalized, account.wallet, intent.id))
        .resolves.toEqual({ action: 'credited' });
    } finally {
      await single.sql.end();
    }
  });

  it('credits a pool-sized positive batch without outer/inner connection starvation', async () => {
    const poolSize = 3;
    const saturated = createDb(TEST_DATABASE_URL, { max: poolSize });
    try {
      const fixtures = await Promise.all(Array.from({ length: poolSize }, async (_, index) => {
        const account = await login();
        const intent = await createDepositIntent(saturated.db, account.wallet, 'keep_deposit');
        return { account, intent, signature: bs58.encode(new Uint8Array(64).fill(31 + index)) };
      }));
      const credits = Promise.all(fixtures.map(({ account, intent, signature }) => (
        verifyDepositNow(saturated.db, async (dep) => ({
          txSignature: signature, wallet: dep.playerWallet, kind: dep.kind,
          lamports: 1n * 10n ** BigInt(TOKEN.decimals), finalized: true,
        }), account.wallet, intent.id)
      )));
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('pool-sized deposit credits deadlocked')), 5_000);
      });
      await expect(Promise.race([credits, timeout])).resolves.toEqual(
        Array.from({ length: poolSize }, () => ({ action: 'credited' })),
      );
    } finally {
      await saturated.sql.end();
    }
  });

  it('bounds in-flight verifier callbacks below the DB pool and releases queued work', async () => {
    const fixtures = await Promise.all(Array.from(
      { length: DEPOSIT_VERIFICATION.concurrency + 1 },
      async () => {
        const account = await login();
        const intent = await createDepositIntent(db(), account.wallet, 'keep_deposit');
        return { account, intent };
      },
    ));
    let entered = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const verifications = fixtures.map(({ account, intent }) => verifyDepositNow(
      db(), async () => { entered++; await wait; return null; }, account.wallet, intent.id,
    ));
    try {
      while (entered < DEPOSIT_VERIFICATION.concurrency) await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(entered).toBe(DEPOSIT_VERIFICATION.concurrency);
    } finally {
      release();
    }
    await expect(Promise.all(verifications)).resolves.toHaveLength(fixtures.length);
    expect(entered).toBe(fixtures.length);
  });

  it('aborts a deposit RPC fetch at the hard deadline', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    ));
    try {
      const request = makeDepositRpcConnection('https://rpc.invalid').getSlot('finalized');
      const rejected = expect(request).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(DEPOSIT_VERIFICATION.rpcTimeoutMs);
      await rejected;
      expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('aborts the whole paginated RPC attempt and never starts a later page', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let secondAborted = false;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => {
          secondAborted = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    try {
      const attempt = withDepositVerificationDeadline(async () => {
        await depositVerificationFetch('https://rpc.invalid', { method: 'POST' });
        await depositVerificationFetch('https://rpc.invalid', { method: 'POST' });
        await depositVerificationFetch('https://rpc.invalid', { method: 'POST' });
      }, 'deposit verification attempt timed out');
      const rejected = expect(attempt).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(DEPOSIT_VERIFICATION.rpcTimeoutMs);
      await rejected;
      expect(secondAborted).toBe(true);
      expect(calls).toBe(2);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('/paid commit winning a stale watcher race prevents terminal expiry', async () => {
    const account = await login();
    const intent = await createDepositIntent(db(), account.wallet, 'keep_deposit');
    const createdAt = new Date(Date.now() - (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    await db().update(deposits).set({ createdAt }).where(eq(deposits.id, intent.id));
    const signature = bs58.encode(new Uint8Array(64).fill(26));
    commitProofs.set(signature, {
      wallet: account.wallet, reference: intent.reference, kind: 'keep_deposit',
    });
    const barrier = controlledBarrier();
    const staleExpiry = verifyDepositNow(db(), async () => {
      await barrier.hold();
      return null;
    }, account.wallet, intent.id, new Date());

    await barrier.reached;
    const paidRequest = app.inject({
      method: 'POST', url: `/deposits/${intent.id}/paid`,
      cookies: { [SESSION_COOKIE]: account.cookie }, payload: { signature },
    });
    let paid: Awaited<typeof paidRequest>;
    try {
      paid = await Promise.race([
        paidRequest,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('/paid was blocked by a shared negative scan')), 1_000,
        )),
      ]);
    } finally {
      barrier.release();
    }
    commitProofs.delete(signature);

    expect(paid.statusCode).toBe(200);
    await expect(staleExpiry).resolves.toEqual({ action: 'none' });
    const [row] = await db().select({
      status: deposits.status, paymentSignature: deposits.paymentSignature,
    }).from(deposits).where(eq(deposits.id, intent.id));
    expect(row).toEqual({ status: 'pending', paymentSignature: signature });
  });

  it('/paid holds serialization locks across exact proof so expiry cannot win mid-confirmation', async () => {
    const account = await login();
    const intent = await createDepositIntent(db(), account.wallet, 'keep_deposit');
    const createdAt = new Date(Date.now() - (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    await db().update(deposits).set({ createdAt }).where(eq(deposits.id, intent.id));
    const signature = bs58.encode(new Uint8Array(64).fill(28));
    const proofBarrier = controlledBarrier();
    commitProofs.set(signature, {
      wallet: account.wallet, reference: intent.reference, kind: 'keep_deposit',
      hold: proofBarrier.hold,
    });
    const paidRequest = app.inject({
      method: 'POST', url: `/deposits/${intent.id}/paid`,
      cookies: { [SESSION_COOKIE]: account.cookie }, payload: { signature },
    });

    await proofBarrier.reached;
    let sharedLockAcquired = false;
    try {
      await db().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(
          hashtext(${'deposit-verification:' + intent.id})
        )`);
        sharedLockAcquired = true;
      });
    } catch {}
    let markExpiryChecked!: () => void;
    const expiryChecked = new Promise<void>((resolve) => { markExpiryChecked = resolve; });
    const staleExpiry = verifyDepositNow(db(), async () => {
      markExpiryChecked();
      return null;
    }, account.wallet, intent.id, new Date());
    await expiryChecked;
    try {
      let terminalSettled = false;
      void staleExpiry.then(() => { terminalSettled = true; });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(terminalSettled).toBe(false);
    } finally {
      proofBarrier.release();
    }
    const [paid, expiry] = await Promise.all([paidRequest, staleExpiry]);
    commitProofs.delete(signature);

    expect(sharedLockAcquired).toBe(true);
    expect(paid.statusCode).toBe(200);
    expect(expiry).toEqual({ action: 'none' });
    const [row] = await db().select({
      status: deposits.status, paymentSignature: deposits.paymentSignature,
    }).from(deposits).where(eq(deposits.id, intent.id));
    expect(row).toEqual({ status: 'pending', paymentSignature: signature });
  });

  it('finalized credit winning an expiry interleaving remains terminal and deadlock-free', async () => {
    const account = await login();
    const intent = await createDepositIntent(db(), account.wallet, 'keep_deposit');
    const createdAt = new Date(Date.now() - (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    await db().update(deposits).set({ createdAt }).where(eq(deposits.id, intent.id));
    const signature = bs58.encode(new Uint8Array(64).fill(27));
    const barrier = controlledBarrier();
    const staleExpiry = verifyDepositNow(db(), async () => {
      await barrier.hold();
      return null;
    }, account.wallet, intent.id, new Date());

    await barrier.reached;
    const finalized: DepositVerifier = async (dep) => ({
      txSignature: signature, wallet: dep.playerWallet, kind: dep.kind,
      lamports: 1n * 10n ** BigInt(TOKEN.decimals), finalized: true,
    });
    try {
      await expect(verifyDepositNow(db(), finalized, account.wallet, intent.id, new Date()))
        .resolves.toEqual({ action: 'credited' });
    } finally {
      barrier.release();
    }

    await expect(staleExpiry).resolves.toEqual({ action: 'none' });
    const [row] = await db().select({
      status: deposits.status, txSignature: deposits.txSignature,
    }).from(deposits).where(eq(deposits.id, intent.id));
    expect(row).toEqual({ status: 'credited', txSignature: signature });
  });

  it('finalized verification lease prevents a stale negative scan from expiring first', async () => {
    const account = await login();
    const intent = await createDepositIntent(db(), account.wallet, 'keep_deposit');
    const createdAt = new Date(Date.now() - (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    await db().update(deposits).set({ createdAt }).where(eq(deposits.id, intent.id));
    const signature = bs58.encode(new Uint8Array(64).fill(29));
    const positiveBarrier = controlledBarrier();
    const positive = verifyDepositNow(db(), async (dep) => {
      await positiveBarrier.hold();
      return {
        txSignature: signature, wallet: dep.playerWallet, kind: dep.kind,
        lamports: 1n * 10n ** BigInt(TOKEN.decimals), finalized: true,
      };
    }, account.wallet, intent.id, new Date());

    await positiveBarrier.reached;
    let markNegativeReached!: () => void;
    const negativeReached = new Promise<void>((resolve) => { markNegativeReached = resolve; });
    const staleNegative = verifyDepositNow(db(), async () => {
      markNegativeReached();
      return null;
    }, account.wallet, intent.id, new Date());
    let negativeSettled = false;
    void staleNegative.then(() => { negativeSettled = true; });
    try {
      await Promise.race([
        negativeReached,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('concurrent negative verifier did not start')), 1_000,
        )),
      ]); // shared scans may coexist
      expect(negativeSettled).toBe(false); // exclusive terminalization waits
    } finally {
      positiveBarrier.release();
    }

    await expect(positive).resolves.toEqual({ action: 'credited' });
    await expect(staleNegative).resolves.toEqual({ action: 'none' });
    const [row] = await db().select({
      status: deposits.status, txSignature: deposits.txSignature,
    }).from(deposits).where(eq(deposits.id, intent.id));
    expect(row).toEqual({ status: 'credited', txSignature: signature });
  });

  it('does not terminal-fail a payment signature already reserved by another deposit', async () => {
    const victim = await login();
    const attacker = await login();
    const createdAt = new Date('2026-08-12T03:00:00.000Z');
    const signature = bs58.encode(new Uint8Array(64).fill(25));
    const protectedIntent = await createDepositIntent(db(), victim.wallet, 'keep_deposit', undefined, createdAt);
    const conflictingIntent = await createDepositIntent(db(), attacker.wallet, 'keep_deposit', undefined, createdAt);
    // Generic intent rows use the database clock. Freeze this fixture explicitly:
    // the conflict path is reached only after TTL, and a wall-clock-dependent age
    // can otherwise turn the assertion into a no-op during a later full-suite run.
    await db().update(deposits).set({ createdAt }).where(eq(deposits.id, conflictingIntent.id));
    await db().update(deposits).set({ paymentSignature: signature })
      .where(eq(deposits.id, protectedIntent.id));
    const afterTtl = new Date(createdAt.getTime() + (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    const conflicting: DepositVerifier = async (dep) => ({
      txSignature: signature, wallet: dep.playerWallet, kind: dep.kind,
      lamports: 1n, finalized: true,
    });
    await expect(verifyDepositNow(
      db(), conflicting, attacker.wallet, conflictingIntent.id, afterTtl,
    )).rejects.toMatchObject({ statusCode: 409 });
    expect((await db().select({ status: deposits.status }).from(deposits)
      .where(eq(deposits.id, conflictingIntent.id)))[0]?.status).toBe('pending');
  });

  it('does not let an under/over retry shadow an exact builder payment', () => {
    const under = { txSignature: 'under', lamports: 499_999_999n };
    const exact = { txSignature: 'exact', lamports: 500_000_000n };
    const over = { txSignature: 'over', lamports: 500_000_001n };

    expect(selectProgramPaymentCandidate([under, exact, over], exact.lamports)).toBe(exact);
    expect(selectProgramPaymentCandidate([over, exact, under], exact.lamports)).toBe(exact);
  });

  it('keeps the highest wrong attempt visible when no exact payment exists', () => {
    const under = { txSignature: 'under', lamports: 499_999_999n };
    const over = { txSignature: 'over', lamports: 500_000_001n };
    expect(selectProgramPaymentCandidate([under, over], 500_000_000n)).toBe(over);
  });

  it('finds an exact program payment at position 17 across paginated retries', async () => {
    const reference = Keypair.generate().publicKey.toBase58();
    const wallet = Keypair.generate().publicKey.toBase58();
    const wrong = Array.from({ length: 16 }, (_, i) => ({
      signature: `wrong-${i}`, err: null, blockTime: 2_000,
    }));
    const connection = {
      getSignaturesForAddress: vi.fn(async (_ref, opts: { before?: string }) => (
        opts.before ? [{ signature: 'exact-17', err: null, blockTime: 2_000 }] : wrong
      )),
      getTransaction: vi.fn(async (signature: string) => ({
        meta: { err: null, logMessages: [signature] },
      })),
    } as unknown as Connection;
    const parseEvents = (logs: string[]) => [{
      reference, wallet, kind: 1,
      lamports: logs[0] === 'exact-17' ? 500_000_000n : 499_999_999n,
    }];
    const verifier = makeChainDepositVerifier(connection, parseEvents);
    await expect(verifier({
      id: 'position-17', playerWallet: wallet, kind: 'builder', reference,
      createdAt: new Date(1_999_000), expectedLamports: 500_000_000n,
    })).resolves.toMatchObject({ txSignature: 'exact-17', lamports: 500_000_000n });
  });

  it.each([
    ['newer direct-only retry', ['wrong-direct', 'valid-two-leg']],
    ['older direct-only retry', ['valid-two-leg', 'wrong-direct']],
  ])('selects the valid warzone two-leg payment despite a %s', async (_label, signatures) => {
    const reference = Keypair.generate().publicKey.toBase58();
    const wallet = Keypair.generate().publicKey;
    const liquidity = Keypair.generate().publicKey;
    const total = BigInt(WARZONE.shieldCostSolLamports);
    const direct = (total * BigInt(WARZONE.shieldLiquidityDirectBps)) / 10_000n;
    const split = total - direct;
    const liquidityDelta = direct + (split * BigInt(ECONOMY.solSplitBps.liquidity)) / 10_000n;
    const connection = {
      getSignaturesForAddress: vi.fn(async () => signatures.map((signature) => ({
        signature, err: null, blockTime: 2_000,
      }))),
      getTransaction: vi.fn(async (signature: string) => ({
        transaction: { message: { staticAccountKeys: [wallet, new PublicKey(reference), liquidity] } },
        meta: {
          err: null,
          logMessages: [signature === 'valid-two-leg' ? 'valid' : 'direct-only'],
          preBalances: [20_000_000_000, 0, 1_000_000_000],
          postBalances: [10_000_000_000, 0, Number(1_000_000_000n + liquidityDelta)],
        },
      })),
    } as unknown as Connection;
    const parseEvents = (logs: string[]) => logs[0] === 'valid' ? [{
      reference, wallet: wallet.toBase58(), kind: WARZONE_SHIELD_KIND, lamports: split,
    }] : [];

    await expect(makeWarzoneShieldVerifier(connection, liquidity, parseEvents)({
      id: 'warzone-ordering', playerWallet: wallet.toBase58(), kind: 'warzone_shield', reference,
      createdAt: new Date(1_999_000), expectedLamports: total,
    })).resolves.toMatchObject({ txSignature: 'valid-two-leg', lamports: total });
  });

  it('keeps a stale intent pending when bounded history is indeterminate', async () => {
    const account = await login();
    const now = new Date('2026-08-12T00:00:00.000Z');
    await db().update(players).set({ entryPaidAt: now }).where(eq(players.wallet, account.wallet));
    const intent = await createDepositIntent(db(), account.wallet, 'builder', undefined, now);
    await db().update(deposits).set({
      createdAt: new Date(now.getTime() - (ECONOMY.depositPendingTtlMin + 1) * 60_000),
    }).where(eq(deposits.id, intent.id));
    const indeterminate: DepositVerifier = async (dep) => {
      throw new DepositVerificationIndeterminateError(dep.reference);
    };
    await expect(verifyDepositNow(
      db(), indeterminate, account.wallet, intent.id, now,
    )).rejects.toBeInstanceOf(DepositVerificationIndeterminateError);
    expect((await db().select({ status: deposits.status }).from(deposits)
      .where(eq(deposits.id, intent.id)))[0]?.status).toBe('pending');
  });

  it('propagates the frozen quote into verification and records wrong-only payments', async () => {
    const exactAccount = await login();
    const exactEpoch = new Date('2026-08-12T00:00:00.000Z');
    await db().update(players).set({ entryPaidAt: exactEpoch, builders: 1 })
      .where(eq(players.wallet, exactAccount.wallet));
    const exactIntent = await createDepositIntent(db(), exactAccount.wallet, 'builder');
    const exactVerifier: DepositVerifier = async (dep) => {
      expect(dep.expectedLamports).toBe(500_000_000n);
      return {
        txSignature: 'builder-exact-proof', wallet: dep.playerWallet, kind: dep.kind,
        lamports: dep.expectedLamports!, finalized: true,
      };
    };
    await expect(verifyDepositNow(
      db(), exactVerifier, exactAccount.wallet, exactIntent.id, exactEpoch,
    )).resolves.toEqual({ action: 'credited' });
    expect((await db().select({ builders: players.builders }).from(players)
      .where(eq(players.wallet, exactAccount.wallet)))[0]?.builders).toBe(2);

    const wrongAccount = await login();
    const wrongEpoch = new Date('2026-08-12T01:00:00.000Z');
    await db().update(players).set({ entryPaidAt: wrongEpoch, builders: 1 })
      .where(eq(players.wallet, wrongAccount.wallet));
    const wrongIntent = await createDepositIntent(db(), wrongAccount.wallet, 'builder', undefined, wrongEpoch);
    // Generic intent creation uses the database default timestamp; freeze this
    // row explicitly so the TTL assertion is independent of wall-clock suite time.
    await db().update(deposits).set({ createdAt: wrongEpoch }).where(eq(deposits.id, wrongIntent.id));
    const afterTtl = new Date(wrongEpoch.getTime() + (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    const wrongVerifier: DepositVerifier = async (dep) => ({
      txSignature: 'builder-wrong-proof', wallet: dep.playerWallet, kind: dep.kind,
      lamports: dep.expectedLamports! + 1n, finalized: true,
    });
    await expect(verifyDepositNow(
      db(), wrongVerifier, wrongAccount.wallet, wrongIntent.id, afterTtl,
    )).resolves.toEqual({ action: 'failed' });
    const [failed] = await db().select().from(deposits).where(eq(deposits.id, wrongIntent.id));
    expect(failed).toMatchObject({
      status: 'failed', txSignature: 'builder-wrong-proof', amount: 500_000_001n,
    });
    expect((await db().select({ builders: players.builders }).from(players)
      .where(eq(players.wallet, wrongAccount.wallet)))[0]?.builders).toBe(1);
  });
});

describe('R9 entry gate', () => {
  it('login no longer grants a base: game routes 402, deposit routes work', async () => {
    const { wallet, cookie, entryPaid } = await login();
    expect(entryPaid).toBe(false);

    // No base, no plot were created at login.
    expect(await db().select().from(buildings).where(eq(buildings.playerWallet, wallet))).toHaveLength(0);
    expect(await db().select().from(plots).where(eq(plots.playerWallet, wallet))).toHaveLength(0);

    // Gated routes answer 402 — including the lazy plot-assign leak (/map/me).
    for (const url of ['/base', '/mine/status', '/army', '/map/me', '/quests', '/heroes']) {
      const res = await app.inject({ url, cookies: { [SESSION_COOKIE]: cookie } });
      expect(res.statusCode, url).toBe(402);
    }

    // The unpaid player CAN mint and poll an entry intent.
    const dep = await app.inject({
      method: 'POST', url: '/deposits',
      cookies: { [SESSION_COOKIE]: cookie },
      payload: { kind: 'entry' },
    });
    expect(dep.statusCode).toBe(200);
    const intent = dep.json() as { id: string; reference: string };
    const poll = await app.inject({ url: `/deposits/${intent.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(poll.statusCode).toBe(200);
    expect((poll.json() as { status: string }).status).toBe('pending');
  });

  it('a verified finalized payment credits once, creates base + plot, opens the gate', async () => {
    const { wallet, cookie } = await login();
    const intent = await createDepositIntent(db(), wallet, 'entry');
    const verifier = verifierFor(new Map([[intent.reference, { wallet, sig: `sig-${intent.reference}` }]]));

    const pass1 = await pollPendingDeposits(db(), verifier);
    expect(pass1.credited).toBe(1);
    expect(pass1.errors).toBe(0);

    // entryPaidAt stamped; base (Keep) + plot exist NOW — and only now.
    const [p] = await db().select().from(players).where(eq(players.wallet, wallet));
    expect(p!.entryPaidAt).not.toBeNull();
    const built = await db().select().from(buildings)
      .where(and(eq(buildings.playerWallet, wallet), eq(buildings.type, 'keep')));
    expect(built).toHaveLength(1);
    const stable = await db().select().from(bases).where(eq(bases.ownerWallet, wallet));
    expect(stable).toHaveLength(1);
    expect(stable[0]?.landPaidAt).not.toBeNull();
    expect(built[0]?.baseId).toBe(stable[0]?.id);
    expect(await db().select().from(plots).where(eq(plots.playerWallet, wallet))).toHaveLength(1);

    // The gate opens without re-login (per-request lookup, not a JWT claim).
    const base = await app.inject({ url: '/base', cookies: { [SESSION_COOKIE]: cookie } });
    expect(base.statusCode).toBe(200);

    // Re-running the watcher is a no-op: the deposit is no longer pending.
    const pass2 = await pollPendingDeposits(db(), verifier);
    expect(pass2.credited).toBe(0);
    const [row] = await db().select().from(deposits).where(eq(deposits.id, intent.id));
    expect(row!.status).toBe('credited');
    expect(row!.txSignature).toBe(`sig-${intent.reference}`);
    // PER-MINT DIMENSION (security review 2026-07-28): the credit records WHICH
    // token the amount counts. Entry is a SOL payment, so it is the native mint
    // — recorded as a value, not left to be re-derived from `kind` later, which
    // is exactly the reconstruction that became impossible for KEEP after the
    // mint rotated twice. See money/mintDimension.ts.
    expect(row!.mint).toBe(NATIVE_SOL_MINT);
  });

  it('KEEP-denominated deposits are labelled with the live mint, SOL ones are not', () => {
    // The distinction that matters for reserves: only `keep_deposit` moves an
    // SPL token into custody, so only it can be labelled with the KEEP mint of
    // the day. `keep_vend` looks KEEP-ish but the player paid SOL — labelling
    // it with the KEEP mint would fabricate an inflow that never happened
    // (AUDIT-FIX-PLAN B1 is that missing inflow; this must not hide it).
    expect(depositMint('keep_vend')).toBe(NATIVE_SOL_MINT);
    expect(depositMint('entry')).toBe(NATIVE_SOL_MINT);
    expect(depositMint('mine_build')).toBe(NATIVE_SOL_MINT);
    // Read from infra/devnet.addresses.json, so it tracks a rotation instead of
    // being pinned to a literal here — and is null (unknown), never a guess,
    // when the file is absent.
    const keep = depositMint('keep_deposit');
    expect(keep).not.toBe(NATIVE_SOL_MINT);
    expect(keep === null || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(keep)).toBe(true);
  });

  it('a payment for the WRONG wallet never credits the intent', async () => {
    const { wallet } = await login();
    const stranger = bs58.encode(await getPublicKeyAsync(utils.randomSecretKey()));
    const intent = await createDepositIntent(db(), wallet, 'entry');
    // The "finalized tx" was signed by someone else — creditDeposit must refuse.
    const verifier = verifierFor(new Map([[intent.reference, { wallet: stranger, sig: `sig-${intent.reference}` }]]));

    const pass = await pollPendingDeposits(db(), verifier);
    expect(pass.credited).toBe(0);
    expect(pass.errors).toBe(1); // surfaced, not swallowed silently

    const [p] = await db().select().from(players)
      .where(and(eq(players.wallet, wallet), isNull(players.entryPaidAt)));
    expect(p).toBeDefined(); // still unpaid
  });

  it('stale unpaid intents expire; paid ones are immune to the TTL', async () => {
    const { wallet } = await login();
    const stale = await createDepositIntent(db(), wallet, 'entry');
    await db().update(deposits)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000) }) // ECONOMY.depositPendingTtlMin = 30
      .where(eq(deposits.id, stale.id));

    const neverFinds: DepositVerifier = async () => null;
    const pass = await pollPendingDeposits(db(), neverFinds);
    expect(pass.expired).toBeGreaterThanOrEqual(1);
    const [row] = await db().select().from(deposits).where(eq(deposits.id, stale.id));
    expect(row!.status).toBe('expired');

    // An expired intent is dead — a later "payment" for it cannot credit.
    const late = verifierFor(new Map([[stale.reference, { wallet, sig: 'sig-late' }]]));
    const pass2 = await pollPendingDeposits(db(), late);
    expect(pass2.credited).toBe(0);
  });

  it('on-demand verify (client poll) credits WITHOUT the background worker, opens the gate', async () => {
    // Reproduces incident 2026-07-18: workers off, so crediting must be driven
    // by the client polling POST /deposits/:id/verify.
    const { wallet, cookie } = await login();
    const dep = await app.inject({
      method: 'POST', url: '/deposits', cookies: { [SESSION_COOKIE]: cookie }, payload: { kind: 'entry' },
    });
    const intent = dep.json() as { id: string; reference: string };

    // Before the payment lands, verify is a no-op: still pending, gate still 402.
    let v = await app.inject({ method: 'POST', url: `/deposits/${intent.id}/verify`, cookies: { [SESSION_COOKIE]: cookie } });
    expect((v.json() as { status: string }).status).toBe('pending');
    expect((await app.inject({ url: '/base', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(402);

    // Payment finalizes → the next poll credits inline (no worker involved).
    verifyMap.set(intent.reference, { wallet, sig: `sig-ondemand-${intent.reference}` });
    v = await app.inject({ method: 'POST', url: `/deposits/${intent.id}/verify`, cookies: { [SESSION_COOKIE]: cookie } });
    expect((v.json() as { status: string }).status).toBe('credited');
    expect((await app.inject({ url: '/base', cookies: { [SESSION_COOKIE]: cookie } })).statusCode).toBe(200);
  });

  it('publishes both entry and later deed plots through already-warm globe and valley caches', async () => {
    // WHY: payment credit inserts the plot before starting the base, while both
    // world reads may already hold the old roster for 60 seconds. A buyer must
    // see the acquired land immediately from another selected base; waiting for
    // cache expiry makes a successful deed look missing and leaves its tile free.
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const viewer = await createTestPlayer(db());
      const viewerEntry = await createDepositIntent(db(), viewer.wallet, 'entry');
      expect(await verifyDepositNow(
        db(), verifierFor(new Map([[viewerEntry.reference, {
          wallet: viewer.wallet, sig: `cache-viewer-${viewerEntry.id}`,
        }]])), viewer.wallet, viewerEntry.id,
      )).toEqual({ action: 'credited' });
      const [viewerBase] = await db().select({ id: bases.id }).from(bases)
        .where(eq(bases.ownerWallet, viewer.wallet));
      expect(viewerBase).toBeDefined();

      const buyer = await createTestPlayer(db());
      let buyerMainBaseId: string | undefined;
      for (const kind of ['entry', 'deed'] as const) {
        const intent = await createDepositIntent(db(), buyer.wallet, kind);
        const [reserved] = await db().select({
          baseId: plotReservations.baseId,
          earthCell: plotReservations.earthCell,
          siteId: plotReservations.siteId,
          x: plotReservations.x,
          y: plotReservations.y,
        }).from(plotReservations).where(eq(plotReservations.depositId, intent.id));
        expect(reserved).toBeDefined();
        const [targetValley] = await db().select({ id: valleys.id }).from(valleys)
          .where(eq(valleys.siteId, requiredFixture(reserved!.siteId)));
        expect(targetValley).toBeDefined();

        const selectedViewer = kind === 'entry'
          ? { wallet: viewer.wallet, baseId: viewerBase!.id }
          : { wallet: buyer.wallet, baseId: buyerMainBaseId! };
        const rect = {
          baseId: selectedViewer.baseId, valleyId: targetValley!.id,
          x0: 0, y0: 0, x1: WORLD.gridCols - 1, y1: WORLD.gridRows - 1,
        };
        resetGlobeCache();
        resetMapCache();
        const beforeGlobe = await globeContext(
          db(), selectedViewer.wallet, new Date(), selectedViewer.baseId,
        );
        // Empty valley containers are intentionally absent from the public globe;
        // the first paid deed turns the valley into a real public place.
        const beforePlayers = beforeGlobe.snap.byValleyId.get(targetValley!.id)?.players ?? 0;
        const beforeMap = await getMapChunk(db(), selectedViewer.wallet, rect);
        expect(beforeMap.markers.some((marker) => marker.kind !== 'pve'
          && marker.earthCell === reserved!.earthCell)).toBe(false);
        expect(globeCacheLoads()).toBe(1);
        expect(mapCacheLoads()).toBe(1);

        expect(await verifyDepositNow(
          db(), verifierFor(new Map([[intent.reference, {
            wallet: buyer.wallet, sig: `cache-${kind}-${intent.id}`,
          }]])), buyer.wallet, intent.id,
        )).toEqual({ action: 'credited' });

        const afterGlobe = await globeContext(
          db(), selectedViewer.wallet, new Date(), selectedViewer.baseId,
        );
        const afterMap = await getMapChunk(db(), selectedViewer.wallet, rect);
        expect(afterGlobe.snap.byValleyId.get(targetValley!.id)!.players).toBe(beforePlayers + 1);
        expect(afterMap.markers.some((marker) => marker.kind !== 'pve'
          && marker.earthCell === reserved!.earthCell
          && marker.x === reserved!.x && marker.y === reserved!.y)).toBe(true);
        expect(globeCacheLoads()).toBe(2);
        expect(mapCacheLoads()).toBe(2);

        if (kind === 'entry') {
          const [main] = await db().select({ id: bases.id }).from(bases)
            .where(eq(bases.ownerWallet, buyer.wallet));
          buyerMainBaseId = main!.id;
        }
      }
    } finally {
      resetGlobeCache();
      resetMapCache();
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
    }
  });

  it('entry intent is idempotent; double-clicked siblings are closed on credit; re-request is a no-op', async () => {
    const { wallet, cookie } = await login();
    const post = () => app.inject({
      method: 'POST', url: '/deposits', cookies: { [SESSION_COOKIE]: cookie }, payload: { kind: 'entry' },
    }).then((r) => r.json() as { id?: string; reference?: string; alreadyPaid?: boolean });

    // Double-click PAY → the SAME pending intent, not two rows.
    const a = await post();
    const b = await post();
    expect(b.id).toBe(a.id);
    // Simulate the pre-fix pileup: two extra stray pending intents for this wallet.
    await createDepositIntent(db(), wallet, 'entry'); // reuse returns a; force real strays:
    await db().insert(deposits).values([
      { playerWallet: wallet, kind: 'entry', reference: `stray-1-${wallet}`.slice(0, 44), status: 'pending' },
      { playerWallet: wallet, kind: 'entry', reference: `stray-2-${wallet}`.slice(0, 44), status: 'pending' },
    ]);

    // The real one credits; every sibling pending entry intent is expired.
    verifyMap.set(a.reference!, { wallet, sig: `sig-real-${a.id}` });
    const v = await app.inject({ method: 'POST', url: `/deposits/${a.id}/verify`, cookies: { [SESSION_COOKIE]: cookie } });
    expect((v.json() as { status: string }).status).toBe('credited');
    const stillPending = await db().select().from(deposits)
      .where(and(eq(deposits.playerWallet, wallet), eq(deposits.kind, 'entry'), eq(deposits.status, 'pending')));
    expect(stillPending).toHaveLength(0); // no orphaned pending intents linger

    // Already paid → POST /deposits reports alreadyPaid, mints nothing.
    const after = await post();
    expect(after.alreadyPaid).toBe(true);
    expect(after.id).toBeUndefined();
  });

  it('a PAID deposit that can never apply strands to FAILED (not silently expired) past the TTL', async () => {
    const { wallet } = await login();
    // Pay entry → base + starter KEEP (covers a 400-KEEP Mine).
    const entry = await createDepositIntent(db(), wallet, 'entry');
    await pollPendingDeposits(db(), verifierFor(new Map([[entry.reference, { wallet, sig: `e-${wallet}` }]])));

    // Build a Mine, finish the build, then mint an upgrade intent and DESTROY the
    // Mine so the on-chain-paid upgrade can never apply.
    const { placeBuilding, completeDueJobs } = await import('../src/game/base');
    const [stableBase] = await db().select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, wallet));
    await rewardBaseShards(
      db(), stableBase!.id, 100_000n, 'test.fund.shards', `fund-${wallet}`,
    ); // stable Mine placement and upgrade spend only this deed's balance
    const mine = await placeBuilding(
      db(), wallet, 'mine' as never, 11, 8, `place-${wallet}`, new Date(), stableBase!.id,
    );
    await completeDueJobs(db(), wallet, new Date(Date.now() + 120_000));
    await fundTestKeep(db(), wallet, 100_000n, 'test.fund', `fund-${wallet}`);
    await db().update(players).set({ keepLevel: 5 }).where(eq(players.wallet, wallet)); // strict Keep-tallest
    await db().update(bases).set({ keepLevel: 5 }).where(eq(bases.id, stableBase!.id));
    // D-057: the paid rail starts at target L5, so the intent needs an L4 mine.
    await db().update(buildings).set({ level: 4 }).where(eq(buildings.id, mine.id));
    const up = await createDepositIntent(db(), wallet, 'mine', { buildingId: mine.id });
    const verifier = verifierFor(new Map([[up.reference, { wallet, sig: `mine-${wallet}` }]]));
    await db().delete(builderJobs).where(eq(builderJobs.buildingId, mine.id)); // FK before the building
    await db().delete(buildings).where(eq(buildings.id, mine.id));

    // Within the TTL: the payment is verified but the grant fails → stays pending
    // (self-heals if the block were transient), NOT failed yet.
    const soon = await pollPendingDeposits(db(), verifier, new Date());
    expect(soon.failed).toBe(0);
    expect((await db().select().from(deposits).where(eq(deposits.id, up.id)))[0]!.status).toBe('pending');

    // Past the TTL: it is PAID (provable by signature) but un-grantable → terminal
    // 'failed', recording the signature so ops can resolve it — never a silent
    // 'expired' that loses the SOL.
    const past = new Date(Date.now() + (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    const pass = await pollPendingDeposits(db(), verifier, past);
    expect(pass.failed).toBe(1);
    const [row] = await db().select().from(deposits).where(eq(deposits.id, up.id));
    expect(row!.status).toBe('failed');
    expect(row!.txSignature).toBe(`mine-${wallet}`);
  });

  it('dev-login stamps entryPaid (the sanctioned bypass goes through the same gate)', async () => {
    const dev = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: {} });
    expect(dev.statusCode).toBe(200);
    const body = dev.json() as { wallet: string; entryPaid: boolean };
    expect(body.entryPaid).toBe(true);
    const cookie = dev.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const base = await app.inject({ url: '/base', cookies: { [SESSION_COOKIE]: cookie } });
    expect(base.statusCode).toBe(200); // gate passes via the same entryPaidAt check
  });
});
