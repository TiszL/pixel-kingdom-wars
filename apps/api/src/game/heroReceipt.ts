import { HERO_KEYS, type HeroKey } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { accounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { HeroLevelSchema, HeroRecoveryConsentSchema, HeroUpgradeConsentSchema } from './heroConsent';

const Identity = z.object({ idempotencyKey: z.string().min(8).max(128), baseId: z.uuid().optional() });
const Hero = z.enum(HERO_KEYS);
const UpgradeRequest = Identity.extend({ hero: Hero, ...HeroUpgradeConsentSchema.shape }).strict();
const RecoveryRequest = Identity.extend({ hero: Hero, ...HeroRecoveryConsentSchema.shape }).strict();
export const HeroUpgradeReceiptQuerySchema = Identity.extend({
  ...HeroUpgradeConsentSchema.shape, expectedLevel: z.coerce.number().pipe(HeroLevelSchema),
}).strict();
export const HeroRecoveryReceiptQuerySchema = Identity.extend(HeroRecoveryConsentSchema.shape).strict();
const Unknown = z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Identity.shape.idempotencyKey });
const Accepted = z.object({
  version: z.literal(1), status: z.literal('accepted'), wallet: z.string(), baseId: z.uuid().nullable(),
  receiptId: z.uuid(), acceptedAt: z.iso.datetime(),
  funding: z.object({ currency: z.enum(['KEEP', 'GEMS']), amount: z.string().regex(/^[1-9][0-9]*$/) }),
});
export const HeroUpgradeReceiptSchema = z.discriminatedUnion('status', [Unknown, Accepted.extend({
  request: UpgradeRequest, result: z.object({ fromLevel: HeroLevelSchema, toLevel: HeroLevelSchema }),
})]);
export const HeroRecoveryReceiptSchema = z.discriminatedUnion('status', [Unknown, Accepted.extend({
  request: RecoveryRequest, result: z.object({ recoveryUntil: z.iso.datetime() }),
})]);
// D-152: a Gems debit carries `currency: 'GEMS'` and no `recycled`; the legacy
// KEEP leg carries both. Exactly one shape is accepted per posting (below).
const Metadata = z.object({
  wallet: z.string(), recycled: z.literal(true).optional(), currency: z.enum(['KEEP', 'GEMS']).optional(),
  hero: Hero, baseId: z.uuid().optional(),
});
const UpgradeMetadata = Metadata.extend({ from: HeroLevelSchema, to: HeroLevelSchema }).strict();
const RecoveryMetadata = Metadata.extend({
  remainingSec: z.number().int().positive(), recoveryUntil: z.iso.datetime().optional(),
}).strict();
export function heroLedgerKey(kind: 'upgrade' | 'recovery', wallet: string, hero: HeroKey, key: string, baseId?: string): string {
  return `${kind === 'upgrade' ? 'heroup' : 'herorecover'}:${wallet}:${baseId ? `${baseId.toLowerCase()}:` : ''}${hero}:${key}`;
}

/** Which single currency a two-entry sink posting charged (E2-GEMS-CONTRACT §3):
 * the legacy KEEP leg (`player_keep → emission_pool`, `recycled: true`) or Gems
 * (`player_gems → gems_sink`, `currency: 'GEMS'`). Anything else is not a sink. */
export function spendCurrencyOf(
  debit: { kind: string; currency: string }, credit: { kind: string; currency: string },
  metadata: { recycled?: true | undefined; currency?: 'KEEP' | 'GEMS' | undefined },
): 'KEEP' | 'GEMS' | null {
  if (debit.kind === 'player_keep' && debit.currency === 'KEEP' && credit.kind === 'emission_pool'
    && credit.currency === 'KEEP' && metadata.recycled === true && metadata.currency !== 'GEMS') return 'KEEP';
  if (debit.kind === 'player_gems' && debit.currency === 'GEMS' && credit.kind === 'gems_sink'
    && credit.currency === 'GEMS' && metadata.currency === 'GEMS' && metadata.recycled === undefined) return 'GEMS';
  return null;
}

/** Immutable evidence only: no current deed/roster, lazy completion, or recreated
 * price. A key alone is not proof; its exact wallet debit must balance the sink. */
