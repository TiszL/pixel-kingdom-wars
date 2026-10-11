/**
 * SHARDKEEP shared types. All NUMBERS live in constants.ts — never here.
 * References: docs/ARCHITECTURE.md §5–§6, GDD v1.5 §3–§4, docs/research/read-app-data-model.md.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Troops
// ---------------------------------------------------------------------------

export const TROOP_TYPES = [
  'highlander',
  'bowman',
  'kegrunner',
  'tunneler',
  'turrider',
  'plunderer',
  // Pixel Kingdom Wars roster (owners 2026-07-20/2026-08-11). Training remains
  // governed by NEW_ROSTER_ENABLED; Wyrmling is defender-only and never trained.
  'giant',
  'troll',
  'dragon',
  'mage',
  'bilgewraith',
  // Dark attacker family (owner 2026-08-11 delegated balance design). The
  // Barrowling is still a TroopType because the deterministic sim and replay
  // renderer spawn it, but it is never a barracks/deploy unit.
  'gloamfang',
  'direwyvern',
  'hexbarrow',
  'barrowling',
  'wyrmling',
] as const;

export type TroopType = (typeof TROOP_TYPES)[number];

/** Troop counts (an army roster). */
export type TroopCounts = Record<TroopType, number>;

/** Ordered additional troops, never a desired total roster. */
export type TrainingComposition = Array<{ troop: TroopType; count: number }>;
export interface TrainingPreset { slot: number; name: string; composition: TrainingComposition }
export interface TrainingQueueConsentRow { id: string; startedAt: string; finishesAt: string }
export interface TrainingScheduleConsent {
  version: 2;
  queue: TrainingQueueConsentRow[];
  unitDurations: Array<{ troop: TroopType; durationMs: number }>;
}
export interface TrainingFinishAllConsent {
  version: 2;
  queue: TrainingQueueConsentRow[];
  maxCostKeep: string;
}
export interface TrainingFreeFinishOffer {
  offer: 'first_troops';
  consent: TrainingFinishAllConsent;
}
export interface TrainingFreeFinishReceipt {
  idempotencyKey: string;
  baseId: string | null;
  consent: TrainingFinishAllConsent;
  completed: Array<{ troop: TroopType; count: number }>;
}
export interface TrainingQuote {
  requested: TrainingComposition;
  queueable: TrainingComposition;
  remaining: Array<{ troop: TroopType; count: number; reason: string }>;
  costShards: string;
  availableShards: string;
  camp: { used: number; capacity: number; after: number };
  barracks: { used: number; capacity: number; after: number };
  /** Total time until the selected batch's final unit, including the existing lane. */
  completionSec: number;
  consent: TrainingScheduleConsent;
  schedule: {
    version: 2; mode: 'sequential'; serverNow: string;
    startsAt: string; finishesAt: string; waitMs: number; durationMs: number;
  };
}
export interface TrainingBatchResult {
  queue: Array<{ id: string; troop: TroopType; finishesAt: string }>;
  costShards: string;
  replayed: boolean;
}
export interface PreviousArmy {
  raidId: string | null;
  composition: TrainingComposition;
  message: string | null;
}

/** Per-troop research levels (1–3, gated by Forge level — GDD Addendum B1). */
export type TroopLevels = Record<TroopType, number>;

/** SIM9 authored combat vocabulary. Kept shared so persisted replay records and
 * every renderer agree without reverse-engineering troop names. */
export type TroopAttackMode = 'melee' | 'projectile' | 'stream' | 'detonate';
export type TroopAttackTechnique =
  | 'strike' | 'slam' | 'rend' | 'arrow' | 'boulder' | 'bolt' | 'breath'
  | 'hexshot' | 'claw' | 'firestorm' | 'maul' | 'detonate';

export type DefenseProjectile = 'cannonball' | 'arrow' | 'shell' | 'beam';

