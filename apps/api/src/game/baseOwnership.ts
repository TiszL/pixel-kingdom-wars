/** Stable multi-base identity and finalized deed authority.
 *
 * Wallet-owned state never appears here. Callers resolve/lock a base explicitly,
 * then scope base-owned rows by its id. Legacy omission is accepted only while
 * exactly one active base exists, so two devices cannot share a global selector.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  getFinalizedCoreAssetOwnerBatch, getFinalizedCoreAssetOwners,
  type FinalizedAssetOwnership, type FinalizedAssetOwnershipBatch,
} from '@shardkeep/chain';
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  baseRaidLocks, bases, baseSlots, deedOwnershipObservations, players, plotReservations,
  baseTransfers, plots, raids,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { fantasyWorldEnabled } from '../config';
import { activateHeldFantasyLocation, getFantasyClaim } from './fantasyLocation';
import { fantasyPresentationActive, resolveFantasyLocation } from './fantasyLocationRead';
import { invalidateGlobe } from '../lib/globeCache';
import { invalidateValley } from '../lib/mapCache';
import { ownershipEligible } from './baseTransfer';
import {
  reanchorBaseMineAccrual, rescheduleBaseMineFullChecks,
} from './baseMining';
import { capturePhysicalMineCustodyBoundary } from '../mining/shardsTaxMineSources';
import { reanchorMineAccrual } from './emission';
import { completeDueJobs } from './base';
import { settleDueStarterExpeditions } from './starterExpeditionReturns';
import { settleAdvancedExpeditionsAtBoundary } from './advancedExpeditionReturns';
import { settleDueOrdinaryCrafting } from './ordinaryCrafting';
import { closeHarvesterSources, recordHarvesterCustodyStop } from './harvesterSettlement';
import type { EarthParcelIdentity } from './world';

/** Custody events sample after the base lock; chain observations keep their
 * own timestamp and must not become fresh merely because a lock took time. */
function custodyEventTime(clock: () => Date): Date {
  const at = clock();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new TypeError('Invalid custody event clock');
  return new Date(at.getTime());
}

/** Server-only receive time, not a client timestamp or renewed RPC lease. */
export type ObservedDeedOwnership = Readonly<FinalizedAssetOwnership & { observedAtMs: number }>;
export function observeDeedOwnership(proof: FinalizedAssetOwnership, observedAtMs: number): ObservedDeedOwnership {
  return Object.freeze({ owner: proof.owner, collection: proof.collection, frozen: proof.frozen,
    delegate: proof.delegate, slot: proof.slot, observedAtMs });
}
export function deedProofIsFresh(proof: ObservedDeedOwnership, admittedAt: Date): boolean {
  const age = admittedAt.getTime() - proof.observedAtMs;
  return Number.isSafeInteger(proof.observedAtMs) && Number.isSafeInteger(admittedAt.getTime())
    && age >= 0 && age <= BASE_OWNERSHIP.mutationFreshnessMs;
}

export interface FinalizedDeedReader {
  (assetId: string, minContextSlot?: number): Promise<FinalizedAssetOwnership | null>;
  readMany?: (
    assets: readonly { assetId: string; minContextSlot?: number | undefined }[],
  ) => Promise<Map<string, FinalizedAssetOwnership | null>>;
  readBatch?: (
    assets: readonly { assetId: string; minContextSlot?: number | undefined }[],
  ) => Promise<FinalizedAssetOwnershipBatch>;
}

export type LockedBaseAuthority = (
  tx: DbTx, wallet: string, baseId: string,
) => Promise<void>;

export async function invalidateBaseWorldCaches(db: Db, baseId: string): Promise<void> {
  const [plot] = await db.select({ valleyId: plots.valleyId }).from(plots).where(eq(plots.baseId, baseId));
  if (plot?.valleyId) invalidateValley(plot.valleyId);
  invalidateGlobe();
}

/** The base row is the serialization root for every stable raid create and deed
 * transfer. Reading the raid state while that row is held therefore closes the
 * create-vs-sale race without taking raid rows in the inverse settlement order. */
async function unresolvedOutgoingRaidId(
  db: DbOrTx, baseId: string,
): Promise<string | null> {
  const [outgoing] = await db.select({ id: raids.id }).from(raids).where(and(
    eq(raids.attackerBaseId, baseId),
    inArray(raids.status, ['pending_orders', 'resolving']),
  )).limit(1);
  return outgoing?.id ?? null;
}

/** Why a finalized ownership refresh produced no usable answer. The transport
 * classes (`queue-timeout`, `rpc-error`) say nothing about the deed. A
 * `null-read` may be a POSITIVE absence (burned, foreign or malformed asset), so
 * only the transport classes may leave a still-live proof in place. */
export type DeedAuthorityUnavailableReason =
  'queue-timeout' | 'rpc-error' | 'null-read' | 'stale-floor' | 'stale-observation' | 'row-changed';

/** A finalized read that never obtained an answer from the chain. Thrown (not
 * returned as null) so the refresh can tell "no answer" from "answered: no
 * eligible asset" and record which one it was. */
export class DeedReadUnavailableError extends Error {
  constructor(readonly reason: 'queue-timeout' | 'rpc-error') {
    super(`finalized deed read unavailable: ${reason}`);
    this.name = 'DeedReadUnavailableError';
  }
}

/** One structured line per refusal/unavailable refresh. The 2026-09-18 incident
 * (two false 503s for legitimate owners) could not be attributed because the
 * reason was swallowed. Never log wallets, signatures or RPC URLs here. */
function warnDeedAuthority(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: 40, event, ...fields }));
}

export function makeFinalizedDeedReader(opts: {
  rpcUrl?: string | undefined; deedCollection?: string | undefined;
}): FinalizedDeedReader | null {
  if (!opts.rpcUrl || !opts.deedCollection) return null;
  const inFlight = new Map<string, Promise<FinalizedAssetOwnership | null>>();
  let nextForegroundStartAt = 0;
  let foregroundFifo: Promise<void> = Promise.resolve();
  const acquireForegroundStart = (deadline: number): Promise<boolean> => {
    const turn = foregroundFifo.then(async () => {
      const delayMs = Math.max(0, nextForegroundStartAt - Date.now());
      if (Date.now() + delayMs > deadline) return false;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      nextForegroundStartAt = Date.now() + BASE_OWNERSHIP.foregroundReadStartIntervalMs;
      return true;
    });
    // A declined or failed turn must never poison later FIFO entrants.
    foregroundFifo = turn.then(() => undefined, () => undefined);
    return turn;
  };
  const reader: FinalizedDeedReader = (assetId, minContextSlot) => {
    // The exact floor is part of the key: sharing a weaker read with a caller
    // that requires a newer context would silently violate monotonic evidence.
    const key = `${assetId}\0${minContextSlot ?? ''}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = (async () => {
      // ONE deadline bounds the logical read, retry included: a retry is just
      // another paced FIFO start, so it can neither burst the shared RPC key nor
      // extend the worst case beyond queue deadline + one bounded read.
      const deadline = Date.now() + BASE_OWNERSHIP.foregroundReadQueueTimeoutMs;
      for (let attempt = 0; ; attempt++) {
        if (!await acquireForegroundStart(deadline)) {
          throw new DeedReadUnavailableError(attempt === 0 ? 'queue-timeout' : 'rpc-error');
        }
        // Same single getMultipleAccounts transport as getFinalizedCoreAssetOwner
        // (asset + collection at one context), but it also reports whether the
        // chain ANSWERED. Only a transport failure is retried; an answer —
        // owner, another owner, delegated/frozen, or no eligible asset — is
        // final for this read and is never retried into a different answer.
        const batch = await getFinalizedCoreAssetOwnerBatch({
          rpcUrl: opts.rpcUrl!, assets: [{ assetId, minContextSlot }],
          expectedCollection: opts.deedCollection!,
        });
        if (batch.transportSucceeded) return batch.owners.get(assetId) ?? null;
        if (attempt >= BASE_OWNERSHIP.foregroundReadTransportRetries) {
          throw new DeedReadUnavailableError('rpc-error');
        }
      }
    })();
    inFlight.set(key, pending);
    void pending.finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }).catch(() => undefined);
    return pending;
  };
  reader.readMany = (assets) => getFinalizedCoreAssetOwners({
    rpcUrl: opts.rpcUrl!, assets, expectedCollection: opts.deedCollection!,
  });
  reader.readBatch = (assets) => getFinalizedCoreAssetOwnerBatch({
    rpcUrl: opts.rpcUrl!, assets, expectedCollection: opts.deedCollection!,
  });
  return reader;
}

/** Repoint wallet-keyed compatibility shadows after stable ownership changes.
 * Callers already hold both player locks and the transferred base lock. */
async function reconcileTransferredPlayerScalars(tx: DbTx, from: string, to: string): Promise<void> {
  const sellerRemaining = await tx.select().from(bases)
    .where(eq(bases.ownerWallet, from)).orderBy(asc(bases.createdAt)).limit(2);
  const sellerCompat = sellerRemaining.find((candidate) => candidate.deedAssetId) ?? sellerRemaining[0];
  await tx.update(players).set({
    deedAssetId: sellerCompat?.deedAssetId ?? null,
    deedMintAssetId: sellerCompat?.deedMintAssetId ?? sellerCompat?.deedAssetId ?? null,
    deedMintingAt: sellerCompat?.deedMintingAt ?? null,
    ...(sellerRemaining.length === 0 ? { entryPaidAt: null } : {}),
    ...(sellerRemaining.length === 1 ? {
      entryPaidAt: sellerCompat?.landPaidAt ?? null,
      keepLevel: sellerCompat!.keepLevel,
      builders: sellerCompat!.builders,
      expansions: sellerCompat!.expansions,
    } : {}),
  }).where(eq(players.wallet, from));
  const buyerOwned = await tx.select().from(bases)
    .where(eq(bases.ownerWallet, to)).orderBy(asc(bases.createdAt)).limit(2);
  const [buyerPlayer] = await tx.select({ deedAssetId: players.deedAssetId }).from(players)
    .where(eq(players.wallet, to));
  const buyerCompat = buyerOwned.find((candidate) => candidate.deedAssetId) ?? buyerOwned[0];
  // A buyer that already owns multiple bases and already has a compatibility
  // deed pointer needs no scalar rewrite. Drizzle rejects `.set({})`, so do
  // not let that harmless state abort the authoritative base transfer.
  if ((!buyerPlayer?.deedAssetId && buyerCompat?.deedAssetId) || buyerOwned.length === 1) {
    await tx.update(players).set({
      ...(!buyerPlayer?.deedAssetId && buyerCompat?.deedAssetId
        ? {
          deedAssetId: buyerCompat.deedAssetId,
          deedMintAssetId: buyerCompat.deedMintAssetId ?? buyerCompat.deedAssetId,
          deedMintingAt: buyerCompat.deedMintingAt,
        }
        : {}),
      ...(buyerOwned.length === 1 ? {
        entryPaidAt: buyerCompat?.landPaidAt ?? null,
        keepLevel: buyerCompat!.keepLevel,
        builders: buyerCompat!.builders,
        expansions: buyerCompat!.expansions,
      } : {}),
    }).where(eq(players.wallet, to));
  }
}

/** Materialize a stable identity for legacy rows or an explicitly authorized
 * first stable read. The default preserves read-only callers that must not
 * create a base for an otherwise empty wallet. */
export async function ensureWalletBaseIdentity(
  db: Db, wallet: string, options: { createEmpty?: boolean } = {},
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, wallet)).orderBy(asc(bases.createdAt)).limit(2);
    if (existing.length > 0) return existing.length === 1 ? existing[0]!.id : null;
    const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!p) throw new HttpError(404, 'player not found');
    // The optimistic read above is only a fast path. A racing first GET may
    // have created the identity while this transaction waited for the player
    // lock, so the authority is this recheck under that lock.
    const raced = await tx.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, wallet)).orderBy(asc(bases.createdAt)).limit(2);
    if (raced.length > 0) return raced.length === 1 ? raced[0]!.id : null;
    const [sold] = await tx.select({ id: baseTransfers.id }).from(baseTransfers)
      .where(eq(baseTransfers.fromWallet, wallet)).limit(1);
    if (sold) {
      throw new HttpError(
        409, 'no base is owned by this wallet; acquire or activate a deed', 'BASE_NOT_OWNED',
      );
    }
    const hasState = await tx.execute(sql`
      select exists(select 1 from buildings where player_wallet=${wallet} and base_id is null)
          or exists(select 1 from obstacles where player_wallet=${wallet} and base_id is null) as present
    `);
    const present = Boolean((hasState as unknown as Array<{ present: boolean }>)[0]?.present);
    if (!present && !p.entryPaidAt && !p.deedAssetId && !options.createEmpty) return null;
    const [base] = await tx.insert(bases).values({
      ownerWallet: wallet, deedAssetId: p.deedAssetId, keepLevel: p.keepLevel,
      deedMintAssetId: p.deedMintAssetId ?? p.deedAssetId,
      builders: p.builders, expansions: p.expansions, landPaidAt: p.entryPaidAt,
      deedMintingAt: p.deedMintingAt,
    }).returning({ id: bases.id });
    await tx.insert(baseSlots).values({ wallet, slot: 1, baseId: base!.id, selectedAt: new Date() });
    await tx.execute(sql`update buildings set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update obstacles set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update builder_jobs set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update layouts set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update shields set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    await tx.execute(sql`update plots set base_id=${base!.id} where player_wallet=${wallet} and base_id is null`);
    return base!.id;
  });
}

