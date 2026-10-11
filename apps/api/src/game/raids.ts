import {raidAdvancedFields,readRaidAdvancedCapture,readRaidAdvancedCandidate,type RaidAdvancedPresentation} from './raidAdvancedPresentation';
import {raidStarterFields,readRaidStarterPresentation,type RaidStarterPresentation} from './raidStarterPresentation';
import {readStarterFleetView} from './starterFleetView';
import {readStarterServicePresentation} from './starterServicePresentation';
import {isDeepStrictEqual} from 'node:util';
import {boundCosmeticRaidFields} from './boundCosmeticPresentation';
import type {BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import { resolveOriginalClanRaidChest, assertOriginalClanRaidChestPosting } from './clanCharterRaidChest';
import { captureCharterArmyChange } from './clanCharterRaidDisposition';
import { canResolveWithCurrentSimulator } from './raidSimVersion';
import { plotVersionForClaim } from '@shardkeep/shared';
import { RAID_BATTLEFIELD, BuildingType } from '@shardkeep/shared';
import { markRaidBaseChanged, raidEventTransaction } from '../lib/raidEventBus';
import { settleDueStarterExpeditions } from './starterExpeditionReturns';
import { settleAdvancedExpeditionsAtBoundary } from './advancedExpeditionReturns';
import { settleDueOrdinaryCrafting } from './ordinaryCrafting';
import { lockHarvesterWalletsForBases, settleDueHarvesterSources } from './harvesterSettlement';
/**
 * Raids end-to-end (ECONOMY.md §4, ✅ LOCKED v3 — GDD §3.3, ARCHITECTURE §5/§6).
 *
 * Flow: POST /raids picks a defender, consumes 1 raid-energy, freezes a defender
 * snapshot + army snapshot + seed and a 60s order deadline → client submits
 * validated deploy orders → the server resolves with the deterministic sim
 * (@shardkeep/sim) → loot moves in the ledger (zero-sum player→player), trophies
 * apply, the defender gets a 48h shield after a one-star-or-better loss, troops are consumed. A replay is
 * exactly (snapshot, orders, seed) + the event log (GDD §3.8).
 *
 * Currency roles (v3):
 * - Raiding costs ENERGY + a SHARD ante, not KEEP. Each PvP raid spends 1
 *   raid-energy (6 free/day, regenerating, then SOL-bought energy) plus shards
 *   scaled by the attacker's Keep level. There is NO daily raid ceiling (owner
 *   2026-07-26): energy and the ante are the whole throttle, so a player who
 *   keeps paying keeps raiding. Energy consume + shard ante + raid INSERT commit
 *   in ONE transaction, tied to the client idempotencyKey (unique), so a retry
 *   returns the existing raid and never double-charges ("no paid but no raid").
 * - Buy energy: pay-per-action on-chain (v3) — a real SOL payment via
 *   shardkeep-core buy_sink (kind=energy) verified at finalized grants +1
 *   purchased energy (money/deposits.ts). Uncapped: energy now stockpiles.
 * - PvE (Ruined Keeps) is free — no energy, no shard ante, no trophies, never
 *   breaks your shield. It runs through createPveRaid, a separate path entirely,
 *   and pvpRaidsToday's `defender IS NOT NULL` filter keeps it out of the count.
 * - Buffs still spend KEEP — which now RECYCLES to emission_pool (ECONOMY.md §4b).
 * - Attacking breaks YOUR shield (GDD §3.3). Shields are SOL-only elsewhere.
 *
 * MATCHMAKING IS PARTITIONED BY LAND OWNERSHIP (locked owner decision 2026-08-09,
 * docs/LAND-DEED-ONBOARDING-PLAN.md): free onboarding creates deedless bases with
 * no parcel, and they form their own sealed pool — deedless players fight only each
 * other, landowners only each other. Enforced in `createRaid` on BOTH the auto-match
 * candidate query and every explicitly-named defender (see ./land.ts).
 *
 * SO THIS FILE ADDS FACTORS TO INV-1, and the three-factor form is stale (F9,
 * 2026-08-09; D-099, 2026-09-02). Attackability is now
 *     (base exists) × sameLandTier(attacker, defender) × keepReach × shield × warzone
 * — ./land.ts is the canonical statement. keepReach is `pvpAttackAllowed` in
 * packages/shared (D-099: a defender's Keep must be at least half the attacker's;
 * the weaker side can always attack up), and TROPHIES ARE NOT A FACTOR: they only
 * ORDER auto-match candidates. What INV-1 actually FORBIDS is intact and is the
 * half that matters: nothing here reads deed or DAS state. That is asserted
 * mechanically — test/land-partition.test.ts greps this whole FILE for the deed-asset
 * column name and fails if it appears anywhere, comments included, so do not name it
 * even to talk about it. Listing or selling a deed therefore still cannot change who
 * may attack you. The land factor reads `players.entryPaidAt`, the payment column,
 * which only the deposit watcher and `transferBase` write; the Keep factor reads
 * `bases.keepLevel` (or `players.keepLevel` while the flag is off), which only the
 * builder job completion writes.
 */
import {
  BUFFS,
  COMBAT_TICK_MS,
  DEFENSES,
  GRID,
  LIVE_RAID,
  RAID_ENERGY,
  RAID_REPLAY_LIMITS,
  RAID_RULES,
  RALLY,
  SHIELD,
  WARZONE,
  STRUCTURES,
  LOOT,
  TROOPS,
  TROOP_ABILITIES,
  TROPHIES,
  TRAP_TYPES,
  TROOP_TYPES,
  isTrainableTroop,
  isDarkAttackerTroop,
  HERO_KEYS,
  HERO_LEVELING,
  HERO_SKILLS,
  HEROES,
  heroTier,
  pvpAttackAllowed,
  pvpAttackShardCostForKeepLevel,
  pvpMinDefenderKeep,
  DeployOrderSchema,
  type BaseSnapshot,
  type BuildingGeometryVersion,
  type HeroCombatLoadout,
  type HeroKey,
  type RaidProtocolVersion,
  type TroopType,
} from '@shardkeep/shared';
import { claimRect, footprintOf } from './footprints';
import {
  SimInputError, SimRepresentationLimitError, SIM_VERSION,
  type RaidOrders, type RaidOutcome, type SimEvent,
} from '@shardkeep/sim';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import {
  accounts, army, baseQuestProgress, questProgress, quests, baseProfiles, baseRaidLocks, bases, baseSlots, buildings, campaignProgress, clans, heroLevels,
  keepCustodyCutoverState, ledgerEntries, ledgerTransactions, obstacles, players, raidCommands, raidLiveStates, raids, shields,
  raidReplayTimelines,
} from '../db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../ledger/accounts';
import { postTransaction, InsufficientFundsError } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import {
  ArmyConsumptionError, baseArmyCoversOrders, consumeArmy,
  darkAttackerRosterEnabled, getArmyState,
} from './army';
import { markRaidAction, utcDay } from './emission';
import { getGameConfig } from './gameConfig';
import { isWarzoneActive } from './warzone';
import { hasLand, landTierFilter, sameLandTier } from './land';
import { progressBaseQuest, progressQuest, progressQuestBatch, progressWeeklyStars } from './quests';
import { serverTrack } from '../telemetry';
import { spendGameCurrency, spendShards } from './spend';
import { clientCurrencyContext, withClientCurrency } from './clientCurrency';
import { spendBaseShards } from './baseEconomy';
import {
  applyBasePvpTrophies,
  consumeBasePurchasedEnergy,
  ensureBaseProfile,
  grantBasePurchasedEnergy,
  lockBaseProfile,
} from './baseProfiles';
import {
  breakBaseShieldOnAttack, getEffectiveShieldStatus, grantBaseDefenseShield,
  invalidateShieldMap, invalidateShieldMapValley, shieldMapValleyId,
} from './baseShields';
import { recordBaseBattle } from './baseBattleHistory';
import {
  admitHeavyRaidSimulation, assertCurrentRaidAttackerAuthority, autoStartDueLiveRaids, batchOrdersSubmitDeadlineAt,
  closeLiveRaidStream, getRaidClock, initializeBatchRaidJournal, initializeLiveRaid,
  raidDatabaseWallNow, raidSimulationActorBound, raidTransactionWallNow, refundUnstartedLiveBuffs, takeEarlyLiveRaidOutcome, validateDropPoint,
} from './liveRaids';
import {
  releaseDeedRaidLoot,
  reserveDeedRaidLoot,
  settleDeedRaidLoot,
} from './raidLoot';
import { getCampForRaid, makeCampaignSnapshot, markCampCleared } from './world';
import { gemsEnabled, heroGearCombatEnabled, multiBaseEnabled } from '../config';
import {
  applyBaseHeroRecoveries,
  baseHeroRaidState,
  recoveringBaseHeroes,
  recruitedHeroPlacementsOf,
} from './heroes';
import { completeDueJobs } from './base';
import {
  resolveBaseHeroLoadouts,
  resolveHeroLoadouts,
  toHeroCombatLoadout,
} from './items';
import {
  assertBaseCampaignStageUnlocked,
  recordBaseCampaignOutcome,
} from './campaign';
import { decodeReplayTimeline, persistReplayTimeline } from './raidReplayArchive';
import { archivedBuildingHealth, safeReplayBuildingHealth } from './raidReplayHealth';
import { campaignBaseVisualHere, currentBaseVisualHere, resolveBaseVisual } from './baseVisual';
import { resolveBaseVisualContext } from '@shardkeep/shared/baseVisual';
import {
  pendingHeroReservationRaidIds,
  releaseRaidHeroes,
  reserveRaidHeroes,
  reservedRaidHeroes,
} from './heroRaidReservations';
import { CAMPAIGN, PVE } from '@shardkeep/shared';
import {
  claimRaidSimulationPermit,
  RaidSimulationBusyError,
  RaidSimulationSystemError,
} from './raidSimulationRunner';

export const OrdersBodySchema = z.object({
  // No `.min(1)`: a HERO-ONLY attack is legal (the tray offers heroes as
  // first-class deploys and the sim handles a troopless order list fine). The
  // "at least one unit" rule moved to the object-level refine below, which
  // counts heroes too — otherwise a hero-only raid 400s at the HTTP boundary
  // and the client, having already fought it locally, shows a false DEFEAT.
  deploys: z.array(DeployOrderSchema).max(RAID_REPLAY_LIMITS.maxDirectDeploys),
  /** D4a: ONE drop per distinct hero (the tray renders a card per recruited
   *  hero and greys it out once placed), so the cap is "how many heroes exist"
   *  and duplicates are rejected — three Theodors was a client bug the server
   *  must not be able to accept. Ownership is validated against the raid's
   *  frozen armySnapshot.heroes (recruited altars at creation time). */
  heroDeploys: z.array(z.object({
    hero: z.enum(HERO_KEYS),
    tx: z.number().int(),
    ty: z.number().int(),
    tMs: z.number().int().nonnegative(),
  })).max(HERO_KEYS.length)
    .refine((a) => new Set(a.map((h) => h.hero)).size === a.length, 'one drop per hero')
    .optional(),
  buffs: z.object({
    warhorn: z.boolean().optional(),
    swiftboots: z.boolean().optional(),
    powdercharge: z.boolean().optional(),
  }).optional(),
  rally: z.object({
    tx: z.number().int().min(0).max(GRID.plotTiles - 1),
    ty: z.number().int().min(0).max(GRID.plotTiles - 1),
    tMs: z.number().int().nonnegative(),
  }).optional(),
  idempotencyKey: z.string().min(8).max(128),
}).refine(
  (b) => b.deploys.length + (b.heroDeploys?.length ?? 0) > 0,
  'deploy at least one unit',
);
export type OrdersBody = z.infer<typeof OrdersBodySchema>;

// ---------------------------------------------------------------------------
// Snapshots + eligibility helpers
// ---------------------------------------------------------------------------

/** Completed buildings only — under-construction rows don't fight (base.ts doc). */
type ActiveRaidBase = {
  id: string;
  ownerWallet: string;
  keepLevel: number;
  expansions: number;
  landPaidAt: Date | null;
};

export type RaidBaseAuthority = (
  wallet: string, baseId: string, lockedDb?: DbOrTx,
) => Promise<void>;

async function activeRaidBases(
  db: DbOrTx, wallet: string, requestedBaseId?: string,
): Promise<ActiveRaidBase[]> {
  return db.select({
    id: bases.id,
    ownerWallet: bases.ownerWallet,
    keepLevel: bases.keepLevel,
    expansions: bases.expansions,
    landPaidAt: bases.landPaidAt,
  }).from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId)).where(and(
    eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
    eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    ...(requestedBaseId ? [eq(bases.id, requestedBaseId)] : []),
  )).orderBy(asc(baseSlots.slot));
}

async function attackerRaidBase(
  db: DbOrTx, wallet: string, requestedBaseId?: string,
): Promise<ActiveRaidBase | null> {
  if (!multiBaseEnabled()) return null;
  const rows = await activeRaidBases(db, wallet, requestedBaseId);
  if (requestedBaseId && rows.length === 0) {
    throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  }
  if (!requestedBaseId && rows.length !== 1) {
    throw new HttpError(409, 'baseId is required when multiple active bases exist', 'BASE_ID_REQUIRED');
  }
  return rows[0]!;
}

async function defenderRaidBase(
  db: DbOrTx, wallet: string | undefined, requestedBaseId?: string,
): Promise<ActiveRaidBase> {
  if (requestedBaseId) {
    const rows = await db.select({
      id: bases.id, ownerWallet: bases.ownerWallet, keepLevel: bases.keepLevel,
      expansions: bases.expansions, landPaidAt: bases.landPaidAt,
    }).from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId)).where(and(
      eq(bases.id, requestedBaseId), eq(bases.status, 'active'), eq(baseSlots.active, true),
      eq(baseSlots.wallet, bases.ownerWallet),
      ...(wallet ? [eq(bases.ownerWallet, wallet), eq(baseSlots.wallet, wallet)] : []),
    )).limit(1);
    if (!rows[0]) throw new HttpError(404, 'defender not found');
    return rows[0];
  }
  if (!wallet) throw new HttpError(404, 'defender not found');
  const rows = await activeRaidBases(db, wallet);
  if (rows.length === 0) throw new HttpError(404, 'defender not found');
  if (rows.length !== 1) {
    throw new HttpError(409, 'defenderBaseId is required when the defender owns multiple bases', 'BASE_ID_REQUIRED');
  }
  return rows[0]!;
}

/** Transfer and raid creation share player -> base -> slot lock order. Exact
 * row locks close the fresh-authority-to-INSERT window without widening a raid
 * into a wallet-wide base lock. */
async function lockRaidBases(
  db: DbOrTx, expected: readonly ActiveRaidBase[],
): Promise<Map<string, ActiveRaidBase>> {
  if (expected.length === 0) return new Map();
  const ids = [...new Set(expected.map((base) => base.id))].sort();
  const rows = await db.select({
    id: bases.id, ownerWallet: bases.ownerWallet, keepLevel: bases.keepLevel,
    expansions: bases.expansions, landPaidAt: bases.landPaidAt, status: bases.status,
  }).from(bases).where(inArray(bases.id, ids)).orderBy(asc(bases.id)).for('update');
  const slots = await db.select({
    baseId: baseSlots.baseId, wallet: baseSlots.wallet, active: baseSlots.active,
  }).from(baseSlots).where(inArray(baseSlots.baseId, ids)).orderBy(asc(baseSlots.baseId)).for('update');
  const result = new Map<string, ActiveRaidBase>();
  for (const wanted of expected) {
    const row = rows.find((candidate) => candidate.id === wanted.id);
    const slot = slots.find((candidate) => candidate.baseId === wanted.id);
    if (!row || row.status !== 'active' || row.ownerWallet !== wanted.ownerWallet
      || !slot?.active || slot.wallet !== wanted.ownerWallet) {
      throw new HttpError(409, 'base ownership changed', 'DEED_OWNERSHIP_CHANGED');
    }
    result.set(row.id, row);
  }
  return result;
}

/** Combat contains completed/armed rows only. V2 additionally freezes the
 * physical footprint of inert construction/spent traps as deployment blockers. */
async function snapshotDefender(
  db: DbOrTx,
  wallet: string,
  stableBase: ActiveRaidBase | null = null,
  now = new Date(),
  geometryVersion?: BuildingGeometryVersion,
): Promise<BaseSnapshot> {
  const rows = await db.execute(sql`
    SELECT b.id, b.type, b.level, b.tx, b.ty, b.trap_spent_at AS "trapSpentAt",
      EXISTS (
        SELECT 1 FROM builder_jobs j
        WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
      ) AS "underConstruction"
    FROM buildings b
    WHERE ${stableBase ? sql`b.base_id = ${stableBase.id}` : sql`b.player_wallet = ${wallet}`}
  `) as unknown as Array<{
    id: string; type: string; level: number; tx: number; ty: number;
    trapSpentAt: Date | null; underConstruction: boolean;
  }>;
  const participates = (building: typeof rows[number]): boolean => !building.underConstruction
    && (!(TRAP_TYPES as readonly string[]).includes(building.type) || !building.trapSpentAt);
  const armedRows = rows.filter(participates);
  const deploymentBlockers = rows.filter((b) => !participates(b)).map((b) => ({
    tx: b.tx, ty: b.ty, ...footprintOf(b.type as BuildingType, geometryVersion),
  }));

  const [player] = await db.select().from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'defender not found');

  // Dual-currency split (owner 2026-07-24): raids loot the defender's MINED
  // wealth — player_shards above the summed vault capacity. KEEP (forge payouts,
  // quest/league rewards, DEPOSITED tokens) is NEVER raidable: deposited money
  // being stealable would be unshippable. Vault capacity is denominated in
  // shards (it protects mining income, same numbers as pre-split).
  let surplus = 0n;
  if (!stableBase) {
    const vaultCap = armedRows
      .filter((b) => b.type === 'vault')
      .reduce((s, v) => s + (STRUCTURES.vault.capacity[v.level - 1] ?? 0), 0);
    const shardAcc = await getOrCreatePlayerAccount(db, wallet, 'player_shards');
    surplus = shardAcc.balance > BigInt(vaultCap)
      ? shardAcc.balance - BigInt(vaultCap) : 0n;
  }

  // The defender's ACTUAL claim (grows with expansions) bounds the deploy zone, so
  // a fully-expanded 26×26 base can't be dropped into (owner 2026-07-20).
  const claim = claimRect(stableBase?.expansions ?? player.expansions);
  // Uncleared obstacles ride along as DECOR ONLY (owner 2026-08-15/M23: the
  // attack field must look like the actual base). The sim never reads them —
  // deploys, pathing and targeting are unchanged — and the field is omitted
  // when empty so legacy replay bytes stay identical.
  const obstacleRows = await db.select({
    spriteKey: obstacles.spriteKey, tx: obstacles.tx, ty: obstacles.ty,
  }).from(obstacles).where(and(
    stableBase ? eq(obstacles.baseId, stableBase.id) : eq(obstacles.playerWallet, wallet),
    isNull(obstacles.clearedAt),
  ));
  const placements = await recruitedHeroPlacementsOf(db, wallet, now, stableBase?.id);
  const loadouts = await frozenHeroLoadouts(
    db, wallet, placements.map((h) => h.hero), stableBase?.id,
  );
  const defenderHeroes = placements.filter((hero) => hero.available).map((hero) => ({
    hero: hero.hero,
    level: hero.level,
    guardTx: hero.guardTx,
    guardTy: hero.guardTy,
    ...(loadouts?.[hero.hero] ? { loadout: loadouts[hero.hero] } : {}),
  }));
  return {
    // Omitted for every current production call. A future non-production
    // candidate gate may pass v2 explicitly; absence is the archive-safe v1.
    ...(geometryVersion === undefined ? {} : { geometryVersion }),
    ...(plotVersionForClaim(claim) === 2 ? { plotVersion: 2 as const } : {}),
    keepLevel: stableBase?.keepLevel ?? player.keepLevel,
    buildings: armedRows.map((b) => ({ id: b.id, type: b.type as never, level: b.level, tx: b.tx, ty: b.ty })),
    surplusShards: Number(surplus),
    ...(deploymentBlockers.length ? { deploymentBlockers } : {}),
    claimMin: claim.min,
    claimMax: claim.max,
    ...(obstacleRows.length > 0 ? { obstacles: obstacleRows } : {}),
    ...(defenderHeroes.length > 0 ? { defenderHeroes } : {}),
  };
}

/**
 * Persist one-use traps triggered by the authoritative simulator. This runs in
 * the same settlement transaction as loot/trophies/replay persistence, so a
 * failed settlement never consumes a defender trap (owner 2026-08-15/M22).
 */
export async function persistSpentDefenderTraps(
  db: DbOrTx,
  defenderWallet: string,
  defenderBaseId: string | null,
  outcomeBuildings: ReadonlyArray<{ id: string; destroyed: boolean }>,
  spentAt: Date,
): Promise<number> {
  const triggeredIds = [...new Set(outcomeBuildings
    .filter((building) => building.destroyed)
    .map((building) => building.id))];
  if (triggeredIds.length === 0) return 0;
  const scope = defenderBaseId
    ? eq(buildings.baseId, defenderBaseId)
    : eq(buildings.playerWallet, defenderWallet);
  const updated = await db.update(buildings).set({ trapSpentAt: spentAt }).where(and(
    scope,
    inArray(buildings.id, triggeredIds),
    inArray(buildings.type, [...TRAP_TYPES]),
    isNull(buildings.trapSpentAt),
  )).returning({ id: buildings.id });
  return updated.length;
}

