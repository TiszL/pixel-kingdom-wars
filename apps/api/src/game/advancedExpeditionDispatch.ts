import {createEquipmentSecondary,readEquipmentSecondary} from './ordinaryEquipmentSecondary';
import {assertOrdinaryCraftingStartsEnabled} from './ordinaryCrafting';
import {EquipmentFittingSchema,applyEquipmentFitting,fittingSelection} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {reserveOrdinaryEquipment,assertEquipmentReservation} from './ordinaryEquipment';
/** Internal D-153.134 advanced admission. No route/worker/fixture fallback. A real
 * finalized reader is required; every new source is captured under base locks. */
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import {advancedExpeditionPreview,AdvancedExpeditionSnapshotSchema,AdvancedExpeditionRouteIdSchema} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {PHASE_E_VEHICLES} from '@shardkeep/shared';
import {phaseEVehiclesEnabled} from '../config';
import {randomUUID} from 'node:crypto';
import {ExpeditionRealmAccessObservationSchema} from '@shardkeep/shared/paidStarterExpeditions';

import {eq,sql} from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import {players} from '../db/schema';
import {advancedExpeditions,advancedExpeditionInflight,advancedExpeditionSupplies} from './advancedExpeditionSchema';
import {reserveRawStock,consumeRawStockReservation,readResourceStockProof} from './resourceStock';
import { HttpError } from '../lib/errors';
import { assertExpeditionRealmAccessAtDeparture, ExpeditionRealmAccessError, type ExpeditionRealmAccessReader, type ExpeditionRealmAccessObservation } from './expeditionRealmAccess';
import { resolveExpeditionHome } from './expeditionHome';
import { parseExpeditionTermObservation, type ExpeditionTermReader } from './expeditionTerms';
import { pinObservedOperatingExpeditionTerm, readStoredExpeditionTerm } from './expeditionTermStore';
import { readCompletedLodge } from './starterExpeditionFacilities';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';
import {readLockedVehicleLifecycle} from './vehicleLifecycle';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const routeId = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/);
const version = z.number().int().positive().max(2_147_483_647);
export const AdvancedExpeditionCommandSchema = z.object({ id: uuid, baseId: uuid, installationId: uuid,
  routeId, policyVersion: version, fitting: EquipmentFittingSchema.optional() }).strict();
export type AdvancedExpeditionCommand = z.infer<typeof AdvancedExpeditionCommandSchema>;
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
const historicalRoute = AdvancedExpeditionSnapshotSchema;
type Row = typeof advancedExpeditions.$inferSelect;
export type AcceptedAdvancedExpedition = Omit<Row, 'homeEvidence' | 'routeSnapshot' | 'finality'> & {
  homeEvidence: z.infer<typeof historicalHome>; routeSnapshot: z.infer<typeof historicalRoute>;
  finality: ReturnType<typeof parseExpeditionTermObservation>['finality'];
};

/** Private historical integrity only. Public adapters must separately bind the
 * authenticated original actor and exact command. No current stock is read. */
