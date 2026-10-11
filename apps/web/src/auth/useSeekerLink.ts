/**
 * Link a Solana Mobile Seeker wallet to the signed-in game account.
 *
 * The Seeker wallet SIGNS a purpose-scoped challenge — it never becomes the
 * session wallet and never signs a payment. Two shapes, one server contract:
 *
 *  A) The session already IS the Seeker wallet (external-wallet sign-in). The
 *     connected adapter signs; seekerWallet === the game wallet.
 *  B) A Privy/social session. The embedded wallet can never hold an SGT, so the
 *     player connects their Seeker wallet through the normal wallet modal —
 *     WITHOUT calling setAuth, so the game session and the payment wallet
 *     (useGameWallet) are untouched.
 *
 * The `.skr` domain is optional and purely cosmetic; the server re-derives and
 * re-checks it on-chain, so a wrong value is ignored rather than trusted.
 */
import { useWallet } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { useCallback, useState } from 'react';
import { api } from '../lib/api';

export interface SeekerStatus {
  linked: boolean;
  seekerWallet: string | null;
  sgtMint: string | null;
  memberNumber: number | null;
  skrDomain: string | null;
  verifiedAt: string | null;
  stale: boolean;
}

interface LinkChallenge { nonce: string; message: string; expiresAt: string }

export function useSeekerLink(): {
  /** Runs the whole challenge → sign → verify round trip. */
  link: (skrDomain?: string) => Promise<SeekerStatus | null>;
  unlink: () => Promise<void>;
  /** Server-side .skr auto-discovery for a LINKED account with no domain on
   *  file. Returns the refreshed status, or null on failure (error is set). */
  findSkr: () => Promise<SeekerStatus | null>;
  busy: boolean;
  error: string | null;
  /** The wallet that would be linked, or null when none is connected. */
  candidate: string | null;
} {
  const { publicKey, signMessage } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = useCallback(async (skrDomain?: string): Promise<SeekerStatus | null> => {
    if (!publicKey || !signMessage) {
      setError('CONNECT YOUR SEEKER WALLET FIRST');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const seekerWallet = publicKey.toBase58();
      const challenge = await api.post<LinkChallenge>('/seeker/link/challenge', { seekerWallet });
      const signature = await signMessage(new TextEncoder().encode(challenge.message));
      const res = await api.post<{ seeker: SeekerStatus; username: string | null }>(
        '/seeker/link/verify',
        { seekerWallet, signature: bs58.encode(signature), ...(skrDomain ? { skrDomain } : {}) },
      );
      return res.seeker;
    } catch (e) {
      setError(e instanceof Error ? e.message.toUpperCase() : 'LINK FAILED');
      return null;
    } finally {
      setBusy(false);
    }
  }, [publicKey, signMessage]);

  const unlink = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.del('/seeker/link');
    } catch (e) {
      setError(e instanceof Error ? e.message.toUpperCase() : 'UNLINK FAILED');
    } finally {
      setBusy(false);
    }
  }, []);

  const findSkr = useCallback(async (): Promise<SeekerStatus | null> => {
    setBusy(true);
    setError(null);
    try {
      // The server re-runs discovery against the LINKED Seeker wallet and
      // forward-proves anything it finds — nothing here is client-decided.
      const res = await api.post<{ seeker: SeekerStatus; username: string | null }>(
        '/seeker/skr/adopt', {},
      );
      return res.seeker;
    } catch (e) {
      setError(e instanceof Error ? e.message.toUpperCase() : '.SKR LOOKUP FAILED');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { link, unlink, findSkr, busy, error, candidate: publicKey?.toBase58() ?? null };
}