async function isShielded(
  db: DbOrTx, wallet: string, now: Date, warzoneActive = false, baseId?: string,
): Promise<boolean> {
  // One resolver owns both the raid gate and player-facing detail. During a
  // warzone ordinary rows keep counting down but do not protect; only a live
  // warzone-source row is effective.
  return (await getEffectiveShieldStatus(db, wallet, now, warzoneActive, baseId)).active;
}

/**
 * DURING a warzone (#46) the per-target rule is a WARZONE.attackCooldownHours
 * cooldown by ANY attacker — "attackable every 4h" — instead of the normal
 * once/day-per-attacker attackedToday. Keeps a warzone brutal but not an infinite
 * farm on one base.
 */
async function defenderOnWarzoneCooldown(
  db: DbOrTx, defender: string, now: Date, defenderBaseId?: string,
): Promise<boolean> {
  const since = new Date(now.getTime() - WARZONE.attackCooldownHours * 3_600_000);
  const rows = await db.select({ id: raids.id }).from(raids).where(and(
    defenderBaseId ? eq(raids.defenderBaseId, defenderBaseId) : eq(raids.defenderWallet, defender),
    gte(raids.createdAt, since),
  )).limit(1);
  return rows.length > 0;
}

async function attackedToday(
  db: DbOrTx, attacker: string, defender: string, now: Date,
  attackerBaseId?: string, defenderBaseId?: string,
): Promise<boolean> {
  const dayStart = new Date(`${utcDay(now)}T00:00:00Z`);
  // "Never the same target twice per day" counts ATTACKS, not visits (tester
  // Suga, 2026-09-04: opening a revenge target, deploying nothing and leaving
  // still said "already attacked today"). A raid that never happened — its
  // deploy window lapsed with no orders (expired, #58), or it was resolved by
  // a retreat before a single troop or hero was committed — leaves the day's
  // attack on that target available. A raid still pending keeps blocking (it
  // is the same attack, resumable) and any resolved raid with a deployment
  // counts whatever its stars.
  const rows = await db.select({ id: raids.id }).from(raids).where(and(
    attackerBaseId ? eq(raids.attackerBaseId, attackerBaseId) : eq(raids.attackerWallet, attacker),
    defenderBaseId ? eq(raids.defenderBaseId, defenderBaseId) : eq(raids.defenderWallet, defender),
    gte(raids.createdAt, dayStart),
    ne(raids.status, 'expired'),
    sql`not (${raids.status} = 'resolved'
      and coalesce(jsonb_array_length(${raids.orders}->'deploys'), 0) = 0
      and coalesce(jsonb_array_length(${raids.orders}->'heroDeploys'), 0) = 0)`,
  )).limit(1);
  return rows.length > 0;
}

async function assertBasePlayable(db: DbOrTx, baseId: string): Promise<void> {
  const [lock] = await db.select({ raidId: baseRaidLocks.raidId }).from(baseRaidLocks)
    .where(eq(baseRaidLocks.baseId, baseId));
  if (lock) {
    throw new HttpError(
      409,
      'You are being raided, please wait to continue playing or watch it live',
      'BASE_UNDER_RAID',
    );
  }
}

/** Every stable create path holds the attacker base row before this check.
 * That row is also the deed-transfer serialization root, so two creates cannot
 * both observe an empty set and commit unresolved outgoing raids. */
async function assertNoUnresolvedOutgoingRaid(
  db: DbOrTx, attackerBaseId: string,
): Promise<void> {
  const [outgoing] = await db.select({ id: raids.id }).from(raids).where(and(
    eq(raids.attackerBaseId, attackerBaseId),
    inArray(raids.status, ['pending_orders', 'resolving']),
  )).limit(1);
  if (outgoing) {
    throw new HttpError(
      409,
      'this base already has an unresolved outgoing battle',
      'BASE_BUSY_ATTACKING',
    );
  }
}

/** Count today's PvP raids by an attacker (energy accounting, ECONOMY.md §4).
 *  EXCLUDES 'expired' raids (#58) — an abandoned raid where the attack never
 *  happened must not keep spending a free-energy slot. */
async function pvpRaidsToday(
  db: DbOrTx, attacker: string, now: Date, attackerBaseId?: string,
): Promise<number> {
  const dayStart = new Date(`${utcDay(now)}T00:00:00Z`);
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(raids).where(and(
    attackerBaseId
      ? eq(raids.attackerBaseId, attackerBaseId)
      : eq(raids.attackerWallet, attacker),
    sql`${raids.defenderWallet} IS NOT NULL`,
    sql`${raids.status} != 'expired'`,
    gte(raids.createdAt, dayStart),
  ));
  return rows[0]?.n ?? 0;
}

/**
 * Expire the attacker's own pending raids — PvP AND PvE — whose deploy deadline
 * passed with no orders submitted: the ATTACK NEVER HAPPENED, so the slot is given
 * back (#58, owner 2026-07-20). FREE energy returns automatically because
 * pvpRaidsToday no longer counts 'expired' rows; PURCHASED energy is refunded +1
 * per expired raid that consumed it; the PvE 3/day count likewise skips 'expired'
 * rows (a PvE raid never consumes energy — its energySource is NULL, so it can
 * never match the 'purchased' refund filter). The conditional UPDATE (WHERE
 * status='pending_orders') takes a row lock, so concurrent calls can't
 * double-refund. Runs before every energy read/consume AND before the PvE daily
 * count, so an abandoned raid restores its slot on the next /base poll or raid
 * attempt — no background worker required (crediting never depends on workers).
 */
async function expireStaleRaids(db: DbOrTx, attacker: string, now: Date, selectedBaseId?: string): Promise<void> {
  // DbTx.transaction opens a SAVEPOINT, while Db.transaction opens the outer
  // transaction (db/client.ts). That makes the status claim and paid-energy
  // credit one atomic unit for every caller, including createRaid's existing tx.
  await raidEventTransaction(db, async (tx) => {
    // Use the same player-first lock order as createRaid. Besides serializing two
    // expiry attempts for one attacker, this avoids a raid->player / player->raid
    // deadlock when expiry races a new raid purchase.
    const [attackerRow] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, attacker)).for('update');
    if (!attackerRow) throw new Error(`raid expiry invariant: attacker ${attacker} does not exist`);

    // First deployment changes the live-state row, not the raid tuple. An
    // UPDATE waiting for the raid lock retains its original statement snapshot
    // of that OTHER row. Lock raids in a separate statement so the subsequent
    // lifecycle predicate sees any deploy that committed while we waited.
    const pending = await tx.select({ id: raids.id, simulationLeaseToken: raids.simulationLeaseToken,
      simulationSystemAttemptedAt: raids.simulationSystemAttemptedAt }).from(raids).where(and(
      eq(raids.attackerWallet, attacker),
      eq(raids.status, 'pending_orders'),
    )).orderBy(raids.id).for('update');

    const liveReservations = await tx.select({
      id: raids.id,
      mode: raidLiveStates.mode,
      startedAt: raidLiveStates.startedAt,
    }).from(raids).innerJoin(raidLiveStates, eq(raidLiveStates.raidId, raids.id)).where(and(
      eq(raids.attackerWallet, attacker),
      eq(raids.status, 'pending_orders'),
    ));
    // A batch journal (D-099) is not a reservation: an abandoned legacy PvP
    // march keeps its ante as the scouting deterrent exactly as before.
    const neverStartedLive = new Set(liveReservations
      .filter((row) => row.startedAt === null && row.mode === 'live').map((row) => row.id));

    // `ordersDeadlineAt` is a deployed wire/storage contract: deploy + battle.
    // Batch rows get the bounded final replay tail internally, so old rows gain
    // the fix without a migration and old clients still derive the same deploy
    // cutoff. Never-started live reservations retain their existing deadline;
    // their first-deploy authority is enforced independently at exactly 30s.
    // A batch journal row keeps the batch tail: it is the same raid.
    const expiryDeadline = sql<Date>`CASE
      -- Owner 2026-09-05: an abandoned first campaign must not trap the base
      -- for a full battle that never began. Accepted commands retain normal
      -- recovery even if a rolling client has not set started_at yet.
      WHEN ${raids.campaignStage} IS NOT NULL
        AND ${selectedBaseId ? eq(raids.attackerBaseId, selectedBaseId) : isNull(raids.attackerBaseId)}
        AND NOT EXISTS (SELECT 1 FROM raid_commands campaign_command
          WHERE campaign_command.raid_id = ${raids.id})
        AND COALESCE(jsonb_array_length(${raids.orders}->'deploys'), 0) = 0
        AND COALESCE(jsonb_array_length(${raids.orders}->'heroDeploys'), 0) = 0
      THEN ${raids.ordersDeadlineAt} - (${RAID_RULES.battleDurationSec} * INTERVAL '1 second')
      WHEN EXISTS (
        SELECT 1 FROM raid_live_states live_kind
        WHERE live_kind.raid_id = ${raids.id} AND live_kind.mode = 'live'
      ) THEN ${raids.ordersDeadlineAt}
      ELSE ${raids.ordersDeadlineAt}
        + (${RAID_RULES.batchOrdersGraceSec} * INTERVAL '1 second')
    END`;
    const oldResolverFacts = new Map(pending.map(row => [row.id, row]));
    const expired = await tx.update(raids)
      .set({ status: 'expired', simulationLeaseToken: null, simulationLeaseUntil: null, simulationSystemAttemptedAt: null })
      .where(and(
        eq(raids.attackerWallet, attacker),
        eq(raids.status, 'pending_orders'),
        sql`${expiryDeadline} < ${now.toISOString()}::timestamptz`,
        or(isNull(raids.simulationLeaseUntil), lt(raids.simulationLeaseUntil, now)),
        sql`NOT EXISTS (
          SELECT 1 FROM raid_live_states live_expiry
          WHERE live_expiry.raid_id = ${raids.id}
            AND (
              live_expiry.started_at IS NOT NULL
              OR (
                live_expiry.command_protocol_version = ${LIVE_RAID.protocolVersion}
                AND live_expiry.armed_at IS NOT NULL
              )
            )
        )`,
      ))
      .returning({
        id: raids.id,
        attackerWallet: raids.attackerWallet,
        attackerBaseId: raids.attackerBaseId,
        idempotencyKey: raids.idempotencyKey,
        energySource: raids.energySource,
        defenderWallet: raids.defenderWallet,
        defenderBaseId: raids.defenderBaseId,
        simVersion: raids.simVersion,
      });
    const legacyRefund = expired.filter((r) => r.energySource === 'purchased'
      && r.attackerBaseId === null).length;
    if (legacyRefund > 0) {
      const credited = await tx.update(players)
        .set({ purchasedEnergy: sql`${players.purchasedEnergy} + ${legacyRefund}` })
        .where(eq(players.wallet, attacker))
        .returning({ wallet: players.wallet });
      if (credited.length !== 1) {
        throw new Error(`raid expiry invariant: refunded ${legacyRefund} energy but updated ${credited.length} players`);
      }
    }
    const stableRefunds = new Map<string, number>();
    for (const raid of expired) {
      if (raid.energySource !== 'purchased' || !raid.attackerBaseId) continue;
      stableRefunds.set(raid.attackerBaseId, (stableRefunds.get(raid.attackerBaseId) ?? 0) + 1);
    }
    for (const [baseId, amount] of stableRefunds) {
      await grantBasePurchasedEnergy(tx, baseId, amount, now);
    }
    // A stale CURRENT-version march with no resolver lease is ordinary player
    // abandonment, so its SHARD ante remains the scouting deterrent. An OLD-SIM
    // march is unusable after rollout, and a current row carrying an expired
    // lease proves the server accepted submission but failed before commit; both
    // are system failures and reverse the exact ante in this transaction. Doing
    // this here closes the /base sweep race; the conditional status update is
    // still the exact-once claim.
    for (const raid of expired) {
      // A pre-battle live buff is charged when accepted, but it never starts or
      // arms the raid. Expiry is therefore the same "attack never happened"
      // boundary as an explicit prestart retreat: reverse the exact committed
      // ledger entries before releasing the reservation. The helper is a no-op
      // once a troop or hero command exists and is idempotent across retries.
      await refundUnstartedLiveBuffs(tx, raid.id, raid.attackerWallet);
      if ((neverStartedLive.has(raid.id)
        || raid.simVersion !== SIM_VERSION
        || oldResolverFacts.get(raid.id)?.simulationLeaseToken != null
        || oldResolverFacts.get(raid.id)?.simulationSystemAttemptedAt != null)
        && raid.defenderWallet) {
        await refundCancelledRaidAnte(tx, raid);
      }
    }
    if (expired.length > 0) {
      await releaseRaidHeroes(tx, expired.map((raid) => raid.id));
      for (const raid of expired) {
        const releasedReservation = await releaseDeedRaidLoot(tx, raid.id, now);
        if (!releasedReservation) {
          await tx.delete(baseRaidLocks).where(eq(baseRaidLocks.raidId, raid.id));
          markRaidBaseChanged(tx, raid.defenderBaseId);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Raid energy (ECONOMY.md §4) — buy + status
// ---------------------------------------------------------------------------

/** Read-only energy status for a player (used by base.ts HUD + preflight). */
export async function getRaidEnergy(
  db: Db, wallet: string, now = new Date(), baseId?: string,
): Promise<{
  used: number; free: number; max: number; purchased: number;
}> {
  await expireStaleRaids(db, wallet, now, baseId); // give back energy for abandoned raids (#58)
  const purchased = baseId
    ? (await ensureBaseProfile(db, baseId)).purchasedEnergy
    : (await db.select({ purchased: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, wallet)))[0]?.purchased ?? 0;
  const raidsToday = await pvpRaidsToday(db, wallet, now, baseId);
  const freeRemaining = Math.max(0, RAID_ENERGY.freePerDay - raidsToday);
  // No daily ceiling any more (owner 2026-07-26), so `free` is simply what the
  // player can spend right now and `max` is the free ALLOWANCE the HUD fills —
  // purchased energy stacks on top of it rather than being clamped into it.
  return {
    used: raidsToday,
    free: freeRemaining + purchased,
    max: RAID_ENERGY.freePerDay,
    purchased,
  };
}

/**
 * Energy is a pay-per-action SOL sink (v3, owner 2026-07-19): a player buys 1
 * raid-energy by paying RAID_ENERGY.solLamportsPerEnergy ON-CHAIN (shardkeep-core
 * buy_sink, kind=energy) through the deposit flow — NOT from a prepaid balance.
 * `assertEnergyPurchasable` gates the intent (never take payment for energy that
 * can't be spent today); `grantPurchasedEnergy` applies the +1 after the payment
 * is verified at `finalized` (money/deposits.ts creditDeposit). No ledger SOL
 * move happens here — the SOL already left the wallet to the treasuries on-chain.
 */

/** Read-only preflight run when the energy deposit intent is minted.
 *
 *  The old 6-raids/day ceiling is gone (owner 2026-07-26), and with it the only
 *  reason energy could be UNSPENDABLE — purchased energy now stockpiles without
 *  limit, so every payment is grantable and the only thing left to establish is
 *  that the payer exists. Kept as the intent's gate so the deposit flow keeps one
 *  named preflight per sink, and so a future limit lands in exactly one place. */
export async function assertEnergyPurchasable(
  db: DbOrTx, wallet: string, baseId?: string,
): Promise<void> {
  const [me] = await db.select({ wallet: players.wallet })
    .from(players).where(eq(players.wallet, wallet));
  if (!me) throw new HttpError(404, 'player not found');
  if (multiBaseEnabled()) {
    if (!baseId) throw new HttpError(409, 'baseId is required', 'BASE_ID_REQUIRED');
    const [owned] = await db.select({ id: bases.id }).from(bases).where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    ));
    if (!owned) throw new HttpError(404, 'base not found', 'BASE_NOT_OWNED');
    await ensureBaseProfile(db, baseId);
  }
}

/** Grant 1 purchased raid-energy — called from creditDeposit once the on-chain
 *  SOL payment is verified at finalized. The deposit row is the idempotency
 *  anchor (credited exactly once). The 6/day USABLE cap is re-enforced at the
 *  point of use (getRaidEnergy, base HUD, createRaid), so an over-grant from a
 *  rare concurrent double-buy is simply unspendable, never an over-raid. */
export async function grantPurchasedEnergy(
  tx: DbOrTx, wallet: string, baseId?: string,
): Promise<number> {
  if (baseId) return grantBasePurchasedEnergy(tx, baseId);
  const [row] = await tx.update(players)
    .set({ purchasedEnergy: sql`${players.purchasedEnergy} + 1` })
    .where(eq(players.wallet, wallet))
    .returning({ purchasedEnergy: players.purchasedEnergy });
  return row?.purchasedEnergy ?? 0;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** Heroes recruited at raid creation = COMPLETED altars (D4a). Frozen into the
 *  armySnapshot like troop counts, so replays validate without live DB reads. */
async function recruitedHeroes(
  db: DbOrTx,
  wallet: string,
  now: Date,
  baseId?: string,
): Promise<Array<'vex' | 'theodor'>> {
  return (await recruitedHeroPlacementsOf(db, wallet, now, baseId))
    .filter((hero) => hero.available)
    .map((hero) => hero.hero);
}

/** Hero LEVELS frozen into the snapshot next to the recruited list (D-Q1). The
 *  level is what the player PAID KEEP for, so it must come from the server's
 *  hero_levels table — never from the client — and it must be frozen at raid
 *  creation like troop levels, or a mid-raid upgrade would change a replay. */
async function heroLevelsOf(db: DbOrTx, wallet: string): Promise<Record<string, number>> {
  const rows = await db.select({ hero: heroLevels.hero, level: heroLevels.level })
    .from(heroLevels).where(eq(heroLevels.playerWallet, wallet));
  const out: Record<string, number> = {};
  for (const r of rows) out[r.hero] = r.level;
  return out;
}

interface HeroRecoveryUpdate {
  hero: HeroKey;
  level: number;
  durationMs: number;
  refundPct: number;
}

/** Convert only authoritative attacker deaths into persistent recovery. Defender
 * knockouts deliberately never enter this map. Tails is accepted only when its
 * typed event carries the exact tier value from shared constants. */
function attackerHeroRecoveries(
  events: readonly SimEvent[],
  frozenLevels: Record<string, number> | undefined,
): HeroRecoveryUpdate[] {
  const dead = new Set(events.filter((event) => event.e === 'troopDeath').map((event) => event.id));
  const tailsById = new Map(events.flatMap((event) => event.e === 'heroSkill'
    && event.side === 'attacker' && event.skill === 'doubleOrNothingTails'
    ? [[event.id, event.refundPct] as const]
    : []));
  const updates: HeroRecoveryUpdate[] = [];
  for (const event of events) {
    if (event.e !== 'deploy' || !event.hero || event.side === 'defender' || !dead.has(event.id)) continue;
    const hero = event.hero;
    const level = Math.max(1, Math.min(HERO_LEVELING.maxLevel, frozenLevels?.[hero] ?? 1));
    let refundPct = 0;
    if (hero === 'vex' && tailsById.has(event.id)) {
      const carried = tailsById.get(event.id);
      const expected = HERO_SKILLS.vex.doubleOrNothing.tailsRegenRefundPct[heroTier(level) - 1]!;
      if (carried !== expected) throw new Error(`raid recovery invariant: invalid tails refund ${carried}`);
      refundPct = carried;
    }
    const fullMs = HEROES[hero].regenMinAt(level) * 60_000;
    const durationMs = Math.floor((fullMs * (100 - refundPct)) / 100);
    updates.push({ hero, level, refundPct, durationMs });
  }
  return updates;
}

/** Loadout effects are frozen only while the balance gate is enabled. Empty
 * loadouts stay absent, retaining the exact historical army/replay shape. */
async function frozenHeroLoadouts(
  db: DbOrTx,
  wallet: string,
  heroes: readonly HeroKey[],
  baseId?: string,
): Promise<Partial<Record<HeroKey, HeroCombatLoadout>> | undefined> {
  if (!heroGearCombatEnabled()) return undefined;
  const resolved = baseId
    ? await resolveBaseHeroLoadouts(db, baseId)
    : await resolveHeroLoadouts(db, wallet);
  const entries = heroes.flatMap((hero) => resolved[hero].itemIds.length > 0
    ? [[hero, toHeroCombatLoadout(resolved[hero])] as const]
    : []);
  return entries.length > 0
    ? Object.fromEntries(entries) as Partial<Record<HeroKey, HeroCombatLoadout>>
    : undefined;
}

/** @internal Pure fail-closed policy used by submit and rollout regression tests. */
export function heroRaidAuthorizationIssue(
  deployed: readonly HeroKey[],
  reserved: readonly HeroKey[],
  recovering: readonly HeroKey[],
): { hero: HeroKey; code: 'HERO_RECOVERING' | 'HERO_RESERVATION_MISSING' } | undefined {
  for (const hero of deployed) {
    if (recovering.includes(hero)) return { hero, code: 'HERO_RECOVERING' };
    if (!reserved.includes(hero)) return { hero, code: 'HERO_RESERVATION_MISSING' };
  }
  return undefined;
}

/** Conservative upper bound known before raid creation charges energy/ante.
 * It assumes every deployable Hexbarrow lands at tick zero and every Nest lives
 * for the whole battle. Legal four-camp rosters fit; corrupted/forward rows fail
 * before the money transaction rather than creating an unresolvable paid raid. */
function assertReplayActorCapacity(
  counts: Partial<Record<TroopType, number>>,
  heroCount: number,
  snapshot: BaseSnapshot,
): void {
  const darkEnabled = darkAttackerRosterEnabled();
  const deployable = TROOP_TYPES.filter((type) => isTrainableTroop(type)
    && (darkEnabled || !isDarkAttackerTroop(type)));
  const direct = deployable.reduce((sum, type) => sum + Math.max(0, counts[type] ?? 0), 0);
  if (direct + heroCount === 0) {
    const inactiveDark = !darkEnabled && TROOP_TYPES.some((type) =>
      isTrainableTroop(type) && isDarkAttackerTroop(type) && (counts[type] ?? 0) > 0);
    if (!inactiveDark) return; // preserve the pre-existing empty-army create contract
    throw new HttpError(
      409,
      'dark attacker roster is coming soon; train an active troop before raiding',
      'TROOP_ROSTER_INACTIVE',
    );
  }
  if (direct > RAID_REPLAY_LIMITS.maxDirectDeploys) {
    throw new HttpError(
      422,
      `raid roster exceeds direct replay limit (${direct}/${RAID_REPLAY_LIMITS.maxDirectDeploys})`,
      'RAID_REPLAY_LIMIT',
    );
  }
  const hexes = darkEnabled ? Math.min(Math.max(0, counts.hexbarrow ?? 0), direct) : 0;
  const brood = TROOP_ABILITIES.hexbarrow.brood;
  const lastTick = RAID_RULES.battleDurationSec * 10 - 1;
  const firstTick = brood.firstDelaySec * 10;
  const cohorts = firstTick > lastTick
    ? 0
    : 1 + Math.floor((lastTick - firstTick) / (brood.intervalSec * 10));
  const broodPerCohort = brood.spawnCounts.reduce((sum, count) => sum + count, 0);
  const nests = snapshot.buildings.filter((b) => b.type === 'dragonnest').length;
  const nestSpawnTicks = Math.floor(lastTick / (DEFENSES.dragonnest.spawnIntervalSec * 10));
  const defenderHeroes = snapshot.defenderHeroes?.length ?? 0;
  const actors = direct + heroCount + defenderHeroes
    + hexes * cohorts * broodPerCohort + nests * nestSpawnTicks;
  if (actors > RAID_REPLAY_LIMITS.maxActors) {
    throw new HttpError(
      422,
      `raid roster exceeds replay actor limit (${actors}/${RAID_REPLAY_LIMITS.maxActors})`,
      'RAID_REPLAY_LIMIT',
    );
  }
}

/**
 * An idempotency retry may cross the same rollout boundary as order submission:
 * the first create committed under the old simulator, its response was lost,
 * then the current client retried the same key. Return it only when the frozen
 * version is current; SIM6 has no compatibility exception.
 */
async function refundCancelledRaidAnte(
  tx: DbOrTx,
  raid: {
    id: string;
    attackerWallet: string;
    attackerBaseId?: string | null;
    idempotencyKey: string | null;
  },
): Promise<void> {
  if (!raid.idempotencyKey) return;
  const originalKey = `raid-ante:${raid.idempotencyKey}`;
  const rows = await tx.select({
    accountId: ledgerEntries.accountId,
    delta: ledgerEntries.delta,
    kind: accounts.kind,
    ownerWallet: accounts.ownerWallet,
    baseId: accounts.baseId,
  }).from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.txnId, ledgerTransactions.id))
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(eq(ledgerTransactions.idempotencyKey, originalKey));
  if (rows.length === 0) return; // Legacy/zero-ante raid: nothing was charged.
  const playerDebit = rows.find((r) => (
    (r.kind === 'player_shards' && !raid.attackerBaseId
      && r.ownerWallet === raid.attackerWallet)
      || (r.kind === 'base_shards' && !!raid.attackerBaseId
        && r.baseId === raid.attackerBaseId)
  ) && r.delta < 0n);
  const burnCredit = rows.find((r) => r.kind === 'shard_burn' && r.delta > 0n);
  if (!playerDebit || !burnCredit || -playerDebit.delta !== burnCredit.delta) {
    throw new Error(`raid system refund invariant: malformed ante ${originalKey}`);
  }
  await postTransaction(tx, {
    idempotencyKey: `raid-ante-refund:${raid.id}`,
    type: 'raid.ante.system_refund',
    entries: [
      { account: playerDebit.accountId, delta: -playerDebit.delta },
      { account: burnCredit.accountId, delta: -burnCredit.delta },
    ],
    metadata: { raidId: raid.id, wallet: raid.attackerWallet, originalKey },
  });
}

/** Atomically terminalise a still-pending incompatible raid and reverse only
 * costs caused by creating that unusable march. Free/PvE slots return because
 * every counter excludes `expired`; purchased energy and the exact original
 * SHARD ante require explicit credits. The conditional status claim is the
 * idempotency anchor for create retries and concurrent submit requests. */
/** @internal Exported for adversarial token-fencing tests; not an HTTP surface. */
export async function compensatePendingRaid(
  db: DbOrTx,
  raid: { id: string; attackerWallet: string; simVersion: number },
  versionMismatchOnly = true,
  expectedSimulationLeaseToken?: string,
  refundAnte = true,
  armyChange?: Partial<Record<TroopType, number>>,
): Promise<boolean> {
  return raidEventTransaction(db, async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, raid.attackerWallet)).for('update');
    if (!player) throw new Error(`raid compatibility refund invariant: missing attacker ${raid.attackerWallet}`);
    // Acquire the lifecycle lock BEFORE the statement that checks live state.
    // READ COMMITTED refreshes a waited-on target tuple, not another table's
    // snapshot: a lone conditional UPDATE can refund a just-started battle.
    await tx.select({ id: raids.id }).from(raids).where(and(
      eq(raids.id, raid.id), eq(raids.attackerWallet, raid.attackerWallet),
    )).for('update');
    const conditions = [
      eq(raids.id, raid.id),
      eq(raids.attackerWallet, raid.attackerWallet),
      eq(raids.status, 'pending_orders'),
    ];
    if (versionMismatchOnly) conditions.push(sql`${raids.simVersion} != ${SIM_VERSION}`);
    if (expectedSimulationLeaseToken) {
      conditions.push(eq(raids.simulationLeaseToken, expectedSimulationLeaseToken));
    }
    // D-036's first-deploy boundary is irreversible. With the raid lock already
    // held, this fresh statement sees the final started/armed state and no new
    // command can start between the predicate and the terminal status claim.
    conditions.push(notExists(
      tx.select({ raidId: raidLiveStates.raidId }).from(raidLiveStates).where(and(
        eq(raidLiveStates.raidId, raids.id),
        or(
          isNotNull(raidLiveStates.startedAt),
          and(
            eq(raidLiveStates.commandProtocolVersion, LIVE_RAID.protocolVersion),
            isNotNull(raidLiveStates.armedAt),
          ),
        ),
      )),
    ));
    // Only the three actual army-change decisions supply this context. The
    // source rechecks a locked shortage; replenishment leaves the raid pending.
    if (!refundAnte && armyChange) {
      if (!expectedSimulationLeaseToken) throw Error('Army compensation requires its original lease');
      if (!(await captureCharterArmyChange(tx, raid.id, raid.attackerWallet, expectedSimulationLeaseToken, armyChange))) return false;
    }
    const [claimed] = await tx.update(raids).set({
      status: 'expired', simulationLeaseToken: null, simulationLeaseUntil: null,
      simulationSystemAttemptedAt: null,
    }).where(and(
      ...conditions,
    )).returning({
      id: raids.id,
      attackerWallet: raids.attackerWallet,
      attackerBaseId: raids.attackerBaseId,
      idempotencyKey: raids.idempotencyKey,
      energySource: raids.energySource,
      defenderWallet: raids.defenderWallet,
      defenderBaseId: raids.defenderBaseId,
    });
    if (!claimed) return false;
    if (claimed.energySource === 'purchased') {
      if (claimed.attackerBaseId) {
        await grantBasePurchasedEnergy(tx, claimed.attackerBaseId, 1);
      } else {
        const credited = await tx.update(players)
          .set({ purchasedEnergy: sql`${players.purchasedEnergy} + 1` })
          .where(eq(players.wallet, claimed.attackerWallet))
          .returning({ wallet: players.wallet });
        if (credited.length !== 1) {
          throw new Error('raid compatibility refund invariant: energy credit failed');
        }
      }
    }
    if (refundAnte && claimed.defenderWallet) await refundCancelledRaidAnte(tx, claimed);
    await refundUnstartedLiveBuffs(tx, claimed.id, claimed.attackerWallet);
    await releaseRaidHeroes(tx, [claimed.id]);
    const releasedReservation = await releaseDeedRaidLoot(tx, claimed.id);
    if (!releasedReservation) {
      await tx.delete(baseRaidLocks).where(eq(baseRaidLocks.raidId, claimed.id));
      markRaidBaseChanged(tx, claimed.defenderBaseId);
    }
    return true;
  });
}

