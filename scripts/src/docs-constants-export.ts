/**
 * Docs number registry: landing/docs-constants.json (M47 §6).
 *
 *   pnpm --filter @shardkeep/scripts run docs:constants            # regenerate
 *   pnpm --filter @shardkeep/scripts run docs:constants -- --check # exit 1 on drift
 *   tsx src/docs-constants-export.ts --content-root <dir> --out <file>   # previews
 *
 * WHY this exists. Every game number lives only in packages/shared/src/constants.ts
 * (hard rule), but the player docs are Markdown written by people, and the 2026-09
 * audit found hand-copied numbers already wrong (training times 10x too slow). So
 * the docs never type a live number: they write `{{n:<token>}}` and the docs engine
 * (landing/build-docs.mjs) substitutes the display string recorded here. The landing
 * build has no TypeScript toolchain, so this generator — which does — evaluates the
 * constants (and the shared helpers the game itself uses: fmtDur, getMiningQuota,
 * speedupCostKeep, vaultProtectionBps …) and writes plain strings. A drift test
 * (scripts/src/landing-docs.test.ts) regenerates the file and requires byte equality,
 * so a balance change can never leave the published docs quoting the old number.
 *
 * The file holds only what the docs USE (every token found in landing/docs-content)
 * plus the nine `pkw-table` datasets, so an unrelated constants change does not
 * churn it; a docs page that adds a token regenerates it once.
 *
 * Token grammar:
 *   token   = [format "."] path
 *   format  = pct | spct | sol | dur | x | min | hours | days   (see FORMATS)
 *   path    = "derived." name                  (DERIVED below: named, documented formulas)
 *           | EXPORT ("." segment)*            (an exported constant of constants.ts)
 *   segment = key | array index | "@" id       (@id: the array element whose id/stat/key/
 *                                               type/name field equals id)
 *
 * Upcoming-update numbers (M47 §1). A path inside the onchain-gameplay catalogue
 * (PHASE_E_* / GEMS* / FORGE_INGOT / the five new building types / the Forge Ingot
 * item) resolves ONLY if it is on LOCKED_UPCOMING, which restates the owner's LOCKED
 * list fact by fact. Everything else there is PROPOSED tuning and must be described
 * in words; asking for it fails the generator (and so the docs build) loudly.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import * as SHARED from '@shardkeep/shared';
import {
  BASE_OWNERSHIP, BUFFS, BUILD_COSTS, BUILD_COUNT_CAP_BY_KEEP, CAMPAIGN, CAPS, CHAT, DAILY_CACHE, DEFENSES,
  DEFENSE_LEVELING, ECONOMY, ELITE_TROOP_UNLOCKS, FANTASY_WORLD, FORGE, FORGE_INGOT, GEAR_ITEMS, GEMS, HEROES,
  HERO_LEVELING, ITEMS, KEEP_BATTERIES, LEGACY_ITEMS, LEVEL_STEP_BUILDING, LOOT, MARKETPLACE, MATERIAL_ITEMS,
  MINING, PHASE_E_BUILDINGS, PHASE_E_POLICY, PLAYTEST_COMPETITIONS, PROFILE_AVATAR, PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL,
  QUESTS, RALLY, REFERRALS, SHIELD, STRUCTURES, TESTER_PROGRAM, TROOPS, TROOP_TYPES, TROPHIES, UNLOCK_ITEMS,
  UPGRADE_COSTS, UPGRADE_TIMES_SEC, fmtDur, getMiningQuota, isTrainableTroop, lootableShareBps, speedupCostKeep,
  vaultProtectionBps,
} from '@shardkeep/shared';
import { fantasyTiles } from '@shardkeep/shared/fantasyWorld';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const DOCS_CONSTANTS_FILE = path.join(REPO_ROOT, 'landing/docs-constants.json');
export const DOCS_CONTENT_DIR = path.join(REPO_ROOT, 'landing/docs-content');
const CONSTANTS_SOURCE = path.join(REPO_ROOT, 'packages/shared/src/constants.ts');
export const DOCS_CONSTANTS_SCHEMA = 'pkw-docs-constants/1';

class DocsConstantsError extends Error {}
function fail(message: string): never {
  throw new DocsConstantsError(`docs constants: ${message}`);
}

// ---------------------------------------------------------------------------
// Number formatting (one deterministic style for every docs number)
// ---------------------------------------------------------------------------

const nf = new Map<number, Intl.NumberFormat>();
/** en-US grouping ("10,000"), at most `digits` decimals, trailing zeros trimmed. */
export function fmtNumber(value: number, digits = 3): string {
  if (!Number.isFinite(value)) fail(`cannot format ${value}`);
  let format = nf.get(digits);
  if (!format) {
    format = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, useGrouping: true });
    nf.set(digits, format);
  }
  const text = format.format(value);
  return text === '-0' ? '0' : text.replace(/^-/, '−');
}

const num = (token: string, value: unknown): number => {
  if (typeof value !== 'number') fail(`${token}: a format needs a number, found ${JSON.stringify(value)}`);
  return value;
};

/** Display formats. Each states the unit conversion so a reader of a page source
 *  knows what `{{n:pct.X}}` prints without opening this file. */
export const FORMATS = Object.freeze({
  /** basis points → percent number: 2_500 → "25" (the page writes the % sign). */
  pct: (token: string, v: unknown) => fmtNumber(num(token, v) / 100, 2),
  /** basis points → signed percent: 600 → "+6", −500 → "−5". */
  spct: (token: string, v: unknown) => {
    const n = num(token, v) / 100;
    return n > 0 ? `+${fmtNumber(n, 2)}` : fmtNumber(n, 2);
  },
  /** lamports → SOL: 50_000_000 → "0.05". */
  sol: (token: string, v: unknown) => fmtNumber(num(token, v) / 1_000_000_000, 9),
  /** seconds → the game's own duration label (shared fmtDur, D-070): 86_400 → "1d". */
  dur: (token: string, v: unknown) => fmtDur(num(token, v)),
  /** basis points → multiplier: 13_600 → "1.36" (the page writes the × sign). */
  x: (token: string, v: unknown) => fmtNumber(num(token, v) / 10_000, 3),
  /** seconds → minutes / hours / days as a plain number. */
  min: (token: string, v: unknown) => fmtNumber(num(token, v) / 60, 2),
  hours: (token: string, v: unknown) => fmtNumber(num(token, v) / 3_600, 2),
  days: (token: string, v: unknown) => fmtNumber(num(token, v) / 86_400, 2),
} satisfies Record<string, (token: string, value: unknown) => string>);
type FormatName = keyof typeof FORMATS;
const isFormat = (name: string): name is FormatName => Object.prototype.hasOwnProperty.call(FORMATS, name);

// ---------------------------------------------------------------------------
// Upcoming-update gate (M47 §1 LOCKED list)
// ---------------------------------------------------------------------------

const NEW_BUILDING_TYPES: readonly string[] = PHASE_E_BUILDINGS.types;
/** Per-building tables whose rows for the five new building types are PROPOSED. */
const BUILDING_TABLE_ROOTS = new Set(['STRUCTURES', 'BUILD_COSTS', 'UPGRADE_COSTS', 'UPGRADE_TIMES_SEC', 'BUILD_COUNT_CAP_BY_KEEP']);

/** True for any constant that describes the upcoming onchain-gameplay update
 *  (not live yet), whether LOCKED or PROPOSED. */
