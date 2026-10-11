import { ForgeClaimReceiptSchema, ForgeClaimRequestSchema, type ForgeClaimReceipt, type ForgeClaimRequest } from '@shardkeep/shared/forgeClaims';
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { forgeClaimCommands, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { claimForgeDaysAfterSettlement, expireDueForgeAllocations, settleDueForgeDays, type ForgeStableBaseContext } from './forge';

function serialize(row: typeof forgeClaimCommands.$inferSelect): ForgeClaimReceipt {
  return ForgeClaimReceiptSchema.parse({ version: 1, actor: row.actorWallet, idempotencyKey: row.requestKey,
    baseId: row.baseId, day: row.day, result: row.result, createdAt: row.createdAt.toISOString() });
}
/** No settlement, expiry, RPC or mutation. A missing key is not proof of no effect. */
export async function getForgeClaimCommand(db: DbOrTx, wallet: string, key: string) {
  const [row] = await db.select().from(forgeClaimCommands)
    .where(and(eq(forgeClaimCommands.actorWallet, wallet), eq(forgeClaimCommands.requestKey, key)));
  return { version: 1 as const, wallet, idempotencyKey: key, enabled: process.env['FORGE_ENABLED'] !== 'false', receipt: row ? serialize(row) : null };
}
function match(prior: ForgeClaimReceipt, request: ForgeClaimRequest): ForgeClaimReceipt {
  if (prior.baseId !== request.baseId || prior.day !== request.day) throw new HttpError(409, 'this key belongs to different Forge claim consent', 'FORGE_CLAIM_MISMATCH');
  return prior;
}
export async function executeForgeClaimCommand(db: Db, wallet: string, input: ForgeClaimRequest,
  now = new Date(), context?: ForgeStableBaseContext): Promise<ForgeClaimReceipt> {
  const request = ForgeClaimRequestSchema.parse(input);
  const prior = (await getForgeClaimCommand(db, wallet, request.idempotencyKey)).receipt;
  if (prior) return match(prior, request);
  if (process.env['FORGE_ENABLED'] === 'false') throw new HttpError(503, 'Forge claims are temporarily unavailable', 'FORGE_DISABLED');
  if (request.baseId ? context?.baseId !== request.baseId : context !== undefined) {
    throw new HttpError(409, 'review the original Forge destination again', 'FORGE_CLAIM_CONTEXT_MISMATCH');
  }
  // Same lazy preparation as the existing claim route, before wallet/base locks.
  await settleDueForgeDays(db, now); await expireDueForgeAllocations(db, now);
  return db.transaction(async tx => {
    // Serialize identical keys before any payout; NO KEY UPDATE permits the
    // receipt's own player FK without introducing a target-player lock.
    const [actor] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('no key update');
    if (!actor) throw new HttpError(401, 'player session is unavailable');
    const existing = (await getForgeClaimCommand(tx, wallet, request.idempotencyKey)).receipt;
    if (existing) return match(existing, request);
    const result = await claimForgeDaysAfterSettlement(tx, wallet, request.day ?? undefined, now, request.baseId ?? undefined, context);
    const [saved] = await tx.insert(forgeClaimCommands).values({ actorWallet: wallet, requestKey: request.idempotencyKey,
      baseId: request.baseId, day: request.day, result: { claimed: result.claimed, totalKeep: result.totalKeep, remaining: result.remaining },
    }).returning();
    // Malformed evidence or storage failure rolls back the same claim/ledger TX.
    return serialize(saved!);
  });
}