export async function readAdvancedExpedition(db: DbOrTx, id: string): Promise<AcceptedAdvancedExpedition | null> {
  const [row] = await db.select().from(advancedExpeditions).where(eq(advancedExpeditions.id, uuid.parse(id)));
  if (!row) return null;
  const homeEvidence = historicalHome.parse(row.homeEvidence), routeSnapshot = historicalRoute.parse(row.routeSnapshot);
  const term = await readStoredExpeditionTerm(db, row.termId, row.termHash);
  if (!term) throw new Error('Accepted advanced expedition lacks original term');
  const { finality } = parseExpeditionTermObservation({ snapshot: term.snapshot, finality: row.finality }, row.departedAt.toISOString());
  if (homeEvidence.baseId !== row.baseId || homeEvidence.custodyWallet !== row.actorWallet
    || (routeSnapshot.accessRequirement==='home' && routeSnapshot.realmId !== homeEvidence.realmId) || routeSnapshot.routeId !== row.routeId
    || routeSnapshot.policyVersion !== row.policyVersion
    || routeSnapshot.resourceId !== row.resourceId || BigInt(routeSnapshot.grossQuantity) !== row.gross
    || BigInt(routeSnapshot.netQuantity) !== row.net || BigInt(routeSnapshot.islandPoolQuantity) !== row.tax
    || row.net + row.tax !== row.gross
    || row.returnsAt.getTime() - row.departedAt.getTime() !== routeSnapshot.durationSec * 1_000) {
    throw new Error('Accepted advanced expedition differs from original evidence');
  }
  if(routeSnapshot.accessRequirement==='paid_realm'){
    const access=ExpeditionRealmAccessObservationSchema.parse(row.accessEvidence);
    if(access.wallet!==row.actorWallet||REALM_IDS[access.realm]!==routeSnapshot.realmId||Date.parse(access.finality.observedAt)>+row.departedAt||BigInt(access.finality.chainUnixTimestamp)*1000n>BigInt(+row.departedAt)||BigInt(+row.departedAt)>=BigInt(access.expiresAt)*1000n||access.source.genesisHash!==term.snapshot.source.genesisHash||access.source.programId!==term.snapshot.source.programId)throw Error('Advanced original access differs');
  }else if(row.accessEvidence!==null)throw Error('Unexpected advanced access');
  const supplies=await db.select().from(advancedExpeditionSupplies).where(eq(advancedExpeditionSupplies.expeditionId,row.id));
  if(supplies.length!==routeSnapshot.supplies.length)throw Error('Advanced supplies incomplete');
  for(const supply of routeSnapshot.supplies){const ids=supplies.find(s=>s.resourceId===supply.resourceId);if(!ids)throw Error('Advanced supply missing');const reserve=await readResourceStockProof(db,ids.reserveId),consume=await readResourceStockProof(db,ids.consumeId);
   if(!reserve||!consume||reserve.operation.kind!=='reserve'||consume.operation.kind!=='consume'||consume.operation.reservationId!==reserve.operation.id||reserve.operation.baseId!==row.baseId||reserve.operation.custodyWallet!==row.actorWallet||reserve.operation.resourceId!==supply.resourceId||reserve.operation.quantity!==BigInt(supply.quantity))throw Error('Advanced supply mismatch');}
  if(routeSnapshot.fitting)await assertEquipmentReservation(db,'advanced',row.id,row.baseId,routeSnapshot.fitting);
  const secondary=await readEquipmentSecondary(db,'advanced',row.id,routeSnapshot.secondaryOutput);if(secondary&&(secondary.base_id!==row.baseId||secondary.term_id!==row.termId||secondary.term_hash!==row.termHash))throw Error('Companion source differs from original trip');
  return { ...row, homeEvidence, routeSnapshot, finality };
}
const conflict = () => new HttpError(409, 'Expedition key belongs to a different original command', 'IDEMPOTENCY_BODY_MISMATCH');
export function matchAdvancedExpeditionCommand(row: AcceptedAdvancedExpedition, wallet: string, cmd: AdvancedExpeditionCommand) {
  if (JSON.stringify(fittingSelection(row.routeSnapshot).fitting)!==JSON.stringify(cmd.fitting) || row.actorWallet !== wallet || row.baseId !== cmd.baseId || row.installationId !== cmd.installationId
    || row.routeId !== cmd.routeId || row.policyVersion !== cmd.policyVersion) throw conflict();
  return row;
}
/** Check actor before loading private original term/home evidence. */
export async function readOwnedAdvancedExpedition(db: DbOrTx, wallet: string, id: string, mutation = false) {
  const [identity] = await db.select({ actor: advancedExpeditions.actorWallet }).from(advancedExpeditions).where(eq(advancedExpeditions.id, uuid.parse(id)));
  if (!identity) return null;
  if (identity.actor !== wallet) { if (mutation) throw conflict(); return null; }
  const proof = await readAdvancedExpedition(db, id);
  if (!proof) throw new Error('Original expedition disappeared');
  return proof;
}
export interface AdvancedExpeditionDependencies {
  /** Server wiring only; never sourced from JSON or public configuration. */
  reader?: ExpeditionTermReader;
  /** Authentic single-use finalized access capability, prefetched before locks. */
  readCoverage?: ExpeditionRealmAccessReader['readCoverage'];
  clock?: () => Date;
  /** Additional trusted restriction; the mandatory Phase E gate always applies. */
  assertAdmission?: () => void;
}
export async function dispatchAdvancedExpedition(
  db: Db, wallet: string, command: AdvancedExpeditionCommand, authority: StableBaseMutationContext,
  deps: AdvancedExpeditionDependencies = {},
): Promise<AcceptedAdvancedExpedition> {
  return (await dispatchAdvancedExpeditionCommitted(db, wallet, command, authority, deps)).expedition;
}