export async function listWalletBases(db: DbOrTx, wallet: string, fantasyScope?: boolean) {
  const fantasy = fantasyScope ?? await fantasyPresentationActive(db);
  const rows = await db.select({
    id: bases.id, deedAssetId: bases.deedAssetId, status: bases.status,
    keepLevel: bases.keepLevel, builders: bases.builders, expansions: bases.expansions,
    landPaidAt: bases.landPaidAt, slot: baseSlots.slot,
    earthCell: plots.earthCell, countryA3: plots.countryA3,
  }).from(bases)
    .leftJoin(baseSlots, and(eq(baseSlots.baseId, bases.id), eq(baseSlots.wallet, wallet)))
    .leftJoin(plots, eq(plots.baseId, bases.id))
    // An unpaid, inactive base created solely to anchor a land reservation is
    // intentionally hidden until payment. The deposit response is the durable
    // pre-signing identity; the ordinary base picker must not expose a ghost.
    .where(and(
      eq(bases.ownerWallet, wallet),
      or(
        isNotNull(baseSlots.slot), isNotNull(bases.landPaidAt),
        isNotNull(bases.deedAssetId), isNotNull(plots.id),
      ),
    )).orderBy(asc(baseSlots.slot), asc(bases.createdAt));
  return Promise.all(rows.map(async (row) => ({
    ...row,
    // Historical Earth bindings remain private during a paused/flag-off
    // fantasy release too. Held locations do not appear as owned parcels.
    earthCell: fantasy ? null : row.earthCell,
    countryA3: fantasy ? null : row.countryA3,
    fantasyLocation: fantasy ? await resolveFantasyLocation(db, row.id) : null,
  })));
}

/** Resolve the active base named by a read without taking mutation locks.
 * Omission remains backward-compatible for a single active base, but can never
 * silently turn device slot order into a server-global selection once a wallet
 * has several. A wallet with no active base is a legitimate read-only globe
 * viewer, so the omitted form returns null; naming a missing/inactive base is an
 * authority error. */
export async function resolveActiveBase(
  db: DbOrTx, wallet: string, requestedBaseId?: string,
) {
  const rows = await db.select({ base: bases, slot: baseSlots.slot }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
      eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      ...(requestedBaseId ? [eq(bases.id, requestedBaseId)] : []),
    )).orderBy(asc(baseSlots.slot));
  if (requestedBaseId && rows.length === 0) {
    throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  }
  if (!requestedBaseId && rows.length > 1) {
    throw new HttpError(409, 'baseId is required when multiple active bases exist', 'BASE_ID_REQUIRED');
  }
  return rows[0] ?? null;
}

/** Presentation-level current-land fact used by auth responses in stable mode.
 * This deliberately follows the active base/slot ownership boundary instead of
 * the lossy players.entryPaidAt compatibility shadow. Privileged actions still
 * perform their own finalized deed-authority checks. */
export async function hasActivePaidStableBase(db: DbOrTx, wallet: string): Promise<boolean> {
  const [paid] = await db.select({ id: bases.id }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
      eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      isNotNull(bases.landPaidAt),
    )).limit(1);
  return paid !== undefined;
}

/** Resolve and row-lock the active base a quote/mutation is bound to. */
export async function lockActiveBase(tx: DbTx, wallet: string, requestedBaseId?: string) {
  // Canonical order used by activation, transfer and ownership refresh. Money
  // callers can safely invoke this without accidentally taking base→player.
  await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
  const rows = await tx.select({ base: bases, slot: baseSlots.slot }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active'),
      ...(requestedBaseId ? [eq(bases.id, requestedBaseId)] : []),
    )).orderBy(asc(baseSlots.slot)).for('update');
  if (requestedBaseId && rows.length === 0) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  if (!requestedBaseId && rows.length !== 1) {
    throw new HttpError(409, 'baseId is required when multiple active bases exist', 'BASE_ID_REQUIRED');
  }
  return rows[0]!;
}

export function observationHash(
  assetId: string, owner: string | null, status: string, slot: bigint | null, checkedAt: Date,
): string {
  return createHash('sha256')
    .update(`${assetId}\0${owner ?? ''}\0${status}\0${slot?.toString() ?? ''}\0${checkedAt.toISOString()}`)
    .digest('hex');
}

/** A finalized bank cannot name different owners at the same context slot.
 * After an outage erased the observed owner, a strictly newer bank is needed. */
export function deedProofMeetsFloor(
  prior: { slot: bigint | null; owner: string | null } | undefined,
  slot: bigint, owner: string | null,
): boolean {
  return prior?.slot == null || slot > prior.slot
    || (slot === prior.slot && owner !== null && owner === prior.owner);
}

/** Journal an external custody fact separately from delivery/reconciliation.
 * Caller holds every involved player in sorted order. This transaction changes
 * neither balances nor custody nor claim receipts. A later overflow, refused
 * raid-time move or cancelled claim cannot erase an already known earning stop.
 * A changed/stale fact is left to the normal reconciliation refusal path.
 */
export async function recordFinalizedHarvesterLossLocked(
  tx: DbTx, baseId: string, from: string, to: string, assetId: string,
  proof: ObservedDeedOwnership, clock: () => Date,
): Promise<boolean> {
  if (from === to) return false;
  const [base] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
  if (!base || base.ownerWallet !== from
    || (base.deedAssetId !== assetId && !(base.deedAssetId === null && base.deedMintAssetId === assetId && base.landPaidAt))) return false;
  const at = custodyEventTime(clock);
  const [prior] = await tx.select().from(deedOwnershipObservations)
    .where(eq(deedOwnershipObservations.baseId, baseId)).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
  if (!deedProofIsFresh(proof, at) || proof.owner !== to || !ownershipEligible(proof, null)
    || !Number.isSafeInteger(proof.slot) || proof.slot < 0
    || !deedProofMeetsFloor(prior, BigInt(proof.slot), proof.owner)) return false;
  // Keep the original receive time/slot. "mismatch" describes the still-current
  // DB custodian; it does not pretend that the buyer's claim already succeeded.
  const checkedAt = new Date(proof.observedAtMs);
  const evidence = { assetId, owner: to, slot: BigInt(proof.slot), checkedAt,
    source: 'harvester-custody-finalized', status: 'mismatch' as const,
    auditHash: observationHash(assetId, to, 'mismatch', BigInt(proof.slot), checkedAt) };
  if (prior) await tx.update(deedOwnershipObservations).set(evidence).where(eq(deedOwnershipObservations.id, prior.id));
  else await tx.insert(deedOwnershipObservations).values({ baseId, ...evidence });
  await recordHarvesterCustodyStop(tx, baseId, at);
  return true;
}

