import { PublicKey } from '@solana/web3.js';
import { authCookies } from '../../auth/authCookieCoordinator';
import type { GameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { mutationGate } from '../mutationGate';
import { parseMiningTaxClaimIdentity, type MiningTaxClaimIdentity } from './journal';
import type { MiningTaxClaimPorts } from './controller';
import { signMiningTaxClaim, type MiningTaxClaimSigningTrust } from './signing';
import { prepareMiningTaxClaimOriginal, savedMiningTaxClaimOriginal, failedMiningTaxClaimOriginal, prepareMiningTaxClaimContinuation, savedMiningTaxClaimContinuation, reviewMiningTaxClaimOriginal, submitMiningTaxClaimOriginal } from './transport';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const miningTaxClaimIdentity = (wallet: string): MiningTaxClaimIdentity => parseMiningTaxClaimIdentity({
 origin: window.location.origin, api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet,
});
export interface MiningTaxClaimBrowserOptions {
 identity: MiningTaxClaimIdentity;
 trust: MiningTaxClaimSigningTrust | null;
 wallet(): GameWallet;
 lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean };
 clock?: () => number;
}
/** Store, controller and these ports receive the same independent application
 * pins. The controller creates opaque static proofs and supplies its fresh
 * review/expiry guard; a server response cannot configure either capability. */
export function createMiningTaxClaimBrowserPorts(input: MiningTaxClaimBrowserOptions): MiningTaxClaimPorts {
 const identity = parseMiningTaxClaimIdentity(input.identity), wallet = input.wallet, lifecycle = input.lifecycle;
 const now = input.clock ?? (() => performance.now());
 const trust = input.trust === null ? null : Object.freeze({
  genesisHash: input.trust.genesisHash, programId: input.trust.programId, configAddress: input.trust.configAddress,
  keepMint: input.trust.keepMint, reserveOwner: input.trust.reserveOwner, reviewedDeploymentSlot: input.trust.reviewedDeploymentSlot,
  reviewedProgramDataSha256: input.trust.reviewedProgramDataSha256,
 });
 function requireTrust() {
  if (!trust) throw Error('Tax deployment trust is unavailable. Original recovery remains readable.');
  try {
   for (const name of ['genesisHash', 'programId', 'configAddress', 'keepMint', 'reserveOwner'] as const) {
    const value = trust[name];
    if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw Error();
    const publicKey = new PublicKey(value);
    if (publicKey.toBase58() !== value || publicKey.equals(PublicKey.default)) throw Error();
   }
   if (!Number.isSafeInteger(trust.reviewedDeploymentSlot) || trust.reviewedDeploymentSlot < 0
    || typeof trust.reviewedProgramDataSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(trust.reviewedProgramDataSha256)) throw Error();
  } catch { throw Error('Tax deployment trust is invalid. Keep the original recovery record.'); }
 }
 const capture: MiningTaxClaimPorts['capture'] = newAction => {
  if (!same(identity, miningTaxClaimIdentity(identity.wallet))) throw Error('This tax journal belongs to another origin, server or network.');
  if (newAction) requireTrust();
  const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), epoch = lifecycle().epoch;
  const signer = newAction ? wallet() : null, signerKey = signer?.publicKey?.toBase58(), signTransaction = signer?.signTransaction;
  const guard = () => {
   authCookies.assertResponse(revision);
   const state = useApp.getState(), page = lifecycle(), current = newAction ? wallet() : null;
   if (!same(identity, miningTaxClaimIdentity(identity.wallet)) || !authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet
    || !page.active || !page.visible || page.epoch !== epoch
    || newAction && (!mutationGate.getSnapshot() || !page.actionsEnabled || signerKey !== identity.wallet || typeof signTransaction !== 'function'
     || current?.publicKey?.toBase58() !== signerKey || current.signTransaction !== signTransaction)) {
    throw Error('The account, wallet signer or tax view changed. Recover the original request.');
   }
  };
  guard(); return guard;
 };
 const current = (guard: () => void) => () => { guard(); return true; };
 // Effects establish their own authority even if accidentally given a GET guard.
 const effect = (guard: () => void) => { guard(); const own = capture(true); return () => { guard(); own(); }; };
 let lastClock = 0;
 return {
  capture, key: () => crypto.randomUUID(),
  clock: () => {
   const value = now();
   if (!Number.isFinite(value) || value < lastClock || value > Number.MAX_SAFE_INTEGER) throw Error('The monotonic tax review clock is unavailable.');
   lastClock = value; return value;
  },
  lock: async (name, run) => {
   if (!navigator.locks?.request) throw Error('This browser cannot coordinate original tax claims across tabs.');
   return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw Error('Another tab is handling this original tax claim. Check its saved request.');
    return run();
   });
  },
  prepare: async (request, guard, retain) => {
   const check = effect(guard); check();
   return prepareMiningTaxClaimOriginal({ identity, request, method: 'POST', isCurrent: current(check), retain });
  },
  getPreparation: async (request, guard, retain) => {
   guard(); return prepareMiningTaxClaimOriginal({ identity, request, method: 'GET', isCurrent: current(guard), retain });
  },
  getSaved: async (idempotencyKey, guard, retain) => {
   guard(); return savedMiningTaxClaimOriginal({ identity, idempotencyKey, isCurrent: current(guard), retain });
  },
  getFailures: async (idempotencyKey, guard, retain) => {
   guard(); return failedMiningTaxClaimOriginal({ identity, idempotencyKey, isCurrent: current(guard), retain });
  },
  getContinuation: async (parentIdempotencyKey,guard,retain) => {guard();return savedMiningTaxClaimContinuation({identity,parentIdempotencyKey,isCurrent:current(guard),retain});},
  prepareContinuation: async (parentIdempotencyKey,request,guard,retain) => {const check=effect(guard),responseGuard=capture(false);check();return prepareMiningTaxClaimContinuation({identity,parentIdempotencyKey,request,isCurrent:current(check),isResponseCurrent:current(responseGuard),retain});},
  currentReview: async (idempotencyKey, ordinal, guard) => {
   const check = effect(guard); check();
   return reviewMiningTaxClaimOriginal({ identity, idempotencyKey, ordinal, isCurrent: current(check) });
  },
  sign: async (prepared, guard) => {
   const check = effect(guard); check();
   if (prepared.wallet !== identity.wallet) throw Error('This tax signing proof belongs to another wallet.');
   const signer = { ...wallet() }, sign = signer.signTransaction;
   if (!sign) throw Error('A sign-only tax wallet is unavailable.');
   check();
   // Invoke the full controller admission guard at the actual approval boundary.
   // No post-approval guard may discard a valid late wire before durable custody.
   return signMiningTaxClaim(prepared, { ...signer, signTransaction: transaction => { check(); return sign.call(signer, transaction); } });
  },
  submit: async (request, guard, retain) => {
   const check = effect(guard), responseGuard = capture(false); check();
   // Retention latches this acknowledgement's positive hold. That hold blocks
   // another send, but cannot invalidate the response which just established it.
   return submitMiningTaxClaimOriginal({ identity, request, isCurrent: current(check), isResponseCurrent: current(responseGuard), retain });
  },
 };
}
