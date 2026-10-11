import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import type { MiningClaimPreparationView } from '@shardkeep/shared/miningClaimsApi';
import type { Connection } from '@solana/web3.js';
import { authCookies } from '../../auth/authCookieCoordinator';
import type { GameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { api, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { mutationGate } from '../mutationGate';
import { miningClaimLock, type MiningClaimPorts } from './controller';
import { parseMiningClaimIdentity, same, type MiningClaimIdentity } from './journal';
import { prepareMiningClaimSigning, signMiningClaim, type MiningClaimSigningTrust } from './signing';
import { claimMiningOriginal, prepareMiningClaimOriginal, submitMiningOriginal, continueMiningOriginal } from './transport';

export const miningClaimIdentity = (wallet: string): MiningClaimIdentity => parseMiningClaimIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });

export function createMiningClaimBrowserPorts(input: { identity: MiningClaimIdentity;
  connection: Pick<Connection, 'getGenesisHash' | 'getBlockHeight'>; trust: MiningClaimSigningTrust | null;
  wallet(): GameWallet; lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): MiningClaimPorts {
  const identity = parseMiningClaimIdentity(input.identity);
  // These five strings are independent application configuration, never fields
  // learned from an API response. A factory keeps its original pins for life.
  const trust = input.trust === null ? null : Object.freeze({ genesisHash: input.trust.genesisHash, programId: input.trust.programId,
    configAddress: input.trust.configAddress, keepMint: input.trust.keepMint, reserveOwner: input.trust.reserveOwner,...(input.trust.orderedLookupTable?{orderedLookupTable:Object.freeze({...input.trust.orderedLookupTable})}:{}) });
  function requireTrust(): MiningClaimSigningTrust {
    if (!trust) throw Error('Mining claim deployment trust is unavailable. Saved receipts can still be recovered.');
    return trust;
  }
  const capture: MiningClaimPorts['capture'] = newAction => {
    if (!same(identity, miningClaimIdentity(identity.wallet))) throw Error('This mining claim journal belongs to another origin, server or network.');
    if (newAction) requireTrust();
    const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), epoch = input.lifecycle().epoch;
    const signer = newAction ? input.wallet() : null, signerKey = signer?.publicKey?.toBase58(), signTransaction = signer?.signTransaction,signVersionedTransaction=signer?.signVersionedTransaction;
    const guard = () => {
      authCookies.assertResponse(revision);
      const state = useApp.getState(), page = input.lifecycle(), currentWallet = newAction ? input.wallet() : null;
      if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== epoch
        || newAction && (!mutationGate.getSnapshot() || !page.actionsEnabled || signerKey !== identity.wallet || typeof signTransaction !== 'function'
          || currentWallet?.publicKey?.toBase58() !== signerKey || currentWallet.signTransaction !== signTransaction || currentWallet.signVersionedTransaction !== signVersionedTransaction))
        throw Error('The account, wallet signer or mining claim view changed. Check the original saved claim.');
    };
    guard(); return guard;
  };
  const current = (guard: () => void) => () => { guard(); return true; };
  // A deadline does not mean an RPC actually stopped. Keep this factory fenced
  // until its underlying read drains, and never use a timed-out answer later.
  let pendingRead: Promise<unknown> | null = null;
  async function read<T>(guard: () => void, run: (check: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
    guard(); if (pendingRead) throw Error('A mining claim read is still pending. Check again after it finishes.');
    let expired = false;
    const abort = new AbortController(), timeout = () => Error('Mining claim read timed out. The original recovery record is kept.');
    const check = () => { if (expired) throw timeout(); guard(); };
    const work = Promise.resolve().then(() => { check(); return run(check, abort.signal); });
    const tracked = work.finally(() => { if (pendingRead === tracked) pendingRead = null; });
    pendingRead = tracked;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { expired = true; abort.abort(); reject(timeout()); }, LAND_CHECKOUT_RECOVERY.requestTimeoutMs); });
    try { const value = await Promise.race([tracked, deadline]); check(); return value; }
    finally { clearTimeout(timer); }
  }
  function checkedPreparation(p: MiningClaimPreparationView,ordinal=0) {
    if (p.wallet !== identity.wallet) throw Error('This mining preparation belongs to another wallet.');
    return prepareMiningClaimSigning(p, requireTrust(),ordinal);
  }
  return {
    capture, lock: miningClaimLock, key: () => crypto.randomUUID(), clock: () => performance.now(),
    getStatus: guard => read(guard, (check, signal) => api.get('/claims/mining/status', { signal, isCurrent: current(check) })),
    // Original transports retain owned evidence before rejecting an obsolete
    // view. Do not wrap them in the ordinary read cancellation race above.
    prepare: (request, guard, retain, refusal) => { guard(); requireTrust(); return prepareMiningClaimOriginal({ request, method: 'POST', isCurrent: current(guard), retain, refusal }); },
    getPreparation: (request, guard, retain) => { guard(); return prepareMiningClaimOriginal({ request, method: 'GET', isCurrent: current(guard), retain }); },
    getClaim: (claimId, guard, retain) => { guard(); return claimMiningOriginal({ claimId, isCurrent: current(guard), retain }); },
    reviewOrdered:(claimId,ordinal,guard)=>read(guard,(check,signal)=>api.get(`/claims/mining/${encodeURIComponent(claimId)}/review?ordinal=${ordinal}`,{signal,isCurrent:current(check)})),
    continuation:(parentClaimId,request,guard,retain,refusal)=>{guard();if(request)requireTrust();return continueMiningOriginal({parentClaimId,request,isCurrent:current(guard),retain,...(refusal?{refusal}:{})});},
    submit: (request, guard) => { guard(); requireTrust(); return submitMiningOriginal({ request, isCurrent: current(guard) }); },
    live: async (p, guard,ordinal=0) => {
      guard(); checkedPreparation(p,ordinal);
      const expectedGenesis = requireTrust().genesisHash, lastValidBlockHeight = p.transactions[0]!.lastValidBlockHeight;
      await read(guard, async check => {
        const genesis = await input.connection.getGenesisHash(); check();
        if (genesis !== expectedGenesis) throw Error('The claim RPC serves a different Solana network.');
        const height = await input.connection.getBlockHeight('finalized'); check();
        if (!Number.isSafeInteger(height) || height < 0) throw Error('The finalized claim block height is unavailable.');
        if (height > lastValidBlockHeight) throw Error('The original claim blockhash has expired. Keep its recovery record.');
      });
    },
    sign: async (p, guard,ordinal=0) => {
      guard(); const prepared = checkedPreparation(p,ordinal), signer = { ...input.wallet() }; guard();
      // No post-await lifecycle check: the controller must persist a valid late
      // signature before deciding whether the original view is still current.
      return signMiningClaim(prepared, signer);
    },
  };
}