async function journalFinalizedHarvesterLoss(
  db: Db, baseId: string, from: string, to: string, assetId: string,
  proof: ObservedDeedOwnership, clock: () => Date,
) {
  return db.transaction(async tx => {
    await tx.insert(players).values({ wallet: to }).onConflictDoNothing();
    await tx.select({ wallet: players.wallet }).from(players)
      .where(inArray(players.wallet, [...new Set([from, to])])).orderBy(asc(players.wallet)).for('update');
    return recordFinalizedHarvesterLossLocked(tx, baseId, from, to, assetId, proof, clock);
  });
}

/** Refresh chain authority and persist/deactivate in one locked apply step. */
export async function refreshBaseOwnership(
  db: Db, baseId: string, reader: FinalizedDeedReader | null, expectedCollection: string | null,
  now = new Date(), source = 'mutation',
  eventClock: () => Date = () => new Date(),
): Promise<'owned' | 'mismatch' | 'ineligible' | 'unavailable'> {
  now = new Date(now.getTime());
  const [before] = await db.select().from(bases).where(eq(bases.id, baseId));
  if (!before) throw new HttpError(404, 'base not found');
  if (!before.deedAssetId) return 'owned';
  const [lastAccepted] = await db.select({ slot: deedOwnershipObservations.slot })
    .from(deedOwnershipObservations)
    .where(and(
      eq(deedOwnershipObservations.baseId, baseId),
      eq(deedOwnershipObservations.assetId, before.deedAssetId),
    )).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
  const floor = lastAccepted?.slot ?? null;
  const floorNumber = floor === null ? undefined : Number(floor);
  let observed: FinalizedAssetOwnership | null = null;
  // A plain null is "the chain answered and named no eligible asset" as far as
  // this function can know; only a thrown read is certainly answer-less.
  let unavailableReason: DeedAuthorityUnavailableReason = 'null-read';
  try {
    observed = reader && (floorNumber === undefined || Number.isSafeInteger(floorNumber))
      ? await reader(before.deedAssetId, floorNumber)
      : null;
  } catch (error) {
    observed = null;
    unavailableReason = error instanceof DeedReadUnavailableError ? error.reason : 'rpc-error';
  }
  const observedSlot = observed && Number.isSafeInteger(observed.slot) && observed.slot >= 0
    ? BigInt(observed.slot) : null;
  const status = !observed || observedSlot === null ? 'unavailable'
    : !ownershipEligible(observed, expectedCollection) ? 'ineligible'
      : observed.owner === before.ownerWallet ? 'owned' : 'mismatch';
  if (status === 'mismatch' && observed) {
    const journaled = await journalFinalizedHarvesterLoss(db, baseId, before.ownerWallet, observed.owner, before.deedAssetId,
      observeDeedOwnership(observed, now.getTime()), eventClock);
    if (!journaled) {
      warnDeedAuthority('deed_ownership_refresh_unavailable', { baseId, source, reason: 'stale-or-changed-custody-fact', preservedProof: true });
      return 'unavailable';
    }
  }
  let preservedProof = false;
  const applied = await db.transaction(async (tx) => {
    if (status === 'mismatch' && observed) {
      await tx.insert(players).values({ wallet: observed.owner }).onConflictDoNothing();
    }
    const lockWallets = status === 'mismatch' && observed
      ? [before.ownerWallet, observed.owner].sort()
      : [before.ownerWallet];
    await tx.select({ wallet: players.wallet }).from(players)
      .where(inArray(players.wallet, lockWallets)).orderBy(asc(players.wallet)).for('update');
    const [locked] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
    if (!locked || locked.deedAssetId !== before.deedAssetId || locked.ownerWallet !== before.ownerWallet) {
      unavailableReason = 'row-changed';
      return 'unavailable';
    }
    const [prior] = await tx.select({
      id: deedOwnershipObservations.id, slot: deedOwnershipObservations.slot,
      owner: deedOwnershipObservations.owner, status: deedOwnershipObservations.status,
      assetId: deedOwnershipObservations.assetId, checkedAt: deedOwnershipObservations.checkedAt,
    })
      .from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, baseId))
      .orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
    const stale = observedSlot !== null && !deedProofMeetsFloor(prior, observedSlot, observed?.owner ?? null);
    // A lower or contradictory context is not evidence: report unavailable,
    // but keep the last accepted observation byte-for-byte for auditability.
    if (stale) {
      unavailableReason = 'stale-floor';
      return 'unavailable';
    }
    // The journal and reconciliation can wait on different lock acquisitions.
    // Never accept a stale mismatch just because its first journal was fresh.
    const mismatchEventAt = status === 'mismatch' ? custodyEventTime(eventClock) : null;
    if (mismatchEventAt && observed && !deedProofIsFresh(observeDeedOwnership(observed, now.getTime()), mismatchEventAt)) {
      unavailableReason = 'stale-observation';
      return 'unavailable';
    }
    // An answer-less read (RPC error, rate limit, timeout, queue deadline) is
    // not evidence either way. It must not destroy a finalized `owned` proof
    // the ten-second policy still accepts: before 2026-09-18 one failed observer
    // wave or foreground read rewrote up to 32 live proofs as `unavailable`, so
    // every one of those owners then needed a foreground read against the same
    // sick RPC and was refused. The proof keeps its ORIGINAL checkedAt and
    // expires on schedule; this read still reports `unavailable`, and the
    // suppressed write is recorded by the log line below. A `null-read` may be a
    // positive absence (burned/foreign asset) and still overwrites.
    if (status === 'unavailable'
      && (unavailableReason === 'queue-timeout' || unavailableReason === 'rpc-error')
      && prior?.status === 'owned' && prior.slot !== null
      && prior.assetId === before.deedAssetId && prior.owner === before.ownerWallet
      && now.getTime() - prior.checkedAt.getTime() <= BASE_OWNERSHIP.mutationFreshnessMs) {
      preservedProof = true;
      return 'unavailable';
    }
    const appliedStatus = status;
    const appliedOwner = appliedStatus === 'unavailable' ? null : observed?.owner ?? null;
    // Unavailable responses must fail privileged actions without erasing the
    // monotonic floor established by the last accepted finalized observation.
    const appliedSlot = appliedStatus === 'unavailable'
      ? prior?.slot ?? observedSlot
      : observedSlot;
    const evidence = {
      assetId: before.deedAssetId!, owner: appliedOwner, slot: appliedSlot,
      checkedAt: now, source, status: appliedStatus,
      auditHash: observationHash(before.deedAssetId!, appliedOwner, appliedStatus, appliedSlot, now),
    } as const;
    // The base row lock serializes mutation refreshes and the sweep. Keep one
    // current observation row rather than appending one row per base per
    // observer sweep (17,280 rows/base/day at the 5-second poll cadence).
    if (prior) await tx.update(deedOwnershipObservations).set(evidence)
      .where(eq(deedOwnershipObservations.id, prior.id));
    else await tx.insert(deedOwnershipObservations).values({ baseId, ...evidence });
    // Only a positive finalized mismatch transfers/deactivates. RPC failure or
    // a transient delegate still fails privileged actions through the latest
    // observation, but cannot permanently evict a legitimate owner.
    if (appliedStatus === 'mismatch') {
      const eventAt = mismatchEventAt!;
      // Positive finalized ownership loss ends future production even when a
      // frozen outgoing raid defers the DB custody move. RPC failure does not.
      await closeHarvesterSources(tx, baseId, eventAt, 'custody_change');
      const mineCaptured = await capturePhysicalMineCustodyBoundary(tx, {
        baseId, recordedWallet: before.ownerWallet, observedWallet: observed!.owner,
        eventAt, observedAt: now, slot: observedSlot, source,
      });
      // A transfer initiated through SHARDKEEP is refused before the chain
      // conveyance while this base attacks. If an owner transfers externally,
      // retain the positive mismatch evidence (which fences further commands)
      // but defer the DB ownership root until the frozen raid is terminal. The
      // buyer then receives the honest post-battle deed state, never a base the
      // former owner can continue mutating.
      if (await unresolvedOutgoingRaidId(tx, baseId)) return appliedStatus;
      // Settle only this sold base while the exact seller/base locks still hold.
      // Due work belongs to the seller; not-yet-due jobs remain attached to the
      // stable base and complete for its eventual owner.
      await completeDueJobs(tx, before.ownerWallet, eventAt, baseId);
      await settleDueStarterExpeditions(tx, baseId, eventAt);
      await settleAdvancedExpeditionsAtBoundary(tx, baseId, eventAt);
      await settleDueOrdinaryCrafting(tx, baseId, eventAt);
      const [settledBase] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
      if (!settledBase) {
        unavailableReason = 'row-changed';
        return 'unavailable';
      }
      await reanchorMineAccrual(tx, before.ownerWallet, eventAt);
      await reanchorMineAccrual(tx, observed!.owner, eventAt);
      // The finalized observer is a second deed-transfer entrypoint beside
      // transferStableBaseInternal. Settle the physical Mine while the row
      // still names the seller, otherwise the buyer's live referral quota can
      // be applied retroactively to the seller's elapsed interval.
      if (!mineCaptured) await reanchorBaseMineAccrual(tx, baseId, eventAt);
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, baseId));
      if (observed) {
        await tx.update(bases).set({ ownerWallet: observed.owner, status: 'inactive', updatedAt: eventAt })
          .where(eq(bases.id, baseId));
        // The accrued buffer and notification cycle follow the physical Mine;
        // only its next full boundary changes under the buyer's quota inputs.
        await rescheduleBaseMineFullChecks(tx, baseId, eventAt);
        await reconcileTransferredPlayerScalars(tx, before.ownerWallet, observed.owner);
        await tx.insert(baseTransfers).values({
          deedAssetId: before.deedAssetId!, fromWallet: before.ownerWallet, toWallet: observed.owner,
          priorKeepLevel: settledBase.keepLevel, priorExpansions: settledBase.expansions,
          priorEntryPaidAt: settledBase.landPaidAt,
          buildingsMoved: 0, jobsMoved: 0, shieldsMoved: 0,
          createdAt: eventAt,
        });
      }
    }
    return appliedStatus;
  });
  if (applied === 'mismatch') await invalidateBaseWorldCaches(db, baseId);
  if (applied === 'unavailable') {
    warnDeedAuthority('deed_ownership_refresh_unavailable', {
      baseId, source, reason: unavailableReason, preservedProof,
    });
  }
  return applied;
}

