import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import type { FinalizedAssetOwnership } from '@shardkeep/chain';
import { BaseClaimCancellationSchema, BaseClaimCandidateSchema, BaseClaimReceiptSchema, BaseClaimRequestSchema, BaseClaimStatusSchema,
  type BaseClaimReceipt, type BaseClaimRequest } from '@shardkeep/shared/baseClaims';
import type { Db, DbOrTx } from '../db/client';
import { baseClaimCommands, bases, baseSlots, deedOwnershipObservations, players } from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { findClaimableBase, type DeedReaders } from './baseClaim';
import { ownershipEligible } from './baseTransfer';
import { deedProofIsFresh, deedProofMeetsFloor, invalidateBaseWorldCaches, observationHash, observeDeedOwnership, recordFinalizedHarvesterLossLocked, transferClaimedStableBase } from './baseOwnership';
import { markDeedDirty } from './deedMetadata';

export const baseClaimEnabled = () => process.env['BASE_CLAIM_V1_ENABLED'] === 'true' && multiBaseEnabled();
const cancelled = () => new HttpError(409, 'this unaccepted deed claim was cancelled', 'BASE_CLAIM_CANCELLED');
const changed = () => new HttpError(409, 'the original deed claim changed; recheck this request', 'BASE_CLAIM_CHANGED');
async function lookup(db: DbOrTx, wallet: string, key: string) {
  return (await db.select().from(baseClaimCommands).where(and(eq(baseClaimCommands.actorWallet, wallet), eq(baseClaimCommands.requestKey, key))))[0];
}
function receipt(row: typeof baseClaimCommands.$inferSelect): BaseClaimReceipt | null {
  if (row.receipt === null) {
    if (row.transferId !== null) throw new Error('cancelled claim contains transfer evidence');
    return null;
  }
  const r = BaseClaimReceiptSchema.parse(row.receipt);
  if (r.actor !== row.actorWallet || r.idempotencyKey !== row.requestKey || r.transferId !== row.transferId
    || r.createdAt !== row.createdAt.toISOString()) throw new Error('claim storage identity differs');
  return r;
}
function replay(row: typeof baseClaimCommands.$inferSelect, request: BaseClaimRequest) {
  const r = receipt(row); if (!r) throw cancelled();
  if (Object.entries(request).some(([key, value]) => r.request[key as keyof BaseClaimRequest] !== value)) {
    throw new HttpError(409, 'this key belongs to different deed claim consent', 'BASE_CLAIM_MISMATCH');
  }
  return r;
}
/** Historical proof only: no present-day ownership, settlement, RPC or selector. */
export async function getBaseClaim(db: DbOrTx, wallet: string, key: string) {
  const row = await lookup(db, wallet, key);
  return BaseClaimStatusSchema.parse({ version: 1, wallet, idempotencyKey: key, enabled: baseClaimEnabled(), receipt: row ? receipt(row) : null });
}
export async function getClaimableBaseV1(db: Db, readers: DeedReaders | null, wallet: string) {
  const enabled = baseClaimEnabled();
  const found = enabled && readers?.collection ? await findClaimableBase(db, readers, wallet) : { claimable: null, reason: 'unavailable' as const };
  return BaseClaimCandidateSchema.parse({ version: 1, wallet, enabled, reason: found.reason,
    candidate: found.claimable ? { baseId: found.claimable.baseId, deedAssetId: found.claimable.deedAssetId } : null });
}
/** Cancellation competes for the same actor/key. Null is an immutable tombstone,
 * never a deleted receipt or permission to discard an acknowledged transfer. */
