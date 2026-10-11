/** Positive SGT qualification from a committed unchanged link and two retained
 * archival transcripts. This private replay validates owner-captured evidence;
 * it does not authenticate arbitrary request JSON or infer missing history. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY as P } from '@shardkeep/shared';
import { miningSeekerTokenAccount, readAgreedMiningSeekerMintBirthEvidence, replayMiningSeekerMintBirthEvidence,
 type MiningSeekerHoldingReader, type MiningSeekerMintBirthInput } from '@shardkeep/chain/mining-seeker-holding';
import { readAgreedMiningSeekerCoverageEvidence, replayMiningSeekerCoverageEvidence,
 type MiningSeekerCoverageReader } from '@shardkeep/chain/mining-seeker-coverage';
import { z } from 'zod';
import type { Db } from '../db/client';
import { readMiningSeekerCheckpointInterval, validateMiningSeekerCheckpointIntervalEvidence,
 readMiningSeekerCoverageChallenge, validateMiningSeekerCoverageChallenge,
 type MiningSeekerCheckpointIntervalEvidence, type MiningSeekerCoverageChallenge } from './seekerCheckpointHistory';

// Resource bounds only. The enclosing publication imposes the same total limit
// on all participants, reservations and proofs together.
const MAX_BYTES = 4 * 1024 * 1024, MAX_NODES = 200_000, MAX_DEPTH = 64;
type Code = 'INVALID_INPUT' | 'SOURCE_UNAVAILABLE' | 'SOURCE_CONFLICT' | 'PROVIDER_CONFIGURATION' | 'TOO_LARGE' | 'ABORTED';
export class MiningSeekerQualificationError extends Error {
 constructor(readonly code: Code) { super(`Mining Seeker qualification refused: ${code}`); this.name = 'MiningSeekerQualificationError'; }
}
function fail(code: Code): never { throw new MiningSeekerQualificationError(code); }
function need(value: unknown, code: Code = 'SOURCE_CONFLICT'): asserts value { if (!value) fail(code); }
const key = z.string().min(32).max(44).refine(value => {
 try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
const providerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const signature = z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const request = z.object({ wallet: key, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const providerProof = z.object({ id: providerId, evidenceJson: z.string().min(1).max(MAX_BYTES), coverageEvidenceJson: z.string().min(1).max(MAX_BYTES) }).strict();
const envelope = request.extend({ version: z.literal(1), checkpoint: z.unknown(), coverageChallenge: z.unknown(), coverageSignature: signature,
 providers: z.tuple([providerProof, providerProof]) }).strict();
export type SeekerMiningQualificationReader = MiningSeekerHoldingReader & MiningSeekerCoverageReader;
export interface SeekerMiningQualificationWiring {
 readonly coverageSignature: string;
 readonly providers: readonly [
  { readonly id: string; readonly connect: (signal: AbortSignal) => SeekerMiningQualificationReader },
  { readonly id: string; readonly connect: (signal: AbortSignal) => SeekerMiningQualificationReader },
 ];
}
export interface MiningSeekerQualificationEvidence {
 readonly version: 1; readonly wallet: string; readonly day: string;
 readonly checkpoint: MiningSeekerCheckpointIntervalEvidence;
 readonly coverageChallenge: MiningSeekerCoverageChallenge; readonly coverageSignature: string;
 readonly providers: readonly [{ readonly id: string; readonly evidenceJson: string; readonly coverageEvidenceJson: string },
  { readonly id: string; readonly evidenceJson: string; readonly coverageEvidenceJson: string }];
}
/** Bound strings/nodes before JSON encoding, reject cycles and non-JSON values,
 * then own the complete immutable copy rather than caller-owned nested facts. */