/** Distributed, crash-recoverable single-flight around the synchronous sim.
 * The token is the ownership fence: after expiry a retry may take over, and an
 * older worker can no longer claim resolution with its stale token. */
async function claimSimulationLease(db: DbOrTx, raidId: string, attacker: string): Promise<string> {
  const token = randomUUID();
  const [claimed] = await db.update(raids).set({
    simulationLeaseToken: token,
    simulationLeaseUntil: sql`NOW() + (${RAID_REPLAY_LIMITS.simulationLeaseSec} * INTERVAL '1 second')`,
    simulationSystemAttemptedAt: null,
  }).where(and(
    eq(raids.id, raidId),
    eq(raids.attackerWallet, attacker),
    eq(raids.status, 'pending_orders'),
    or(isNull(raids.simulationLeaseUntil), lt(raids.simulationLeaseUntil, sql`NOW()`)),
  )).returning({ id: raids.id });
  if (!claimed) {
    throw new HttpError(409, 'raid submission is already being resolved', 'RAID_SUBMISSION_IN_PROGRESS');
  }
  return token;
}

async function releaseSimulationLease(
  db: Db,
  raidId: string,
  token: string,
  markSystemFailure = false,
): Promise<void> {
  await db.update(raids).set({
    simulationLeaseToken: null,
    simulationLeaseUntil: null,
    ...(markSystemFailure
      ? { simulationSystemAttemptedAt: sql`COALESCE(${raids.simulationSystemAttemptedAt}, NOW())` }
      : {}),
  }).where(and(
    eq(raids.id, raidId),
    eq(raids.status, 'pending_orders'),
    eq(raids.simulationLeaseToken, token),
  ));
}

async function renewSimulationLease(db: Db, raidId: string, token: string): Promise<void> {
  const [renewed] = await db.update(raids).set({
    simulationLeaseUntil: sql`NOW() + (${RAID_REPLAY_LIMITS.simulationLeaseSec} * INTERVAL '1 second')`,
  }).where(and(
    eq(raids.id, raidId),
    eq(raids.status, 'pending_orders'),
    eq(raids.simulationLeaseToken, token),
  )).returning({ id: raids.id });
  if (!renewed) {
    throw new HttpError(409, 'raid simulation lease was superseded; retry shortly', 'RAID_SUBMISSION_IN_PROGRESS');
  }
}

async function liveArmyCoversOrders(
  db: DbOrTx,
  wallet: string,
  used: Partial<Record<TroopType, number>>,
  baseId?: string | null,
): Promise<boolean> {
  if (multiBaseEnabled()) {
    if (!baseId) throw new HttpError(409, 'baseId is required while multi-base is active', 'BASE_ID_REQUIRED');
    return baseArmyCoversOrders(db, baseId, used);
  }
  const rows = await db.select({ troop: army.troop, count: army.count }).from(army)
    .where(eq(army.playerWallet, wallet));
  const counts = new Map(rows.map((row) => [row.troop, row.count]));
  return (Object.entries(used) as Array<[TroopType, number]>).every(
    ([troop, count]) => !count || (counts.get(troop) ?? 0) >= count,
  );
}

async function extendBusyRaidDeadline(
  db: DbOrTx,
  raid: { id: string; attackerWallet: string; createdAt: Date },
  now: Date,
): Promise<void> {
  const fullWindowMs = raidOrdersWindowMs();
  const retryUntil = new Date(now.getTime()
    + fullWindowMs);
  // Capacity refusal buys at most ONE additional full window from creation.
  // Repeated self-busy calls can never preserve a frozen roster indefinitely.
  const absoluteCap = new Date(raid.createdAt.getTime() + fullWindowMs * 2);
  await db.update(raids).set({
    ordersDeadlineAt: sql`GREATEST(
      ${raids.ordersDeadlineAt},
      LEAST(${retryUntil.toISOString()}::timestamptz, ${absoluteCap.toISOString()}::timestamptz)
    )`,
  }).where(and(
    eq(raids.id, raid.id),
    eq(raids.attackerWallet, raid.attackerWallet),
    eq(raids.status, 'pending_orders'),
  ));
}

/** The deployed row/wire deadline remains deploy + combat (30s + 90s). */
export function raidOrdersWindowMs(): number {
  return (RAID_RULES.deployWindowSec
    + RAID_RULES.battleDurationSec) * 1_000;
}

/** The effective batch submit deadline lives beside the journal clock it also
 * closes (liveRaids.ts); re-exported so callers keep one import. */
export { batchOrdersSubmitDeadlineAt };

async function claimHeavySimulationLease(
  db: Db,
  raid: { id: string; attackerWallet: string; createdAt: Date },
  now: Date,
): Promise<string> {
  const result = await db.transaction(async (tx) => {
    // Canonical player→raid order. Cooldown and lease either commit together,
    // or neither does; a cooldown refusal commits only bounded retry grace.
    const cooldown = await admitHeavyRaidSimulation(tx, raid.attackerWallet);
    if (!cooldown) {
      await extendBusyRaidDeadline(tx, raid, now);
      return null;
    }
    return claimSimulationLease(tx, raid.id, raid.attackerWallet);
  });
  if (!result) {
    throw new HttpError(429, 'raid simulator cooldown; retry shortly', 'RAID_SIMULATION_COOLDOWN');
  }
  return result;
}

async function requireResolvableRaidVersion<T extends {
  id: string; attackerWallet: string; status: string; simVersion: number;
}>(db: DbOrTx, raid: T): Promise<T> {
  if (!canResolveWithCurrentSimulator(raid.simVersion)) {
    const compensated = raid.status === 'pending_orders'
      ? await compensatePendingRaid(db, raid)
      : false;
    if (!compensated) {
      const [started] = await db.select({ status: raids.status })
        .from(raids)
        .innerJoin(raidLiveStates, eq(raidLiveStates.raidId, raids.id))
        .where(and(
          eq(raids.id, raid.id),
          inArray(raids.status, ['pending_orders', 'resolving']),
          or(
            isNotNull(raidLiveStates.startedAt),
            and(
              eq(raidLiveStates.commandProtocolVersion, LIVE_RAID.protocolVersion),
              isNotNull(raidLiveStates.armedAt),
            ),
          ),
        ))
        .limit(1);
      if (started) {
        throw new HttpError(
          503,
          `started raid requires its pinned simulator v${raid.simVersion}; rollout must keep that resolver available`,
          'RAID_PINNED_SIMULATOR_REQUIRED',
        );
      }
    }
    throw new HttpError(
      409,
      `raid uses simulator v${raid.simVersion}, but the server now uses v${SIM_VERSION} — the unusable raid was cancelled and refundable costs restored; start a new raid`,
      'RAID_SIM_VERSION_MISMATCH',
    );
  }
  return raid;
}

/**
 * Hard rollout/readiness fence for D-036. A new simulator may start only after
 * the still-running compatible worker has resolved every battle that crossed
 * the first-deploy boundary. Never compensate these rows and never activate an
 * irreversible database cutover ahead of this assertion.
 */
export async function assertNoIncompatibleStartedLiveRaids(
  db: DbOrTx,
  targetVersion = SIM_VERSION,
): Promise<void> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(raids)
    .innerJoin(raidLiveStates, eq(raidLiveStates.raidId, raids.id))
    .where(and(
      inArray(raids.status, ['pending_orders', 'resolving']),
      or(
        isNotNull(raidLiveStates.startedAt),
        and(
          eq(raidLiveStates.commandProtocolVersion, LIVE_RAID.protocolVersion),
          isNotNull(raidLiveStates.armedAt),
        ),
      ),
      sql`${raids.simVersion} != ${targetVersion}`,
    ));
  const count = row?.n ?? 0;
  if (count > 0) {
    throw new Error(
      `[raid-rollout] ${count} started unresolved raid(s) require a simulator other than v${targetVersion}; `
      + 'keep the compatible worker live until they resolve',
    );
  }
}

type RaidCreateBinding = ({ raidProtocolVersion: RaidProtocolVersion } & (
  | { operation: 'pvp'; defenderWallet?: string; attackerBaseId?: string; defenderBaseId?: string; excludeBaseId?: string }
  | { operation: 'pve'; pveCampId: string; attackerBaseId?: string }
  | { operation: 'campaign'; campaignStage: number; attackerBaseId?: string }
));

/** Raw client keys are neither actor- nor operation-scoped. Persist a bounded
 * namespace so another wallet or raid kind can safely use the same client key. */
function raidCreateKey(attacker: string, operation: RaidCreateBinding['operation'], clientKey: string): string {
  const namespace = createHash('sha256').update(`${attacker}\0${operation}`).digest('hex');
  return `raid:${namespace}:${clientKey}`;
}

function raidCreateBindingMatches(
  row: typeof raids.$inferSelect, attacker: string, binding: RaidCreateBinding,
): boolean {
  if (row.attackerWallet !== attacker) return false;
  if (binding.attackerBaseId !== undefined && row.attackerBaseId !== binding.attackerBaseId) return false;
  if (binding.operation === 'pvp') {
    return row.defenderWallet !== null && row.pveCampId === null && row.campaignStage === null
      && (binding.defenderWallet === undefined || row.defenderWallet === binding.defenderWallet)
      && (binding.defenderBaseId === undefined || row.defenderBaseId === binding.defenderBaseId)
      && (row.armySnapshot as { createRequest?: { excludeBaseId?: string } }).createRequest?.excludeBaseId
        === binding.excludeBaseId;
  }
  if (binding.operation === 'pve') {
    return row.defenderWallet === null && row.campaignStage === null
      && row.pveCampId === binding.pveCampId;
  }
  return row.defenderWallet === null && row.pveCampId === null
    && row.campaignStage === binding.campaignStage;
}

async function createRetry(
  db: DbOrTx, attacker: string, clientKey: string, binding: RaidCreateBinding,
): Promise<{
  idempotencyKey: string;
  existing: (typeof raids.$inferSelect & { raidProtocolVersion: RaidProtocolVersion }) | null;
}> {
  const idempotencyKey = raidCreateKey(attacker, binding.operation, clientKey);
  const rows = await db.select().from(raids).where(or(
    eq(raids.idempotencyKey, idempotencyKey),
    // Rollout compatibility: rows created before namespacing stored the raw key.
    eq(raids.idempotencyKey, clientKey),
  ));
  const existingRow = rows.find((row) => row.idempotencyKey === idempotencyKey)
    ?? rows.find((row) => row.idempotencyKey === clientKey && row.attackerWallet === attacker)
    ?? null;
  if (existingRow && !raidCreateBindingMatches(existingRow, attacker, binding)) {
    throw new HttpError(409, 'idempotency key is already bound to another raid request', 'RAID_IDEMPOTENCY_MISMATCH');
  }
  let existing = null;
  if (existingRow) {
    const [live] = await db.select({ version: raidLiveStates.commandProtocolVersion })
      .from(raidLiveStates).where(eq(raidLiveStates.raidId, existingRow.id));
    const actual = (live?.version ?? LIVE_RAID.legacyProtocolVersion) as RaidProtocolVersion;
    if (actual !== binding.raidProtocolVersion) {
      throw new HttpError(409, 'idempotency key is bound to another raid protocol', 'RAID_IDEMPOTENCY_MISMATCH');
    }
    existing = { ...existingRow, raidProtocolVersion: actual };
  }
  return { idempotencyKey, existing };
}

function requestedRaidProtocol(version?: RaidProtocolVersion): RaidProtocolVersion {
  return version ?? LIVE_RAID.legacyProtocolVersion;
}

function assertRaidProtocolCreationAllowed(
  version: RaidProtocolVersion,
  allowRaidProtocolV2: boolean | undefined,
): void {
  if (version === LIVE_RAID.protocolVersion && allowRaidProtocolV2 !== true) {
    throw new HttpError(503, 'live raid protocol v2 is disabled', 'LIVE_RAID_V2_DISABLED');
  }
}