async function paidEvidence(db: DbOrTx, wallet: string, hero: HeroKey, key: string, baseId: string | undefined, kind: 'upgrade' | 'recovery') {
  const [txn] = await db.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, heroLedgerKey(kind, wallet, hero, key, baseId)));
  if (!txn || txn.type !== (kind === 'upgrade' ? 'hero.upgrade' : 'hero.recovery.speedup')) return null;
  const parsed = (kind === 'upgrade' ? UpgradeMetadata : RecoveryMetadata).safeParse(txn.metadata);
  if (!parsed.success) return null;
  const metadata = parsed.data;
  if (metadata.wallet !== wallet || metadata.hero !== hero
    || (metadata.baseId?.toLowerCase() ?? null) !== (baseId?.toLowerCase() ?? null)) return null;
  const entries = await db.select({ delta: ledgerEntries.delta, account: accounts }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  if (entries.length !== 2) return null;
  const debit = entries.find((entry) => entry.delta < 0n);
  const credit = entries.find((entry) => entry.delta > 0n);
  if (!debit || !credit || debit.delta + credit.delta !== 0n) return null;
  const currency = spendCurrencyOf(debit.account, credit.account, metadata);
  if (!currency || debit.account.ownerWallet !== wallet || debit.account.baseId !== null
    || credit.account.ownerWallet !== null || credit.account.baseId !== null) return null;
  return { txn, metadata, cost: -debit.delta, currency };
}

export async function heroUpgradeEvidence(db: DbOrTx, wallet: string, hero: HeroKey, key: string, baseId?: string) {
  const evidence = await paidEvidence(db, wallet, hero, key, baseId, 'upgrade');
  if (!evidence || !('from' in evidence.metadata) || evidence.metadata.to !== evidence.metadata.from + 1) return null;
  return { ...evidence, from: evidence.metadata.from, to: evidence.metadata.to };
}
export async function getHeroUpgradeReceipt(db: DbOrTx, wallet: string, input: z.infer<typeof UpgradeRequest>) {
  const request = UpgradeRequest.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  const evidence = await heroUpgradeEvidence(db, wallet, request.hero, request.idempotencyKey, request.baseId);
  if (!evidence || evidence.from !== request.expectedLevel || evidence.cost > BigInt(request.maxCostKeep)) return unknown;
  return HeroUpgradeReceiptSchema.parse({
    version: 1, status: 'accepted', request, wallet, baseId: evidence.metadata.baseId ?? null,
    receiptId: evidence.txn.id, acceptedAt: evidence.txn.createdAt.toISOString(),
    funding: { currency: evidence.currency, amount: evidence.cost.toString() },
    result: { fromLevel: evidence.from, toLevel: evidence.to },
  });
}
export async function heroRecoveryEvidence(db: DbOrTx, wallet: string, hero: HeroKey, key: string, baseId?: string) {
  return paidEvidence(db, wallet, hero, key, baseId, 'recovery');
}
export async function getHeroRecoveryReceipt(db: DbOrTx, wallet: string, input: z.infer<typeof RecoveryRequest>) {
  const request = RecoveryRequest.parse(input);
  const unknown = { version: 1, status: 'unknown', idempotencyKey: request.idempotencyKey } as const;
  const evidence = await paidEvidence(db, wallet, request.hero, request.idempotencyKey, request.baseId, 'recovery');
  // Older writers saved only remainingSec: neither natural expiry nor a new
  // injury can reconstruct the episode that an uncertain request consented to.
  if (!evidence || !('recoveryUntil' in evidence.metadata) || !evidence.metadata.recoveryUntil
    || Date.parse(evidence.metadata.recoveryUntil) !== Date.parse(request.recoveryUntil)
    || evidence.cost > BigInt(request.maxCostKeep)) return unknown;
  return HeroRecoveryReceiptSchema.parse({
    version: 1, status: 'accepted', request, wallet, baseId: evidence.metadata.baseId ?? null,
    receiptId: evidence.txn.id, acceptedAt: evidence.txn.createdAt.toISOString(),
    funding: { currency: evidence.currency, amount: evidence.cost.toString() },
    result: { recoveryUntil: evidence.metadata.recoveryUntil },
  });
}
