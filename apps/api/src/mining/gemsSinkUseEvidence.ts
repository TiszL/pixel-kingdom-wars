/** Historical paid effects from one copied Gems snapshot; no current job/base reads. */
import { createHash } from 'node:crypto';
import { HERO_KEYS } from '@shardkeep/shared';
import { BuilderJobSpeedupIntentSchema, BuilderJobSpeedupResultSchema, BuilderJobSpeedupProofSchema } from '@shardkeep/shared/builderJobSpeedup';
import { TrainingFinishIntentSchema, TrainingFinishResultSchema, TrainingFinishProofSchema } from '@shardkeep/shared/trainingFinish';
import { ResearchSpeedupIntentSchema, ResearchSpeedupProofSchema } from '@shardkeep/shared/researchSpeedup';
import { MinePurchaseIntentSchema, MinePurchaseProofSchema } from '@shardkeep/shared/minePurchase';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { HeroLevelSchema } from '../game/heroConsent';
import { HeroRecoveryReceiptSchema, HeroUpgradeReceiptSchema, heroLedgerKey } from '../game/heroReceipt';
import { builderJobSpeedupLedgerKey } from '../game/builderJobSpeedupReceipt';
import { trainingFinishLedgerKey } from '../game/trainingFinishReceipt';
import { researchSpeedupLedgerKey } from '../game/researchReceipt';
import { readGemsFlowEvidence, type GemsFlowEvidence, type GemsFlowFact } from './gemsFlowEvidence';
import { attributeGemsFlowEvidence,attributePostZeroGemsFlowEvidence,type PostZeroGemsFlowInput,type GemsFlowAttribution, type GemsAttributedLot } from './gemsFlowAttribution';
export class GemsSinkUseEvidenceError extends Error {
 readonly code = 'SOURCE_UNAVAILABLE'; constructor() { super('Gems sink-use source is inconsistent'); this.name = 'GemsSinkUseEvidenceError'; }
}
type Kind = 'builder-finish' | 'training-finish' | 'research-finish' | 'hero-upgrade' | 'hero-recovery' | 'additional-mine-placement';
type Reason = 'excluded-conversion' | 'refunded' | 'terminal-effect-unproven' | 'acquisition-only' | 'recruitment-command-unavailable' | 'unsupported-sink' | 'legacy-or-malformed-receipt';
export interface GemsSinkUseFact {
 eventId: string; transactionId: string; transactionType: string; kind: Kind; wallet: string; baseId: string | null;
 observedAt: string; effectiveObservedAt: string; ledgerCreatedAt: string; amount: string;
 effect: Record<string, unknown>; consumed: GemsAttributedLot[]; requiresDepositVerification: boolean;
}
export interface GemsSinkUseEvidence {
 version: 1; sourcePolicyVersion: 1; sinkUsePolicyVersion: 1; sourceDigest: string; wallet: string; day: string;
 verified: GemsSinkUseFact[]; unresolved: Array<{ eventId: string; transactionId: string; transactionType: string; observedAt: string; effectiveObservedAt: string; reason: Reason; amount: string; consumed: GemsAttributedLot[] }>;
 usefulChainCreditAuthorized: false; scoringAuthorized: false; allocationReady: false; publicationAuthorized: false;
}
export type PostZeroGemsSinkUseEvidence=Omit<GemsSinkUseEvidence,'version'|'sourcePolicyVersion'>&{version:2;sourcePolicyVersion:2;sourceKind:'committed-zero-inventory-fifo';openingId:string};
const common = { wallet: z.string(), currency: z.literal('GEMS'), baseId: z.uuid().optional() };
const positive = z.number().int().positive().safe();
const Builder = z.object({ ...common, jobId: z.uuid(), remSec: positive, builderJobSpeedup: z.object({ version: z.literal(1), request: BuilderJobSpeedupIntentSchema, result: BuilderJobSpeedupResultSchema }).strict() }).strict();
const Training = z.object({ ...common, rows: positive, remSec: positive, trainingFinish: z.object({ version: z.literal(1), request: TrainingFinishIntentSchema, result: TrainingFinishResultSchema }).strict() }).strict();
const Research = z.object({ ...common, troop: ResearchSpeedupIntentSchema.shape.troop, toLevel: ResearchSpeedupIntentSchema.shape.toLevel, remSec: positive, researchSpeedup: z.object({ version: z.literal(1), request: ResearchSpeedupIntentSchema }).strict() }).strict();
const Upgrade = z.object({ ...common, hero: z.enum(HERO_KEYS), from: HeroLevelSchema, to: HeroLevelSchema }).strict();
const Recovery = z.object({ ...common, hero: z.enum(HERO_KEYS), remainingSec: positive, recoveryUntil: z.iso.datetime() }).strict();
const Mine = z.object({ ...common, type: z.literal('mine'), tx: MinePurchaseIntentSchema.shape.tx, ty: MinePurchaseIntentSchema.shape.ty, mineIndex: positive, minePurchase: z.object({ version: z.literal(1), request: MinePurchaseIntentSchema }).strict() }).strict();
interface Source { transaction: { id: string; key: string; type: string; metadata: Record<string, unknown>; createdAt: string } }
interface Effect { kind: Kind; baseId: string | null; effect: Record<string, unknown>; identities: string[] }
/** Date normalization is only shared-proof display compatibility. Both cutoff
 * timestamps in the result retain the PostgreSQL microsecond source strings. */