function copy(value: unknown): unknown {
 let nodes = 0, bytes = 0;
 const seen = new WeakSet<object>();
 function walk(v: unknown, depth: number): void {
  if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('TOO_LARGE');
  if (typeof v === 'string') { bytes += Buffer.byteLength(v); if (bytes > MAX_BYTES) fail('TOO_LARGE'); }
  else if (v !== null && typeof v === 'object') {
   need(!seen.has(v)); seen.add(v);
   need(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
   for (const [k, child] of Object.entries(v)) { bytes += Buffer.byteLength(k); if (bytes > MAX_BYTES) fail('TOO_LARGE'); walk(child, depth + 1); }
   seen.delete(v);
  } else need(v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isSafeInteger(v));
 }
 walk(value, 0); const text = JSON.stringify(value); need(typeof text === 'string'); if (Buffer.byteLength(text) > MAX_BYTES) fail('TOO_LARGE'); return JSON.parse(text);
}
function freeze<T>(value: T): T {
 if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
 return value;
}
function micros(value: string): bigint {
 need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value));
 const whole = Date.parse(value.slice(0, 19) + 'Z'); need(Number.isSafeInteger(whole));
 return BigInt(whole) * 1_000n + BigInt(value.slice(20, 26));
}
function inputFor(checkpoint: MiningSeekerCheckpointIntervalEvidence): MiningSeekerMintBirthInput {
 const { seekerWallet, sgtMint } = checkpoint.link;
 return { linkedWallet: seekerWallet, mint: sgtMint,
  tokenAccount: miningSeekerTokenAccount(seekerWallet, sgtMint),
  startAt: new Date(checkpoint.startsAt), endAt: new Date(checkpoint.endsAt), coverageFloor: new Date(checkpoint.coverageStartedAt) };
}
function providerIds(a: string, b: string): void { need(a.toLowerCase() !== b.toLowerCase(), 'PROVIDER_CONFIGURATION'); }

export function replayMiningSeekerQualification(value: unknown) {
 const parsed = envelope.safeParse(copy(value)); need(parsed.success); const owned = parsed.data;
 providerIds(owned.providers[0].id, owned.providers[1].id);
 const checkpoint = validateMiningSeekerCheckpointIntervalEvidence(owned.checkpoint);
 const coverageChallenge = validateMiningSeekerCoverageChallenge(owned.coverageChallenge);
 need(checkpoint.wallet === owned.wallet && checkpoint.day === owned.day);
 need(coverageChallenge.coverageStartedAt === checkpoint.coverageStartedAt && coverageChallenge.recordedHistoryStartedAt === checkpoint.recordedHistoryStartedAt
  && coverageChallenge.birthEventFloor === checkpoint.birthEventFloor);
 const input = inputFor(checkpoint);
 const witnesses = owned.providers.map(provider => replayMiningSeekerCoverageEvidence(provider.coverageEvidenceJson,
  { nonceHex: coverageChallenge.nonce, signature: owned.coverageSignature }));
 const [witness, otherWitness] = witnesses; need(witness && otherWitness);
 // Identical signatures with valid Ed25519 verification bind the exact original
 // memo message; block slots must agree as well. Chain time is not a DB clock.
 need(witness.signature === otherWitness.signature && witness.slot === otherWitness.slot && witness.blockTime === otherWitness.blockTime && witness.genesisHash === otherWitness.genesisHash
  && witness.messageSha256 === otherWitness.messageSha256);
 const proofs = owned.providers.map(provider => replayMiningSeekerMintBirthEvidence(provider.evidenceJson, input));
 const [first, second] = proofs; need(first && second);
 need(first.mintBirth.slot > witness.slot && second.mintBirth.slot > witness.slot);
 const firstWire = JSON.parse(first.evidenceJson) as { accounts: { owner: string; data: string }[] };
 const secondWire = JSON.parse(second.evidenceJson) as { accounts: { owner: string; data: string }[] };
 need(firstWire.accounts.every((account, i) => account.owner === secondWire.accounts[i]?.owner && account.data === secondWire.accounts[i]?.data)
  && JSON.stringify(first.generation) === JSON.stringify(second.generation) && JSON.stringify(first.mintBirth) === JSON.stringify(second.mintBirth));
 // Chain timestamps have whole-second precision. Compare the actual original
 // database microseconds as well as the chain reader's millisecond floor.
 const born = BigInt(first.mintBirth.blockTime) * 1_000_000n;
 need(born > micros(checkpoint.coverageStartedAt));
 const claims = checkpoint.events.filter(event => event.sourceTable === 'seeker_links' && event.afterState !== null
  && (event.afterState as { sgt_mint?: string }).sgt_mint === checkpoint.link.sgtMint);
 need(claims.length > 0 && claims.every(event => born <= micros(event.observedAt)));
 need(born < micros(checkpoint.checkpoint.observedAt));
 const evidence: MiningSeekerQualificationEvidence = freeze({ version: 1, wallet: owned.wallet, day: owned.day, checkpoint, coverageChallenge, coverageSignature: owned.coverageSignature,
  providers: [owned.providers[0], owned.providers[1]] });
 return freeze({ wallet: owned.wallet, day: owned.day, seekerWallet: input.linkedWallet, sgtMint: input.mint,
  tokenAccount: input.tokenAccount, bonusBps: P.mining.seekerBonusBps, evidence });
}