/** Privileged actions accept cached evidence for at most ten seconds, otherwise
 * they synchronously refresh finalized Core state and fail closed. */
export async function assertFreshLockedBaseAuthority(
  db: DbOrTx, wallet: string, baseId: string, now = new Date(),
  opts: { allowInactive?: boolean } = {},
) {
  const [base] = await db.select().from(bases)
    .where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, wallet),
      ...(opts.allowInactive ? [] : [eq(bases.status, 'active')]),
    ))
    .for('update');
  if (!base) throw new HttpError(409, 'deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
  if (!base.deedAssetId && base.deedMintAssetId) {
    throw new HttpError(
      503,
      'deed mint is pending exact on-chain recovery; base authority is quarantined',
      'DEED_AUTHORITY_UNAVAILABLE',
    );
  }
  if (!base.deedAssetId) return base;
  const [latest] = await db.select().from(deedOwnershipObservations).where(and(
    eq(deedOwnershipObservations.baseId, baseId),
    eq(deedOwnershipObservations.assetId, base.deedAssetId),
  )).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1).for('update');
  const fresh = latest?.slot !== null && latest?.slot !== undefined
    && latest.status === 'owned' && latest.owner === wallet
    && now.getTime() - latest.checkedAt.getTime() <= BASE_OWNERSHIP.mutationFreshnessMs;
  if (!fresh) {
    warnDeedAuthority('deed_authority_refused', {
      gate: 'locked', baseId, status: latest?.status ?? 'none',
      ageMs: latest ? now.getTime() - latest.checkedAt.getTime() : null,
    });
    throw new HttpError(503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE');
  }
  return base;
}

/** Freeze the wallet's exact active extraction set and its accepted finalized
 * evidence inside the same transaction that credits mining/cache rewards.
 *
 * The player root serializes activation and transfer before we discover the
 * set. Bases, then slots, then observations are locked in stable base-id order,
 * matching the transfer-compatible player -> base -> slot -> evidence order.
 * No chain RPC is allowed here: the public route acquired evidence first and
 * this boundary only proves it is still positive and at most ten seconds old. */
export async function assertFreshLockedActiveBaseAuthorities(
  tx: DbTx, wallet: string, now = new Date(),
) {
  const [player] = await tx.select({ wallet: players.wallet }).from(players)
    .where(eq(players.wallet, wallet)).for('update');
  if (!player) throw new HttpError(404, 'player not found');

  // Reading the identity set after the player lock is safe: every supported
  // activation/transfer path takes that root before changing active slots.
  const discovered = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots)
    .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true)))
    .orderBy(asc(baseSlots.baseId));
  const ids = discovered.map((row) => row.baseId);
  if (ids.length === 0) return [];

  const lockedBases = await tx.select().from(bases)
    .where(inArray(bases.id, ids)).orderBy(asc(bases.id)).for('update');
  const lockedSlots = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots)
    .where(and(
      eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), inArray(baseSlots.baseId, ids),
    )).orderBy(asc(baseSlots.baseId)).for('update');
  if (lockedBases.length !== ids.length || lockedSlots.length !== ids.length
    || lockedBases.some((base, index) => base.id !== ids[index]
      || lockedSlots[index]?.baseId !== base.id
      || base.ownerWallet !== wallet || base.status !== 'active')) {
    throw new HttpError(409, 'active deed set changed', 'DEED_OWNERSHIP_CHANGED');
  }

  for (const base of lockedBases) {
    await assertFreshLockedBaseAuthority(tx, wallet, base.id, now);
  }
  // A five-deed loop can cross the freshness boundary while locking later
  // observations. Re-evaluate every already-locked proof at one final instant.
  const completedAt = new Date();
  for (const base of lockedBases) {
    await assertFreshLockedBaseAuthority(tx, wallet, base.id, completedAt);
  }
  return lockedBases;
}

/** Early gate renewals nobody is waiting for: at most one per base per process
 * (a client fires several gated requests at once; one read and one locked
 * apply serve them all). */
const gateRenewalsInFlight = new Map<string, Promise<void>>();

/** Renew a STILL-VALID proof without making the request wait for the chain.
 * The result lands on the observation row exactly as an awaited refresh would
 * (`owned` renews it, a finalized mismatch transfers/deactivates, an answer-less
 * read leaves the live proof untouched and is logged by refreshBaseOwnership).
 * The promise is abandoned by design, so it must never reject. */
function renewProofInBackground(
  db: Db, baseId: string, reader: FinalizedDeedReader | null,
  expectedCollection: string | null, now: Date,
): void {
  if (gateRenewalsInFlight.has(baseId)) return;
  const renewal = refreshBaseOwnership(db, baseId, reader, expectedCollection, now, 'gate-renewal')
    .then(() => undefined, (error: unknown) => {
      // Only an unexpected fault (database, vanished base) throws. Name and code
      // only: a driver message can quote SQL parameters, i.e. a wallet.
      const code = (error as { code?: unknown } | null)?.code;
      warnDeedAuthority('deed_gate_renewal_failed', {
        baseId, error: error instanceof Error ? error.name : typeof error,
        code: typeof code === 'string' ? code : null,
      });
    })
    .finally(() => { gateRenewalsInFlight.delete(baseId); });
  gateRenewalsInFlight.set(baseId, renewal);
}