function displayTime(value: string): string | null { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : null; }
function keySuffix(key: string, prefix: string): string | null { if (!key.startsWith(prefix)) return null; const suffix = key.slice(prefix.length); return suffix.length >= 8 && suffix.length <= 128 ? suffix : null; }
function effectOf(source: Source, wallet: string, amount: string): Effect | null {
 const t = source.transaction, metadata = t.metadata, acceptedAt = displayTime(t.createdAt); if (!acceptedAt || metadata['wallet'] !== wallet) return null;
 const proof = { version: 1, status: 'accepted', wallet, receiptId: t.id, acceptedAt, funding: { currency: 'GEMS', amount } };
 if (t.type === 'build.speedup') {
  const parsed = Builder.safeParse(metadata); if (!parsed.success) return null; const m = parsed.data, { request, result } = m.builderJobSpeedup;
  if (t.key !== builderJobSpeedupLedgerKey(wallet, request.idempotencyKey) || request.baseId !== (m.baseId ?? null) || m.jobId !== request.jobId || m.remSec !== Math.ceil((Date.parse(request.consent.finishesAt) - Date.parse(result.completedAt)) / 1000)) return null;
  const p = BuilderJobSpeedupProofSchema.safeParse({ ...proof, request, result }); if (!p.success || p.data.status !== 'accepted') return null;
  return { kind: 'builder-finish', baseId: request.baseId, effect: p.data.result, identities: [`builder:${request.jobId}`] };
 }
 if (t.type === 'train.speedup') {
  const parsed = Training.safeParse(metadata); if (!parsed.success) return null; const m = parsed.data, { request, result } = m.trainingFinish;
  if (t.key !== trainingFinishLedgerKey(wallet, request.idempotencyKey, request.baseId) || request.baseId !== (m.baseId ?? null) || m.rows !== result.paidRows.length || m.remSec !== Math.ceil((Math.max(...result.paidRows.map(r => Date.parse(r.finishesAt))) - Date.parse(result.completedAt)) / 1000)) return null;
  const p = TrainingFinishProofSchema.safeParse({ ...proof, request, result }); if (!p.success || p.data.status !== 'accepted') return null;
  return { kind: 'training-finish', baseId: request.baseId, effect: p.data.result, identities: result.paidRows.map(r => `training:${r.id}`) };
 }
 if (t.type === 'research.speedup') {
  const parsed = Research.safeParse(metadata); if (!parsed.success) return null; const m = parsed.data, request = m.researchSpeedup.request;
  if (t.key !== researchSpeedupLedgerKey(wallet, request.idempotencyKey, request.baseId) || request.baseId !== (m.baseId ?? null) || m.troop !== request.troop || m.toLevel !== request.toLevel) return null;
  const p = ResearchSpeedupProofSchema.safeParse({ ...proof, request, result: { troop: request.troop, fromLevel: request.currentLevel, toLevel: request.toLevel } }); if (!p.success || p.data.status !== 'accepted') return null;
  return { kind: 'research-finish', baseId: request.baseId, effect: { ...p.data.result, episodeId: request.episodeId, finishesAt: request.finishesAt }, identities: [`research:${request.baseId ?? wallet}:${request.troop}:${request.episodeId ?? `${request.currentLevel}:${request.finishesAt}`}`] };
 }
 if (t.type === 'hero.upgrade') {
  const parsed = Upgrade.safeParse(metadata); if (!parsed.success) return null; const m = parsed.data;
  const prefix = heroLedgerKey('upgrade', wallet, m.hero, '', m.baseId), key = keySuffix(t.key, prefix);
  if (!key || m.to !== m.from + 1 || !HeroUpgradeReceiptSchema.options[1].shape.result.safeParse({ fromLevel: m.from, toLevel: m.to }).success) return null;
  // The producer stored the actual effect, not its original consent ceiling.
  // Never manufacture a request/consent object from the amount already spent.
  return { kind: 'hero-upgrade', baseId: m.baseId ?? null, effect: { hero: m.hero, fromLevel: m.from, toLevel: m.to }, identities: [`hero-upgrade:${m.baseId ?? wallet}:${m.hero}:${m.from}:${m.to}`] };
 }
 if (t.type === 'hero.recovery.speedup') {
  const parsed = Recovery.safeParse(metadata); if (!parsed.success) return null; const m = parsed.data;
  const prefix = heroLedgerKey('recovery', wallet, m.hero, '', m.baseId), key = keySuffix(t.key, prefix);
  if (!key || !HeroRecoveryReceiptSchema.options[1].shape.result.safeParse({ recoveryUntil: m.recoveryUntil }).success) return null;
  return { kind: 'hero-recovery', baseId: m.baseId ?? null, effect: { hero: m.hero, recoveryUntil: m.recoveryUntil, cleared: true }, identities: [`hero-recovery:${m.baseId ?? wallet}:${m.hero}:${m.recoveryUntil}`] };
 }
 if (t.type === 'build.mine') {
  const parsed = Mine.safeParse(metadata); if (!parsed.success) return null; const m = parsed.data, request = m.minePurchase.request;
  if (t.key !== `build:${wallet}:${request.idempotencyKey}` || request.baseId !== (m.baseId ?? null) || request.type !== m.type || request.tx !== m.tx || request.ty !== m.ty || request.mineConsent.mineIndex !== m.mineIndex) return null;
  const p = MinePurchaseProofSchema.safeParse({ version: 1, wallet, request, receiptId: t.id, acceptedAt, funding: proof.funding }); if (!p.success) return null;
  // Atomic placement is proved; construction completion is not asserted.
  return { kind: 'additional-mine-placement', baseId: request.baseId, effect: { type: 'mine', tx: m.tx, ty: m.ty, mineIndex: m.mineIndex }, identities: [`mine-placement:${t.id}`] };
 }
 return null;
}
export function deriveGemsSinkUseEvidence(evidence: GemsFlowEvidence): GemsSinkUseEvidence {
 // One validated source snapshot supplies BOTH attribution and use joins.
 const attribution = attributeGemsFlowEvidence(evidence);
 // Attribution bounded this complete ordered snapshot before serialization.
 const sourceDigest = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
 return {version:1,sourcePolicyVersion:1,sinkUsePolicyVersion:1,sourceDigest,wallet:evidence.wallet,day:evidence.day,...deriveUses(evidence,attribution)};
}
export function derivePostZeroGemsSinkUseEvidence(evidence:PostZeroGemsFlowInput,sourceDigest:string):PostZeroGemsSinkUseEvidence{
 if(!/^[0-9a-f]{64}$/.test(sourceDigest))throw new GemsSinkUseEvidenceError();
 const attribution=attributePostZeroGemsFlowEvidence(evidence);
 return {version:2,sourcePolicyVersion:2,sourceKind:evidence.sourceKind,openingId:evidence.openingId,sinkUsePolicyVersion:1,sourceDigest,wallet:evidence.wallet,day:evidence.day,...deriveUses(evidence,attribution)};
}
function deriveUses(evidence:Pick<GemsFlowEvidence,'facts'|'wallet'>,attribution:Pick<GemsFlowAttribution,'debits'>){
 const byId = new Map(evidence.facts.map(f => [f.id, f]));
 const verified: GemsSinkUseFact[] = [], unresolved: GemsSinkUseEvidence['unresolved'] = [], identities = new Set<string>();
 for (const debit of attribution.debits) {
  const fact: GemsFlowFact | undefined = byId.get(debit.eventId); if (!fact || fact.transactionId !== debit.transactionId) throw new GemsSinkUseEvidenceError();
  // B3s just validated the source, copied account identities and balanced legs.
  const source = fact.source as Source; const type = source.transaction.type;
  let reason: Reason | undefined;
  if (debit.excludedGemsToShards) reason = 'excluded-conversion'; else if (debit.refundedByEventId) reason = 'refunded';
  else if (type === 'raid.buffs') reason = 'terminal-effect-unproven'; else if (type === 'item.buy') reason = 'acquisition-only';
  else if (type === 'hero.recruit') reason = 'recruitment-command-unavailable';
  else if (!['build.speedup', 'train.speedup', 'research.speedup', 'hero.upgrade', 'hero.recovery.speedup', 'build.mine'].includes(type)) reason = 'unsupported-sink';
  const effect = reason ? null : effectOf(source, evidence.wallet, debit.amount);
  if (!effect) unresolved.push({ eventId: fact.id, transactionId: debit.transactionId, transactionType: type, observedAt: fact.observedAt, effectiveObservedAt: fact.effectiveObservedAt, reason: reason ?? 'legacy-or-malformed-receipt', amount: debit.amount, consumed: debit.consumed });
  else {
   for (const identity of effect.identities) { if (identities.has(identity)) throw new GemsSinkUseEvidenceError(); identities.add(identity); }
   verified.push({ eventId: fact.id, transactionId: debit.transactionId, transactionType: type, kind: effect.kind, wallet: evidence.wallet, baseId: effect.baseId, observedAt: fact.observedAt, effectiveObservedAt: fact.effectiveObservedAt, ledgerCreatedAt: source.transaction.createdAt, amount: debit.amount, effect: effect.effect, consumed: debit.consumed, requiresDepositVerification: debit.consumed.some(l => l.requiresDepositVerification) });
  }
 }
 return {verified,unresolved,usefulChainCreditAuthorized:false as const,scoringAuthorized:false as const,allocationReady:false as const,publicationAuthorized:false as const};
}
export async function readGemsSinkUseEvidence(db: DbOrTx, input: unknown): Promise<GemsSinkUseEvidence> {
 return deriveGemsSinkUseEvidence(await readGemsFlowEvidence(db, input));
}