/** One defense shot owns its visible body release and projectile arrival. */
export interface DefenseFireEvent {
  t: number;
  e: 'fire';
  id: string;
  target: number;
  proj: DefenseProjectile;
  ix: number;
  iy: number;
  releaseOffsetMs: number;
  flightMs: number;
  impactOffsetTicks: number;
}

/** A compact run of identical authored attack cycles. `impactOffsetsTicks`
 * repeats for every cycle (Dragon has several stream contacts); target geometry
 * is frozen, so a run may only merge while all target fields remain identical. */
export interface AttackRunEvent {
  t: number;
  e: 'attackRun';
  id: number;
  side: 'attacker' | 'defender';
  troop: TroopType;
  targetKind: 'troop' | 'building';
  target: number | string;
  ix: number;
  iy: number;
  mode: TroopAttackMode;
  technique: TroopAttackTechnique;
  /** Exact authored clocks for a 60fps renderer; tick offsets remain the
   * authoritative deterministic damage boundary. */
  cycleMs: number;
  releaseOffsetMs: number;
  cycleTicks: number;
  releaseOffsetTicks: number;
  impactOffsetsTicks: number[];
  cadenceTicks: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/** Every placeable building, walls included (GDD §3.1 + Addendum B5/B6). */
export enum BuildingType {
  Keep = 'keep',
  Mine = 'mine',
  Vault = 'vault',
  Barracks = 'barracks',
  Forge = 'forge',
  Camp = 'camp',
  Cannon = 'cannon',
  ArcherTower = 'archertower',
  Mortar = 'mortar',
  AirDefence = 'airdefence',
  SpikeTrap = 'spiketrap',
  PowderMine = 'powdermine',
  Pitfall = 'pitfall',
  AirMine = 'airmine',
  Wall = 'wall',
  // Pixel Kingdom Wars epic defenses (owner 2026-07-20) — DARK until NEW_ROSTER_ENABLED.
  ElectricTower = 'electrictower',
  MageTower = 'magetower',
  LaserTower = 'lasertower',
  DragonNest = 'dragonnest',
  /** Gold Forge — the shards→KEEP fusion building (owner 2026-07-24): its level
   * gates the player's daily forge-contribution cap (FORGE.contributionCapByLevel). */
  GoldForge = 'goldforge',
  /** Hero altars (overnight 2026-07-26, HEROES MVP): placing one recruits its
   * hero at L1. Vex's Shardborn Altar (2×2) and Theodor's Siege Stool (2×2).
   * Combat integration is a separate phase — see OVERNIGHT-INTEGRATION-PLAN D4. */
  HeroAltar = 'heroaltar',
  SiegeStool = 'siegestool',
  ClanHall = 'clanhall',
  /** Phase E service buildings + the vehicle berth (D-152 §5, owner 2026-09-20;
   * E2-WORKSHOP-CONTRACT §1 commit A). DARK: placement is refused until
   * PHASE_E_BUILDINGS_ENABLED (commit B, SIM 18); today they only exist as enum
   * values and constants rows so no replay can contain them (SIM byte-identical).
   * One `berth` type: occupied/away/exhausted and every vehicle family are
   * combat-identical (E1-ASSET-INTEGRATION §4) — the visual family is an
   * attribute of the building row, never a type. */
  Workshop = 'workshop',
  Lodge = 'lodge',
  Market = 'market',
  Harvester = 'harvester',
  Berth = 'berth',
}

export type DefenseType =
  | 'cannon' | 'archertower' | 'mortar' | 'airdefence'
  | 'electrictower' | 'magetower' | 'lasertower' | 'dragonnest';
export const TRAP_TYPES = ['spiketrap', 'powdermine', 'pitfall', 'airmine'] as const;
export type TrapType = (typeof TRAP_TYPES)[number];
export type StructureType = 'keep' | 'vault' | 'mine' | 'barracks' | 'forge' | 'camp' | 'wall' | 'goldforge' | 'heroaltar' | 'siegestool' | 'clanhall'
  // Phase E (D-152 §5, dark): passive destructibles, hp only, no attack fields.
  | 'workshop' | 'lodge' | 'market' | 'harvester' | 'berth';

export interface Building {
  id: string;
  type: BuildingType;
  /** Gameplay level. Wall art uses five tiers; tier-based building/trap art keeps four. */
  level: number;
  /** Tile coordinates of the top-left footprint corner within the plot. */
  tx: number;
  ty: number;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export type League = 'bronze' | 'silver' | 'gold' | 'sol';

export interface LeagueRewardItem {
  itemId: 'keg_of_haste' | 'finishers_seal';
  qty: number;
}

/** Authenticated, base-scoped projection returned by GET /leagues. Bigint
 * amounts cross the JSON boundary as decimal strings. */
export interface LeagueOverview {
  week: {
    startsAt: string;
    closesAt: string;
    settlesAt: string;
  };
  rewards: {
    status: 'disabled' | 'scheduled' | 'active';
    firstSettlementAt: string;
    minRatedAttacks: number;
    maxRewardedBasesPerWallet: number;
  };
  trophyModel: 'cumulative';
  you: {
    baseId: string;
    trophies: number;
    tier: League;
    currentWeekRatedAttacks: number;
    participationMet: boolean;
    rewardCandidate: boolean;
    blockedByHigherBase: boolean;
  } | null;
  board: Array<{
    rank: number;
    baseId: string;
    name: string | null;
    trophies: number;
    tier: League;
    you: boolean;
  }>;
  lastSettlement: {
    week: string;
    tier: League;
    trophies: number;
    keepLevel: number;
    cacheShards: string;
    items: LeagueRewardItem[];
    settledAt: string;
  } | null;
}

/** Why the selected kingdom is or is not in the projected season places. */
export type LeagueSeasonYouReason = 'placed' | 'needs_trophies' | 'needs_rated_attacks'
  | 'needs_weekly_score' | 'another_kingdom' | 'beyond_places';

/** Authenticated, read-only GET /leagues/season (overnight builder 2026-10-06).
 * A projection of the current weekly season: nothing here is a claim, an
 * allocation record or a payment. Raw SKR amounts are decimal strings. */
export interface LeagueSeasonView {
  serverTime: string;
  refreshAfterSec: number;
  season: { week: string; startsAt: string; closesAt: string; settlesAt: string };
  /** The fixed weekly league rewards, lowest league first, for the selected
   * kingdom's Keep level (null amounts when no kingdom is selected). */
  tierRewards: {
    keepLevel: number | null;
    tiers: Array<{ tier: League; fromTrophies: number; cacheShards: string | null; items: LeagueRewardItem[] }>;
  };
  prize: {
    currency: 'SKR';
    /** 'unset' = no pot is configured: every amount is null. */
    status: 'unset' | 'devnet_test';
    potRaw: string | null;
    decimals: number | null;
    ranking: 'weekly_net';
    minWeeklyScore: number;
    minRatedAttacks: number;
    maxPlaces: number;
    /** Contiguous places 1..maxPlaces. Band 1 rows are one place each and
     * shareBps is that place's share; band 2/3 rows cover a range and
     * shareBps is the whole band's share, split equally. */
    places: Array<{ band: 1 | 2 | 3; fromPlace: number; toPlace: number; shareBps: number; amountRawEach: string | null }>;
  };
  standings: {
    /** Weekly score = this week's trophy change from resolved rated raids. */
    basis: 'projection_resolved_raids';
    eligibleCount: number;
    /** The band-1 places, best first. */
    leaders: Array<{
      place: number; baseId: string; name: string | null; weeklyScore: number;
      trophies: number; tier: League; amountRaw: string | null; you: boolean;
    }>;
    you: {
      baseId: string; place: number | null; weeklyScore: number; ratedAttacks: number;
      trophies: number; tier: League; amountRaw: string | null; reason: LeagueSeasonYouReason;
    } | null;
  };
}

/** The wallet IS the identity (GDD §4.9); balances live in the ledger, not here. */
export interface Player {
  /** base58 wallet pubkey — primary identity. */
  wallet: string;
  name: string;
  keepLevel: number;
  trophies: number;
  league: League;
  /** Builders owned, 1–6 (owner 2026-08-11). */
  builders: number;
  /** Land expansions purchased, 0–2 (GDD §4.6). */
  expansions: number;
  valleyId: string;
  /** Plot coordinates on the world map (server-assigned, GDD §3.4). */
  plotX: number;
  plotY: number;
  createdAtMs: number;
}

// ---------------------------------------------------------------------------
// Raids & replays (ARCHITECTURE §5–§6)
// ---------------------------------------------------------------------------

/** One troop drop. tMs = milliseconds since deploy phase start. */
export const DeployOrderSchema = z.object({
  troop: z.enum(TROOP_TYPES),
  tx: z.number().int(),
  ty: z.number().int(),
  tMs: z.number().int().nonnegative(),
});

export type DeployOrder = z.infer<typeof DeployOrderSchema>;

/** Frozen defender base at raid start — what the deterministic sim consumes. */
/** Capped, resolved gear buckets frozen into a raid. Field names intentionally
 * match the catalog modifier vocabulary; every value is integer basis points. */
export interface HeroCombatModifiers {
  hero_hp_bps: number;
  hero_damage_bps: number;
  ability_damage_bps: number;
  cooldown_reduction_bps: number;
  move_speed_bps: number;
  incoming_damage_reduction_bps: number;
  first_hit_reduction_bps: number;
  wall_damage_bps: number;
  allied_troop_hp_bps: number;
  allied_troop_damage_bps: number;
}

/** Immutable raid-facing projection of one equipped loadout. Omitted when gear
 * combat was disabled or the loadout was empty, preserving legacy replay bytes. */
export interface HeroCombatLoadout {
  catalogRevision: number;
  version: number;
  hash: string;
  modifiers: HeroCombatModifiers;
}

/** Raid-building geometry is frozen independently of the simulator protocol.
 * Missing means the archived v1 layout so old snapshot JSON remains exact. */
export type BuildingGeometryVersion = 1 | 2;

/** SIM15/v2 opens the realm and claim; SIM17/v3 requires an empty 2×2 square.
 * Missing is the archived contract, never inferred from the current simulator. */
export type BattlefieldVersion = 1 | 2 | 3;

/** Plot coordinates are frozen separately from building footprint dimensions.
 * Missing is the historical [0,30) frame; v2 grows around the same centre. */
export type PlotGeometryVersion = 1 | 2;

export interface BaseSnapshot {
  /** Explicit only for geometry-v2 candidate snapshots. Missing and 1 preserve
   * every historical/current 2x2 KEEP replay. */
  geometryVersion?: BuildingGeometryVersion;
  battlefieldVersion?: BattlefieldVersion;
  plotVersion?: PlotGeometryVersion;
  /** V2 deployment-only footprints for placed rows omitted from combat (e.g.
   * spent traps and construction). They never become targets or affect damage. */
  deploymentBlockers?: Array<{ tx: number; ty: number; fw: number; fh: number }>;
  keepLevel: number;
  buildings: Building[];
  /** Defender shards above vault cap at snapshot time — the raidable surplus (GDD §3.3). */
  surplusShards: number;
  /** Defender's actual claim bounds in tile coords (owner 2026-07-20 big-base
   * expansion). Legacy battlefields exclude its strict interior; version 2
   * permits every unoccupied tile; version 3 requires an empty square. Optional: the sim defaults to a fresh 14-claim
   * centered in the plot when absent (keeps historical replays byte-identical). */
  claimMin?: number;
  claimMax?: number;
  /** Defender's uncleared obstacles frozen at raid creation — DECOR ONLY: the
   * sim ignores them entirely (they never block deploys, pathing or targeting).
   * Shipped so the attack field renders like the defender's actual base (owner
   * 2026-08-15/M23). Omitted when empty so legacy replay bytes are unchanged. */
  obstacles?: Array<{ spriteKey: string; tx: number; ty: number }>;
  /** Recruited defenders frozen at raid creation. Omitted when empty so legacy
   * replay bytes remain unchanged. Guard coordinates are altar-relative tiles. */
  defenderHeroes?: Array<{
    hero: 'vex' | 'theodor';
    level: number;
    guardTx: number;
    guardTy: number;
    loadout?: HeroCombatLoadout;
  }>;
}

export interface RaidResult {
  /** ★ at 50% destruction, ★★ Keep destroyed, ★★★ 100% (GDD §3.3). */
  stars: 0 | 1 | 2 | 3;
  /** 0–100 total destruction. */
  destructionPct: number;
  keepDestroyed: boolean;
  lootShards: number;
  attackerTrophyDelta: number;
  defenderTrophyDelta: number;
}

export interface Raid {
  id: string;
  attackerWallet: string;
  defenderWallet: string;
  /** mulberry32 seed; server-chosen, makes the sim fully deterministic. */
  seed: number;
  snapshot: BaseSnapshot;
  orders: DeployOrder[];
  result?: RaidResult;
  createdAtMs: number;
}

/** Raid command/clock wire contract. V1 is retained for already-created rows;
 * only an explicitly requested, server-enabled creation may select V2. */
export type RaidProtocolVersion = 1 | 2;
export type LiveRaidClockRate = 1 | 2;

export interface LiveRaidClock<TTimestamp = string> {
  protocolVersion: RaidProtocolVersion;
  revision: number;
  rate: LiveRaidClockRate;
  anchorWallAt: TTimestamp | null;
  anchorSimMs: number;
  serverNow: TTimestamp;
  simNowMs: number;
  battleEndsAt: TTimestamp | null;
  durationMs: number;
}

/** A replay is just (snapshot, orders, seed) — the client re-simulates bit-identically (GDD §3.8). */
export interface ReplayBundle {
  snapshot: BaseSnapshot;
  orders: DeployOrder[];
  seed: number;
}

// ---------------------------------------------------------------------------
// Global chat (owner 2026-08-13 — public profile only, never wallet/base IDs)
// ---------------------------------------------------------------------------

export interface ChatAuthor {
  name: string;
  avatarUrl: string | null;
  seekerVerified: boolean;
}

export interface ChatMessage {
  /** PostgreSQL bigint serialized losslessly as a decimal string. */
  id: string;
  clientMessageId: string;
  text: string;
  createdAt: string;
  author: ChatAuthor;
  /** Viewer-relative permission; identity keys never cross the API boundary. */
  canBlock: boolean;
  /** UTF-16 offsets into normalized text; recipient identities stay server-side. */
  mentions?: Array<{ start: number; end: number }>;
  /** True only for a mentioned viewer other than the message author. */
  mentioned?: boolean;
}

export type ChatEvent =
  | { id: string; type: 'message'; createdAt: string; messageId: string; message: ChatMessage }
  | { id: string; type: 'redaction'; createdAt: string; messageId: string };

export type ChatSendBlockedReason = 'USERNAME_REQUIRED' | 'DEED_REQUIRED' | 'MUTED' | 'DISABLED';

/** A personal block never discloses either participant's wallet identity. */
export interface ChatBlock {
  /** Opaque database row identity, serialized losslessly as decimal text. */
  id: string;
  createdAt: string;
  author: ChatAuthor;
}

// ---------------------------------------------------------------------------
// Ledger (ARCHITECTURE §5 — append-only double-entry)
// ---------------------------------------------------------------------------

// Aligned with apps/api db enum `account_kind` (the generated migration is the source of truth).
export type LedgerAccountKind =
  | 'player_keep'
  | 'player_sol_credit'
  | 'emission_pool'
  | 'burn'
  | 'league_pool'
  | 'league_entitlement_escrow'
  | 'treasury'
  | 'quest_bucket'
  | 'sol_treasury'
  | 'withdrawal_escrow'
  | 'onchain_outflow';
