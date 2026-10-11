/** Exact public consent and original history, separate from current inventory. */
import { HarvesterSourceEnvelopeSchema, HarvesterSourceReceiptSchema, HarvesterSourceRequestSchema,
  HarvesterSourceSummarySchema, harvesterPolicyV1, type HarvesterSourceRequest } from '@shardkeep/shared/harvesterApi';
import { and, eq } from 'drizzle-orm';
import { harvestersEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { harvesterSources, harvesterSourceCommands, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import type { ExpeditionTermReader } from './expeditionTerms';
import { readHarvesterSource, selectHarvesterSource, type AcceptedHarvesterSource } from './harvesterSources';
import { readHarvesterSettlement } from './harvesterSettlement';
import type { StableBaseMutationContext } from './stableBasePrerequisites';

const mismatch = () => new HttpError(409, 'Harvester key belongs to another original command', 'IDEMPOTENCY_BODY_MISMATCH');
export function assertHarvesterSelectionsEnabled() {
  if (!harvestersEnabled()) throw new HttpError(503, 'Harvester selections are paused', 'HARVESTERS_DISABLED');
}
export function harvesterSourceSummary(source: AcceptedHarvesterSource) {
  return HarvesterSourceSummarySchema.parse({ sourceId: source.id, baseId: source.baseId, harvesterId: source.harvesterId,
    policyVersion: source.policyVersion, realmId: source.realmId, resourceId: source.resourceId,
    admittedAt: source.admittedAt.toISOString(), leaseExpiresAt: source.leaseExpiresAt.toISOString() });
}
export async function readHarvesterSourceCommand(db: DbOrTx, wallet: string, key: string, mutation = false) {
  // Bind the actor BEFORE any private home, term or settlement proof is decoded.
  const [identity] = await db.select({ wallet: harvesterSourceCommands.actorWallet }).from(harvesterSourceCommands)
    .where(eq(harvesterSourceCommands.id, key));
  if (!identity) {
    if (mutation) {
      const [reserved] = await db.select({ id: harvesterSources.id }).from(harvesterSources).where(eq(harvesterSources.id, key));
      if (reserved) throw mismatch();
    }
    return null;
  }
  if (identity.wallet !== wallet) { if (mutation) throw mismatch(); return null; }
  const [command] = await db.select().from(harvesterSourceCommands).where(and(eq(harvesterSourceCommands.id, key), eq(harvesterSourceCommands.actorWallet, wallet)));
  if (!command) throw new Error('Original Harvester command disappeared');
  const source = await readHarvesterSource(db, key);
  if (!source || !source.publicAdmission || source.actorWallet !== wallet || source.baseId !== command.baseId
    || source.harvesterId !== command.harvesterId || source.policyVersion !== command.policyVersion)
    throw new Error('Original Harvester command differs from accepted source');
  return HarvesterSourceReceiptSchema.parse({ wallet,
    request: { idempotencyKey: command.id, baseId: command.baseId, harvesterId: command.harvesterId,
      expectedSourceId: command.expectedSourceId, policyVersion: command.policyVersion },
    source: { ...harvesterSourceSummary(source), completedBuildJobId: source.harvesterCompletedJobId,
      harvesterCompletedAt: source.harvesterCompletedAt.toISOString(), terms: harvesterPolicyV1(),
      term: { termId: source.termId, termHash: source.termHash, startsAt: new Date(source.intervalSnapshot.term.startsAtMs).toISOString(),
        endsAt: new Date(source.intervalSnapshot.term.endsAtMs).toISOString() } } });
}
export function matchHarvesterSourceCommand(proof: NonNullable<Awaited<ReturnType<typeof readHarvesterSourceCommand>>>, request: HarvesterSourceRequest) {
  if (JSON.stringify(proof.request) !== JSON.stringify(HarvesterSourceRequestSchema.parse(request))) throw mismatch();
  return proof;
}
export async function harvesterSourceEnvelope(db: Db, wallet: string, key: string) {
  // Closure and its last event must be read from one committed history. Source
  // admission itself remains READ COMMITTED for genuine term pinning.
  return db.transaction(async tx => {
    const originalReceipt = await readHarvesterSourceCommand(tx, wallet, key);
    const scope = { wallet, idempotencyKey: key, serverNow: new Date().toISOString() };
    if (!originalReceipt) return HarvesterSourceEnvelopeSchema.parse({ ...scope, status: 'unknown', originalReceipt: null, settlement: null });
    const proof = await readHarvesterSettlement(tx, key);
    if (!proof) throw new Error('Original Harvester settlement history disappeared');
    return HarvesterSourceEnvelopeSchema.parse({ ...scope, status: 'accepted', originalReceipt, settlement: {
      events: proof.events.map(({ event: e }) => ({ sourceId: e.sourceId, ordinal: e.ordinal, walletSequence: e.walletSequence.toString(),
        resourceId: e.resourceId, policyVersion: e.policyVersion, earnedAt: e.earnedAt.toISOString(), settledAt: e.settledAt.toISOString(),
        utcDay: e.utcDay.toISOString(), grossQuantity: e.gross.toString(), netQuantity: e.net.toString(), islandPoolQuantity: e.tax.toString(),
        taxPolicyVersion: e.taxPolicyVersion, taxBasisPoints: e.taxBasisPoints, islandPoolBps: e.islandPoolBps,
        carryBefore: e.carryBefore.toString(), carryAfter: e.carryAfter.toString() })),
      closure: proof.closure ? { sourceId: proof.closure.sourceId, reason: proof.closure.reason,
        cutoffAt: proof.closure.cutoffAt.toISOString(), processedOrdinal: proof.closure.processedOrdinal } : null,
      custodyStop: proof.stop ? { sourceId: proof.stop.sourceId, cutoffAt: proof.stop.cutoffAt.toISOString(),
        checkedAt: proof.stop.checkedAt.toISOString(), auditHash: proof.stop.auditHash } : null,
    } });
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export async function selectHarvesterSourceCommand(db: Db, wallet: string, raw: HarvesterSourceRequest,
  authority: StableBaseMutationContext, deps: { reader: ExpeditionTermReader; clock?: () => Date }) {
  const request = HarvesterSourceRequestSchema.parse(raw);
  const prior = await readHarvesterSourceCommand(db, wallet, request.idempotencyKey, true);
  if (prior) return matchHarvesterSourceCommand(prior, request);
  assertHarvesterSelectionsEnabled();
  const clock = deps.clock ?? (() => new Date());
  // Consume even an injected provider outside SQL locks. Only this immutable,
  // single-use in-memory observation is available to the nested selector.
  const observation = await deps.reader.readOperatingTerm(new Date(clock().getTime()).toISOString());
  if (!observation) throw new HttpError(503, 'Genuine Harvester term unavailable', 'EXPEDITION_TERM_UNAVAILABLE');
  let used = false;
  try { return await db.transaction(async tx => {
    const [actor] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!actor) throw new HttpError(404, 'player not found');
    const original = await readHarvesterSourceCommand(tx, wallet, request.idempotencyKey, true);
    if (original) return matchHarvesterSourceCommand(original, request);
    assertHarvesterSelectionsEnabled();
    await selectHarvesterSource(tx, wallet, { id: request.idempotencyKey, baseId: request.baseId,
      harvesterId: request.harvesterId, policyVersion: request.policyVersion }, authority, {
      clock, assertAdmission: assertHarvesterSelectionsEnabled, publicCommand: { expectedSourceId: request.expectedSourceId },
      reader: { async readOperatingTerm() { if (used) throw new Error('Harvester observation already consumed'); used = true; return observation; } },
    });
    const accepted = await readHarvesterSourceCommand(tx, wallet, request.idempotencyKey, true);
    if (!accepted) throw new Error('Harvester public command was not persisted');
    return accepted;
  }); } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    // A cross-actor/global-key loser must roll back first, never adopt a winner.
    if (code === '23505') throw mismatch();
    throw error;
  }
}
