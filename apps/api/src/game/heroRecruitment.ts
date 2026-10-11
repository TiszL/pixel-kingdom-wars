import { HeroRecruitmentReceiptSchema, HeroRecruitmentRequestSchema, type HeroRecruitmentReceipt, type HeroRecruitmentRequest } from '@shardkeep/shared/heroRecruitment';
import { and, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { heroRecruitmentCommands, players } from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { placeHeroRecruitment, type StableBaseMutationContext } from './base';

export const heroRecruitmentEnabled = () => process.env['HERO_RECRUITMENT_ENABLED'] === 'true';
function serialize(row: typeof heroRecruitmentCommands.$inferSelect): HeroRecruitmentReceipt {
  const receipt = HeroRecruitmentReceiptSchema.parse(row.receipt);
  if (receipt.actor !== row.actorWallet || receipt.idempotencyKey !== row.requestKey
    || receipt.createdAt !== row.createdAt.toISOString()) throw new Error('hero recruitment storage identity mismatch');
  return receipt;
}
/** Historical acceptance only. No placement, settlement, ownership RPC, job
 * completion or balance bootstrap. Missing proof never establishes failure. */
export async function getHeroRecruitmentCommand(db: DbOrTx, wallet: string, key: string) {
  const [row] = await db.select().from(heroRecruitmentCommands)
    .where(and(eq(heroRecruitmentCommands.actorWallet, wallet), eq(heroRecruitmentCommands.requestKey, key)));
  return { version: 1 as const, wallet, idempotencyKey: key, enabled: heroRecruitmentEnabled(), receipt: row ? serialize(row) : null };
}
/** GET route only. Clients read `receipt: null` as "this key never committed",
 * so wait on the player lock the command holds (FOR UPDATE, before its key
 * lookup) rather than read past a command still in flight. A request still
 * before its lock remains invisible. The wire shape is unchanged; web and native
 * decode it with an exact key set. */
export async function readHeroRecruitmentCommand(db: Db, wallet: string, key: string) {
  return db.transaction(async tx => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('share');
    return getHeroRecruitmentCommand(tx, wallet, key);
  }, { isolationLevel: 'read committed' });
}
function match(prior: HeroRecruitmentReceipt, request: HeroRecruitmentRequest) {
  if ((Object.keys(request) as Array<keyof HeroRecruitmentRequest>).some(key => prior.request[key] !== request[key])) {
    throw new HttpError(409, 'this key belongs to different hero recruitment consent', 'HERO_RECRUITMENT_MISMATCH');
  }
  return prior;
}
export async function executeHeroRecruitmentCommand(db: Db, wallet: string, input: HeroRecruitmentRequest,
  now = new Date(), context?: StableBaseMutationContext): Promise<HeroRecruitmentReceipt> {
  const request = HeroRecruitmentRequestSchema.parse(input);
  return db.transaction(async tx => {
    // The canonical placement and deed transfer already take player -> base ->
    // slot locks. Reuse that player root before the historical-key lookup;
    // never lock a receipt or base before the player or introduce a new order.
    const [actor] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!actor) throw new HttpError(401, 'player session is unavailable');
    const prior = (await getHeroRecruitmentCommand(tx, wallet, request.idempotencyKey)).receipt;
    if (prior) return match(prior, request);
    if (!heroRecruitmentEnabled()) throw new HttpError(503, 'Hero recruitment is temporarily unavailable', 'HERO_RECRUITMENT_DISABLED');
    // Null is explicit legacy consent, never permission to discover today's
    // selected deed. An explicit stable target is honored in both flag states.
    if (request.baseId === null && multiBaseEnabled()) throw new HttpError(409, 'review an explicit original base before recruiting', 'BASE_ID_REQUIRED');
    if (request.baseId ? context?.baseId !== request.baseId : context !== undefined) {
      throw new HttpError(409, 'review the original hero recruitment base again', 'HERO_RECRUITMENT_CONTEXT_MISMATCH');
    }
    const receipt = await placeHeroRecruitment(tx, wallet, request, now, context);
    const [saved] = await tx.insert(heroRecruitmentCommands).values({ actorWallet: wallet, requestKey: request.idempotencyKey,
      receipt, createdAt: now,
    }).returning();
    // Failed storage or malformed returned proof rolls back funding, audit,
    // lazy completion, the new building and its job in this same transaction.
    return serialize(saved!);
  });
}
