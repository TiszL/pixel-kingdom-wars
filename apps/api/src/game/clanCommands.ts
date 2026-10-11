import {
  ClanCommandReceiptSchema, type ClanCommandReceipt, type ClanKickRequest, type ClanLeaveRequest,
} from '@shardkeep/shared/clanCommands';
import { and, eq } from 'drizzle-orm';
import { multiBaseEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { clanCommandReceipts, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { ClanCommandRefused, kickMemberInTransaction, leaveClanInTransaction } from './clans';
import type { StableBaseMutationContext } from './stableBasePrerequisites';

function serialize(row: typeof clanCommandReceipts.$inferSelect): ClanCommandReceipt {
  return ClanCommandReceiptSchema.parse({
    version: 1, actor: row.actorWallet, idempotencyKey: row.requestKey,
    kind: row.kind, clanId: row.clanId, baseId: row.baseId, target: row.targetWallet,
    state: row.state, payoutShards: row.payoutShards.toString(), ledgerTransactionId: row.ledgerTransactionId,
    refusalCode: row.refusalCode, createdAt: row.createdAt.toISOString(),
  });
}

/** Read-only even after dissolution, a deed transfer or a membership change.
 * A missing receipt never proves a request could not still be in flight. */
export async function getClanCommand(db: DbOrTx, wallet: string, key: string) {
  const [row] = await db.select().from(clanCommandReceipts)
    .where(and(eq(clanCommandReceipts.actorWallet, wallet), eq(clanCommandReceipts.requestKey, key)));
  return { version: 1 as const, wallet, idempotencyKey: key, receipt: row ? serialize(row) : null };
}

type Command = { kind: 'leave'; request: ClanLeaveRequest; baseContext?: StableBaseMutationContext | undefined }
  | { kind: 'kick'; request: ClanKickRequest };

export async function executeClanCommand(db: Db, wallet: string, command: Command): Promise<ClanCommandReceipt> {
  const request = command.request;
  const baseId = command.kind === 'leave' ? command.request.baseId : null;
  const target = command.kind === 'kick' ? command.request.wallet : null;
  return db.transaction(async (tx) => {
    // Actor -> payout base -> clan is the existing leave lock order. A kick
    // must also acquire the actor first, or its receipt FK can deadlock with a
    // concurrent leave holding that player while waiting for the same clan.
    // No target-player lock: different actors never acquire each other's rows.
    const [actor] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('no key update');
    if (!actor) throw new HttpError(401, 'player session is unavailable');
    const prior = (await getClanCommand(tx, wallet, request.idempotencyKey)).receipt;
    if (prior) {
      if (prior.kind !== command.kind || prior.clanId !== request.clanId || prior.baseId !== baseId || prior.target !== target) {
        throw new HttpError(409, 'this key belongs to different clan consent', 'CLAN_COMMAND_MISMATCH');
      }
      return prior;
    }
    // Never resolve an omitted payout deed from today's selected base. The
    // original reviewed request and authority callback must name the same deed.
    if (command.kind === 'leave' && (multiBaseEnabled()
      ? baseId === null || command.baseContext?.baseId !== baseId
      : baseId !== null || command.baseContext !== undefined)) {
      throw new HttpError(409, 'review the original payout base again', 'CLAN_BASE_CONTEXT_MISMATCH');
    }
    let outcome: Pick<typeof clanCommandReceipts.$inferInsert, 'state' | 'payoutShards' | 'ledgerTransactionId' | 'refusalCode'>;
    try {
      // The savepoint is necessary: only a known domain refusal may commit a
      // no-effect receipt. Any partial mutation inside the attempt rolls back.
      outcome = await tx.transaction(async (attempt) => {
        if (command.kind === 'leave') {
          return { ...await leaveClanInTransaction(attempt, wallet, command.baseContext, request.clanId), refusalCode: null };
        }
        await kickMemberInTransaction(attempt, wallet, command.request.wallet, request.clanId);
        return { state: 'kicked', payoutShards: 0n, ledgerTransactionId: null, refusalCode: null };
      });
    } catch (error) {
      if (!(error instanceof ClanCommandRefused)) throw error;
      outcome = { state: 'refused', payoutShards: 0n, ledgerTransactionId: null, refusalCode: error.refusal };
    }
    const [row] = await tx.insert(clanCommandReceipts).values({
      actorWallet: wallet, requestKey: request.idempotencyKey, kind: command.kind,
      clanId: request.clanId, baseId, targetWallet: target, ...outcome,
    }).returning();
    // Receipt insertion/validation and the exact payout commit together. An
    // unavailable receipt store cannot acknowledge or strand a completed leave.
    return serialize(row!);
  });
}
