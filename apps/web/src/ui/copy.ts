/**
 * Verbatim copy lifted word-for-word from the reference App (SHARDKEEP
 * App.html: shop ~L961, loading msgs L1762, train table T L633).
 * The App is the authority for player-facing text (CLAUDE.md chain). Game
 * NUMBERS that drive behaviour come from @shardkeep/shared, not from here.
 */
import { TROOPS } from '@shardkeep/shared';

// Loading-screen rotation (App L1762).
export const LOADING_MSGS = [
  'WAKING THE FORGE…',
  'LOADING REGION…',
  'CONNECTING TO SOLANA…',
  'SHARPENING SWORDS…',
];

// --- Shop items (App L961) — verbatim labels/prices --------------------------

export interface ShopItem {
  img: string;
  w: number;
  h: number;
  name: string;
  cur: 'keep' | 'sol';
  price: string;
}

// (The App's SKIN shop copy — SHOP_SKINS / SHOP_SKINS_FEATURED — was deleted
// with the keep-skin removal, owner 2026-08-15 / M23 a8. The skins never had
// live consumers here; the real catalog is server-authoritative.)
export const SHOP_BOOSTS: ShopItem[] = [
  { img: 'ui_icon_powdercharge', w: 52, h: 52, name: 'POWDER ×3', cur: 'keep', price: '45' },
  { img: 'ui_icon_swiftboots', w: 52, h: 52, name: 'SWIFT BOOTS', cur: 'keep', price: '30' },
  { img: 'ui_icon_warhorn', w: 52, h: 52, name: 'WAR HORN', cur: 'keep', price: '60' },
  // Shields are SOL-only (ECONOMY.md §4a). Price is overridden in ShopScreen
  // from SHIELD.extendCostSolLamports — kept blank here so no game number is
  // hardcoded in copy (the old 80-KEEP price is removed).
  { img: 'ui_icon_shield', w: 52, h: 52, name: 'SHIELD +12H', cur: 'sol', price: '' },
  { img: 'ui_icon_energy', w: 52, h: 52, name: '+1 MARCH', cur: 'keep', price: '25' },
  { img: 'ui_builder_workman', w: 52, h: 52, name: '2ND BUILDER', cur: 'sol', price: '2.0' },
];
export const SHOP_TOKENS = [
  { keep: '100 KEEP', sol: '0.1', accent: undefined as string | undefined },
  { keep: '550 KEEP · +10%', sol: '0.5', accent: '#9C6F1E' },
  { keep: '1,200 KEEP · +20%', sol: '1.0', accent: '#E3AE3C' },
];

// --- Army training table (App T, L633) — pts + SHARDS cost per troop ---------

// Order + display labels are copy; the per-troop pts / SHARDS cost are DERIVED
// from TROOPS in @shardkeep/shared (never duplicated here — CLAUDE.md hard rule).
const TRAIN_ROWS: Array<{ key: keyof typeof TROOPS; label: string }> = [
  { key: 'highlander', label: 'HIGHLANDER' },
  { key: 'bowman', label: 'BOWMAN' },
  { key: 'kegrunner', label: 'KEG RUNNER' },
  { key: 'tunneler', label: 'TUNNELER' },
  { key: 'turrider', label: 'TUR RIDER' },
  { key: 'plunderer', label: 'PLUNDERER' },
  // Pixel Kingdom Wars attacker roster (the wyrmling is Nest-spawned, never trained).
  { key: 'giant', label: 'GIANT' },
  { key: 'troll', label: 'TROLL' },
  { key: 'dragon', label: 'DRAGON' },
  { key: 'mage', label: 'MAGE' },
  { key: 'bilgewraith', label: 'BILGEWRAITH' },
  { key: 'gloamfang', label: 'GLOAMFANG' },
  { key: 'direwyvern', label: 'DIREWYVERN' },
  { key: 'hexbarrow', label: 'HEXBARROW' },
];
export const TRAIN_TABLE: Array<{ key: string; label: string; pts: number; shardCost: number }> =
  TRAIN_ROWS.map(({ key, label }) => ({ key, label, pts: TROOPS[key].pts, shardCost: TROOPS[key].costKeep }));

/** Codex troop name by troop key (for sheets / labels). */
const TROOP_NAMES = {
  highlander: 'HIGHLANDER', bowman: 'BOWMAN', kegrunner: 'KEG RUNNER',
  tunneler: 'TUNNELER', turrider: 'TUR RIDER', plunderer: 'PLUNDERER',
  giant: 'GIANT', troll: 'TROLL', dragon: 'DRAGON', mage: 'MAGE',
  bilgewraith: 'BILGEWRAITH', gloamfang: 'GLOAMFANG',
  direwyvern: 'DIREWYVERN', hexbarrow: 'HEXBARROW',
  barrowling: 'BARROWLING', wyrmling: 'WYRMLING',
} satisfies Record<keyof typeof TROOPS, string>;
export const TROOP_DISPLAY: Record<string, string> = TROOP_NAMES;

