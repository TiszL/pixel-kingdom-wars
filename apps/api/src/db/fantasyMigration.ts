/** Explicit operator migration only; never a startup hook. The reviewed
 * manifest determines scope, never inactive/login flags or last-seen time. */
import { createHash } from 'node:crypto';
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import {
  FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, crownlandsMigrationTiles,
} from '@shardkeep/shared/fantasyWorld';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  bases, baseSlots, deedOwnershipObservations, fantasyLandClaims,
  fantasyMigrationBatches, fantasyRetirementExclusions, players, deposits,
} from './schema';
import { activateFantasyPurchaseCutover, getFantasyClaim, installFantasyCatalog, pendingLegacyFantasyPurchases, requireOrdinaryFantasyTile, stageLockedLegacyFantasyPurchases } from '../game/fantasyLocation';

export interface MigrationIdentity { baseId: string; mintId: string; ownerWallet: string }
export interface RetirementIdentity {
  baseId: string; mintId: string | null; receiptId: string; abandonReceiptId: string;
}
export interface MigrationEntry extends MigrationIdentity { tileId: number; state: 'held' | 'assigned' }
export interface FantasyMigrationManifest {
  version: 1;
  worldId: typeof FANTASY_WORLD_ID;
  catalogHash: string;
  snapshotAt: string;
  entries: MigrationEntry[];
  exclusions: RetirementIdentity[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function compareId(a: { baseId: string }, b: { baseId: string }): number {
  return a.baseId < b.baseId ? -1 : a.baseId > b.baseId ? 1 : 0;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function fantasyManifestHash(manifest: FantasyMigrationManifest): string {
  return createHash('sha256').update(canonical(manifest)).digest('hex');
}

export function validateFantasyManifest(manifest: FantasyMigrationManifest): void {
  if (!manifest || !Array.isArray(manifest.entries) || !Array.isArray(manifest.exclusions) || manifest.version !== 1 || manifest.worldId !== FANTASY_WORLD_ID || manifest.catalogHash !== FANTASY_CATALOG_HASH
    || !Number.isFinite(Date.parse(manifest.snapshotAt))) throw new Error('Invalid fantasy migration catalog or snapshot');
  const excluded = new Set<string>();
  const excludedMints = new Set<string>();
  for (const row of manifest.exclusions) {
    if (!uuid.test(row.baseId) || !uuid.test(row.receiptId) || !uuid.test(row.abandonReceiptId)
      || (row.mintId !== null && (!mint.test(row.mintId) || excludedMints.has(row.mintId))) || excluded.has(row.baseId)) {
      throw new Error('Invalid or duplicate positive retirement identity');
    }
    excluded.add(row.baseId);
    if (row.mintId) excludedMints.add(row.mintId);
  }
  const baseIds = new Set<string>(); const mintIds = new Set<string>(); const tiles = new Set<number>();
  for (const row of manifest.entries) {
    const tile = requireOrdinaryFantasyTile(row.tileId);
    if (!uuid.test(row.baseId) || !mint.test(row.mintId) || !mint.test(row.ownerWallet)
      || (row.state !== 'held' && row.state !== 'assigned') || excluded.has(row.baseId)
      || excludedMints.has(row.mintId) || baseIds.has(row.baseId) || mintIds.has(row.mintId) || tiles.has(row.tileId)
      || tile.realmId !== 'crownlands') throw new Error('Invalid, retired, duplicate or non-Crownlands migration target');
    baseIds.add(row.baseId); mintIds.add(row.mintId); tiles.add(row.tileId);
  }
}

export function planFantasyMigration(input: {
  snapshotAt: string; active: MigrationIdentity[]; inactive: MigrationIdentity[];
  exclusions: RetirementIdentity[];
  existing?: ReadonlyArray<{ baseId: string; tileId: number; state: 'held' | 'assigned' }>;
  unavailableTileIds?: readonly number[];
}): FantasyMigrationManifest {
  const existing = new Map((input.existing ?? []).map((claim) => [claim.baseId, claim]));
  const unavailable = new Set([...(input.unavailableTileIds ?? []), ...(input.existing ?? []).map((claim) => claim.tileId)]);
  const ranked = crownlandsMigrationTiles(); let cursor = 0;
  const entries: MigrationEntry[] = [];
  for (const [cohort, state] of [[input.active, 'assigned'], [input.inactive, 'held']] as const) {
    for (const identity of [...cohort].sort(compareId)) {
      const prior = existing.get(identity.baseId);
      if (prior) { entries.push({ ...identity, tileId: prior.tileId, state: prior.state }); continue; }
      while (ranked[cursor] && unavailable.has(ranked[cursor]!.tileId)) cursor++;
      const tile = ranked[cursor++];
      if (!tile) throw new Error('Insufficient Crownlands migration capacity');
      unavailable.add(tile.tileId);
      entries.push({ ...identity, tileId: tile.tileId, state });
    }
  }
  const manifest: FantasyMigrationManifest = {
    version: 1, worldId: FANTASY_WORLD_ID, catalogHash: FANTASY_CATALOG_HASH,
    snapshotAt: input.snapshotAt, entries, exclusions: [...input.exclusions].sort(compareId),
  };
  validateFantasyManifest(manifest);
  return manifest;
}

export interface FantasyMigrationResult {
  manifestHash: string; inserted: number; retained: number; excluded: number;
  pendingLegacyHeld: number; dryRun: boolean;
}
class DryRunRollback extends Error {
  constructor(readonly result: FantasyMigrationResult) { super('Fantasy migration dry run rollback'); }
}

/** Historical restore rehearsals intentionally use as-of-snapshot ownership.
 * The release path below requires current evidence and cannot use that clock. */
export async function rehearseFantasyMigration(db: Db, manifest: FantasyMigrationManifest, expectedManifestHash: string): Promise<FantasyMigrationResult> {
  return runFantasyMigration(db, manifest, expectedManifestHash, { rehearsal: true, dryRun: false });
}

/** No deployment or RPC is performed here. CLI approval/build guards precede
 * this call; this core additionally requires explicitly staged sales flags.
 * Dry run executes the same constraints and then rolls back the transaction. */
export async function applyFantasyMigration(db: Db, manifest: FantasyMigrationManifest, expectedManifestHash: string,
  options: { dryRun: boolean }): Promise<FantasyMigrationResult> {
  if (process.env['FANTASY_WORLD_ENABLED'] !== 'false' || process.env['MULTI_BASE_ENABLED'] !== 'true') {
    throw new Error('Fantasy migration requires staged FANTASY_WORLD_ENABLED=false and MULTI_BASE_ENABLED=true');
  }
  try { return await runFantasyMigration(db, manifest, expectedManifestHash, { rehearsal: false, dryRun: options.dryRun }); }
  catch (error) { if (error instanceof DryRunRollback) return error.result; throw error; }
}

async function runFantasyMigration(db: Db, manifest: FantasyMigrationManifest, expectedManifestHash: string,
  options: { rehearsal: boolean; dryRun: boolean }): Promise<FantasyMigrationResult> {
  validateFantasyManifest(manifest);
  const manifestHash = fantasyManifestHash(manifest);
  if (manifestHash !== expectedManifestHash) throw new Error('Fantasy manifest approval hash mismatch');
  return db.transaction(async (tx) => {
    const [database] = await tx.execute<{ name: string }>(sql`select current_database() as name`);
    if (options.rehearsal && !database?.name.endsWith('_test')) throw new Error('Fantasy rehearsal requires an isolated _test database');
    const pending = options.rehearsal ? [] : await pendingLegacyFantasyPurchases(tx);
    const ids = [...new Set([...manifest.entries.map((entry) => entry.baseId), ...manifest.exclusions.map((entry) => entry.baseId), ...pending.map(row => row.baseId)])].sort();
    // Lock current owners, not historical manifest wallets, so an idempotent
    // rerun remains valid after a deed transfer without changing its location.
    const before = ids.length ? await tx.select().from(bases).where(inArray(bases.id, ids)) : [];
    const wallets = [...new Set([...before.map((base) => base.ownerWallet), ...pending.map(row => row.wallet)])].sort();
    if (wallets.length) await tx.select().from(players).where(inArray(players.wallet, wallets)).orderBy(asc(players.wallet)).for('update');
    const locked = ids.length ? await tx.select().from(bases).where(inArray(bases.id, ids)).orderBy(asc(bases.id)).for('update') : [];
    if (locked.length !== ids.length || locked.some((base) => !wallets.includes(base.ownerWallet))) {
      throw new Error('Fantasy manifest base identity changed while locking');
    }
    if (pending.length) await tx.select().from(deposits).where(inArray(deposits.id, pending.map(row => row.depositId))).orderBy(asc(deposits.id)).for('update');
    const byId = new Map(locked.map((base) => [base.id, base]));
    await installFantasyCatalog(tx);
    for (const exclusion of manifest.exclusions) {
      const base = byId.get(exclusion.baseId)!;
      if (base.deedAssetId !== exclusion.mintId) throw new Error('Retirement mint no longer matches the reviewed base');
      const [prior] = await tx.select().from(fantasyRetirementExclusions)
        .where(eq(fantasyRetirementExclusions.baseId, exclusion.baseId));
      if (prior) {
        if (prior.mintId !== exclusion.mintId || prior.receiptId !== exclusion.receiptId
          || prior.abandonReceiptId !== exclusion.abandonReceiptId) throw new Error('Retirement evidence changed');
      } else {
        await tx.insert(fantasyRetirementExclusions).values({
          ...exclusion, evidenceHash: createHash('sha256').update(canonical(exclusion)).digest('hex'),
        });
      }
    }
    await tx.insert(fantasyMigrationBatches).values({ manifestHash, worldId: manifest.worldId, manifest })
      .onConflictDoNothing();
    let inserted = 0; let retained = 0;
    for (const entry of manifest.entries) {
      const base = byId.get(entry.baseId)!;
      if (!base.landPaidAt || base.deedAssetId !== entry.mintId) throw new Error('Reviewed paid deed identity changed');
      const prior = await getFantasyClaim(tx, entry.baseId);
      if (prior) {
        if (prior.worldId !== manifest.worldId || prior.tileId !== entry.tileId || prior.expectedMint !== entry.mintId
          || (prior.state === 'held' && entry.state === 'assigned')) {
          throw new Error('Existing fantasy assignment cannot be reshuffled');
        }
        // A legitimate later activation may have promoted this original hold.
        // Replaying its historical manifest retains the assigned location;
        // a new manifest cannot silently promote a still-held destination.
        retained++; continue;
      }
      if (base.ownerWallet !== entry.ownerWallet) throw new Error('Reviewed deed owner changed before migration');
      if (entry.state === 'assigned') {
        const [slot] = await tx.select().from(baseSlots).where(and(
          eq(baseSlots.baseId, entry.baseId), eq(baseSlots.wallet, entry.ownerWallet), eq(baseSlots.active, true),
        )).for('update');
        const [observation] = await tx.select().from(deedOwnershipObservations)
          .where(eq(deedOwnershipObservations.baseId, entry.baseId))
          .orderBy(desc(deedOwnershipObservations.checkedAt), desc(deedOwnershipObservations.id)).limit(1).for('update');
        const age = observation ? (options.rehearsal ? Date.parse(manifest.snapshotAt) : Date.now()) - observation.checkedAt.getTime() : Infinity;
        if (base.status !== 'active' || !slot || observation?.status !== 'owned' || observation.slot === null
          || observation.assetId !== entry.mintId || observation.owner !== entry.ownerWallet
          || (options.rehearsal ? Math.abs(age) : age) > BASE_OWNERSHIP.observationHealthFreshnessMs || (!options.rehearsal && age < 0)) {
          throw new Error(options.rehearsal ? 'Reviewed active deed lacks matching as-of-snapshot ownership evidence' : 'Active deed lacks fresh finalized ownership evidence at apply time');
        }
      } else if (base.status !== 'inactive') {
        throw new Error('Inactive reserve cohort changed before migration');
      }
      await tx.insert(fantasyLandClaims).values({
        worldId: manifest.worldId, tileId: entry.tileId, baseId: entry.baseId, state: entry.state,
        source: entry.state === 'assigned' ? 'migration-active' : 'migration-inactive',
        expectedMint: entry.mintId, manifestHash,
        assignedAt: entry.state === 'assigned' ? new Date() : null,
      });
      inserted++;
    }
    const pendingLegacyHeld = options.rehearsal ? 0 : await stageLockedLegacyFantasyPurchases(tx, pending);
    if (!options.rehearsal) await activateFantasyPurchaseCutover(tx);
    const result = { manifestHash, inserted, retained, excluded: manifest.exclusions.length, pendingLegacyHeld, dryRun: options.dryRun };
    if (options.dryRun) throw new DryRunRollback(result);
    return result;
  });
}
