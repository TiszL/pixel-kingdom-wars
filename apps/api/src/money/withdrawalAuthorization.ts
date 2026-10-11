/** Independent wallet authorization gate for hot-wallet KEEP payouts. */
import { createHash } from 'node:crypto';
import { verifyAsync } from '@noble/ed25519';
import { ECONOMY } from '@shardkeep/shared';
import bs58 from 'bs58';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { buildRecentAuthMessage } from '../auth/message';
import { readWithdrawalAuthChallengeAt } from '../auth/session';
import type { Config } from '../config';
import type { Db } from '../db/client';
import {
  accounts, ledgerEntries, ledgerTransactions, sessions,
  withdrawalAuthorizations, withdrawals,
} from '../db/schema';
import { errorForStorage } from '../lib/errors';
import { currentKeepMint } from './mintDimension';

export interface WithdrawalAuthorizationProof {
  challengeToken: string;
  signature: string;
}

export type WithdrawalAuthorizationTarget = Pick<
  typeof withdrawals.$inferSelect,
  | 'id' | 'playerWallet' | 'currency' | 'amount' | 'feeBurned'
  | 'destination' | 'unbondsAt' | 'requestLedgerTxnId' | 'createdAt'
>;

export type WithdrawalAuthorizationVerdict =
  | { ok: true; digest: string; cluster: 'devnet' | 'mainnet-beta'; keepMint: string }
  | { ok: false; reason: string };

export type WithdrawalAuthorizationGate = (
  withdrawal: WithdrawalAuthorizationTarget,
  now?: Date,
) => Promise<WithdrawalAuthorizationVerdict>;

const HOLD_TOLERANCE_MS = 10_000;

function sameMetadata(
  value: unknown,
  expected: { wallet: string; destination: string; instant: boolean },
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'destination,instant,wallet'
    && record['wallet'] === expected.wallet
    && record['destination'] === expected.destination
    && record['instant'] === expected.instant;
}

function challengeDigest(token: string, signature: string): string {
  return createHash('sha256').update(token).update('\0').update(signature).digest('hex');
}

/**
 * Verify and durably consume one wallet proof before the hot wallet signs.
 * `submitted_at` is database-authored and immutable, so a standard withdrawal
 * remains verifiable after its 24-hour hold without extending challenge life.
 */
