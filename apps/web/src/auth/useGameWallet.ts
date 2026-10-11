/**
 * Unified game signer — resolves WHICH wallet signs a payment tx for the
 * current session: the Privy embedded wallet (social/email accounts) when the
 * session wallet is one, else the wallet-adapter wallet (Phantom/Solflare/MWA).
 *
 * Fixes the Phantom-opens-for-Privy-users bug: every payment hook previously
 * read `useWallet()` (the adapter), so a Privy session either had no signer or
 * prompted the WRONG wallet. Selection is by the authenticated session wallet
 * (store.wallet), so the tx payer always matches the player identity.
 *
 * Exported as a module-level branch on VITE_PRIVY_APP_ID (build-time constant):
 * the Privy variant calls Privy hooks and only exists when PrivyProvider is
 * mounted (App.tsx mounts it under the same env condition).
 */
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWallets } from '@privy-io/react-auth/solana';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { useMemo } from 'react';
import { SOLANA_CHAIN } from '../lib/cluster';
import { useLoginChallenge } from './loginChallenge';
import { useApp } from '../state/store';
import { findPrivyEmbeddedWallet, walletMatchesSession } from './privyWallet';

const PRIVY_ENABLED = !!import.meta.env.VITE_PRIVY_APP_ID;
/** Wallet-standard chain id from the same fail-closed source as MWA and RPC. */
const CHAIN = SOLANA_CHAIN;

export interface GameWallet {
  /** The signing wallet's pubkey (null until a signer is available). */
  publicKey: PublicKey | null;
  /** Sign an off-chain security message with the session wallet. */
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  /** Sign + send `tx`; resolves to the tx signature (base58). Null while no signer. */
  sendTransaction: ((tx: Transaction) => Promise<string>) | null;
  /** Opt-in sign-only rail. The caller persists proof and owns the one broadcast. */
  signTransaction?: ((tx: Transaction) => Promise<Transaction>) | null;
  /** Charter v0 consent only; callers retain bytes and own exact delivery. */
  signVersionedTransaction?: ((tx: VersionedTransaction) => Promise<VersionedTransaction>) | null;
  /** True when the signer is the Privy embedded wallet (no extension popup). */
  isEmbedded: boolean;
}

const NO_GAME_WALLET: GameWallet = {
  publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false,
};

/** Adapter-only variant (Privy disabled or no embedded match). */
function useGameWalletAdapter(): GameWallet {
  const { publicKey, signMessage, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  return useMemo(() => ({
    publicKey,
    isEmbedded: false,
    signMessage: publicKey && signMessage ? signMessage : null,
    signTransaction: publicKey && signTransaction ? signTransaction : null,
    signVersionedTransaction: publicKey && signTransaction ? signTransaction : null,
    sendTransaction: publicKey && sendTransaction
      ? async (tx: Transaction) => sendTransaction(tx, connection)
      : null,
  }), [publicKey, signMessage, sendTransaction, signTransaction, connection]);
}

function useGameWalletPrivy(): GameWallet {
  const adapter = useGameWalletAdapter();
  const { connection } = useConnection();
  const { wallets } = useWallets();
  const gameSession = useApp((s) => s.wallet);
  const pendingSession = useLoginChallenge((s) => s.wallet);
  const session = gameSession ?? pendingSession;

  return useMemo(() => {
    const embedded = findPrivyEmbeddedWallet(wallets, session);
    if (!embedded) {
      // Reject a disconnected or switched adapter. Every signer must still own
      // the authenticated session; otherwise factor proof and payments could be
      // requested from a different wallet after the session was established.
      return walletMatchesSession(adapter.publicKey, session) ? adapter : NO_GAME_WALLET;
    }
    const pk = new PublicKey(embedded.address);
    return {
      publicKey: pk,
      isEmbedded: true,
      signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
        const out = await embedded.signMessage({ message });
        return out.signature;
      },
      signTransaction: async (tx: Transaction): Promise<Transaction> => {
        // Preserve the caller's quoted payer/message/blockhash. This path must
        // never delegate to signAndSendTransaction or refresh transaction terms.
        const out = await embedded.signTransaction({
          transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
          chain: CHAIN as `solana:${string}`,
        });
        return Transaction.from(out.signedTransaction);
      },
      signVersionedTransaction: async (tx: VersionedTransaction): Promise<VersionedTransaction> => {
        const out = await embedded.signTransaction({ transaction: tx.serialize(), chain: CHAIN as `solana:${string}` });
        return VersionedTransaction.deserialize(out.signedTransaction);
      },
      sendTransaction: async (tx: Transaction): Promise<string> => {
        // The adapter fills these in sendTransaction(); for Privy we serialize
        // ourselves, so set the payer + a fresh blockhash first.
        tx.feePayer = pk;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const out = await embedded.signAndSendTransaction({
          transaction: serialized,
          chain: CHAIN as `solana:${string}`,
        });
        return bs58.encode(out.signature);
      },
    };
  }, [session, wallets, adapter, connection]);
}

export const useGameWallet: () => GameWallet = PRIVY_ENABLED ? useGameWalletPrivy : useGameWalletAdapter;