export function isUpcomingPath(pathText: string): boolean {
  const [root = '', second = ''] = pathText.split('.');
  if (/^(?:PHASE_E_|GEMS)/.test(root)) return true;
  if (root === 'FORGE_INGOT' || root === 'KEEP_MINING_FLOOR' || root === 'MATERIAL_ITEMS') return true;
  if (BUILDING_TABLE_ROOTS.has(root) && NEW_BUILDING_TYPES.includes(second)) return true;
  if (root === 'ITEMS' && Object.prototype.hasOwnProperty.call(MATERIAL_ITEMS, second)) return true;
  return false;
}

/** The owner's LOCKED list (M47 §1), one entry per publishable constant, each
 *  with the fact it states. Nothing else from the upcoming catalogue may render. */
export const LOCKED_UPCOMING: Readonly<Record<string, string>> = Object.freeze({
  'GEMS.gemsPerKeep': 'KEEP→Gems 1:1',
  'GEMS.shardsPerGem': 'Gems→SHARDS 1:1',
  'PHASE_E_POLICY.currencies.gems.gemsPerKeep': 'KEEP→Gems 1:1',
  'PHASE_E_POLICY.currencies.gems.shardsPerGem': 'Gems→SHARDS 1:1',
  'PHASE_E_POLICY.forge.shardsPerIngot': '10,000 SHARDS per Forge Ingot',
  'FORGE_INGOT.shardsPerIngot': '10,000 SHARDS per Forge Ingot',
  'PHASE_E_POLICY.mining.grossDailyCeilingKeep': 'up to 98,000 KEEP/day gross mining ceiling ("up to")',
  'PHASE_E_POLICY.mining.freePoolBps': '5% pool without a Land Deed',
  'PHASE_E_POLICY.mining.deedPoolBps': '95% pool with a Land Deed',
  'PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay': '2 units/day per free wallet',
  'PHASE_E_POLICY.mining.scoreGraceSec': 'score held 48 h',
  'PHASE_E_POLICY.mining.seekerBonusBps': 'weight +10% Seeker',
  'PHASE_E_POLICY.mining.genesisBaseBonusBps': 'weight +20% Genesis',
  'PHASE_E_POLICY.bases.activePerWalletMax': 'up to 5 active bases',
  'PHASE_E_POLICY.bases.freePerWalletMax': '2 free bases',
  'PHASE_E_POLICY.bases.replacementFeeLamports': '0.1 SOL roster replacement',
  'PHASE_E_POLICY.bases.secondFreeBaseCostShards': 'second free base 100,000 SHARDS',
  'PHASE_E_POLICY.taxes.resources.playerBps': 'tax 80/20 on new resources',
  'PHASE_E_POLICY.taxes.resources.islandPoolBps': 'tax 80/20 on new resources',
  'PHASE_E_POLICY.taxes.resources.devBps': '0% to the team',
  'PHASE_E_POLICY.taxes.minedKeep.playerBps': 'tax 80/10/10 on newly mined KEEP',
  'PHASE_E_POLICY.taxes.minedKeep.islandPoolBps': 'tax 80/10/10 on newly mined KEEP',
  'PHASE_E_POLICY.taxes.minedKeep.recycleBps': 'tax 80/10/10 on newly mined KEEP',
  'PHASE_E_POLICY.taxes.minedKeep.devBps': '0% to the team',
  'PHASE_E_POLICY.taxes.keepMarket.sellerBps': 'KEEP market 90% seller',
  'PHASE_E_POLICY.taxes.keepMarket.burnBps': 'KEEP market 10% burned',
  'PHASE_E_POLICY.seekerIsland.totalSpots': 'Seeker Island 100 spots',
  'PHASE_E_POLICY.seekerIsland.kingSpots': '20 King spots',
  'PHASE_E_POLICY.seekerIsland.regularSpots': '80 regular spots',
  // Not an economic number: the eight realms are a live fact; the island rule
  // "1-4 realms per regular spot" is stated against them.
  'PHASE_E_POLICY.seekerIsland.realmCount': 'eight realms (live world fact)',
  'PHASE_E_POLICY.seekerIsland.regularRealmCountMin': '1–4 realms per regular spot',
  'PHASE_E_POLICY.seekerIsland.regularRealmCountMax': '1–4 realms per regular spot',
  'PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax': '10 permits/day per spot',
  'PHASE_E_POLICY.seekerIsland.operatingTermSec': '7-day terms',
  'PHASE_E_POLICY.seekerIsland.overlappingAuctionSec': '24 h overlapping auction',
  'PHASE_E_POLICY.seekerIsland.permitDurationSec': 'realm permit for 7 days',
  'PHASE_E_POLICY.seekerIsland.permitPriceLamports': 'realm permit 0.01 SOL',
  'PHASE_E_POLICY.craft.applicationFeeLamports': 'vehicle craft fee 0.05 SOL',
  'PHASE_E_POLICY.claims.applicationFeeLamports': 'no claim fee',
  'PHASE_E_BUILDINGS.visualTiers': 'new buildings: 4 visual tiers',
  // One Harvester variant per realm (the delivered art); a count of realms, not tuning.
  'PHASE_E_BUILDINGS.harvesterRealmVariants': 'one Realm Harvester variant per realm',
  'FORGE_INGOT.rawStockTheftDivisor': '1% of raw resources lost when a raid destroys the Keep',
  ...Object.fromEntries(NEW_BUILDING_TYPES.flatMap((type) => [
    [`STRUCTURES.${type}.maxLevel`, 'new buildings: 20 levels'],
    [`STRUCTURES.${type}.footprint.0`, 'new buildings: 2×2'],
    [`STRUCTURES.${type}.footprint.1`, 'new buildings: 2×2'],
  ])),
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const SELECTOR_FIELDS = ['id', 'stat', 'key', 'type', 'name', 'slug'] as const;
const EXPORTS = SHARED as unknown as Record<string, unknown>;
const CONSTANT_EXPORTS: ReadonlySet<string> = new Set(
  [...readFileSync(CONSTANTS_SOURCE, 'utf8').matchAll(/^export const ([A-Z][A-Z0-9_]*)\b/gm)].map((m) => m[1]!),
);

/** Resolve `ROOT.seg.seg` against the exports of constants.ts (never other modules:
 *  the constants file is the one authority for game numbers). */
export function resolvePath(pathText: string): unknown {
  const segments = pathText.split('.');
  const root = segments.shift()!;
  if (!CONSTANT_EXPORTS.has(root)) fail(`${pathText}: "${root}" is not an exported constant of packages/shared/src/constants.ts`);
  let current: unknown = EXPORTS[root];
  let walked = root;
  for (const segment of segments) {
    if (segment === '') fail(`${pathText}: empty path segment`);
    if (segment.startsWith('@')) {
      if (!Array.isArray(current)) fail(`${pathText}: "${segment}" selects from an array, but ${walked} is not one`);
      const id = segment.slice(1);
      const matches = current.filter((item) => item && typeof item === 'object'
        && SELECTOR_FIELDS.some((field) => (item as Record<string, unknown>)[field] === id));
      if (matches.length !== 1) fail(`${pathText}: ${walked} has ${matches.length} elements matching ${segment}`);
      current = matches[0];
    } else {
      if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
        fail(`${pathText}: ${walked} has no "${segment}"`);
      }
      current = (current as Record<string, unknown>)[segment];
    }
    walked = `${walked}.${segment}`;
  }
  return current;
}

/** The selector-free spelling of a path (array elements by index) — what the
 *  LOCKED list is keyed on, so `@id` cannot sidestep it. */
function canonicalPath(pathText: string): string {
  return pathText.split('.').map((segment) => (segment.startsWith('@') ? '@' : segment)).join('.');
}

// ---------------------------------------------------------------------------
// Derived values: named formulas over the constants, pre-formatted.
// ---------------------------------------------------------------------------

interface Derived {
  /** The formula in words, recorded in the JSON next to the value. */
  formula: string;
  value: () => string;
  /** Set when the value comes from the upcoming catalogue: the LOCKED fact. */
  locked?: string;
}

/** The constant lamport step of a per-level SOL price table (fails if it is not constant). */
const lamportsStep = (table: Readonly<Record<number, number>>): number => {
  const levels = Object.keys(table).map(Number).sort((a, b) => a - b);
  const steps = levels.slice(1).map((level, index) => table[level]! - table[levels[index]!]!);
  if (steps.length === 0 || steps.some((step) => step !== steps[0])) fail('derived: SOL upgrade table is not a constant step');
  return steps[0]!;
};
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const pctOf = (mult: number): string => fmtNumber(Math.round((mult - 1) * 10_000) / 100, 2);
const forgeCap = FORGE.contributionCapByLevel[1]!;
const FORGE_BUSY_DAY_TOTAL = 1_000_000; // illustrative busy-day total for the worked example
const forgePayout = (contribution: number, total: number): number =>
  Math.floor((FORGE.dailyEmissionKeep * Math.min(contribution, Math.floor((total * FORGE.maxDailyShareBps) / 10_000)))
    / Math.max(total, FORGE.softCapShards));

export const DERIVED: Readonly<Record<string, Derived>> = Object.freeze({
  armyMaxPoints: { formula: 'Army Camp cap at Keep 20 × a level-20 camp\'s capacity', value: () => fmtNumber(BUILD_COUNT_CAP_BY_KEEP.camp!.at(-1)! * STRUCTURES.camp.capacityPts.at(-1)!) },
  avatarMaxMiB: { formula: 'PROFILE_AVATAR.maxUploadBytes in MiB', value: () => fmtNumber(PROFILE_AVATAR.maxUploadBytes / 1_048_576, 1) },
  buildingL20Mult: { formula: 'product of LEVEL_STEP_BUILDING (L1→L20), rounded', value: () => fmtNumber(Math.round(LEVEL_STEP_BUILDING.reduce<number>((p, s) => p * s, 1))) },
  campaignActs: { formula: 'CAMPAIGN.totalStages ÷ stagesPerAct', value: () => fmtNumber(CAMPAIGN.totalStages / CAMPAIGN.stagesPerAct) },
  campaignTotalShards: { formula: 'Σ over the 100 authored stages of firstThreeStarShardsByKeep[stage Keep band]', value: () => fmtNumber(sum(CAMPAIGN.encounters.map((stage) => CAMPAIGN.firstThreeStarShardsByKeep[stage.keepLevel - 1] ?? 0))) },
  chatCooldownSec: { formula: 'CHAT.sendCooldownMs in seconds', value: () => fmtNumber(CHAT.sendCooldownMs / 1_000) },
  consumableItemCount: { formula: 'consumables in LEGACY_ITEMS', value: () => fmtNumber(Object.values(LEGACY_ITEMS).filter((item) => item.kind === 'consumable').length) },
  dailyCacheFirstWeekMax: { formula: 'DAILY_CACHE.firstWeekStepShards × consistencyStreakDays', value: () => fmtNumber(DAILY_CACHE.firstWeekStepShards * DAILY_CACHE.consistencyStreakDays) },
  dailyQuestCount: { formula: 'QUESTS.dailyTemplates.length', value: () => fmtNumber(QUESTS.dailyTemplates.length) },
  forgeExampleQuiet: { formula: 'floor(dailyEmissionKeep × L1 cap ÷ softCapShards): a full L1 cap on a day below the soft cap', value: () => fmtNumber(forgePayout(forgeCap, FORGE.softCapShards)) },
  forgeExampleBusyTotal: { formula: 'illustrative busy-day total (1,000,000 SHARDS)', value: () => fmtNumber(FORGE_BUSY_DAY_TOTAL) },
  forgeExampleBusy: { formula: 'floor(dailyEmissionKeep × L1 cap ÷ busy-day total)', value: () => fmtNumber(forgePayout(forgeCap, FORGE_BUSY_DAY_TOTAL)) },
  forgeMaxRate: { formula: 'dailyEmissionKeep ÷ softCapShards (KEEP per SHARD at or below the soft cap)', value: () => fmtNumber(FORGE.dailyEmissionKeep / FORGE.softCapShards, 2) },
  forgeSolStep: { formula: 'constant SOL step between Gold Forge upgrade levels', value: () => fmtNumber(lamportsStep(FORGE.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL) / 1e9, 9) },
  gearItemCount: { formula: 'GEAR_ITEMS count', value: () => fmtNumber(Object.keys(GEAR_ITEMS).length) },
  heroVexRecoveryL1Min: { formula: 'HEROES.vex.regenMinAt(1)', value: () => fmtNumber(HEROES.vex.regenMinAt(1)) },
  heroVexRecoveryPerLevelMin: { formula: 'HEROES.vex.regenMinAt(2) − regenMinAt(1)', value: () => fmtNumber(HEROES.vex.regenMinAt(2) - HEROES.vex.regenMinAt(1)) },
  heroTheodorRecoveryL1Min: { formula: 'HEROES.theodor.regenMinAt(1)', value: () => fmtNumber(HEROES.theodor.regenMinAt(1)) },
  heroTheodorRecoveryPerLevelMin: { formula: 'HEROES.theodor.regenMinAt(2) − regenMinAt(1)', value: () => fmtNumber(HEROES.theodor.regenMinAt(2) - HEROES.theodor.regenMinAt(1)) },
  keepLadderFactor: {
    formula: 'UPGRADE_TIMES_SEC.keep ÷ UPGRADE_TIMES_SEC.mine (constant ratio)',
    value: () => {
      const ratios = UPGRADE_TIMES_SEC.keep.map((sec, index) => sec / UPGRADE_TIMES_SEC.mine[index]!);
      if (ratios.some((ratio) => Math.abs(ratio - ratios[0]!) > 1e-9)) fail('derived.keepLadderFactor: Keep ladder is not a constant multiple of the building ladder');
      return fmtNumber(ratios[0]!, 2);
    },
  },
  keepLadderTotalHours: { formula: 'Σ UPGRADE_TIMES_SEC.keep in hours', value: () => fmtNumber(sum(UPGRADE_TIMES_SEC.keep) / 3_600, 1) },
  landReservationMin: { formula: 'BASE_OWNERSHIP.reservationTtlMs in minutes', value: () => fmtNumber(BASE_OWNERSHIP.reservationTtlMs / 60_000) },
  landSplitLiquiditySol: { formula: 'ECONOMY.entryFeeSol × solSplitBps.liquidity', value: () => fmtNumber((ECONOMY.entryFeeSol * ECONOMY.solSplitBps.liquidity) / 10_000, 9) },
  landSplitDevSol: { formula: 'ECONOMY.entryFeeSol × solSplitBps.dev', value: () => fmtNumber((ECONOMY.entryFeeSol * ECONOMY.solSplitBps.dev) / 10_000, 9) },
  landSplitOpsSol: { formula: 'ECONOMY.entryFeeSol × solSplitBps.ops', value: () => fmtNumber((ECONOMY.entryFeeSol * ECONOMY.solSplitBps.ops) / 10_000, 9) },
  liveItemCount: { formula: 'ITEMS minus the not-yet-enabled MATERIAL_ITEMS', value: () => fmtNumber(Object.keys(ITEMS).length - Object.keys(MATERIAL_ITEMS).length) },
  marketSellerPct: { formula: '100 − MARKETPLACE.feeBps as percent', value: () => fmtNumber(100 - MARKETPLACE.feeBps / 100, 2) },
  maxClaimTiles: { formula: 'CAPS.claimTilesByExpansion (last)', value: () => fmtNumber(CAPS.claimTilesByExpansion.at(-1)!) },
  originalClaimMaxTiles: { formula: 'CAPS.claimTilesByExpansion after the original six expansions', value: () => fmtNumber(CAPS.claimTilesByExpansion[6]!) },
  // The locked mining pool maxima (M47 §1): each is the gross daily ceiling times a
  // locked split, so the docs can say "at most" without a second copy of a number.
  miningFreePoolMaxKeep: { formula: 'grossDailyCeilingKeep × freePoolBps ÷ 10,000 (the most the pool without a Land Deed can share in a day)', value: () => fmtNumber((PHASE_E_POLICY.mining.grossDailyCeilingKeep * PHASE_E_POLICY.mining.freePoolBps) / 10_000), locked: 'up to 98,000 KEEP/day gross × 5% pool without a Land Deed' },
  miningDeedPoolMaxKeep: { formula: 'grossDailyCeilingKeep × deedPoolBps ÷ 10,000 (the most the Land Deed pool can share in a day)', value: () => fmtNumber((PHASE_E_POLICY.mining.grossDailyCeilingKeep * PHASE_E_POLICY.mining.deedPoolBps) / 10_000), locked: 'up to 98,000 KEEP/day gross × 95% pool with a Land Deed' },
  minedKeepPlayerMaxKeep: { formula: 'grossDailyCeilingKeep × minedKeep.playerBps ÷ 10,000 (players\' part of a fully allocated day)', value: () => fmtNumber((PHASE_E_POLICY.mining.grossDailyCeilingKeep * PHASE_E_POLICY.taxes.minedKeep.playerBps) / 10_000), locked: 'the 98,000 ceiling is gross; at full allocation 80% to players' },
  minedKeepIslandMaxKeep: { formula: 'grossDailyCeilingKeep × minedKeep.islandPoolBps ÷ 10,000 (the island pool\'s part of a fully allocated day)', value: () => fmtNumber((PHASE_E_POLICY.mining.grossDailyCeilingKeep * PHASE_E_POLICY.taxes.minedKeep.islandPoolBps) / 10_000), locked: 'the 98,000 ceiling is gross; at full allocation 10% to the island pool' },
  minedKeepRecycleMaxKeep: { formula: 'grossDailyCeilingKeep × minedKeep.recycleBps ÷ 10,000 (returned to future mining on a fully allocated day)', value: () => fmtNumber((PHASE_E_POLICY.mining.grossDailyCeilingKeep * PHASE_E_POLICY.taxes.minedKeep.recycleBps) / 10_000), locked: 'the 98,000 ceiling is gross; at full allocation 10% back to future mining' },
  freeWalletDailyIngotShards: { formula: 'freeCapacityUnitsPerWalletDay × forge.shardsPerIngot (SHARDS behind a free wallet\'s full daily capacity)', value: () => fmtNumber(PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay * PHASE_E_POLICY.forge.shardsPerIngot), locked: '2 units/day per free wallet × 10,000 SHARDS per Forge Ingot' },
  miningCeilingPerDay: { formula: 'getMiningQuota(Keep 20, max Mines all level 20, 7-day streak)', value: () => fmtNumber(getMiningQuota(20, Array.from({ length: MINING.MAX_MINES_BY_KEEP.at(-1)! }, () => 20), MINING.CONSISTENCY_STREAK_DAYS)) },
  miningExampleL5L3: { formula: 'getMiningQuota(Keep 3, one level-5 Mine, no streak)', value: () => fmtNumber(getMiningQuota(3, [5], 0)) },
  miningExampleTwoMines: { formula: 'getMiningQuota(Keep 1, two level-1 Mines, no streak)', value: () => fmtNumber(getMiningQuota(1, [1, 1], 0)) },
  miningStreakMult: { formula: 'MINING.CONSISTENCY_BPS as a multiplier', value: () => fmtNumber(MINING.CONSISTENCY_BPS / MINING.BPS_ONE, 3) },
  playtestCompetitionTotalUsd: { formula: 'Σ PLAYTEST_COMPETITIONS.prizes amountUsd', value: () => fmtNumber(sum(PLAYTEST_COMPETITIONS.prizes.map((prize) => prize.amountUsd))) },
  playtestCompetitionGameplayUsd: { formula: 'Σ prizes that are not the video award (gameplay + reports)', value: () => fmtNumber(sum(PLAYTEST_COMPETITIONS.prizes.filter((prize) => prize.category !== 'video').map((prize) => prize.amountUsd))) },
  powderchargePct: { formula: '(BUFFS.powdercharge.wallDamageMult − 1) as percent', value: () => pctOf(BUFFS.powdercharge.wallDamageMult) },
  swiftbootsPct: { formula: '(BUFFS.swiftboots.troopSpeedMult − 1) as percent', value: () => pctOf(BUFFS.swiftboots.troopSpeedMult) },
  warhornPct: { formula: '(BUFFS.warhorn.troopDamageMult − 1) as percent', value: () => pctOf(BUFFS.warhorn.troopDamageMult) },
  pvpAnteStep: {
    formula: 'PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL per Keep level (linear)',
    value: () => {
      const step = PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL[0]!;
      if (PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL.some((cost, index) => cost !== step * (index + 1))) fail('derived.pvpAnteStep: the ante is no longer step × Keep level');
      return fmtNumber(step);
    },
  },
  rallyBonusPct: { formula: '(RALLY.speedAndDamageMult − 1) as percent', value: () => pctOf(RALLY.speedAndDamageMult) },
  rawStockTheftPct: { formula: '100 ÷ FORGE_INGOT.rawStockTheftDivisor', value: () => fmtNumber(100 / FORGE_INGOT.rawStockTheftDivisor, 2), locked: '1% of raw resources lost when a raid destroys the Keep' },
  referralBonusPct: { formula: 'REFERRALS.miningBonusBpsPerReferral as percent', value: () => fmtNumber(REFERRALS.miningBonusBpsPerReferral / 100, 2) },
  referralBonusThreePct: { formula: '3 × REFERRALS.miningBonusBpsPerReferral as percent', value: () => fmtNumber((3 * REFERRALS.miningBonusBpsPerReferral) / 100, 2) },
  sheetStatPct: { formula: '(DEFENSE_LEVELING.statMultPerLevel − 1) as percent', value: () => pctOf(DEFENSE_LEVELING.statMultPerLevel) },
  shieldExtendMaxRemainingDur: { formula: 'fmtDur(SHIELD.extendPurchaseMaxRemainingHours)', value: () => fmtDur(SHIELD.extendPurchaseMaxRemainingHours * 3_600) },
  shieldOnLossDur: { formula: 'fmtDur(SHIELD.hoursOnLoss)', value: () => fmtDur(SHIELD.hoursOnLoss * 3_600) },
  solanaTiles: { formula: 'FANTASY_WORLD.genesisTiles + seekerTiles', value: () => fmtNumber(FANTASY_WORLD.genesisTiles + FANTASY_WORLD.seekerTiles) },
  speedup1hKeep: { formula: 'speedupCostKeep(1 h)', value: () => fmtNumber(speedupCostKeep(3_600)) },
  speedup24hKeep: { formula: 'speedupCostKeep(24 h)', value: () => fmtNumber(speedupCostKeep(86_400)) },
  testerSweepMin: { formula: 'TESTER_PROGRAM.sweepEveryMs in minutes', value: () => fmtNumber(TESTER_PROGRAM.sweepEveryMs / 60_000) },
  trainableTroopCount: { formula: 'TROOP_TYPES that isTrainableTroop', value: () => fmtNumber(TROOP_TYPES.filter(isTrainableTroop).length) },
  trapCapKeepLevel: { formula: 'first Keep level at which CAPS.trapsByKeepLevel reaches its maximum', value: () => fmtNumber((CAPS.trapsByKeepLevel as readonly number[]).indexOf(Math.max(...CAPS.trapsByKeepLevel)) + 1) },
  unlockItemCount: { formula: 'UNLOCK_ITEMS count', value: () => fmtNumber(Object.keys(UNLOCK_ITEMS).length) },
  upgradeLadderTotalHours: { formula: 'Σ UPGRADE_TIMES_SEC.mine in hours', value: () => fmtNumber(sum(UPGRADE_TIMES_SEC.mine) / 3_600, 1) },
  vaultL1Shielded: { formula: 'vaultProtectionBps(1) as percentage points', value: () => fmtNumber(vaultProtectionBps(1) / 100, 2) },
  vaultL1Lootable: { formula: 'lootableShareBps(1) as percent', value: () => fmtNumber(lootableShareBps(1) / 100, 2) },
  vaultL10Shielded: { formula: 'vaultProtectionBps(10) as percentage points', value: () => fmtNumber(vaultProtectionBps(10) / 100, 2) },
  vaultL10Lootable: { formula: 'lootableShareBps(10) as percent', value: () => fmtNumber(lootableShareBps(10) / 100, 2) },
  vaultL20Lootable: { formula: 'lootableShareBps(20) as percent', value: () => fmtNumber(lootableShareBps(20) / 100, 2) },
  weeklyQuestCount: { formula: 'QUESTS.weeklyTemplates.length', value: () => fmtNumber(QUESTS.weeklyTemplates.length) },
  weightBoostBothPct: { formula: '(seekerBonusBps + genesisBaseBonusBps) as percent', value: () => fmtNumber((PHASE_E_POLICY.mining.seekerBonusBps + PHASE_E_POLICY.mining.genesisBaseBonusBps) / 100, 2), locked: 'weight +30% both' },
  withdrawExampleFee: { formula: '1,000 KEEP × ECONOMY.withdrawFeeBps', value: () => fmtNumber((1_000 * ECONOMY.withdrawFeeBps) / 10_000, 2) },
  withdrawExampleNet: { formula: '1,000 KEEP − the withdrawal fee', value: () => fmtNumber(1_000 - (1_000 * ECONOMY.withdrawFeeBps) / 10_000, 2) },
  withdrawNetPct: { formula: '100 − ECONOMY.withdrawFeeBps as percent', value: () => fmtNumber(100 - ECONOMY.withdrawFeeBps / 100, 2) },
  zeroStarDefenderGain: { formula: '−TROPHIES.zeroStarLoss', value: () => fmtNumber(-TROPHIES.zeroStarLoss) },
});

export interface ResolvedToken { text: string; locked?: string }

/** Resolve one `{{n:<token>}}` to its display string, enforcing the LOCKED gate. */
export function resolveToken(token: string): ResolvedToken {
  if (!/^[A-Za-z0-9_.@-]+$/.test(token)) fail(`{{n:${token}}}: unreadable token`);
  let rest = token;
  let format: FormatName | null = null;
  const head = token.split('.')[0]!;
  if (isFormat(head)) {
    format = head;
    rest = token.slice(head.length + 1);
  }
  if (rest.startsWith('derived.')) {
    if (format) fail(`{{n:${token}}}: derived values are already formatted; drop the "${format}." prefix`);
    const name = rest.slice('derived.'.length);
    const spec = DERIVED[name];
    if (!spec) fail(`{{n:${token}}}: unknown derived value "${name}" (define it in scripts/src/docs-constants-export.ts DERIVED)`);
    return spec.locked ? { text: spec.value(), locked: spec.locked } : { text: spec.value() };
  }
  let locked: string | undefined;
  if (isUpcomingPath(rest)) {
    locked = LOCKED_UPCOMING[canonicalPath(rest)];
    if (!locked) {
      fail(`{{n:${token}}}: ${rest} is an onchain-gameplay number that is not on the M47 §1 LOCKED list — it is PROPOSED, so describe it in words instead`);
    }
  }
  const value = resolvePath(rest);
  let text: string;
  if (format) text = FORMATS[format](token, value);
  else if (typeof value === 'number') text = fmtNumber(value);
  else if (typeof value === 'string') text = value;
  else fail(`{{n:${token}}}: resolves to ${value === null ? 'null' : typeof value}; point at a number or a string`);
  return locked ? { text, locked } : { text };
}

// ---------------------------------------------------------------------------
// pkw-table datasets
// ---------------------------------------------------------------------------

export interface TableCell {
  text: string;
  /** A pinned landing-pack sprite (path below /assets/img/) shown before the text. */
  sprite?: string;
  /** Status badge: live | coming | planned. */
  badge?: 'live' | 'coming' | 'planned';
  /** A declared docs-media thumbnail and the art column to crop from a tier strip. */
  thumb?: { media: string; columns: number; pick: number };
}
export interface TableColumn { key: string; label: string; align?: 'left' | 'right' | 'center' }
export interface TableData { caption: string; columns: TableColumn[]; rows: Array<Record<string, TableCell>>; note?: string }

const cell = (text: string, extra: Omit<TableCell, 'text'> = {}): TableCell => ({ text, ...extra });
const n = (value: number, digits = 3): TableCell => cell(fmtNumber(value, digits));
const dash = cell('—');

const TROOP_NAMES: Readonly<Record<string, string>> = {
  highlander: 'Highlander', bowman: 'Bowman', kegrunner: 'Keg Runner', tunneler: 'Tunneler', turrider: 'Tur Rider',
  plunderer: 'Plunderer', giant: 'Giant', troll: 'Troll', dragon: 'Dragon', mage: 'Mage', bilgewraith: 'Bilgewraith',
  gloamfang: 'Gloamfang', direwyvern: 'Direwyvern', hexbarrow: 'Hexbarrow',
};
const DEFENSE_NAMES: Readonly<Record<string, string>> = {
  cannon: 'Cannon', archertower: 'Archer Tower', mortar: 'Mortar', airdefence: 'Air Defence',
  electrictower: 'Electric Tower', magetower: 'Mage Tower', lasertower: 'Laser Tower', dragonnest: 'Dragon Nest',
};
const TRAP_NAMES: Readonly<Record<string, string>> = { spiketrap: 'Spike Trap', powdermine: 'Powder Mine', pitfall: 'Pitfall', airmine: 'Air Mine' };
const BUILDING_NAMES: Readonly<Record<string, string>> = {
  ...DEFENSE_NAMES, ...TRAP_NAMES, keep: 'Keep', mine: 'Mine', vault: 'Vault', barracks: 'Barracks', camp: 'Army Camp',
  forge: 'Alchemy Lab', goldforge: 'Gold Forge', heroaltar: 'Hero Altar (Vex)', siegestool: 'Siege Stool (Theodor)',
  clanhall: 'Clan Hall', wall: 'Walls',
};
/** Landing-pack sprites (real game art, pinned in art/source/website). The
 *  retired cannon/mortar crate sprites are deliberately never used. */
const DEFENSE_SPRITES: Readonly<Record<string, string>> = {
  archertower: 'scene/bld_archer.png', electrictower: 'scene/bld_tesla.png', magetower: 'scene/bld_magetower.png',
  lasertower: 'scene/bld_laser.png', dragonnest: 'scene/bld_nest.png',
};

function troopsTable(): TableData {
  const rows = TROOP_TYPES.filter(isTrainableTroop).map((type) => {
    const troop = TROOPS[type] as (typeof TROOPS)[keyof typeof TROOPS] & { isFlying?: boolean };
    const name = TROOP_NAMES[type];
    if (!name) fail(`pkw-table troops: no display name for trainable troop "${type}"`);
    return {
      troop: cell(troop.isFlying ? `${name} (flies)` : name, { sprite: `scene/trp_${type}_e_f1.png` }),
      points: n(troop.pts),
      cost: n(troop.costKeep),
      time: cell(fmtDur(Math.ceil(troop.trainSec)).replace(/^(\d+)s$/, `${fmtNumber(troop.trainSec, 1)}s`)),
      hp: n(troop.hp),
      dps: n(troop.dps),
      speed: n(troop.speedTilesPerSec, 2),
      range: troop.range === 'melee' ? cell('Melee') : n(troop.range, 1),
    };
  });
  return {
    caption: 'Trainable troops (level 1)',
    columns: [
      { key: 'troop', label: 'Troop' }, { key: 'points', label: 'Pts', align: 'right' },
      { key: 'cost', label: 'SHARDS', align: 'right' }, { key: 'time', label: 'Training', align: 'right' },
      { key: 'hp', label: 'HP', align: 'right' }, { key: 'dps', label: 'DPS', align: 'right' },
      { key: 'speed', label: 'Speed', align: 'right' }, { key: 'range', label: 'Range', align: 'right' },
    ],
    rows,
    note: `Pts is army capacity; speed and range are in tiles. ${Object.keys(ELITE_TROOP_UNLOCKS.itemByTroop).map((type) => TROOP_NAMES[type]).join(', ')} each need a one-time training writ. Research in the Alchemy Lab raises HP and damage level by level.`,
  };
}

function heroesTable(): TableData {
  const rows = (['vex', 'theodor'] as const).map((key) => {
    const hero = HEROES[key];
    return {
      hero: cell(`${hero.name}, ${hero.title}`),
      altar: cell(BUILDING_NAMES[hero.altar]!.replace(/ \(.*\)$/, '')),
      unlock: cell(`Keep ${hero.unlockKeepLevel}`),
      recruit: n(hero.recruitCostKeep),
      l1: cell(`${fmtNumber(HERO_LEVELING.hp[key][0]!)} / ${fmtNumber(HERO_LEVELING.dps[key][0]!)}`),
      l20: cell(`${fmtNumber(HERO_LEVELING.hp[key].at(-1)!)} / ${fmtNumber(HERO_LEVELING.dps[key].at(-1)!)}`),
      recovery: cell(`${fmtNumber(hero.regenMinAt(1))} min + ${fmtNumber(hero.regenMinAt(2) - hero.regenMinAt(1))} per level`),
    };
  });
  return {
    caption: 'Heroes',
    columns: [
      { key: 'hero', label: 'Hero' }, { key: 'altar', label: 'Building' }, { key: 'unlock', label: 'Unlock' },
      { key: 'recruit', label: 'Recruit (KEEP)', align: 'right' }, { key: 'l1', label: 'L1 HP / DPS', align: 'right' },
      { key: 'l20', label: 'L20 HP / DPS', align: 'right' }, { key: 'recovery', label: 'Recovery' },
    ],
    rows,
    note: 'A hero contract item can be used instead of the KEEP recruit price.',
  };
}

function defensesTable(): TableData {
  const order = ['cannon', 'archertower', 'mortar', 'airdefence', 'electrictower', 'magetower', 'lasertower', 'dragonnest'] as const;
  const rows = order.map((type) => {
    const d = DEFENSES[type] as Record<string, unknown> & { hp: number; footprint: readonly number[] };
    const build = BUILD_COSTS[type] as { costShards: number; requiresKeepLevel?: number };
    const range = typeof d.rangeMinTiles === 'number'
      ? `${fmtNumber(d.rangeMinTiles as number, 1)}–${fmtNumber(d.rangeMaxTiles as number, 1)}`
      : fmtNumber(d.rangeTiles as number, 1);
    const air = d.targetsAir === true;
    const ground = d.targetsGround !== false;
    const targets = type === 'dragonnest' ? 'Spawns Wyrmlings' : air && ground ? 'Ground + air' : air ? 'Air only' : 'Ground only';
    const sprite = DEFENSE_SPRITES[type];
    return {
      defense: cell(DEFENSE_NAMES[type]!, sprite ? { sprite } : {}),
      unlock: cell(`Keep ${build.requiresKeepLevel ?? 1}`),
      cost: n(build.costShards),
      hp: n(d.hp),
      dps: typeof d.dps === 'number' ? n(d.dps) : dash,
      range: cell(range),
      interval: typeof d.fireIntervalSec === 'number' ? cell(`${fmtNumber(d.fireIntervalSec as number, 2)}s`)
        : typeof d.spawnIntervalSec === 'number' ? cell(`${fmtNumber(d.spawnIntervalSec as number, 2)}s`) : dash,
      targets: cell(targets),
      size: cell(`${d.footprint[0]}×${d.footprint[1]}`),
    };
  });
  return {
    caption: 'Defences (level 1)',
    columns: [
      { key: 'defense', label: 'Defence' }, { key: 'unlock', label: 'Unlock' }, { key: 'cost', label: 'SHARDS', align: 'right' },
      { key: 'hp', label: 'HP', align: 'right' }, { key: 'dps', label: 'DPS', align: 'right' },
      { key: 'range', label: 'Range (tiles)', align: 'right' }, { key: 'interval', label: 'Fires every', align: 'right' },
      { key: 'targets', label: 'Targets' }, { key: 'size', label: 'Size', align: 'center' },
    ],
    rows,
    note: `Every level adds ${pctOf(DEFENSE_LEVELING.statMultPerLevel)}% HP and damage up to level 5, then smaller steps. The Keep gains a long-range battery at Keep ${KEEP_BATTERIES.highRangeUnlockLevel} and a close-range battery at Keep ${KEEP_BATTERIES.lowRangeUnlockLevel}.`,
  };
}

function trapsTable(): TableData {
  const rows = (['spiketrap', 'powdermine', 'pitfall', 'airmine'] as const).map((type) => {
    const trap = DEFENSES[type] as Record<string, unknown> & { burstDamageByTier: readonly number[] };
    const build = BUILD_COSTS[type] as { costShards: number; requiresKeepLevel?: number };
    const splash = trap.splashRadiusTilesByTier as readonly number[] | undefined;
    const stun = trap.stunTicksByTier as readonly number[] | undefined;
    return {
      trap: cell(TRAP_NAMES[type]!),
      unlock: cell(`Keep ${build.requiresKeepLevel ?? 1}`),
      cost: n(build.costShards),
      damage: cell(trap.burstDamageByTier.map((value) => fmtNumber(value)).join(' → ')),
      effect: cell(splash ? `Splash ${splash.map((r) => fmtNumber(r, 2)).join(' → ')} tiles`
        : stun ? `Stuns ${stun.map((t) => fmtNumber(t / 10, 1)).join(' → ')} s` : 'Single target'),
      targets: cell(type === 'airmine' ? 'Air' : 'Ground'),
    };
  });
  return {
    caption: 'Traps (tiers 1 → 4)',
    columns: [
      { key: 'trap', label: 'Trap' }, { key: 'unlock', label: 'Unlock' }, { key: 'cost', label: 'SHARDS', align: 'right' },
      { key: 'damage', label: 'Burst damage', align: 'right' }, { key: 'effect', label: 'Effect' }, { key: 'targets', label: 'Hits' },
    ],
    rows,
    note: `Traps fire once and stay spent until repaired. Tier 1 covers levels 1–5, tier 4 levels 16–20. Up to ${fmtNumber(Math.max(...CAPS.trapsByKeepLevel))} traps from Keep ${(CAPS.trapsByKeepLevel as readonly number[]).indexOf(Math.max(...CAPS.trapsByKeepLevel)) + 1}.`,
  };
}

function keepLevelsTable(): TableData {
  const liveTypes = Object.keys(BUILD_COSTS).filter((type) => !NEW_BUILDING_TYPES.includes(type));
  const rows = Array.from({ length: STRUCTURES.keep.maxLevel }, (_, index) => {
    const level = index + 1;
    const opens = liveTypes
      .filter((type) => ((BUILD_COSTS as Record<string, { requiresKeepLevel?: number }>)[type]!.requiresKeepLevel ?? 1) === level && level > 1)
      .map((type) => BUILDING_NAMES[type] ?? type);
    if (level === KEEP_BATTERIES.highRangeUnlockLevel) opens.push('Keep long-range battery');
    if (level === KEEP_BATTERIES.lowRangeUnlockLevel) opens.push('Keep close-range battery');
    if (level === RALLY.unlockKeepLevel) opens.push('Rally');
    return {
      level: cell(String(level)),
      cost: index === 0 ? cell('Start') : n(UPGRADE_COSTS.keep[index - 1]!),
      time: index === 0 ? dash : cell(fmtDur(UPGRADE_TIMES_SEC.keep[index - 1]!)),
      mines: n(MINING.MAX_MINES_BY_KEEP[index]!),
      walls: n(BUILD_COUNT_CAP_BY_KEEP.wall![index]!),
      traps: n(CAPS.trapsByKeepLevel[index]!),
      opens: cell(opens.length ? opens.join(', ') : '—'),
    };
  });
  return {
    caption: 'Keep levels',
    columns: [
      { key: 'level', label: 'Keep', align: 'center' }, { key: 'cost', label: 'Upgrade (SHARDS)', align: 'right' },
      { key: 'time', label: 'Upgrade time', align: 'right' }, { key: 'mines', label: 'Mines', align: 'right' },
      { key: 'walls', label: 'Walls', align: 'right' }, { key: 'traps', label: 'Traps', align: 'right' },
      { key: 'opens', label: 'Opens' },
    ],
    rows,
    note: 'Upgrade cost and time are for reaching that level from the one before. No building can be upgraded above your Keep level.',
  };
}

function expansionsTable(): TableData {
  const rows = [
    { step: cell('Start'), size: cell(`${CAPS.claimTilesByExpansion[0]}×${CAPS.claimTilesByExpansion[0]}`), keep: dash, price: cell('Included') },
    ...CAPS.expansionPriceSolByIndex.map((price, index) => ({
      step: cell(String(index + 1)),
      size: cell(`${CAPS.claimTilesByExpansion[index + 1]}×${CAPS.claimTilesByExpansion[index + 1]}`),
      keep: cell(`Keep ${CAPS.expansionReqKeepLevel[index]}`),
      price: cell(`${fmtNumber(price, 2)} SOL`),
    })),
  ];
  if (rows.length !== CAPS.expansionsMax + 1) fail('pkw-table expansions: price table and expansionsMax disagree');
  return {
    caption: 'Land expansions',
    columns: [
      { key: 'step', label: 'Expansion', align: 'center' }, { key: 'size', label: 'Claim (tiles)', align: 'right' },
      { key: 'keep', label: 'Needs', align: 'right' }, { key: 'price', label: 'Price (devnet)', align: 'right' },
    ],
    rows,
    note: 'Expansions are bought in order. Devnet SOL has no monetary value.',
  };
}

const REALM_ORDER = ['crownlands', 'frostveil', 'elderwood', 'sunscar', 'cinderfall', 'thornwake', 'stormcairn', 'seeker-reach'] as const;
const REALM_LABELS: Readonly<Record<string, string>> = {
  crownlands: 'Crownlands', frostveil: 'Frostveil', elderwood: 'Elderwood', sunscar: 'Sunscar', cinderfall: 'Cinderfall',
  thornwake: 'Thornwake', stormcairn: 'Stormcairn', 'seeker-reach': 'Solana Reach',
};
function realmsTable(): TableData {
  const counts = new Map<string, { ordinary: number; genesis: number; seeker: number }>();
  for (const tile of fantasyTiles()) {
    const entry = counts.get(tile.realmId) ?? { ordinary: 0, genesis: 0, seeker: 0 };
    entry[tile.allocation] += 1;
    counts.set(tile.realmId, entry);
  }
  const rows = REALM_ORDER.map((realm) => {
    const c = counts.get(realm) ?? fail(`pkw-table realms: no tiles for ${realm}`);
    const reserved = c.genesis + c.seeker;
    return {
      realm: cell(REALM_LABELS[realm]!),
      tiles: n(c.ordinary + reserved),
      sale: c.ordinary ? n(c.ordinary) : cell('None'),
      reserved: reserved ? cell(`${fmtNumber(c.genesis)} Genesis · ${fmtNumber(c.seeker)} Seeker`) : dash,
      status: c.ordinary ? cell('LIVE', { badge: 'live' }) : cell('RESERVED', { badge: 'planned' }),
    };
  });
  const total = sum(rows.map((row) => Number(row.tiles.text.replace(/,/g, ''))));
  if (total !== FANTASY_WORLD.totalTiles) fail(`pkw-table realms: tiles sum to ${total}, FANTASY_WORLD says ${FANTASY_WORLD.totalTiles}`);
  return {
    caption: 'The eight realms',
    columns: [
      { key: 'realm', label: 'Realm' }, { key: 'tiles', label: 'Tiles', align: 'right' },
      { key: 'sale', label: 'For sale', align: 'right' }, { key: 'reserved', label: 'Reserved' }, { key: 'status', label: 'Bases' },
    ],
    rows,
    note: `${fmtNumber(FANTASY_WORLD.totalTiles)} tiles in all: ${fmtNumber(FANTASY_WORLD.ordinaryTiles)} ordinary tiles you can buy as Land Deeds, plus ${fmtNumber(FANTASY_WORLD.genesisTiles)} Genesis and ${fmtNumber(FANTASY_WORLD.seekerTiles)} Seeker tiles reserved in Solana Reach.`,
  };
}

/** New buildings: LOCKED facts only (2×2, one per base, 20 levels, 4 tiers). */
const NEW_BUILDINGS: ReadonlyArray<{ type: string; name: string; role: string; strip: string; columns: number; pick: number }> = [
  { type: 'workshop', name: 'Workshop', role: 'Refines SHARDS into Forge Ingots, and realm resources into materials and kits', strip: 'oc-workshop-tiers.webp', columns: 4, pick: 3 },
  { type: 'lodge', name: 'Exploration Lodge', role: 'Sends your vehicles on expeditions across the realms', strip: 'oc-lodge-tiers.webp', columns: 4, pick: 3 },
  { type: 'market', name: 'Market', role: 'A building for the market you already open from the HUD', strip: 'oc-market-tiers.webp', columns: 4, pick: 3 },
  { type: 'harvester', name: 'Realm Harvester', role: 'Produces the raw resource of the realm your base stands in', strip: 'oc-harvester-tiers.webp', columns: 4, pick: 3 },
  { type: 'berth', name: 'Berth', role: 'The dock for one installed vehicle', strip: 'oc-berths-docked.webp', columns: 5, pick: 0 },
];
function newBuildingsTable(): TableData {
  const rows = NEW_BUILDINGS.map((building) => {
    const structure = STRUCTURES[building.type as keyof typeof STRUCTURES] as { maxLevel: number; footprint: readonly number[] };
    return {
      building: cell(building.name, { thumb: { media: building.strip, columns: building.columns, pick: building.pick } }),
      role: cell(building.role),
      size: cell(`${structure.footprint[0]}×${structure.footprint[1]}`),
      count: cell(PHASE_E_BUILDINGS.onePerBase ? 'One' : '—'),
      levels: n(structure.maxLevel),
      tiers: n(PHASE_E_BUILDINGS.visualTiers),
    };
  });
  return {
    caption: 'New buildings (coming with onchain gameplay)',
    columns: [
      { key: 'building', label: 'Building' }, { key: 'role', label: 'What it does' }, { key: 'size', label: 'Size', align: 'center' },
      { key: 'count', label: 'Per base', align: 'center' }, { key: 'levels', label: 'Levels', align: 'right' },
      { key: 'tiers', label: 'Tiers', align: 'right' },
    ],
    rows,
    note: 'Tiers are the visual stages a building grows through as it levels. Costs, hit points and Keep-level gates are still being tuned and will show in the build menu when the update ships.',
  };
}

function currenciesTable(): TableData {
  const pct = (bps: number): string => fmtNumber(bps / 100, 2);
  const market = PHASE_E_POLICY.taxes.keepMarket;
  return {
    caption: 'Spendable currencies after the update',
    columns: [
      { key: 'currency', label: 'Currency' }, { key: 'what', label: 'What it is' }, { key: 'use', label: 'Used for' },
      { key: 'wallet', label: 'In your wallet' }, { key: 'status', label: 'Status' },
    ],
    rows: [
      { currency: cell('SOL'), what: cell('Solana\'s own token (devnet during the playtest)'), use: cell('Land Deeds, builders, expansions and the NFT market'), wallet: cell('Yes'), status: cell('LIVE', { badge: 'live' }) },
      { currency: cell('KEEP'), what: cell('The game token, an SPL token'), use: cell(`KEEP mining claims to your wallet; the resource and item market (${pct(market.sellerBps)}% to the seller, ${pct(market.burnBps)}% burned); converting to Gems`), wallet: cell('Yes'), status: cell('LIVE', { badge: 'live' }) },
      { currency: cell('Gems'), what: cell('The in-game spending currency'), use: cell(`Speed-ups, recruits, buffs and shop items; KEEP converts to Gems ${fmtNumber(GEMS.gemsPerKeep)}:1 and Gems to SHARDS ${fmtNumber(GEMS.shardsPerGem)}:1`), wallet: cell('Never — Gems cannot be withdrawn or listed'), status: cell('COMING', { badge: 'coming' }) },
      { currency: cell('SKR'), what: cell('The Seeker token'), use: cell('Seeker Island auctions'), wallet: cell('Yes'), status: cell('COMING', { badge: 'coming' }) },
    ],
    note: 'SHARDS, the eight realm resources and Crystal Fragments are resources, not currencies. Devnet items and currencies have no monetary value.',
  };
}

export const TABLE_BUILDERS: Readonly<Record<string, () => TableData>> = Object.freeze({
  troops: troopsTable, heroes: heroesTable, defenses: defensesTable, traps: trapsTable, 'keep-levels': keepLevelsTable,
  expansions: expansionsTable, realms: realmsTable, 'new-buildings': newBuildingsTable, currencies: currenciesTable,
});

// ---------------------------------------------------------------------------
// The registry file
// ---------------------------------------------------------------------------

export function collectTokens(contentRoot = DOCS_CONTENT_DIR): string[] {
  const tokens = new Set<string>();
  for (const name of readdirSync(contentRoot).filter((file) => file.endsWith('.md')).sort()) {
    const source = readFileSync(path.join(contentRoot, name), 'utf8');
    for (const match of source.matchAll(/\{\{\s*n:([^}]*)\}\}/g)) tokens.add(match[1]!.trim());
    const loose = source.replace(/\{\{\s*n:[^}]*\}\}/g, '').match(/\{\{[^}]*\}\}/);
    if (loose) fail(`${name}: "${loose[0]}" is not a {{n:<token>}} number (the only template the docs support)`);
  }
  return [...tokens].sort();
}