export async function requireFreshBaseAuthority(
  db: Db, wallet: string, baseId: string, reader: FinalizedDeedReader | null,
  expectedCollection: string | null, now = new Date(),
) {
  // `now` is the caller's instant at entry. Every accept/refuse decision below
  // is measured at the REAL current instant (entry + elapsed): a pool wait or a
  // slow failed read must never let this gate accept a proof that has since
  // aged past the ten-second rule. Several routes rely on this gate ALONE (GET
  // /army, /army/previous, /heroes, /mine/status have no locked re-check).
  const enteredAtMs = Date.now();
  const realNow = () => new Date(now.getTime() + (Date.now() - enteredAtMs));
  const [base] = await db.select().from(bases).where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet)));
  if (!base || base.status !== 'active') throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  if (!base.deedAssetId && base.deedMintAssetId) {
    throw new HttpError(
      503,
      'deed mint is pending exact on-chain recovery; base authority is quarantined',
      'DEED_AUTHORITY_UNAVAILABLE',
    );
  }
  if (!base.deedAssetId) return base;
  const deedAssetId = base.deedAssetId;
  const latestObservation = async () => (await db.select().from(deedOwnershipObservations)
    .where(and(eq(deedOwnershipObservations.baseId, baseId), eq(deedOwnershipObservations.assetId, deedAssetId)))
    .orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1))[0];
  /** THE policy: a finalized `owned` proof for this wallet, at most ten seconds old. */
  const proves = (row: typeof deedOwnershipObservations.$inferSelect | undefined, at: Date) => row !== undefined
    && row.slot !== null && row.status === 'owned' && row.owner === wallet
    && at.getTime() - row.checkedAt.getTime() <= BASE_OWNERSHIP.mutationFreshnessMs;
  const latest = await latestObservation();
  const decidedAt = realNow();
  if (proves(latest, decidedAt)) {
    // This gate runs BEFORE the action's transaction, which re-checks the same
    // proof against the same ten-second limit after taking its row locks. A
    // proof accepted here at 9.9 s was refused there at 10.1 s — a false 503 for
    // a legitimate owner with a perfectly healthy RPC (2026-09-18). So a proof
    // that is about to expire is renewed from here — but NEVER awaited. A read
    // can take longer (paced queue + RPC, each up to 8 s) than the proof has
    // left; waiting for it and then measuring the proof at the real instant
    // refused a request this proof was entitled to serve (security review
    // 2026-09-18: 8 s proof + read failing after 2.5 s => 503). The request
    // proceeds on the proof it holds, decided at this instant, exactly as it
    // would have with no early renewal; the renewal lands on the row for the
    // locked re-check (which reads the latest row) and for the next request.
    if (decidedAt.getTime() - latest!.checkedAt.getTime()
      > BASE_OWNERSHIP.mutationFreshnessMs - BASE_OWNERSHIP.gateRefreshAheadMs) {
      renewProofInBackground(db, baseId, reader, expectedCollection, now);
    }
  } else {
    // No proof the rule accepts: only now is the chain worth waiting for.
    const status = await refreshBaseOwnership(db, baseId, reader, expectedCollection, now);
    if (status !== 'owned') {
      // An ANSWER-LESS refresh changes nothing about what is already proven: the
      // observer may have renewed the proof while this read was queued (its
      // newer slot makes this read `stale-floor`). Re-apply the unchanged policy
      // to the current row at the REAL current instant — this read may have
      // taken ~16 s to fail, and the observer's proof ages while it does. Never
      // after a positive answer: `mismatch`/`ineligible` are recorded on the
      // row and fail right here.
      const current = status === 'unavailable' ? await latestObservation() : undefined;
      const recheckedAt = realNow();
      if (!proves(current, recheckedAt)) {
        warnDeedAuthority('deed_authority_refused', {
          gate: 'refresh', baseId, refresh: status, priorStatus: latest?.status ?? 'none',
          priorAgeMs: latest ? now.getTime() - latest.checkedAt.getTime() : null,
        });
        throw new HttpError(503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE');
      }
    }
  }
  const [current] = await db.select().from(bases)
    .where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active')));
  if (!current) throw new HttpError(409, 'deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
  return current;
}

/** Wallet-wide extraction uses the strongest active base, so every active deed
 * that could contribute must carry fresh finalized authority before a collect
 * or cache claim. A free deedless base needs no chain proof. */
export async function requireFreshActiveBaseAuthorities(
  db: Db, wallet: string, reader: FinalizedDeedReader | null,
  expectedCollection: string | null, now = new Date(),
) {
  const active = await db.select({
    id: bases.id, deedAssetId: bases.deedAssetId,
    deedMintAssetId: bases.deedMintAssetId, landPaidAt: bases.landPaidAt,
  })
    .from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active')))
    .orderBy(asc(baseSlots.slot));
  await Promise.all(active.map((base) => (base.deedAssetId || base.deedMintAssetId)
    ? requireFreshBaseAuthority(db, wallet, base.id, reader, expectedCollection, now)
    : Promise.resolve(base)));

  // Fence the action boundary, not merely the start of the request. A wallet
  // may have five active deeds and each finalized read is bounded at 8 seconds;
  // sequential checks made the first proof tens of seconds old before the
  // caller could mutate. Parallel reads plus this re-read prove that neither
  // the active set nor any accepted proof aged past the 10-second policy while
  // the gate was running.
  const completedAt = new Date();
  const current = await db.select({
    id: bases.id, deedAssetId: bases.deedAssetId,
    deedMintAssetId: bases.deedMintAssetId, landPaidAt: bases.landPaidAt,
  }).from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active')))
    .orderBy(asc(baseSlots.slot));
  if (current.length !== active.length || current.some((base, i) => base.id !== active[i]!.id)) {
    throw new HttpError(409, 'active deed set changed during authorization', 'DEED_OWNERSHIP_CHANGED');
  }
  await Promise.all(current.map(async (base) => {
    if (!base.deedAssetId && base.deedMintAssetId) {
      throw new HttpError(
        503,
        'deed mint is pending exact on-chain recovery; base authority is quarantined',
        'DEED_AUTHORITY_UNAVAILABLE',
      );
    }
    if (!base.deedAssetId) return;
    const [latest] = await db.select().from(deedOwnershipObservations).where(and(
      eq(deedOwnershipObservations.baseId, base.id),
      eq(deedOwnershipObservations.assetId, base.deedAssetId),
    )).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
    if (!latest || latest.status !== 'owned' || latest.owner !== wallet || latest.slot === null
      || completedAt.getTime() - latest.checkedAt.getTime() > BASE_OWNERSHIP.mutationFreshnessMs) {
      throw new HttpError(503, 'deed ownership proof expired during authorization', 'DEED_AUTHORITY_UNAVAILABLE');
    }
  }));
  return current;
}

/** Ownership-scoped refresh for client-triggered activation. Prevents callers
 * from using a foreign base id as an RPC/deactivation oracle. */
export async function refreshOwnedBaseOwnership(
  db: Db, wallet: string, baseId: string, reader: FinalizedDeedReader | null,
  expectedCollection: string | null, now = new Date(),
) {
  const [owned] = await db.select({ id: bases.id }).from(bases)
    .where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet)));
  if (!owned) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
  return refreshBaseOwnership(db, baseId, reader, expectedCollection, now);
}

/** Real-money commitment fence for a NEW stable item reservation. Unlike the
 * ordinary mutation helper, this deliberately ignores a fresh cached `owned`
 * observation and performs one exact finalized read every time. */
