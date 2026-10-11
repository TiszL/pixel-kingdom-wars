/** Loading advice is tied to the same constants and atlas clips as gameplay.
 * No logo or stale screenshot is part of this module; the card is useful even
 * when its optional sprite cannot be fetched. */
import {
  BUILD_COSTS, DEFENSES, fmtDur, HEROES, LOOT, MINING, RAID_RULES, SHIELD,
  TROOPS, UPGRADE_TIMES_SEC,
} from '@shardkeep/shared';

export type TipCategory = 'BUILD' | 'DEFENCE' | 'TROOPS' | 'HEROES' | 'RAID';

export interface TipClip {
  atlas: string;
  /** AtlasClip discovers every `<stem>_fN` frame from the generated JSON. */
  stem: string;
}

export interface LoadingTip {
  id: string;
  category: TipCategory;
  text: string;
  clip: TipClip;
}

export const TIP_FPS = 8;
const n = (value: number): string => value.toLocaleString('en-US');
const pct = (bps: number): string => `${Math.round(bps / 100)}%`;

export const LOADING_TIPS: readonly LoadingTip[] = [
  {
    id: 'mine-output', category: 'BUILD',
    text: `A level one Mine produces ${n(MINING.MINE_QUOTA_BASE)} shards per day. Build the economy before the walls.`,
    clip: { atlas: 'ware_mine_1', stem: 'ware_bld_mine_t1_work' },
  },
  {
    id: 'mine-buffer', category: 'BUILD',
    text: `A Mine stores ${fmtDur(MINING.MINE_STORAGE_DAYS * 86_400)} of output. Collect before production pauses.`,
    clip: { atlas: 'ware_mine_1', stem: 'ware_bld_mine_t1_work' },
  },
  {
    id: 'wall-build', category: 'BUILD',
    text: `Walls cost ${n(BUILD_COSTS.wall.costShards)} shards and build instantly, without taking a builder.`,
    clip: { atlas: 'wall5', stem: 'wall5_t1_straight_damaged' },
  },
  {
    id: 'keep-upgrade', category: 'BUILD',
    text: `Your first Keep upgrade takes ${fmtDur(UPGRADE_TIMES_SEC.keep[0]!)}. Start long upgrades before leaving.`,
    clip: { atlas: 'ware_keep_1', stem: 'ware_bld_keep_l1_idle' },
  },
  {
    id: 'gold-forge', category: 'BUILD',
    text: `The Gold Forge unlocks at Keep ${BUILD_COSTS.goldforge.requiresKeepLevel} and turns earned shards into KEEP.`,
    clip: { atlas: 'ware_goldforge_3', stem: 'ware_bld_goldforge_l3_work' },
  },
  {
    id: 'cannon', category: 'DEFENCE',
    text: `Cannons reach ${DEFENSES.cannon.rangeTiles} tiles for ${DEFENSES.cannon.dps} damage per second, but cannot hit flyers.`,
    clip: { atlas: 'v2bld_cannon_t1', stem: 'v2_bld_cannon_t1_fire_d0' },
  },
  {
    id: 'archer-tower', category: 'DEFENCE',
    text: `Archer Towers reach ${DEFENSES.archertower.rangeTiles} tiles and can hit both ground and flying troops.`,
    clip: { atlas: 'ware_archer_1', stem: 'ware_bld_archer_t1_fire_d0' },
  },
  {
    id: 'mortar', category: 'DEFENCE',
    text: `Mortars splash out to ${DEFENSES.mortar.rangeMaxTiles} tiles but are blind inside ${DEFENSES.mortar.rangeMinTiles}. Cover that gap.`,
    clip: { atlas: 'v2bld_mortar_t1', stem: 'v2_bld_mortar_t1_fire_d0' },
  },
  {
    id: 'electric-tower', category: 'DEFENCE',
    text: `Electric Towers chain through ${DEFENSES.electrictower.chainMax} extra targets. Put them where armies bunch up.`,
    clip: { atlas: 'ware_electrictower_1', stem: 'ware_bld_electrictower_t1_idle' },
  },
  {
    id: 'laser-tower', category: 'DEFENCE',
    text: `Laser Towers reach ${DEFENSES.lasertower.rangeTiles} tiles and focus ground targets from Keep ${BUILD_COSTS.lasertower.requiresKeepLevel}.`,
    clip: { atlas: 'ware_lasertower_1', stem: 'ware_bld_lasertower_t1_fire_d0' },
  },
  {
    id: 'bowman', category: 'TROOPS',
    text: `Bowmen fire from ${TROOPS.bowman.range} tiles away. Let tougher troops open the path in front of them.`,
    clip: { atlas: 'v2trp_bowman_t1_locomotion', stem: 'v2_trp_bowman_t1_walk_d0' },
  },
  {
    id: 'tunneler', category: 'TROOPS',
    text: `Tunnelers burrow under walls and open a ${RAID_RULES.burrowClearTiles}-tile path when they surface.`,
    clip: { atlas: 'v2trp_tunneler_t1_locomotion', stem: 'v2_trp_tunneler_t1_walk_d0' },
  },
  {
    id: 'giant', category: 'TROOPS',
    text: `Giants carry ${n(TROOPS.giant.hp)} health toward defences and throw rocks from ${TROOPS.giant.siegeThrow.rangeTiles} tiles.`,
    clip: { atlas: 'v2trp_giant_t1_locomotion', stem: 'v2_trp_giant_t1_walk_d0' },
  },
  {
    id: 'troll', category: 'TROOPS',
    text: `Trolls bring ${n(TROOPS.troll.hp)} health and break walls that block their route into the base.`,
    clip: { atlas: 'v2trp_troll_t1_locomotion', stem: 'v2_trp_troll_t1_walk_d0' },
  },
  {
    id: 'dragon', category: 'TROOPS',
    text: `Dragons fly over walls for ${TROOPS.dragon.dps} damage per second, but anti-air defences punish them.`,
    clip: { atlas: 'v2trp_dragon_t1_locomotion', stem: 'v2_trp_dragon_t1_fly_d0' },
  },
  {
    id: 'vex', category: 'HEROES',
    text: `Vex unlocks at Keep ${HEROES.vex.unlockKeepLevel} and can advance to level ${HEROES.vex.maxLevel}.`,
    clip: { atlas: 'hero', stem: 'hero_vex_idle' },
  },
  {
    id: 'theodor', category: 'HEROES',
    text: `Theodor starts with ${n(HEROES.theodor.hpAt(1))} health. Use the sapper to hold the dangerous lane.`,
    clip: { atlas: 'hero', stem: 'hero_theo_idle' },
  },
  {
    id: 'hero-recovery', category: 'HEROES',
    text: `A defeated Vex needs ${fmtDur(HEROES.vex.regenMinAt(1) * 60)} to recover at level one. Plan the next raid.`,
    clip: { atlas: 'hero', stem: 'hero_vex_idle' },
  },
  {
    id: 'raid-clock', category: 'RAID',
    text: `Deployment lasts ${fmtDur(RAID_RULES.deployWindowSec)}, followed by ${fmtDur(RAID_RULES.battleDurationSec)} of battle.`,
    clip: { atlas: 'v2trp_highlander_t1_locomotion', stem: 'v2_trp_highlander_t1_walk_d0' },
  },
  {
    id: 'raid-shield', category: 'RAID',
    text: `Losing a raid grants a ${fmtDur(SHIELD.hoursOnLoss * 3_600)} shield. Starting an attack breaks it.`,
    clip: { atlas: 'ware_keep_1', stem: 'ware_bld_keep_l1_idle' },
  },
  {
    id: 'raid-loot', category: 'RAID',
    text: `Up to ${pct(LOOT.balanceLootableBps)} of defender shards enter the loot calculation; a standing Vault protects part of it.`,
    clip: { atlas: 'ware_vault_1', stem: 'ware_bld_vault_t1_work' },
  },
  {
    id: 'raid-scout', category: 'RAID',
    text: `Scouting reveals the layout for ${fmtDur(RAID_RULES.scoutPreviewSec)}. Find the Mortar dead zone before deploying.`,
    clip: { atlas: 'v2bld_mortar_t1', stem: 'v2_bld_mortar_t1_fire_d0' },
  },
];

/** Fisher-Yates over a copy: every card appears once before any repeats. */
export function shuffleTips(tips: readonly LoadingTip[], rng: () => number): LoadingTip[] {
  const deck = [...tips];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

export function tipAtlases(tips: readonly LoadingTip[] = LOADING_TIPS): string[] {
  return [...new Set(tips.map((tip) => tip.clip.atlas))].sort();
}
