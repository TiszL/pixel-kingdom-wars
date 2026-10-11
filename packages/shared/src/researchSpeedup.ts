/** Original research FINISH consent and ledger proof. Lazy subpath only. */
import { z } from 'zod';
import { TROOP_LEVELING } from './constants';
import { TROOP_TYPES } from './types';
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Key = z.string().min(8).max(128);
const Currency = z.enum(['KEEP', 'GEMS']);
const Timestamp = z.iso.datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
const Level = z.number().int().min(1).max(TROOP_LEVELING.maxLevel);
const validAmount = (v: string) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
const Amount = z.string().refine(validAmount, 'expected a positive int64 amount');
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const ResearchSpeedupIntentSchema = z.object({
  troop: z.enum(TROOP_TYPES), baseId: Uuid.nullable(), idempotencyKey: Key, expectedCurrency: Currency,
  currentLevel: Level, toLevel: Level, finishesAt: Timestamp, episodeId: Uuid.nullable(), maxCostKeep: Amount,
}).strict().refine(v => v.toLevel === v.currentLevel + 1, 'research must advance exactly one level');
export type ResearchSpeedupIntent = z.infer<typeof ResearchSpeedupIntentSchema>;
export const ResearchSpeedupProofSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key }).strict(),
  z.object({ version: z.literal(1), status: z.literal('accepted'), wallet: Wallet,
    request: ResearchSpeedupIntentSchema, receiptId: Uuid, acceptedAt: Timestamp,
    funding: z.object({ currency: Currency, amount: Amount }).strict(),
    result: z.object({ troop: z.enum(TROOP_TYPES), fromLevel: Level, toLevel: Level }).strict(),
  }).strict().refine(v => v.funding.currency === v.request.expectedCurrency
    && validAmount(v.funding.amount) && validAmount(v.request.maxCostKeep)
    && BigInt(v.funding.amount) <= BigInt(v.request.maxCostKeep)
    && v.result.troop === v.request.troop && v.result.fromLevel === v.request.currentLevel
    && v.result.toLevel === v.request.toLevel, 'invalid original research funding'),
]);
export type ResearchSpeedupProof = z.infer<typeof ResearchSpeedupProofSchema>;
export function researchSpeedupBody(raw: ResearchSpeedupIntent) {
  const { troop, baseId, idempotencyKey, expectedCurrency: _currency, ...consent } = ResearchSpeedupIntentSchema.parse(raw);
  return { troop, ...(baseId === null ? {} : { baseId }), idempotencyKey, consent };
}
export function researchSpeedupReceiptPath(raw: ResearchSpeedupIntent): string {
  const intent = ResearchSpeedupIntentSchema.parse(raw);
  const query = new URLSearchParams(Object.entries(intent).filter(([k, v]) => k !== 'baseId' || v !== null)
    .map(([k, v]): [string, string] => [k, v === null ? 'null' : String(v)]));
  return `/army/research/speedup/receipt?${query}`;
}
export function sameResearchSpeedupIntent(a: ResearchSpeedupIntent, b: ResearchSpeedupIntent): boolean {
  return (Object.keys(a) as Array<keyof ResearchSpeedupIntent>).every(k => a[k] === b[k]);
}
export function matchResearchSpeedupProof(raw: unknown, wallet: string, input: ResearchSpeedupIntent): ResearchSpeedupProof {
  Wallet.parse(wallet);
  const intent = ResearchSpeedupIntentSchema.parse(input); const proof = ResearchSpeedupProofSchema.parse(raw);
  if (proof.status === 'unknown') {
    if (proof.idempotencyKey !== intent.idempotencyKey) throw new Error('Research receipt key differs.');
  } else if (proof.wallet !== wallet || !sameResearchSpeedupIntent(intent, proof.request)) {
    throw new Error('Research receipt differs from the original command.');
  }
  return proof;
}
