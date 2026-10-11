/**
 * Land ownership — the ONE predicate behind the deedless/landowner PARTITION
 * (docs/LAND-DEED-ONBOARDING-PLAN.md, LOCKED OWNER DECISIONS 2026-08-09).
 *
 * Onboarding is free: a player signs up, gets a base, buildings, army, heroes
 * and shards, and owns NO land until they pay 0.2 SOL on-chain. Land ownership
 * is `players.entryPaidAt IS NOT NULL` — the column keeps its exact original
 * meaning ("this wallet paid 0.2 SOL on-chain"), which is why deedMetadata's
 * Founded trait, the deposit watcher's stamp and baseTransfer need no diff.
 *
 * WHY THIS IS THE PREDICATE AND NOT "has a plot row":
 * `entryPaidAt` is the AUTHORIZATION column — it is what the route gate reads,
 * and using a second, derived predicate for the same concept is how two sources
 * of truth drift. Plot absence is the complementary MAP mechanism (the roster is
 * `plots INNER JOIN players`, so a plotless base yields no map row and cannot be
 * found, scouted or picked). One column decides who you may fight; plot absence
 * decides whether you can be seen.
 *
 * THE ATTACKABILITY INVARIANT, RESTATED HONESTLY (F9, 2026-08-09; D-099,
 * 2026-09-02). INV-1 used to read `(base exists) × shield × warzone`. This file
 * adds a factor and D-099 adds another, so it is now
 *
 *     (base exists) × sameLandTier(attacker, defender) × keepReach × shield × warzone
 *
 * where keepReach is `pvpAttackAllowed` in packages/shared (the defender's Keep is
 * at least half the attacker's; the weaker side can always attack up). Trophies
 * are NOT a factor — they only order auto-match candidates — and every comment
 * that still states a three-factor or trophy-window form is stale. What the
 * ITEMS-plan §8 fix actually forbids is INTACT and is the half that matters:
 * NOTHING in the raid path reads deed or DAS state, so listing or selling a deed
 * cannot change who may attack you. The land factor reads `players.entryPaidAt`,
 * which is written only by the deposit watcher (money/depositWatcher.ts) and by
 * `transferBase` (game/baseTransfer.ts) — so neither tier change is a dodge:
 * paying moves you INTO the paid pool where everyone can be raided, and a base
 * transfer hands the parcel and its exposure to the buyer. Do NOT couple
 * attackability to deed/DAS state; couple it to this column only.
 *
 * THE PARTITION: matchmaking is two SEALED pools. A deedless attacker only ever
 * meets deedless defenders; a landowner only ever meets landowners. Enforced on
 * BOTH the auto-match candidate query and every explicitly-named defender, so no
 * route can reach across the boundary. Deedless bases are invisible to the paid
 * world, which is the whole reason they need no shield row.
 */
import { isNotNull, isNull, type SQL } from 'drizzle-orm';
import { players } from '../db/schema';

/** True when this wallet has paid for its land (`players.entryPaidAt` stamped). */
export function hasLand(p: { entryPaidAt: Date | null }): boolean {
  return p.entryPaidAt != null;
}

/** Both rows on the SAME side of the land boundary — the raid/scout precondition. */
export function sameLandTier(
  a: { entryPaidAt: Date | null },
  b: { entryPaidAt: Date | null },
): boolean {
  return hasLand(a) === hasLand(b);
}

/**
 * SQL half of the partition, for candidate queries over `players`. Passing the
 * ATTACKER's own tier is what seals the pool: there is deliberately no "either"
 * value, so a caller cannot accidentally query the union.
 */
export function landTierFilter(owned: boolean): SQL {
  return owned ? isNotNull(players.entryPaidAt) : isNull(players.entryPaidAt);
}