export async function createRaid(
  db: Db, attacker: string,
  opts: {
    defenderWallet?: string | undefined;
    attackerBaseId?: string | undefined;
    defenderBaseId?: string | undefined;
    excludeBaseId?: string | undefined;
    authorizeAttackerBase?: RaidBaseAuthority | undefined;
    authorizeDefenderBase?: RaidBaseAuthority | undefined;
    idempotencyKey: string;
    raidProtocolVersion?: RaidProtocolVersion | undefined;
    allowRaidProtocolV2?: boolean | undefined;
  },
  at?: Date | (() => Date),
) {
  // Explicit time is a server/test dependency, never a command field. With no
  // override, sample the database again AFTER participant/base lock waits.
  const explicitTime = () => {
    const value = typeof at === 'function' ? at() : at;
    if (value === undefined) return undefined;
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid raid admission clock');
    return new Date(value.getTime());
  };
  const stableRequested = multiBaseEnabled();
  if (opts.excludeBaseId && (!stableRequested || opts.defenderBaseId || opts.defenderWallet)) {
    throw new HttpError(400, 'target exclusion requires automatic stable-base matchmaking');
  }
  const raidProtocolVersion = requestedRaidProtocol(opts.raidProtocolVersion);
  const binding: RaidCreateBinding = {
    operation: 'pvp',
    raidProtocolVersion,
    ...(opts.excludeBaseId ? { excludeBaseId: opts.excludeBaseId } : {}),
    ...(opts.defenderWallet ? { defenderWallet: opts.defenderWallet } : {}),
    ...(stableRequested && opts.attackerBaseId ? { attackerBaseId: opts.attackerBaseId } : {}),
    ...(stableRequested && opts.defenderBaseId ? { defenderBaseId: opts.defenderBaseId } : {}),
  };
  // Idempotent fast-path: a committed retry returns the existing raid (no re-charge).
  const { idempotencyKey, existing } = await createRetry(db, attacker, opts.idempotencyKey, binding);
  if (existing) return { ...await requireResolvableRaidVersion(db, existing), ...await boundCosmeticRaidFields(db, existing.id), ...await raidStarterFields(db,existing.id,existing.snapshot), ...await raidAdvancedFields(db,existing.id,existing.snapshot) };
  assertRaidProtocolCreationAllowed(raidProtocolVersion, opts.allowRaidProtocolV2);
  const now = explicitTime() ?? await raidDatabaseWallNow(db);

  const [me] = await db.select().from(players).where(eq(players.wallet, attacker));
  if (!me) throw new HttpError(404, 'player not found');
  const attackerBase = await attackerRaidBase(db, attacker, opts.attackerBaseId);
  const stable = attackerBase !== null;
  if (stable && (!opts.authorizeAttackerBase || !opts.authorizeDefenderBase)) {
    throw new HttpError(503, 'fresh raid base authority is required', 'DEED_AUTHORITY_UNAVAILABLE');
  }
  if (attackerBase) await opts.authorizeAttackerBase!(attacker, attackerBase.id);
  const attackerProfile = attackerBase
    ? await ensureBaseProfile(db, attackerBase.id)
    : null;
  const attackerTrophies = attackerProfile?.trophies ?? me.trophies;

  // #46: preflight warzone predicate, no cron. Atomic admission samples it again
  // after locks so a wait cannot carry an expired policy across the snapshot.
  const warzoneActive = isWarzoneActive(await getGameConfig(db), now);

  // THE PARTITION (locked owner decision 2026-08-09, docs/LAND-DEED-ONBOARDING-PLAN.md):
  // land ownership splits the player base into two SEALED matchmaking pools. A
  // deedless attacker only ever meets deedless defenders; a landowner only ever
  // meets landowners. Deedless bases have no plot, so they produce no map row and
  // the paid world cannot even see them — this is the mechanism that replaces the
  // proposed standing shield.
  //
  // THIS LINE IS THE FOURTH FACTOR OF ATTACKABILITY (F9): the predicate is
  // (base exists) × shield × warzone × sameLandTier, NOT the three-factor INV-1
  // form. The tier input is the selected stable base's land-payment timestamp
  // (or the legacy player payment while the flag is off), so it never comes from
  // collectible metadata and a transfer cannot be used to dodge an attack.
  const iOwnLand = attackerBase ? attackerBase.landPaidAt !== null : hasLand(me);

  // Phase 1 (reads): pick + validate a defender.
  let defender: string;
  let defenderBase: ActiveRaidBase | null = null;
  if (opts.defenderWallet || (stable && opts.defenderBaseId)) {
    defenderBase = stable
      ? await defenderRaidBase(db, opts.defenderWallet, opts.defenderBaseId)
      : null;
    defender = defenderBase?.ownerWallet ?? opts.defenderWallet!;
    if (defender === attacker) throw new HttpError(422, 'cannot raid yourself');
    const [d] = await db.select().from(players).where(eq(players.wallet, defender));
    if (!d) throw new HttpError(404, 'defender not found');
    // Cross-boundary raids are refused with the SAME 404 as a wallet that does not
    // exist, and BEFORE the trophy/shield checks, deliberately: a distinguishable
    // error would be an existence oracle for wallets that are not on the map, and
    // "not in the world yet" is the honest description of a base with no parcel.
    // Route gating alone cannot do this — POST /raids must stay reachable by
    // deedless players (auto-match is their only PvP), so the boundary has to be
    // enforced on the defender, here, whatever route names them (map pick, revenge).
    if (stable
      ? (attackerBase!.landPaidAt !== null) !== (defenderBase!.landPaidAt !== null)
      : !sameLandTier(me, d)) {
      throw new HttpError(404, 'defender not found');
    }
    if (stable) await opts.authorizeDefenderBase!(defender, defenderBase!.id);
    // The defender's profile row must exist before settlement can move trophies
    // onto it; its trophies are no longer read here — nothing about rating gates
    // a named target (D-099).
    if (defenderBase) await ensureBaseProfile(db, defenderBase.id);
    // THE KEEP GATE (D-099, owner 2026-09-02): "KEEP 10 cannot attack KEEP 1;
    // KEEP 1 can attack KEEP 10". Levels come from the selected stable bases (or
    // the wallet rows while the flag is off) — never from deed state, which INV-1
    // forbids this file to read. `code` rides along so the client can say WHY
    // with the two numbers instead of regexing the message.
    const attackerKeep = attackerBase?.keepLevel ?? me.keepLevel;
    const defenderKeep = defenderBase?.keepLevel ?? d.keepLevel;
    if (!pvpAttackAllowed(attackerKeep, defenderKeep)) {
      throw new HttpError(
        422,
        `their Keep is too far below yours (L${defenderKeep} vs your L${attackerKeep})`,
        'keep_too_far_below',
      );
    }
    if (await isShielded(db, defender, now, warzoneActive, defenderBase?.id)) {
      throw new HttpError(422, 'defender is shielded');
    }
    if (warzoneActive) {
      if (await defenderOnWarzoneCooldown(db, defender, now, defenderBase?.id)) {
        throw new HttpError(422, `target was hit in the last ${WARZONE.attackCooldownHours}h — warzone cooldown`);
      }
    } else if (await attackedToday(db, attacker, defender, now, attackerBase?.id, defenderBase?.id)) {
      throw new HttpError(422, 'already attacked today');
    }
  } else {
    // Auto-match (D-099): trophies ORDER the candidates, the Keep rule FILTERS
    // them. Candidates come back NEAREST-RATED FIRST — the pool is capped, so an
    // unordered page could be 50 arbitrary rows (all shielded, say) while a
    // perfectly good opponent sat unread, reporting a false "no eligible targets".
    // The land-tier and Keep filters are in the SQL for the SAME reason the
    // ordering is: a page spent on rows the per-row filters would throw away is a
    // page that cannot find the legal opponent behind them. There is no trophy
    // band and no widening retry any more: a band turned "nobody near your
    // rating" into "nobody at all" for whoever out-climbed their cohort (the
    // KEEP-11 "no eligible targets" report), and a defender's rating says nothing
    // about whether the fight is fair — their Keep does.
    const attackerKeep = attackerBase?.keepLevel ?? me.keepLevel;
    // `keep_level >= ceil(attacker × bps / 10⁴)` is exactly pvpAttackAllowed for
    // an integer column — one rule, stated once in shared, bound here in SQL.
    const minDefenderKeep = pvpMinDefenderKeep(attackerKeep);
    const candidates: Array<{ wallet: string; baseId?: string }> = stable
      ? await db.select({ wallet: bases.ownerWallet, baseId: bases.id })
        .from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
        .innerJoin(players, eq(players.wallet, bases.ownerWallet))
        .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id)).where(and(
          sql`${bases.ownerWallet} != ${attacker}`,
          ...(opts.excludeBaseId ? [ne(bases.id, opts.excludeBaseId)] : []),
          eq(baseSlots.active, true), eq(bases.status, 'active'),
          eq(baseSlots.wallet, bases.ownerWallet),
          iOwnLand ? sql`${bases.landPaidAt} IS NOT NULL` : sql`${bases.landPaidAt} IS NULL`,
          gte(bases.keepLevel, minDefenderKeep),
        )).orderBy(sql`abs(COALESCE(${baseProfiles.trophies}, 0) - ${attackerTrophies})`)
        .limit(RAID_RULES.autoMatchCandidatePool)
      : await db.select({ wallet: players.wallet }).from(players).where(and(
        sql`${players.wallet} != ${attacker}`,
        landTierFilter(iOwnLand),
        gte(players.keepLevel, minDefenderKeep),
      )).orderBy(sql`abs(${players.trophies} - ${attackerTrophies})`)
        .limit(RAID_RULES.autoMatchCandidatePool);
    // Every filter below applies to BOTH pools, and each earns its place on the
    // deedless side too:
    //  - isShielded: a deedless base DOES accrue shield rows — losing a raid
    //    inserts the 24h 'loss' shield below — so dropping it would let one
    //    deedless attacker farm the same fresh signup on repeat.
    //  - attackedToday / warzone cooldown: identical fairness rule; the warzone
    //    semantics are deliberately NOT relaxed for deedless bases (see the note
    //    on the loss-shield insert in submitOrders).
    //  - hasKeep: a base whose Keep is still under construction is not a base.
    // There is no plot filter and there must not be one: a deedless base has no
    // plot row BY DESIGN — that absence is what keeps it off the map.
    const eligible: Array<{ wallet: string; baseId?: string }> = [];
    for (const c of candidates) {
      if (await isShielded(db, c.wallet, now, warzoneActive, c.baseId)) continue;
      if (warzoneActive
        ? await defenderOnWarzoneCooldown(db, c.wallet, now, c.baseId)
        : await attackedToday(db, attacker, c.wallet, now, attackerBase?.id, c.baseId)) continue;
      const hasKeep = await db.select({ id: buildings.id }).from(buildings)
        .where(and(
          c.baseId ? eq(buildings.baseId, c.baseId) : eq(buildings.playerWallet, c.wallet),
          eq(buildings.type, 'keep'),
        )).limit(1);
      if (hasKeep.length === 0) continue;
      eligible.push(c);
    }
    // `code` (app.ts's error handler forwards it, as it does ALPHA_GATED) so the
    // client can branch on WHY and offer the world map / PvE routes this message
    // advises. The alternative it replaces is matching on the message TEXT, which
    // api.ts explicitly warns against — messages get reworded, regexes do not.
    if (eligible.length === 0) {
      if (opts.excludeBaseId) {
        throw new HttpError(404, 'No other target available', 'no_other_targets');
      }
      // Two pools, two HONEST messages + two codes, and both NAME THE RESTRICTION
      // (D-099): a player told "no eligible targets" cannot tell a quiet server
      // from a rule, and the rule is the answer they act on. A deedless player has
      // no world map and no PvE bounty to fall back on, so telling them to "try
      // the world map or PvE" would send them at two screens they cannot use; and
      // the reason their pool is empty is different in kind (nobody else is
      // settling right now), so the client must be able to offer buying land instead.
      throw new HttpError(
        404,
        iOwnLand
          ? `no deeded base at KEEP ≥ ${minDefenderKeep} without a shield or a recent raid right now — try the world map or PvE`
          : `no other settlers at KEEP ≥ ${minDefenderKeep} to raid right now — try CAMPAIGN, or buy your land to join the world`,
        iOwnLand ? 'no_targets' : 'no_targets_deedless',
      );
    }
    // Uniform among the nearest-rated survivors, capped at autoMatchNearestPick:
    // random so one neighbour is not farmed on repeat, nearest so it is still a
    // peer fight (D-099 "random among the nearest ten"). `eligible` keeps the
    // SQL's nearest-first order, so the first N ARE the nearest N.
    const selected = eligible[randomInt(Math.min(eligible.length, RAID_RULES.autoMatchNearestPick))]!;
    defender = selected.wallet;
    if (stable) {
      defenderBase = await defenderRaidBase(db, defender, selected.baseId);
      await opts.authorizeDefenderBase!(defender, defenderBase.id);
    }
  }

  const seed = randomInt(0, 0xffffffff);

  // Phase 2 (atomic): consume energy + create the raid in ONE transaction, tied
  // to the idempotencyKey. The player FOR UPDATE lock serializes an attacker's
  // concurrent creates so raidsToday counting and energy spend can't race.
  return raidEventTransaction(db, async (tx) => {
    const participantWallets = [...new Set([attacker, defender])].sort();
    const lockedPlayers = await tx.select().from(players)
      .where(inArray(players.wallet, participantWallets)).orderBy(asc(players.wallet)).for('update');
    const meLocked = lockedPlayers.find((player) => player.wallet === attacker);
    if (!meLocked) throw new HttpError(404, 'player not found');
    if (!lockedPlayers.some((player) => player.wallet === defender)) {
      throw new HttpError(404, 'defender not found');
    }
    // Re-check idempotency under the lock (a concurrent create with the same key
    // committed while we waited → return that raid rather than double-charging).
    const { existing: again } = await createRetry(tx, attacker, opts.idempotencyKey, binding);
    if (again) return { ...await requireResolvableRaidVersion(tx, again), ...await boundCosmeticRaidFields(tx, again.id), ...await raidStarterFields(tx,again.id,again.snapshot), ...await raidAdvancedFields(tx,again.id,again.snapshot) };
    const lockedBases = stable
      ? await lockRaidBases(tx, [attackerBase!, defenderBase!])
      : new Map<string, ActiveRaidBase>();
    let attackerBaseLocked = attackerBase ? lockedBases.get(attackerBase.id)! : null;
    let defenderBaseLocked = defenderBase ? lockedBases.get(defenderBase.id)! : null;
    if (attackerBaseLocked && defenderBaseLocked
      && (attackerBaseLocked.landPaidAt !== null) !== (defenderBaseLocked.landPaidAt !== null)) {
      throw new HttpError(404, 'defender not found');
    }
    if (attackerBaseLocked) {
      await opts.authorizeAttackerBase!(attacker, attackerBaseLocked.id, tx);
      await opts.authorizeDefenderBase!(defender, defenderBaseLocked!.id, tx);
      await assertBasePlayable(tx, attackerBaseLocked.id);
    }
    // One locked event time governs due sources, shields/warzone, snapshot,
    // Mine reservations and the new deadline. Preflight time cannot survive a
    // lock wait and omit a return already due when loot is frozen.
    const now = await raidTransactionWallNow(tx, explicitTime());
    const warzoneActive = isWarzoneActive(await getGameConfig(tx), now);
    if (attackerBaseLocked) {
      // Builder timers are authoritative at `now`, even if neither owner has
      // polled /base since they elapsed. Materialize BOTH deed states under the
      // already-held participant row locks before freezing heroes, Keep level,
      // geometry, loot or defenses. Re-read base scalars because a due Keep
      // upgrade changes keepLevel in the same transaction.
      await completeDueJobs(tx, attacker, now, attackerBaseLocked.id);
      await completeDueJobs(tx, defender, now, defenderBaseLocked!.id);
      // Original earners can differ from today's owners. Lock their dedicated
      // accounting rows together after both bases, never historical players.
      await lockHarvesterWalletsForBases(tx, [attackerBaseLocked.id, defenderBaseLocked!.id]);
      for (const baseId of [attackerBaseLocked.id, defenderBaseLocked!.id].sort()) {
        await settleDueStarterExpeditions(tx, baseId, now);
        await settleAdvancedExpeditionsAtBoundary(tx, baseId, now);
        await settleDueOrdinaryCrafting(tx, baseId, now);
        await settleDueHarvesterSources(tx, baseId, now);
      }
      const refreshed = await tx.select({
        id: bases.id,
        ownerWallet: bases.ownerWallet,
        keepLevel: bases.keepLevel,
        expansions: bases.expansions,
        landPaidAt: bases.landPaidAt,
        status: bases.status,
      }).from(bases).where(inArray(
        bases.id, [attackerBaseLocked.id, defenderBaseLocked!.id],
      )).orderBy(asc(bases.id));
      attackerBaseLocked = refreshed.find((base) => base.id === attackerBaseLocked!.id)!;
      defenderBaseLocked = refreshed.find((base) => base.id === defenderBaseLocked!.id)!;
      const [defenderOutgoing] = await tx.select({ id: raids.id }).from(raids).where(and(
        eq(raids.attackerBaseId, defenderBaseLocked!.id),
        inArray(raids.status, ['pending_orders', 'resolving']),
      )).limit(1).for('update');
      if (defenderOutgoing) {
        throw new HttpError(
          409,
          'target is currently in another battle',
          'BASE_BUSY_ATTACKING',
        );
      }
      if (await isShielded(tx, defender, now, warzoneActive, defenderBaseLocked!.id)) {
        throw new HttpError(422, 'defender is shielded');
      }
      if (warzoneActive
        ? await defenderOnWarzoneCooldown(tx, defender, now, defenderBaseLocked!.id)
        : await attackedToday(
          tx, attacker, defender, now, attackerBaseLocked.id, defenderBaseLocked!.id,
        )) {
        throw new HttpError(422, warzoneActive
          ? `target was hit in the last ${WARZONE.attackCooldownHours}h — warzone cooldown`
          : 'already attacked today');
      }
    }
    // Candidate reads precede the participant locks and due-job completion.
    // An elapsed Keep upgrade can raise the attacker's minimum target level
    // here; named targets and random picks must obey the same final rule before
    // a raid, energy spend or ante is committed (D-109 feedback verification).
    const finalAttackerKeep = attackerBaseLocked?.keepLevel ?? meLocked.keepLevel;
    const finalDefenderKeep = defenderBaseLocked?.keepLevel
      ?? lockedPlayers.find((player) => player.wallet === defender)!.keepLevel;
    if (!pvpAttackAllowed(finalAttackerKeep, finalDefenderKeep)) {
      throw new HttpError(
        422,
        `their Keep is too far below yours (L${finalDefenderKeep} vs your L${finalAttackerKeep})`,
        'keep_too_far_below',
      );
    }
    await expireStaleRaids(tx, attacker, now, attackerBaseLocked?.id); // reclaim abandoned-raid energy before counting (#58)
    if (attackerBaseLocked) {
      await assertNoUnresolvedOutgoingRaid(tx, attackerBaseLocked.id);
    }
    // Freeze the roster only after the same attacker/base locks used by raid
    // settlement. A pre-transaction read can survive an intervening troop
    // decrement and create a started raid whose frozen army can never settle.
    const armyState = await getArmyState(tx, attacker, now, attackerBaseLocked?.id);
    if (armyState.unsupportedTroops.length > 0) {
      throw new HttpError(409, 'army contains troops unsupported by this server; update before raiding', 'TROOP_ROSTER_UNSUPPORTED');
    }
    const lockedProfile = attackerBaseLocked
      ? await lockBaseProfile(tx, attackerBaseLocked.id)
      : null;
    // Read hero availability only after the player lock. Raid settlement takes
    // the same lock before writing recovery/releasing reservations, so a create
    // cannot freeze a hero from the instant before a concurrent knockout.
    const baseHeroes = attackerBaseLocked
      ? await baseHeroRaidState(tx, attackerBaseLocked.id, now)
      : null;
    const heroes = baseHeroes?.heroes ?? await recruitedHeroes(tx, attacker, now);
    const frozenHeroLevels = baseHeroes?.heroLevels ?? await heroLevelsOf(tx, attacker);
    const heroLoadouts = await frozenHeroLoadouts(
      tx, attacker, heroes, attackerBaseLocked?.id,
    );
    const snapshot = { ...await snapshotDefender(tx, defender, defenderBaseLocked, now),
      battlefieldVersion: RAID_BATTLEFIELD.currentVersion };
    const visualContext = await resolveBaseVisual(tx, defenderBaseLocked?.id);
    // Complete original proof runs under the same participant/base locks and
    // settlement cutoff. The INSERT trigger independently derives structural
    // facts; neither receipt recovery nor replay consults this current view.
    const servicePresentation = defenderBaseLocked ? await readStarterServicePresentation(tx,defenderBaseLocked.id,
      snapshot.buildings.map(b=>({...b,underConstruction:false})),await readStarterFleetView(tx,defenderBaseLocked.id),now) : undefined;
    // SQL validates original lifecycle; TS independently maps its redacted facts.
    const advancedCandidate=defenderBaseLocked?await readRaidAdvancedCandidate(tx,defenderBaseLocked.id,snapshot,now):undefined;
    assertReplayActorCapacity(armyState.counts, heroes.length, snapshot);
    const raidsToday = await pvpRaidsToday(tx, attacker, now, attackerBaseLocked?.id);
    // No daily raid ceiling (owner 2026-07-26): energy + the shard ante below are
    // the whole throttle, so a player with bought energy and shards may keep going.
    const freeRemaining = Math.max(0, RAID_ENERGY.freePerDay - raidsToday);
    // Which bucket this raid spends — persisted so an abandoned (expired) raid can
    // refund it (free returns via the count; purchased via a +1). (#58)
    const energySource = freeRemaining > 0 ? ('free' as const) : ('purchased' as const);
    if (freeRemaining <= 0) {
      const purchasedEnergy = lockedProfile?.purchasedEnergy ?? meLocked.purchasedEnergy;
      if (purchasedEnergy <= 0) {
        throw new HttpError(422, 'out of raid energy — buy more with SOL or wait for tomorrow');
      }
      if (attackerBaseLocked) {
        await consumeBasePurchasedEnergy(tx, attackerBaseLocked.id, now);
      } else {
        await tx.update(players)
          .set({ purchasedEnergy: sql`${players.purchasedEnergy} - 1` })
          .where(eq(players.wallet, attacker));
      }
    }
    // (else a free energy is consumed implicitly — the new raid row bumps raidsToday.)

    // PvP shard ante (owner 2026-07-26), scaled by the ATTACKER's Keep level.
    // Charged in the same tx as the energy spend so a raid can never exist
    // half-paid, and keyed off the idempotencyKey so the FOR UPDATE retry path
    // above (or a client retry) can't double-charge. PvE never reaches here —
    // createPveRaid is a separate path (PVE.costsEnergy).
    const attackerKeepLevel = attackerBaseLocked?.keepLevel ?? meLocked.keepLevel;
    const ante = BigInt(pvpAttackShardCostForKeepLevel(attackerKeepLevel));
    if (ante > 0n) {
      try {
        const metadata = {
          keepLevel: attackerKeepLevel,
          defender,
          ...(attackerBaseLocked ? { attackerBaseId: attackerBaseLocked.id } : {}),
          ...(defenderBaseLocked ? { defenderBaseId: defenderBaseLocked.id } : {}),
        };
        if (attackerBaseLocked) {
          await spendBaseShards(
            tx, attackerBaseLocked.id, ante, 'raid.ante',
            `raid-ante:${idempotencyKey}`, metadata,
          );
        } else {
          await spendShards(
            tx, attacker, ante, 'raid.ante', `raid-ante:${idempotencyKey}`, metadata,
          );
        }
      } catch (e) {
        // A bare ledger InsufficientFundsError would reach the client as a 500
        // and read as "the game broke" rather than "you can't afford this" —
        // and the RaidUI matches on message text to choose what to offer.
        if (e instanceof InsufficientFundsError) {
          throw new HttpError(422, `not enough shards to attack — this raid costs ${ante} shards at Keep ${attackerKeepLevel}`);
        }
        throw e;
      }
    }

    const [raid] = await tx.insert(raids).values({
      idempotencyKey,
      // Daily energy/target counts and cooldowns must use the same locked
      // admission instant. PostgreSQL now() would retain transaction start.
      createdAt: now,
      attackerWallet: attacker,
      ...(attackerBaseLocked ? { attackerBaseId: attackerBaseLocked.id } : {}),
      defenderWallet: defender,
      ...(defenderBaseLocked ? { defenderBaseId: defenderBaseLocked.id } : {}),
      seed: BigInt(seed),
      // Pin the replay protocol before the player starts deploying. A server
      // rollout between create and submit must never resolve this frozen input
      // with a different simulator.
      simVersion: SIM_VERSION,
      snapshot,
      visualContext,
      armySnapshot: {
        // Durable request binding, outside simulator features; legacy rows omit it.
        ...(opts.excludeBaseId ? { createRequest: { excludeBaseId: opts.excludeBaseId } } : {}),
        counts: armyState.counts, levels: armyState.levels, heroes,
        heroLevels: frozenHeroLevels,
        ...(attackerBaseLocked ? { attackerKeepLevel } : {}),
        ...(heroLoadouts ? { heroLoadouts } : {}),
        features: {
          ...armyState.features,
          // Wire capabilities: new clients may use all 30 deploy seconds only
          // after a server advertises the internal batch submission tail, and
          // journal each order (D-099) only after it advertises the journal —
          // old clients keep posting their whole list to /orders.
          ...(!defenderBaseLocked
            ? { batchOrdersGraceSec: RAID_RULES.batchOrdersGraceSec, batchCommandJournal: true }
            : {}),
        },
      },
      // Covers the PRE-BATTLE window PLUS the fight itself: troops may now be
      // committed mid-raid (A3b), so the client submits the completed order list
      // after the battle, not at its start. `deployWindowSec` alone would 422
      // every raid that actually used reserves.
      ordersDeadlineAt: new Date(now.getTime() + raidOrdersWindowMs()),
      status: 'pending_orders',
      energySource,
    }).returning();
    const capturedPresentation=await readRaidStarterPresentation(tx,raid!.id,snapshot);
    if(!isDeepStrictEqual(capturedPresentation,servicePresentation))throw new HttpError(503,'Frozen fleet source changed','RAID_STARTER_CAPTURE_MISMATCH');
    const advancedCapture=await readRaidAdvancedCapture(tx,raid!.id,snapshot);
    if(!isDeepStrictEqual(advancedCapture,advancedCandidate))throw new HttpError(503,'Frozen advanced source changed','RAID_ADVANCED_CAPTURE_MISMATCH');
    if (defenderBaseLocked) {
      await initializeLiveRaid(
        tx, raid!.id, defenderBaseLocked.id, raid!.ordersDeadlineAt, now, raidProtocolVersion,
      );
      await reserveDeedRaidLoot(tx, {
        raidId: raid!.id,
        attackerBaseId: attackerBaseLocked!.id,
        defenderBaseId: defenderBaseLocked.id,
        now,
      });
    } else {
      await initializeBatchRaidJournal(tx, raid!.id, now, raidProtocolVersion);
    }
    await reserveRaidHeroes(tx, raid!, heroes);
    return { ...raid!, raidProtocolVersion, ...await boundCosmeticRaidFields(tx, raid!.id),
      ...(capturedPresentation===undefined?{}:{servicePresentation:capturedPresentation}),
      ...(advancedCapture===undefined?{}:{advancedServicePresentation:advancedCapture.presentation}) };
  });
}

