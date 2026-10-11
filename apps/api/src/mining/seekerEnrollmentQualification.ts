/** D153.209: existing authentic SGTs qualify prospectively from their first
 * fully tracked day. Enrollment never invents mint birth or historical holding.
 * Private owned captures only; replay does not authenticate caller JSON. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY as P } from '@shardkeep/shared';
import { miningSeekerTokenAccount, readAgreedMiningSeekerHoldingEvidence, replayMiningSeekerHoldingEvidence,
 type MiningSeekerHoldingReader, type MiningSeekerHoldingInput } from '@shardkeep/chain/mining-seeker-holding';
import { readAgreedMiningSeekerEnrollmentEvidence, replayMiningSeekerEnrollmentEvidence,
 type MiningSeekerEnrollmentReader } from '@shardkeep/chain/mining-seeker-enrollment';
import { z } from 'zod';
import type { Db } from '../db/client';
import { readMiningSeekerEnrollmentInterval, validateMiningSeekerEnrollmentIntervalEvidence,
 type MiningSeekerEnrollmentIntervalEvidence } from './seekerMiningEnrollment';

// Resource bounds only. The enclosing publication imposes the same total limit
// on all participants, reservations and proofs together.
const MAX_BYTES = 4 * 1024 * 1024, MAX_NODES = 200_000, MAX_DEPTH = 64;
type Code = 'INVALID_INPUT' | 'SOURCE_UNAVAILABLE' | 'SOURCE_CONFLICT' | 'PROVIDER_CONFIGURATION' | 'TOO_LARGE' | 'ABORTED';
export class MiningSeekerEnrollmentQualificationError extends Error {
 constructor(readonly code: Code) { super(`Mining Seeker enrollment qualification refused: ${code}`); this.name = 'MiningSeekerEnrollmentQualificationError'; }
}
function fail(code: Code): never { throw new MiningSeekerEnrollmentQualificationError(code); }
function need(value: unknown, code: Code = 'SOURCE_CONFLICT'): asserts value { if (!value) fail(code); }
const key = z.string().min(32).max(44).refine(value => {
 try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
const providerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const signature = z.string().min(64).max(88).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
const request = z.object({ wallet: key, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const providerProof = z.object({ id: providerId, evidenceJson: z.string().min(1).max(MAX_BYTES), enrollmentEvidenceJson: z.string().min(1).max(MAX_BYTES) }).strict();
const envelope = request.extend({ version: z.literal(2), interval: z.unknown(), enrollmentSignature: signature,
 providers: z.tuple([providerProof, providerProof]) }).strict();
export type SeekerMiningEnrollmentReader = MiningSeekerHoldingReader & MiningSeekerEnrollmentReader;
export interface SeekerMiningEnrollmentWiring {
 readonly enrollmentId: string;
 readonly enrollmentSignature: string;
 readonly providers: readonly [
  { readonly id: string; readonly connect: (signal: AbortSignal) => SeekerMiningEnrollmentReader },
  { readonly id: string; readonly connect: (signal: AbortSignal) => SeekerMiningEnrollmentReader },
 ];
}
export interface MiningSeekerEnrollmentQualificationEvidence {
 readonly version: 2; readonly wallet: string; readonly day: string;
 readonly interval: MiningSeekerEnrollmentIntervalEvidence; readonly enrollmentSignature: string;
 readonly providers: readonly [{ readonly id: string; readonly evidenceJson: string; readonly enrollmentEvidenceJson: string },
  { readonly id: string; readonly evidenceJson: string; readonly enrollmentEvidenceJson: string }];
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
function inputFor(interval: MiningSeekerEnrollmentIntervalEvidence): MiningSeekerHoldingInput {
 const { seekerWallet, sgtMint } = interval.link;
 return { linkedWallet: seekerWallet, mint: sgtMint,
  tokenAccount: miningSeekerTokenAccount(seekerWallet, sgtMint),
  startAt: new Date(interval.startsAt), endAt: new Date(interval.endsAt) };
}
function providerIds(a: string, b: string): void { need(a.toLowerCase() !== b.toLowerCase(), 'PROVIDER_CONFIGURATION'); }

export function replayMiningSeekerEnrollmentQualification(value: unknown) {
 const parsed = envelope.safeParse(copy(value)); need(parsed.success); const owned = parsed.data;
 providerIds(owned.providers[0].id, owned.providers[1].id);
 const interval = validateMiningSeekerEnrollmentIntervalEvidence(owned.interval);
 need(interval.wallet === owned.wallet && interval.day === owned.day);
 const input = inputFor(interval), enrolled = interval.enrollment;
 const witnesses = owned.providers.map(provider => replayMiningSeekerEnrollmentEvidence(provider.enrollmentEvidenceJson,
  { nonceHex: enrolled.nonce, signature: owned.enrollmentSignature }));
 const [witness, otherWitness] = witnesses; need(witness && otherWitness);
 need(witness.signature === otherWitness.signature && witness.slot === otherWitness.slot && witness.blockTime === otherWitness.blockTime
  && witness.genesisHash === otherWitness.genesisHash && witness.messageSha256 === otherWitness.messageSha256);
 // The committed unpredictable nonce establishes causality. Conservatively
 // require both independent clocks before the first entire eligible UTC day.
 const start = BigInt(input.startAt.getTime()) * 1_000n;
 need(micros(enrolled.observedAt) < start && BigInt(witness.blockTime) * 1_000_000n < start);
 need(BigInt(witness.blockTime) * 1_000_000n >= micros(enrolled.observedAt));
 const proofs = owned.providers.map(provider => replayMiningSeekerHoldingEvidence(provider.evidenceJson, input));
 const [first, second] = proofs; need(first && second);
 need(BigInt(first.throughSlot) >= BigInt(witness.slot) && BigInt(second.throughSlot) >= BigInt(witness.slot));
 const firstWire = JSON.parse(first.evidenceJson) as { accounts: { owner: string; data: string }[] };
 const secondWire = JSON.parse(second.evidenceJson) as { accounts: { owner: string; data: string }[] };
 need(firstWire.accounts.every((account, i) => account.owner === secondWire.accounts[i]?.owner && account.data === secondWire.accounts[i]?.data)
  && JSON.stringify(first.generation) === JSON.stringify(second.generation));
 const evidence: MiningSeekerEnrollmentQualificationEvidence = freeze({ version: 2, wallet: owned.wallet, day: owned.day,
  interval, enrollmentSignature: owned.enrollmentSignature, providers: [owned.providers[0], owned.providers[1]] });
 return freeze({ wallet: owned.wallet, day: owned.day, seekerWallet: input.linkedWallet, sgtMint: input.mint,
  tokenAccount: input.tokenAccount, bonusBps: P.mining.seekerBonusBps, evidence });
}

export async function captureMiningSeekerEnrollmentQualification(db: Db, wiring: SeekerMiningEnrollmentWiring,
 value: { wallet: string; day: string }, signal?: AbortSignal): Promise<MiningSeekerEnrollmentQualificationEvidence> {
 const parsed = request.safeParse(value); need(parsed.success, 'INVALID_INPUT');
 need(Array.isArray(wiring?.providers) && wiring.providers.length === 2, 'PROVIDER_CONFIGURATION');
 need(z.uuid().safeParse(wiring.enrollmentId).success && signature.safeParse(wiring.enrollmentSignature).success, 'PROVIDER_CONFIGURATION');
 const enrollmentId = wiring.enrollmentId, enrollmentSignature = wiring.enrollmentSignature;
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
   const interval = await readMiningSeekerEnrollmentInterval(db, { ...parsed.data, enrollmentId }); active();
   const readers = providers.map(provider => provider.connect(combined));
   need(readers[0] && readers[1] && readers[0] !== readers[1], 'PROVIDER_CONFIGURATION');
   const witness = await readAgreedMiningSeekerEnrollmentEvidence([readers[0], readers[1]], { nonceHex: interval.enrollment.nonce, signature: enrollmentSignature }); active();
   const agreed = await readAgreedMiningSeekerHoldingEvidence([readers[0], readers[1]], inputFor(interval)); active();
   return replayMiningSeekerEnrollmentQualification({ version: 2, ...parsed.data, interval, enrollmentSignature,
    providers: providers.map((provider, i) => ({ id: provider.id, evidenceJson: agreed.proofs[i]!.evidenceJson, enrollmentEvidenceJson: witness.proofs[i]!.evidenceJson })) }).evidence;
  };
  return await Promise.race([run(), new Promise<never>((_, reject) => {
   rejectAbort = () => reject(new MiningSeekerEnrollmentQualificationError('ABORTED')); combined.addEventListener('abort', rejectAbort, { once: true });
  })]);
 } catch (error) { if (error instanceof MiningSeekerEnrollmentQualificationError) throw error; active(); return fail('SOURCE_UNAVAILABLE'); }
 finally { if (rejectAbort) combined.removeEventListener('abort', rejectAbort); controller.abort(); }
}
