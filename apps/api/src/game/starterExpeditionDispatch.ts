import {createEquipmentSecondary,readEquipmentSecondary} from './ordinaryEquipmentSecondary';
import {assertOrdinaryCraftingStartsEnabled} from './ordinaryCrafting';
import {EquipmentFittingSchema,applyEquipmentFitting,fittingSelection} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {reserveOrdinaryEquipment,assertEquipmentReservation} from './ordinaryEquipment';
/** Internal D153.19 starter admission. No route/worker/fixture fallback. A real
 * finalized reader is required; every new source is captured under base locks. */
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { starterRoutePreview, StarterRouteIdSchema } from '@shardkeep/shared/phaseEExpeditions';
import { PaidStarterRouteIdSchema, paidStarterRoutePreview, paidStarterRouteAtDeparture } from '@shardkeep/shared/paidStarterExpeditions';
import { StarterExpeditionRouteSnapshotSchema } from '@shardkeep/shared/starterExpeditionApi';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { fleetInstallations, players, starterExpeditions, starterExpeditionInflight } from '../db/schema';
import { HttpError } from '../lib/errors';
import { assertExpeditionRealmAccessAtDeparture, ExpeditionRealmAccessError, type ExpeditionRealmAccessReader, type ExpeditionRealmAccessObservation } from './expeditionRealmAccess';
import { resolveExpeditionHome } from './expeditionHome';
import { parseExpeditionTermObservation, type ExpeditionTermReader } from './expeditionTerms';
import { pinObservedOperatingExpeditionTerm, readStoredExpeditionTerm } from './expeditionTermStore';
import { getStarterFleet } from './starterFleet';
import { readCompletedLodge } from './starterExpeditionFacilities';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const routeId = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
const version = z.number().int().positive().max(2_147_483_647);
export const StarterExpeditionCommandSchema = z.object({ id: uuid, baseId: uuid, installationId: uuid,
  routeId, routeVersion: version, rewardVersion: version, fitting: EquipmentFittingSchema.optional() }).strict();
export type StarterExpeditionCommand = z.infer<typeof StarterExpeditionCommandSchema>;
const instant = z.string().datetime({ precision: 3 }).refine(v => new Date(v).toISOString() === v);
// Historical format only: never call current preview/home-catalogue validators
// here. Accepted evidence outlives policy, prices, ownership and live facilities.
const historicalHome = z.discriminatedUnion('source', [
  z.object({ version: z.literal(1), baseId: uuid, custodyWallet: z.string().min(1), source: z.literal('free_assignment'),
    realmId: z.enum(REALM_IDS), evidence: z.object({ id: uuid, version, assignedWallet: z.string().min(1),
      provenance: z.string().min(1), assignedAt: instant }).strict() }).strict(),
  z.object({ version: z.literal(1), baseId: uuid, custodyWallet: z.string().min(1), source: z.literal('deed_location'),
    realmId: z.enum(REALM_IDS), evidence: z.object({ id: uuid, version, deedAssetId: z.string().min(1),
      worldId: z.string().min(1), tileId: z.number().int().nonnegative(), catalogHash: z.string().min(1),
      claimSource: z.enum(['purchase', 'migration-active', 'migration-inactive']), assignedAt: instant }).strict() }).strict(),
]);
const historicalRoute = StarterExpeditionRouteSnapshotSchema;
type Row = typeof starterExpeditions.$inferSelect;
export type AcceptedStarterExpedition = Omit<Row, 'homeEvidence' | 'routeSnapshot' | 'finality'> & {
  homeEvidence: z.infer<typeof historicalHome>; routeSnapshot: z.infer<typeof historicalRoute>;
  finality: ReturnType<typeof parseExpeditionTermObservation>['finality'];
};

/** Private historical integrity only. Public adapters must separately bind the
 * authenticated original actor and exact command. No current stock is read. */
