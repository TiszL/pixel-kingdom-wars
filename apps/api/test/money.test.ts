/**
 * Money plumbing tests (PLAN.md 4g — GDD §4.9): deposit crediting
 * (idempotent, kind/wallet matched, caps), withdrawal state machine
 * (escrow freeze, cancel, payout w/ 2% burn, personal daily cap, failed sends),
 * shield extension.
 */
import { createHash } from 'node:crypto';
import { CAPS, ECONOMY, MINING, SHIELD, TOKEN, VEND, fmtDur, vendLamportsForKeep, withdrawDailyCapForKeepLevel } from '@shardkeep/shared';
import { Keypair, PublicKey } from '@solana/web3.js';
import { and, eq, isNull, sql } from 'drizzle-orm';

/** A real on-curve wallet pubkey — a valid withdrawal destination (payouts go
 * to its ATA). Random-byte test wallets are ~half off-curve, which the request
 * validation (correctly) rejects. */
const DEST = Keypair.generate().publicKey.toBase58();
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  accounts, baseProfiles, baseRaidLocks, bases, baseSlots, buildings, deposits, ledgerEntries,
  ledgerTransactions, players, raids, shields, withdrawalAttempts,
  withdrawalAuthorizations, withdrawalPayoutReservations, withdrawals,
} from '../src/db/schema';
import { completeDueJobs, ensureStartingBase, placeBuilding } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { assertShieldExtendable, grantShieldExtension } from '../src/game/shop';
import { rewardShards } from '../src/game/spend';
import { rewardBaseShards } from '../src/game/baseEconomy';
import {
  createDepositIntent, creditDeposit, nextLandPurchaseKind, type VerifiedPayment,
} from '../src/money/deposits';
import { verifyDepositNow } from '../src/money/depositWatcher';
import {
  cancelWithdrawal,
  getPersonalWithdrawalLimit,
  isFailedWithdrawalRefundable,
  preflightWithdrawal,
  processDueWithdrawals as processDueWithdrawalsWithAuthorization,
  refundFailedWithdrawal,
  requestWithdrawal,
} from '../src/money/withdrawals';
import { checkReserves, type ReserveReader } from '../src/money/snapshot';
import { currentKeepMint } from '../src/money/mintDimension';

/** A reserve reader that always covers — the shared test DB carries liabilities
 *  from every other suite, so payout tests that are NOT about the gate pin it
 *  open with an absurd reserve. The gate itself is exercised separately. */
const COVERED: ReserveReader = async () => 10n ** 15n;
async function persistTestAuthorization(
  withdrawalId: string,
  keepMint = currentKeepMint()!,
): Promise<string> {
  const digest = createHash('sha256').update(`test-authorization:${withdrawalId}`).digest('hex');
  await db.insert(withdrawalAuthorizations).values({
    withdrawalId,
    challengeToken: 'test-authorization-challenge-token',
    walletSignature: '2'.repeat(88),
    cluster: 'devnet', keepMint,
  }).onConflictDoNothing();
  await db.update(withdrawalAuthorizations).set({
    validatedDigest: digest, validatedAt: new Date(),
  }).where(and(
    eq(withdrawalAuthorizations.withdrawalId, withdrawalId),
    isNull(withdrawalAuthorizations.validatedDigest),
  ));
  return digest;
}
// Direct money tests bypass the real wallet verifier. Persist its durable
// post-verification evidence so finality exercises the same boundary as the
// production worker; withdrawal-security-routes covers the real signature.
const AUTHORIZED: Parameters<typeof processDueWithdrawalsWithAuthorization>[3] = async (w) => ({
  ok: true, digest: await persistTestAuthorization(w.id), cluster: 'devnet',
  keepMint: currentKeepMint()!,
});
async function processDueWithdrawals(
  database: Parameters<typeof processDueWithdrawalsWithAuthorization>[0],
  sender: Parameters<typeof processDueWithdrawalsWithAuthorization>[1],
  reserve: Parameters<typeof processDueWithdrawalsWithAuthorization>[2],
  enabled: boolean,
  now?: Date,
) {
  return processDueWithdrawalsWithAuthorization(
    database, sender, reserve, AUTHORIZED, enabled, now,
  );
}
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';
import { FINALITY_PENDING, makeTestKeepSender } from './withdrawalSender';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `money-${++key}-${Math.random().toString(36).slice(2)}`;

async function basePlayer(keep = 50_000n) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await ensureWalletBaseIdentity(db, p.wallet);
  if (keep > 0n) await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
  if (keep > 0n) await rewardShards(db, p.wallet, keep, 'test.fund.shards', k());
  return p;
}
async function landPlayer(keep = 50_000n) {
  const p = await basePlayer(keep);
  const paidAt = new Date();
  await db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, p.wallet));
  await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, p.wallet));
  return p;
}
const balance = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;

function payment(wallet: string, kind: VerifiedPayment['kind'], sig?: string, lamports = 200_000_000n): VerifiedPayment {
  return {
    txSignature: sig ?? `sig-${k()}`,
    wallet,
    kind,
    lamports,
    finalized: true,
  };
}

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  await conn.sql.end();
});

