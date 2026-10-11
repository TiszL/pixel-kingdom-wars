/**
 * Fresh primary authentication for security-sensitive actions.
 *
 * Both external-wallet and Privy/social sessions sign through useGameWallet, so
 * the proof always comes from the embedded/external wallet that owns the active
 * server session. Grants stay only in component memory and are bound server-side
 * to that session, one purpose and (for instant withdrawals) one exact request.
 */
import bs58 from 'bs58';
import { useCallback, useRef } from 'react';
import { api } from '../lib/api';
import { useLoginChallenge } from './loginChallenge';
import { useApp } from '../state/store';
import { useGameWallet } from './useGameWallet';
import { waitForWalletSignature } from './walletSignature';

export type RecentAuthPurpose =
  | 'factor_change' | 'key_export' | 'withdrawal' | 'admin_mail_reward' | 'totp_recovery';

export interface WithdrawalRecentAuthIntent {
  version: 1;
  grossAmount: string;
  feeBurned: string;
  netAmount: string;
  cluster: 'devnet' | 'mainnet-beta';
  keepMint: string;
  destination: string;
  idempotencyKey: string;
  mode: 'standard' | 'instant';
  unbondingHours: number;
}

/** Exact digest of one admin reward delivery. The API recomputes contentHash
 * from the normalized send body, so this proof cannot authorize a different
 * recipient, reward, subject, or delivery key. */
export interface AdminMailRewardRecentAuthIntent {
  recipientWallet: string;
  idempotencyKey: string;
  subject: string;
  attachments: Array<
    | { kind: 'KEEP' | 'SHARDS'; amount: string }
    | { kind: 'ITEM'; itemId: string; qty: number }
  >;
  contentHash: string;
}

export interface TotpRecoveryRecentAuthIntent {
  recoveryId: string;
  action: 'start' | 'complete';
}

export type RecentAuthIntent =
  | WithdrawalRecentAuthIntent | AdminMailRewardRecentAuthIntent | TotpRecoveryRecentAuthIntent;

interface ChallengeResponse {
  challengeToken: string;
  message: string;
  expiresAt: string;
}

interface GrantResponse {
  grant: string;
  purpose: RecentAuthPurpose;
  expiresAt: string;
}

export interface WithdrawalWalletProof {
  challengeToken: string;
  signature: string;
}

interface CachedGrant {
  grant: string;
  expiresAtMs: number;
  proof?: WithdrawalWalletProof;
}

export function useRecentAuth(): {
  prove: (purpose: RecentAuthPurpose, intent?: RecentAuthIntent) => Promise<string>;
  proveWithdrawal: (intent: WithdrawalRecentAuthIntent) => Promise<{
    grant: string;
    proof: WithdrawalWalletProof;
  }>;
  isEmbedded: boolean;
} {
  const gameSession = useApp((s) => s.wallet);
  const pendingSession = useLoginChallenge((s) => s.wallet);
  const sessionWallet = gameSession ?? pendingSession;
  const { publicKey, signMessage, isEmbedded } = useGameWallet();
  const cache = useRef(new Map<string, CachedGrant>());

  const proveDetailed = useCallback(async (
    purpose: RecentAuthPurpose,
    intent?: RecentAuthIntent,
  ): Promise<CachedGrant> => {
    if (!sessionWallet || !publicKey || !signMessage || publicKey.toBase58() !== sessionWallet) {
      throw new Error('Reconnect the wallet that owns this account to confirm this action.');
    }
    const intentRequired = purpose === 'withdrawal' || purpose === 'admin_mail_reward'
      || purpose === 'totp_recovery';
    if (intentRequired !== !!intent
      || (purpose === 'withdrawal' && intent && !('grossAmount' in intent))
      || (purpose === 'admin_mail_reward' && intent && !('contentHash' in intent))
      || (purpose === 'totp_recovery' && intent && !('recoveryId' in intent))) {
      throw new Error('This sensitive action is missing its signed request details.');
    }
    const cacheKey = JSON.stringify([sessionWallet, purpose, intent ?? null]);
    const cached = cache.current.get(cacheKey);
    // Keep a small margin so a grant cannot expire between proof and POST.
    if (cached && cached.expiresAtMs > Date.now() + 10_000) return cached;

    const challenge = await api.postRaw<ChallengeResponse>('/auth/reauth/challenge', {
      purpose,
      ...(intent ? { intent } : {}),
    });
    const signatureBytes = await waitForWalletSignature(
      signMessage(new TextEncoder().encode(challenge.message)),
    );
    const signature = bs58.encode(signatureBytes);
    const verified = await api.postRaw<GrantResponse>('/auth/reauth/verify', {
      challengeToken: challenge.challengeToken,
      signature,
    });
    if (verified.purpose !== purpose) throw new Error('The wallet confirmed a different action.');
    const expiresAtMs = Date.parse(verified.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('Wallet confirmation expired. Please try again.');
    }
    const result: CachedGrant = {
      grant: verified.grant,
      expiresAtMs,
      ...(purpose === 'withdrawal' ? {
        proof: { challengeToken: challenge.challengeToken, signature },
      } : {}),
    };
    cache.current.set(cacheKey, result);
    return result;
  }, [sessionWallet, publicKey, signMessage]);

  const prove = useCallback(async (
    purpose: RecentAuthPurpose, intent?: RecentAuthIntent,
  ): Promise<string> => (await proveDetailed(purpose, intent)).grant, [proveDetailed]);

  const proveWithdrawal = useCallback(async (intent: WithdrawalRecentAuthIntent) => {
    const result = await proveDetailed('withdrawal', intent);
    if (!result.proof) throw new Error('Wallet confirmation did not return a withdrawal proof.');
    return { grant: result.grant, proof: result.proof };
  }, [proveDetailed]);

  return { prove, proveWithdrawal, isEmbedded };
}