/** Both recovery branches are non-fresh. A new result resolves only after the
 * owning transaction commits; the existing accepted-row API remains unchanged. */
export async function dispatchAdvancedExpeditionCommitted(
  db: Db, wallet: string, command: AdvancedExpeditionCommand, authority: StableBaseMutationContext,
  deps: AdvancedExpeditionDependencies = {},
): Promise<{ created: boolean; expedition: AcceptedAdvancedExpedition }> {
  deps={...deps};authority={...authority};
  if('rollback'in db)throw Error('Advanced dispatch requires top-level DB');
  const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='advanced_expeditions'::regclass) allowed`);if(!owner?.allowed)throw new HttpError(503,'Owner capability required','ADVANCED_OWNER');
  const cmd = AdvancedExpeditionCommandSchema.parse(command),gate=()=>{deps.assertAdmission?.();if(!phaseEVehiclesEnabled())throw new HttpError(503,'Advanced departures paused','ADVANCED_DISABLED');};
  const old = await readOwnedAdvancedExpedition(db, wallet, cmd.id, true);
  if (old) return { created: false, expedition: matchAdvancedExpeditionCommand(old, wallet, cmd) };
  return (db as Db).transaction(async tx => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const prior = await readOwnedAdvancedExpedition(tx, wallet, cmd.id, true);
    if (prior) return { created: false, expedition: matchAdvancedExpeditionCommand(prior, wallet, cmd) };
    gate();
    if (uuid.parse(authority.baseId) !== cmd.baseId) throw conflict();
    if(cmd.fitting)assertOrdinaryCraftingStartsEnabled();
    const context = { ...authority, baseId: cmd.baseId };
    await lockStablePrerequisiteBase(tx, wallet, context);
    gate();
    const home = await resolveExpeditionHome(tx, wallet, context);
    const installation=await readLockedVehicleLifecycle(tx,cmd.installationId);
    if(!installation||installation.baseId!==cmd.baseId)throw new HttpError(409,'Advanced installation unavailable','ADVANCED_INSTALLATION');
    if(installation.pendingIntentId!==null)throw new HttpError(409,'Advanced vehicle service pending','VEHICLE_SERVICE_RESERVED');
    const [flight]=await tx.select().from(advancedExpeditionInflight).where(eq(advancedExpeditionInflight.baseId,cmd.baseId));if(flight||installation.away)throw new HttpError(409,'Advanced vehicle already away','ADVANCED_INFLIGHT');
    if(installation.completedTotal-installation.allowanceStart>=BigInt(PHASE_E_VEHICLES.completedUsesPerInstall))throw new HttpError(409,'Advanced vehicle exhausted','ADVANCED_EXHAUSTED');
    const lodgeCompletedAt = await readCompletedLodge(tx, cmd.baseId);
    if (!lodgeCompletedAt) throw new HttpError(409, 'A completed Lodge on this base is required', 'EXPEDITION_LODGE_UNAVAILABLE');
    const clock = deps.clock ?? (() => new Date());
    const beforeTermLock = new Date(clock().getTime());
    if (!Number.isFinite(beforeTermLock.getTime()) || lodgeCompletedAt > beforeTermLock || new Date(installation.berthCompletedAt) > beforeTermLock)
      throw new Error('Advanced facilities are not complete at dispatch');
    const preview=advancedExpeditionPreview({family:installation.family,tier:installation.tier,homeRealmId:home.realmId,routeId:AdvancedExpeditionRouteIdSchema.parse(cmd.routeId)},cmd.policyVersion);
    let coverage: ExpeditionRealmAccessObservation | undefined;
    if (preview.accessRequirement==='paid_realm') {
      if (!deps.readCoverage) throw new ExpeditionRealmAccessError('UNAVAILABLE');
      coverage = await deps.readCoverage(beforeTermLock.toISOString());
      assertExpeditionRealmAccessAtDeparture(coverage, { wallet, realm: REALM_IDS.indexOf(preview.realmId) }, beforeTermLock.toISOString());
    }
    const route=historicalRoute.parse(applyEquipmentFitting(preview,cmd.fitting));
    for(const supply of route.supplies)await tx.execute(sql`select base_id from resource_stocks where base_id=${cmd.baseId} and resource_id=${supply.resourceId} for update`);
    const term = await pinObservedOperatingExpeditionTerm(tx, beforeTermLock, deps.reader);
    // Pinning can wait on its source advisory lock. The original single-use
    // observation is not permission to depart at that earlier time: revalidate
    // it and the live gate after the final wait without consuming another read.
    const departedAt = new Date(clock().getTime());
    gate();
    if (!Number.isFinite(departedAt.getTime()) || lodgeCompletedAt > departedAt || new Date(installation.berthCompletedAt) > departedAt)
      throw new Error('Advanced facilities are not complete at dispatch');
    const checked = parseExpeditionTermObservation({ snapshot: term.snapshot, finality: term.finality }, departedAt.toISOString());
    if (departedAt.getTime() - Date.parse(checked.finality.observedAt) > PHASE_E_SEEKER_AUCTION.observationMaxAgeMs)
      throw new Error('Advanced expedition term observation is stale');
    if (coverage) {
      assertExpeditionRealmAccessAtDeparture(coverage, { wallet, realm: REALM_IDS.indexOf(route.realmId) }, departedAt.toISOString());
      if (coverage.source.genesisHash !== term.snapshot.source.genesisHash || coverage.source.programId !== term.snapshot.source.programId)
        throw new ExpeditionRealmAccessError('SOURCE');
    }
    const returnsAt = new Date(departedAt.getTime() + route.durationSec * 1_000);
    if (!Number.isFinite(returnsAt.getTime())) throw new Error('Advanced return timestamp overflow');
    const [inserted] = await tx.insert(advancedExpeditions).values({ ...cmd, actorWallet: wallet, homeEvidence: home, accessEvidence:coverage??null,
      routeSnapshot: route, termId: term.snapshot.termId, termHash: term.hash, finality: checked.finality,
      resourceId: route.resourceId, gross: BigInt(route.grossQuantity), net: BigInt(route.netQuantity), tax: BigInt(route.islandPoolQuantity),
      departedAt, returnsAt }).onConflictDoNothing().returning({ id: advancedExpeditions.id });
    if (!inserted) {
      // Same-actor retries serialize before any mutable work. A later key
      // collision must roll back incidental home/term writes, never commit them.
      throw conflict();
    }
    await tx.insert(advancedExpeditionInflight).values({ installationId: cmd.installationId, expeditionId: cmd.id,baseId:cmd.baseId });
    for(const supply of route.supplies){const reserveId=randomUUID(),consumeId=randomUUID();await reserveRawStock(tx,wallet,{operationId:reserveId,baseId:cmd.baseId,resourceId:supply.resourceId,quantity:BigInt(supply.quantity)},context);await consumeRawStockReservation(tx,consumeId,reserveId);await tx.insert(advancedExpeditionSupplies).values({expeditionId:cmd.id,resourceId:supply.resourceId,reserveId,consumeId});}
    gate();await context.assertAuthority(tx,wallet,cmd.baseId);
    if(cmd.fitting)assertOrdinaryCraftingStartsEnabled();
    if(cmd.fitting)await reserveOrdinaryEquipment(tx,'advanced',cmd.id,cmd.baseId,route.fitting!);
    if(route.secondaryOutput)await createEquipmentSecondary(tx,'advanced',cmd.id);
    const accepted = await readAdvancedExpedition(tx, cmd.id);
    if (!accepted) throw new Error('Advanced acceptance was not persisted');
    gate();
    if(cmd.fitting){assertOrdinaryCraftingStartsEnabled();await context.assertAuthority(tx,wallet,cmd.baseId);assertOrdinaryCraftingStartsEnabled();}
    return { created: true, expedition: accepted };
  });
}