describe('deposits', () => {
  it('credits an entry payment exactly once and stamps entry_paid_at', async () => {
    const p = await basePlayer(0n);
    const intent = await createDepositIntent(db, p.wallet, 'entry');
    const pay = payment(p.wallet, 'entry');
    expect((await creditDeposit(db, intent.id, pay)).credited).toBe(true);
    expect((await creditDeposit(db, intent.id, pay)).credited).toBe(false); // idempotent
    const [row] = await db.select().from(players).where(eq(players.wallet, p.wallet));
    expect(row!.entryPaidAt).not.toBeNull();
  });

  it('does not treat an unpaid expired entry intent as a consumed Player PDA', async () => {
    const p = await basePlayer(0n);
    await db.insert(deposits).values({
      playerWallet: p.wallet, kind: 'entry', reference: Keypair.generate().publicKey.toBase58(),
      status: 'expired',
    });
    await expect(createDepositIntent(db, p.wallet, 'entry'))
      .resolves.toMatchObject({ kind: 'entry', id: expect.any(String) });
  });

  it('uses and credits the repeatable deed rail when stable paid land outlives the player shadow', async () => {
    const p = await basePlayer(0n);
    const paidAt = new Date('2026-08-12T08:00:00.000Z');
    await db.update(bases).set({ landPaidAt: paidAt }).where(eq(bases.ownerWallet, p.wallet));

    // WHY: multi-base compatibility may leave players.entryPaidAt null even
    // though an exact stable base proves the first land purchase. Advertising
    // `deed` but rejecting its finalized payment here would strand 0.2 SOL.
    expect(await nextLandPurchaseKind(db, p.wallet)).toBe('deed');
    await expect(createDepositIntent(db, p.wallet, 'entry'))
      .rejects.toMatchObject({ code: 'ENTRY_PDA_CONSUMED' });
    const intent = await createDepositIntent(db, p.wallet, 'deed');
    await expect(creditDeposit(db, intent.id, payment(p.wallet, 'deed')))
      .resolves.toMatchObject({ credited: true, landActivated: true });
  });

  it('honours a frozen first-entry quote when another paid deed arrives before finality', async () => {
    const p = await basePlayer(0n);
    const intent = await createDepositIntent(db, p.wallet, 'entry');
    const [other] = await db.insert(bases).values({
      ownerWallet: p.wallet, landPaidAt: new Date('2026-08-12T08:05:00.000Z'), status: 'active',
    }).returning();
    await db.insert(baseSlots).values({ wallet: p.wallet, slot: 2, baseId: other!.id });

    // WHY: a valid pay_entry may already be broadcast when an external deed
    // transfer lands. Eligibility was serialized when this reference was
    // created, so later ownership cannot turn that real SOL into a failed row.
    await expect(creditDeposit(db, intent.id, payment(p.wallet, 'entry')))
      .resolves.toMatchObject({ credited: true, landActivated: true });
    expect(await nextLandPurchaseKind(db, p.wallet)).toBe('deed');
  });

  it('adopts a fresh pre-cutover land reservation before returning its payable reference', async () => {
    const p = await basePlayer(0n);
    const legacy = await createDepositIntent(db, p.wallet, 'entry');
    const [row] = await db.select().from(deposits).where(eq(deposits.id, legacy.id));
    const legacyPayload = { ...(row!.payload as Record<string, unknown>) };
    delete legacyPayload['landPurchaseVersion'];
    await db.update(deposits).set({ payload: legacyPayload }).where(eq(deposits.id, legacy.id));

    const reused = await createDepositIntent(db, p.wallet, 'entry');
    expect(reused.id).toBe(legacy.id);
    expect((await db.select({ payload: deposits.payload }).from(deposits)
      .where(eq(deposits.id, legacy.id)))[0]?.payload)
      .toMatchObject({ landPurchaseVersion: 1 });
  });

  it('reuses a fresh entry intent but fails closed while an older reference is near expiry', async () => {
    const p = await basePlayer(0n);
    const first = await createDepositIntent(db, p.wallet, 'entry');
    // Same wallet, moments later: one open intent, so a double-click must not
    // pile up a second payable reference.
    expect((await createDepositIntent(db, p.wallet, 'entry')).id).toBe(first.id);

    // Now ask again from far enough in the future that `first` no longer has
    // room to sign+land+finalize. It is STILL 'pending' in the DB (expiry is
    // stamped lazily), so only the age floor can catch it. Handing it back is
    // what took 0.2 SOL for an intent the next verify expired on age alone
    // (incident 2026-07-26). A sibling reference would be just as unsafe now
    // that both would target one reserved base/cell, so the watcher alone owns
    // terminalization before a fresh intent can be issued.
    const tooLate = new Date(
      Date.now()
        + (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000
        + 1_000,
    );
    await expect(createDepositIntent(db, p.wallet, 'entry', undefined, tooLate))
      .rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_WINDOW_CLOSING' });
    const [stale] = await db.select().from(deposits).where(eq(deposits.id, first.id));
    expect(stale!.status).toBe('pending'); // untouched: an in-flight payment can still credit it

    const expiredAt = new Date(stale!.createdAt.getTime() + ECONOMY.depositPendingTtlMin * 60_000 + 1);
    await expect(verifyDepositNow(db, async () => null, p.wallet, first.id, expiredAt))
      .resolves.toEqual({ action: 'expired' });
    const fresh = await createDepositIntent(db, p.wallet, 'entry', undefined, expiredAt);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.reference).not.toBe(first.reference);
  });

  it('builder purchases are progressively server-priced and increment through builder 6', async () => {
    const p = await landPlayer(0n);
    for (const expected of [2, 3, 4, 5, 6]) {
      const intent = await createDepositIntent(db, p.wallet, 'builder') as unknown as { id: string; amountLamports: number };
      const price = BigInt(Math.round(CAPS.builderPricesSol[expected - 2]! * 1e9));
      expect(intent.amountLamports).toBe(Number(price));
      await creditDeposit(db, intent.id, payment(p.wallet, 'builder', undefined, price));
      const [row] = await db.select().from(players).where(eq(players.wallet, p.wallet));
      expect(row!.builders).toBe(expected);
    }
    await expect(createDepositIntent(db, p.wallet, 'builder'))
      .rejects.toThrow(/builder cap/);
    expect(CAPS.buildersMax).toBe(6);
  });

  it('offers exactly one frozen payable builder intent under concurrent requests', async () => {
    const p = await landPlayer(0n);
    const intents = await Promise.all(Array.from({ length: 30 }, async () =>
      await createDepositIntent(db, p.wallet, 'builder') as {
        id: string; reference: string; kind: 'builder'; amountLamports: number;
      }));
    expect(new Set(intents.map((intent) => intent.id))).toEqual(new Set([intents[0]!.id]));
    expect(new Set(intents.map((intent) => intent.reference))).toEqual(new Set([intents[0]!.reference]));
    expect(intents[0]!.amountLamports).toBe(500_000_000);

    const rows = await db.select().from(deposits).where(and(
      eq(deposits.playerWallet, p.wallet), eq(deposits.kind, 'builder'), eq(deposits.status, 'pending'),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      expectedBuilders: 1,
      amountLamports: 500_000_000,
      landPaidAt: expect.any(String),
    });
  });

  it('never expires a closing builder intent ahead of a finalized credit', async () => {
    const p = await landPlayer(0n);
    const intent = await createDepositIntent(db, p.wallet, 'builder') as {
      id: string; reference: string; amountLamports: number;
    };
    const closingWindow = new Date(
      Date.now()
        + (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000
        + 1_000,
    );

    const [createResult, creditResult] = await Promise.allSettled([
      createDepositIntent(db, p.wallet, 'builder', undefined, closingWindow),
      creditDeposit(db, intent.id,
        payment(p.wallet, 'builder', undefined, BigInt(intent.amountLamports))),
    ]);
    expect(creditResult.status).toBe('fulfilled');
    if (creditResult.status === 'fulfilled') expect(creditResult.value.credited).toBe(true);
    // Whichever transaction gets the player lock first, the original payment
    // is recorded: creation may wait/reject, or may quote the NEXT slot only
    // after the credit commits. It must never expire the paid original.
    if (createResult.status === 'fulfilled') {
      expect(createResult.value.id).not.toBe(intent.id);
      expect((createResult.value as { amountLamports: number }).amountLamports).toBe(750_000_000);
    }
    const [paid] = await db.select().from(deposits).where(eq(deposits.id, intent.id));
    expect(paid!.status).toBe('credited');
    expect(paid!.txSignature).not.toBeNull();
  });

  it('keeps finalized paid base mutations pending while the defender snapshot is locked', async () => {
    for (const kind of ['builder', 'energy'] as const) {
      const defender = await landPlayer(0n);
      const attacker = await basePlayer(0n);
      const [defenderBase] = await db.select().from(bases)
        .where(eq(bases.ownerWallet, defender.wallet));
      const intent = await createDepositIntent(db, defender.wallet, kind) as {
        id: string; amountLamports: number;
      };
      const [raid] = await db.insert(raids).values({
        attackerWallet: attacker.wallet,
        defenderWallet: defender.wallet,
        defenderBaseId: defenderBase!.id,
        seed: 1n,
        snapshot: {},
        armySnapshot: {},
        ordersDeadlineAt: new Date(Date.now() + 60_000),
      }).returning({ id: raids.id });
      await db.insert(baseRaidLocks).values({
        baseId: defenderBase!.id,
        raidId: raid!.id,
        state: 'live',
        expiresAt: new Date(Date.now() + 60_000),
      });
      const pay = payment(
        defender.wallet, kind, undefined, BigInt(intent.amountLamports),
      );
      const readMutation = async (): Promise<number> => kind === 'builder'
        ? (await db.select({ value: bases.builders }).from(bases)
          .where(eq(bases.id, defenderBase!.id)))[0]!.value
        : (await db.select({ value: baseProfiles.purchasedEnergy }).from(baseProfiles)
          .where(eq(baseProfiles.baseId, defenderBase!.id)))[0]?.value ?? 0;
      const before = await readMutation();
      const afterTtl = new Date(
        Date.now() + (ECONOMY.depositPendingTtlMin + 1) * 60_000,
      );

      // WHY: a paid quote predates the raid, but applying either physical state
      // or purchased raid energy now would mutate the frozen defender deed.
      // Even after the intent TTL, leave it and the signature unclaimed so the
      // exact finalized payment can settle after the raid releases.
      await expect(verifyDepositNow(db, async () => pay, defender.wallet, intent.id, afterTtl))
        .resolves.toEqual({ action: 'none' });
      const [pending] = await db.select().from(deposits).where(eq(deposits.id, intent.id));
      expect(pending).toMatchObject({ status: 'pending', txSignature: null });
      expect(await readMutation()).toBe(before);

      await db.delete(baseRaidLocks).where(eq(baseRaidLocks.raidId, raid!.id));
      await expect(verifyDepositNow(db, async () => pay, defender.wallet, intent.id, afterTtl))
        .resolves.toEqual({ action: 'credited' });
      expect(await readMutation()).toBe(before + 1);
      await expect(verifyDepositNow(db, async () => pay, defender.wallet, intent.id, afterTtl))
        .resolves.toEqual({ action: 'none' });
      expect(await readMutation()).toBe(before + 1);
    }
  });

  it('does not issue a new reference while a legacy unbound builder intent is pending', async () => {
    const p = await landPlayer(0n);
    const [legacy] = await db.insert(deposits).values({
      playerWallet: p.wallet,
      kind: 'builder',
      reference: Keypair.generate().publicKey.toBase58(),
      status: 'pending',
      payload: null,
    }).returning();
    await expect(createDepositIntent(db, p.wallet, 'builder'))
      .rejects.toThrow(/earlier builder payment is still pending/);
    const [preserved] = await db.select().from(deposits).where(eq(deposits.id, legacy!.id));
    expect(preserved!.status).toBe('pending');
  });

  it('will not apply a frozen builder quote after the wallet loses its land', async () => {
    const p = await landPlayer(0n);
    const intent = await createDepositIntent(db, p.wallet, 'builder') as {
      id: string; amountLamports: number;
    };
    await db.update(bases).set({ landPaidAt: null })
      .where(eq(bases.ownerWallet, p.wallet));

    await expect(creditDeposit(db, intent.id,
      payment(p.wallet, 'builder', undefined, BigInt(intent.amountLamports))))
      .rejects.toThrow(/different base epoch/);
    const [player] = await db.select({ builders: players.builders }).from(players)
      .where(eq(players.wallet, p.wallet));
    const [preserved] = await db.select().from(deposits).where(eq(deposits.id, intent.id));
    expect(player!.builders).toBe(1);
    expect(preserved!.status).toBe('pending');
  });

  it('requires the exact frozen builder quote without consuming a mismatched intent', async () => {
    const p = await landPlayer(0n);
    const intent = await createDepositIntent(db, p.wallet, 'builder') as unknown as { id: string; amountLamports: number };
    await expect(creditDeposit(db, intent.id,
      payment(p.wallet, 'builder', undefined, BigInt(intent.amountLamports - 1))))
      .rejects.toThrow(/frozen quote/);
    await expect(creditDeposit(db, intent.id,
      payment(p.wallet, 'builder', undefined, BigInt(intent.amountLamports + 1))))
      .rejects.toThrow(/frozen quote/);
    const [dep] = await db.select().from(deposits).where(eq(deposits.id, intent.id));
    expect(dep!.status).toBe('pending');
  });

  it('rejects wallet or kind mismatches against the intent', async () => {
    const p = await landPlayer(0n);
    const other = await basePlayer(0n);
    // Expansions are now Keep-gated (1st needs L3, owner 2026-07-20); raise the
    // level so the intent mints — this test is about wallet/kind mismatch, not gating.
    await db.update(players).set({ keepLevel: 3 }).where(eq(players.wallet, p.wallet));
    await db.update(bases).set({ keepLevel: 3 }).where(eq(bases.ownerWallet, p.wallet));
    const intent = await createDepositIntent(db, p.wallet, 'expansion');
    await expect(creditDeposit(db, intent.id, payment(other.wallet, 'expansion')))
      .rejects.toThrow(/wallet does not match/);
    const intent2 = await createDepositIntent(db, p.wallet, 'expansion');
    await expect(creditDeposit(db, intent2.id, payment(p.wallet, 'builder')))
      .rejects.toThrow(/kind does not match/);
  });

  it('land expansions are Keep-gated + server-priced, 100% to liquidity (owner 2026-07-20)', async () => {
    const p = await landPlayer(0n);
    // Fresh base (Keep L1): the 1st expansion is gated at Keep L3 — no intent minted.
    await expect(createDepositIntent(db, p.wallet, 'expansion')).rejects.toThrow(/Keep level 3/);
    // Raise the Keep and buy: the intent carries the per-index SOL price; the paid
    // deposit (SOL → liquidity) re-checks it and increments expansions once.
    await db.update(players).set({ keepLevel: 9 }).where(eq(players.wallet, p.wallet));
    await db.update(bases).set({ keepLevel: 9 }).where(eq(bases.ownerWallet, p.wallet));
    const intent = await createDepositIntent(db, p.wallet, 'expansion') as unknown as { id: string; amountLamports: number };
    expect(intent.amountLamports).toBe(Math.round(CAPS.expansionPriceSolByIndex[0]! * 1e9)); // 0.15 SOL
    expect((await creditDeposit(db, intent.id,
      payment(p.wallet, 'expansion', undefined, BigInt(intent.amountLamports)))).credited).toBe(true);
    const [after] = await db.select().from(players).where(eq(players.wallet, p.wallet));
    expect(after!.expansions).toBe(1);
  });

  it('offers one exact, base-bound expansion quote under concurrent requests', async () => {
    const p = await landPlayer(0n);
    await db.update(players).set({ keepLevel: 20 }).where(eq(players.wallet, p.wallet));
    await db.update(bases).set({ keepLevel: 20 }).where(eq(bases.ownerWallet, p.wallet));
    const intents = await Promise.all(Array.from({ length: 30 }, async () =>
      await createDepositIntent(db, p.wallet, 'expansion') as {
        id: string; reference: string; amountLamports: number;
      }));
    expect(new Set(intents.map((intent) => intent.id))).toEqual(new Set([intents[0]!.id]));
    expect(new Set(intents.map((intent) => intent.reference))).toEqual(new Set([intents[0]!.reference]));
    expect(intents[0]!.amountLamports).toBe(150_000_000);

    await expect(creditDeposit(db, intents[0]!.id,
      payment(p.wallet, 'expansion', undefined, 150_000_001n)))
      .rejects.toThrow(/frozen quote/);
    const [stillPending] = await db.select().from(deposits).where(eq(deposits.id, intents[0]!.id));
    expect(stillPending!.status).toBe('pending');
  });
});

describe('withdrawals (GDD §4.9)', () => {
  it('WITHDRAWALS_ENABLED=false blocks new requests globally (bootstrap gate)', async () => {
    // WHY: the liquidity-bootstrap month depends on this single flag actually
    // gating (ONRAMP-WALLETS-PLAN §2/§8) — if the check ever drifts from the
    // schema-validated literal, withdrawals silently open mid-bootstrap.
    const p = await basePlayer(10_000n);
    process.env['WITHDRAWALS_ENABLED'] = 'false';
    try {
      // Pin the 503 STATUS, not just the message: a drift to 401 would make the
      // client read the bootstrap gate as "session expired" and force-logout
      // (the A7 misclassification class — security review B4 #2).
      await expect(requestWithdrawal(db, p.wallet, 4_000n, DEST, k()))
        .rejects.toMatchObject({ statusCode: 503, message: expect.stringMatching(/liquidity pool goes live/) });
    } finally {
      delete process.env['WITHDRAWALS_ENABLED'];
    }
    // gate off again → the same request goes through
    const w = await requestWithdrawal(db, p.wallet, 4_000n, DEST, k());
    expect(w.status).toBe('unbonding');
  });

  it('request freezes funds in escrow; cancel returns them', async () => {
    const p = await basePlayer(10_000n);
    const before = await balance(p.wallet);
    const w = await requestWithdrawal(db, p.wallet, 4_000n, DEST, k());
    expect(w.status).toBe('unbonding');
    expect(await balance(p.wallet)).toBe(before - 4_000n); // unspendable now
    await cancelWithdrawal(db, p.wallet, w.id);
    expect(await balance(p.wallet)).toBe(before);
  });

  it('rolls back the cancelled status and every balance when compensation posting fails', async () => {
    // WHY: status used to commit before the ledger post. Any post failure left
    // escrow stranded forever because retry saw `cancelled` and refused.
    const p = await basePlayer(10_000n);
    const before = await balance(p.wallet);
    const w = await requestWithdrawal(db, p.wallet, 4_000n, DEST, k());
    const frozen = await balance(p.wallet);
    const sys = await bootstrapSystemAccounts(db);
    const escrowBefore = (await db.select().from(accounts)
      .where(eq(accounts.id, sys.withdrawal_escrow)))[0]!.balance;

    await expect(cancelWithdrawal(db, p.wallet, w.id, {
      post: async () => { throw new Error('injected ledger failure'); },
    })).rejects.toThrow(/injected ledger failure/);

    expect(await balance(p.wallet)).toBe(frozen);
    expect((await db.select().from(accounts)
      .where(eq(accounts.id, sys.withdrawal_escrow)))[0]!.balance).toBe(escrowBefore);
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, w.id)))[0])
      .toMatchObject({ status: 'unbonding', completedAt: null });
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:cancel`,
    ))).toHaveLength(0);

    // The exact same row remains retryable and refunds once the post works.
    await cancelWithdrawal(db, p.wallet, w.id);
    expect(await balance(p.wallet)).toBe(before);
  });

  it('serializes concurrent cancellation so escrow is returned exactly once', async () => {
    const p = await basePlayer(10_000n);
    const before = await balance(p.wallet);
    const w = await requestWithdrawal(db, p.wallet, 4_000n, DEST, k());
    const results = await Promise.allSettled([
      cancelWithdrawal(db, p.wallet, w.id),
      cancelWithdrawal(db, p.wallet, w.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await balance(p.wallet)).toBe(before);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:cancel`,
    ))).toHaveLength(1);
  });

  it('consumes authorization only after validation and atomically with escrow', async () => {
    // WHY: instant-withdraw email/TOTP proofs are one-time. A malformed request,
    // an ordinary cap/balance rejection, or a rolled-back escrow must not burn
    // that proof; an idempotent network retry must not ask for it twice.
    const p = await basePlayer(10_000n);
    const before = await balance(p.wallet);
    const authorize = vi.fn(async () => undefined);

    await expect(requestWithdrawal(db, p.wallet, 1n, DEST, k(), { authorize }))
      .rejects.toThrow(/minimum withdrawal/);
    expect(authorize).not.toHaveBeenCalled();

    const requestKey = k();
    const first = await requestWithdrawal(db, p.wallet, 1_000n, DEST, requestKey, { authorize });
    expect(authorize).toHaveBeenCalledOnce();
    expect(await balance(p.wallet)).toBe(before - 1_000n);

    const retry = await requestWithdrawal(db, p.wallet, 1_000n, DEST, requestKey, { authorize });
    expect(retry.id).toBe(first.id);
    expect(authorize).toHaveBeenCalledOnce();
    await expect(requestWithdrawal(db, p.wallet, 1_001n, DEST, requestKey, { authorize }))
      .rejects.toThrow(/different withdrawal/);
    await expect(requestWithdrawal(
      db, p.wallet, 1_000n, Keypair.generate().publicKey.toBase58(), requestKey, { authorize },
    )).rejects.toThrow(/different withdrawal/);
    expect(authorize).toHaveBeenCalledOnce();
    expect(await balance(p.wallet)).toBe(before - 1_000n);

    const p2 = await basePlayer(10_000n);
    const before2 = await balance(p2.wallet);
    const deny = vi.fn(async () => { throw new Error('authorization denied'); });
    await expect(requestWithdrawal(db, p2.wallet, 1_000n, DEST, k(), { authorize: deny }))
      .rejects.toThrow(/authorization denied/);
    expect(deny).toHaveBeenCalledOnce();
    expect(await balance(p2.wallet)).toBe(before2);
    expect(await db.select().from(withdrawals).where(eq(withdrawals.playerWallet, p2.wallet)))
      .toHaveLength(0);
  });

  it('never inline-pays an already-created instant row on an idempotent retry', async () => {
    // WHY: exact instant retries skip their already-consumed factor by design.
    // Therefore a queued duplicate (for example, first request had no sender or
    // its reserve gate halted) must wait for the payout worker; letting the retry
    // enter inline payout would move money without a factor consumed in that tx.
    const p = await basePlayer(10_000n);
    const requestKey = k();
    const firstAuthorize = vi.fn(async () => true);
    const queued = await requestWithdrawal(db, p.wallet, 1_000n, DEST, requestKey, {
      instant: true, authorize: firstAuthorize,
    });
    expect(queued.status).toBe('unbonding');
    expect(firstAuthorize).toHaveBeenCalledOnce();

    const retryAuthorize = vi.fn(async () => true);
    const sendCalled = vi.fn();
    const send = makeTestKeepSender({ prepare: sendCalled });
    const retry = await requestWithdrawal(db, p.wallet, 1_000n, DEST, requestKey, {
      instant: true, authorize: retryAuthorize, send, readReserve: COVERED,
    });
    expect(retry.id).toBe(queued.id);
    expect(retry.status).toBe('unbonding');
    expect(retryAuthorize).not.toHaveBeenCalled();
    expect(sendCalled).not.toHaveBeenCalled();

    // Immediately-due instant rows would pollute later worker-count assertions.
    await cancelWithdrawal(db, p.wallet, queued.id);
  });

  it('preflights the exact server gates without freezing KEEP or creating a row', async () => {
    // WHY: the withdrawal UI must validate before asking for a wallet signature
    // or sending a one-time email code. This is the same transaction path, not a
    // client-side approximation that can drift from caps/cooldown/balance rules.
    const p = await basePlayer(10_000n);
    const before = await balance(p.wallet);
    await preflightWithdrawal(db, p.wallet, 1_000n, DEST, k());
    expect(await balance(p.wallet)).toBe(before);
    expect(await db.select().from(withdrawals).where(eq(withdrawals.playerWallet, p.wallet)))
      .toHaveLength(0);

    await expect(preflightWithdrawal(db, p.wallet, 1n, DEST, k()))
      .rejects.toThrow(/minimum withdrawal/);
    expect(await balance(p.wallet)).toBe(before);
  });

  it('preflights an existing idempotency anchor in its exact instant mode', async () => {
    // WHY: preflight used to silently force standard mode. Once mode became part
    // of the idempotent intent, an exact instant retry falsely collided with its
    // own row before the UI could review or issue a code.
    const p = await basePlayer(10_000n);
    const requestKey = k();
    const row = await requestWithdrawal(db, p.wallet, 1_000n, DEST, requestKey, {
      instant: true, authorize: async () => true,
    });
    const frozen = await balance(p.wallet);

    await expect(preflightWithdrawal(
      db, p.wallet, 1_000n, DEST, requestKey, { instant: true },
    )).resolves.toBeUndefined();
    expect(await balance(p.wallet)).toBe(frozen);
    expect(await db.select().from(withdrawals).where(eq(withdrawals.playerWallet, p.wallet)))
      .toHaveLength(1);

    await expect(preflightWithdrawal(
      db, p.wallet, 1_000n, DEST, requestKey, { instant: false },
    )).rejects.toThrow(/different withdrawal mode/);
    await cancelWithdrawal(db, p.wallet, row.id);
  });

  it('payout burns the 2% fee and moves the net out of custody', async () => {
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 5_000n, DEST, k());
    const fee = (w.amount * BigInt(ECONOMY.withdrawFeeBps)) / 10_000n;
    const net = w.amount - fee;
    // time-travel: unbonding over
    await db.execute(
      (await import('drizzle-orm')).sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`,
    );
    // Workers sweep the shared queue, so an unrelated due row must not change
    // what this test proves about its own withdrawal.
    const unrelatedPlayer = await basePlayer(2_000n);
    const unrelated = await requestWithdrawal(db, unrelatedPlayer.wallet, 1_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${unrelated.id}`);
    const targetBroadcasts: Array<{ signature: string; dest: string; amount: bigint }> = [];
    await processDueWithdrawals(db, makeTestKeepSender({
      broadcast: async (prepared) => {
        if (prepared.transfer.withdrawalId !== w.id) return prepared.signature;
        const [persisted] = await db.select().from(withdrawalAttempts)
          .where(eq(withdrawalAttempts.withdrawalId, w.id));
        expect(persisted).toMatchObject({
          status: 'broadcast', txSignature: prepared.signature,
          recentBlockhash: prepared.recentBlockhash,
          lastValidBlockHeight: BigInt(prepared.lastValidBlockHeight),
          transferSnapshot: prepared.transfer,
        });
        expect(Buffer.from(persisted!.signedTransaction))
          .toEqual(Buffer.from(prepared.transactionBytes));
        targetBroadcasts.push({
          signature: prepared.signature,
          dest: prepared.transfer.destinationOwner,
          amount: BigInt(prepared.transfer.amountKeep),
        });
        return prepared.signature;
      },
    }), COVERED, true);
    expect(targetBroadcasts).toEqual([{ signature: expect.any(String), dest: DEST, amount: net }]);
    const [settled] = await db.select().from(withdrawals).where(eq(withdrawals.id, w.id));
    expect(settled).toMatchObject({
      status: 'sent', amount: 5_000n, feeBurned: fee,
      txSignature: targetBroadcasts[0]!.signature,
    });
    const payoutTxns = await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:payout`,
    ));
    expect(payoutTxns).toHaveLength(1);
    const entries = await db.select().from(ledgerEntries)
      .where(eq(ledgerEntries.txnId, payoutTxns[0]!.id));
    const sys = await bootstrapSystemAccounts(db);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: sys.withdrawal_escrow, delta: -5_000n }),
      expect.objectContaining({ accountId: sys.burn, delta: fee }),
      expect.objectContaining({ accountId: sys.onchain_outflow, delta: net }),
    ]));
    const [terminalAttempt] = await db.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.withdrawalId, w.id));
    expect(terminalAttempt).toMatchObject({
      status: 'finalized_success', broadcastCount: 1,
      txSignature: targetBroadcasts[0]!.signature,
    });
    await expect(db.update(withdrawalAttempts)
      .set({ signedTransaction: Buffer.from([1, 2, 3]) })
      .where(eq(withdrawalAttempts.id, terminalAttempt!.id)))
      .rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringMatching(/signed evidence is immutable/) }),
      });
    await expect(db.update(withdrawalAttempts)
      .set({ status: 'broadcast' })
      .where(eq(withdrawalAttempts.id, terminalAttempt!.id)))
      .rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringMatching(/terminal evidence is immutable/) }),
      });
    // A re-run may serve unrelated rows from parallel suites, but this exact
    // terminal withdrawal can never be prepared, broadcast, or posted twice.
    let targetPreparations = 0;
    let targetRebroadcasts = 0;
    await processDueWithdrawals(db, makeTestKeepSender({
      prepare: async (request) => {
        if (request.withdrawalId === w.id) targetPreparations++;
      },
      broadcast: async (prepared) => {
        if (prepared.transfer.withdrawalId === w.id) targetRebroadcasts++;
        return prepared.signature;
      },
    }), COVERED, true);
    expect({ targetPreparations, targetRebroadcasts }).toEqual({
      targetPreparations: 0, targetRebroadcasts: 0,
    });
    expect(await db.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.withdrawalId, w.id))).toHaveLength(1);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:payout`,
    ))).toHaveLength(1);
  });

  it('requires persisted validated wallet evidence again at finalized settlement', async () => {
    // WHY: a signer-gate return is transient process memory. Final accounting
    // must fail closed if the independently verified authorization row is
    // absent, even after an RPC reports the signed transfer as finalized.
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    const memoryOnlyGate: Parameters<typeof processDueWithdrawalsWithAuthorization>[3] = async () => ({
      ok: true,
      digest: createHash('sha256').update('memory-only').digest('hex'),
      cluster: 'devnet', keepMint: currentKeepMint()!,
    });

    await expect(processDueWithdrawalsWithAuthorization(
      db, makeTestKeepSender(), COVERED, memoryOnlyGate, true,
    )).rejects.toThrow(/no independently validated wallet authorization/);
    expect(await db.select().from(withdrawalAuthorizations)
      .where(eq(withdrawalAuthorizations.withdrawalId, w.id))).toHaveLength(0);
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, w.id)))[0])
      .toMatchObject({ status: 'processing', payoutLedgerTxnId: null, mint: null });
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:payout`,
    ))).toHaveLength(0);

    // Once durable evidence exists, reconciliation settles the SAME immutable
    // attempt; it does not sign or broadcast a replacement transaction.
    await persistTestAuthorization(w.id);
    const reconciled = await processDueWithdrawalsWithAuthorization(
      db, makeTestKeepSender(), COVERED, memoryOnlyGate, true,
    );
    expect(reconciled.sent).toBe(1);
  });

  it('settles the mint from durable authorization, not from the signed snapshot alone', async () => {
    // WHY: the transfer snapshot is persisted input. If it disagrees with the
    // immutable mint independently verified from the wallet intent, finalized
    // accounting must stay held rather than recording the attacker-chosen mint.
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    const authorizedMint = Keypair.generate().publicKey.toBase58();
    await persistTestAuthorization(w.id, authorizedMint);
    const lyingGate: Parameters<typeof processDueWithdrawalsWithAuthorization>[3] = async () => ({
      ok: true,
      digest: createHash('sha256').update('memory-mint').digest('hex'),
      cluster: 'devnet', keepMint: currentKeepMint()!,
    });
    await expect(processDueWithdrawalsWithAuthorization(
      db, makeTestKeepSender(), COVERED, lyingGate, true,
    )).rejects.toThrow(/signed withdrawal transfer does not match the frozen payout/);
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, w.id)))[0])
      .toMatchObject({ status: 'processing', payoutLedgerTxnId: null, mint: null });

    // Test-only isolation: the synthetic finalized-success observation was
    // deliberately inconsistent, so retire this fixture as an investigated
    // error rather than letting later worker tests repeatedly reconcile it.
    const [attempt] = await db.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.withdrawalId, w.id));
    const investigatedAt = new Date();
    await db.update(withdrawalAttempts).set({
      status: 'finalized_error', finalizedAt: investigatedAt,
      lastError: 'test fixture: authorization mint mismatch', updatedAt: investigatedAt,
    }).where(eq(withdrawalAttempts.id, attempt!.id));
    await db.update(withdrawals).set({
      status: 'failed', completedAt: investigatedAt,
      lastError: 'FINALIZED ERROR — test fixture authorization mint mismatch',
    }).where(eq(withdrawals.id, w.id));
  });

  it('a claim-losing worker cannot release the winning worker allowance', async () => {
    // WHY: both workers may reserve and sign before either claims. The losing
    // worker's cleanup runs only after the winner's atomic processing+attempt
    // commit, so the SQL release guard must leave the winner's reservation.
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    let preparedCount = 0;
    let releaseBoth!: () => void;
    const bothPrepared = new Promise<void>((resolve) => { releaseBoth = resolve; });
    let broadcasts = 0;
    const sender = makeTestKeepSender({
      prepare: async () => {
        preparedCount++;
        if (preparedCount === 2) releaseBoth();
        await bothPrepared;
      },
      broadcast: async (prepared) => {
        broadcasts++;
        return prepared.signature;
      },
    });
    const results = await Promise.all([
      processDueWithdrawals(db, sender, COVERED, true),
      processDueWithdrawals(db, sender, COVERED, true),
    ]);

    expect(preparedCount).toBe(2);
    expect(broadcasts).toBe(1);
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
    expect((await db.select().from(withdrawalPayoutReservations)
      .where(eq(withdrawalPayoutReservations.withdrawalId, w.id)))[0])
      .toMatchObject({ status: 'sent', grossKeep: 1_000n });
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:payout`,
    ))).toHaveLength(1);
  });

  it('releases a pre-broadcast allowance when transaction preparation fails', async () => {
    // WHY: no signed attempt exists yet, so retaining the reservation would let
    // an RPC outage consume this wallet's payout allowance for 24 hours.
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    const held = await processDueWithdrawals(db, makeTestKeepSender({
      prepare: async () => { throw new Error('prepare unavailable'); },
    }), COVERED, true);
    expect(held.held).toBe(1);
    expect((await db.select().from(withdrawalPayoutReservations)
      .where(eq(withdrawalPayoutReservations.withdrawalId, w.id)))[0]!.status).toBe('released');

    const retried = await processDueWithdrawals(db, makeTestKeepSender(), COVERED, true);
    expect(retried.sent).toBe(1);
  });

  it('serializes per-wallet allowance and rechecks an expired reservation before retry', async () => {
    // WHY: an old reserved row must not become a free payout after it falls out
    // of the rolling window while a newer withdrawal consumes the fresh cap.
    const first = await basePlayer(0n);
    const second = await basePlayer(0n);
    const at = new Date();
    const insertRows = async (wallet: string, count: number) => db.insert(withdrawals).values(
      Array.from({ length: count }, () => ({
        playerWallet: wallet, currency: 'KEEP' as const, amount: 30_000n,
        feeBurned: 600n, destination: DEST, status: 'unbonding' as const,
        // Keep synthetic allowance-only rows out of later due-payout sweeps.
        unbondsAt: new Date(at.getTime() + 7 * 24 * 60 * 60 * 1_000),
      })),
    ).returning({ id: withdrawals.id });
    const [concurrentA, concurrentB] = await insertRows(first.wallet, 2);
    const reserve = async (id: string, wallet: string) => {
      const [row] = await db.execute(sql<{ allowed: boolean }>`
        SELECT public.shardkeep_reserve_withdrawal_allowance(
          ${id}::uuid, ${wallet}::text, 30000::bigint, 50000::bigint
        ) AS allowed
      `);
      return row!.allowed;
    };
    const concurrent = await Promise.all([
      reserve(concurrentA!.id, first.wallet),
      reserve(concurrentB!.id, first.wallet),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);

    // statement_timestamp() is fixed before a waiting call acquires the
    // wallet lock. A row written by the lock winner can therefore appear
    // slightly in the future to that waiter and must still consume allowance.
    const future = await basePlayer(0n);
    const [futureReserved, futureCandidate] = await insertRows(future.wallet, 2);
    await db.insert(withdrawalPayoutReservations).values({
      withdrawalId: futureReserved!.id,
      playerWallet: future.wallet,
      grossKeep: 30_000n,
      status: 'reserved',
      reservedAt: new Date(at.getTime() + 60_000),
      updatedAt: new Date(at.getTime() + 60_000),
    });
    expect(await reserve(futureCandidate!.id, future.wallet)).toBe(false);

    const [oldRow, freshRow] = await insertRows(second.wallet, 2);
    await db.insert(withdrawalPayoutReservations).values({
      withdrawalId: oldRow!.id,
      playerWallet: second.wallet,
      grossKeep: 30_000n,
      status: 'reserved',
      reservedAt: new Date(at.getTime() - 25 * 60 * 60 * 1_000),
      updatedAt: new Date(at.getTime() - 25 * 60 * 60 * 1_000),
    });
    expect(await reserve(freshRow!.id, second.wallet)).toBe(true);
    expect(await reserve(oldRow!.id, second.wallet)).toBe(false);
  });

  it('an ambiguous broadcast remains processing and only rebroadcasts identical bytes', async () => {
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.execute(
      (await import('drizzle-orm')).sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`,
    );
    const signed: Buffer[] = [];
    let definitiveError = false;
    const sender = makeTestKeepSender({
      broadcast: async (prepared) => {
        signed.push(Buffer.from(prepared.transactionBytes));
        throw new Error('rpc down');
      },
      reconcile: async () => definitiveError
        ? { status: 'finalized_error', source: 'test-primary', error: 'definitive cleanup' }
        : FINALITY_PENDING,
    });
    const res = await processDueWithdrawals(db, sender, COVERED, true);
    expect(res).toEqual({ sent: 0, failed: 0, held: 1 });
    const [processing] = await db.select().from(withdrawals).where(eq(withdrawals.id, w.id));
    expect(processing).toMatchObject({ status: 'processing', txSignature: null });
    expect(processing!.lastError).toMatch(/^BROADCAST AMBIGUOUS/);
    expect(isFailedWithdrawalRefundable(processing!)).toBe(false);
    await expect(refundFailedWithdrawal(db, w.id, { wallet: p.wallet }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, w.id)))[0]!.status)
      .toBe('processing');
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:refund`,
    ))).toHaveLength(0);
    const later = new Date(Date.now() + 10_000);
    const again = await processDueWithdrawals(db, sender, COVERED, true, later);
    expect(again.sent).toBe(0);
    expect(signed).toHaveLength(2);
    expect(signed[1]).toEqual(signed[0]);
    definitiveError = true;
    const terminal = await processDueWithdrawals(db, sender, COVERED, true, new Date(later.getTime() + 1));
    expect(terminal.failed).toBe(1);
    await refundFailedWithdrawal(db, w.id, { wallet: p.wallet });
  });

  it('rolls ledger settlement back if the finalized withdrawal row cannot commit', async () => {
    // WHY: finality does not permit split bookkeeping. If the ledger post could
    // commit before the withdrawal status/signature, recovery would either pay
    // twice or strand an already-paid escrow.
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 2_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    let blockerId: string | null = null;
    const sender = makeTestKeepSender({ broadcast: async (prepared) => {
      const [blocker] = await db.insert(withdrawals).values({
        playerWallet: p.wallet, currency: 'KEEP', amount: 1n, feeBurned: 0n,
        destination: DEST, status: 'failed', unbondsAt: new Date(),
        txSignature: prepared.signature, lastError: 'test-only unique-signature blocker',
      }).returning();
      blockerId = blocker!.id;
      return prepared.signature;
    } });

    await expect(processDueWithdrawals(db, sender, COVERED, true)).rejects.toThrow(/Failed query/);
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, w.id)))[0]!.status)
      .toBe('processing');
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:payout`,
    ))).toHaveLength(0);
    expect((await db.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.withdrawalId, w.id)))[0]!.status).toBe('broadcast');

    await db.delete(withdrawals).where(eq(withdrawals.id, blockerId!));
    const recovered = await processDueWithdrawals(db, makeTestKeepSender(), COVERED, true);
    expect(recovered.sent).toBe(1);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:payout`,
    ))).toHaveLength(1);
  });

  it('holds expired null observations because non-archival history can be pruned', async () => {
    const p = await basePlayer(10_000n);
    const before = await balance(p.wallet);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    const result = await processDueWithdrawals(db, makeTestKeepSender({
      reconcile: async () => ({
        status: 'expired_unresolved', sources: ['provider-a.example', 'provider-b.example'],
      }),
    }), COVERED, true);
    expect(result).toEqual({ sent: 0, failed: 0, held: 1 });
    const [held] = await db.select().from(withdrawals).where(eq(withdrawals.id, w.id));
    expect(held).toMatchObject({ status: 'processing', txSignature: null });
    expect(isFailedWithdrawalRefundable(held!)).toBe(false);
    expect(await balance(p.wallet)).toBe(before - 1_000n);
    const [attempt] = await db.select().from(withdrawalAttempts)
      .where(eq(withdrawalAttempts.withdrawalId, w.id));
    expect(attempt).toMatchObject({
      status: 'broadcast',
      lastError: 'EXPIRED UNRESOLVED — non-archival RPC history cannot prove transfer absence',
      absenceProofSources: ['provider-a.example', 'provider-b.example'],
    });
    await expect(refundFailedWithdrawal(db, w.id, { wallet: p.wallet }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await balance(p.wallet)).toBe(before - 1_000n);

    // Test cleanup models the separate archival/operator investigation that
    // later finds a finalized transaction error. Only that positive result may
    // move the attempt onto the ordinary failed/refund path.
    const investigatedAt = new Date();
    await db.update(withdrawalAttempts).set({
      status: 'finalized_error', finalizedAt: investigatedAt,
      lastError: 'archival review found finalized error',
    }).where(eq(withdrawalAttempts.id, attempt!.id));
    await db.update(withdrawals).set({
      status: 'failed', txSignature: attempt!.txSignature, completedAt: investigatedAt,
      lastError: `FINALIZED ERROR — ${attempt!.txSignature} — archival review found finalized error`,
    }).where(eq(withdrawals.id, w.id));
    await refundFailedWithdrawal(db, w.id, { wallet: p.wallet });
    expect(await balance(p.wallet)).toBe(before);
  });

  it('holds a legacy processing row with no signed attempt forever', async () => {
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.update(withdrawals).set({
      status: 'processing', lastError: 'legacy worker outcome unknown',
    }).where(eq(withdrawals.id, w.id));
    const prepare = vi.fn();
    const result = await processDueWithdrawals(db, makeTestKeepSender({ prepare }), COVERED, true);
    expect(result).toEqual({ sent: 0, failed: 0, held: 1 });
    expect(prepare).not.toHaveBeenCalled();
    const [held] = await db.select().from(withdrawals).where(eq(withdrawals.id, w.id));
    expect(held!.status).toBe('processing');
    expect(isFailedWithdrawalRefundable(held!)).toBe(false);
    // Test cleanup models a later explicit operator chain audit.
    await db.update(withdrawals).set({
      status: 'failed', lastError: 'NOT BROADCAST — operator verified no matching transaction',
    }).where(eq(withdrawals.id, w.id));
    await refundFailedWithdrawal(db, w.id, { wallet: p.wallet });
  });

  it('WITHDRAWALS_ENABLED=false holds already-due rows before any read, claim or send', async () => {
    // WHY: the switch used to block only NEW requests. Flipping it during a
    // custody incident still let the worker drain every row already queued.
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    let sends = 0;
    let reserveReads = 0;
    const disabled = await processDueWithdrawals(
      db,
      makeTestKeepSender({ prepare: async () => { sends++; } }),
      async () => { reserveReads++; return 10n ** 15n; },
      false,
    );

    expect(disabled).toEqual({
      sent: 0, failed: 0, held: 0,
      skipped: 'WITHDRAWALS_ENABLED=false — all queued payout outflow held',
      outflowHeld: true,
    });
    expect(sends).toBe(0);
    expect(reserveReads).toBe(0);
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, w.id)))[0])
      .toMatchObject({ status: 'unbonding', txSignature: null, lastError: null });

    // Re-enabling preserves the original queue semantics: the same untouched
    // row becomes payable without repair or re-creation.
    const enabled = await processDueWithdrawals(db, makeTestKeepSender(), COVERED, true);
    expect(enabled.sent).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reserve gate (AUDIT-FIX-PLAN B1 / ARCHITECTURE §5)