export async function readStarterExpedition(db: DbOrTx, id: string): Promise<AcceptedStarterExpedition | null> {
  const [row] = await db.select().from(starterExpeditions).where(eq(starterExpeditions.id, uuid.parse(id)));
  if (!row) return null;
  const homeEvidence = historicalHome.parse(row.homeEvidence), routeSnapshot = historicalRoute.parse(row.routeSnapshot);
  const term = await readStoredExpeditionTerm(db, row.termId, row.termHash);
  if (!term) throw new Error('Accepted starter expedition lacks original term');
  const { finality } = parseExpeditionTermObservation({ snapshot: term.snapshot, finality: row.finality }, row.departedAt.toISOString());
  if (homeEvidence.baseId !== row.baseId || homeEvidence.custodyWallet !== row.actorWallet
    || (!('access' in routeSnapshot) && routeSnapshot.realmId !== homeEvidence.realmId) || routeSnapshot.routeId !== row.routeId
    || routeSnapshot.routeCatalogueVersion !== row.routeVersion || routeSnapshot.rewardTableVersion !== row.rewardVersion
    || routeSnapshot.resourceId !== row.resourceId || BigInt(routeSnapshot.grossQuantity) !== row.gross
    || BigInt(routeSnapshot.netQuantity) !== row.net || BigInt(routeSnapshot.islandPoolQuantity) !== row.tax
    || !paidStarterRouteAtDeparture(routeSnapshot, row.departedAt.toISOString(), row.actorWallet)
    || ('access' in routeSnapshot && routeSnapshot.access.kind === 'paid_realm'
      && (routeSnapshot.access.observation.source.genesisHash !== term.snapshot.source.genesisHash
        || routeSnapshot.access.observation.source.programId !== term.snapshot.source.programId))
    || row.net + row.tax !== row.gross
    || row.returnsAt.getTime() - row.departedAt.getTime() !== routeSnapshot.durationSec * 1_000) {
    throw new Error('Accepted starter expedition differs from original evidence');
  }
  if(routeSnapshot.fitting)await assertEquipmentReservation(db,'starter',row.id,row.baseId,routeSnapshot.fitting);
  const secondary=await readEquipmentSecondary(db,'starter',row.id,routeSnapshot.secondaryOutput);if(secondary&&(secondary.base_id!==row.baseId||secondary.term_id!==row.termId||secondary.term_hash!==row.termHash))throw Error('Companion source differs from original trip');
  return { ...row, homeEvidence, routeSnapshot, finality };
}
const conflict = () => new HttpError(409, 'Expedition key belongs to a different original command', 'IDEMPOTENCY_BODY_MISMATCH');
export function matchStarterExpeditionCommand(row: AcceptedStarterExpedition, wallet: string, cmd: StarterExpeditionCommand) {
  if (JSON.stringify(fittingSelection(row.routeSnapshot).fitting)!==JSON.stringify(cmd.fitting) || row.actorWallet !== wallet || row.baseId !== cmd.baseId || row.installationId !== cmd.installationId
    || row.routeId !== cmd.routeId || row.routeVersion !== cmd.routeVersion || row.rewardVersion !== cmd.rewardVersion) throw conflict();
  return row;
}
/** Check actor before loading private original term/home evidence. */
export async function readOwnedStarterExpedition(db: DbOrTx, wallet: string, id: string, mutation = false) {
  const [identity] = await db.select({ actor: starterExpeditions.actorWallet }).from(starterExpeditions).where(eq(starterExpeditions.id, uuid.parse(id)));
  if (!identity) return null;
  if (identity.actor !== wallet) { if (mutation) throw conflict(); return null; }
  const proof = await readStarterExpedition(db, id);
  if (!proof) throw new Error('Original expedition disappeared');
  return proof;
}
export interface StarterExpeditionDependencies {
  /** Server wiring only; never sourced from JSON or public configuration. */
  reader?: ExpeditionTermReader;
  /** Authentic single-use finalized access capability, prefetched before locks. */
  readCoverage?: ExpeditionRealmAccessReader['readCoverage'];
  clock?: () => Date;
  /** Public transport's live new-start gate, rechecked after canonical locks.
   * Internal source fixtures remain explicit and do not activate public routes. */
  assertAdmission?: () => void;
}
export async function dispatchStarterExpedition(
  db: DbOrTx, wallet: string, command: StarterExpeditionCommand, authority: StableBaseMutationContext,
  deps: StarterExpeditionDependencies = {},
): Promise<AcceptedStarterExpedition> {
  return (await dispatchStarterExpeditionResult(db, wallet, command, authority, deps)).expedition;
}

