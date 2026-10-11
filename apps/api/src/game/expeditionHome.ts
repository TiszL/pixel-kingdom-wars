/** DARK D-153.17 home authority only. No route, dispatch, yield or stock credit.
 * Future admission must call inside its DbTx and freeze returned evidence with
 * the job; the return value is not a reusable access token. */
import { PHASE_E_STARTER_ACCESS } from '@shardkeep/shared';
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, getFantasyTile } from '@shardkeep/shared/fantasyWorld';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { bases, deposits, expeditionFreeHomes, fantasyWorldCatalog, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { getFantasyClaim, isFantasyRetired, resolveFantasyLocation } from './fantasyLocationRead';
import { lockStablePrerequisiteBase, type StableBaseMutationContext } from './stableBasePrerequisites';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const common = { version: z.literal(1), baseId: uuid, custodyWallet: z.string().min(1) };
/** Evidence v1 pins its historical realm/policy even if a later policy changes. */
export const ExpeditionHomeEvidenceSchema = z.discriminatedUnion('source', [
  z.object({ ...common, source: z.literal('free_assignment'), realmId: z.literal('crownlands'),
    evidence: z.object({ id: uuid, version: z.literal(1), assignedWallet: z.string().min(1),
      provenance: z.literal('authenticated_free_home_v1'), assignedAt: z.string().datetime() }).strict(),
  }).strict(),
  z.object({ ...common, source: z.literal('deed_location'), realmId: z.enum(REALM_IDS),
    evidence: z.object({ id: uuid, version: z.literal(1), deedAssetId: z.string().min(1),
      worldId: z.literal(FANTASY_WORLD_ID), tileId: z.number().int().nonnegative(),
      catalogHash: z.literal(FANTASY_CATALOG_HASH),
      claimSource: z.enum(['purchase', 'migration-active', 'migration-inactive']),
      assignedAt: z.string().datetime(),
    }).strict(),
  }).strict(),
]).refine(value => {
  if (value.source === 'free_assignment') return true;
  const tile = getFantasyTile(value.evidence.tileId);
  return tile?.allocation === 'ordinary' && tile.realmId === value.realmId;
}, 'Home evidence must identify canonical ordinary deed land');
export type ExpeditionHomeEvidence = z.infer<typeof ExpeditionHomeEvidenceSchema>;
const unavailable = () => new HttpError(409, 'The base has no authoritative expedition home', 'EXPEDITION_HOME_UNAVAILABLE');

type LockedBase = typeof bases.$inferSelect;
type FreePolicyPreview = { source: 'free_policy_preview'; version: number; realmId: typeof PHASE_E_STARTER_ACCESS.freeHomeRealm };
export type ExpeditionHomePreview = { source: 'free_assignment' | 'deed_location' | 'free_policy_preview';
  version: number; realmId: ExpeditionHomeEvidence['realmId'] };

function freeEvidence(base: LockedBase, home: typeof expeditionFreeHomes.$inferSelect): ExpeditionHomeEvidence {
  if (home.baseId !== base.id) throw unavailable();
  return ExpeditionHomeEvidenceSchema.parse({ version: 1, baseId: base.id, custodyWallet: base.ownerWallet,
    source: 'free_assignment', realmId: home.realmId,
    evidence: { id: home.id, version: home.policyVersion, assignedWallet: home.assignedWallet,
      provenance: home.provenance, assignedAt: home.createdAt.toISOString() } });
}

/** Shared current-home predicate. Caller owns the authorized player/base/slot
 * locks. Reading an unassigned free home never manufactures persisted proof. */
async function readCurrentHome(tx: DbTx, base: LockedBase): Promise<ExpeditionHomeEvidence | FreePolicyPreview> {
  if (await isFantasyRetired(tx, base.id, base.deedAssetId)) throw unavailable();
  const free = base.landPaidAt === null && base.deedAssetId === null
    && base.deedMintAssetId === null && base.deedMintingAt === null;
  if (free) {
    if (await getFantasyClaim(tx, base.id)) throw unavailable();
    const [home] = await tx.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId, base.id));
    return home ? freeEvidence(base, home) : { source: 'free_policy_preview',
      version: PHASE_E_STARTER_ACCESS.policyVersion, realmId: PHASE_E_STARTER_ACCESS.freeHomeRealm };
  }
  // Paid-but-unminted bases never reuse an old free assignment.
  if (!base.deedAssetId || base.deedMintingAt !== null
    || (base.deedMintAssetId !== null && base.deedMintAssetId !== base.deedAssetId)) throw unavailable();
  const tile = await resolveFantasyLocation(tx, base.id);
  const claim = await getFantasyClaim(tx, base.id);
  const [catalog] = await tx.select().from(fantasyWorldCatalog).where(eq(fantasyWorldCatalog.worldId, FANTASY_WORLD_ID));
  if (!tile || !claim || claim.state !== 'assigned' || !claim.assignedAt
    || claim.tileId !== tile.tileId || claim.worldId !== tile.worldId || catalog?.catalogHash !== FANTASY_CATALOG_HASH) throw unavailable();
  if (claim.source === 'purchase') {
    if (!claim.depositId) throw unavailable();
    const [deposit] = await tx.select().from(deposits).where(eq(deposits.id, claim.depositId));
    const payload = deposit?.payload as Record<string, unknown> | undefined;
    // Current owner may differ from payer after sale. Bind original base;
    // dev-login land cannot become production proof by flipping NODE_ENV.
    if (!deposit || deposit.status !== 'credited' || !['entry', 'deed'].includes(deposit.kind)
      || payload?.baseId !== base.id || payload.devFixture !== undefined
      || deposit.reference.startsWith('dev-fantasy:')) throw unavailable();
  }
  return ExpeditionHomeEvidenceSchema.parse({ version: 1, baseId: base.id, custodyWallet: base.ownerWallet,
    source: 'deed_location', realmId: tile.realmId,
    evidence: { id: claim.id, version: 1, deedAssetId: base.deedAssetId, worldId: tile.worldId,
      tileId: tile.tileId, catalogHash: FANTASY_CATALOG_HASH, claimSource: claim.source,
      assignedAt: claim.assignedAt.toISOString() } });
}