// ---------------------------------------------------------------------------

describe('reserve-gated payouts', () => {
  /** Queues one withdrawal and time-travels it past unbonding. */
  async function due(keep: bigint, amount: bigint) {
    const p = await basePlayer(keep);
    const w = await requestWithdrawal(db, p.wallet, amount, DEST, k());
    await db.execute(sql`UPDATE withdrawals SET unbonds_at = NOW() - INTERVAL '1 hour' WHERE id = ${w.id}`);
    return { p, w };
  }
  const statusOf = async (id: string) =>
    (await db.select().from(withdrawals).where(eq(withdrawals.id, id)))[0]!.status;

  it('refuses a payout that would breach coverage, leaves the row PAYABLE, then pays once coverage returns', async () => {
    // WHY: this is the whole point of B1. `keep_vend` can credit withdrawable
    // player_keep without moving reserve KEEP into custody, so the books can
    // outrun the hot wallet with no bug anywhere. Before this gate, an
    // under-reserved custody kept paying first-come-first-served until the ATA
    // ran dry — the players at the back of the queue ate the shortfall. The row
    // must survive the halt UNTOUCHED (not 'failed'), because a halt is our
    // problem to fix, not a defect in the player's request.
    const { p, w } = await due(10_000n, 5_000n);
    const before = await balance(p.wallet);

    const held = await processDueWithdrawals(db, makeTestKeepSender({
      prepare: async () => { throw new Error('sender must NOT be called while custody is short'); },
    }), async () => 1n, true); // 1 KEEP of reserve against ≥10k of liability
    expect(held).toEqual({ sent: 0, failed: 0, held: 1 });
    expect(await statusOf(w.id)).toBe('unbonding'); // still payable, not failed
    expect(await balance(p.wallet)).toBe(before);   // escrow untouched

    // Coverage restored → the very same row drains with no operator action.
    const paid = await processDueWithdrawals(db, makeTestKeepSender(), COVERED, true);
    expect(paid.sent).toBe(1);
    expect(await statusOf(w.id)).toBe('sent');
  });

  it('FAILS CLOSED when the reserve read throws, and when no reader is configured', async () => {
    // WHY: "unknown coverage" must never read as "covered". A transient RPC
    // failure is the single most likely way a solvency brake gets silently
    // disarmed — the gate would be worthless if a dead RPC unblocked payouts.
    const { w } = await due(10_000n, 2_000n);
    const mustNotSend = makeTestKeepSender({
      prepare: async () => { throw new Error('sender must NOT be called'); },
    });

    const rpcDown = await processDueWithdrawals(db, mustNotSend, async () => { throw new Error('rpc down'); }, true);
    expect(rpcDown).toEqual({ sent: 0, failed: 0, held: 1 });
    expect(await statusOf(w.id)).toBe('unbonding');

    // No reader at all (hot wallet unprovisioned / addresses missing) is the
    // same verdict — absence of proof is not proof of coverage.
    const noReader = await processDueWithdrawals(db, mustNotSend, null, true);
    expect(noReader).toEqual({ sent: 0, failed: 0, held: 1 });
    expect(await statusOf(w.id)).toBe('unbonding');
    await cancelWithdrawal(db, w.playerWallet, w.id); // keep later batch tests isolated
  });

  it('gates the INSTANT (2FA) path too — it queues instead of settling', async () => {
    // WHY: the instant path calls the payout directly, bypassing the worker. If
    // the gate lived only in processDueWithdrawals, a 2FA code would be a way to
    // buy past the solvency brake — the fastest player drains the short reserve.
    const p = await basePlayer(10_000n);
    const w = await requestWithdrawal(db, p.wallet, 3_000n, DEST, k(), {
      instant: true,
      send: makeTestKeepSender({
        prepare: async () => { throw new Error('sender must NOT be called'); },
      }),
      readReserve: async () => 1n,
    });
    expect(w.status).toBe('unbonding'); // queued for the worker, escrow intact
    expect(await statusOf(w.id)).toBe('unbonding');
    await cancelWithdrawal(db, p.wallet, w.id); // keep later batch tests isolated
  });

  it('rechecks coverage for every due row immediately before its send', async () => {
    // A payout improves coverage by its fee, but the API can add liabilities
    // between sends. A batch-wide positive verdict is therefore stale authority.
    const a = await due(10_000n, 1_000n);
    const b = await due(10_000n, 1_000n);
    let reads = 0;
    const counting: ReserveReader = async () => { reads++; return 10n ** 15n; };
    const res = await processDueWithdrawals(db, makeTestKeepSender(), counting, true);
    expect(res.sent).toBeGreaterThanOrEqual(2);
    expect(reads).toBe(res.sent + res.failed + res.held);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await statusOf(a.w.id)).toBe('sent');
    expect(await statusOf(b.w.id)).toBe('sent');
  });

  it('halts the second row when the first send races with a new liability', async () => {
    const a = await due(10_000n, 1_000n);
    const b = await due(10_000n, 1_000n);
    const liabilityBefore = (await checkReserves(db, async () => 0n)).liabilityKeep;
    const creditor = await basePlayer(0n);
    let transfers = 0;
    let liveReserve = liabilityBefore;

    const result = await processDueWithdrawals(db, makeTestKeepSender({ broadcast: async (prepared) => {
      transfers++;
      if (transfers === 1) {
        liveReserve -= BigInt(prepared.transfer.amountKeep); // transfer left the hot ATA
        // Runs while the worker is between sequential sends. The first payout
        // improves coverage by only its 2% fee (20 KEEP); this new 1,000 KEEP
        // liability makes the formerly-positive batch verdict stale.
        await fundTestKeep(db, creditor.wallet, 1_000n, 'test.reserve-race', k());
      }
      return prepared.signature;
    } }), async () => liveReserve, true);

    expect(result).toEqual({ sent: 1, failed: 0, held: 1 });
    expect(transfers).toBe(1);
    const statuses = [await statusOf(a.w.id), await statusOf(b.w.id)].sort();
    expect(statuses).toEqual(['sent', 'unbonding']);
    const held = (await statusOf(a.w.id)) === 'unbonding' ? a : b;
    await cancelWithdrawal(db, held.p.wallet, held.w.id);
  });

  it('the gate uses the SAME liability definition as /por', async () => {
    // WHY: two different liability sums would let /por publish "covered" while
    // the queue halts (or worse, the reverse). The gate calls checkReserves
    // verbatim, so the invariant to pin is that unclaimed forge KEEP and escrow
    // are inside the number the brake reads — a payout is refused at exactly the
    // reserve /por calls short, not one KEEP later.
    const liability = (await checkReserves(db, async () => 0n)).liabilityKeep;
    const { w } = await due(10_000n, 1_000n);
    const grown = (await checkReserves(db, async () => 0n)).liabilityKeep;
    expect(grown).toBeGreaterThanOrEqual(liability); // escrow stayed a liability

    // exactly-covered pays; one KEEP short halts
    const short = await processDueWithdrawals(db, makeTestKeepSender({
      prepare: async () => { throw new Error('no'); },
    }), async () => grown - 1n, true);
    expect(short.held).toBe(1);
    const exact = await processDueWithdrawals(db, makeTestKeepSender(), async () => grown, true);
    expect(exact.sent).toBe(1);
    expect(await statusOf(w.id)).toBe('sent');
  });
});

