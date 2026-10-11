/** D153.28 internal source selection. Replacing an original source first settles
 * and closes its bounded obligation; new admission never backfills a paused gap.
 * Public consent may wrap this selector; reads never create production. */
import { PublicKey } from '@solana/web3.js';
import { BuildingType, PHASE_E_HARVESTER, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { HarvesterIntervalV1Schema } from '@shardkeep/shared/phaseEHarvester';
import { PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES } from '@shardkeep/shared/phaseEResources';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { bases, builderJobs, buildings, harvesterSources, harvesterSourceHeads, harvesterSourceCommands, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { resolveExpeditionHome } from './expeditionHome';
import { parseExpeditionTermObservation, unavailableExpeditionTermReader, type ExpeditionTermReader } from './expeditionTerms';
import { pinObservedOperatingExpeditionTerm, readStoredExpeditionTerm } from './expeditionTermStore';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';
import { closeHarvesterSources } from './harvesterSettlement';

const uuid = z.string().uuid().transform(v => v.toLowerCase());
const version = z.number().int().positive().max(2_147_483_647);
const instant = z.string().datetime({ precision: 3 });
// Historical geography format, not today's deed catalogue or free-home policy.
const home = z.discriminatedUnion('source', [
  z.object({ version: z.literal(1), baseId: uuid, custodyWallet: z.string().min(1), source: z.literal('free_assignment'), realmId: z.enum(REALM_IDS),
    evidence: z.object({ id: uuid, version, assignedWallet: z.string().min(1), provenance: z.string().min(1), assignedAt: instant }).strict() }).strict(),
  z.object({ version: z.literal(1), baseId: uuid, custodyWallet: z.string().min(1), source: z.literal('deed_location'), realmId: z.enum(REALM_IDS),
    evidence: z.object({ id: uuid, version, deedAssetId: z.string().min(1), worldId: z.string().min(1), tileId: z.number().int().nonnegative(),
      catalogHash: z.string().min(1), claimSource: z.enum(['purchase', 'migration-active', 'migration-inactive']), assignedAt: instant }).strict() }).strict(),
]);
export const HarvesterSourceCommandSchema = z.object({ id: uuid, baseId: uuid, harvesterId: uuid, policyVersion: version }).strict();
export type HarvesterSourceCommand = z.infer<typeof HarvesterSourceCommandSchema>;
const mismatch = () => new HttpError(409, 'Harvester key belongs to another original command', 'IDEMPOTENCY_BODY_MISMATCH');
const pending = () => new HttpError(409, 'Original Harvester source must be settled before replacement', 'HARVESTER_SOURCE_PENDING');
function currentObservation(value: unknown, at: Date) {
  const observed = parseExpeditionTermObservation(value, at.toISOString());
  if (at.getTime() - Date.parse(observed.finality.observedAt) > PHASE_E_SEEKER_AUCTION.observationMaxAgeMs)
    throw new Error('Harvester term observation is stale');
  return observed;
}

/** Private original evidence, never a current ownership/capacity view. A future
 * public adapter must bind authenticated original wallet before disclosing it. */
export async function readHarvesterSource(db: DbOrTx, id: string) {
  const [row] = await db.select().from(harvesterSources).where(eq(harvesterSources.id, uuid.parse(id)));
  if (!row) return null;
  const interval = HarvesterIntervalV1Schema.parse(row.intervalSnapshot), evidence = home.parse(row.homeEvidence);
  const term = await readStoredExpeditionTerm(db, row.termId, row.termHash);
  if (!term) throw new Error('Harvester source lacks original term');
  const observation = parseExpeditionTermObservation({ snapshot: term.snapshot, finality: row.finality }, row.admittedAt.toISOString());
  const resource = PHASE_E_RAW_RESOURCE_IDS.find(id => PHASE_E_RAW_RESOURCES[id].realmId === interval.realmId);
  const expires = Math.min(interval.admittedAtMs + PHASE_E_HARVESTER.v1.maxLeaseSec * 1_000, interval.term.endsAtMs);
  if (interval.sourceId !== row.id || interval.originalWallet !== row.actorWallet || interval.baseId !== row.baseId
    || interval.harvesterId !== row.harvesterId || interval.policyVersion !== row.policyVersion || interval.realmId !== row.realmId
    || interval.admittedAtMs !== row.admittedAt.getTime() || interval.term.id !== row.termId || interval.term.hash !== row.termHash
    || interval.term.startsAtMs !== Date.parse(term.snapshot.startsAt) || interval.term.endsAtMs !== Date.parse(term.snapshot.endsAt)
    || expires !== row.leaseExpiresAt.getTime() || evidence.baseId !== row.baseId || evidence.custodyWallet !== row.actorWallet
    || evidence.realmId !== row.realmId || row.resourceId !== resource || row.harvesterCompletedAt > row.admittedAt)
    throw new Error('Harvester source differs from original interval');
  return { ...row, intervalSnapshot: interval, homeEvidence: evidence, finality: observation.finality };
}
export type AcceptedHarvesterSource = NonNullable<Awaited<ReturnType<typeof readHarvesterSource>>>;
type Accepted = AcceptedHarvesterSource;
async function originalForActor(db: DbOrTx, id: string, wallet: string, reserved = false) {
  const [identity] = await db.select({ wallet: harvesterSources.actorWallet }).from(harvesterSources).where(eq(harvesterSources.id, id));
  if (!identity) return null;
  if (reserved || identity.wallet !== wallet) throw mismatch();
  return readHarvesterSource(db, id);
}
function match(row: Accepted, wallet: string, cmd: HarvesterSourceCommand) {
  if (row.actorWallet !== wallet || row.baseId !== cmd.baseId || row.harvesterId !== cmd.harvesterId || row.policyVersion !== cmd.policyVersion) throw mismatch();
  return row;
}
async function completedHarvester(tx: DbTx, cmd: HarvesterSourceCommand) {
  const [facility] = await tx.select().from(buildings).where(and(eq(buildings.id, cmd.harvesterId), eq(buildings.baseId, cmd.baseId))).for('update');
  if (!facility || facility.type !== BuildingType.Harvester || facility.level < 1)
    throw new HttpError(409, 'Completed Harvester required', 'HARVESTER_FACILITY_UNAVAILABLE');
  const jobs = await tx.select().from(builderJobs).where(and(eq(builderJobs.buildingId, facility.id), eq(builderJobs.kind, 'build')));
  const completed = jobs.find(j => j.baseId === cmd.baseId && j.completedAt !== null && j.cancelledAt === null);
  if (jobs.some(j => j.completedAt === null) || !completed?.completedAt)
    throw new HttpError(409, 'Completed Harvester required', 'HARVESTER_FACILITY_UNAVAILABLE');
  return { jobId: completed.id, at: completed.completedAt };
}
export async function selectHarvesterSource(db: DbOrTx, wallet: string, command: HarvesterSourceCommand,
  authority: StableBaseMutationContext, deps: { reader?: ExpeditionTermReader; clock?: () => Date;
    assertAdmission?: () => void; publicCommand?: { expectedSourceId: string | null } } = {}) {
  const cmd = HarvesterSourceCommandSchema.parse(command), context = { ...authority };
  const reviewedHead = deps.publicCommand ? uuid.nullable().parse(deps.publicCommand.expectedSourceId) : undefined;
  // The public wrapper alone may replay an original exact request.
  const prior = await originalForActor(db, cmd.id, wallet, !!deps.publicCommand);
  if (prior) return match(prior, wallet, cmd);
  if (new PublicKey(wallet).toBase58() !== wallet) throw new Error('Invalid original Harvester wallet');
  const clock = deps.clock ?? (() => new Date());
  // Provider work precedes every lock this helper acquires. An outer transaction
  // that already holds locks MUST supply the genuine no-RPC single-use prefetch
  // bridge; it must never inject a cold reader. No public/config fallback exists.
  const fetched = await (deps.reader ?? unavailableExpeditionTermReader).readOperatingTerm(new Date(clock().getTime()).toISOString());
  if (!fetched) throw new Error('Authoritative operating Harvester term unavailable');
  const observation = currentObservation(fetched, new Date(clock().getTime()));
  return (db as Db).transaction(async tx => {
    const [player] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const replay = await originalForActor(tx, cmd.id, wallet, !!deps.publicCommand);
    if (replay) return match(replay, wallet, cmd);
    if (uuid.parse(context.baseId) !== cmd.baseId) throw mismatch();
    const involved = await tx.select().from(harvesterSourceHeads).where(or(eq(harvesterSourceHeads.wallet, wallet), eq(harvesterSourceHeads.baseId, cmd.baseId)));
    const baseIds = [...new Set([cmd.baseId, ...involved.map(head => head.baseId)])].sort();
    const lockedBases = await tx.select().from(bases).where(inArray(bases.id, baseIds)).orderBy(asc(bases.id)).for('update');
    // Never acquire an unexpected base after these locks/accounting locks. A
    // concurrent boundary may close a head; a new foreign head must be retried.
    const heads = await tx.select().from(harvesterSourceHeads).where(or(eq(harvesterSourceHeads.wallet, wallet), eq(harvesterSourceHeads.baseId, cmd.baseId)));
    if (heads.some(head => !baseIds.includes(head.baseId) || head.wallet !== wallet)) throw pending();
    await lockStablePrerequisiteBase(tx, wallet, context);
    deps.assertAdmission?.();
    if (deps.publicCommand && (heads.find(head => head.wallet === wallet)?.sourceId ?? null) !== reviewedHead)
      throw new HttpError(409, 'Harvester source review changed', 'HARVESTER_SOURCE_CHANGED');
    if (cmd.policyVersion !== PHASE_E_HARVESTER.currentPolicyVersion) throw new HttpError(409, 'Harvester review is stale', 'HARVESTER_POLICY_CHANGED');
    if (deps.publicCommand) await tx.insert(harvesterSourceCommands).values({ id: cmd.id, actorWallet: wallet,
      baseId: cmd.baseId, harvesterId: cmd.harvesterId, expectedSourceId: reviewedHead!, policyVersion: cmd.policyVersion });
    const evidence = await resolveExpeditionHome(tx, wallet, context), facility = await completedHarvester(tx, cmd);
    const closeAt = new Date(clock().getTime());
    currentObservation(observation, closeAt);
    for (const head of heads) {
      const originalBase = lockedBases.find(base => base.id === head.baseId);
      // Lost-custody/deactivated sources require their real boundary's cutoff.
      // Selection must not invent that historical instant for a seller/buyer.
      if (!originalBase || originalBase.ownerWallet !== wallet || originalBase.status !== 'active') throw pending();
      const original = await readHarvesterSource(tx, head.sourceId);
      if (!original) throw new Error('Original Harvester source missing');
      await closeHarvesterSources(tx, head.baseId, closeAt, original.leaseExpiresAt <= closeAt ? 'lease_expired' : 'replacement');
    }
    const pinAt = new Date(clock().getTime());
    const checked = currentObservation(observation, pinAt);
    const term = await pinObservedOperatingExpeditionTerm(tx, pinAt, { async readOperatingTerm() { return checked; } });
    // Term pinning can wait on its shared advisory lock. The accepted interval
    // must use the real time AFTER that wait and still-current admission flags.
    const admittedAt = new Date(clock().getTime());
    currentObservation(observation, admittedAt); deps.assertAdmission?.();
    if (!Number.isFinite(admittedAt.getTime()) || facility.at > admittedAt) throw new Error('Harvester facility is not complete at admission');
    const interval = HarvesterIntervalV1Schema.parse({ policyVersion: cmd.policyVersion, sourceId: cmd.id, originalWallet: wallet,
      baseId: cmd.baseId, harvesterId: cmd.harvesterId, realmId: evidence.realmId, admittedAtMs: admittedAt.getTime(),
      term: { id: term.snapshot.termId, hash: term.hash, startsAtMs: Date.parse(term.snapshot.startsAt), endsAtMs: Date.parse(term.snapshot.endsAt) } });
    const resourceId = PHASE_E_RAW_RESOURCE_IDS.find(id => PHASE_E_RAW_RESOURCES[id].realmId === interval.realmId)!;
    const [inserted] = await tx.insert(harvesterSources).values({ ...cmd, actorWallet: wallet, realmId: interval.realmId, resourceId, homeEvidence: evidence,
      harvesterCompletedJobId: facility.jobId, harvesterCompletedAt: facility.at, intervalSnapshot: interval,
      termId: term.snapshot.termId, termHash: term.hash, finality: term.finality, admittedAt,
      leaseExpiresAt: new Date(Math.min(interval.admittedAtMs + PHASE_E_HARVESTER.v1.maxLeaseSec * 1_000, interval.term.endsAtMs)) }).onConflictDoNothing().returning({ id: harvesterSources.id });
    if (!inserted) {
      // A still-new public command cannot adopt a concurrent internal winner,
      // even if its body matches. Roll back every incidental closure/settlement.
      if (deps.publicCommand) throw mismatch();
      const winner = await readHarvesterSource(tx, cmd.id);
      if (!winner) throw mismatch();
      return match(winner, wallet, cmd);
    }
    await tx.insert(harvesterSourceHeads).values({ wallet, baseId: cmd.baseId, sourceId: cmd.id });
    const accepted = await readHarvesterSource(tx, cmd.id);
    if (!accepted) throw new Error('Harvester source was not persisted');
    return accepted;
  });
}