/** Public read projection only, inside an already authorized locked base
 * snapshot. Raids do not prevent reads; integrity failures must remain visible. */
export async function readExpeditionHomePreview(tx: DbTx, base: LockedBase): Promise<ExpeditionHomePreview | null> {
  try {
    const home = await readCurrentHome(tx, base);
    return { source: home.source, version: home.source === 'free_policy_preview' ? home.version : home.evidence.version,
      realmId: home.realmId };
  } catch (error) {
    if (error instanceof HttpError && error.code === 'EXPEDITION_HOME_UNAVAILABLE') return null;
    throw error;
  }
}

/** Current authenticated wallet and exact dispatch base only. Reauthorize saved
 * assignments too; never borrow another owned deed or a selected-base fallback. */
export async function resolveExpeditionHome(
  db: DbOrTx, wallet: string, authority: StableBaseMutationContext,
): Promise<ExpeditionHomeEvidence> {
  authority = { ...authority, baseId: uuid.parse(authority.baseId) };
  return (db as Db).transaction(async tx => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const base = await lockStablePrerequisiteBase(tx, wallet, authority);
    const current = await readCurrentHome(tx, base);
    if (current.source !== 'free_policy_preview') return current;
    const [home] = await tx.insert(expeditionFreeHomes).values({ baseId: base.id, assignedWallet: base.ownerWallet,
      realmId: current.realmId, policyVersion: current.version, provenance: 'authenticated_free_home_v1' }).returning();
    if (!home) throw unavailable();
    return freeEvidence(base, home);
  });
}
