/** Deed-owned player progression used by raid admission and settlement.
 *
 * A wallet is only the current authority. Trophies, league state and purchased
 * raid energy remain attached to the stable base id when its deed changes
 * hands. (base_profiles.keep_skin is a DEAD column: all-NULL since 0077 and
 * its setter was deleted with the keep-skin removal, M23 a8 — kept in the
 * schema under the additive no-migration discipline.)
 */
import { TROPHIES, type League } from '@shardkeep/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { baseProfiles } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockActiveBase, resolveActiveBase } from './baseOwnership';

export type BaseProfile = typeof baseProfiles.$inferSelect;

/** New deeds start empty; migrated primary deeds were populated by 0074. */
export async function ensureBaseProfile(db: DbOrTx, baseId: string): Promise<BaseProfile> {
  await db.insert(baseProfiles).values({ baseId }).onConflictDoNothing();
  const [profile] = await db.select().from(baseProfiles).where(eq(baseProfiles.baseId, baseId));
  if (!profile) throw new Error(`base profile missing after ensure: ${baseId}`);
  return profile;
}

/** Read a selected active deed after DB ownership authority has been checked. */
export async function getSelectedBaseProfile(
  db: Db, wallet: string, requestedBaseId?: string,
): Promise<BaseProfile> {
  const selected = await resolveActiveBase(db, wallet, requestedBaseId);
  if (!selected) throw new HttpError(404, 'base not found', 'BASE_NOT_OWNED');
  return ensureBaseProfile(db, selected.base.id);
}

/** Canonical player -> base -> profile lock for a selected-deed mutation. */
export async function lockSelectedBaseProfile(
  tx: DbTx, wallet: string, requestedBaseId?: string,
): Promise<{ baseId: string; profile: BaseProfile }> {
  const selected = await lockActiveBase(tx, wallet, requestedBaseId);
  await tx.insert(baseProfiles).values({ baseId: selected.base.id }).onConflictDoNothing();
  const [profile] = await tx.select().from(baseProfiles)
    .where(eq(baseProfiles.baseId, selected.base.id)).for('update');
  if (!profile) throw new Error(`base profile missing after ensure: ${selected.base.id}`);
  return { baseId: selected.base.id, profile };
}

/** Caller already owns/locks base authority; used inside raid transactions. */
export async function lockBaseProfile(tx: DbTx, baseId: string): Promise<BaseProfile> {
  await tx.insert(baseProfiles).values({ baseId }).onConflictDoNothing();
  const [profile] = await tx.select().from(baseProfiles)
    .where(eq(baseProfiles.baseId, baseId)).for('update');
  if (!profile) throw new Error(`base profile missing after ensure: ${baseId}`);
  return profile;
}

export async function grantBasePurchasedEnergy(
  tx: DbOrTx, baseId: string, amount = 1, now = new Date(),
): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError('energy amount must be positive');
  await ensureBaseProfile(tx, baseId);
  const [updated] = await tx.update(baseProfiles).set({
    purchasedEnergy: sql`${baseProfiles.purchasedEnergy} + ${amount}`,
    updatedAt: now,
  }).where(eq(baseProfiles.baseId, baseId)).returning({ purchasedEnergy: baseProfiles.purchasedEnergy });
  return updated!.purchasedEnergy;
}

/** Atomic guard: concurrent raid creates can never consume one energy twice. */
export async function consumeBasePurchasedEnergy(
  tx: DbOrTx, baseId: string, now = new Date(),
): Promise<number> {
  await ensureBaseProfile(tx, baseId);
  const [updated] = await tx.update(baseProfiles).set({
    purchasedEnergy: sql`${baseProfiles.purchasedEnergy} - 1`,
    updatedAt: now,
  }).where(sql`${baseProfiles.baseId} = ${baseId} AND ${baseProfiles.purchasedEnergy} > 0`)
    .returning({ purchasedEnergy: baseProfiles.purchasedEnergy });
  if (!updated) throw new HttpError(422, 'no purchased raid energy available');
  return updated.purchasedEnergy;
}

export async function snapshotBaseLeagueWeek(
  tx: DbOrTx, baseId: string, league: League, trophies: number, now = new Date(),
): Promise<void> {
  await ensureBaseProfile(tx, baseId);
  await tx.update(baseProfiles).set({ league, weekStartTrophies: trophies, updatedAt: now })
    .where(eq(baseProfiles.baseId, baseId));
}

export interface BaseTrophyOutcome {
  attackerDelta: number;
  defenderDelta: number;
  attackerTrophies: number;
  defenderTrophies: number;
}

/** Apply the existing Elo-damped outcome to the two deed profiles.
 * Profiles lock by stable UUID so opposing simultaneous raids cannot deadlock. */
export async function applyBasePvpTrophies(
  tx: DbTx,
  attackerBaseId: string,
  defenderBaseId: string,
  stars: 0 | 1 | 2 | 3,
  now = new Date(),
): Promise<BaseTrophyOutcome> {
  if (attackerBaseId === defenderBaseId) throw new HttpError(422, 'cannot raid the same base');
  await tx.insert(baseProfiles).values([{ baseId: attackerBaseId }, { baseId: defenderBaseId }])
    .onConflictDoNothing();
  const locked = await tx.select().from(baseProfiles)
    .where(inArray(baseProfiles.baseId, [attackerBaseId, defenderBaseId]))
    .orderBy(asc(baseProfiles.baseId)).for('update');
  const attacker = locked.find((p) => p.baseId === attackerBaseId);
  const defender = locked.find((p) => p.baseId === defenderBaseId);
  if (!attacker || !defender) throw new Error('raid base profile missing after ensure');

  const gap = attacker.trophies - defender.trophies;
  const factor = Math.min(TROPHIES.maxFactorBps, Math.max(
    TROPHIES.minFactorBps,
    10_000 - gap * TROPHIES.dampBpsPerTrophy,
  ));
  const attackerDelta = stars > 0
    ? Math.max(1, Math.round((TROPHIES.winByStars[stars - 1] ?? 0) * factor / 10_000))
    : Math.min(-1, Math.round(
      TROPHIES.zeroStarLoss * (TROPHIES.lossInversionBps - factor) / 10_000,
    ));
  const defenderDelta = -attackerDelta;
  const attackerTrophies = Math.max(0, attacker.trophies + attackerDelta);
  const defenderTrophies = Math.max(0, defender.trophies + defenderDelta);
  await tx.update(baseProfiles).set({ trophies: attackerTrophies, updatedAt: now })
    .where(eq(baseProfiles.baseId, attackerBaseId));
  await tx.update(baseProfiles).set({ trophies: defenderTrophies, updatedAt: now })
    .where(eq(baseProfiles.baseId, defenderBaseId));
  return { attackerDelta, defenderDelta, attackerTrophies, defenderTrophies };
}