export async function cancelUnacceptedBaseClaim(db: Db, wallet: string, key: string) {
  return db.transaction(async tx => {
    const [actor] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!actor) throw new HttpError(401, 'player session is unavailable');
    const row = await lookup(tx, wallet, key);
    if (!row) await tx.insert(baseClaimCommands).values({ actorWallet: wallet, requestKey: key });
    const original = row ? receipt(row) : null;
    return BaseClaimCancellationSchema.parse({ version: 1, wallet, idempotencyKey: key, cancelled: original === null, receipt: original });
  });
}
export async function executeBaseClaim(db: Db, readers: DeedReaders | null, wallet: string, input: BaseClaimRequest,
  clock: () => Date = () => new Date()) {
  const request = BaseClaimRequestSchema.parse(input);
  const prior = await lookup(db, wallet, request.idempotencyKey);
  if (prior) return replay(prior, request);
  if (!baseClaimEnabled()) throw new HttpError(503, 'new deed claims are paused', 'BASE_CLAIM_DISABLED');
  if (!readers?.collection) throw new HttpError(503, 'deed ownership verification is unavailable', 'BASE_CLAIM_UNAVAILABLE');
  const collection = readers.collection;
  try { if (new PublicKey(request.deedAssetId).toBase58() !== request.deedAssetId) throw changed(); }
  catch { throw new HttpError(400, 'invalid deed asset', 'BASE_CLAIM_INVALID_DEED'); }
  // This read chooses a lock participant, never another target. After taking
  // globally sorted player locks the same base/deed/owner must still agree.
  const [observed] = await db.select({ owner: bases.ownerWallet, deed: bases.deedAssetId }).from(bases).where(eq(bases.id, request.baseId));
  if (!observed || observed.deed !== request.deedAssetId) throw changed();
  let proof: Awaited<ReturnType<DeedReaders['ownerOf']>>;
  try { proof = await readers.ownerOf(request.deedAssetId); }
  catch { throw new HttpError(503, 'deed ownership verification is unavailable', 'BASE_CLAIM_UNAVAILABLE'); }
  const observedAtMs = clock().getTime();
  if (!proof || proof.owner !== wallet || !ownershipEligible(proof, collection)
    || !('slot' in proof) || !Number.isSafeInteger(proof.slot) || Number(proof.slot) < 0) {
    throw new HttpError(422, 'this deed is not currently transferable to this wallet', 'BASE_CLAIM_NOT_TRANSFERABLE');
  }
  const finalized = observeDeedOwnership(proof as FinalizedAssetOwnership, observedAtMs);
  // This is an independently proven external custody fact, not acceptance of
  // this command. Preserve it even if later delivery overflows or cancellation
  // wins. Recheck the original actor/key under locks BEFORE mutable evidence,
  // so a concurrent accepted claim still returns its exact original receipt.
  const journalReplay = await db.transaction(async tx => {
    const locked = await tx.select({ wallet: players.wallet }).from(players)
      .where(inArray(players.wallet, [wallet, observed.owner])).orderBy(asc(players.wallet)).for('update');
    if (!locked.some(player => player.wallet === wallet)) throw new HttpError(401, 'player session is unavailable');
    const existing = await lookup(tx, wallet, request.idempotencyKey);
    if (existing) return replay(existing, request);
    await recordFinalizedHarvesterLossLocked(tx, request.baseId, observed.owner, wallet, request.deedAssetId, finalized, clock);
    return null;
  });
  if (journalReplay) return journalReplay;
  const accepted = await db.transaction(async tx => {
    const locked = await tx.select({ wallet: players.wallet }).from(players)
      .where(inArray(players.wallet, [wallet, observed.owner])).orderBy(asc(players.wallet)).for('update');
    if (!locked.some(p => p.wallet === wallet)) throw new HttpError(401, 'player session is unavailable');
    const existing = await lookup(tx, wallet, request.idempotencyKey);
    if (existing) return replay(existing, request);
    if (!baseClaimEnabled()) throw new HttpError(503, 'new deed claims are paused', 'BASE_CLAIM_DISABLED');
    const [base] = await tx.select().from(bases).where(eq(bases.id, request.baseId)).for('update');
    if (!base || base.deedAssetId !== request.deedAssetId || base.ownerWallet !== observed.owner) throw changed();
    const alreadyOwned = base.ownerWallet === wallet;
    const slots = alreadyOwned ? await tx.select({ active: baseSlots.active }).from(baseSlots).where(eq(baseSlots.baseId, base.id)).for('update') : [];
    const now = new Date(clock().getTime());
    if (!deedProofIsFresh(finalized, now)) {
      throw new HttpError(503, 'fresh deed ownership evidence is unavailable', 'BASE_CLAIM_UNAVAILABLE');
    }
    const [previousProof] = await tx.select({ id: deedOwnershipObservations.id, slot: deedOwnershipObservations.slot, owner: deedOwnershipObservations.owner }).from(deedOwnershipObservations)
      .where(eq(deedOwnershipObservations.baseId, base.id)).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
    if (!deedProofMeetsFloor(previousProof, BigInt(finalized.slot), finalized.owner)) {
      throw new HttpError(503, 'fresh deed ownership evidence is unavailable', 'BASE_CLAIM_UNAVAILABLE');
    }
    // Every accepted finalized proof advances the canonical observation, even
    // for an ordinary active or already-owned deed. Otherwise a later failover
    // RPC could roll ownership back below a slot this command already accepted.
    const checkedAt = new Date(finalized.observedAtMs);
    const evidence = { assetId: request.deedAssetId, owner: wallet, slot: BigInt(finalized.slot), checkedAt,
      source: 'claim-finalized', status: 'owned' as const,
      auditHash: observationHash(request.deedAssetId, wallet, 'owned', BigInt(finalized.slot), checkedAt) };
    if (previousProof) await tx.update(deedOwnershipObservations).set(evidence).where(eq(deedOwnershipObservations.id, previousProof.id));
    else await tx.insert(deedOwnershipObservations).values({ baseId: base.id, ...evidence });
    const moved = alreadyOwned ? null : await transferClaimedStableBase(tx, base.id, observed.owner, wallet, request.deedAssetId, finalized, () => now);
    const r = BaseClaimReceiptSchema.parse({ version: 1, actor: wallet, idempotencyKey: request.idempotencyKey, request,
      outcome: alreadyOwned ? 'already_owned' : 'claimed', active: moved ? moved.active : base.status === 'active' && slots.some(s => s.active),
      transferId: moved?.transferId ?? null, fromWallet: moved ? observed.owner : null,
      ownership: { owner: wallet, collection, slot: String(finalized.slot) }, createdAt: now.toISOString() });
    const [saved] = await tx.insert(baseClaimCommands).values({ actorWallet: wallet, requestKey: request.idempotencyKey,
      transferId: r.transferId, receipt: r, createdAt: now }).returning();
    if (!saved) throw new Error('claim receipt was not written');
    return receipt(saved)!;
  });
  if (accepted.outcome === 'claimed') {
    markDeedDirty(request.deedAssetId);
    try { await invalidateBaseWorldCaches(db, request.baseId); }
    catch (error) { console.error('[base-claim] committed claim cache invalidation failed', error); }
  }
  return accepted;
}