export function makeWithdrawalAuthorizationGate(config: Config, db: Db): WithdrawalAuthorizationGate {
  const domain = new URL(config.WEB_ORIGIN[0]!).host;
  return async (target, now = new Date()): Promise<WithdrawalAuthorizationVerdict> => {
    try {
      return await db.transaction(async (tx): Promise<WithdrawalAuthorizationVerdict> => {
        const [row] = await tx.select({
          withdrawal: withdrawals,
          authorization: withdrawalAuthorizations,
        }).from(withdrawals)
          .innerJoin(
            withdrawalAuthorizations,
            eq(withdrawalAuthorizations.withdrawalId, withdrawals.id),
          )
          .where(eq(withdrawals.id, target.id))
          .for('update');
        if (!row) return { ok: false, reason: 'wallet authorization is missing' };
        const w = row.withdrawal;
        const authorization = row.authorization;
        if (w.status !== 'unbonding') {
          return { ok: false, reason: `withdrawal is ${w.status}, not unbonding` };
        }

        const challenge = await readWithdrawalAuthChallengeAt(
          config,
          authorization.challengeToken,
          { wallet: w.playerWallet, sessionId: extractSessionId(authorization.challengeToken) },
          authorization.submittedAt,
        );
        const [session] = await tx.select({ id: sessions.id }).from(sessions).where(and(
          eq(sessions.id, challenge.sid),
          eq(sessions.wallet, w.playerWallet),
          lte(sessions.createdAt, authorization.submittedAt),
          gt(sessions.expiresAt, authorization.submittedAt),
          or(isNull(sessions.revokedAt), gt(sessions.revokedAt, authorization.submittedAt)),
        )).limit(1);
        if (!session) return { ok: false, reason: 'signed session was not active when authorization was submitted' };

        const intent = challenge.intent!;
        if (!('grossAmount' in intent)) return { ok: false, reason: 'withdrawal intent is missing' };

        let signature: Uint8Array;
        let wallet: Uint8Array;
        try {
          signature = bs58.decode(authorization.walletSignature);
          wallet = bs58.decode(w.playerWallet);
        } catch {
          return { ok: false, reason: 'wallet authorization is not canonical base58' };
        }
        if (signature.length !== 64 || wallet.length !== 32) {
          return { ok: false, reason: 'wallet authorization has invalid byte length' };
        }
        const message = buildRecentAuthMessage({
          domain,
          wallet: w.playerWallet,
          sessionId: challenge.sid,
          purpose: 'withdrawal',
          nonce: challenge.nonce,
          issuedAt: new Date(challenge.iat! * 1_000),
          expiresAt: new Date(challenge.exp! * 1_000),
          intent,
        });
        if (!(await verifyAsync(signature, new TextEncoder().encode(message), wallet))) {
          return { ok: false, reason: 'wallet authorization signature is invalid' };
        }

        const expectedMode = intent.mode === 'instant';
        const expectedHold = expectedMode ? 0 : ECONOMY.unbondingHours;
        const expectedFee = (w.amount * BigInt(ECONOMY.withdrawFeeBps)) / 10_000n;
        if (intent.version !== 1
            || intent.cluster !== authorization.cluster
            || intent.keepMint !== authorization.keepMint
            || authorization.cluster !== config.SOLANA_CLUSTER
            || authorization.keepMint !== currentKeepMint(config.SOLANA_CLUSTER)
            || intent.grossAmount !== w.amount.toString()
            || intent.feeBurned !== w.feeBurned.toString()
            || intent.netAmount !== (w.amount - w.feeBurned).toString()
            || intent.destination !== w.destination
            || intent.unbondingHours !== expectedHold
            || w.currency !== 'KEEP'
            || w.feeBurned !== expectedFee) {
          return { ok: false, reason: 'signed withdrawal fields do not match the frozen request' };
        }
        const actualHold = w.unbondsAt.getTime() - w.createdAt.getTime();
        const signedHold = intent.unbondingHours * 3_600_000;
        if (Math.abs(actualHold - signedHold) > HOLD_TOLERANCE_MS) {
          return { ok: false, reason: 'withdrawal maturity does not match the signed mode' };
        }
        if (!w.requestLedgerTxnId) {
          return { ok: false, reason: 'withdrawal request has no ledger transaction' };
        }
        const [requestTxn] = await tx.select().from(ledgerTransactions)
          .where(eq(ledgerTransactions.id, w.requestLedgerTxnId)).limit(1);
        if (!requestTxn
            || requestTxn.type !== 'withdrawal.request'
            || requestTxn.idempotencyKey !== `withdrawal.request:${w.playerWallet}:${intent.idempotencyKey}`
            || !sameMetadata(requestTxn.metadata, {
              wallet: w.playerWallet, destination: w.destination, instant: expectedMode,
            })) {
          return { ok: false, reason: 'withdrawal request ledger identity does not match the signed intent' };
        }
        const entries = await tx.select({
          delta: ledgerEntries.delta,
          kind: accounts.kind,
          ownerWallet: accounts.ownerWallet,
        }).from(ledgerEntries)
          .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
          .where(eq(ledgerEntries.txnId, requestTxn.id));
        const playerDebit = entries.filter((entry) => (
          entry.kind === 'player_keep' && entry.ownerWallet === w.playerWallet
          && entry.delta === -w.amount
        ));
        const escrowCredit = entries.filter((entry) => (
          entry.kind === 'withdrawal_escrow' && entry.ownerWallet === null
          && entry.delta === w.amount
        ));
        if (entries.length !== 2 || playerDebit.length !== 1 || escrowCredit.length !== 1) {
          return { ok: false, reason: 'withdrawal request ledger entries are not the exact two-entry escrow freeze' };
        }

        const digest = challengeDigest(
          authorization.challengeToken, authorization.walletSignature,
        );
        if (authorization.validatedDigest !== null) {
          return authorization.validatedDigest === digest
            ? { ok: true, digest, cluster: authorization.cluster as 'devnet' | 'mainnet-beta', keepMint: authorization.keepMint }
            : { ok: false, reason: 'stored wallet authorization digest changed' };
        }
        const [validated] = await tx.update(withdrawalAuthorizations).set({
          validatedDigest: digest,
          validatedAt: now,
        }).where(and(
          eq(withdrawalAuthorizations.withdrawalId, w.id),
          isNull(withdrawalAuthorizations.validatedDigest),
        )).returning({ digest: withdrawalAuthorizations.validatedDigest });
        if (!validated || validated.digest !== digest) {
          return { ok: false, reason: 'wallet authorization could not be durably consumed' };
        }
        return {
          ok: true, digest,
          cluster: authorization.cluster as 'devnet' | 'mainnet-beta',
          keepMint: authorization.keepMint,
        };
      });
    } catch (error) {
      return { ok: false, reason: `wallet authorization verification failed: ${errorForStorage(error, 240)}` };
    }
  };
}

/** Decode the signed JWT payload only to recover sid; signature/claim validation
 * is immediately performed by readWithdrawalAuthChallengeAt before use. */
function extractSessionId(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof payload['sid'] === 'string' ? payload['sid'] : '';
  } catch {
    return '';
  }
}