/**
 * PvE raid on a Ruined Keep (GDD §3.6): no energy, no trophies, never breaks
 * your shield; KEEP bounty from the finite emission pool; max 3 camps/day. Tied to the client
 * idempotencyKey so a retry returns the same raid.
 */
export async function createPveRaid(
  db: Db, attacker: string, campId: string, idempotencyKey: string, now = new Date(),
  baseContext?: {
    attackerBaseId?: string | undefined;
    authorizeAttackerBase?: RaidBaseAuthority | undefined;
    raidProtocolVersion?: RaidProtocolVersion | undefined;
    allowRaidProtocolV2?: boolean | undefined;
  },
) {
  const raidProtocolVersion = requestedRaidProtocol(baseContext?.raidProtocolVersion);
  const binding: RaidCreateBinding = {
    operation: 'pve', pveCampId: campId, raidProtocolVersion,
    ...(multiBaseEnabled() && baseContext?.attackerBaseId
      ? { attackerBaseId: baseContext.attackerBaseId } : {}),
  };
  const retry = await createRetry(db, attacker, idempotencyKey, binding);
  const existing = retry.existing;
  if (existing) return requireResolvableRaidVersion(db, existing);
  assertRaidProtocolCreationAllowed(raidProtocolVersion, baseContext?.allowRaidProtocolV2);

  const [me] = await db.select().from(players).where(eq(players.wallet, attacker));
  if (!me) throw new HttpError(404, 'player not found');
  const attackerBase = await attackerRaidBase(db, attacker, baseContext?.attackerBaseId);
  if (attackerBase && !baseContext?.authorizeAttackerBase) {
    throw new HttpError(503, 'fresh raid base authority is required', 'DEED_AUTHORITY_UNAVAILABLE');
  }
  if (attackerBase) await baseContext!.authorizeAttackerBase!(attacker, attackerBase.id);

  const dayStart = new Date(`${utcDay(now)}T00:00:00Z`);
  const camp = await getCampForRaid(db, campId, now);
  const seed = randomInt(0, 0xffffffff);

  return raidEventTransaction(db, async (tx) => {
    const [locked] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, attacker)).for('update');
    if (!locked) throw new HttpError(404, 'player not found');
    const lockedBases = attackerBase ? await lockRaidBases(tx, [attackerBase]) : null;
    const attackerBaseLocked = attackerBase ? lockedBases!.get(attackerBase.id)! : null;
    if (attackerBaseLocked) {
      await baseContext!.authorizeAttackerBase!(attacker, attackerBaseLocked.id, tx);
    }
    const { existing: again } = await createRetry(tx, attacker, idempotencyKey, binding);
    if (again) return requireResolvableRaidVersion(tx, again);

    // Reclaim abandoned camp slots before counting (#58 extended to PvE).
    await expireStaleRaids(tx, attacker, now, attackerBaseLocked?.id);
    if (attackerBaseLocked) {
      await assertBasePlayable(tx, attackerBaseLocked.id);
      await assertNoUnresolvedOutgoingRaid(tx, attackerBaseLocked.id);
    }
    const armyState = await getArmyState(tx, attacker, now, attackerBaseLocked?.id);
    if (armyState.unsupportedTroops.length > 0) {
      throw new HttpError(409, 'army contains troops unsupported by this server; update before raiding', 'TROOP_ROSTER_UNSUPPORTED');
    }
    const todays = await tx.select({ n: sql<number>`count(*)::int` }).from(raids).where(and(
      attackerBaseLocked
        ? eq(raids.attackerBaseId, attackerBaseLocked.id)
        : eq(raids.attackerWallet, attacker),
      sql`${raids.pveCampId} IS NOT NULL`,
      sql`${raids.status} != 'expired'`,
      gte(raids.createdAt, dayStart),
    ));
    if ((todays[0]?.n ?? 0) >= PVE.maxCampsPerDay) {
      throw new HttpError(422, `max ${PVE.maxCampsPerDay} camps per day`);
    }

    const baseHeroes = attackerBaseLocked
      ? await baseHeroRaidState(tx, attackerBaseLocked.id, now)
      : null;
    const heroes = baseHeroes?.heroes ?? await recruitedHeroes(tx, attacker, now);
    const frozenHeroLevels = baseHeroes?.heroLevels ?? await heroLevelsOf(tx, attacker);
    const heroLoadouts = await frozenHeroLoadouts(
      tx, attacker, heroes, attackerBaseLocked?.id,
    );
    assertReplayActorCapacity(armyState.counts, heroes.length, camp.snapshot as BaseSnapshot);
    const [raid] = await tx.insert(raids).values({
      idempotencyKey: retry.idempotencyKey,
      attackerWallet: attacker,
      ...(attackerBaseLocked ? { attackerBaseId: attackerBaseLocked.id } : {}),
      pveCampId: camp.id,
      seed: BigInt(seed),
      simVersion: SIM_VERSION,
      snapshot: { ...(camp.snapshot as BaseSnapshot), battlefieldVersion: RAID_BATTLEFIELD.currentVersion },
      // PvE camps have no realm of their own: they stamp this host's current
      // Crownlands scenery (CURRENT_BASE_VISUAL, lifted only by a realm-kit preview).
      visualContext: currentBaseVisualHere('crownlands'),
      armySnapshot: {
        counts: armyState.counts, levels: armyState.levels, heroes,
        heroLevels: frozenHeroLevels,
        ...(attackerBaseLocked ? { attackerKeepLevel: attackerBaseLocked.keepLevel } : {}),
        ...(heroLoadouts ? { heroLoadouts } : {}),
        features: {
          ...armyState.features,
          batchOrdersGraceSec: RAID_RULES.batchOrdersGraceSec,
          batchCommandJournal: true,
        },
      },
      // Covers the pre-battle deploy window plus the whole fight.
      ordersDeadlineAt: new Date(now.getTime() + raidOrdersWindowMs()),
      status: 'pending_orders',
    }).returning();
    await initializeBatchRaidJournal(tx, raid!.id, now, raidProtocolVersion);
    await reserveRaidHeroes(tx, raid!, heroes);
    return { ...raid!, raidProtocolVersion };
  });
}

/**
 * Campaign raid: stage 1–100 fights its dedicated deterministic campaign base
 * (no rotating camp row involved).
 * FREE like all PvE (no energy, no shard ante, no trophies, no shield break),
 * replayable with no daily cap; the progression value is the STARS, and the
 * one-time first-3★ reward is granted at resolution.
 */
export async function createCampaignRaid(
  db: Db, attacker: string, stage: number, idempotencyKey: string, now = new Date(),
  baseContext?: {
    attackerBaseId?: string | undefined;
    authorizeAttackerBase?: RaidBaseAuthority | undefined;
    raidProtocolVersion?: RaidProtocolVersion | undefined;
    allowRaidProtocolV2?: boolean | undefined;
  },
) {
  const raidProtocolVersion = requestedRaidProtocol(baseContext?.raidProtocolVersion);
  const binding: RaidCreateBinding = {
    operation: 'campaign', campaignStage: stage, raidProtocolVersion,
    ...(multiBaseEnabled() && baseContext?.attackerBaseId
      ? { attackerBaseId: baseContext.attackerBaseId } : {}),
  };
  const retry = await createRetry(db, attacker, idempotencyKey, binding);
  const existing = retry.existing;
  if (existing) return requireResolvableRaidVersion(db, existing);
  assertRaidProtocolCreationAllowed(raidProtocolVersion, baseContext?.allowRaidProtocolV2);
  const [me] = await db.select().from(players).where(eq(players.wallet, attacker));
  if (!me) throw new HttpError(404, 'player not found');
  const attackerBase = await attackerRaidBase(db, attacker, baseContext?.attackerBaseId);
  if (attackerBase && !baseContext?.authorizeAttackerBase) {
    throw new HttpError(503, 'fresh raid base authority is required', 'DEED_AUTHORITY_UNAVAILABLE');
  }
  if (attackerBase) await baseContext!.authorizeAttackerBase!(attacker, attackerBase.id);

  if (!Number.isInteger(stage) || stage < 1 || stage > CAMPAIGN.totalStages) {
    throw new HttpError(404, 'no such campaign stage');
  }
  if (attackerBase) {
    await assertBaseCampaignStageUnlocked(db, attackerBase.id, stage);
  } else if (stage > 1) {
    const [prev] = await db.select({ s: campaignProgress.bestStars }).from(campaignProgress)
      .where(and(eq(campaignProgress.playerWallet, attacker), eq(campaignProgress.stage, stage - 1)));
    if ((prev?.s ?? 0) < CAMPAIGN.unlockStarsRequired) {
      throw new HttpError(422, `clear stage ${stage - 1} first`);
    }
  }

  const snapshot = { ...makeCampaignSnapshot(stage), battlefieldVersion: RAID_BATTLEFIELD.currentVersion };
  const seed = randomInt(0, 0xffffffff);
  return raidEventTransaction(db, async (tx) => {
    const [locked] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, attacker)).for('update');
    if (!locked) throw new HttpError(404, 'player not found');
    const lockedBases = attackerBase ? await lockRaidBases(tx, [attackerBase]) : null;
    const attackerBaseLocked = attackerBase ? lockedBases!.get(attackerBase.id)! : null;
    if (attackerBaseLocked) {
      await baseContext!.authorizeAttackerBase!(attacker, attackerBaseLocked.id, tx);
      await assertBasePlayable(tx, attackerBaseLocked.id);
      await assertBaseCampaignStageUnlocked(tx, attackerBaseLocked.id, stage);
    }
    const { existing: again } = await createRetry(tx, attacker, idempotencyKey, binding);
    if (again) return requireResolvableRaidVersion(tx, again);
    await expireStaleRaids(tx, attacker, now, attackerBaseLocked?.id);
    if (attackerBaseLocked) {
      await assertNoUnresolvedOutgoingRaid(tx, attackerBaseLocked.id);
    }
    const armyState = await getArmyState(tx, attacker, now, attackerBaseLocked?.id);
    if (armyState.unsupportedTroops.length > 0) {
      throw new HttpError(409, 'army contains troops unsupported by this server; update before raiding', 'TROOP_ROSTER_UNSUPPORTED');
    }

    const baseHeroes = attackerBaseLocked
      ? await baseHeroRaidState(tx, attackerBaseLocked.id, now)
      : null;
    const heroes = baseHeroes?.heroes ?? await recruitedHeroes(tx, attacker, now);
    if (!Object.values(armyState.counts).some((count) => count > 0) && heroes.length === 0) {
      const baseId = attackerBaseLocked?.id;
      const progress = baseId
        ? await tx.select({ id: baseQuestProgress.id }).from(baseQuestProgress)
          .innerJoin(quests, eq(quests.id, baseQuestProgress.questId)).where(and(
            eq(baseQuestProgress.baseId, baseId), eq(quests.scope, 'onboarding'),
            eq(quests.templateCode, 'first_raid'),
            or(gte(baseQuestProgress.progress, quests.target), isNotNull(baseQuestProgress.completedAt),
              isNotNull(baseQuestProgress.claimedAt)),
          )).limit(1)
        : await tx.select({ id: questProgress.id }).from(questProgress)
          .innerJoin(quests, eq(quests.id, questProgress.questId)).where(and(
            eq(questProgress.playerWallet, attacker), eq(quests.scope, 'onboarding'),
            eq(quests.templateCode, 'first_raid'),
            or(gte(questProgress.progress, quests.target), isNotNull(questProgress.completedAt),
              isNotNull(questProgress.claimedAt)),
          )).limit(1);
      const priorWin = progress.length ? progress : await tx.select({ id: raids.id }).from(raids).where(and(
        baseId ? eq(raids.attackerBaseId, baseId) : eq(raids.attackerWallet, attacker),
        eq(raids.status, 'resolved'), sql`COALESCE((${raids.result}->>'stars')::int, 0) >= 1`,
      )).limit(1);
      if (priorWin.length === 0) {
        throw new HttpError(422, 'Train troops before starting your first campaign', 'FIRST_CAMPAIGN_ARMY_REQUIRED');
      }
    }
    const frozenHeroLevels = baseHeroes?.heroLevels ?? await heroLevelsOf(tx, attacker);
    const heroLoadouts = await frozenHeroLoadouts(
      tx, attacker, heroes, attackerBaseLocked?.id,
    );
    assertReplayActorCapacity(armyState.counts, heroes.length, snapshot);
    const [raid] = await tx.insert(raids).values({
      idempotencyKey: retry.idempotencyKey,
      attackerWallet: attacker,
      ...(attackerBaseLocked ? { attackerBaseId: attackerBaseLocked.id } : {}),
      campaignStage: stage,
      seed: BigInt(seed),
      simVersion: SIM_VERSION,
      snapshot,
      visualContext: campaignBaseVisualHere(Math.floor((stage - 1) / CAMPAIGN.stagesPerAct) + 1),
      armySnapshot: {
        counts: armyState.counts, levels: armyState.levels, heroes,
        heroLevels: frozenHeroLevels,
        ...(attackerBaseLocked ? { attackerKeepLevel: attackerBaseLocked.keepLevel } : {}),
        ...(heroLoadouts ? { heroLoadouts } : {}),
        features: {
          ...armyState.features,
          batchOrdersGraceSec: RAID_RULES.batchOrdersGraceSec,
          batchCommandJournal: true,
        },
      },
      ordersDeadlineAt: new Date(now.getTime() + raidOrdersWindowMs()),
      status: 'pending_orders',
    }).returning();
    await initializeBatchRaidJournal(tx, raid!.id, now, raidProtocolVersion);
    await reserveRaidHeroes(tx, raid!, heroes);
    return { ...raid!, raidProtocolVersion };
  });
}