/** Quest template-code → verbatim display label (server returns templateCode;
 * these mirror the constants' dailyTemplates names, upper-cased like the App).
 *
 * The two AMOUNT objectives count SHARDS, not KEEP: QUESTS.dailyTemplates names
 * them "Steal 500 Shards" / "Spend 200 Shards", raids.ts progresses steal_500
 * from shard loot and spend.ts progresses spend_200 from shard spends. They read
 * KEEP here until 2026-08-09, which pointed a free-tier objective at the
 * withdrawable currency it has nothing to do with. */
export const QUEST_LABELS: Record<string, string> = {
  win_2_star: 'WIN A RAID WITH 2★',
  steal_500: 'STEAL 500 SHARDS',
  two_keg_runners: 'USE 2 KEG RUNNERS IN ONE RAID',
  clear_ruined_keep: 'CLEAR A CAMPAIGN STAGE',
  upgrade_any: 'UPGRADE ANY BUILDING',
  defend_success: 'DEFEND SUCCESSFULLY',
  spend_200: 'SPEND 200 SHARDS',
  scout_3: 'SCOUT 3 BASES',
  place_5_walls: 'PLACE 5 WALL SEGMENTS',
  train_tur_rider: 'TRAIN A TUR RIDER',
  all_3_buffs: 'USE ALL 3 BUFFS IN ONE RAID',
  win_from_map: 'WIN FROM THE WORLD MAP',
  // M23 a15 expansion (owner 2026-08-15) — mirrors QUESTS.dailyTemplates names.
  win_3_star: 'WIN A RAID WITH 3★',
  win_2_raids: 'WIN 2 RAIDS',
  raid_3_times: 'GO RAIDING 3 TIMES',
  steal_1500: 'STEAL 1,500 SHARDS',
  earn_5_stars: 'EARN 5 STARS IN RAIDS',
  clear_2_keeps: 'CLEAR 2 CAMPAIGN STAGES',
  vault_buster: 'DESTROY AN ENEMY VAULT',
  deploy_hero: 'SEND A HERO INTO BATTLE',
  hero_untouched: 'WIN WITH A HERO, LOSE NO HERO',
  deploy_20_troops: 'DEPLOY 20 TROOPS',
  use_5_highlanders: 'DEPLOY 5 HIGHLANDERS',
  use_5_bowmen: 'DEPLOY 5 BOWMEN',
  use_3_tunnelers: 'DEPLOY 3 TUNNELERS',
  use_3_tur_riders: 'DEPLOY 3 TUR RIDERS',
  use_2_plunderers: 'DEPLOY 2 PLUNDERERS',
  use_2_giants: 'DEPLOY 2 GIANTS',
  use_2_trolls: 'DEPLOY 2 TROLLS',
  use_a_dragon: 'DEPLOY A DRAGON',
  use_a_mage: 'DEPLOY A MAGE',
  use_war_horn: 'RAID WITH THE WAR HORN',
  use_swift_boots: 'RAID WITH SWIFT BOOTS',
  use_powder_charge: 'RAID WITH A POWDER CHARGE',
  campaign_clear: 'CLEAR A CAMPAIGN STAGE',
  campaign_3star: 'EARN 3★ ON A CAMPAIGN STAGE',
  campaign_2_stages: 'CLEAR 2 CAMPAIGN STAGES',
  upgrade_2_buildings: 'START 2 BUILDING UPGRADES',
  upgrade_to_level_3: 'PUSH A BUILDING TO LEVEL 3+',
  place_10_walls: 'PLACE 10 WALL SEGMENTS',
  clear_obstacle: 'CLEAR AN OBSTACLE',
  train_5_troops: 'TRAIN 5 TROOPS',
  train_20_points: 'TRAIN 20 ARMY POINTS',
  collect_mines: 'COLLECT FROM YOUR MINES',
  collect_1000_mined: 'COLLECT 1,000 MINED SHARDS',
  claim_daily_cache: 'CLAIM THE DAILY CACHE',
  spend_500: 'SPEND 500 SHARDS',
  forge_smelt: 'SMELT SHARDS IN THE GOLD FORGE',
  scout_1: 'SCOUT AN ENEMY BASE',
  upgrade_hero: 'UPGRADE A HERO',
  // First-run chain (QUESTS.onboardingTemplates, owner 2026-08-28). These objectives
  // replace the tutorial cards that used to TELL the player to do them, so the
  // label is the instruction — an imperative, never a description.
  first_camp: 'BUILD AN ARMY CAMP',
  first_mine: 'BUILD A MINE',
  first_barracks: 'BUILD A BARRACKS',
  first_troops: 'TRAIN YOUR FIRST ARMY',
  first_land: 'CLAIM YOUR LAND',
  first_raid: 'WIN YOUR FIRST RAID',
  // Weekly rotation pool (QUESTS.weeklyTemplates).
  earn_8_stars: 'EARN 8 STARS',
  win_10_raids: 'WIN 10 RAIDS',
  steal_5000: 'STEAL 5,000 SHARDS',
  clear_5_keeps: 'CLEAR 5 CAMPAIGN STAGES',
  train_100_points: 'TRAIN 100 ARMY POINTS',
};