// ---------------------------------------------------------------------------
// failed → refunded (AUDIT-FIX-PLAN B1 companion)
// ---------------------------------------------------------------------------

describe('refunding a failed withdrawal', () => {
  /** Represents an operator-audited legacy failure whose chain lookup proved no
   * broadcast. A sender throw is deliberately NOT this shape: it is ambiguous. */
  async function failedRow(keep: bigint, amount: bigint) {
    const p = await basePlayer(keep);
    const w = await requestWithdrawal(db, p.wallet, amount, DEST, k());
    await db.update(withdrawals).set({
      status: 'failed',
      lastError: 'NOT BROADCAST — operator verified no matching chain transaction',
    }).where(eq(withdrawals.id, w.id));
    expect(isFailedWithdrawalRefundable((await db.select().from(withdrawals)
      .where(eq(withdrawals.id, w.id)))[0]!)).toBe(true);
    return { p, w };
  }

  it('returns the gross to the player exactly once, and the ledger balances', async () => {
    // WHY: before this transition a failed payout left the player's KEEP in
    // withdrawal_escrow with NO code path back — stranded until hand-written
    // SQL. There is at least one such row live.
    const { p, w } = await failedRow(10_000n, 4_000n);
    const frozen = await balance(p.wallet);

    const refunded = await refundFailedWithdrawal(db, w.id, { wallet: p.wallet });
    expect(refunded.status).toBe('refunded');
    expect(await balance(p.wallet)).toBe(frozen + 4_000n); // gross, not net — nothing was burned

    // Double-entry: the compensating posting sums to zero and is the ONE txn.
    const [txn] = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:refund`));
    expect(txn).toBeTruthy();
    expect(refunded.refundLedgerTxnId).toBe(txn!.id);
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, txn!.id));
    expect(entries.reduce((s, e) => s + e.delta, 0n)).toBe(0n);

    // A second attempt is refused — the money already went home.
    await expect(refundFailedWithdrawal(db, w.id, { wallet: p.wallet }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(await balance(p.wallet)).toBe(frozen + 4_000n);
  });

  it('concurrent double-refund produces exactly ONE posting', async () => {
    // WHY: the row lock inside the conditional status claim is what makes this
    // safe; withdrawal_escrow is NOT a non-negative account, so a second posting
    // would NOT fail loudly at the ledger — it would silently mint KEEP.
    const { p, w } = await failedRow(10_000n, 3_000n);
    const frozen = await balance(p.wallet);

    const results = await Promise.allSettled([
      refundFailedWithdrawal(db, w.id, { wallet: p.wallet }),
      refundFailedWithdrawal(db, w.id, { wallet: p.wallet }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(p.wallet)).toBe(frozen + 3_000n); // credited ONCE

    const txns = await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `withdrawal:${w.id}:refund`));
    expect(txns).toHaveLength(1);
  });

  it('REFUSES a row that may already have been paid on-chain', async () => {
    // WHY: 'failed' does not mean "the KEEP stayed put" — the payout path marks
    // a row failed when the send succeeded but the ledger/row write didn't, and
    // records `SENT <sig>` precisely so nothing downstream pays twice. Refunding
    // that row hands the player their KEEP a SECOND time.
    const { p, w } = await failedRow(10_000n, 2_000n);
    const frozen = await balance(p.wallet);
    await db.update(withdrawals)
      .set({ txSignature: `already-sent-${k()}`, lastError: 'SENT abc — DO NOT RE-SEND — boom' })
      .where(eq(withdrawals.id, w.id));

    await expect(refundFailedWithdrawal(db, w.id, { wallet: p.wallet }))
      .rejects.toMatchObject({ statusCode: 409 });
    // The guard threw INSIDE the claim transaction, so the status rolled back
    // too — the row is still 'failed' for ops, not half-refunded.
    const [after] = await db.select().from(withdrawals).where(eq(withdrawals.id, w.id));
    expect(after!.status).toBe('failed');
    expect(await balance(p.wallet)).toBe(frozen);
  });

  it('fails closed for a plain legacy failure with no explicit no-broadcast proof', async () => {
    // WHY: old workers overwrote BROADCAST ATTEMPTED with a plain RPC error.
    // Null signature + generic error is therefore unknown, not refundable.
    const { p, w } = await failedRow(10_000n, 2_000n);
    await db.update(withdrawals).set({ lastError: 'Error: rpc down' })
      .where(eq(withdrawals.id, w.id));
    const frozen = await balance(p.wallet);

    await expect(refundFailedWithdrawal(db, w.id, { wallet: p.wallet }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await balance(p.wallet)).toBe(frozen);
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, w.id)))[0]!.status)
      .toBe('failed');
  });

  it('refuses non-failed rows and another wallet\'s row', async () => {
    const p = await basePlayer(10_000n);
    const unbonding = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k());
    await expect(refundFailedWithdrawal(db, unbonding.id, { wallet: p.wallet }))
      .rejects.toMatchObject({ statusCode: 422 });

    const { w } = await failedRow(10_000n, 1_000n);
    const stranger = await basePlayer(0n);
    // Scoped by wallet → a stranger sees 404, never another player's row.
    await expect(refundFailedWithdrawal(db, w.id, { wallet: stranger.wallet }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('a refunded request costs the player neither their daily cap nor a cooldown day', async () => {
    // WHY: the failure was OURS (RPC down, hot ATA short). If a refunded row
    // still counted, our outage would silently cost the player a day of access
    // to their own funds. Economically it is a cancel: nothing left custody.
    const { p, w } = await failedRow(10_000n, 4_000n);
    await refundFailedWithdrawal(db, w.id, { wallet: p.wallet });
    // Same-day retry succeeds: neither the 24h cooldown nor the rolling cap saw it.
    const retry = await requestWithdrawal(db, p.wallet, 4_000n, DEST, k());
    expect(retry.status).toBe('unbonding');
  });

  it('keeps the refunded amount inside PoR liability (it moved, it did not vanish)', async () => {
    // WHY: escrow and play balance are BOTH custodial liability, so a refund is
    // liability-neutral. If the refund credited the player without debiting
    // escrow (or vice versa) the published solvency number would drift — and
    // the reserve gate above reads that same number to decide who gets paid.
    const { p, w } = await failedRow(10_000n, 5_000n);
    const before = await checkReserves(db, async () => 0n);
    await refundFailedWithdrawal(db, w.id, { wallet: p.wallet });
    const after = await checkReserves(db, async () => 0n);
    expect(after.liabilityKeep).toBe(before.liabilityKeep);
  });

  it('enforces the per-player daily cap (Keep-level 1 = 50k)', async () => {
    const p = await basePlayer(300_000n);
    const overCap = BigInt(withdrawDailyCapForKeepLevel(1)) + 10_000n;
    await expect(requestWithdrawal(db, p.wallet, overCap, DEST, k()))
      .rejects.toThrow(/daily withdrawal cap/);
  });

  it('does not let another player consume this wallet\'s rolling allowance', async () => {
    // WHY: the removed global cap let unrelated wallets block each other. Each L1
    // wallet may independently use its own 50k allowance.
    const first = await basePlayer(50_000n);
    const second = await basePlayer(50_000n);
    const cap = BigInt(withdrawDailyCapForKeepLevel(1));
    await expect(requestWithdrawal(db, first.wallet, cap, DEST, k()))
      .resolves.toMatchObject({ amount: cap });
    await expect(requestWithdrawal(db, second.wallet, cap, DEST, k()))
      .resolves.toMatchObject({ amount: cap });
    await expect(getPersonalWithdrawalLimit(db, second.wallet)).resolves.toMatchObject({
      personalDailyLimitKeep: cap.toString(),
      personalDailyUsedKeep: cap.toString(),
      personalDailyRemainingKeep: '0',
      governingKeepLevel: 1,
    });
  });

  it('24h cooldown: a second withdrawal within the day is rejected', async () => {
    // WHY: at most one (non-failed) cash-out per 24h, so loot can't be drained
    // every mine tick — it has to sit on the base and stay raidable.
    const p = await basePlayer(100_000n);
    await requestWithdrawal(db, p.wallet, 10_000n, DEST, k()); // first is fine
    await expect(requestWithdrawal(db, p.wallet, 10_000n, DEST, k()))
      .rejects.toThrow(/cooldown/);
  });

  it('withdraws 100% of holdings in ONE request, then the cooldown blocks the next', async () => {
    // WHY: the 50%-of-holdings single-withdrawal cap is GONE (owner 2026-07-26).
    // It existed to slow whales extracting value; the Gold Forge now gates KEEP
    // emission behind daily Shard contribution, so extraction speed is bounded at
    // the mint. Under the personal cap and off cooldown the whole stack may leave
    // at once, but the timing brake must still hold.
    const p = await basePlayer(10_000n);
    const all = await balance(p.wallet);
    expect(all).toBeLessThanOrEqual(BigInt(withdrawDailyCapForKeepLevel(1)));
    const w = await requestWithdrawal(db, p.wallet, all, DEST, k());
    expect(w.amount).toBe(all);
    expect(w.status).toBe('unbonding');
    expect(await balance(p.wallet)).toBe(0n); // every unit frozen in escrow
    // Re-fund, so the next rejection can ONLY be the cooldown (not empty pockets).
    await fundTestKeep(db, p.wallet, 10_000n, 'test.refund', k());
    await expect(requestWithdrawal(db, p.wallet, BigInt(ECONOMY.minWithdrawKeep), DEST, k()))
      .rejects.toThrow(/cooldown/);
  });

  it('the personal daily cap scales with Keep level', async () => {
    const p = await basePlayer(260_000n);
    await db.update(players).set({ keepLevel: 5 }).where(eq(players.wallet, p.wallet));
    const overL1 = BigInt(withdrawDailyCapForKeepLevel(1)) + 10_000n;
    const w = await requestWithdrawal(db, p.wallet, overL1, DEST, k());
    expect(w.amount).toBe(overL1);
    expect(BigInt(withdrawDailyCapForKeepLevel(5))).toBe(92_000n);
  });

  it('rejects withdrawing more than the balance, readably and before escrow', async () => {
    // WHY: with the 50%-of-holdings cap gone, the BALANCE is the ceiling on a
    // single withdrawal. player_keep is a non-negative account so the freeze would
    // fail regardless, but the player must see a plain message (not a ledger error
    // naming an internal account id), and no funds may move.
    const p = await basePlayer(100n);
    const before = await balance(p.wallet);
    await expect(requestWithdrawal(db, p.wallet, before + 1_000n, DEST, k()))
      .rejects.toThrow(/not enough KEEP/);
    expect(await balance(p.wallet)).toBe(before);
  });

  it('rejects sub-minimum amounts and bad destinations BEFORE escrow (no fund-lock)', async () => {
    const p = await basePlayer(10_000n);
    const before = await balance(p.wallet);
    // Below the minimum single withdrawal (ATA-rent siphon guard).
    await expect(requestWithdrawal(db, p.wallet, BigInt(ECONOMY.minWithdrawKeep) - 1n, DEST, k()))
      .rejects.toThrow(/minimum withdrawal/);
    // Not a valid base58 pubkey.
    await expect(requestWithdrawal(db, p.wallet, 1_000n, 'not a valid pubkey!!', k()))
      .rejects.toThrow(/invalid destination/);
    // Valid base58 but OFF-curve (a PDA) — payouts go to a wallet's ATA, so an
    // off-curve address can't receive and must be rejected up front, not after
    // a 48h escrow freeze (security review #3).
    const pda = PublicKey.findProgramAddressSync([new Uint8Array([1])], PublicKey.default)[0].toBase58();
    await expect(requestWithdrawal(db, p.wallet, 1_000n, pda, k()))
      .rejects.toThrow(/on-curve/);
    // Escrow never moved for any of the three.
    expect(await balance(p.wallet)).toBe(before);
  });
});

describe('KEEP deposit (owner 2026-07-19 — inbound custody credit)', () => {
  const inflowBalance = async (): Promise<bigint> => {
    const sys = await bootstrapSystemAccounts(db);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, sys.onchain_inflow));
    return row!.balance;
  };
  const keepPay = (wallet: string, baseUnits: bigint): VerifiedPayment => ({
    txSignature: `keep-${k()}`, wallet, kind: 'keep_deposit', lamports: baseUnits, finalized: true,
  });

  it('credits the OBSERVED on-chain KEEP to the play balance, exactly once', async () => {
    const p = await basePlayer(0n);
    const before = await balance(p.wallet);
    const intent = await createDepositIntent(db, p.wallet, 'keep_deposit');
    const pay = keepPay(p.wallet, 5_000n * 10n ** BigInt(TOKEN.decimals)); // 5,000 KEEP on-chain
    expect((await creditDeposit(db, intent.id, pay)).credited).toBe(true);
    expect(await balance(p.wallet)).toBe(before + 5_000n);
    // idempotent: the same credited deposit can't credit again
    expect((await creditDeposit(db, intent.id, pay)).credited).toBe(false);
    expect(await balance(p.wallet)).toBe(before + 5_000n);
  });

  it('keeps reserves balanced: player +amount / onchain_inflow -amount', async () => {
    const p = await basePlayer(0n);
    const inflowBefore = await inflowBalance();
    const intent = await createDepositIntent(db, p.wallet, 'keep_deposit');
    await creditDeposit(db, intent.id, keepPay(p.wallet, 2_000n * 10n ** BigInt(TOKEN.decimals)));
    expect(await inflowBalance()).toBe(inflowBefore - 2_000n); // mirror of the player credit
  });

  it('lets a player withdraw finalized KEEP deposits within their personal allowance', async () => {
    // WHY: deposited and earned KEEP intentionally share one player_keep account.
    // Deposited funds remain withdrawable, but use the same wallet-level limit.
    const p = await landPlayer(0n);
    const deposited = 60_000n;
    const intent = await createDepositIntent(db, p.wallet, 'keep_deposit');
    await creditDeposit(
      db, intent.id, keepPay(p.wallet, deposited * 10n ** BigInt(TOKEN.decimals)),
    );
    expect(await balance(p.wallet)).toBe(deposited);
    await expect(requestWithdrawal(db, p.wallet, deposited, DEST, k()))
      .rejects.toThrow(/daily withdrawal cap/);
    const cap = BigInt(withdrawDailyCapForKeepLevel(1));
    const withdrawal = await requestWithdrawal(db, p.wallet, cap, DEST, k());
    expect(withdrawal.amount).toBe(cap);
    expect(await balance(p.wallet)).toBe(deposited - cap);
  });

  it('rejects a sub-1-KEEP dust deposit (never credits 0)', async () => {
    const p = await basePlayer(0n);
    const intent = await createDepositIntent(db, p.wallet, 'keep_deposit');
    const dust = 10n ** BigInt(TOKEN.decimals) - 1n; // < 1 whole KEEP
    await expect(creditDeposit(db, intent.id, keepPay(p.wallet, dust))).rejects.toThrow(/below 1 KEEP/i);
  });

  it('a wallet mismatch between payment and intent is refused', async () => {
    const p = await basePlayer(0n);
    const other = await basePlayer(0n);
    const intent = await createDepositIntent(db, p.wallet, 'keep_deposit');
    await expect(creditDeposit(db, intent.id, keepPay(other.wallet, 1_000n * 10n ** BigInt(TOKEN.decimals))))
      .rejects.toThrow(/wallet does not match/);
  });
});

describe('mine_build — retired SOL rail, in-flight payments still honoured (D-057)', () => {
  // D-057 (owner 2026-08-16, verbatim: "we should not gate miners with sol at
  // start"): additional mines now place through POST /base/buildings charging
  // only the progressive KEEP, so 'mine_build' intent CREATION refuses for
  // everyone. The CREDIT path deliberately survives — a payment broadcast
  // against a pre-cutover intent must still place its mine (money moved is
  // money honoured). This block was REWRITTEN from the pre-D-057 pins (which
  // encoded "mines 2+ cost SOL"); the test count is preserved 8 → 8.
  const PRE_D057_2ND_MINE_LAMPORTS = 50_000_000n; // the retired 0.05 SOL 2nd-mine price
  async function playerWith1Mine(keep = 50_000n) {
    const p = await landPlayer(keep);
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, p.wallet));
    await rewardBaseShards(db, base!.id, keep, 'test.fund.base-shards', k());
    await placeBuilding(db, p.wallet, 'mine' as never, 17, 14, k(), new Date(), base!.id);
    await completeDueJobs(db, p.wallet, new Date(Date.now() + 120_000)); // free the builder
    return p;
  }
  /** Seed the row a pre-D-057 pod would have minted for the 2nd-mine slot —
   *  intent creation refuses now, so in-flight coverage must inject it. */
  async function seedInFlightMineBuild(
    wallet: string, opts: { lamports?: bigint; createdAt?: Date } = {},
  ) {
    const [base] = await db.select().from(bases).where(eq(bases.ownerWallet, wallet));
    const [row] = await db.insert(deposits).values({
      playerWallet: wallet, kind: 'mine_build', reference: k(), status: 'pending',
      payload: {
        baseId: base!.id, tx: 19, ty: 14, expectedMines: 1,
        amountLamports: Number(opts.lamports ?? PRE_D057_2ND_MINE_LAMPORTS),
        landPaidAt: base!.landPaidAt!.toISOString(), deedAssetId: base!.deedAssetId,
      },
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    }).returning();
    return row!;
  }
  const mineBuildPay = (wallet: string, lamports: bigint): VerifiedPayment => ({
    txSignature: `sol-${k()}`, wallet, kind: 'mine_build', lamports, finalized: true,
  });

  it('refuses every new mine_build intent — mines never cost SOL (D-057)', async () => {
    const zeroMines = await landPlayer(50_000n);
    await expect(createDepositIntent(db, zeroMines.wallet, 'mine_build', { tx: 19, ty: 14 }))
      .rejects.toMatchObject({ statusCode: 422, code: 'MINE_BUILD_SOL_RETIRED' });
    const oneMine = await playerWith1Mine();
    await expect(createDepositIntent(db, oneMine.wallet, 'mine_build', { tx: 19, ty: 14 }))
      .rejects.toMatchObject({ statusCode: 422, code: 'MINE_BUILD_SOL_RETIRED' });
  });

  it('an in-flight pre-D-057 payment still places the 2nd mine; progressive KEEP recycles', async () => {
    const p = await playerWith1Mine();
    const before = await balance(p.wallet);
    const inflight = await seedInFlightMineBuild(p.wallet);
    expect((await creditDeposit(db, inflight.id, mineBuildPay(p.wallet, PRE_D057_2ND_MINE_LAMPORTS))).credited).toBe(true);
    // progressive KEEP charged (recycled to emission_pool, not burned); the
    // old SOL price check passes because every current price is 0 ≤ paid.
    expect(await balance(p.wallet)).toBe(before - BigInt(MINING.MINE_BUILD_KEEP[1]!));
    const mines = await db.select().from(buildings)
      .where(and(eq(buildings.playerWallet, p.wallet), eq(buildings.type, 'mine')));
    expect(mines.length).toBe(2); // additive income now sums both
  });

  it('an in-flight payment that mismatches its frozen quote still grants nothing', async () => {
    const p = await playerWith1Mine();
    const inflight = await seedInFlightMineBuild(p.wallet);
    await expect(creditDeposit(db, inflight.id, mineBuildPay(p.wallet, PRE_D057_2ND_MINE_LAMPORTS - 1n)))
      .rejects.toThrow(/frozen quote/i);
    expect((await db.select().from(deposits).where(eq(deposits.id, inflight.id)))[0]?.status)
      .toBe('pending'); // kept for reconciliation, never silently consumed
  });

  it('concurrent refusals mint no pending rows at all', async () => {
    const p = await playerWith1Mine();
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, () =>
      createDepositIntent(db, p.wallet, 'mine_build', { tx: 19, ty: 14 })));
    expect(attempts.every((a) => a.status === 'rejected')).toBe(true);
    const rows = await db.select().from(deposits).where(and(
      eq(deposits.playerWallet, p.wallet), eq(deposits.kind, 'mine_build'),
    ));
    expect(rows).toHaveLength(0);
  });

  it('the free build path wins a race against an in-flight credit — never two mines for one slot', async () => {
    // The in-flight row froze expectedMines=1. If the player builds their 2nd
    // mine through the NEW free route before verification lands, the credit
    // must observe the changed slot and grant nothing more (409, row stays
    // pending for operator reconciliation) — not place a 3rd mine.
    const p = await playerWith1Mine();
    const inflight = await seedInFlightMineBuild(p.wallet);
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, p.wallet));
    await placeBuilding(db, p.wallet, 'mine' as never, 19, 14, k(), new Date(), base!.id);
    await expect(creditDeposit(db, inflight.id, mineBuildPay(p.wallet, PRE_D057_2ND_MINE_LAMPORTS)))
      .rejects.toMatchObject({ statusCode: 409 });
    const mines = await db.select().from(buildings)
      .where(and(eq(buildings.playerWallet, p.wallet), eq(buildings.type, 'mine')));
    expect(mines.length).toBe(2);
    expect((await db.select().from(deposits).where(eq(deposits.id, inflight.id)))[0]?.status)
      .toBe('pending');
  });

  it('a closing in-flight intent still credits — the creation refusal terminalizes nothing', async () => {
    const p = await playerWith1Mine();
    const closingCreatedAt = new Date(Date.now()
      - (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000 - 1);
    const inflight = await seedInFlightMineBuild(p.wallet, { createdAt: closingCreatedAt });
    const credit = await creditDeposit(db, inflight.id, mineBuildPay(p.wallet, PRE_D057_2ND_MINE_LAMPORTS));
    expect(credit.credited).toBe(true);
    expect((await db.select().from(deposits).where(eq(deposits.id, inflight.id)))[0]?.status)
      .toBe('credited');
  });

  it('a legacy-shaped pending row survives the refusal untouched (watcher owns its terminal state)', async () => {
    const p = await playerWith1Mine();
    const inflight = await seedInFlightMineBuild(p.wallet);
    await db.update(deposits).set({ payload: { tx: 19, ty: 14 } })
      .where(eq(deposits.id, inflight.id)); // pre-0071 shape, mutable via UPDATE only
    await expect(createDepositIntent(db, p.wallet, 'mine_build', { tx: 20, ty: 14 }))
      .rejects.toMatchObject({ code: 'MINE_BUILD_SOL_RETIRED' });
    expect((await db.select().from(deposits).where(eq(deposits.id, inflight.id)))[0]?.status)
      .toBe('pending');
  });

  it('rejects legacy-shaped pending mine_build inserts from rolling old pods', async () => {
    const p = await playerWith1Mine();
    await expect(db.insert(deposits).values({
      playerWallet: p.wallet, kind: 'mine_build', reference: k(), status: 'pending',
      payload: { tx: 19, ty: 14 },
    })).rejects.toMatchObject({
      cause: {
        code: '23514',
        message: expect.stringMatching(/legacy pending mine intent shape/),
      },
    });
  });
});

describe('shield extension (GDD §3.3 + ECONOMY.md §4a — SOL-only, pay-per-action in v3)', () => {
  it('requires an active shield; grants +extendHours capped at the ceiling; never touches KEEP', async () => {
    const p = await basePlayer(1_000n);

    // No active shield → the intent preflight refuses, so we never take an
    // on-chain payment for an extension that can't apply.
    await expect(assertShieldExtendable(db, p.wallet)).rejects.toThrow(/no active shield/);

    // Owner 2026-08-12: a paid extension becomes available only once the
    // remaining protection has fallen to 36 hours or less.
    const eligibleHours = SHIELD.extendPurchaseMaxRemainingHours - 6;
    await db.insert(shields).values({
      playerWallet: p.wallet, source: 'loss',
      expiresAt: new Date(Date.now() + eligibleHours * 3600 * 1000),
    });

    await assertShieldExtendable(db, p.wallet); // now allowed
    const keepBefore = await balance(p.wallet);
    const { expiresAt } = await grantShieldExtension(db, p.wallet);
    expect(expiresAt).not.toBeNull();

    // KEEP untouched — the SOL was paid on-chain (buy_sink), not from the ledger.
    expect(await balance(p.wallet)).toBe(keepBefore);
    // 30h + 12h = 42h, under the 48h ceiling.
    expect(expiresAt!.getTime()).toBeGreaterThan(Date.now() + (eligibleHours + SHIELD.extendHours - 1) * 3600 * 1000);
    expect(expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + SHIELD.maxHours * 3600 * 1000 + 1000);
  });

  it('never treats a warzone purchase as an ordinary shield or mutates it at credit time', async () => {
    const p = await basePlayer(0n);
    const now = new Date('2026-08-13T10:00:00.000Z');
    const longExpiry = new Date(now.getTime() + (SHIELD.maxHours + 12) * 3600 * 1000);
    await db.insert(shields).values({
      playerWallet: p.wallet, source: 'warzone', expiresAt: longExpiry,
    });

    await expect(assertShieldExtendable(db, p.wallet, now))
      .rejects.toThrow(/no active shield/);
    expect(await grantShieldExtension(db, p.wallet, now))
      .toEqual({ expiresAt: null, granted: false });
    const [row] = await db.select().from(shields).where(eq(shields.playerWallet, p.wallet));
    expect(row).toMatchObject({ source: 'warzone', expiresAt: longExpiry });
  });

  it('extends the longest ordinary row across stable/legacy coexistence but leaves warzone untouched', async () => {
    const p = await basePlayer(0n);
    const [base] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, p.wallet));
    const now = new Date('2026-08-13T10:00:00.000Z');
    const legacyExpiry = new Date(now.getTime() + 24 * 3_600_000);
    const stableExpiry = new Date(now.getTime() + 30 * 3_600_000);
    const warzoneExpiry = new Date(now.getTime() + 72 * 3_600_000);
    const [legacy, stable, warzone] = await db.insert(shields).values([
      { playerWallet: p.wallet, source: 'loss', expiresAt: legacyExpiry },
      { playerWallet: p.wallet, baseId: base!.id, source: 'purchase', expiresAt: stableExpiry },
      { playerWallet: p.wallet, baseId: base!.id, source: 'warzone', expiresAt: warzoneExpiry },
    ]).returning();

    await expect(assertShieldExtendable(db, p.wallet, now)).resolves.toBeUndefined();
    expect(await grantShieldExtension(db, p.wallet, now)).toEqual({
      expiresAt: new Date(stableExpiry.getTime() + SHIELD.extendHours * 3_600_000),
      granted: true,
    });
    const rows = await db.select().from(shields)
      .where(and(eq(shields.playerWallet, p.wallet)));
    expect(rows.find((row) => row.id === legacy!.id)?.expiresAt).toEqual(legacyExpiry);
    expect(rows.find((row) => row.id === stable!.id)?.expiresAt)
      .toEqual(new Date(stableExpiry.getTime() + SHIELD.extendHours * 3_600_000));
    expect(rows.find((row) => row.id === warzone!.id)).toMatchObject({
      source: 'warzone', expiresAt: warzoneExpiry,
    });
  });

  it('does NOT mint a shield when none is active — blocks the attack-then-reshield bypass', async () => {
    const p = await basePlayer(0n);
    // If the shield lapsed between paying and finalization (e.g. the player
    // attacked, breaking it), the grant is a no-op — it must never create a
    // fresh shield (security review 2026-07-19 #1).
    const { expiresAt } = await grantShieldExtension(db, p.wallet);
    expect(expiresAt).toBeNull();
    const rows = await db.select().from(shields).where(eq(shields.playerWallet, p.wallet));
    expect(rows.length).toBe(0);
  });

  it('credit is a no-op when the ordinary shield disappears after preflight, even if warzone remains', async () => {
    const p = await basePlayer(0n);
    const now = new Date('2026-08-13T10:00:00.000Z');
    const ordinaryExpiry = new Date(now.getTime() + 30 * 3_600_000);
    const warzoneExpiry = new Date(now.getTime() + 72 * 3_600_000);
    const [ordinary, warzone] = await db.insert(shields).values([
      { playerWallet: p.wallet, source: 'loss', expiresAt: ordinaryExpiry },
      { playerWallet: p.wallet, source: 'warzone', expiresAt: warzoneExpiry },
    ]).returning();
    await expect(assertShieldExtendable(db, p.wallet, now)).resolves.toBeUndefined();

    // Represents attack/break after the on-chain payment was sent but before
    // its finalized credit was applied.
    await db.delete(shields).where(eq(shields.id, ordinary!.id));
    expect(await grantShieldExtension(db, p.wallet, now))
      .toEqual({ expiresAt: null, granted: false });
    expect((await db.select().from(shields).where(eq(shields.id, warzone!.id)))[0])
      .toMatchObject({ source: 'warzone', expiresAt: warzoneExpiry });
  });

  it('refuses purchase while more than 36h remains', async () => {
    const p = await basePlayer(1_000n);
    const now = new Date('2026-08-13T10:00:00.000Z');
    // Already at the 48h ceiling — nothing to buy.
    const [ordinary] = await db.insert(shields).values({
      playerWallet: p.wallet, source: 'loss',
      expiresAt: new Date(now.getTime() + SHIELD.maxHours * 3600 * 1000 + 60_000),
    }).returning();
    await expect(assertShieldExtendable(db, p.wallet, now)).rejects.toThrow(
      // The refusal speaks the player's duration vocabulary (fmtDur: "1d 12h"), not raw hours.
      new RegExp(`${fmtDur(SHIELD.extendPurchaseMaxRemainingHours * 3_600)} remaining or less`),
    );
    expect(await grantShieldExtension(db, p.wallet, now)).toEqual({
      expiresAt: ordinary!.expiresAt,
      granted: false,
    });
  });

  it('shield deposit credit enforces the on-chain price and is idempotent', async () => {
    const p = await landPlayer(0n);
    const [base] = await db.select({ id: bases.id }).from(bases).where(eq(bases.ownerWallet, p.wallet));
    await db.insert(shields).values({
      playerWallet: p.wallet, baseId: base!.id, source: 'loss',
      expiresAt: new Date(Date.now() + 30 * 3600 * 1000),
    });
    const pay = (lamports: bigint): VerifiedPayment => ({
      txSignature: `sig-${k()}`, wallet: p.wallet, kind: 'shield', lamports, finalized: true,
    });
    // Underpaying the on-chain amount grants nothing (the credit tx rolls back).
    const under = await createDepositIntent(db, p.wallet, 'shield');
    await expect(creditDeposit(db, under.id, pay(BigInt(SHIELD.extendCostSolLamports) - 1n)))
      .rejects.toThrow(/frozen quote/);
    // A verified full-price payment extends once; re-crediting the same deposit
    // row (the idempotency anchor) does nothing.
    const [shieldBefore] = await db.select().from(shields).where(eq(shields.playerWallet, p.wallet));
    const intent = await createDepositIntent(db, p.wallet, 'shield');
    const full = pay(BigInt(SHIELD.extendCostSolLamports));
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(true);
    expect((await creditDeposit(db, intent.id, full)).credited).toBe(false);
    const [shieldAfter] = await db.select().from(shields).where(eq(shields.playerWallet, p.wallet));
    expect(shieldAfter!.expiresAt.getTime()).toBeGreaterThan(shieldBefore!.expiresAt.getTime());
  });
});

describe('KEEP buy-vend shutdown + historical-intent recovery', () => {
  const vendPay = (wallet: string, lamports: bigint): VerifiedPayment => ({
    txSignature: `sig-${k()}`, wallet, kind: 'keep_vend', lamports, finalized: true,
  });
  const historicalIntent = async (wallet: string, keepOut: number) => {
    const amountLamports = vendLamportsForKeep(keepOut);
    const [row] = await db.insert(deposits).values({
      playerWallet: wallet,
      kind: 'keep_vend',
      reference: Keypair.generate().publicKey.toBase58(),
      status: 'pending',
      payload: { keepOut, amountLamports: Number(amountLamports) },
    }).returning({ id: deposits.id });
    return { id: row!.id, amountLamports };
  };

  it('rejects every NEW vend intent with a typed fail-closed 503', async () => {
    const p = await landPlayer(0n);
    await expect(createDepositIntent(db, p.wallet, 'keep_vend', { keepOut: 1_000 }))
      .rejects.toMatchObject({ statusCode: 503, code: 'KEEP_VEND_UNAVAILABLE' });
  });

  it('credits an already-pending historical intent exactly once', async () => {
    const p = await landPlayer(0n);
    const intent = await historicalIntent(p.wallet, 1_000);
    const before = await balance(p.wallet);
    const pay = vendPay(p.wallet, intent.amountLamports);
    expect((await creditDeposit(db, intent.id, pay)).credited).toBe(true);
    expect(await balance(p.wallet)).toBe(before + 1_000n);
    // idempotent: the same deposit row never credits twice
    expect((await creditDeposit(db, intent.id, pay)).credited).toBe(false);
    expect(await balance(p.wallet)).toBe(before + 1_000n);
  });

  it('rejects an underpaid vend (server re-prices at credit time)', async () => {
    const p = await landPlayer(0n);
    const intent = await historicalIntent(p.wallet, 500);
    const before = await balance(p.wallet);
    await expect(creditDeposit(db, intent.id, vendPay(p.wallet, vendLamportsForKeep(500) - 1n)))
      .rejects.toThrow(/underpaid/);
    expect(await balance(p.wallet)).toBe(before); // rolled back, nothing granted
  });

  it('rejects a malformed historical intent instead of inventing a credit', async () => {
    const p = await landPlayer(0n);
    const intent = await historicalIntent(p.wallet, VEND.minKeepPerPurchase - 1);
    const before = await balance(p.wallet);
    await expect(creditDeposit(db, intent.id, vendPay(p.wallet, intent.amountLamports)))
      .rejects.toThrow(/invalid amount/);
    expect(await balance(p.wallet)).toBe(before);
  });

  it('keeps the historical recovery posting in onchain_inflow for PoR', async () => {
    const p = await landPlayer(0n);
    const sys = await bootstrapSystemAccounts(db);
    const [inflowBefore] = await db.select().from(accounts).where(eq(accounts.id, sys.onchain_inflow));
    const intent = await historicalIntent(p.wallet, 2_000);
    await creditDeposit(db, intent.id, vendPay(p.wallet, vendLamportsForKeep(2_000)));
    const [inflowAfter] = await db.select().from(accounts).where(eq(accounts.id, sys.onchain_inflow));
    expect(inflowAfter!.balance).toBe(inflowBefore!.balance - 2_000n);
  });
});