export interface DocsConstants {
  $schema: string;
  generated: string;
  values: Record<string, string>;
  locked: Record<string, string>;
  derived: Record<string, string>;
  tables: Record<string, TableData>;
}

export function buildDocsConstants({ contentRoot = DOCS_CONTENT_DIR }: { contentRoot?: string } = {}): DocsConstants {
  const values: Record<string, string> = {};
  const locked: Record<string, string> = {};
  const derived: Record<string, string> = {};
  const problems: string[] = [];
  for (const token of collectTokens(contentRoot)) {
    try {
      const resolved = resolveToken(token);
      values[token] = resolved.text;
      if (resolved.locked) locked[token] = resolved.locked;
      if (token.startsWith('derived.')) derived[token] = DERIVED[token.slice('derived.'.length)]!.formula;
    } catch (error) {
      if (!(error instanceof DocsConstantsError)) throw error;
      problems.push(error.message);
    }
  }
  if (problems.length) throw new DocsConstantsError(problems.join('\n'));
  const tables = Object.fromEntries(Object.entries(TABLE_BUILDERS).map(([id, build]) => [id, build()]));
  return {
    $schema: DOCS_CONSTANTS_SCHEMA,
    generated: 'GENERATED by scripts/src/docs-constants-export.ts from packages/shared/src/constants.ts and the {{n:}} tokens in landing/docs-content — do not edit; run `pnpm --filter @shardkeep/scripts run docs:constants`.',
    values, locked, derived, tables,
  };
}

export const serializeDocsConstants = (data: DocsConstants): string => `${JSON.stringify(data, null, 2)}\n`;

export function main(argv: string[]): number {
  const { values: args } = parseArgs({
    args: argv,
    options: { check: { type: 'boolean' }, 'content-root': { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  const out = path.resolve(args.out ?? DOCS_CONSTANTS_FILE);
  let text: string;
  try {
    text = serializeDocsConstants(buildDocsConstants({ contentRoot: path.resolve(args['content-root'] ?? DOCS_CONTENT_DIR) }));
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  if (args.check) {
    let current = '';
    try { current = readFileSync(out, 'utf8'); } catch { /* missing = drift */ }
    if (current !== text) {
      console.error(`${path.relative(REPO_ROOT, out)} is out of date: run pnpm --filter @shardkeep/scripts run docs:constants`);
      return 1;
    }
    console.log(`${path.relative(REPO_ROOT, out)} is current`);
    return 0;
  }
  writeFileSync(out, text);
  const data = JSON.parse(text) as DocsConstants;
  console.log(`wrote ${path.relative(REPO_ROOT, out) || out}: ${Object.keys(data.values).length} tokens (${Object.keys(data.locked).length} LOCKED upcoming), ${Object.keys(data.tables).length} tables`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