/** The fresh distinction is publishable only after the owning transaction commits.
 * Existing transaction callers retain the accepted-row entry above. */
export async function dispatchStarterExpeditionCommitted(
  db: Db, wallet: string, command: StarterExpeditionCommand, authority: StableBaseMutationContext,
  deps: StarterExpeditionDependencies = {},
): Promise<{ created: boolean; expedition: AcceptedStarterExpedition }> {
  if ('rollback' in db) throw new Error('Committed starter dispatch requires a top-level connection');
  return dispatchStarterExpeditionResult(db, wallet, command, authority, deps);
}

async function dispatchStarterExpeditionResult(
  db: DbOrTx, wallet: string, command: StarterExpeditionCommand, authority: StableBaseMutationContext,
  deps: StarterExpeditionDependencies,
): Promise<{ created: boolean; expedition: AcceptedStarterExpedition }> {
  const cmd = StarterExpeditionCommandSchema.parse(command);
  const old = await readOwnedStarterExpedition(db, wallet, cmd.id, true);
  if (old) return { created: false, expedition: matchStarterExpeditionCommand(old, wallet, cmd) };
  return (db as Db).transaction(async tx => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const prior = await readOwnedStarterExpedition(tx, wallet, cmd.id, true);
    if (prior) return { created: false, expedition: matchStarterExpeditionCommand(prior, wallet, cmd) };
    deps.assertAdmission?.();
    if (uuid.parse(authority.baseId) !== cmd.baseId) throw conflict();
    if(cmd.fitting)assertOrdinaryCraftingStartsEnabled();
    const context = { ...authority, baseId: cmd.baseId };
    await lockStablePrerequisiteBase(tx, wallet, context);
    deps.assertAdmission?.();
    const home = await resolveExpeditionHome(tx, wallet, context);
    const fleet = await getStarterFleet(tx, wallet, context);
    if (!fleet || fleet.installationId !== cmd.installationId) throw new HttpError(409, 'Original starter installation unavailable', 'STARTER_FLEET_UNAVAILABLE');
    const [installation] = await tx.select().from(fleetInstallations).where(eq(fleetInstallations.id, fleet.installationId)).for('update');
    if (!installation || installation.baseId !== cmd.baseId) throw new Error('Starter installation scope changed');
    const [flight] = await tx.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId, cmd.installationId));
    if (flight) throw new HttpError(409, 'Starter vehicle is already away', 'STARTER_EXPEDITION_INFLIGHT');
    const lodgeCompletedAt = await readCompletedLodge(tx, cmd.baseId);
    if (!lodgeCompletedAt) throw new HttpError(409, 'A completed Lodge on this base is required', 'EXPEDITION_LODGE_UNAVAILABLE');
    const clock = deps.clock ?? (() => new Date());
    const beforeTermLock = new Date(clock().getTime());
    if (!Number.isFinite(beforeTermLock.getTime()) || lodgeCompletedAt > beforeTermLock || new Date(fleet.berthCompletedAt) > beforeTermLock)
      throw new Error('Starter facilities are not complete at dispatch');
    const parsedRoute = StarterRouteIdSchema.safeParse(cmd.routeId), paidRoute = PaidStarterRouteIdSchema.safeParse(cmd.routeId);
    if (!parsedRoute.success && !paidRoute.success) throw new HttpError(400, 'Unknown starter route', 'EXPEDITION_ROUTE_INVALID');
    const preview = paidRoute.success ? paidStarterRoutePreview(paidRoute.data) : starterRoutePreview(home.realmId, parsedRoute.data!);
    let coverage: ExpeditionRealmAccessObservation | undefined;
    if (paidRoute.success) {
      if (!deps.readCoverage) throw new ExpeditionRealmAccessError('UNAVAILABLE');
      coverage = await deps.readCoverage(beforeTermLock.toISOString());
      assertExpeditionRealmAccessAtDeparture(coverage, { wallet, realm: REALM_IDS.indexOf(preview.realmId) }, beforeTermLock.toISOString());
    }
    const route = historicalRoute.parse(applyEquipmentFitting(coverage ? { ...preview, access: { ...preview.access, observation: coverage } } : preview,cmd.fitting));
    if (route.routeCatalogueVersion !== cmd.routeVersion || route.rewardTableVersion !== cmd.rewardVersion)
      throw new HttpError(409, 'Starter route review is stale', 'EXPEDITION_ROUTE_CHANGED');
    const term = await pinObservedOperatingExpeditionTerm(tx, beforeTermLock, deps.reader);
    // Pinning can wait on its source advisory lock. The original single-use
    // observation is not permission to depart at that earlier time: revalidate
    // it and the live gate after the final wait without consuming another read.
    const departedAt = new Date(clock().getTime());
    deps.assertAdmission?.();
    if (!Number.isFinite(departedAt.getTime()) || lodgeCompletedAt > departedAt || new Date(fleet.berthCompletedAt) > departedAt)
      throw new Error('Starter facilities are not complete at dispatch');
    const checked = parseExpeditionTermObservation({ snapshot: term.snapshot, finality: term.finality }, departedAt.toISOString());
    if (departedAt.getTime() - Date.parse(checked.finality.observedAt) > PHASE_E_SEEKER_AUCTION.observationMaxAgeMs)
      throw new Error('Starter expedition term observation is stale');
    if (coverage) {
      assertExpeditionRealmAccessAtDeparture(coverage, { wallet, realm: REALM_IDS.indexOf(route.realmId) }, departedAt.toISOString());
      if (coverage.source.genesisHash !== term.snapshot.source.genesisHash || coverage.source.programId !== term.snapshot.source.programId)
        throw new ExpeditionRealmAccessError('SOURCE');
    }
    const returnsAt = new Date(departedAt.getTime() + route.durationSec * 1_000);
    if (!Number.isFinite(returnsAt.getTime())) throw new Error('Starter return timestamp overflow');
    const [inserted] = await tx.insert(starterExpeditions).values({ ...cmd, actorWallet: wallet, homeEvidence: home,
      routeSnapshot: route, termId: term.snapshot.termId, termHash: term.hash, finality: checked.finality,
      resourceId: route.resourceId, gross: BigInt(route.grossQuantity), net: BigInt(route.netQuantity), tax: BigInt(route.islandPoolQuantity),
      departedAt, returnsAt }).onConflictDoNothing().returning({ id: starterExpeditions.id });
    if (!inserted) {
      // Same-actor retries serialize before any mutable work. A later key
      // collision must roll back incidental home/term writes, never commit them.
      throw conflict();
    }
    await tx.insert(starterExpeditionInflight).values({ installationId: cmd.installationId, expeditionId: cmd.id });
    if(cmd.fitting)assertOrdinaryCraftingStartsEnabled();
    if(cmd.fitting)await reserveOrdinaryEquipment(tx,'starter',cmd.id,cmd.baseId,route.fitting!);
    if(route.secondaryOutput)await createEquipmentSecondary(tx,'starter',cmd.id);
    const accepted = await readStarterExpedition(tx, cmd.id);
    if (!accepted) throw new Error('Starter acceptance was not persisted');
    if(cmd.fitting){assertOrdinaryCraftingStartsEnabled();await context.assertAuthority(tx,wallet,cmd.baseId);assertOrdinaryCraftingStartsEnabled();}
    return { created: true, expedition: accepted };
  });
}