export async function captureMiningSeekerQualification(db: Db, wiring: SeekerMiningQualificationWiring,
 value: { wallet: string; day: string }, signal?: AbortSignal): Promise<MiningSeekerQualificationEvidence> {
 const parsed = request.safeParse(value); need(parsed.success, 'INVALID_INPUT');
 need(Array.isArray(wiring?.providers) && wiring.providers.length === 2, 'PROVIDER_CONFIGURATION');
 need(signature.safeParse(wiring.coverageSignature).success, 'PROVIDER_CONFIGURATION'); const coverageSignature = wiring.coverageSignature;
 const providers = wiring.providers.map(provider => {
  need(provider && providerId.safeParse(provider.id).success && typeof provider.connect === 'function', 'PROVIDER_CONFIGURATION');
  return { id: provider.id, connect: provider.connect };
 });
 providerIds(providers[0]!.id, providers[1]!.id);
 const controller = new AbortController(), combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
 const active = () => { if (combined.aborted) fail('ABORTED'); };
 let rejectAbort: (() => void) | undefined;
 try {
  active();
  const run = async () => {
   const coverageChallenge = await readMiningSeekerCoverageChallenge(db); active();
   const checkpoint = await readMiningSeekerCheckpointInterval(db, { ...parsed.data, policyVersion: 1 }); active();
   const readers = providers.map(provider => provider.connect(combined));
   need(readers[0] && readers[1] && readers[0] !== readers[1], 'PROVIDER_CONFIGURATION');
   const coverage = await readAgreedMiningSeekerCoverageEvidence([readers[0], readers[1]], { nonceHex: coverageChallenge.nonce, signature: coverageSignature }); active();
   const agreed = await readAgreedMiningSeekerMintBirthEvidence([readers[0], readers[1]], inputFor(checkpoint)); active();
   return replayMiningSeekerQualification({ version: 1, ...parsed.data, checkpoint, coverageChallenge, coverageSignature,
    providers: providers.map((provider, i) => ({ id: provider.id, evidenceJson: agreed.proofs[i]!.evidenceJson, coverageEvidenceJson: coverage.proofs[i]!.evidenceJson })) }).evidence;
  };
  return await Promise.race([run(), new Promise<never>((_, reject) => {
   rejectAbort = () => reject(new MiningSeekerQualificationError('ABORTED')); combined.addEventListener('abort', rejectAbort, { once: true });
  })]);
 } catch (error) { if (error instanceof MiningSeekerQualificationError) throw error; active(); return fail('SOURCE_UNAVAILABLE'); }
 finally { if (rejectAbort) combined.removeEventListener('abort', rejectAbort); controller.abort(); }
}
