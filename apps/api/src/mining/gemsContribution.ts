/** A bounded daily Gems contribution from matched, verified source views.
 * Read-only evaluation never writes an award, consumes ingots or publishes. */
import { PHASE_E_GEMS_MINING_CREDIT as POLICY } from '@shardkeep/shared';
import type { Db } from '../db/client';
import { readGemsSinkUseEvidence, type GemsSinkUseEvidence, type PostZeroGemsSinkUseEvidence } from './gemsSinkUseEvidence';
import { createGemsFinalizedOriginReader, type GemsFinalizedOriginWiring, type FinalizedGemsOrigins, type PostZeroFinalizedGemsOrigins } from './gemsFinalizedOrigins';
export class GemsContributionError extends Error {
 constructor(readonly code: 'SOURCE_MISMATCH' | 'USE_UNAVAILABLE') { super(`Gems contribution refused: ${code}`); this.name = 'GemsContributionError'; }
}
function need(value: unknown): asserts value { if (!value) throw new GemsContributionError('SOURCE_MISMATCH'); }
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const amount = (s: string): bigint => { need(typeof s === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(s)); return BigInt(s); };
/** Internal source composition, not a request-input verifier. Public callers
 * use the factory, whose two readers obtain the facts independently from DB/RPC. */
export function composeGemsContribution(use: GemsSinkUseEvidence, origins: FinalizedGemsOrigins) {
 need(use.version === 1 && origins.version === 1 && use.sourcePolicyVersion === 1 && origins.sourcePolicyVersion === 1
  && use.sinkUsePolicyVersion === 1 && use.wallet === origins.wallet && use.day === origins.day
  && /^[0-9a-f]{64}$/.test(use.sourceDigest) && use.sourceDigest === origins.sourceDigest
  && origins.attribution.wallet === use.wallet && origins.attribution.day === use.day);
 return compose(use,origins);
}
export function composePostZeroGemsContribution(use:PostZeroGemsSinkUseEvidence,origins:PostZeroFinalizedGemsOrigins) {
 need(use.version===2&&origins.version===2&&use.sourcePolicyVersion===2&&origins.sourcePolicyVersion===2&&use.sourceKind==='committed-zero-inventory-fifo'&&origins.sourceKind===use.sourceKind&&use.openingId===origins.openingId&&origins.attribution.openingId===use.openingId&&use.sinkUsePolicyVersion===1&&use.wallet===origins.wallet&&use.day===origins.day&&/^[0-9a-f]{64}$/.test(use.sourceDigest)&&use.sourceDigest===origins.sourceDigest&&origins.attribution.wallet===use.wallet&&origins.attribution.day===use.day);
 return {sourceKind:use.sourceKind,openingId:use.openingId,...compose(use,origins)};
}
function compose(use:GemsSinkUseEvidence|PostZeroGemsSinkUseEvidence,origins:FinalizedGemsOrigins|PostZeroFinalizedGemsOrigins) {
 const start = `${use.day}T00:00:00.000000Z`, ms = Date.parse(start);
 need(Number.isFinite(ms) && new Date(ms).toISOString().slice(0,10) === use.day);
 const end = new Date(ms + 86400000).toISOString().replace('.000Z', '.000000Z');
 const current = (at: string) => { need(timestamp.test(at)); return at >= start && at < end; };
 const debits = new Map(origins.attribution.debits.map(d => [d.eventId, d]));
 need(debits.size === origins.attribution.debits.length);
 const seen = new Set<string>(), eligible: { eventId: string; transactionId: string; kind: string; convertedGems: string }[] = [];
 let converted = 0n, unresolvedConverted = 0n;
 const joined = (row: { eventId: string; transactionId: string; amount: string; effectiveObservedAt: string; consumed: typeof origins.attribution.currentLots }) => {
  need(!seen.has(row.eventId)); seen.add(row.eventId);
  const debit = debits.get(row.eventId);
  need(debit && debit.transactionId === row.transactionId && debit.amount === row.amount && debit.effectiveObservedAt === row.effectiveObservedAt);
  need(row.consumed.length === debit.consumed.length);
  for (const [i, original] of row.consumed.entries()) {
   const verified = debit.consumed[i]!;
   // The exact finalized-origin reader may only clear deposit verification.
   const { requiresDepositVerification: a, ...sourceLot } = original;
   const { requiresDepositVerification: b, ...verifiedLot } = verified;
   need(JSON.stringify(sourceLot) === JSON.stringify(verifiedLot) && (!b || a));
  }
  let n = 0n;
  for (const lot of debit.consumed) {
   need(!lot.requiresDepositVerification);
   if (lot.originClass === 'custodial-conversion' || lot.originClass === 'wallet-conversion-ledger') n += amount(lot.amount);
   else need(lot.originClass === 'grant');
  }
  need(n <= amount(row.amount)); return { debit, n };
 };
 for (const row of use.verified) {
  const { debit, n } = joined(row); need(!debit.excludedGemsToShards && debit.refundedByEventId === null && row.wallet === use.wallet);
  if (current(row.effectiveObservedAt) && n > 0n) { converted += n; eligible.push({ eventId: row.eventId, transactionId: row.transactionId, kind: row.kind, convertedGems: n.toString() }); }
 }
 for (const row of use.unresolved) {
  const { debit, n } = joined(row);
  if (row.reason === 'excluded-conversion') need(debit.excludedGemsToShards);
  else if (row.reason === 'refunded') need(debit.refundedByEventId !== null);
  else if (current(row.effectiveObservedAt)) unresolvedConverted += n;
 }
 need(seen.size === debits.size);
 const disabled = Number(POLICY.usefulComponentBps) === 0;
 // Unproven positive use cannot become a false zero. Once the bounded daily
 // maximum is already proved, extra unresolved use cannot increase that award.
 if (!disabled && converted < BigInt(POLICY.minConvertedGemsSpent) && unresolvedConverted > 0n) throw new GemsContributionError('USE_UNAVAILABLE');
 const credits = !disabled && converted >= BigInt(POLICY.minConvertedGemsSpent) ? POLICY.maxCreditsPerWalletDay : 0;
 return { wallet: use.wallet, day: use.day, policyVersion: POLICY.version, sourceDigest: use.sourceDigest,
  chainIdentity: origins.chainIdentity, convertedGemsSpent: converted.toString(), unresolvedConvertedGems: unresolvedConverted.toString(),
  eligibleSpends: eligible, credits, usefulGemsComponentBps: credits ? POLICY.usefulComponentBps : 0,
  reason: disabled ? 'disabled' as const : credits ? 'qualified' as const : 'below_threshold' as const,
  allocationReady: false as const, publicationAuthorized: false as const };
}
export function createGemsContributionReader(db: Db, wiring: GemsFinalizedOriginWiring) {
 const readOrigins = createGemsFinalizedOriginReader(db, wiring);
 return async (input: unknown) => {
  const use = await readGemsSinkUseEvidence(db, input);
  const origins = await readOrigins(input);
  return composeGemsContribution(use, origins);
 };
}
