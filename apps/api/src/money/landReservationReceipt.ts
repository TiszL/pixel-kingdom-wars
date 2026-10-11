/** K-night-A7: what one saved land-reservation request (POST /deposits {kind: entry|deed, idempotencyKey, landAddress})
 * did, by its key. A reservation moves no money (the payment is the separate signed transfer to the row's reference),
 * but a client may forget its saved request only on a definitive answer, so this route never guesses: `accepted` names
 * the row THIS key reserved, `absent` proves no row could be this key's, and everything else is `unknown`. */
import { FANTASY_WORLD_ID } from '@shardkeep/shared/fantasyWorld';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { deposits, players } from '../db/schema';

const Key = z.string().min(8).max(128);
const Kind = z.enum(['entry', 'deed']);
const Lookup = z.object({ kind: Kind, idempotencyKey: Key, tileId: z.number().int().nonnegative().optional() }).strict();
export type LandReservationLookup = z.infer<typeof Lookup>;
/** Query form of the lookup: the saved body's purchase kind and key, plus the tile it named, if any. */
export const LandReservationReceiptQuerySchema = z.object({
  kind: Kind, idempotencyKey: Key,
  tileId: z.string().regex(/^(0|[1-9][0-9]{0,8})$/).transform(Number).optional(),
}).strict();

const Uuid = z.uuid();
const LandAddressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fantasy'), worldId: z.literal(FANTASY_WORLD_ID), tileId: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('legacy-earth'), earthCell: z.number().int().nonnegative() }).strict(),
]);
export const LandReservationReceiptSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key }).strict(),
  z.object({ version: z.literal(1), status: z.literal('absent'), idempotencyKey: Key, absentAsOf: z.iso.datetime() }).strict(),
  z.object({
    version: z.literal(1), status: z.literal('accepted'), idempotencyKey: Key, kind: Kind,
    depositId: Uuid, baseId: Uuid, reservedAt: z.iso.datetime(), landAddress: LandAddressSchema,
  }).strict(),
]);
export type LandReservationReceipt = z.infer<typeof LandReservationReceiptSchema>;

/** The frozen address of a reserved row, from the payload createLandPurchaseIntent wrote with the key. */
function frozenAddress(payload: Record<string, unknown>) {
  const fantasy = LandAddressSchema.safeParse(payload['landAddress']);
  if (fantasy.success && fantasy.data.kind === 'fantasy') return fantasy.data;
  const cell = z.number().int().nonnegative().safeParse(payload['earthCell']);
  return payload['landAddress'] === undefined && cell.success ? { kind: 'legacy-earth' as const, earthCell: cell.data } : null;
}

/** GET /deposits/land/receipt.
 * - `accepted`: exactly one of this wallet's entry/deed rows records this key (createLandPurchaseIntent records it
 *   only on the row the request itself reserved), of the same kind and, when the lookup names a tile, that tile.
 *   Historical only: the client re-reads GET /deposits/:id for today's status and payment window.
 * - `absent`: no entry/deed row of this wallet records the key, and every row of the looked-up kind records some key,
 *   so none can be this request's. A key that was answered with an already-pending reservation is `absent` too: it
 *   reserved nothing, and that reservation stays readable through the wallet's own deposits.
 * - `unknown`: a mismatching row holds the key, or a row of this kind carries no key (written before keys were
 *   recorded, or by a request without one), which this key may have created.
 * Concurrency as readConstructionReceipt: the reservation writer takes this wallet's players row FOR UPDATE and writes
 * the keyed row in that transaction; FOR SHARE here waits for it. `absentAsOf` is stamped after the lock, before the
 * reads, so a client applies its minimum age to a request still in transit. */
export async function readLandReservationReceipt(db: Db, wallet: string, input: LandReservationLookup): Promise<LandReservationReceipt> {
  const lookup = Lookup.parse(input);
  return db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('share');
    const absentAsOf = new Date().toISOString();
    return getLandReservationReceipt(tx, wallet, lookup, absentAsOf);
  }, { isolationLevel: 'read committed' });
}

async function getLandReservationReceipt(tx: DbOrTx, wallet: string, lookup: LandReservationLookup, absentAsOf: string) {
  const unknown = { version: 1, status: 'unknown', idempotencyKey: lookup.idempotencyKey } as const;
  const claimed = await tx.select().from(deposits).where(and(
    eq(deposits.playerWallet, wallet), inArray(deposits.kind, ['entry', 'deed']),
    sql`${deposits.payload}->>'idempotencyKey' = ${lookup.idempotencyKey}`,
  ));
  if (claimed.length > 1) return unknown;
  const [row] = claimed;
  if (row) {
    const payload = row.payload as Record<string, unknown> | null;
    const baseId = Uuid.safeParse(payload?.['baseId']);
    const address = payload ? frozenAddress(payload) : null;
    if (row.kind !== lookup.kind || !baseId.success || !address
      || (lookup.tileId !== undefined && (address.kind !== 'fantasy' || address.tileId !== lookup.tileId))) return unknown;
    return LandReservationReceiptSchema.parse({ version: 1, status: 'accepted', idempotencyKey: lookup.idempotencyKey,
      kind: row.kind, depositId: row.id, baseId: baseId.data, reservedAt: row.createdAt.toISOString(), landAddress: address });
  }
  const [keyless] = await tx.select({ id: deposits.id }).from(deposits).where(and(
    eq(deposits.playerWallet, wallet), eq(deposits.kind, lookup.kind),
    or(isNull(deposits.payload), sql`${deposits.payload}->>'idempotencyKey' is null`),
  )).limit(1);
  if (keyless) return unknown;
  return LandReservationReceiptSchema.parse({ version: 1, status: 'absent', idempotencyKey: lookup.idempotencyKey, absentAsOf });
}