/** The player's campaign board: per-stage best stars + the unlock frontier. */
export async function getCampaignBoard(db: Db, wallet: string) {
  const rows = await db.select().from(campaignProgress)
    .where(eq(campaignProgress.playerWallet, wallet));
  const byStage = new Map(rows.map((r) => [r.stage, r]));
  return {
    stages: Array.from({ length: CAMPAIGN.totalStages }, (_, i) => {
      const stage = i + 1;
      const encounter = CAMPAIGN.encounters[i]!;
      const keepLevel = encounter.keepLevel;
      const prev = stage === 1 ? undefined : byStage.get(stage - 1);
      return {
        stage,
        act: Math.floor(i / CAMPAIGN.stagesPerAct) + 1,
        tier: keepLevel,
        keepLevel,
        name: encounter.name,
        theme: encounter.theme,
        tactic: encounter.tactic,
        profile: encounter.profile,
        threat: encounter.threat,
        position: { c: encounter.c, r: encounter.r },
        defenderHero: encounter.defenderHero?.hero ?? null,
        recommendedArmyPoints: CAMPAIGN.recommendedArmyPointsByKeep[keepLevel - 1],
        maxArmyPoints: CAMPAIGN.maxArmyPointsByKeep[keepLevel - 1],
        bestStars: byStage.get(stage)?.bestStars ?? 0,
        unlocked: stage === 1 || (prev?.bestStars ?? 0) >= CAMPAIGN.unlockStarsRequired,
        firstThreeStarClaimed: byStage.get(stage)?.firstThreeStarAt != null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Order submission + resolution
// ---------------------------------------------------------------------------

export async function submitOrders(
  db: Db,
  attacker: string,
  raidId: string,
  body: OrdersBody,
  now?: Date,
  acceptedLiveStream = false,
  systemRecovery = false,
  forcedRetreat = false,
) {
  if (forcedRetreat && !acceptedLiveStream) {
    throw new Error('forced retreat requires an accepted live command stream');
  }
  // Tests may inject a deterministic wall clock. Production samples PostgreSQL,
  // never the API host, and samples again after the terminal rows are locked.
  const requestNow = now ?? await raidDatabaseWallNow(db);
  const [raid] = await db.select().from(raids)
    .where(and(eq(raids.id, raidId), eq(raids.attackerWallet, attacker)));
  if (!raid) throw new HttpError(404, 'raid not found');
  if (!systemRecovery) await assertCurrentRaidAttackerAuthority(db, attacker, raid);
  if (raid.status !== 'pending_orders') throw new HttpError(422, 'raid already resolved');
  const [live] = await db.select({
    mode: raidLiveStates.mode,
    commandProtocolVersion: raidLiveStates.commandProtocolVersion,
    startedAt: raidLiveStates.startedAt,
    closedAt: raidLiveStates.streamClosedAt,
  }).from(raidLiveStates).where(eq(raidLiveStates.raidId, raidId));
  const [retreatControl] = acceptedLiveStream
    ? await db.select({ payload: raidCommands.payload }).from(raidCommands).where(and(
      eq(raidCommands.raidId, raidId), eq(raidCommands.kind, 'retreat'),
    )).limit(1)
    : [];
  if (acceptedLiveStream && (retreatControl !== undefined) !== forcedRetreat) {
    throw new HttpError(
      409,
      'live retreat settlement marker mismatch',
      'RAID_RETREAT_STATE_MISMATCH',
    );
  }
  // Replay ends at the durably accepted simulator clock, including speed
  // changes. Request/recovery wall time can be minutes later than RETREAT.
  const retreatSimNowMs = forcedRetreat
    ? (retreatControl?.payload as { _clock?: { simNowMs?: unknown } } | undefined)?._clock?.simNowMs
    : undefined;
  if (forcedRetreat && (typeof retreatSimNowMs !== 'number'
    || !Number.isSafeInteger(retreatSimNowMs) || retreatSimNowMs < 0
    || retreatSimNowMs >= RAID_RULES.battleDurationSec * 1_000)) {
    throw new HttpError(409, 'retreat replay clock is unavailable', 'RAID_RETREAT_STATE_MISMATCH');
  }
  // The accepted retreat tick is the settlement boundary: the simulator stops
  // there and its exact partial state IS the result — destruction so far,
  // keep, stars, loot, trophies — scored like a horn finish (2026-09-17,
  // tester f7c978e8 + owner on native: a started retreat settled as a
  // 0 % / 0★ placeholder with a zero-star trophy loss while its own archived
  // prefix showed the keep falling; 203 such settlements in the prior 14 days).
  const retreatTicks = forcedRetreat
    ? Math.floor((retreatSimNowMs as number) / COMBAT_TICK_MS) : undefined;
  // A live stream always finishes through its own endpoint. A batch journal
  // (D-099) does so only once an order was journaled: an old client never
  // journals and keeps posting its whole list here, and a journal with nothing
  // in it stays an ordinary batch raid that expires and refunds as before.
  const journaled = live !== undefined && (
    live.mode === 'live'
    || live.startedAt !== null
    // Protocol V2 is authoritative from creation, including the armed
    // pre-ATTACK phase. It may never fall back to a client-authored whole list.
    || live.commandProtocolVersion === LIVE_RAID.protocolVersion
  );
  if (journaled && (!acceptedLiveStream || live.closedAt === null)) {
    throw new HttpError(
      409,
      'this raid uses the live command stream; finish it through the live battle endpoint',
      'RAID_LIVE_STREAM_REQUIRED',
    );
  }
  if (!acceptedLiveStream
    && batchOrdersSubmitDeadlineAt(raid.ordersDeadlineAt).getTime() < requestNow.getTime()) {
    // Expiry is protocol-independent: no combat happened, so even a raid pinned
    // to an unaudited simulator must be closed and its consumed energy restored.
    // Run this before the compatibility gate or a rollout can strand paid energy
    // forever. expireStaleRaids' conditional pending_orders update makes retries
    // idempotent; this path never validates orders or enters the simulator.
    await expireStaleRaids(db, attacker, requestNow);
    throw new HttpError(422, 'deploy window expired');
  }
  // The row is pinned at creation, not first stamped after resolution. A deploy
  // can land between an API rollout and the player's order submission; refuse
  // every unaudited mismatch because re-running it could award a battle the
  // player did not watch. SIM6 has no exception because targeting is outcome-
  // changing. The only preceding mutation is protocol-independent stale expiry/
  // refund above; every unexpired mismatch is rejected before validation,
  // simulation, or combat state.
  await requireResolvableRaidVersion(db, raid);

  // The roster gate can be rolled back between create and submit. Only cancel a
  // frozen gate-ON raid that actually contains dark owned units; a forged dark
  // order against an ordinary snapshot remains an invalid order and must not
  // become a free scouting refund. System-caused cancellation restores the same
  // energy/ante set as a simulator incompatibility, atomically and exactly once.
  const frozenArmy = raid.armySnapshot as {
    counts?: Partial<Record<TroopType, number>>;
    features?: { darkAttackerRoster?: { enabled?: boolean } };
  };
  const frozenDarkEnabled = frozenArmy.features?.darkAttackerRoster?.enabled === true;
  const frozenHasDark = TROOP_TYPES.some((type) => isTrainableTroop(type)
    && isDarkAttackerTroop(type) && (frozenArmy.counts?.[type] ?? 0) > 0);
  if (frozenDarkEnabled && frozenHasDark && !darkAttackerRosterEnabled()) {
    const compensated = await compensatePendingRaid(db, raid, false);
    if (!compensated) {
      throw new HttpError(
        409,
        'started raid retained for authoritative recovery; retry shortly',
        'RAID_SUBMISSION_IN_PROGRESS',
      );
    }
    throw new HttpError(
      409,
      'dark attacker roster was disabled; the raid was cancelled and refundable costs restored',
      'TROOP_ROSTER_INACTIVE',
    );
  }

  // ── ALL player-triggerable validation + the sim run BEFORE any mutation, so
  //    nothing here can throw a 422 that would brick a claimed raid (security
  //    review: a post-claim throw left the raid stuck in 'resolving' forever and
  //    ate the energy). The mutation itself is one atomic transaction below. ──

  // Army validation against the frozen snapshot.
  const armySnap = raid.armySnapshot as {
    counts: Record<TroopType, number>; levels: Record<TroopType, number>;
    heroes?: Array<'vex' | 'theodor'>; heroLevels?: Record<string, number>;
    heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
    attackerKeepLevel?: number;
  };
  const usedCounts = Object.fromEntries(TROOP_TYPES.map((t) => [t, 0])) as Record<TroopType, number>;
  for (const d of body.deploys) {
    if (!isTrainableTroop(d.troop)) throw new HttpError(422, `${d.troop} cannot be deployed directly`);
    // Authorization is frozen with the raid. OFF→ON cannot retroactively make
    // stored dark inventory deployable in a snapshot the client fought as OFF;
    // ON→OFF was system-cancelled above with exact compensation.
    if (isDarkAttackerTroop(d.troop) && !frozenDarkEnabled) {
      throw new HttpError(409, 'this troop is coming soon', 'TROOP_ROSTER_INACTIVE');
    }
    usedCounts[d.troop] += 1;
  }
  for (const t of TROOP_TYPES) {
    if (usedCounts[t] > (armySnap.counts[t] ?? 0)) throw new HttpError(422, `not enough ${t} in camp`);
  }

  // Rally gate (GDD §3.5). Stable raids freeze the selected attacker's Keep at
  // creation, so a sold high Keep or a different base cannot authorize submit.
  // Historical/flag-off rows lack that field and retain the legacy wallet read.
  if (body.rally) {
    const rallyKeepLevel = armySnap.attackerKeepLevel ?? (await db.select({
      keepLevel: players.keepLevel,
    }).from(players).where(eq(players.wallet, attacker)))[0]?.keepLevel;
    if ((rallyKeepLevel ?? 0) < RALLY.unlockKeepLevel) {
      throw new HttpError(422, `Rally unlocks at Keep level ${RALLY.unlockKeepLevel}`);
    }
  }

  // Buffs cost (one of each max; schema enforces booleans). Charged inside the
  // tx below in ONE currency by the sink shim (D-152): Gems → gems_sink, or the
  // legacy KEEP leg that RECYCLES to emission_pool (ECONOMY.md §4b).
  let buffCost = 0;
  if (body.buffs?.warhorn) buffCost += BUFFS.warhorn.costKeep;
  if (body.buffs?.swiftboots) buffCost += BUFFS.swiftboots.costKeep;
  if (body.buffs?.powdercharge) buffCost += BUFFS.powdercharge.costKeep;
  // Direct submissions retain their request currency across async settlement.
  // Recovery of an accepted journal never charges here: its buff commands were
  // paid at acceptance, and acceptedLiveStream fences the settlement debit.
  const buffCurrency = clientCurrencyContext();
  const gemsAvailable = gemsEnabled();
  // Match the sink's post-retirement currency choice before expensive work.
  // This observation grants no posting authority: the ledger still checks the
  // custody fence under its own locks, including a freeze racing simulation.
  const [custody] = buffCost > 0 && !acceptedLiveStream
    ? await db.select({ phase: keepCustodyCutoverState.phase }).from(keepCustodyCutoverState)
      .where(eq(keepCustodyCutoverState.id, true))
    : [];
  const custodyRetired = custody?.phase === 'frozen' || custody?.phase === 'retired';
  if (custodyRetired && !gemsAvailable && buffCurrency.expectedCurrency !== 'GEMS') {
    throw new HttpError(423, 'Custodial KEEP is retired. Refresh your balances and use Gems.', 'KEEP_CUSTODY_FROZEN');
  }
  // Affordability pre-check (friendly early-out; the ledger re-checks under lock
  // inside the tx, so a race just rolls back and stays retryable — never bricks).
  if (buffCost > 0 && !acceptedLiveStream && !buffCurrency.expectedCurrency) {
    const keepBal = custodyRetired ? 0n : (await getOrCreatePlayerAccount(db, attacker, 'player_keep')).balance;
    const gemsBal = gemsAvailable ? (await getOrCreatePlayerAccount(db, attacker, 'player_gems')).balance : 0n;
    if (keepBal < BigInt(buffCost) && gemsBal < BigInt(buffCost)) {
      const preferred = custodyRetired ? 'GEMS' : gemsAvailable ? (buffCurrency.currency ?? 'KEEP') : 'KEEP';
      throw new HttpError(422, `not enough ${preferred} for buffs`, `INSUFFICIENT_${preferred}`);
    }
  }

  if (buffCost > 0 && !acceptedLiveStream && buffCurrency.expectedCurrency) {
    const expectedCurrency = buffCurrency.expectedCurrency;
    const unavailable = expectedCurrency === 'GEMS' ? !gemsAvailable : custodyRetired;
    const balance = unavailable ? 0n : (await getOrCreatePlayerAccount(db, attacker,
      expectedCurrency === 'GEMS' ? 'player_gems' : 'player_keep')).balance;
    // Reject known shortfalls before expensive simulation, but recheck under
    // ledger locks in settlement. This preflight cannot authorize a fallback.
    if (unavailable || balance < BigInt(buffCost)) throw new HttpError(409,
      'the reviewed currency is no longer available for this price; review again', 'CURRENCY_CONSENT_CHANGED',
      { expectedCurrency, cost: String(buffCost), reason: unavailable ? 'currency_unavailable' : 'insufficient_balance' });
  }

  // Resolve deterministically. (exactOptionalPropertyTypes: only set keys.)
  const buffsUsed: NonNullable<RaidOrders['buffs']> = {};
  if (body.buffs?.warhorn) buffsUsed.warhorn = true;
  if (body.buffs?.swiftboots) buffsUsed.swiftboots = true;
  if (body.buffs?.powdercharge) buffsUsed.powdercharge = true;
  // D4a: a hero drop must be a hero this raid's snapshot RECRUITED — frozen at
  // creation exactly like troop counts, so a replay validates identically.
  for (const h of body.heroDeploys ?? []) {
    if (!(armySnap.heroes ?? []).includes(h.hero)) {
      throw new HttpError(422, `you have not recruited ${h.hero} — build their altar first`);
    }
  }
  if ((body.heroDeploys?.length ?? 0) > 0) {
    const deployedHeroes = body.heroDeploys!.map((deploy) => deploy.hero);
    const [reservationRows, recoveringRows] = await Promise.all([
      reservedRaidHeroes(db, raid),
      raid.attackerBaseId
        ? recoveringBaseHeroes(db, raid.attackerBaseId, deployedHeroes, requestNow)
        : db.select({ hero: heroLevels.hero }).from(heroLevels).where(and(
          eq(heroLevels.playerWallet, attacker),
          inArray(heroLevels.hero, deployedHeroes),
          gt(heroLevels.recoveryUntil, requestNow),
        )).then((rows) => rows.map((row) => row.hero)),
    ]);
    const issue = heroRaidAuthorizationIssue(
      deployedHeroes,
      reservationRows,
      recoveringRows,
    );
    if (issue) {
      const compensated = await compensatePendingRaid(db, raid, false);
      if (!compensated) {
        throw new HttpError(409, 'raid reservation changed; retry shortly', 'RAID_SUBMISSION_IN_PROGRESS');
      }
      throw new HttpError(
        409,
        issue.code === 'HERO_RECOVERING'
          ? `${issue.hero} is recovering; refundable costs were restored`
          : `${issue.hero} is not reserved for this raid; refundable costs were restored`,
        issue.code,
      );
    }
  }
  // Stamp the SNAPSHOT's hero level onto each drop: the client never supplies
  // it, so a tampered order cannot field a level the player did not buy.
  const heroDeploys = (body.heroDeploys ?? []).map((h) => ({
    hero: h.hero, tx: h.tx, ty: h.ty, tMs: h.tMs,
    level: armySnap.heroLevels?.[h.hero] ?? 1,
    ...(armySnap.heroLoadouts?.[h.hero] ? { loadout: armySnap.heroLoadouts[h.hero] } : {}),
  }));
  const orders: RaidOrders = {
    deploys: body.deploys,
    ...(heroDeploys.length ? { heroDeploys } : {}),
    ...(Object.keys(buffsUsed).length > 0 ? { buffs: buffsUsed } : {}),
    ...(body.rally ? { rally: body.rally } : {}),
  };
  const snapshot = raid.snapshot as BaseSnapshot;
  // These cheap simulator input checks must precede the durable acceptance
  // receipt. An invalid replay never becomes activity or breaks protection.
  const seenHeroes = new Set<HeroKey>();
  for (const deploy of heroDeploys) {
    if (seenHeroes.has(deploy.hero)) throw new HttpError(422, `duplicate hero deploy: ${deploy.hero}`);
    seenHeroes.add(deploy.hero);
  }
  for (const deploy of [...orders.deploys, ...heroDeploys]) {
    validateDropPoint(snapshot, deploy.tx, deploy.ty);
    if (!Number.isInteger(deploy.tMs) || deploy.tMs < 0 || deploy.tMs >= RAID_RULES.battleDurationSec * 1_000) {
      throw new HttpError(422, `deploy outside the battle: ${deploy.tMs}ms`);
    }
  }
  // Stale frozen inventory is cheap to identify and must never occupy the
  // process-wide CPU slot. Claim only this raid's distributed fence before
  // terminal compensation, so an already-running resolver cannot be cancelled.
  if (!(await liveArmyCoversOrders(db, attacker, usedCounts, raid.attackerBaseId))) {
    const staleLeaseToken = await claimSimulationLease(db, raidId, attacker);
    const compensated = await compensatePendingRaid(db, raid, false, staleLeaseToken, false, usedCounts);
    if (!compensated) {
      throw new HttpError(409, 'raid simulation lease was superseded; retry shortly', 'RAID_SUBMISSION_IN_PROGRESS');
    }
    throw new HttpError(
      409,
      'army changed after this raid started; energy/attempt restored, scouting ante retained',
      'RAID_ARMY_CHANGED',
    );
  }
  // Stable live PvP breaks protection at its first server-accepted deploy.
  // Bulk/batch acceptance also belongs to campaign/PvE activity, but only PvP
  // breaks protection. Do not gate the durable acceptance receipt on mode.
  const acceptsDeploymentHere = !acceptedLiveStream || live?.mode === 'batch';
  // Exact paid orders are not accepted until their selected debit succeeds.
  // A balance/flag race during CPU work must not consume shield protection or
  // leave an activity receipt for a refused command. Live commands are prepaid.
  const deferExactAcceptance = !acceptedLiveStream && buffCost > 0 && buffCurrency.expectedCurrency !== undefined
    && (body.deploys.length > 0 || (body.heroDeploys?.length ?? 0) > 0);
  if (acceptsDeploymentHere && !deferExactAcceptance && (body.deploys.length > 0 || (body.heroDeploys?.length ?? 0) > 0)) {
    await db.transaction(async (tx) => {
      // This bounded transaction is the acceptance boundary, before CPU work.
      // Match the existing player → raid lifecycle lock order. Never retain a
      // pool connection while simulation runs or wait for CPU capacity here.
      const participantWallets = [...new Set([attacker, ...(raid.defenderWallet ? [raid.defenderWallet] : [])])].sort();
      await tx.select({ wallet: players.wallet }).from(players)
        .where(inArray(players.wallet, participantWallets)).orderBy(asc(players.wallet)).for('update');
      const [pending] = await tx.select().from(raids).where(eq(raids.id, raidId)).for('update');
      if (!pending || pending.status !== 'pending_orders') throw new HttpError(422, 'raid already resolved');
      if (!systemRecovery) await assertCurrentRaidAttackerAuthority(tx, attacker, pending);
      if (!acceptedLiveStream && pending.bulkDeploymentAcceptedAt === null) {
        await tx.execute(sql`lock table player_action_events in row exclusive mode`);
        const acceptedAt = await raidTransactionWallNow(tx);
        await tx.update(raids).set({ bulkDeploymentAcceptedAt: acceptedAt }).where(eq(raids.id, raidId));
      }
      if (raid.defenderWallet) {
        if (raid.attackerBaseId) {
          await breakBaseShieldOnAttack(tx, attacker, raid.attackerBaseId, { deferMapInvalidation: true });
        } else {
          await tx.delete(shields).where(eq(shields.playerWallet, attacker));
        }
      }
    });
    if (raid.defenderWallet) await invalidateShieldMap(db, attacker, raid.attackerBaseId ?? undefined);
  }
  // All cheap, attacker-controlled validation is complete. Fence the expensive
  // CPU simulator before entering it so a legal max roster cannot block the
  // API event loop. Admission is fail-fast; only after owning the process slot
  // do we acquire the distributed per-raid lease, so its TTL starts at work.
  // A retreat truncates the run at its tick; a normal finish keeps the exact
  // option shape the early full-destruction proof was computed with.
  const simulationInput = {
    snapshot, orders, seed: Number(raid.seed),
    options: {
      troopLevels: armySnap.levels,
      ...(retreatTicks !== undefined ? { stopAfterTick: retreatTicks } : {}),
    },
  };
  const earlyOutcome = acceptedLiveStream && !forcedRetreat
    ? takeEarlyLiveRaidOutcome(body, raidId, simulationInput) : null;
  let simulationPermit: ReturnType<typeof claimRaidSimulationPermit> | undefined;
  if (!earlyOutcome) {
    try {
      simulationPermit = claimRaidSimulationPermit();
    } catch (error) {
      if (error instanceof RaidSimulationBusyError) {
        // A valid submission refused for server capacity must retain a complete
        // retry window; otherwise repeated BUSY responses can turn into a punitive
        // ante burn even though the player submitted before the deadline.
        await extendBusyRaidDeadline(db, raid, requestNow);
        throw new HttpError(503, error.message, 'RAID_SIMULATION_BUSY');
      }
      throw error;
    }
  }
  try {
  const directActors = Object.values(usedCounts).reduce((sum, count) => sum + count, 0);
  const orderedActorBound = raidSimulationActorBound(snapshot, orders);
  const simulationLeaseToken = !earlyOutcome
    && orderedActorBound > RAID_REPLAY_LIMITS.heavySimulationAboveActors
    ? await claimHeavySimulationLease(db, raid, requestNow)
    : await claimSimulationLease(db, raidId, attacker);
  if (!(await liveArmyCoversOrders(db, attacker, usedCounts, raid.attackerBaseId))) {
    const compensated = await compensatePendingRaid(db, raid, false, simulationLeaseToken, false, usedCounts);
    if (!compensated) {
      throw new HttpError(409, 'raid simulation lease was superseded; retry shortly', 'RAID_SUBMISSION_IN_PROGRESS');
    }
    throw new HttpError(
      409,
      'army changed after this raid started; energy/attempt restored, scouting ante retained',
      'RAID_ARMY_CHANGED',
    );
  }
  let outcome: RaidOutcome;
  try {
    outcome = earlyOutcome ?? await simulationPermit!.run(simulationInput);
  } catch (e) {
    if (forcedRetreat) {
      // Retreat already closed the accepted stream and spends its normal costs.
      // A replay worker failure must remain recoverable, never turn that loss
      // into the simulation-failure refund of an ordinary unresolved battle.
      await releaseSimulationLease(db, raidId, simulationLeaseToken, !(e instanceof SimInputError));
      if (e instanceof RaidSimulationSystemError || e instanceof SimRepresentationLimitError) {
        throw new HttpError(503, 'retreat replay is not ready; retry shortly', 'RAID_SIMULATION_FAILED');
      }
      if (e instanceof SimInputError) throw new HttpError(422, e.message);
      throw e;
    }
    if (e instanceof SimRepresentationLimitError) {
      const compensated = await compensatePendingRaid(db, raid, false, simulationLeaseToken);
      if (!compensated) {
        throw new HttpError(409, 'raid simulation lease was superseded; retry shortly', 'RAID_SUBMISSION_IN_PROGRESS');
      }
      throw new HttpError(422, 'raid replay limit exceeded; the raid was cancelled and refundable costs restored', 'RAID_REPLAY_LIMIT');
    }
    if (e instanceof RaidSimulationSystemError) {
      const compensated = await compensatePendingRaid(db, raid, false, simulationLeaseToken);
      if (!compensated) {
        throw new HttpError(409, 'raid simulation lease was superseded; retry shortly', 'RAID_SUBMISSION_IN_PROGRESS');
      }
      throw new HttpError(
        503,
        'raid simulation failed; the raid was cancelled and refundable costs restored',
        'RAID_SIMULATION_FAILED',
      );
    }
    await releaseSimulationLease(db, raidId, simulationLeaseToken, !(e instanceof SimInputError));
    if (e instanceof SimInputError) throw new HttpError(422, e.message);
    throw e;
  }
  // A retreat archive plays to the accepted retreat clock even when the
  // simulation ended earlier (army wiped, field idle until RETREAT); the
  // truncated run already carries exactly the events up to that tick.
  const replayTicks = retreatTicks ?? outcome.ticks;
  // Refresh after the CPU phase so the fenced atomic-resolution transaction
  // owns a complete lease window even near the worker deadline.
  await renewSimulationLease(db, raidId, simulationLeaseToken);

  const heroRecoveries = attackerHeroRecoveries(outcome.events, armySnap.heroLevels);

  // ── ATOMIC RESOLUTION: claim → all money/state writes → 'resolved', in ONE
  //    transaction. Any failure (concurrent-submit loss, a loot-clamp balance
  //    race, infra) rolls the whole thing back — the raid stays 'pending_orders'
  //    and is retryable rather than half-resolved or bricked. ──
  const tx0 = await raidEventTransaction(db, async (tx) => {
    // Canonical lifecycle lock order is player → raid, matching stale expiry and
    // compatibility compensation. The lease update committed before this tx and
    // holds no lock, so it introduces no inverse edge.
    const participantWallets = [...new Set([
      attacker,
      ...(raid.defenderWallet ? [raid.defenderWallet] : []),
    ])].sort();
    const lockedPlayers = await tx.select({
      wallet: players.wallet,
      keepLevel: players.keepLevel,
      trophies: players.trophies,
    }).from(players).where(inArray(players.wallet, participantWallets))
      .orderBy(asc(players.wallet)).for('update');
    const lockedMe = lockedPlayers.find((p) => p.wallet === attacker);
    const lockedDefender = raid.defenderWallet
      ? lockedPlayers.find((p) => p.wallet === raid.defenderWallet)
      : undefined;
    if (!lockedMe || (raid.defenderWallet && !lockedDefender)) {
      throw new Error(`raid resolution invariant: missing participant for ${raidId}`);
    }
    // Serializes concurrent submits: the loser's WHERE matches 0 rows and bails,
    // rolling back with nothing written (M1 double-resolve guard, now atomic).
    const claimed = await tx.update(raids)
      .set({ status: 'resolving' })
      .where(and(
        eq(raids.id, raidId),
        eq(raids.status, 'pending_orders'),
        eq(raids.simulationLeaseToken, simulationLeaseToken),
      ))
      .returning({ id: raids.id, bulkDeploymentAcceptedAt: raids.bulkDeploymentAcceptedAt });
    if (claimed.length === 0) throw new HttpError(422, 'raid already resolved');

    // Recovery begins only once the authoritative result has won the settlement
    // claim. Using the request timestamp here would silently discount simulation
    // time and any database-lock contention before this transaction.
    const settledAt = await raidTransactionWallNow(tx, now);

    // Only the authoritative, successfully-fenced settlement starts attacker
    // recovery. A retry cannot extend it because only one transaction can claim
    // the raid; GREATEST also protects a later recovery from an older in-flight
    // raid settling second. Existing paid levels are never overwritten.
    if (raid.attackerBaseId) {
      await applyBaseHeroRecoveries(
        tx,
        raid.attackerBaseId,
        heroRecoveries.map((recovery) => ({
          hero: recovery.hero,
          recoveryUntil: new Date(settledAt.getTime() + recovery.durationMs),
        })),
        settledAt,
      );
    } else {
      for (const recovery of heroRecoveries) {
        const recoveryUntil = new Date(settledAt.getTime() + recovery.durationMs);
        await tx.insert(heroLevels).values({
          playerWallet: attacker,
          hero: recovery.hero,
          level: recovery.level,
          recoveryUntil,
          updatedAt: settledAt,
        }).onConflictDoUpdate({
          target: [heroLevels.playerWallet, heroLevels.hero],
          set: {
            recoveryUntil: sql`GREATEST(COALESCE(${heroLevels.recoveryUntil}, '-infinity'::timestamptz), ${recoveryUntil.toISOString()}::timestamptz)`,
            updatedAt: settledAt,
          },
        });
      }
    }

    // Resolve every ledger account this resolution MAY touch (no locks yet), then
    // pre-lock the union in canonical id-ascending order — the SAME order
    // postTransaction locks in. This multi-post transaction would otherwise
    // acquire locks non-monotonically across its buff+loot posts and could
    // deadlock a concurrent single post (e.g. the defender's mine-collect that
    // locks defender_keep then emission_pool). Locking the union up front makes
    // the whole tx's acquisition order canonical (security review #2).
    const pvpVictory = !!(outcome.victory && raid.defenderWallet);
    const deedPvp = !!(raid.defenderWallet && raid.attackerBaseId && raid.defenderBaseId);
    const participantBaseIds = [
      ...(raid.attackerBaseId ? [raid.attackerBaseId] : []),
      ...(raid.defenderBaseId ? [raid.defenderBaseId] : []),
    ].sort();
    const deedOwners = participantBaseIds.length > 0
      ? await tx.select({ id: bases.id, ownerWallet: bases.ownerWallet }).from(bases)
        .where(inArray(bases.id, participantBaseIds))
        .orderBy(asc(bases.id)).for('update')
      : [];
    const attackerDeedOwner = deedOwners.find((base) => base.id === raid.attackerBaseId)?.ownerWallet;
    const defenderDeedOwner = deedOwners.find((base) => base.id === raid.defenderBaseId)?.ownerWallet;
    if ((raid.attackerBaseId && !attackerDeedOwner)
      || (deedPvp && !defenderDeedOwner)) {
      throw new Error(`raid settlement invariant: deed participant vanished for ${raidId}`);
    }
    if (!systemRecovery) await assertCurrentRaidAttackerAuthority(tx, attacker, raid);
    if (deferExactAcceptance) {
      if (claimed[0]!.bulkDeploymentAcceptedAt === null) {
        await tx.execute(sql`lock table player_action_events in row exclusive mode`);
        await tx.update(raids).set({ bulkDeploymentAcceptedAt: settledAt }).where(eq(raids.id, raidId));
      }
      if (raid.defenderWallet) {
        if (raid.attackerBaseId) await breakBaseShieldOnAttack(tx, attacker, raid.attackerBaseId, { deferMapInvalidation: true });
        else await tx.delete(shields).where(eq(shields.playerWallet, attacker));
      }
    }
    if (raid.defenderWallet) {
      await persistSpentDefenderTraps(
        tx, raid.defenderWallet, raid.defenderBaseId, outcome.buildings, settledAt,
      );
    }
    const sys = await bootstrapSystemAccounts(tx);
    const att = await getOrCreatePlayerAccount(tx, attacker, 'player_keep');
    // D-152: buffs are charged in Gems or the legacy KEEP leg (never both, never
    // split), so both currencies' accounts join the deterministic lock set.
    const attGems = buffCost > 0 && !acceptedLiveStream && (gemsEnabled() || buffCurrency.expectedCurrency === 'GEMS')
      ? await getOrCreatePlayerAccount(tx, attacker, 'player_gems') : undefined;
    // SPLIT (owner 2026-07-24): loot moves SHARDS (mined wealth) — buffs are the
    // in-game currency, so the tx touches both currencies' accounts. The PvE
    // camp bounty (a KEEP faucet, dormant since D-069) was removed under D-152:
    // a cleared camp pays nothing.
    const attShards = pvpVictory && !deedPvp
      ? await getOrCreatePlayerAccount(tx, attacker, 'player_shards') : undefined;
    const def = pvpVictory && !deedPvp
      ? await getOrCreatePlayerAccount(tx, raid.defenderWallet!, 'player_shards') : undefined;

    const touched = new Set<string>();
    if (buffCost > 0 && !acceptedLiveStream) {
      touched.add(att.id);
      touched.add(sys.emission_pool);
      if (attGems) { touched.add(attGems.id); touched.add(sys.gems_sink); }
    }
    if (pvpVictory && !deedPvp) {
      touched.add(attShards!.id);
      touched.add(def!.id);
      touched.add(sys.shard_burn);
      touched.add(sys.clan_chest);
    }
    let lockedDefBalance = def?.balance ?? 0n;
    if (touched.size > 0) {
      const locked = await tx.select().from(accounts)
        .where(inArray(accounts.id, [...touched])).orderBy(asc(accounts.id)).for('update');
      const defRow = def ? locked.find((r) => r.id === def.id) : undefined;
      if (defRow) lockedDefBalance = defRow.balance;
    }

    // Buffs recycle (inline so it shares the raid tx; a shortfall throws
    // InsufficientFunds → rollback → retryable). Keyed on the SERVER-authoritative
    // raid id (NOT the client idempotencyKey) so it can't be dedup-farmed across
    // raids for free buffs + free spend_200 (security review #1). A raid resolves
    // at most once, so this is fully idempotent.
    if (buffCost > 0 && !acceptedLiveStream) {
      await spendGameCurrency(
        tx, attacker, BigInt(buffCost), 'raid.buffs', `raid:${raidId}:buffs`,
        { raidId, buffs: body.buffs }, { context: buffCurrency },
      );
    }

    // Loot (GDD §3.3): victory only; 10% surplus (+5% if vault fell), cap
    // keepLevel×1000 (ECONOMY.md §4). Zero-sum vs the defender in SHARDS (the
    // split: mined wealth is raidable, KEEP never is). Ranked leagues take no
    // raid tithe (owner 2026-08-30); the displayed loot is the exact attacker
    // credit. Clamped to the defender's LOCKED balance (read above under FOR
    // UPDATE), so a concurrent defender spend can't make the debit overdraw.
    let loot = 0n;
    let chestCut = 0n;
    if (deedPvp) {
      // D-065: Vault protection reads the FROZEN snapshot level, never the
      // live row (an upgrade finishing mid-raid must not change the settlement).
      const snapshotLevelById = new Map(snapshot.buildings.map((b) => [b.id, b.level]));
      const deedLoot = await settleDeedRaidLoot(
        tx, raidId, outcome.stars,
        outcome.buildings.map((b) => ({
          id: b.id, type: b.type, destroyed: b.destroyed,
          ...(snapshotLevelById.has(b.id) ? { level: snapshotLevelById.get(b.id)! } : {}),
        })),
        settledAt,
      );
      loot = deedLoot.total;
    } else if (pvpVictory) {
      const pct = LOOT.surplusFraction * 100 + (outcome.vaultDestroyed ? LOOT.vaultDestroyedBonusFraction * 100 : 0);
      const attackerKeepLevel = armySnap.attackerKeepLevel ?? lockedMe.keepLevel;
      const cap = BigInt(snapshot.keepLevel === 0 ? 0 : attackerKeepLevel * LOOT.capPerAttackerKeepLevel);
      const raw = (BigInt(snapshot.surplusShards) * BigInt(Math.round(pct))) / 100n;
      loot = raw > cap ? cap : raw;
      if (loot > lockedDefBalance) loot = lockedDefBalance > 0n ? lockedDefBalance : 0n;
      if (loot > 0n) {
        // Clan chest (C3): a slice of the attacker's NET goes to their clan's
        // weekly chest — clans pool what their members actually raid. Same tx as
        // the loot itself, and the per-clan attribution column moves with the
        // pooled account, so sum(clans.chest_shards) == clan_chest balance holds
        // at every commit boundary.
        // Resolve the immutable admitted clan/rate when enrolled. The bounded
        // same-transaction capability retains genuine unenrolled legacy routing.
        const originalClan = await resolveOriginalClanRaidChest(tx, raidId, attacker, loot);
        chestCut = originalClan.chestCut;
        const lootPost = await postTransaction(tx, {
          idempotencyKey: `raid:${raidId}:loot`,
          type: 'raid.loot',
          entries: [
            { account: def!.id, delta: -loot },
            { account: attShards!.id, delta: loot - chestCut },
            ...(chestCut > 0n ? [{ account: sys.clan_chest, delta: chestCut }] : []),
          ],
          metadata: { raidId, attacker, defender: raid.defenderWallet, clanChest: chestCut.toString() },
        });
        // Gated on !duplicate (review #8, defensive parity with settleClanChests)
        // and asserted to hit the locked row (review #1): a 0-row match here
        // means attribution and pool would drift — fail the tx, never commit it.
        if (chestCut > 0n && originalClan.clanId !== null && !lootPost.duplicate) {
          const bumped = await tx.update(clans)
            .set({ chestShards: sql`${clans.chestShards} + ${chestCut}` })
            .where(eq(clans.id, originalClan.clanId))
            .returning({ id: clans.id });
          if (bumped.length !== 1) throw new Error(`clan chest attribution matched ${bumped.length} rows for clan ${originalClan.clanId} — pool/attribution drift`);
        }
        await assertOriginalClanRaidChestPosting(tx, raidId, lootPost.transaction.id);
      }
    }

    // PvP: trophies (Elo-damped) + loser shield. PvE: bounty + camp cleared.
    let attackerDelta = 0;
    let defenderDelta = 0;
    if (raid.defenderWallet) {
      if (deedPvp) {
        const trophyOutcome = await applyBasePvpTrophies(
          tx, raid.attackerBaseId!, raid.defenderBaseId!, outcome.stars, settledAt,
        );
        attackerDelta = trophyOutcome.attackerDelta;
        defenderDelta = trophyOutcome.defenderDelta;
      } else {
        const gap = lockedMe.trophies - lockedDefender!.trophies;
        const factor = Math.min(TROPHIES.maxFactorBps, Math.max(TROPHIES.minFactorBps,
          10_000 - gap * TROPHIES.dampBpsPerTrophy));
        attackerDelta = outcome.stars > 0
          ? Math.max(1, Math.round((TROPHIES.winByStars[outcome.stars - 1] ?? 0) * factor / 10_000))
          : Math.min(-1, Math.round(TROPHIES.zeroStarLoss * (TROPHIES.lossInversionBps - factor) / 10_000));
        defenderDelta = -attackerDelta;
        await tx.update(players)
          .set({ trophies: sql`${players.trophies} + ${attackerDelta}` })
          .where(eq(players.wallet, attacker));
        await tx.update(players)
          .set({ trophies: sql`GREATEST(0, ${players.trophies} + ${defenderDelta})` })
          .where(eq(players.wallet, raid.defenderWallet));
      }

      // #46: create the 48h loss-shield DURING a warzone, but the shared
      // effective-shield resolver suppresses it until the window closes. The
      // row keeps counting down and may protect for its remainder afterward;
      // it never makes the current warzone defender unattackable.
      // The warzone is NOT relaxed for the deedless pool (2026-08-09): the rule is
      // deliberately identical on both sides of the partition, so there is exactly
      // one shield semantic to reason about. ⚠ CONSEQUENCE FOR THE OWNER: a paid
      // WARZONE-source shield is the only protection during a window, and a
      // deedless player cannot buy one (non-`entry` deposit intents are gated), so
      // while a warzone is open deedless bases are attackable every
      // WARZONE.attackCooldownHours by their own pool with no way to opt out.
      // Warzones are admin-opened, so the mitigation today is "don't open one while
      // the free tier is young"; relaxing it needs an owner decision, not a guess.
      if (deedPvp) {
        await grantBaseDefenseShield(
          tx, raid.defenderWallet, raid.defenderBaseId!, outcome.stars,
          settledAt, { deferMapInvalidation: true },
        );
      } else if (outcome.victory) {
        await tx.insert(shields).values({
          playerWallet: raid.defenderWallet,
          ...(raid.defenderBaseId ? { baseId: raid.defenderBaseId } : {}),
          source: 'loss',
          expiresAt: new Date(settledAt.getTime() + SHIELD.hoursOnLoss * 3600 * 1000),
        });
      }
    } else if (raid.pveCampId && outcome.victory) {
      // D-152 amendment: no bounty. The camp is still marked cleared so the
      // daily camp cap and "already cleared" rules keep their meaning.
      await markCampCleared(tx, raid.pveCampId, settledAt);
    } else if (raid.campaignStage && raid.attackerBaseId) {
      const campaignOutcome = await recordBaseCampaignOutcome(
        tx, raid.attackerBaseId, attacker, raid.campaignStage, outcome.stars, settledAt,
      );
      loot = campaignOutcome.rewardShards;
    } else if (raid.campaignStage) {
      // Campaign stars RATCHET (never regress) and the one-time first-3★ shard
      // reward pays exactly once — firstThreeStarAt is the idempotency anchor,
      // stamped in the same UPDATE that checks it was NULL (MAPS split E1).
      const stage = raid.campaignStage;
      const stars = outcome.stars;
      await tx.insert(campaignProgress)
        .values({ playerWallet: attacker, stage, bestStars: stars, updatedAt: settledAt })
        .onConflictDoUpdate({
          target: [campaignProgress.playerWallet, campaignProgress.stage],
          set: {
            bestStars: sql`GREATEST(${campaignProgress.bestStars}, ${stars})`,
            updatedAt: settledAt,
          },
        });
      if (stars >= 3) {
        // Double-pay protection is LAYERED: the ledger idempotency key
        // (campaign-3star:wallet:stage) is the hard guard — proven by mutation:
        // dropping the IS-NULL gate alone cannot double-pay — while the
        // firstThreeStarAt stamp drives the board's claimed flag and keeps the
        // reward path off the ledger entirely on replays.
        const claimed = await tx.update(campaignProgress)
          .set({ firstThreeStarAt: settledAt })
          .where(and(
            eq(campaignProgress.playerWallet, attacker),
            eq(campaignProgress.stage, stage),
            sql`${campaignProgress.firstThreeStarAt} IS NULL`,
          ))
          .returning({ stage: campaignProgress.stage });
        if (claimed.length === 1) {
          const act = Math.ceil(stage / CAMPAIGN.stagesPerAct);
          // Reward is keyed by the AUTHORED row's Keep band, never re-derived
          // arithmetically: a stage→keep mapping change must not silently pay 0.
          const encounter = CAMPAIGN.encounters[stage - 1];
          if (!encounter) throw new Error(`campaign stage ${stage} has no authored encounter row`);
          const keepLevel = encounter.keepLevel;
          const reward = BigInt(CAMPAIGN.firstThreeStarShardsByKeep[keepLevel - 1] ?? 0);
          if (reward > 0n) {
            const { rewardShards } = await import('./spend');
            await rewardShards(tx, attacker, reward, 'campaign.first_three_star',
              `campaign-3star:${attacker}:${stage}`, { stage, act });
          }
        }
      }
    }

    // Troops consumed atomically with the resolution (GDD §3.2).
    await consumeArmy(tx, attacker, usedCounts, raid.attackerBaseId ?? undefined);

    // What the ATTACKER pocketed after their clan's chest cut. Ranked leagues
    // never tithe raid loot; the HUD and steal quest reflect the exact credit.
    const lootNet = loot - chestCut;
    const result = {
      stars: outcome.stars,
      destructionPct: outcome.destructionPct,
      keepDestroyed: outcome.keepDestroyed,
      lootShards: Number(lootNet),
      attackerTrophyDelta: attackerDelta,
      defenderTrophyDelta: defenderDelta,
      ...(forcedRetreat ? { retreated: true as const } : {}),
    };
    if (raid.attackerBaseId) {
      await recordBaseBattle(tx, {
        raidId,
        attackerBaseId: raid.attackerBaseId,
        ...(deedPvp ? { defenderBaseId: raid.defenderBaseId! } : {}),
        attackerOwnerWallet: attackerDeedOwner!,
        ...(deedPvp ? { defenderOwnerWallet: defenderDeedOwner! } : {}),
        stars: outcome.stars,
        destructionPct: outcome.destructionPct,
        // PvE bounty is wallet KEEP, not deed SHARDS. Campaign's one-time
        // reward is deed SHARDS and therefore belongs in the deed delta.
        lootShards: raid.campaignStage ? lootNet : deedPvp ? lootNet : 0n,
        createdAt: settledAt,
      });
    }
    const buildingHealth = safeReplayBuildingHealth(SIM_VERSION, outcome);
    await persistReplayTimeline(tx, raidId, {
      snapshot: raid.snapshot,
      ...(raid.visualContext ? { visualContext: raid.visualContext } : {}),
      ...await boundCosmeticRaidFields(tx, raidId),
      ...await raidStarterFields(tx,raidId,raid.snapshot),
      ...await raidAdvancedFields(tx,raidId,raid.snapshot),
      armySnapshot: raid.armySnapshot,
      orders,
      seed: Number(raid.seed),
      simVersion: SIM_VERSION,
      events: outcome.events,
      result,
      // Display health comes from simulation, including retreat's played prefix.
      ...(buildingHealth ? { buildingHealth } : {}),
    }, replayTicks * COMBAT_TICK_MS);
    const [updated] = await tx.update(raids).set({
      // The FULL replay input (deploys + heroDeploys + buffs + rally) — storing
      // body.deploys alone dropped buffs/rally silently (visual replays play
      // from stored EVENTS, so it never showed) and would have dropped the
      // hero (D4a). "replay = (snapshot, orders, seed)" now actually holds.
      orders,
      status: 'resolved',
      result,
      events: outcome.events,
      // Stamp the simulator that produced the persisted event log. Every mismatch
      // was rejected before this transaction; SIM6 resolves only SIM6 snapshots.
      simVersion: SIM_VERSION,
      simulationLeaseToken: null,
      simulationLeaseUntil: null,
      simulationSystemAttemptedAt: null,
      resolvedAt: settledAt,
    }).where(eq(raids.id, raidId)).returning();
    await releaseRaidHeroes(tx, [raidId]);
    if (!deedPvp) {
      await tx.delete(baseRaidLocks).where(eq(baseRaidLocks.raidId, raidId));
      markRaidBaseChanged(tx, raid.defenderBaseId);
    }
    const shieldMapValley = raid.defenderWallet && outcome.stars > 0
      ? await shieldMapValleyId(
        tx, raid.defenderWallet, raid.defenderBaseId ?? undefined,
      )
      : null;
    return { updated: updated!, result, lootNet, shieldMapValley, settledAt };
  }).catch(async (e: unknown) => {
    if (e instanceof ArmyConsumptionError) {
      const compensated = await compensatePendingRaid(db, raid, false, simulationLeaseToken, false, usedCounts);
      if (!compensated) {
        throw new HttpError(409, 'raid simulation lease was superseded; retry shortly', 'RAID_SUBMISSION_IN_PROGRESS');
      }
      throw new HttpError(
        409,
        'army changed while the raid was resolving; energy/attempt restored, scouting ante retained',
        'RAID_ARMY_CHANGED',
      );
    }
    // Every transactional failure leaves the row pending. Release only our own
    // token so the exact same orders can retry immediately; a newer lease is
    // never cleared by an older worker.
    // Business races are attacker-controlled/retryable and must not become a
    // refundable scouting escape. Only an unknown infrastructure failure is
    // durable evidence of accepted work the server failed to commit.
    const systemFailure = !(e instanceof InsufficientFundsError || e instanceof HttpError);
    await releaseSimulationLease(db, raidId, simulationLeaseToken, systemFailure);
    throw e;
  });

  // Settlement's shield write is now committed. Publishing earlier lets a
  // concurrent cold map read reload the pre-commit shield state and keep it for
  // the cache TTL after this transaction succeeds.
  invalidateShieldMapValley(tx0.shieldMapValley);
  if (deferExactAcceptance && raid.defenderWallet) await invalidateShieldMap(db, attacker, raid.attackerBaseId ?? undefined);

  // ── Non-money, non-blocking side effects AFTER commit: proof-of-play +
  //    quests. A failure here can't brick or double-charge the (already
  //    resolved, committed) raid, so they don't need the transaction. ──
  // Analytics (M23 a13): server-authoritative raid_completed AFTER commit —
  // dashboards count confirmed state changes, never UI clicks. Fire-and-forget.
  serverTrack('raid_completed', attacker, {
    kind: raid.campaignStage ? 'campaign' : raid.pveCampId ? 'pve' : 'pvp',
    stars: outcome.stars,
    victory: outcome.victory,
    ...(raid.campaignStage ? { stage: raid.campaignStage } : {}),
  }, { eventId: `raid:${raidId}` });
  // A no-progress campaign sandbag is free and repeatable; counting it as a
  // proof-of-play raid would let a one-unit 0-star loop satisfy daily activity.
  // Real PvP/PvE resolutions always count, and a campaign attempt counts once it
  // demonstrates actual progress (at least one star).
  if (!raid.campaignStage || outcome.stars > 0) {
    await markRaidAction(db, attacker, tx0.settledAt, raid.attackerBaseId ?? undefined);
  }
  // One volley, one live-quest lookup (M23 a15). Ticks for templates not in
  // today's rotation are no-ops, so every branch pushes unconditionally.
  // K-023 FIXED: buffs are a KEEP sink and no longer tick spend_200 — the
  // spend quests count SHARD spends only (game/spend.ts).
  const attackerTicks: Array<readonly [string, number]> = [];
  // Same sandbag gate as markRaidAction above: a free 0-star campaign loop
  // must not farm the raid-count quest.
  if (!raid.campaignStage || outcome.stars > 0) attackerTicks.push(['raid_3_times', 1]);
  if (outcome.victory) attackerTicks.push(['win_2_raids', 1], ['win_10_raids', 1]);
  // ONBOARDING CHAIN (owner 2026-08-28): "perform first raid". A WIN, on the
  // same sandbag gate as raid_3_times — a 0-star campaign walk-in is not the
  // first raid the chain is teaching, and letting it count would hand a new
  // player the reward for doing nothing.
  if (outcome.victory && (!raid.campaignStage || outcome.stars > 0)) {
    attackerTicks.push(['first_raid', 1]);
  }
  if (directActors > 0) attackerTicks.push(['deploy_20_troops', directActors]);
  const troopDeployTemplates: ReadonlyArray<readonly [string, TroopType]> = [
    ['use_5_highlanders', 'highlander'], ['use_5_bowmen', 'bowman'],
    ['use_3_tunnelers', 'tunneler'], ['use_3_tur_riders', 'turrider'],
    ['use_2_plunderers', 'plunderer'], ['use_2_giants', 'giant'],
    ['use_2_trolls', 'troll'], ['use_a_dragon', 'dragon'], ['use_a_mage', 'mage'],
  ];
  for (const [template, troop] of troopDeployTemplates) {
    if (usedCounts[troop] > 0) attackerTicks.push([template, usedCounts[troop]]);
  }
  if (buffsUsed.warhorn) attackerTicks.push(['use_war_horn', 1]);
  if (buffsUsed.swiftboots) attackerTicks.push(['use_swift_boots', 1]);
  if (buffsUsed.powdercharge) attackerTicks.push(['use_powder_charge', 1]);
  if (heroDeploys.length > 0) {
    attackerTicks.push(['deploy_hero', 1]);
    // heroRecoveries is exactly the set of deployed attacker heroes that fell.
    if (outcome.victory && heroRecoveries.length === 0) attackerTicks.push(['hero_untouched', 1]);
  }
  if (raid.defenderWallet) {
    if (outcome.stars >= 2) attackerTicks.push(['win_2_star', 1]);
    if (outcome.stars === 3) attackerTicks.push(['win_3_star', 1]);
    if (outcome.stars > 0) attackerTicks.push(['earn_5_stars', outcome.stars]);
    if (tx0.lootNet > 0n) {
      attackerTicks.push(
        ['steal_500', Number(tx0.lootNet)],
        ['steal_1500', Number(tx0.lootNet)],
        ['steal_5000', Number(tx0.lootNet)],
      );
    }
    if (outcome.victory) attackerTicks.push(['win_from_map', 1]);
    if (outcome.vaultDestroyed) attackerTicks.push(['vault_buster', 1]);
    if (usedCounts.kegrunner >= 2) attackerTicks.push(['two_keg_runners', 1]);
    if (buffsUsed.warhorn && buffsUsed.swiftboots && buffsUsed.powdercharge) {
      attackerTicks.push(['all_3_buffs', 1]);
    }
  } else if (raid.pveCampId && outcome.victory) {
    attackerTicks.push(['clear_ruined_keep', 1], ['clear_2_keeps', 1], ['clear_5_keeps', 1]);
  } else if (raid.campaignStage) {
    // D-069 (owner 2026-08-23): PvE is the Campaign only — the former Ruined
    // Keep quests count Campaign stage clears so no quest is ever dead.
    if (outcome.victory) {
      attackerTicks.push(['campaign_clear', 1], ['campaign_2_stages', 1]);
      attackerTicks.push(['clear_ruined_keep', 1], ['clear_2_keeps', 1], ['clear_5_keeps', 1]);
    }
    if (outcome.stars === 3) attackerTicks.push(['campaign_3star', 1]);
  }
  await progressQuestBatch(
    db, attacker, attackerTicks, tx0.settledAt, raid.attackerBaseId ?? undefined,
  );
  if (raid.defenderWallet) {
    if (!outcome.victory) {
      if (raid.defenderBaseId) {
        await progressBaseQuest(db, raid.defenderBaseId, 'defend_success', 1, tx0.settledAt);
      } else {
        await progressQuest(db, raid.defenderWallet, 'defend_success', 1, tx0.settledAt);
      }
    }
    await progressWeeklyStars(
      db, attacker, outcome.stars, tx0.settledAt, raid.attackerBaseId ?? undefined,
    );
  }

  return { raid: tx0.updated, result: tx0.result, outcome: { vaultDestroyed: outcome.vaultDestroyed } };
  } finally {
    await simulationPermit?.release();
  }
}

/** Resolve disconnected battles from their canonical journaled input — the
 * server-stamped live stream and, since D-099, the client-stamped batch journal
 * of a PvE/campaign/legacy raid whose client never posted its final list.
 * Started raids are never abandoned or refunded: once the battle clock ends,
 * this bounded sweep closes the append-only stream and submits it through the
 * exact same deterministic settlement path as an online attacker. `raidId`
 * scopes a sweep to one march — a batch journal has no defender deed to scope
 * by. */
export async function recoverDueStartedLiveRaids(
  db: Db,
  now?: Date,
  defenderBaseId?: string,
  raidId?: string,
): Promise<{ resolved: number; raced: number }> {
  await autoStartDueLiveRaids(db, now, raidId, defenderBaseId);
  const scanNow = now ?? await raidDatabaseWallNow(db);
  const due = await db.select({
    raidId: raids.id,
    attackerWallet: raids.attackerWallet,
  }).from(raidLiveStates).innerJoin(raids, eq(raids.id, raidLiveStates.raidId))
    .where(and(
      eq(raids.status, 'pending_orders'),
      isNotNull(raidLiveStates.startedAt),
      isNotNull(raidLiveStates.battleEndsAt),
      or(
        lte(raidLiveStates.battleEndsAt, scanNow),
        sql`EXISTS (
          SELECT 1 FROM raid_commands retreat_recovery
          WHERE retreat_recovery.raid_id = ${raids.id}
            AND retreat_recovery.kind = 'retreat'
        )`,
      ),
      ...(defenderBaseId ? [eq(raids.defenderBaseId, defenderBaseId)] : []),
      ...(raidId ? [eq(raids.id, raidId)] : []),
    ))
    .orderBy(asc(raidLiveStates.battleEndsAt))
    .limit(LIVE_RAID.recoveryBatchSize);
  let resolved = 0;
  let raced = 0;
  const failures: unknown[] = [];
  for (const row of due) {
    try {
      // Omitted production clocks force closeLiveRaidStream to sample
      // PostgreSQL again after locking both authoritative rows.
      const orders = await closeLiveRaidStream(db, row.attackerWallet, row.raidId, now, true);
      // Production omits a caller clock so settlement samples PostgreSQL after
      // its locks. Deterministic tests retain their explicit injected instant.
      await submitOrders(
        db, row.attackerWallet, row.raidId, orders, now, true, true,
        orders.retreated === true,
      );
      resolved += 1;
    } catch (error) {
      if (error instanceof HttpError && (
        error.code === 'RAID_SUBMISSION_IN_PROGRESS'
        || error.code === 'RAID_CLOCK_NOT_DUE'
        || error.message === 'raid already resolved'
      )) {
        raced += 1;
        continue;
      }
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `failed to recover ${failures.length} live raid(s)`);
  }
  return { resolved, raced };
}

/** Cancel reservations that never became an attack. The first deploy is the
 * attack boundary; if it never arrives inside the deploy window, energy, ante,
 * loot escrow, hero reservations, Mine buffers, and the defender lock all return
 * exactly once through the ordinary compensation transaction. */
export async function recoverNeverStartedLiveRaids(
  db: Db,
  now = new Date(),
  defenderBaseId?: string,
): Promise<{ released: number; raced: number }> {
  const latestCreatedAt = new Date(now.getTime() - RAID_RULES.deployWindowSec * 1_000);
  const stale = await db.select({
    id: raids.id,
    attackerWallet: raids.attackerWallet,
    simVersion: raids.simVersion,
  }).from(raidLiveStates).innerJoin(raids, eq(raids.id, raidLiveStates.raidId))
    .where(and(
      eq(raids.status, 'pending_orders'),
      // An empty batch journal is not a reservation (D-099): it keeps the
      // whole batch window plus tail and expires through expireStaleRaids.
      eq(raidLiveStates.mode, 'live'),
      isNull(raidLiveStates.startedAt),
      lte(raids.createdAt, latestCreatedAt),
      ...(defenderBaseId ? [eq(raids.defenderBaseId, defenderBaseId)] : []),
    ))
    .orderBy(asc(raids.createdAt))
    .limit(LIVE_RAID.recoveryBatchSize);
  let released = 0;
  let raced = 0;
  for (const raid of stale) {
    if (await compensatePendingRaid(db, raid, false, undefined, true)) released += 1;
    else raced += 1;
  }
  return { released, raced };
}

export async function recoverLiveRaidLifecycle(
  db: Db,
  now?: Date,
  defenderBaseId?: string,
) {
  // Recovery may run inside ANOTHER wallet's request (a defender's view) or the
  // scheduler: never inherit that request's advertised currency (D-152 hygiene).
  return withClientCurrency(undefined, async () => {
    const lifecycleNow = now ?? await raidDatabaseWallNow(db);
    const neverStarted = await recoverNeverStartedLiveRaids(db, lifecycleNow, defenderBaseId);
    const started = await recoverDueStartedLiveRaids(db, now, defenderBaseId);
    return { neverStarted, started };
  });
}

// ---------------------------------------------------------------------------
// Reads: log + replay
// ---------------------------------------------------------------------------

export async function getRaidLog(db: Db, wallet: string, now = new Date()) {
  // The log is also the lost-response recovery surface. Sweep this attacker's
  // expired marches first so it can never advertise a hero reservation whose
  // deadline already passed; expiry releases energy/reservations atomically.
  await expireStaleRaids(db, wallet, now);
  const rows = await db.select().from(raids)
    .where(or(eq(raids.attackerWallet, wallet), eq(raids.defenderWallet, wallet)))
    .orderBy(desc(raids.createdAt))
    .limit(RAID_RULES.replayRetention);
  // The log used to render a raw base58 wallet as "who you fought". Resolve the
  // opponent's username + Seeker badge in one extra read so the log identifies
  // people the same way every other surface does.
  const opponents = [...new Set(rows.map((r) => (r.attackerWallet === wallet ? r.defenderWallet : r.attackerWallet)))]
    .filter((w): w is string => !!w);
  const ident = new Map<string, { name: string; seeker: boolean }>();
  if (opponents.length > 0) {
    const ps = await db.select({ wallet: players.wallet, name: players.name, seeker: players.seekerVerified })
      .from(players).where(inArray(players.wallet, opponents));
    ps.forEach((p) => ident.set(p.wallet, { name: p.name, seeker: p.seeker }));
  }
  return rows.map((r) => {
    const opponent = r.attackerWallet === wallet ? r.defenderWallet : r.attackerWallet;
    const who = opponent ? ident.get(opponent) : undefined;
    const mine = r.attackerWallet === wallet;
    return {
      id: r.id,
      role: mine ? 'attacker' : 'defender',
      opponent,
      /** '' for PvE / unknown — the client falls back to the short wallet. */
      opponentName: who?.name ?? '',
      opponentSeeker: who?.seeker ?? false,
      status: r.status,
      result: r.result,
      createdAt: r.createdAt,
      resumable: mine && r.status === 'pending_orders' && r.simVersion === SIM_VERSION,
    };
  });
}

/** Attacker-only frozen create payloads for lost-response recovery. Kept off the
 * ordinary raid log so opening Profile never downloads large base snapshots.
 * The `heroReserved` bit lets a HERO_ALREADY_COMMITTED recovery choose the
 * march that actually owns a hero rather than an unrelated hero-less pending
 * raid. */
function pendingRaidResumeDto(
  r: typeof raids.$inferSelect,
  heroReserved: boolean,
  liveState?: Awaited<ReturnType<typeof getRaidClock>>,
  boundCosmeticVisual?: BoundCosmeticBaseRead,
  servicePresentation?: RaidStarterPresentation|null,
  advancedServicePresentation?: RaidAdvancedPresentation|null,
) {
  return {
    id: r.id,
    defenderWallet: r.defenderWallet,
    attackerBaseId: r.attackerBaseId,
    defenderBaseId: r.defenderBaseId,
    pveCampId: r.pveCampId,
    campaignStage: r.campaignStage,
    snapshot: r.snapshot,
    visualContext: resolveBaseVisualContext(r.visualContext),
    ...(boundCosmeticVisual === undefined ? {} : { boundCosmeticVisual }),
    ...(servicePresentation===undefined?{}:{servicePresentation}),
    ...(advancedServicePresentation===undefined?{}:{advancedServicePresentation}),
    armySnapshot: r.armySnapshot,
    ordersDeadlineAt: r.ordersDeadlineAt,
    seed: Number(r.seed),
    simVersion: r.simVersion,
    heroReserved,
    raidProtocolVersion: (liveState?.live.commandProtocolVersion
      ?? LIVE_RAID.legacyProtocolVersion) as RaidProtocolVersion,
    live: liveState ? {
      clock: liveState.clock,
      startedAt: liveState.live.startedAt,
      armedAt: liveState.live.armedAt,
      streamClosedAt: liveState.live.streamClosedAt,
      lastSequence: liveState.live.lastSequence,
    } : null,
  };
}

async function pendingResumeWithClock(
  db: Db,
  row: typeof raids.$inferSelect,
  heroReserved: boolean,
  now?: Date,
) {
  const [live] = await db.select({ raidId: raidLiveStates.raidId }).from(raidLiveStates)
    .where(eq(raidLiveStates.raidId, row.id));
  return pendingRaidResumeDto(
    row,
    heroReserved,
    live ? await getRaidClock(db, row.id, now) : undefined,
    (await boundCosmeticRaidFields(db, row.id)).boundCosmeticVisual,
    await readRaidStarterPresentation(db,row.id,row.snapshot),
    (await raidAdvancedFields(db,row.id,row.snapshot)).advancedServicePresentation,
  );
}

/** The bounded HERO_ALREADY_COMMITTED recovery set. Each active deed may reserve
 * its own authored roster; the helper caps this by active-deeds × hero count. */
export async function getPendingHeroRaidResumes(db: Db, wallet: string, now?: Date) {
  await expireStaleRaids(db, wallet, now ?? await raidDatabaseWallNow(db));
  const raidIds = await pendingHeroReservationRaidIds(db, wallet);
  if (raidIds.length === 0) return [];
  const rows = await db.select().from(raids).where(and(
    eq(raids.attackerWallet, wallet),
    eq(raids.status, 'pending_orders'),
    eq(raids.simVersion, SIM_VERSION),
    inArray(raids.id, raidIds),
  )).orderBy(desc(raids.createdAt)).limit(raidIds.length);
  return Promise.all(rows.map(async (r) => pendingRaidResumeDto(r, true, undefined,
    (await boundCosmeticRaidFields(db, r.id)).boundCosmeticVisual,await readRaidStarterPresentation(db,r.id,r.snapshot),(await raidAdvancedFields(db,r.id,r.snapshot)).advancedServicePresentation)));
}

/** Every current-simulator attacker march, not only the one that happened to
 * reserve a hero. The canonical live cursor/clock lets another tab reconcile
 * before it appends any command. */
export async function getPendingRaidResumes(db: Db, wallet: string, now?: Date) {
  await expireStaleRaids(db, wallet, now ?? await raidDatabaseWallNow(db));
  const rows = await db.select().from(raids).where(and(
    eq(raids.attackerWallet, wallet),
    eq(raids.status, 'pending_orders'),
    eq(raids.simVersion, SIM_VERSION),
  )).orderBy(desc(raids.createdAt)).limit(LIVE_RAID.reconnectPageSize);
  return Promise.all(rows.map(async (row) => pendingResumeWithClock(
    db, row, (await reservedRaidHeroes(db, row)).length > 0, now,
  )));
}

/** Exact Raid-Log continuation. The immutable id is attacker-authorized and
 * returns at most one frozen payload, including hero-less campaign/PvE raids. */
export async function getPendingRaidResume(
  db: Db,
  wallet: string,
  raidId: string,
  now?: Date,
) {
  await expireStaleRaids(db, wallet, now ?? await raidDatabaseWallNow(db));
  const [row] = await db.select().from(raids).where(and(
    eq(raids.id, raidId),
    eq(raids.attackerWallet, wallet),
    eq(raids.status, 'pending_orders'),
    eq(raids.simVersion, SIM_VERSION),
  )).limit(1);
  if (!row) return null;
  const reservation = await reservedRaidHeroes(db, row);
  return pendingResumeWithClock(db, row, reservation.length > 0, now);
}

/** The replay bundle. Clients play the persisted event log; snapshot/orders/seed
 * remain proof/debug inputs and preserve deterministic auditability. */
export async function getReplay(db: Db, wallet: string, raidId: string, includeNativeHealth = false) {
  const [r] = await db.select().from(raids).where(eq(raids.id, raidId));
  if (!r || (r.attackerWallet !== wallet && r.defenderWallet !== wallet)) {
    throw new HttpError(404, 'replay not found');
  }
  if (r.status !== 'resolved') throw new HttpError(422, 'raid not resolved');
  let buildingHealth;
  let cosmetic = await boundCosmeticRaidFields(db, r.id);
  let starter: {servicePresentation?:RaidStarterPresentation|null}={};
  let advanced: {advancedServicePresentation?:RaidAdvancedPresentation|null}={};
  const [timeline] = await db.select().from(raidReplayTimelines).where(eq(raidReplayTimelines.raidId, raidId));
  if (timeline) {
    try {
      const archived = decodeReplayTimeline(timeline);
      if((archived.servicePresentation!==undefined||archived.advancedServicePresentation!==undefined)&&!isDeepStrictEqual(archived.snapshot,r.snapshot))
        throw Error('Frozen starter archive differs from the returned original snapshot');
      cosmetic = archived.boundCosmeticVisual === undefined ? {} : { boundCosmeticVisual: archived.boundCosmeticVisual };
      starter=archived.servicePresentation===undefined?{}:{servicePresentation:archived.servicePresentation};
      advanced=archived.advancedServicePresentation===undefined?{}:{advancedServicePresentation:archived.advancedServicePresentation};
      if (includeNativeHealth) buildingHealth = archivedBuildingHealth(archived);
    } catch { throw new HttpError(409, 'replay archive failed its integrity check'); }
  } else {starter=await raidStarterFields(db,r.id,r.snapshot);advanced=await raidAdvancedFields(db,r.id,r.snapshot);}
  return {
    id: r.id,
    snapshot: r.snapshot,
    visualContext: resolveBaseVisualContext(r.visualContext),
    ...cosmetic,
    ...starter,
    ...advanced,
    orders: r.orders,
    seed: Number(r.seed),
    simVersion: r.simVersion,
    events: r.events,
    result: r.result,
    armySnapshot: r.armySnapshot,
    ...(includeNativeHealth ? { buildingHealth } : {}),
  };
}
