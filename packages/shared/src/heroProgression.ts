/** Hero level/recovery consent and immutable funding evidence. Lazy subpath only. */
import { z } from 'zod';
import { HERO_KEYS, HERO_LEVELING } from './constants';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Key = z.string().min(8).max(128);
const Hero = z.enum(HERO_KEYS);
const Currency = z.enum(['KEEP', 'GEMS']);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Level = z.number().int().min(1).max(HERO_LEVELING.maxLevel);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)));
const amount = (v: string) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
const Amount = z.string().refine(amount, 'expected a positive int64 amount');
const identity = { hero: Hero, baseId: Uuid.nullable(), idempotencyKey: Key, expectedCurrency: Currency, maxCostKeep: Amount };

/** maxCostKeep retains the compatible wire name; expectedCurrency freezes the
 * actual single currency the player reviewed, independently of that name. */
export const HeroProgressionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upgrade'), ...identity, expectedLevel: Level.refine(v => v < HERO_LEVELING.maxLevel) }).strict(),
  z.object({ kind: z.literal('recovery'), ...identity, recoveryUntil: Timestamp }).strict(),
]);
export type HeroProgressionIntent = z.infer<typeof HeroProgressionIntentSchema>;
const requestIdentity = { hero: Hero, baseId: Uuid.optional(), idempotencyKey: Key, maxCostKeep: Amount };
const Unknown = z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key }).strict();
const accepted = { version: z.literal(1), status: z.literal('accepted'), wallet: Wallet, baseId: Uuid.nullable(),
  receiptId: Uuid, acceptedAt: Timestamp, funding: z.object({ currency: Currency, amount: Amount }).strict() };
export const HeroUpgradeProofSchema = z.discriminatedUnion('status', [Unknown, z.object({ ...accepted,
  request: z.object({ ...requestIdentity, expectedLevel: Level }).strict(),
  result: z.object({ fromLevel: Level, toLevel: Level }).strict(),
}).strict().refine(r => r.baseId === (r.request.baseId ?? null) && r.result.fromLevel === r.request.expectedLevel
  && r.result.toLevel === r.result.fromLevel + 1 && amount(r.funding.amount) && amount(r.request.maxCostKeep)
  && BigInt(r.funding.amount) <= BigInt(r.request.maxCostKeep), 'invalid original Hero level funding')]);
export const HeroRecoveryProofSchema = z.discriminatedUnion('status', [Unknown, z.object({ ...accepted,
  request: z.object({ ...requestIdentity, recoveryUntil: Timestamp }).strict(),
  result: z.object({ recoveryUntil: Timestamp }).strict(),
}).strict().refine(r => r.baseId === (r.request.baseId ?? null)
  && Date.parse(r.result.recoveryUntil) === Date.parse(r.request.recoveryUntil)
  && amount(r.funding.amount) && amount(r.request.maxCostKeep)
  && BigInt(r.funding.amount) <= BigInt(r.request.maxCostKeep), 'invalid original Hero recovery funding')]);
export type HeroProgressionProof = z.infer<typeof HeroUpgradeProofSchema> | z.infer<typeof HeroRecoveryProofSchema>;

export function heroProgressionPath(input: HeroProgressionIntent): string {
  const intent = HeroProgressionIntentSchema.parse(input);
  return `/heroes/${intent.hero}/${intent.kind === 'upgrade' ? 'upgrade' : 'recovery/speedup'}`;
}
export function heroProgressionBody(input: HeroProgressionIntent): Record<string, unknown> {
  const intent = HeroProgressionIntentSchema.parse(input);
  return { idempotencyKey: intent.idempotencyKey, ...(intent.baseId === null ? {} : { baseId: intent.baseId }),
    consent: intent.kind === 'upgrade' ? { expectedLevel: intent.expectedLevel, maxCostKeep: intent.maxCostKeep }
      : { recoveryUntil: intent.recoveryUntil, maxCostKeep: intent.maxCostKeep } };
}
export function heroProgressionReceiptPath(input: HeroProgressionIntent): string {
  const intent = HeroProgressionIntentSchema.parse(input);
  const query = new URLSearchParams({ idempotencyKey: intent.idempotencyKey, maxCostKeep: intent.maxCostKeep,
    ...(intent.baseId === null ? {} : { baseId: intent.baseId }),
    ...(intent.kind === 'upgrade' ? { expectedLevel: String(intent.expectedLevel) } : { recoveryUntil: intent.recoveryUntil }) });
  return `${heroProgressionPath(intent)}/receipt?${query}`;
}
/** A valid receipt for another command/currency is never this command's proof.
 * POST acknowledgements such as spentKeep:0 on replay cannot replace this GET. */
export function matchHeroProgressionProof(raw: unknown, wallet: string, input: HeroProgressionIntent): HeroProgressionProof {
  Wallet.parse(wallet);
  const intent = HeroProgressionIntentSchema.parse(input);
  const proof = intent.kind === 'upgrade' ? HeroUpgradeProofSchema.parse(raw) : HeroRecoveryProofSchema.parse(raw);
  if (proof.status === 'unknown') {
    if (proof.idempotencyKey !== intent.idempotencyKey) throw new Error('Hero recovery key differs from the original command.');
    return proof;
  }
  const request = proof.request;
  if (proof.wallet !== wallet || proof.baseId !== intent.baseId || request.hero !== intent.hero
    || request.idempotencyKey !== intent.idempotencyKey || request.maxCostKeep !== intent.maxCostKeep
    || proof.funding.currency !== intent.expectedCurrency
    || (intent.kind === 'upgrade' ? !('expectedLevel' in request) || request.expectedLevel !== intent.expectedLevel
      : !('recoveryUntil' in request) || request.recoveryUntil !== intent.recoveryUntil)) {
    throw new Error('Hero receipt differs from the original command or reviewed currency.');
  }
  return proof;
}
