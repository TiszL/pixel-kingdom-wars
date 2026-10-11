/**
 * Hero commitment ownership across the stable-base cutover.
 *
 * MULTI_BASE uses the stable deed identity: two deeds may independently commit
 * their own Vex, and a transfer never releases or rekeys the commitment. Flag-
 * off raids retain the wallet key. Durable raid identity—not today's feature
 * flag—selects the arm, so rollback reads cannot reinterpret a commitment.
 */
import { BASE_OWNERSHIP, HERO_KEYS, type HeroKey } from '@shardkeep/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { heroRaidReservations, raids } from '../db/schema';
import { HttpError } from '../lib/errors';

export type HeroReservationRaid = Pick<
  typeof raids.$inferSelect,
  'id' | 'attackerWallet' | 'attackerBaseId'
>;

/** Reservations follow the persisted raid identity, never the current feature
 * flag. A rollback may read stable rows after the flag changes; switching on
 * an ambient flag here would reinterpret durable custody. */
function raidScopePredicate(raid: HeroReservationRaid) {
  return raid.attackerBaseId
    ? and(
      eq(heroRaidReservations.baseId, raid.attackerBaseId),
      isNull(heroRaidReservations.playerWallet),
    )
    : and(
      eq(heroRaidReservations.playerWallet, raid.attackerWallet),
      isNull(heroRaidReservations.baseId),
    );
}

function isHeroReservationConflict(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  const code = (error as { code?: string }).code ?? cause?.code;
  const constraint = String(
    (error as { constraint_name?: string }).constraint_name
      ?? cause?.constraint_name
      ?? (error as Error).message,
  );
  return code === '23505' && (
    constraint.includes('hero_raid_reservations_base_hero_uq')
    || constraint.includes('hero_raid_reservations_player_hero_pk')
    // A repeated hero in one input is the same rejected commitment, not a 500.
    || constraint.includes('hero_raid_reservations_raid_hero_uq')
  );
}

/** Reserve each hero exactly once for this stable base (or fenced legacy
 * wallet). The caller owns the surrounding raid/energy transaction. */
export async function reserveRaidHeroes(
  db: DbOrTx,
  raid: HeroReservationRaid,
  heroes: readonly HeroKey[],
): Promise<void> {
  if (heroes.length === 0) return;
  try {
    await db.insert(heroRaidReservations).values(heroes.map((hero) => ({
      ...(raid.attackerBaseId
        ? { baseId: raid.attackerBaseId }
        : { playerWallet: raid.attackerWallet }),
      hero,
      raidId: raid.id,
    })));
  } catch (error) {
    if (isHeroReservationConflict(error)) {
      throw new HttpError(
        409,
        'a hero is already committed to another unresolved raid',
        'HERO_ALREADY_COMMITTED',
      );
    }
    throw error;
  }
}

export async function releaseRaidHeroes(
  db: DbOrTx,
  raidIds: readonly string[],
): Promise<void> {
  if (raidIds.length === 0) return;
  await db.delete(heroRaidReservations).where(inArray(heroRaidReservations.raidId, [...raidIds]));
}

/** Exact submit-time fence: a reservation from another base or the legacy arm
 * can never authorize this raid's hero deployment. */
export async function reservedRaidHeroes(
  db: DbOrTx,
  raid: HeroReservationRaid,
): Promise<HeroKey[]> {
  const rows = await db.select({ hero: heroRaidReservations.hero })
    .from(heroRaidReservations)
    .where(and(eq(heroRaidReservations.raidId, raid.id), raidScopePredicate(raid)));
  return rows.map((row) => row.hero);
}

/** Lost-create-response recovery remains attacker-authorized by the immutable
 * raid row. This naturally spans all of the wallet's deeds without restoring a
 * wallet-wide hero uniqueness fence. */
export async function pendingHeroReservationRaidIds(
  db: DbOrTx,
  attackerWallet: string,
): Promise<string[]> {
  const rows = await db.selectDistinct({ raidId: heroRaidReservations.raidId })
    .from(heroRaidReservations)
    .innerJoin(raids, eq(raids.id, heroRaidReservations.raidId))
    .where(and(
      eq(raids.attackerWallet, attackerWallet),
      or(
        and(
          isNull(raids.attackerBaseId),
          isNull(heroRaidReservations.baseId),
          eq(heroRaidReservations.playerWallet, attackerWallet),
        ),
        and(
          isNull(heroRaidReservations.playerWallet),
          eq(heroRaidReservations.baseId, raids.attackerBaseId),
        ),
      ),
    ))
    .limit(BASE_OWNERSHIP.maxActive * HERO_KEYS.length);
  return rows.map((row) => row.raidId);
}