export async function requireExactFinalizedOwnedBaseAuthority(
  db: Db, wallet: string, baseId: string, reader: FinalizedDeedReader | null,
  expectedCollection: string | null, now = new Date(),
): Promise<void> {
  const [source] = await db.select({ deedAssetId: bases.deedAssetId }).from(bases)
    .where(and(eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active')));
  if (!source) throw new HttpError(409, 'deed ownership changed', 'DEED_OWNERSHIP_CHANGED');
  if (!source.deedAssetId || !reader) {
    throw new HttpError(503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE');
  }
  const status = await refreshBaseOwnership(
    db, baseId, reader, expectedCollection, now, 'market-reservation',
  );
  if (status !== 'owned') {
    throw new HttpError(503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE');
  }
}

/** Serialize the global deed-observer capacity decision. The cap is an
 * operational authority boundary: at the supported maximum one complete,
 * bounded finalized sweep still finishes inside the sub-minute loss-detection
 * target. A deed may still exist in a wallet above this cap, but it cannot be
 * activated into gameplay until capacity is available. */
export async function assertDeedObserverCapacity(tx: DbTx, additionalActiveDeeds = 1): Promise<void> {
  if (additionalActiveDeeds <= 0) return;
  if (await deedObserverCapacityAvailable(tx, additionalActiveDeeds)) return;
  throw new HttpError(
    503,
    'active deed observer capacity reached; deactivate another deed or retry later',
    'DEED_OBSERVER_CAPACITY',
  );
}

/** Advisory-locked capacity probe for ownership transfers, which must still
 * convey the deed when no observer slot is available and merely leave it
 * inactive. */
async function deedObserverCapacityAvailable(tx: DbTx, additionalActiveDeeds: number): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('shardkeep:deed-observer-capacity'))`);
  const [row] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.active, true), eq(bases.status, 'active'),
      // A fixed mint address is a durable reservation even when the RPC send
      // failed ambiguously and the retry lease was released. The asset may
      // already exist; dropping it from this count could overbook the observer
      // and strand a valid deed at final attachment.
      sql`(${bases.deedAssetId} IS NOT NULL OR ${bases.deedMintAssetId} IS NOT NULL OR ${bases.deedMintingAt} IS NOT NULL)`,
    ));
  return (row?.count ?? 0) + additionalActiveDeeds <= BASE_OWNERSHIP.observationMaxActiveDeeds;
}

/** Boot/activation preflight for rows created by the one-time 0064 backfill.
 * Runtime admission prevents crossing the ceiling afterward, but an existing
 * database must also prove it starts inside the supported observer envelope. */
export async function assertDeedObserverCapacityReady(db: Db): Promise<void> {
  const coverage = await deedObserverCoverage(db);
  if (coverage.active > BASE_OWNERSHIP.observationMaxActiveDeeds) {
    throw new Error(
      `[multi-base] ${coverage.active} active deeds exceed supported observer capacity `
      + `${BASE_OWNERSHIP.observationMaxActiveDeeds}; activation refused`,
    );
  }
  if (coverage.uncovered > 0) {
    throw new Error(
      `[multi-base] ${coverage.uncovered} active deed(s) lack a current owned observation; activation refused`,
    );
  }
}

/** Worker boot may be the only process capable of healing stale observations,
 * so it enforces the hard capacity ceiling without demanding freshness first. */
export async function assertDeedObserverCapacityWithinLimit(db: Db): Promise<void> {
  const coverage = await deedObserverCoverage(db);
  if (coverage.active > BASE_OWNERSHIP.observationMaxActiveDeeds) {
    throw new Error(
      `[multi-base] ${coverage.active} active deeds exceed supported observer capacity `
      + `${BASE_OWNERSHIP.observationMaxActiveDeeds}; observer start refused`,
    );
  }
}

/** Recomputed observer health boundary (never a cached process flag). A latest
 * row for another asset/owner, an unavailable/mismatch status, null slot, or a
 * proof older than the 60-second SLA all make the active deed uncovered. */
export async function deedObserverCoverage(
  db: Db, now = new Date(),
): Promise<{ ok: boolean; active: number; uncovered: number }> {
  // Raw postgres.js parameters do not apply Drizzle's timestamp encoder. Bind
  // the ISO value explicitly so health checks work on a real database instead
  // of passing a Date object to the wire encoder.
  const freshAfter = new Date(
    now.getTime() - BASE_OWNERSHIP.observationHealthFreshnessMs,
  ).toISOString();
  const result = await db.execute(sql`
    SELECT
      count(*)::int AS active,
      count(*) FILTER (
        WHERE (b.deed_asset_id IS NULL AND b.deed_mint_asset_id IS NOT NULL)
          OR (b.deed_asset_id IS NOT NULL AND (
            o.base_id IS NULL OR o.asset_id <> b.deed_asset_id
            OR o.owner IS DISTINCT FROM b.owner_wallet
            OR o.status <> 'owned' OR o.slot IS NULL OR o.checked_at < ${freshAfter}
          ))
      )::int AS uncovered
    FROM base_slots s
    JOIN bases b ON b.id = s.base_id
    LEFT JOIN LATERAL (
      SELECT d.base_id, d.asset_id, d.owner, d.status, d.slot, d.checked_at
      FROM deed_ownership_observations d
      WHERE d.base_id = b.id
      ORDER BY d.checked_at DESC, d.id DESC
      LIMIT 1
    ) o ON true
    WHERE s.active = true AND b.status = 'active'
      AND (b.deed_asset_id IS NOT NULL OR b.deed_mint_asset_id IS NOT NULL OR b.deed_minting_at IS NOT NULL)
  `);
  const row = (result as unknown as Array<{ active: number; uncovered: number }>)[0];
  const active = Number(row?.active ?? 0);
  const uncovered = Number(row?.uncovered ?? 0);
  return {
    ok: active <= BASE_OWNERSHIP.observationMaxActiveDeeds && uncovered === 0,
    active, uncovered,
  };
}

/** Add/relocate a deed after a caller has established finalized ownership. The
 * first deed attaches to the existing free base; subsequent deeds create bases,
 * auto-activating only while a slot is free.
 *
 * If `deedAssetId` is already a pending exact mint reservation, it belongs to
 * that stable base even if the asset transferred before the RPC/DB recovery.
 * Never attach it to the recipient's free base. Cross-owner recovery therefore
 * requires the caller's finalized owner verifier and transfers that exact base. */
export async function registerOwnedDeed(
  db: Db, wallet: string, deedAssetId: string,
  recovery?: {
    ownerOf: (assetId: string) => Promise<FinalizedAssetOwnership | null>;
    expectedCollection: string | null;
    clock?: () => Date;
  },
) {
  const [pendingHint] = await db.select({ id: bases.id, ownerWallet: bases.ownerWallet })
    .from(bases).where(eq(bases.deedMintAssetId, deedAssetId)).limit(1);
  const clock = recovery?.clock ?? (() => new Date());
  let crossOwnerProof: ObservedDeedOwnership | null = null;
  if (pendingHint && pendingHint.ownerWallet !== wallet) {
    const observed = recovery ? await recovery.ownerOf(deedAssetId) : null;
    const observedAtMs = clock().getTime();
    if (!recovery?.expectedCollection || !observed || observed.owner !== wallet
      || !ownershipEligible(observed, recovery?.expectedCollection ?? null)) {
      throw new HttpError(
        503, 'pending deed transferability could not be verified at finalized commitment',
        'DEED_AUTHORITY_UNAVAILABLE',
      );
    }
    crossOwnerProof = observeDeedOwnership(observed, observedAtMs);
  }

  const result = await db.transaction(async (tx) => {
    await tx.insert(players).values({ wallet }).onConflictDoNothing();
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    const duplicate = await tx.select().from(bases).where(eq(bases.deedAssetId, deedAssetId));
    if (duplicate[0]) {
      if (duplicate[0].ownerWallet !== wallet) {
        throw new HttpError(409, 'deed is already registered to another wallet', 'DEED_ALREADY_REGISTERED');
      }
      return { base: duplicate[0], transferFrom: null as string | null };
    }
    const [pending] = await tx.select().from(bases)
      .where(eq(bases.deedMintAssetId, deedAssetId)).for('update');
    if (pending) {
      if (!pending.landPaidAt) {
        throw new HttpError(409, 'pending deed has no paid base', 'DEED_OWNERSHIP_CHANGED');
      }
      if (pending.ownerWallet !== wallet
        && (!crossOwnerProof || pendingHint?.id !== pending.id)) {
        // A reservation appeared/changed after the preflight. Refuse this turn;
        // the retry will verify the now-stable exact base before touching it.
        throw new HttpError(
          503, 'pending deed owner changed during verification', 'DEED_AUTHORITY_UNAVAILABLE',
        );
      }
      if (pending.ownerWallet !== wallet) {
        // Do not attach in one transaction and transfer in another: a crash in
        // between strands the exact deed on the stale owner. The canonical
        // transfer transaction below performs both changes atomically.
        return { base: pending, transferFrom: pending.ownerWallet };
      }
      const [attached] = await tx.update(bases).set({
        deedAssetId, deedMintAssetId: deedAssetId, deedMintingAt: null, updatedAt: new Date(),
      }).where(and(eq(bases.id, pending.id), isNull(bases.deedAssetId))).returning();
      if (!attached) throw new HttpError(409, 'pending deed changed during recovery', 'DEED_OWNERSHIP_CHANGED');
      {
        const owned = await tx.select({ id: bases.id }).from(bases)
          .where(eq(bases.ownerWallet, wallet)).limit(2);
        if (owned.length === 1) {
          await tx.update(players).set({
            deedAssetId, deedMintAssetId: deedAssetId, deedMintingAt: null,
          }).where(eq(players.wallet, wallet));
        }
      }
      return { base: attached, transferFrom: null as string | null };
    }
    const owned = await tx.select().from(bases).where(eq(bases.ownerWallet, wallet)).orderBy(asc(bases.id)).for('update');
    const free = owned.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .find((b) => b.deedAssetId === null && b.deedMintAssetId === null);
    if (free) {
      if (free.status === 'active') await assertDeedObserverCapacity(tx);
      await closeHarvesterSources(tx, free.id, custodyEventTime(clock), 'realm_change');
      const [updated] = await tx.update(bases).set({
        deedAssetId, deedMintAssetId: deedAssetId, landPaidAt: new Date(), updatedAt: new Date(),
      })
        .where(eq(bases.id, free.id)).returning();
      return { base: updated!, transferFrom: null as string | null };
    }
    const slots = await tx.select().from(baseSlots).where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true))).for('update');
    const activate = slots.length < BASE_OWNERSHIP.maxActive;
    if (activate) await assertDeedObserverCapacity(tx);
    let created: typeof bases.$inferSelect;
    try {
      [created] = await tx.insert(bases).values({
        ownerWallet: wallet, deedAssetId, deedMintAssetId: deedAssetId,
        status: activate ? 'active' : 'inactive',
      }).returning() as [typeof bases.$inferSelect];
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new HttpError(409, 'deed was registered concurrently', 'DEED_ALREADY_REGISTERED');
      }
      throw error;
    }
    if (activate) {
      const used = new Set(slots.map((s) => s.slot));
      const slot = Array.from({ length: BASE_OWNERSHIP.maxActive }, (_, i) => i + 1).find((n) => !used.has(n))!;
      await tx.insert(baseSlots).values({ wallet, slot, baseId: created.id, selectedAt: new Date() });
    }
    return { base: created, transferFrom: null as string | null };
  });
  if (!result.transferFrom) return result.base;
  await transferStableBaseInternal(
    db, result.base.id, result.transferFrom, wallet, deedAssetId, true, crossOwnerProof ?? undefined, clock,
  );
  const [transferred] = await db.select().from(bases).where(eq(bases.id, result.base.id));
  if (!transferred || transferred.ownerWallet !== wallet || transferred.deedAssetId !== deedAssetId) {
    throw new HttpError(409, 'recovered deed base transfer did not settle', 'DEED_OWNERSHIP_CHANGED');
  }
  return transferred;
}

export async function activateBase(
  db: Db, wallet: string, baseId: string, replaceBaseId?: string,
  assertAuthority?: LockedBaseAuthority,
  clock: () => Date = () => new Date(),
) {
  const activated = await db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    // Selection/renewal and raids can lock the same pair. Acquire all possible
    // roster bases in canonical order before slots or Harvester accounting.
    const rosterBases = await tx.select().from(bases)
      .where(and(inArray(bases.id, [...new Set([baseId, ...(replaceBaseId ? [replaceBaseId] : [])])]), eq(bases.ownerWallet, wallet)))
      .orderBy(asc(bases.id)).for('update');
    const target = rosterBases.find(base => base.id === baseId);
    if (!target) throw new HttpError(404, 'base not owned', 'BASE_NOT_OWNED');
    const slots = await tx.select().from(baseSlots)
      .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true))).orderBy(asc(baseSlots.slot)).for('update');
    const already = slots.find((s) => s.baseId === baseId);
    if (already) {
      if (target.landPaidAt && (fantasyWorldEnabled() || await getFantasyClaim(tx, baseId))) {
        await activateHeldFantasyLocation(tx, wallet, baseId);
      }
      return {
        result: { baseId, slot: already.slot },
        worldChanged: false,
        affectedValleyIds: [] as string[],
      };
    }
    if (!target.deedAssetId && target.deedMintAssetId) {
      throw new HttpError(
        503,
        'deed mint is pending exact on-chain recovery; base activation is quarantined',
        'DEED_AUTHORITY_UNAVAILABLE',
      );
    }
    // The route's finalized refresh happens before this transaction. Re-check
    // its persisted evidence only after the canonical player/base/slot locks,
    // so an ownership loss during the lock wait cannot reactivate sold land.
    if (assertAuthority) await assertAuthority(tx, wallet, target.id);
    const [targetRaidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
      .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, target.id)).for('update');
    if (targetRaidLock) {
      throw new HttpError(
        423,
        'You are being raided, please wait to continue playing or watch it live',
        'BASE_BEING_RAIDED',
      );
    }
    if (await unresolvedOutgoingRaidId(tx, target.id)) {
      throw new HttpError(
        409,
        'finish the base\'s active outgoing battle before changing active bases',
        'BASE_BUSY_ATTACKING',
      );
    }
    let slot: number;
    let displacedBaseId: string | null = null;
    if (slots.length < BASE_OWNERSHIP.maxActive) {
      if (target.deedAssetId) await assertDeedObserverCapacity(tx);
      const used = new Set(slots.map((s) => s.slot));
      slot = Array.from({ length: BASE_OWNERSHIP.maxActive }, (_, i) => i + 1).find((n) => !used.has(n))!;
      await tx.insert(baseSlots).values({ wallet, slot, baseId, selectedAt: new Date() });
    } else {
      const displaced = slots.find((s) => s.baseId === replaceBaseId);
      if (!displaced) throw new HttpError(409, 'replaceBaseId must name an active base', 'BASE_REPLACEMENT_REQUIRED');
      const displacedBase = rosterBases.find(base => base.id === displaced.baseId);
      if (!displacedBase) throw new Error(`active base slot ${displaced.baseId} lost its base row`);
      const [displacedRaidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
        .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, displaced.baseId)).for('update');
      if (displacedRaidLock) {
        throw new HttpError(
          423,
          'You are being raided, please wait to continue playing or watch it live',
          'BASE_BEING_RAIDED',
        );
      }
      if (await unresolvedOutgoingRaidId(tx, displaced.baseId)) {
        throw new HttpError(
          409,
          'finish the base\'s active outgoing battle before changing active bases',
          'BASE_BUSY_ATTACKING',
        );
      }
      if (target.deedAssetId) {
        if (!displacedBase.deedAssetId) await assertDeedObserverCapacity(tx);
      }
      slot = displaced.slot;
      displacedBaseId = displaced.baseId;
      await closeHarvesterSources(tx, displaced.baseId, custodyEventTime(clock), 'deactivation');
      await tx.update(bases).set({ status: 'inactive', updatedAt: new Date() }).where(eq(bases.id, displaced.baseId));
      await tx.update(baseSlots).set({ baseId, selectedAt: new Date() })
        .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.slot, slot)));
    }
    await tx.update(bases).set({ status: 'active', updatedAt: new Date() }).where(eq(bases.id, baseId));
    if (target.landPaidAt && (fantasyWorldEnabled() || await getFantasyClaim(tx, baseId))) {
      await activateHeldFantasyLocation(tx, wallet, baseId);
    }
    const affectedPlots = await tx.select({ valleyId: plots.valleyId }).from(plots)
      .where(inArray(plots.baseId, displacedBaseId ? [baseId, displacedBaseId] : [baseId]));
    return {
      result: { baseId, slot },
      worldChanged: true,
      affectedValleyIds: affectedPlots.map((plot) => plot.valleyId),
    };
  });
  // The public-world cache must never be cleared from inside the transaction:
  // a concurrent read could repopulate the pre-commit roster and keep it for the
  // full TTL. Resolve first (which means COMMIT succeeded), then evict every
  // plotted valley whose public eligibility changed plus the planet aggregate.
  if (activated.worldChanged) {
    for (const valleyId of new Set(activated.affectedValleyIds)) if (valleyId) invalidateValley(valleyId);
    invalidateGlobe();
  }
  return activated.result;
}

/** Apply an externally traded deed by changing only the stable ownership root.
 * Every playable child—including economy, army, research, heroes, items and
 * history—already follows base_id, so none of it is copied or rewritten here. */
async function transferStableBaseInternal(
  db: Db, baseId: string, from: string, to: string, expectDeed: string,
  attachReserved: boolean,
  verifiedOwner?: ObservedDeedOwnership,
  eventClock: () => Date = () => new Date(),
) {
  if (from === to) return { baseId, active: true };
  // Copy even server-provided evidence before the transaction can wait.
  const proof = verifiedOwner && observeDeedOwnership(verifiedOwner, verifiedOwner.observedAtMs);
  if (proof) await journalFinalizedHarvesterLoss(db, baseId, from, to, expectDeed, proof, eventClock);
  const result = await db.transaction(tx => transferStableBaseTransaction(
    tx, baseId, from, to, expectDeed, attachReserved, proof, eventClock,
  ));
  await invalidateBaseWorldCaches(db, baseId);
  return { baseId: result.baseId, active: result.active };
}

/** Shared canonical move. The command caller owns its outer transaction and
 * publishes cache invalidation only after the retained receipt commits. */
async function transferStableBaseTransaction(
  tx: DbTx, baseId: string, from: string, to: string, expectDeed: string,
  attachReserved: boolean, verifiedOwner?: ObservedDeedOwnership,
  eventClock: () => Date = () => new Date(),
) {
  await tx.insert(players).values({ wallet: to }).onConflictDoNothing();
  await tx.select({ wallet: players.wallet }).from(players)
    .where(sql`${players.wallet} in (${from}, ${to})`).orderBy(asc(players.wallet)).for('update');
  const [base] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
  const reservedRecovery = attachReserved
    && base?.deedAssetId === null && base.deedMintAssetId === expectDeed;
  if (!base || base.ownerWallet !== from
    || (base.deedAssetId !== expectDeed && !reservedRecovery)) {
    throw new HttpError(409, 'deed changed since observation', 'DEED_OWNERSHIP_CHANGED');
  }
  if (await unresolvedOutgoingRaidId(tx, baseId)) {
    throw new HttpError(
      409,
      'finish the base\'s active outgoing battle before transferring its deed',
      'BASE_BUSY_ATTACKING',
    );
  }
  const eventAt = custodyEventTime(eventClock);
  // Player/base locks serialize every transfer with native claim acceptance
  // and observer writes. Once a floor exists, omitting proof cannot bypass it.
  const [priorProof] = await tx.select().from(deedOwnershipObservations)
    .where(eq(deedOwnershipObservations.baseId, baseId))
    .orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
  if ((verifiedOwner || priorProof?.slot != null)
    && (!verifiedOwner || !deedProofIsFresh(verifiedOwner, eventAt)
      || verifiedOwner.owner !== to || !ownershipEligible(verifiedOwner, null)
      || !Number.isSafeInteger(verifiedOwner.slot) || verifiedOwner.slot < 0
      || !deedProofMeetsFloor(priorProof, BigInt(verifiedOwner.slot), verifiedOwner.owner))) {
    throw new HttpError(503, 'fresh deed ownership evidence is unavailable', 'DEED_AUTHORITY_UNAVAILABLE');
  }
  if (reservedRecovery) {
    await tx.update(bases).set({
      deedAssetId: expectDeed, deedMintAssetId: expectDeed,
      deedMintingAt: null, updatedAt: eventAt,
    }).where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, from),
      isNull(bases.deedAssetId), eq(bases.deedMintAssetId, expectDeed),
    ));
  }
  if (verifiedOwner) {
    const now = new Date(verifiedOwner.observedAtMs);
    const evidence = { assetId: expectDeed, owner: to, slot: BigInt(verifiedOwner.slot), checkedAt: now,
      source: 'claim-finalized', status: 'owned' as const,
      auditHash: observationHash(expectDeed, to, 'owned', BigInt(verifiedOwner.slot), now) };
    // Native v1 already persisted this exact proof in its outer transaction.
    // Avoid a duplicate observation event while retaining legacy acceptance.
    if (priorProof) {
      if (priorProof.auditHash !== evidence.auditHash) await tx.update(deedOwnershipObservations).set(evidence).where(eq(deedOwnershipObservations.id, priorProof.id));
    } else await tx.insert(deedOwnershipObservations).values({ baseId, ...evidence });
  }
  await completeDueJobs(tx, from, eventAt, baseId);
  await settleDueStarterExpeditions(tx, baseId, eventAt);
  await settleAdvancedExpeditionsAtBoundary(tx, baseId, eventAt);
  await settleDueOrdinaryCrafting(tx, baseId, eventAt);
  await closeHarvesterSources(tx, baseId, eventAt, 'custody_change');
  const [settledBase] = await tx.select().from(bases).where(eq(bases.id, baseId)).for('update');
  if (!settledBase) throw new HttpError(409, 'base disappeared during transfer', 'DEED_OWNERSHIP_CHANGED');
  // Neither the retired wallet clock nor a physical Mine clock may straddle
  // an ownership boundary. In particular, settle every Mine while the base
  // still names the seller: ownerReferralBonusBps is live, so reading it only
  // after the UPDATE would retroactively apply the buyer's referral rate to
  // the seller's elapsed interval and mint unearned SHARDS.
  await reanchorMineAccrual(tx, from, eventAt);
  await reanchorMineAccrual(tx, to, eventAt);
  const mineCaptured = await capturePhysicalMineCustodyBoundary(tx, {
    baseId, recordedWallet: from, observedWallet: to, eventAt,
    observedAt: verifiedOwner ? new Date(verifiedOwner.observedAtMs) : eventAt,
    slot: verifiedOwner ? BigInt(verifiedOwner.slot) : null, source: 'stable-transfer',
  });
  if (!mineCaptured) await reanchorBaseMineAccrual(tx, baseId, eventAt);
  const [priorSlot] = await tx.select().from(baseSlots)
    .where(eq(baseSlots.baseId, baseId)).for('update');
  await tx.delete(baseSlots).where(eq(baseSlots.baseId, baseId));
  const buyerSlots = await tx.select().from(baseSlots)
    .where(and(eq(baseSlots.wallet, to), eq(baseSlots.active, true))).orderBy(asc(baseSlots.slot)).for('update');
  let active = buyerSlots.length < BASE_OWNERSHIP.maxActive;
  const remainsObserved = base.status === 'active' && priorSlot?.active === true;
  if (reservedRecovery && !remainsObserved) {
    // Attaching the reserved id above takes the deed-asset registry lock in
    // the 0072 trigger. Never acquire observer capacity after that lock:
    // mint/register use capacity -> registry, so reversing it can deadlock.
    // Keep an inactive recovered base quarantined until activateBase takes
    // the canonical capacity lock before any later identity-sensitive work.
    active = false;
  } else if (active && !remainsObserved) {
    // An inactive deed becoming active consumes observer capacity. A sale
    // cannot be rejected after the chain already conveyed ownership, so lack
    // of capacity leaves the received base inactive instead.
    active = await deedObserverCapacityAvailable(tx, 1);
  }
  const fantasyClaim = await getFantasyClaim(tx, baseId);
  // A trusted internal move without any observation remains quarantined until
  // activation establishes proof; public claim/recovery callers supply it.
  if (active && fantasyClaim?.state === 'held' && !verifiedOwner) active = false;
  await tx.update(bases).set({ ownerWallet: to, status: active ? 'active' : 'inactive', updatedAt: eventAt })
    .where(eq(bases.id, baseId));
  // The settled balance/clock/cycle stay with the physical Mine. Only its
  // future full boundary changes, now under the buyer's live quota inputs.
  await rescheduleBaseMineFullChecks(tx, baseId, eventAt);
  if (active) {
    const used = new Set(buyerSlots.map((s) => s.slot));
    const slot = Array.from({ length: BASE_OWNERSHIP.maxActive }, (_, i) => i + 1).find((n) => !used.has(n))!;
    await tx.insert(baseSlots).values({ wallet: to, slot, baseId, selectedAt: eventAt });
    if (fantasyClaim?.state === 'held') await activateHeldFantasyLocation(tx, to, baseId, eventAt);
  }
  // Legacy player columns are compatibility shadows, never authority. They
  // still must not point at a deed the wallet just sold: that stale pointer
  // blocked mint/recovery for a remaining base and could resurrect sold land
  // when the feature flag was off. Clear/repoint the seller first (the player
  // deed column is unique), then fill the buyer only when unambiguous/empty.
  await reconcileTransferredPlayerScalars(tx, from, to);
  const [audit] = await tx.insert(baseTransfers).values({
    deedAssetId: expectDeed, fromWallet: from, toWallet: to,
    priorKeepLevel: settledBase.keepLevel, priorExpansions: settledBase.expansions,
    priorEntryPaidAt: settledBase.landPaidAt,
    // Stable ids mean no child ownership columns are rewritten. Zero is the
    // truthful legacy audit count; the deed/base id is the moved identity.
    buildingsMoved: 0, jobsMoved: 0, shieldsMoved: 0,
    createdAt: eventAt,
  }).returning({ id: baseTransfers.id });
  if (!audit) throw new Error('stable transfer audit was not written');
  return { baseId, active, transferId: audit.id };
}

/** Exact claim seam: no reserved-deed recovery and no early cache publication. */
export async function transferClaimedStableBase(
  tx: DbTx, baseId: string, from: string, to: string, expectDeed: string,
  verifiedOwner: ObservedDeedOwnership,
  eventClock: () => Date = () => new Date(),
) {
  if (from === to) throw new HttpError(409, 'claim transfer requires a different owner', 'BASE_CLAIM_CHANGED');
  const proof = observeDeedOwnership(verifiedOwner, verifiedOwner.observedAtMs);
  return transferStableBaseTransaction(tx, baseId, from, to, expectDeed, false, proof, eventClock);
}

export async function transferStableBase(
  db: Db, baseId: string, from: string, to: string, expectDeed: string,
  verifiedOwner?: ObservedDeedOwnership,
  eventClock: () => Date = () => new Date(),
) {
  return transferStableBaseInternal(db, baseId, from, to, expectDeed, false, verifiedOwner, eventClock);
}

/** Reservation seam for the deposit service. The caller creates/locks the
 * deposit in the same transaction and supplies the currently claimable set. */
export async function reserveEarthCell(
  tx: DbTx, depositId: string, baseId: string, parcel: EarthParcelIdentity,
  now = new Date(),
) {
  const [existing] = await tx.select().from(plotReservations).where(eq(plotReservations.depositId, depositId));
  if (existing) {
    if (existing.baseId !== baseId || existing.earthCell !== parcel.earthCell
      || existing.siteId !== parcel.siteId || existing.x !== parcel.x || existing.y !== parcel.y
      || existing.countryA3 !== parcel.countryA3) {
      throw new HttpError(409, 'deposit reservation identity changed', 'RESERVATION_MISMATCH');
    }
    return existing;
  }
  try {
    return await tx.transaction(async (sp) => {
      const [row] = await sp.insert(plotReservations).values({
        depositId, baseId, earthCell: parcel.earthCell, siteId: parcel.siteId,
        x: parcel.x, y: parcel.y, countryA3: parcel.countryA3,
        expiresAt: new Date(now.getTime() + BASE_OWNERSHIP.reservationTtlMs),
      }).returning();
      return row!;
    });
  } catch (error) {
    const pgCode = (error as { code?: string; cause?: { code?: string } }).code
      ?? (error as { cause?: { code?: string } }).cause?.code;
    if (pgCode === '23505') {
      throw new HttpError(409, 'Earth cell was reserved concurrently', 'EARTH_CELL_UNAVAILABLE');
    }
    throw error;
  }
}

/** One wallet clock uses the strongest active base, never a sum across deeds. */
export async function maxActiveBaseKeepLevel(db: DbOrTx, wallet: string): Promise<number> {
  const [r] = await db.select({ value: sql<number>`coalesce(max(${bases.keepLevel}), 0)::int` })
    .from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active')));
  return r?.value ?? 0;
}

// Kept here as a compatibility export for existing callers/tests. The
// implementation lives with mining so base ownership can reanchor accrual
// without creating a circular dependency.
export { maxActiveMineQuota } from './emission';

/** Delay before the next observer wave. Exported so the RPC-budget and
 * supported-cap timing contract can be pinned without a database/RPC test. */
export function ownershipSweepBatchDelayMs(
  previousBatchStartedAt: number | null, nowMs: number,
): number {
  return previousBatchStartedAt === null ? 0 : Math.max(
    0, previousBatchStartedAt + BASE_OWNERSHIP.observationBatchIntervalMs - nowMs,
  );
}

/** What the observer job stores as its BullMQ return value. Completed jobs are
 * kept for a day (BULLMQ_RETENTION.deedOwnership) and the 5-second cadence
 * completes 17,280 of them; the full per-deed array (~70 bytes x up to 160
 * deeds) would hold 90-190 MB of Redis for history nobody reads. Every deed
 * that is NOT `owned` is still named, so an incident stays diagnosable. */
export function summarizeOwnershipSweep(
  results: ReadonlyArray<{ baseId: string; status: string }>,
) {
  const notOwned = results.filter((result) => result.status !== 'owned');
  return { deeds: results.length, owned: results.length - notOwned.length, notOwned };
}

export async function sweepActiveBaseOwnership(
  db: Db, reader: FinalizedDeedReader | null, expectedCollection: string | null,
  _now = new Date(), limit?: number,
) {
  const latest = db.select({
    baseId: deedOwnershipObservations.baseId,
    assetId: deedOwnershipObservations.assetId,
    checkedAt: sql<Date>`max(${deedOwnershipObservations.checkedAt})`.as('checked_at'),
    slot: sql<bigint | null>`max(${deedOwnershipObservations.slot})`.as('slot'),
  }).from(deedOwnershipObservations).groupBy(
    deedOwnershipObservations.baseId, deedOwnershipObservations.assetId,
  ).as('latest_deed_observation');
  const rows = await db.select({
    id: bases.id, assetId: bases.deedAssetId, floor: latest.slot,
  }).from(bases)
    .leftJoin(latest, and(
      eq(latest.baseId, bases.id), eq(latest.assetId, bases.deedAssetId),
    ))
    .where(and(eq(bases.status, 'active'), sql`${bases.deedAssetId} IS NOT NULL`))
    // Never order by gameplay updatedAt: an ordinary owned/unavailable poll
    // changes only its observation, so that order starved every base after the
    // first page forever. Unseen deeds first, then the least recently checked.
    .orderBy(sql`${latest.checkedAt} ASC NULLS FIRST`, asc(bases.id));
  if (limit === undefined && rows.length > BASE_OWNERSHIP.observationMaxActiveDeeds) {
    throw new Error(
      `[deed-ownership] ${rows.length} active deeds exceed supported observer capacity `
      + `${BASE_OWNERSHIP.observationMaxActiveDeeds}; refusing a sweep that cannot meet the loss-detection SLA`,
    );
  }
  const selected = limit === undefined ? rows : rows.slice(0, limit);
  const results = [] as Array<{ baseId: string; status: string }>;
  let previousBatchStartedAt: number | null = null;
  for (let i = 0; i < selected.length; i += BASE_OWNERSHIP.observationConcurrency) {
    const remainingDelay = ownershipSweepBatchDelayMs(previousBatchStartedAt, Date.now());
    if (remainingDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remainingDelay));
    }
    previousBatchStartedAt = Date.now();
    const chunk = selected.slice(i, i + BASE_OWNERSHIP.observationConcurrency);
    let prefetched: Map<string, FinalizedAssetOwnership | null> | null = null;
    // A wave whose ONE transport request failed answered nothing about any of
    // its deeds. Tell the per-deed refresh so, or it cannot distinguish that
    // from 32 positive absences and rewrites 32 live proofs as `unavailable`.
    let waveUnanswered = false;
    if (reader?.readBatch || reader?.readMany) {
      const requests = chunk.flatMap((row) => {
        const floor = row.floor === null ? undefined : Number(row.floor);
        return row.assetId && (floor === undefined || Number.isSafeInteger(floor))
          ? [{ assetId: row.assetId, minContextSlot: floor }]
          : [];
      });
      try {
        if (reader.readBatch) {
          // Same single transport request as readMany, plus its outcome.
          const batch = await reader.readBatch(requests);
          prefetched = batch.owners;
          waveUnanswered = !batch.transportSucceeded;
        } else {
          prefetched = await reader.readMany!(requests);
        }
      } catch {
        prefetched = new Map();
        waveUnanswered = true;
      }
    }
    results.push(...await Promise.all(chunk.map(async (row) => ({
      baseId: row.id,
      // Each bounded RPC batch gets its real start time. Reusing the sweep's
      // original timestamp made the final chunk appear stale immediately after
      // a legitimate ~40-second supported-cap pass.
      status: await refreshBaseOwnership(
        db, row.id,
        prefetched === null
          ? reader
          : async (assetId) => {
            if (waveUnanswered) throw new DeedReadUnavailableError('rpc-error');
            return prefetched!.get(assetId) ?? null;
          },
        expectedCollection, new Date(), 'sweep',
      ),
    }))));
  }
  if (limit === undefined && previousBatchStartedAt !== null) {
    // Keep the queue-global job active for one more wave interval. BullMQ may
    // already have the next repeat queued (always, at the supported ceiling,
    // and after the startup sweep), and another worker replica may claim it;
    // holding this globally-serialized job is the cross-process fence that
    // keeps the next sweep's first wave a full interval behind our last one,
    // so the observer's one-request-per-interval budget holds ACROSS sweeps.
    // The supported 160-deed pass releases after 5 intervals = one poll period.
    const remainingDelay = ownershipSweepBatchDelayMs(previousBatchStartedAt, Date.now());
    if (remainingDelay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remainingDelay));
    }
  }
  return results;
}
