/** Original actor consent and recovery, independent of current custody/flags. */
import { StarterFleetEnvelopeSchema, StarterFleetReceiptSchema, StarterFleetRequestSchema,
  type StarterFleetReceipt, type StarterFleetRequest } from '@shardkeep/shared/starterFleetApi';
import { and, eq, sql } from 'drizzle-orm';
import { starterExpeditionsEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { builderJobs, fleetInstallations, players, starterFleetCommands } from '../db/schema';
import { HttpError } from '../lib/errors';
import { installStarterFleet } from './starterFleet';
import type { StableBaseMutationContext } from './stableBasePrerequisites';

const mismatch = () => new HttpError(409, 'Starter key belongs to another original command', 'IDEMPOTENCY_BODY_MISMATCH');
export function assertStarterInstallationsEnabled() {
  if (!starterExpeditionsEnabled()) throw new HttpError(503, 'Starter installations are paused', 'PHASE_E_DISABLED');
}
export async function readStarterFleetCommand(db: DbOrTx, wallet: string, key: string, mutation = false): Promise<StarterFleetReceipt | null> {
  // Inspect only actor first. A foreign proof is never validated or disclosed.
  const [identity] = await db.select({ actor: starterFleetCommands.actorWallet }).from(starterFleetCommands).where(eq(starterFleetCommands.id, key));
  if (!identity) return null;
  if (identity.actor !== wallet) { if (mutation) throw mismatch(); return null; }
  const [row] = await db.select().from(starterFleetCommands).where(and(eq(starterFleetCommands.id, key), eq(starterFleetCommands.actorWallet, wallet)));
  if (!row) throw new Error('Original starter command disappeared');
  const [install] = await db.select().from(fleetInstallations).where(eq(fleetInstallations.id, row.installationId));
  const [job] = await db.select().from(builderJobs).where(eq(builderJobs.id, row.completedBuildJobId));
  if (!install || install.baseId !== row.baseId || install.berthId !== row.berthId || install.family !== 'starter'
    || install.completedBuildJobId !== row.completedBuildJobId || install.berthCompletedAt.getTime() !== row.berthCompletedAt.getTime()
    || install.createdAt.getTime() !== row.installedAt.getTime() || !job || job.baseId !== row.baseId
    || job.buildingId !== row.berthId || job.kind !== 'build' || job.cancelledAt || job.completedAt?.getTime() !== row.berthCompletedAt.getTime())
    throw new Error('Invalid original starter installation proof');
  return StarterFleetReceiptSchema.parse({ wallet, request: { idempotencyKey: row.id, baseId: row.baseId, berthId: row.berthId },
    installation: { installationId: row.installationId, baseId: row.baseId, berthId: row.berthId, family: 'starter',
      completedBuildJobId: row.completedBuildJobId, berthCompletedAt: row.berthCompletedAt.toISOString(), installedAt: row.installedAt.toISOString() },
    acceptedAt: row.acceptedAt.toISOString() });
}
export function matchStarterFleetCommand(proof: StarterFleetReceipt, request: StarterFleetRequest) {
  if (JSON.stringify(proof.request) !== JSON.stringify(StarterFleetRequestSchema.parse(request))) throw mismatch();
  return proof;
}
export function starterFleetEnvelope(wallet: string, key: string, receipt: StarterFleetReceipt | null, now = new Date()) {
  return StarterFleetEnvelopeSchema.parse({ wallet, idempotencyKey: key, serverNow: now.toISOString(),
    status: receipt ? 'accepted' : 'unknown', receipt });
}
export async function installStarterFleetCommand(db: DbOrTx, wallet: string, raw: StarterFleetRequest, authority: StableBaseMutationContext) {
  const request = StarterFleetRequestSchema.parse(raw);
  const prior = await readStarterFleetCommand(db, wallet, request.idempotencyKey, true);
  if (prior) return matchStarterFleetCommand(prior, request);
  assertStarterInstallationsEnabled();
  try { return await (db as Db).transaction(async tx => {
    const [actor] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!actor) throw new HttpError(404, 'player not found');
    const original = await readStarterFleetCommand(tx, wallet, request.idempotencyKey, true);
    if (original) return matchStarterFleetCommand(original, request);
    if (authority.baseId !== request.baseId) throw mismatch();
    // Reuse the registry's canonical base/slot/raid/facility admission. This
    // callback runs under its locks, before it can read or create an install.
    const installed = await installStarterFleet(tx, wallet, request.berthId, { ...authority,
      assertAuthority: async (locked, actor, baseId) => {
        await authority.assertAuthority(locked, actor, baseId); assertStarterInstallationsEnabled();
      } });
    // Retain the database timestamp exactly (sub-ms SQL precision is not a DTO).
    const [row] = await tx.select().from(fleetInstallations).where(eq(fleetInstallations.id, installed.installationId));
    if (!row) throw new Error('Starter installation disappeared');
    await tx.insert(starterFleetCommands).values({ id: request.idempotencyKey, actorWallet: wallet,
      baseId: request.baseId, berthId: request.berthId, installationId: row.id, completedBuildJobId: row.completedBuildJobId,
      berthCompletedAt: sql`(SELECT berth_completed_at FROM fleet_installations WHERE id=${row.id})`,
      installedAt: sql`(SELECT created_at FROM fleet_installations WHERE id=${row.id})`, acceptedAt: new Date() });
    const proof = await readStarterFleetCommand(tx, wallet, request.idempotencyKey, true);
    if (!proof) throw new Error('Starter command was not persisted');
    return proof;
  }); } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code
      ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === '23505') {
      // A different actor can race the globally unique key from another base.
      // The losing installation has already rolled back with its transaction.
      const winner = await readStarterFleetCommand(db, wallet, request.idempotencyKey, true);
      if (winner) return matchStarterFleetCommand(winner, request);
    }
    throw error;
  }
}
